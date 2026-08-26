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
export async function vigiarConexaoCanais(
  sql: Sql, agora: Date,
  // ⚠️ Costura para o teste, no mesmo estilo do `{ buscar }` dos adaptadores: o
  //    caminho "canal DE PÉ" não pode ser exercitado com credencial falsa, que
  //    sempre responde caído. Sem esta injeção, o ramo que FECHA o alerta ficaria
  //    sem teste — justamente o que estava quebrado.
  deps: { readonly criar?: typeof criarCanal } = {},
): Promise<ResumoVigiaCanal> {
  const criar = deps.criar ?? criarCanal
  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('vigia_conexao_canal')) AS ok`
  if (!trava?.ok) return { verificados: 0, caiu: 0, voltou: 0 }

  try {
    const canais = await sql<{
      tenant_id: string; id: string; provedor: string | null; nome_amigavel: string | null
      estado: string; credenciais_cifradas: Buffer | null
    }[]>`
      SELECT tenant_id, id, provedor, nome_amigavel, estado, credenciais_cifradas
        FROM canal_conectado
       WHERE estado IN ('conectado', 'degradado', 'desconectado')
         AND provedor IS NOT NULL AND credenciais_cifradas IS NOT NULL`

    let verificados = 0, caiu = 0, voltou = 0

    for (const c of canais) {
      // ⚠️ Um canal quebrado não pode parar a vigilância dos OUTROS. `decifrar`
      //    lança em credencial corrompida, e sem esta cerca a passada inteira
      //    morria no primeiro canal ruim — de TODOS os tenants, a cada 5 min,
      //    virando um `warn` que ninguém lê. É a mesma regra do webhook: um
      //    evento que falha não pode travar a fila do resto.
      try {
        const canal = criar(c.provedor!, decifrar(c.credenciais_cifradas!))
        // ⚠️ Só pergunta onde a sessão pode cair. No oficial, "conectado" viria de
        //    uma verificação que não aconteceu — e inventar isso é pior que não ter.
        if (!canal.capacidades.sessaoPodeCair) continue

        verificados++
        const r = await canal.verificarConexao()

        if (r.conectado) {
          if (c.estado === 'desconectado') {
            await sql`
              UPDATE canal_conectado
                 SET estado = 'conectado', ultimo_erro = NULL, verificado_em = ${agora}
               WHERE tenant_id = ${c.tenant_id} AND id = ${c.id}`
            voltou++
          } else {
            // ⚠️ Nada MUDOU — mas a verificação ACONTECEU, e é isso que o carimbo
            //    registra. Gravar só na mudança deixaria "conectado" envelhecendo
            //    em silêncio, indistinguível do valor de cadastro nunca conferido:
            //    o defeito que o `0069` existe para fechar.
            await sql`
              UPDATE canal_conectado SET verificado_em = ${agora}
               WHERE tenant_id = ${c.tenant_id} AND id = ${c.id}`
          }
          // ⚠️ O alerta é fechado por ESTAR CONECTADO, não pela transição.
          //    Antes, fechar dependia de ver o estado sair de 'desconectado' — e
          //    o "Testar conexão" grava 'conectado' direto, por fora. Encontrado
          //    em produção (25/ago): canal de pé, vigia dizendo caiu=0, e um
          //    alerta CRÍTICO de 24/ago preso em aberto, com a faixa vermelha na
          //    tela. Alerta que não pode ser fechado ensina a ignorar a faixa —
          //    é o pior desfecho possível para um aviso crítico.
          await resolverAlerta(sql, c.tenant_id, agora)
        } else if (c.estado !== 'desconectado') {
          await sql`
            UPDATE canal_conectado
               SET estado = 'desconectado', ultimo_erro = ${r.detalhe ?? 'sessão caiu'},
                   verificado_em = ${agora}
             WHERE tenant_id = ${c.tenant_id} AND id = ${c.id}`
          await abrirAlerta(sql, c.tenant_id, c.nome_amigavel, r.detalhe ?? null)
          caiu++
        } else {
          // Segue caído, e o alerta segue aberto — só o carimbo avança.
          await sql`
            UPDATE canal_conectado SET verificado_em = ${agora}
             WHERE tenant_id = ${c.tenant_id} AND id = ${c.id}`
        }
      } catch {
        // ⚠️ Sem resposta do fornecedor NÃO carimba e NÃO muda estado: o carimbo
        //    significa "última vez que obtivemos resposta". Deixá-lo envelhecer é
        //    o aviso — a tela mostra "verificado há 3 h" e a pessoa vê que a
        //    vigilância parou. Carimbar aqui seria registrar uma observação que
        //    não houve, e mentir com precisão é pior que não saber.
        continue
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
  sql: Sql, tenantId: string, nome: string | null, detalhe: string | null,
): Promise<void> {
  const numero = nome ? ` (${nome})` : ''
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

/**
 * Fecha o alerta de canal caído. **Idempotente**: roda em toda passada em que o
 * canal está de pé e não faz nada quando não há alerta aberto.
 *
 * ⚠️ Separada de propósito. Enquanto fechar era um `UPDATE` solto dentro do ramo
 * da transição, só existia UM caminho de volta — e qualquer outro jeito de o
 * estado virar 'conectado' (o "Testar conexão" da tela) deixava o alerta órfão,
 * sem ninguém que pudesse fechá-lo depois.
 */
export async function resolverAlerta(sql: Sql, tenantId: string, agora: Date): Promise<void> {
  await sql`
    UPDATE alerta SET resolvido_em = ${agora}
     WHERE tenant_id = ${tenantId} AND tipo = 'canal_desconectado' AND resolvido_em IS NULL`
}
