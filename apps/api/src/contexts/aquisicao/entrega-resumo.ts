import type { Sql } from '../../db/index.js'
import { montarResumo, type ResumoDiario } from './resumo-diario.js'

/**
 * A ENTREGA DO RESUMO DIÁRIO (AQ-08) — o canal, decidido.
 *
 * O resumo já era montado e a entrega era injetada, porque o canal estava em
 * aberto. A decisão com o dono do produto (2026-08-24) foi **webhook de saída**
 * (`0033`), e por três motivos que continuam valendo:
 *
 * - já existe, **assinado com HMAC**, com cursor, retry e dead-letter;
 * - **não gasta número nem aquecimento** da frota (`0037`) — mandar relatório
 *   interno pelo canal não-oficial misturaria tráfego operacional com tráfego de
 *   atendimento no mesmo número, e contaria contra o teto diário;
 * - o cliente escolhe o destino (Slack, e-mail via automação, o que ele usar)
 *   sem que o produto precise conhecer nenhum desses canais.
 *
 * ⚠️ **O evento CARREGA CONTEÚDO, e isto é deliberado** — é a exceção à regra do
 * ADR-007 de "payload sem conteúdo", que existe para o caminho do SSE. Confira
 * por que ela não vale aqui:
 *
 * - o `NOTIFY` do `0026` projeta só `tenantId`, `id`, `tipo`, `conversaId` e
 *   `versao` — o texto do resumo **não entra** no barramento de tempo real;
 * - o replay do SSE também só projeta `conversaId`/`versao`, então o navegador
 *   nunca recebe este payload;
 * - o consumidor é o despachante de webhook, que entrega para uma URL que o
 *   próprio tenant cadastrou, filtrando por `tenant_id`.
 *
 * Se o payload fosse vazio, o receptor precisaria de uma credencial de API para
 * ir buscar o resumo — e o webhook de saída não tem uma.
 */

/** Hora LOCAL do tenant em que o resumo do dia sai. */
export const HORA_RESUMO_LOCAL = Number(process.env.RESUMO_MIDIA_HORA ?? 20)

/** ⚠️ Fim do dia, não começo: às 8h o "hoje" do resumo estaria vazio. */
export const TIPO_EVENTO_RESUMO = 'midia.resumo_diario'

export interface ResultadoResumoDiario {
  readonly avaliados: number
  readonly entregues: number
  readonly semDado: number
  readonly foraDaHora: number
  readonly jaEntregues: number
}

/**
 * O que aconteceu com UM tenant nesta passada. Estado NOMEADO, não booleano:
 * "não entregou" tem quatro causas diferentes, e distinguir "ainda não deu a
 * hora" de "não havia o que dizer" é a diferença entre esperar e investigar.
 */
export type ResultadoTenant =
  | 'entregue'
  | 'fora_da_hora'
  | 'ja_entregue'
  | 'sem_dado'
  | 'tenant_desconhecido'

/**
 * Grava o evento na outbox e o recibo do dia, **no mesmo commit**.
 *
 * ⚠️ O recibo entra PRIMEIRO e com `ON CONFLICT DO NOTHING RETURNING`: se outro
 * processo já entregou hoje, ele não devolve linha e o evento nem chega a ser
 * criado. É a trava de "uma vez por dia" (`0061`) fazendo o trabalho, em vez de
 * um `SELECT` antes do `INSERT` — que perde a corrida por construção.
 */
export async function entregarNoOutbox(
  sql: Sql, resumo: ResumoDiario, dia: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [recibo] = await tx<{ dia: string }[]>`
      INSERT INTO midia_resumo_entregue (tenant_id, dia)
      VALUES (${resumo.tenantId}, ${dia}::date)
      ON CONFLICT (tenant_id, dia) DO NOTHING
      RETURNING dia`
    if (!recibo) return false

    const [ev] = await tx<{ id: string }[]>`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (${resumo.tenantId}, ${TIPO_EVENTO_RESUMO}, 'midia', NULL,
              ${JSON.stringify({
                dia: resumo.dia,
                texto: resumo.texto,
                linhas: resumo.linhas,
                alertas: resumo.alertas,
              })}::text::jsonb)
      RETURNING id`

    await tx`
      UPDATE midia_resumo_entregue SET outbox_id = ${ev!.id}
       WHERE tenant_id = ${resumo.tenantId} AND dia = ${dia}::date`
    return true
  }) as Promise<boolean>
}

/**
 * O resumo de UM tenant: decide a hora no fuso DELE, confere o recibo do dia,
 * monta e entrega.
 *
 * ⚠️ A hora e o dia saem do **fuso do tenant**, calculados pelo banco. Ler o
 * relógio do servidor (UTC) mandaria o resumo de Manaus (UTC-4) carimbado com o
 * dia seguinte — e às 16h da tarde dele.
 */
export async function entregarResumoDoTenant(
  sql: Sql, tenantId: string, agora: Date,
): Promise<ResultadoTenant> {
  const [t] = await sql<{ hora_local: number; dia_local: string }[]>`
    SELECT EXTRACT(HOUR FROM (${agora}::timestamptz AT TIME ZONE t.fuso))::int AS hora_local,
           to_char((${agora}::timestamptz AT TIME ZONE t.fuso)::date, 'YYYY-MM-DD') AS dia_local
      FROM tenant t WHERE t.id = ${tenantId}`
  if (!t) return 'tenant_desconhecido'
  if (t.hora_local < HORA_RESUMO_LOCAL) return 'fora_da_hora'

  const [ja] = await sql<{ dia: string }[]>`
    SELECT dia FROM midia_resumo_entregue
     WHERE tenant_id = ${tenantId} AND dia = ${t.dia_local}::date`
  if (ja) return 'ja_entregue'

  const resumo = await montarResumo(sql, tenantId, agora, t.dia_local)
  // "Sem dado" ≠ "tudo zero": resumo vazio todo dia é o caminho mais curto para
  // o cliente parar de ler os que importam.
  if (!resumo.temDado) return 'sem_dado'

  return (await entregarNoOutbox(sql, resumo, t.dia_local)) ? 'entregue' : 'ja_entregue'
}

/**
 * Uma passada por todos os tenants com conta de mídia: quem já passou da hora
 * local e ainda não recebeu o resumo de hoje, recebe.
 *
 * ⚠️ Guardada por advisory lock, como as outras varreduras — duas instâncias
 * montando ao mesmo tempo custaria consulta em dobro (a trava do `0061` já
 * impediria a entrega dupla, mas trabalho jogado fora continua sendo trabalho).
 *
 * ⚠️ **Dia sem dado não vira recibo**, e por isso volta a ser avaliado na
 * próxima passada: um lead que entra às 21h faz o resumo sair às 21h. O que não
 * acontece é sair duas vezes — disso cuida a chave `(tenant_id, dia)`.
 */
export async function varrerResumoDiario(sql: Sql, agora: Date): Promise<ResultadoResumoDiario> {
  const vazio: ResultadoResumoDiario = {
    avaliados: 0, entregues: 0, semDado: 0, foraDaHora: 0, jaEntregues: 0,
  }

  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('midia_resumo_diario')) AS ok`
  if (!trava?.ok) return vazio

  try {
    // Só quem tem conta de mídia ativa — os demais não têm o que relatar.
    const tenants = await sql<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM midia_conta WHERE ativo`

    let entregues = 0, semDado = 0, foraDaHora = 0, jaEntregues = 0

    for (const { tenant_id } of tenants) {
      switch (await entregarResumoDoTenant(sql, tenant_id, agora)) {
        case 'entregue': entregues++; break
        case 'sem_dado': semDado++; break
        case 'fora_da_hora': foraDaHora++; break
        case 'ja_entregue': jaEntregues++; break
        default: break
      }
    }

    return { avaliados: tenants.length, entregues, semDado, foraDaHora, jaEntregues }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('midia_resumo_diario'))`
  }
}
