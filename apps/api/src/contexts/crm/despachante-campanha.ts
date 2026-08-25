import type { Sql } from '../../db/index.js'
import { enviarTextoParaContato, type ResultadoEnvioTexto } from '../atendimento/envio-conversa.js'
import { statusAquecimento } from '../atendimento/aquecimento.js'

/**
 * DESPACHANTE DE CAMPANHA — o que faltava para "disparar" significar alguma coisa.
 *
 * ⚠️ Até aqui, `POST /v1/campanhas/:id/disparar` ENFILEIRAVA os envios
 * (`campanha_envio`, `0036`) e **ninguém drenava a fila**. A tela mostrava a
 * campanha "disparando", os destinatários apareciam no painel, e nenhuma
 * mensagem saía. É a pior classe de defeito: a funcionalidade PARECE existir, e
 * a descoberta só viria pelo cliente perguntando por que ninguém respondeu.
 *
 * ⚠️ **Nada aqui fala com o adaptador.** Tudo passa por `enviarTextoParaContato`,
 * que é o gateway único: opt-out, estado do canal, credencial, janela de 24h e
 * pausa de disparo. Campanha é justamente o caminho onde furar o guardrail
 * custaria mais caro — mil mensagens de uma vez.
 *
 * ⚠️ E respeita o AQUECIMENTO (`0037`): o teto diário do número não-oficial é o
 * que separa "campanha" de "número banido". Estourado o teto do dia, a campanha
 * fica onde está e continua amanhã — ela NÃO é marcada como concluída.
 */

/** Envios por passada e por campanha. Rajada de mil não vira mil de uma vez. */
const LOTE = 10

/**
 * Quem entrega. Injetável — o teste exercita o caminho FELIZ sem falar com
 * provedor nenhum, como o despachante de push e o de webhooks já fazem.
 * ⚠️ O padrão da casa é injetar a borda, nunca mockar o módulo: mock silencia
 * quando a assinatura muda; parâmetro quebra o typecheck.
 */
export type EnviarCampanha = (
  tenantId: string, canalId: string, contatoId: string, texto: string, agora: Date,
) => Promise<ResultadoEnvioTexto>

export interface ResultadoDisparo {
  readonly enviados: number
  /** Recusados por política NOSSA (opt-out, janela, pausa) — não são erro. */
  readonly bloqueados: number
  /** Falha de transporte do provedor. */
  readonly falhas: number
  /** Ficaram para amanhã porque o teto de aquecimento do dia acabou. */
  readonly aguardandoAquecimento: number
  readonly campanhasConcluidas: number
}

const VAZIO: ResultadoDisparo = {
  enviados: 0, bloqueados: 0, falhas: 0, aguardandoAquecimento: 0, campanhasConcluidas: 0,
}

interface CampanhaEmCurso {
  id: string
  nome: string
  mensagem: string
  canal_id: string | null
}

/**
 * Uma passada nas campanhas de UM tenant.
 *
 * ⚠️ Roda como DONO (worker) com `tenant_id` explícito — mas o envio entra por
 * `comTenantServico`, ou seja, a escrita da mensagem acontece sob RLS.
 */
export async function despacharCampanhasDoTenant(
  sql: Sql, tenantId: string, agora: Date, enviar: EnviarCampanha = enviarTextoParaContato,
): Promise<ResultadoDisparo> {
  const campanhas = await sql<CampanhaEmCurso[]>`
    SELECT id, nome, mensagem, canal_id
      FROM campanha
     WHERE tenant_id = ${tenantId} AND estado = 'disparando'
     ORDER BY disparada_em ASC NULLS LAST`

  let enviados = 0, bloqueados = 0, falhas = 0, aguardando = 0, concluidas = 0

  for (const c of campanhas) {
    // ⚠️ Campanha sem canal não tem por onde sair. Marcar como concluída
    //    esconderia o problema; deixar 'disparando' para sempre também. O
    //    caminho honesto é parar de tentar e deixar a fila intacta — a tela
    //    mostra os pendentes e alguém corrige o cadastro.
    if (!c.canal_id) continue

    /**
     * ⚠️ O teto do dia é lido DENTRO do laço, uma vez por campanha: duas
     * campanhas no mesmo número compartilham o mesmo teto, e ler antes do laço
     * deixaria a segunda gastar o que a primeira já gastou.
     */
    const aquecimento = await comTenantDoWorker(sql, tenantId, (tx) =>
      statusAquecimento(tx, c.canal_id!, agora))
    const cabeHoje = Math.min(LOTE, aquecimento.restante)
    if (cabeHoje <= 0) {
      const [p] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM campanha_envio
         WHERE tenant_id = ${tenantId} AND campanha_id = ${c.id} AND estado = 'pendente'`
      aguardando += p?.n ?? 0
      continue
    }

    const pendentes = await sql<{ id: string; contato_id: string }[]>`
      SELECT id, contato_id FROM campanha_envio
       WHERE tenant_id = ${tenantId} AND campanha_id = ${c.id} AND estado = 'pendente'
       ORDER BY criado_em ASC
       LIMIT ${cabeHoje}`

    for (const envio of pendentes) {
      const r = await enviar(tenantId, c.canal_id, envio.contato_id, c.mensagem, agora)

      if (r.ok) {
        enviados++
        await sql`
          UPDATE campanha_envio
             SET estado = 'enviado', enviado_em = now(), mensagem_id = ${r.mensagemId}
           WHERE tenant_id = ${tenantId} AND id = ${envio.id}`
        continue
      }

      // ⚠️ Recusa NOSSA vira 'bloqueado', falha de transporte vira 'falhou'.
      //    Colapsar as duas faria uma tentativa futura reenviar para quem pediu
      //    para não receber — e o opt-out é invariante, não filtro.
      const estado = r.classe === 'transporte' ? 'falhou' : 'bloqueado'
      if (estado === 'falhou') falhas++
      else bloqueados++
      await sql`
        UPDATE campanha_envio SET estado = ${estado}, enviado_em = now(),
               mensagem_id = ${r.mensagemId ?? null}
         WHERE tenant_id = ${tenantId} AND id = ${envio.id}`
    }

    // Acabou a fila desta campanha? Só então ela conclui.
    const [restam] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM campanha_envio
       WHERE tenant_id = ${tenantId} AND campanha_id = ${c.id} AND estado = 'pendente'`
    if ((restam?.n ?? 0) === 0) {
      await sql`
        UPDATE campanha SET estado = 'concluida'
         WHERE tenant_id = ${tenantId} AND id = ${c.id} AND estado = 'disparando'`
      concluidas++
    }
  }

  return {
    enviados, bloqueados, falhas,
    aguardandoAquecimento: aguardando, campanhasConcluidas: concluidas,
  }
}

/**
 * ⚠️ `statusAquecimento` foi escrito para a API e usa `tenant_atual()`. O
 * despachante roda como DONO, sem tenant de sessão — sem isto ele leria zero e o
 * teto de aquecimento sumiria justamente no caminho que mais precisa dele.
 */
async function comTenantDoWorker<T>(sql: Sql, tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${tenantId}, true)`
    return fn(tx as unknown as Sql)
  }) as Promise<T>
}

/** Uma passada por todos os tenants com campanha em curso. */
export async function despacharCampanhas(
  sql: Sql, agora: Date, enviar: EnviarCampanha = enviarTextoParaContato,
): Promise<ResultadoDisparo> {
  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('campanha_despacho')) AS ok`
  if (!trava?.ok) return VAZIO

  try {
    const tenants = await sql<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM campanha WHERE estado = 'disparando'`

    let enviados = 0, bloqueados = 0, falhas = 0, aguardando = 0, concluidas = 0
    for (const { tenant_id } of tenants) {
      const r = await despacharCampanhasDoTenant(sql, tenant_id, agora, enviar)
      enviados += r.enviados; bloqueados += r.bloqueados; falhas += r.falhas
      aguardando += r.aguardandoAquecimento; concluidas += r.campanhasConcluidas
    }
    return {
      enviados, bloqueados, falhas,
      aguardandoAquecimento: aguardando, campanhasConcluidas: concluidas,
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('campanha_despacho'))`
  }
}
