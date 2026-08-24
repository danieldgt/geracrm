import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'
import { criarCanal } from './canais/fabrica.js'
import { decifrar } from '../integracao/cofre.js'

/**
 * VIGIA DE CONEXÃO DO CANAL.
 *
 * ⚠️ Nasceu de um incidente real (2026-08-24): o número não-oficial caiu — o
 * celular desconectou — e **o produto não avisou**. O dono descobriu porque
 * parou de funcionar, e o painel continuou mostrando "conectado", porque o
 * estado só era atualizado quando alguém tentava enviar.
 *
 * ⚠️ **Silêncio parecendo saúde é o pior modo de falha de um produto de
 * atendimento**: quando ninguém escreve, não há erro para ninguém ver — só
 * conversas que não chegam.
 *
 * O canal não-oficial automatiza um WhatsApp Web: celular sem internet, desligado
 * ou desconectado pelo próprio WhatsApp derruba a sessão. Por isso a pergunta é
 * feita ATIVAMENTE, e só onde faz sentido (`capacidades.sessaoPodeCair`).
 */

export interface ResumoVigiaCanal {
  readonly verificados: number
  readonly caiu: number
  readonly voltou: number
}

/**
 * Uma passada por todos os canais cuja sessão pode cair.
 *
 * Roda como DONO, guardada por advisory lock. ⚠️ Não altera canal marcado como
 * `suspenso`: suspensão é decisão humana ou da Meta, e sobrescrever apagaria a
 * razão pela qual alguém desligou aquele número.
 */
export async function vigiarConexaoCanais(sql: Sql, agora: Date): Promise<ResumoVigiaCanal> {
  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('vigia_conexao_canal')) AS ok`
  if (!trava?.ok) return { verificados: 0, caiu: 0, voltou: 0 }

  try {
    const canais = await sql<{
      tenant_id: string; id: string; provedor: string; telefone: string | null
      estado: string; credencial: Uint8Array
    }[]>`
      SELECT tenant_id, id, provedor, telefone, estado, credencial
        FROM canal_conectado
       WHERE estado IN ('conectado', 'degradado', 'desconectado')`

    let verificados = 0, caiu = 0, voltou = 0

    for (const c of canais) {
      const canal = criarCanal(c.provedor, decifrar(Buffer.from(c.credencial)))
      // ⚠️ Só pergunta onde a sessão pode cair. No oficial, "conectado" viria de
      //    uma verificação que não aconteceu — e inventar isso é pior que não ter.
      if (!canal.capacidades.sessaoPodeCair) continue

      verificados++
      const r = await canal.verificarConexao()

      if (!r.conectado && c.estado !== 'desconectado') {
        await sql`
          UPDATE canal_conectado
             SET estado = 'desconectado', ultimo_erro = ${r.detalhe ?? 'sessão caiu'}
           WHERE tenant_id = ${c.tenant_id} AND id = ${c.id}`
        await abrirAlerta(sql, c.tenant_id, c.telefone, r.detalhe ?? null)
        caiu++
      } else if (r.conectado && c.estado === 'desconectado') {
        await sql`
          UPDATE canal_conectado SET estado = 'conectado', ultimo_erro = NULL
           WHERE tenant_id = ${c.tenant_id} AND id = ${c.id}`
        await sql`
          UPDATE alerta SET resolvido_em = ${agora}
           WHERE tenant_id = ${c.tenant_id} AND tipo = 'canal_desconectado' AND resolvido_em IS NULL`
        voltou++
      }
    }

    return { verificados, caiu, voltou }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('vigia_conexao_canal'))`
  }
}

/**
 * ⚠️ Severidade CRÍTICA, sem hesitar: número fora do ar não é degradação, é o
 * produto parado. E o evento no outbox faz a faixa de alerta acender na tela de
 * quem estiver com o console aberto — que é onde a notícia precisa chegar.
 */
async function abrirAlerta(
  sql: Sql, tenantId: string, telefone: string | null, detalhe: string | null,
): Promise<void> {
  const numero = telefone ? ` (${telefone})` : ''
  const mensagem = `WhatsApp desconectado${numero}: o número não envia nem recebe. `
    + `Releia o QR code no painel do provedor para reconectar.`
    + (detalhe ? ` Detalhe: ${detalhe}` : '')

  const nova = await sql<{ id: string }[]>`
    INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
    VALUES (${tenantId}, ${randomUUID()}, 'canal_desconectado', 'critico', ${mensagem})
    ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO NOTHING
    RETURNING id`

  if (nova.length > 0) {
    await sql`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (${tenantId}, 'alerta.novo', 'tenant', ${tenantId}, '{}'::jsonb)`
  }
}
