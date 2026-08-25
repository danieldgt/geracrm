import type { Sql } from '../../db/index.js'
import {
  ehFalhaPermanente,
  type ConversaoParaEnvio,
  type MotivoFalhaPlataforma,
  type PortaPlataformaMidia,
} from './plataformas/porta.js'

/**
 * DESPACHANTE DE CONVERSÕES (AQ-15) — devolve à plataforma o que o lead virou.
 *
 * Mesma forma do despachante de `webhook_saida` (0033): varredura guardada por
 * advisory lock, retentativa com backoff e dead-letter. As diferenças estão
 * comentadas onde aparecem, e nenhuma é estética.
 *
 * ⚠️ Roda como DONO (worker), sem tenant de sessão — o isolamento vem do
 * `tenant_id` explícito em cada consulta, igual ao `automacao-motor`.
 */

/** Depois disto, a conversão vira dead-letter (`falhou`) e sai da fila. */
export const MAX_TENTATIVAS = 8

/**
 * ⚠️ Curva mais lenta que a do webhook (que começa em 30s e para em 1h), porque
 * o problema é outro: conversão não é notificação. A plataforma aceita o fato
 * dentro de uma janela de **dias**, então correr não traz benefício — e insistir
 * rápido contra uma API de anúncio gasta cota que a sincronização precisa.
 *
 * 5min → 10 → 20 → 40 → 80 → 160 → 320 → teto de 6h.
 */
export function backoffSegundos(tentativas: number): number {
  return Math.min(21_600, 300 * 2 ** Math.max(0, tentativas - 1))
}

/**
 * ⚠️ Janela de importação. As plataformas recusam conversão muito antiga; este é
 * o piso conservador entre elas. Descartamos ANTES de chamar, para não gastar
 * cota nem tentativa num fato que já nasceu recusado.
 *
 * A rigor é propriedade de cada plataforma e deveria vir do adaptador — fica
 * como constante até existir um adaptador real que discorde.
 */
export const DIAS_JANELA_IMPORTACAO = 90

/** Por que uma conversão foi descartada. ⚠️ Decisão NOSSA, não recusa da plataforma. */
export type MotivoDescarte =
  /** A origem não tem `click_id` — não há como a plataforma casar o evento. */
  | 'sem_identificador'
  /** O fato é mais velho que a janela de importação. */
  | 'fora_da_janela_de_importacao'
  /** O adaptador da plataforma não devolve conversão. */
  | 'plataforma_sem_capacidade'
  /**
   * ⚠️ A conta não tem `conversionAction` cadastrada. É falta de CADASTRO do
   * cliente na plataforma, não defeito nosso — e é por isso que descarta em vez
   * de retentar: oito tentativas não preenchem um campo em branco.
   */
  | 'conta_sem_acao_de_conversao'

export interface ResultadoDespacho {
  readonly enviadas: number
  readonly descartadas: number
  readonly reagendadas: number
  readonly falhadas: number
}

interface LinhaPendente {
  id: string
  tenant_id: string
  plataforma: string
  tipo_evento: 'lead' | 'lead_qualificado' | 'compra'
  valor_centavos: string | null
  event_id: string
  tentativas: number
  ocorrida_em: Date
  click_id: string | null
  click_id_tipo: 'gclid' | 'wbraid' | 'gbraid' | 'fbclid' | null
  conta_externa_id: string | null
  conversao_action_id: string | null
}

/** Decide, sem tocar na rede, se a conversão sequer deve ser tentada. */
export function avaliarDescarte(
  linha: { clickId: string | null; ocorridaEm: Date; acaoDeConversaoId?: string | null | undefined },
  temCapacidade: boolean,
  agora: Date,
): MotivoDescarte | null {
  if (!temCapacidade) return 'plataforma_sem_capacidade'
  if (!linha.clickId) return 'sem_identificador'
  // ⚠️ Sem a ação de conversão cadastrada na conta, o envio é recusa garantida.
  //    Descartar com motivo NOMEADO é melhor que gastar oito tentativas e um
  //    dead-letter para descobrir um campo em branco no cadastro.
  if (linha.acaoDeConversaoId === null) return 'conta_sem_acao_de_conversao'
  const idadeDias = (agora.getTime() - linha.ocorridaEm.getTime()) / 86_400_000
  if (idadeDias > DIAS_JANELA_IMPORTACAO) return 'fora_da_janela_de_importacao'
  return null
}

/**
 * O que fazer depois de uma recusa da plataforma.
 *
 * ⚠️ **`limite_de_taxa` NÃO consome tentativa.** Estourar cota não é defeito da
 * conversão — é do nosso ritmo. Se consumisse, uma rajada de rate limit mandaria
 * para o dead-letter um lote inteiro de conversões perfeitamente válidas, e a
 * receita sumiria do painel da plataforma sem ninguém entender por quê.
 *
 * ⚠️ Falha **permanente** vai direto ao dead-letter: retentar credencial
 * revogada oito vezes só atrasa em horas a descoberta de um problema humano.
 */
export function decidirAposFalha(
  motivo: MotivoFalhaPlataforma,
  tentativas: number,
): { acao: 'reagendar'; tentativas: number; esperaSegundos: number } | { acao: 'dead_letter' } {
  if (motivo === 'limite_de_taxa') {
    return { acao: 'reagendar', tentativas, esperaSegundos: backoffSegundos(tentativas + 1) }
  }
  if (ehFalhaPermanente(motivo)) return { acao: 'dead_letter' }
  const proximas = tentativas + 1
  if (proximas >= MAX_TENTATIVAS) return { acao: 'dead_letter' }
  return { acao: 'reagendar', tentativas: proximas, esperaSegundos: backoffSegundos(proximas) }
}

/** Fábrica de adaptador por plataforma — injetada para o teste usar um falso. */
export type AdaptadorPara = (plataforma: string) => PortaPlataformaMidia | null

/**
 * Uma passada pelas conversões pendentes e devidas de um tenant.
 *
 * ⚠️ Cada conversão é resolvida na **própria transação**: uma falha não pode
 * desfazer o que já foi entregue. É a mesma disciplina do handler idempotente.
 */
export async function despacharDoTenant(
  sql: Sql, tenantId: string, adaptadorPara: AdaptadorPara, agora: Date, limite = 100,
): Promise<ResultadoDespacho> {
  const pendentes = await sql<LinhaPendente[]>`
    SELECT c.id, c.tenant_id, c.plataforma, c.tipo_evento, c.valor_centavos::text AS valor_centavos,
           c.event_id, c.tentativas,
           coalesce(c.venda_ocorrida_em, c.criado_em) AS ocorrida_em,
           o.click_id, o.click_id_tipo,
           ct.id_externo AS conta_externa_id, ct.conversao_action_id
      FROM midia_conversao c
      JOIN midia_lead_origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
      LEFT JOIN midia_conta ct ON ct.tenant_id = o.tenant_id AND ct.id = o.conta_id
     WHERE c.tenant_id = ${tenantId}
       AND c.estado = 'pendente'
       AND c.proxima_tentativa_em <= ${agora}
     ORDER BY c.proxima_tentativa_em
     LIMIT ${limite}`

  let enviadas = 0, descartadas = 0, reagendadas = 0, falhadas = 0

  for (const linha of pendentes) {
    const adaptador = adaptadorPara(linha.plataforma)
    const temCapacidade = adaptador?.capacidades.conversaoOffline === true

    const descarte = avaliarDescarte(
      {
        clickId: linha.click_id,
        ocorridaEm: linha.ocorrida_em,
        // ⚠️ `undefined` (plataforma que não exige ação) ≠ `null` (Google sem
        //    cadastro). Só o segundo descarta.
        acaoDeConversaoId: adaptador?.capacidades.conversaoOffline
          ? linha.conversao_action_id
          : undefined,
      },
      temCapacidade, agora,
    )
    if (descarte !== null) {
      await sql`
        UPDATE midia_conversao
           SET estado = 'descartada', ultimo_erro = ${descarte}
         WHERE tenant_id = ${tenantId} AND id = ${linha.id}`
      descartadas++
      continue
    }

    const conversao: ConversaoParaEnvio = {
      eventId: linha.event_id,
      tipoEvento: linha.tipo_evento,
      // ⚠️ bigint volta como STRING do driver (INV-46) — cast explícito aqui.
      valorCentavos: linha.valor_centavos === null ? null : Number(linha.valor_centavos),
      clickId: linha.click_id!,
      clickIdTipo: linha.click_id_tipo,
      acaoDeConversaoId: linha.conversao_action_id,
      ocorridaEm: linha.ocorrida_em,
    }

    const r = await adaptador!.enviarConversao(linha.conta_externa_id ?? '', conversao)

    if (r.ok) {
      await sql`
        UPDATE midia_conversao
           SET estado = 'enviada', enviada_em = ${agora}, ultimo_erro = NULL
         WHERE tenant_id = ${tenantId} AND id = ${linha.id}`
      enviadas++
      continue
    }

    const decisao = decidirAposFalha(r.motivo, linha.tentativas)
    if (decisao.acao === 'dead_letter') {
      await sql`
        UPDATE midia_conversao
           SET estado = 'falhou', tentativas = ${linha.tentativas + 1}, ultimo_erro = ${r.motivo}
         WHERE tenant_id = ${tenantId} AND id = ${linha.id}`
      falhadas++
    } else {
      const proxima = new Date(agora.getTime() + decisao.esperaSegundos * 1000)
      await sql`
        UPDATE midia_conversao
           SET tentativas = ${decisao.tentativas}, proxima_tentativa_em = ${proxima},
               ultimo_erro = ${r.motivo}
         WHERE tenant_id = ${tenantId} AND id = ${linha.id}`
      reagendadas++
    }
  }

  return { enviadas, descartadas, reagendadas, falhadas }
}

/**
 * Varredura de todos os tenants com conversão pendente.
 *
 * ⚠️ Guardada por advisory lock: várias instâncias da API não despacham em dobro
 * — e conversão duplicada infla a receita no painel da plataforma, que é o erro
 * que ninguém reclama porque melhora o número.
 */
export async function despacharTodos(
  sql: Sql, adaptadorPara: AdaptadorPara, agora: Date,
): Promise<ResultadoDespacho> {
  const vazio: ResultadoDespacho = { enviadas: 0, descartadas: 0, reagendadas: 0, falhadas: 0 }

  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('midia_conversao_despacho')) AS ok`
  if (!trava?.ok) return vazio

  try {
    const tenants = await sql<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM midia_conversao
       WHERE estado = 'pendente' AND proxima_tentativa_em <= ${agora}`

    const total = { ...vazio }
    for (const { tenant_id } of tenants) {
      const r = await despacharDoTenant(sql, tenant_id, adaptadorPara, agora)
      total.enviadas += r.enviadas
      total.descartadas += r.descartadas
      total.reagendadas += r.reagendadas
      total.falhadas += r.falhadas
    }
    return total
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('midia_conversao_despacho'))`
  }
}
