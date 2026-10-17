import {
  avaliarFase, diasUteisEntre, ehModoAgente, faseDoModo, indisponivel, inicioDaFasePorAuditoria, janelaDaFase, medido,
  msPausadosPeloTeto, pausadoPeloTeto, semanaDaData, deslocarSemana, somarConcordancia, somarPlayground, taxaSombra, taxasDaSugestao,
  CONVERSAO_MATURACAO_DIAS, CRITERIOS_RUBRICA, FONTES_DA_FASE, LIMIAR_SIMILARIDADE_SOMBRA, MODO_DA_FASE, ROTULO_FASE,
  type FaseAgente, type FonteMedida, type GoLiveDto, type MedidasFase, type ModoAgente, type MotivoAmostra,
  type MudancaDeConfig, type MudancaDeTeto, type RevisaoParaSomar,
} from '@geracrm/shared'
import { emSavepoint, type Sql } from '../../../db/index.js'
import { momentoNoFuso } from '../../plataforma/fuso.js'
import { metricaSlaHandoff } from '../sla-metrica.js'
import { conferenciaVigente, cortePlayground, decisaoTemCritica, entradasPlayground } from './homologacao.js'
import { lerFatosDoModo, modoEfetivoDoCanal } from './pipeline/modo-efetivo.js'

/**
 * GO-LIVE (raia P19): COLETA as medidas de cada critério de fase e entrega à
 * avaliação PURA (`avaliarFase`, shared). Aqui só há leitura — o painel nunca
 * muda o modo (isso é a tela da P14, com confirmação e auditoria).
 *
 * ⚠️ Cada fonte roda no próprio SAVEPOINT: uma fonte que falha vira critério
 *    "sem medida" com o motivo, e as outras seguem (degrada, não quebra).
 * ⚠️ Só as fontes da fase atual são lidas (`FONTES_DA_FASE`).
 * ⚠️ Toda janela é [desde, agora) com o `agora` de quem chama — nada de `now()`
 *    escondido em consulta de outra raia (a medida fica reproduzível no teste).
 * ⚠️ Tudo sob RLS do tenant (tx de `req.comTenant`), filtrado pelo número.
 */

const DIA_MS = 86_400_000
const MAX_SEMANAS_CONCORDANCIA = 13
const MAX_MUDANCAS_AUDITADAS = 200

export interface ContextoColeta {
  readonly canalId: string
  readonly agora: Date
  readonly fuso: string | null
  /** O modo de `agente_decisao` que a fase produz. */
  readonly modo: ModoAgente | 'simulacao'
  /** Início da janela das medidas. */
  readonly desde: Date
  /** Início da janela do "0 CRÍTICA" (14 dias no recorte, 30 no amplo). */
  readonly desdeCritica: Date
}

type Coletor<K extends FonteMedida> = (tx: Sql, c: ContextoColeta) => Promise<MedidasFase[K]>
export type Coletores = { readonly [K in FonteMedida]: Coletor<K> }

/** Mesma definição de sugestão da P13 (`sugestao.ts`): assistido que gerou texto. */
const ehSugestaoAssistido = (tx: Sql) => tx`d.modo = 'assistido' AND d.desfecho IN ('sugeriu', 'handoff')
  AND jsonb_typeof(d.resposta->'mensagens') = 'array' AND jsonb_array_length(d.resposta->'mensagens') > 0`

const semConferencia = (o_que: string, como: string) =>
  indisponivel(`Sem conferência ${o_que} nos últimos 30 dias. ${como}`)

/** As fontes padrão. Exportadas para o teste trocar uma por uma que falha. */
export const COLETORES: Coletores = {
  async douradas(tx, c) {
    const conf = await conferenciaVigente(tx, c.canalId, 'douradas', c.agora)
    if (!conf) return semConferencia('das conversas douradas', 'Rode pnpm agente:avaliar e registre cenários e CRÍTICAs no painel (administrador).')
    return medido({
      cenarios: Number(conf.resultado['cenarios']), criticas: Number(conf.resultado['criticas']), em: conf.atualizadoEm.toISOString(), por: conf.por,
    })
  },

  async smoke(tx, c) {
    const conf = await conferenciaVigente(tx, c.canalId, 'smoke', c.agora)
    if (!conf) return semConferencia('do smoke', 'Rode pnpm agente:smoke e registre o resultado no painel (administrador).')
    return medido({ ok: conf.resultado['ok'] === true, em: conf.atualizadoEm.toISOString(), por: conf.por })
  },

  async playground(tx, c) {
    // Uma entrada por reinício (0109) + a conversa de teste ainda aberta (como se reiniciasse agora).
    // Só depois do corte (última publicação de playbook ou mudança na configuração do número).
    const corte = await cortePlayground(tx, c.canalId, c.agora)
    const entradas = await entradasPlayground(tx, c.canalId)
    const aberta = await tx<{ guardrails: unknown; criado_em: Date }[]>`
      SELECT d.guardrails, d.criado_em FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'simulacao'
         AND d.criado_em < ${c.agora}
         ${corte ? tx`AND d.criado_em >= ${corte}` : tx``}
       ORDER BY d.criado_em DESC LIMIT 500`
    const todas = aberta.length > 0
      ? [...entradas, { em: c.agora.toISOString(), turnos: aberta.length, criticas: aberta.filter((d) => decisaoTemCritica(d.guardrails)).length }]
      : entradas
    const soma = somarPlayground(todas, { agora: c.agora.toISOString(), corte: corte ? corte.toISOString() : null })
    return medido({ ...soma, corte: corte ? corte.toISOString() : null })
  },

  async volume(tx, c) {
    const [r] = await tx<{ turnos: number; conversas: number }[]>`
      SELECT count(*)::int AS turnos, count(DISTINCT d.conversa_id)::int AS conversas
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = ${c.modo}
         AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}`
    return medido({ turnos: r?.turnos ?? 0, conversas: r?.conversas ?? 0 })
  },

  async criticas(tx, c) {
    // O que ESCAPOU (P12): `pior_gravidade` já ignora as marcas corrigidas pelo pipeline.
    const [r] = await tx<{ n: number }[]>`
      SELECT count(DISTINCT a.decisao_id)::int AS n FROM agente_avaliacao a
       WHERE a.tenant_id = tenant_atual() AND a.canal_id = ${c.canalId}
         AND a.pior_gravidade = 'CRITICA' AND a.criado_em >= ${c.desdeCritica} AND a.criado_em < ${c.agora}`
    return medido(r?.n ?? 0)
  },

  async notaJuiz(tx, c) {
    const [r] = await tx<{ media: string | null; n: number }[]>`
      SELECT round(avg(a.nota_media), 2)::text AS media, count(*)::int AS n FROM agente_avaliacao a
       WHERE a.tenant_id = tenant_atual() AND a.canal_id = ${c.canalId} AND a.tipo = 'juiz'
         AND a.nota_media IS NOT NULL AND a.erro IS NULL AND a.criado_em >= ${c.desde} AND a.criado_em < ${c.agora}`
    return medido({ media: r?.media == null ? null : Number(r.media), avaliadas: r?.n ?? 0 })
  },

  async concordancia(tx, c) {
    // P16 conta uma revisão por (conversa, SEMANA); aqui a janela inteira é a
    // unidade — a mesma conversa revisada em duas semanas conta UMA vez no mínimo de 20.
    const semanas = semanasDaJanela(c.desde, c.agora, c.fuso)
    const linhas = await tx<{
      conversa_id: string; criado_em: Date; concordancia: Record<string, boolean | null>; concorda: boolean | null
      motivo: string | null; falso_negativo_critica: boolean
    }[]>`
      SELECT conversa_id, criado_em, concordancia, concorda, motivo, falso_negativo_critica FROM agente_revisao
       WHERE tenant_id = tenant_atual() AND canal_id = ${c.canalId} AND semana = ANY(${semanas}::text[])`
    const revs: RevisaoParaSomar[] = linhas.map((l) => ({
      conversaId: l.conversa_id, semana: 'janela', criadoEm: new Date(l.criado_em).toISOString(),
      concorda: l.concorda, motivo: l.motivo as MotivoAmostra | null, falsoNegativoCritica: l.falso_negativo_critica,
      gravidade: l.concordancia['gravidade'] === true,
      porCriterio: Object.fromEntries(CRITERIOS_RUBRICA.map((k) => [k, l.concordancia[k] ?? null])),
    }))
    const t = somarConcordancia(revs)
    return medido({ valor: t.concordancia, comparaveis: t.conversasComparaveis, falsosNegativosCritica: t.falsosNegativosCritica })
  },

  async similaridadeSombra(tx, c) {
    // Mesma régua da P13 (`metricasSugestoes`), na janela [desde, agora) do painel.
    const [s] = await tx<{ comparados: number; acima: number }[]>`
      SELECT count(*)::int AS comparados,
             count(*) FILTER (WHERE d.sombra_similaridade >= ${LIMIAR_SIMILARIDADE_SOMBRA})::int AS acima
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'sombra'
         AND d.sombra_similaridade IS NOT NULL AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}`
    const comparados = s?.comparados ?? 0
    return medido({ comparados, taxaAcima: taxaSombra({ comparados, acimaDoLimiar: s?.acima ?? 0, similaridadeMedia: null }) })
  },

  async sugestoes(tx, c) {
    // Mesma régua da P13 (`metricasSugestoes` + `taxasDaSugestao`), na janela [desde, agora).
    const [l] = await tx<{ geradas: number; enviadas: number; editadas: number; descartadas: number; superadas: number; pendentes: number }[]>`
      SELECT count(*)::int AS geradas,
             count(*) FILTER (WHERE d.sugestao_estado = 'enviada')::int AS enviadas,
             count(*) FILTER (WHERE d.sugestao_estado = 'editada')::int AS editadas,
             count(*) FILTER (WHERE d.sugestao_estado = 'descartada')::int AS descartadas,
             count(*) FILTER (WHERE d.sugestao_estado = 'superada')::int AS superadas,
             count(*) FILTER (WHERE d.sugestao_estado IS NULL)::int AS pendentes
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND ${ehSugestaoAssistido(tx)}
         AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}`
    const n = { geradas: 0, enviadas: 0, editadas: 0, descartadas: 0, superadas: 0, pendentes: 0, ...l }
    const t = taxasDaSugestao({ ...n, criticas: 0, similaridadeMediaEditadas: null })
    return medido({ geradas: n.geradas, usadas: n.enviadas + n.editadas, taxaUso: t.taxaUso, taxaSemEdicao: t.taxaSemEdicao })
  },

  async custoPorConversa(tx, c) {
    const [r] = await tx<{ custo: string; conversas: number; juiz: string }[]>`
      SELECT coalesce(sum(d.custo_centavos), 0)::text AS custo, count(DISTINCT d.conversa_id)::int AS conversas,
             (SELECT coalesce(sum(a.custo_centavos), 0) FROM agente_avaliacao a
               WHERE a.tenant_id = tenant_atual() AND a.canal_id = ${c.canalId} AND a.tipo = 'juiz'
                 AND a.criado_em >= ${c.desde} AND a.criado_em < ${c.agora})::text AS juiz
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = ${c.modo}
         AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}`
    const conversas = r?.conversas ?? 0
    return medido({
      centavos: conversas ? Math.round(Number(r!.custo) / conversas) : null, conversas, juizCentavos: Number(r?.juiz ?? 0),
    })
  },

  async numerosBloqueados(tx, c) {
    // R$ sem fonte (numeros_bloqueados) + número de negócio sem fonte substituído (P7).
    const [r] = await tx<{ turnos: number; com: number }[]>`
      SELECT count(*)::int AS turnos,
             count(*) FILTER (WHERE jsonb_array_length(d.numeros_bloqueados) > 0
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.guardrails) g
                            WHERE g->>'etapa' = 'numeros-ampliados' AND g->>'acao' IN ('substituido', 'bloqueado')))::int AS com
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = ${c.modo}
         AND d.resposta IS NOT NULL AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}`
    return medido({ turnos: r?.turnos ?? 0, comBloqueio: r?.com ?? 0 })
  },

  async latenciaPrimeira(tx, c) {
    // Do cliente falar até o cliente ler: 1ª mensagem do agente (mensagens_saida_ids)
    // − a mensagem mais antiga que o turno respondeu (mensagens_ids), na 1ª resposta
    // enviada de cada sessão. Inclui o debounce da fila — é o que o cliente sente.
    // `mensagem` é particionada por criado_em: a busca fica entre 7 dias antes e 1 dia depois
    // da decisão (o cliente pode ter falado dias antes de um turno reagendado). Sessão cujas
    // mensagens não aparecem conta em `semMedida`, à vista na tela.
    const [r] = await tx<{ p95: number | null; n: number; sem: number }[]>`
      SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY s.ms) FILTER (WHERE s.ms IS NOT NULL AND s.ms >= 0)::int AS p95,
             count(*) FILTER (WHERE s.ms IS NOT NULL AND s.ms >= 0)::int AS n,
             count(*) FILTER (WHERE s.ms IS NULL OR s.ms < 0)::int AS sem
        FROM (SELECT DISTINCT ON (d.sessao_id)
                     EXTRACT(EPOCH FROM (
                       (SELECT min(m.criado_em) FROM mensagem m
                         WHERE m.tenant_id = d.tenant_id AND m.conversa_id = d.conversa_id AND m.id = ANY(d.mensagens_saida_ids)
                           AND m.criado_em BETWEEN d.criado_em - interval '7 days' AND d.criado_em + interval '1 day')
                     - (SELECT min(m.criado_em) FROM mensagem m
                         WHERE m.tenant_id = d.tenant_id AND m.conversa_id = d.conversa_id AND m.id = ANY(d.mensagens_ids)
                           AND m.criado_em BETWEEN d.criado_em - interval '7 days' AND d.criado_em + interval '1 day')
                     )) * 1000 AS ms
                FROM agente_decisao d
               WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'autonomo'
                 AND d.enviada AND d.sessao_id IS NOT NULL AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}
               ORDER BY d.sessao_id, d.criado_em) s`
    return medido({ p95Ms: r?.p95 ?? null, amostras: r?.n ?? 0, semMedida: r?.sem ?? 0 })
  },

  async handoff(tx, c) {
    const [r] = await tx<{ conversas: number; com: number }[]>`
      SELECT count(DISTINCT d.conversa_id)::int AS conversas,
             count(DISTINCT d.conversa_id) FILTER (WHERE d.desfecho = 'handoff')::int AS com
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'autonomo'
         AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}`
    return medido({ conversas: r?.conversas ?? 0, comHandoff: r?.com ?? 0 })
  },

  async optOut(tx, c) {
    // O gatilho de opt-out (P4) marca a decisão: `gatilhos-entrada/opt_out` (ou o pedido de exclusão LGPD).
    const [r] = await tx<{ conversas: number; com: number }[]>`
      SELECT count(DISTINCT d.conversa_id)::int AS conversas,
             count(DISTINCT d.conversa_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM jsonb_array_elements(d.guardrails) g
                WHERE g->>'etapa' = 'gatilhos-entrada' AND g->>'codigo' IN ('opt_out', 'lgpd_exclusao')))::int AS com
        FROM agente_decisao d
       WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'autonomo'
         AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}`
    return medido({ conversas: r?.conversas ?? 0, comOptOut: r?.com ?? 0 })
  },

  async conversao(tx, c) {
    // Coortes MADURAS: só entra quem entrou na coorte há ≥ 14 dias (teve tempo de virar pedido).
    //   agente: conversas do número em que ele atuou em autônomo; entrada = 1ª decisão na janela.
    //   humano: as demais conversas do número com o cliente falando na janela E respondidas por uma
    //           pessoa (régua da P18); entrada = 1ª entrante.
    // Convertida: pedido confirmado pelo cliente ou efetivado DEPOIS da entrada (EXISTS correlacionado,
    // índice parcial `pedido_conversao_por_conversa`, 0109). A conversa de simulação não entra.
    const maduroAte = new Date(c.agora.getTime() - CONVERSAO_MATURACAO_DIAS * DIA_MS)
    const [r] = await tx<{ ag: number; ag_c: number; hu: number; hu_c: number }[]>`
      WITH ag AS (
        SELECT d.conversa_id AS id, min(d.criado_em) AS entrada FROM agente_decisao d
         WHERE d.tenant_id = tenant_atual() AND d.canal_id = ${c.canalId} AND d.modo = 'autonomo'
           AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde} AND d.criado_em < ${c.agora}
         GROUP BY d.conversa_id
        HAVING min(d.criado_em) <= ${maduroAte}),
      hu AS (
        SELECT x.id, x.entrada FROM (
          SELECT cv.id,
                 (SELECT min(m.criado_em) FROM mensagem m
                   WHERE m.tenant_id = cv.tenant_id AND m.conversa_id = cv.id AND m.direcao = 'entrante'
                     AND m.criado_em >= ${c.desde} AND m.criado_em < ${c.agora}) AS entrada
            FROM conversa cv
           WHERE cv.tenant_id = tenant_atual() AND cv.canal_id = ${c.canalId} AND cv.ultima_mensagem_em >= ${c.desde}
             AND NOT EXISTS (SELECT 1 FROM agente_decisao d
                              WHERE d.tenant_id = cv.tenant_id AND d.conversa_id = cv.id
                                AND d.modo IN ('autonomo', 'simulacao') AND d.desfecho <> 'silencio' AND d.criado_em >= ${c.desde})
             AND NOT EXISTS (SELECT 1 FROM contato ct
                              WHERE ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id AND ct.origem_carga = 'simulacao')) x
         WHERE x.entrada IS NOT NULL AND x.entrada <= ${maduroAte}
           -- Atendida por GENTE: a mesma régua da resposta humana do SLA (P18,
           -- respostaHumanaDoAtendimento): saliente com autor. Conversa sem resposta
           -- de ninguém não é coorte humana — é abandono, e puxaria a base para baixo.
           AND EXISTS (SELECT 1 FROM mensagem m
                        WHERE m.tenant_id = tenant_atual() AND m.conversa_id = x.id AND m.direcao = 'saliente'
                          AND m.enviada_por_id IS NOT NULL AND m.criado_em >= x.entrada AND m.criado_em < ${c.agora}))
      SELECT (SELECT count(*) FROM ag)::int AS ag,
             (SELECT count(*) FROM ag WHERE EXISTS (
                SELECT 1 FROM pedido p WHERE p.tenant_id = tenant_atual() AND p.conversa_id = ag.id
                   AND (p.confirmado_em IS NOT NULL OR p.estado = 'efetivado') AND p.criado_em >= ag.entrada))::int AS ag_c,
             (SELECT count(*) FROM hu)::int AS hu,
             (SELECT count(*) FROM hu WHERE EXISTS (
                SELECT 1 FROM pedido p WHERE p.tenant_id = tenant_atual() AND p.conversa_id = hu.id
                   AND (p.confirmado_em IS NOT NULL OR p.estado = 'efetivado') AND p.criado_em >= hu.entrada))::int AS hu_c`
    return medido({
      agente: { conversas: r?.ag ?? 0, convertidas: r?.ag_c ?? 0 },
      humano: { conversas: r?.hu ?? 0, convertidas: r?.hu_c ?? 0 },
    })
  },

  async pedidosErrados(tx, c) {
    // APROXIMAÇÃO de "confirmado errado": pedido montado pelo agente, CONFIRMADO pelo
    // cliente e cancelado depois. O domínio não registra "erro do pedido"; o
    // cancelamento após a confirmação é o sinal que existe (pode ser desistência).
    const [r] = await tx<{ confirmados: number; cancelados: number }[]>`
      SELECT count(*)::int AS confirmados,
             count(*) FILTER (WHERE p.estado = 'cancelado' AND p.cancelado_em >= p.confirmado_em)::int AS cancelados
        FROM pedido p
        JOIN conversa cv ON cv.tenant_id = p.tenant_id AND cv.id = p.conversa_id
       WHERE p.tenant_id = tenant_atual() AND cv.canal_id = ${c.canalId} AND p.origem = 'agente'
         AND p.confirmado_em IS NOT NULL AND p.confirmado_em >= ${c.desde} AND p.confirmado_em < ${c.agora}`
    return medido({ confirmados: r?.confirmados ?? 0, cancelados: r?.cancelados ?? 0 })
  },

  async slaHandoff(tx, c) {
    // A MESMA régua de /v1/performance (`metricaSlaHandoff`), só deste número.
    return medido(await metricaSlaHandoff(tx, { desde: c.desde, agora: c.agora, canalId: c.canalId }))
  },
}

/** As semanas ISO (no fuso da loja) que a janela toca, da mais antiga à atual. */
export function semanasDaJanela(desde: Date, agora: Date, fuso: string | null): string[] {
  const fim = semanaDaData(momentoNoFuso(agora, fuso).data)
  if (!fim) return []
  const ini = semanaDaData(momentoNoFuso(desde, fuso).data) ?? fim
  const semanas: string[] = [fim]
  let s = fim
  while (s !== ini && semanas.length < MAX_SEMANAS_CONCORDANCIA) {
    const anterior = deslocarSemana(s, -1)
    if (!anterior) break
    semanas.unshift(anterior)
    s = anterior
  }
  return semanas
}

/**
 * Quando a fase começou (M4): a última mudança AUDITADA do número que TROCOU a
 * fase (reconstruída com `antes/depois` da auditoria, `inicioDaFasePorAuditoria`).
 * O teto do tenant não entra: kill switch pausa, não muda a fase. Sem mudança
 * auditada que troque a fase (configuração anterior à P14), estima pela 1ª
 * decisão no modo da fase nos últimos 90 dias.
 */
async function inicioDaFase(
  tx: Sql, p: { canalId: string; modoNumero: ModoAgente; recorte: unknown; modo: ModoAgente | 'simulacao'; agora: Date },
): Promise<{ inicio: Date | null; estimado: boolean }> {
  const auditorias = await tx<{ criado_em: Date; dados: { antes?: Record<string, unknown>; depois?: Record<string, unknown>; criacao?: boolean } }[]>`
    SELECT criado_em, dados FROM auditoria
     WHERE tenant_id = tenant_atual() AND entidade = 'agente_config' AND entidade_id = ${p.canalId}
       AND acao = 'agente.config_alterada' AND criado_em <= ${p.agora}
     ORDER BY criado_em DESC LIMIT ${MAX_MUDANCAS_AUDITADAS}`
  const mudancas: MudancaDeConfig[] = auditorias.map((a) => ({
    em: new Date(a.criado_em).toISOString(), antes: a.dados.antes ?? {}, depois: a.dados.depois ?? {}, criacao: a.dados.criacao === true,
  }))
  const pelaAuditoria = inicioDaFasePorAuditoria({ modoNumero: p.modoNumero, recorte: p.recorte }, mudancas)
  if (pelaAuditoria) return { inicio: new Date(pelaAuditoria), estimado: false }
  const [d] = await tx<{ em: Date | null }[]>`
    SELECT min(criado_em) AS em FROM agente_decisao
     WHERE tenant_id = tenant_atual() AND canal_id = ${p.canalId} AND modo = ${p.modo}
       AND criado_em >= ${new Date(p.agora.getTime() - 90 * DIA_MS)} AND criado_em < ${p.agora}`
  return { inicio: d?.em ? new Date(d.em) : null, estimado: true }
}

/**
 * Quanto do tempo desde o início da fase o teto do tenant pausou o número
 * (kill switch abaixo do modo dele): esse tempo não conta como dias na fase.
 */
async function msPausados(
  tx: Sql, p: { inicio: Date; agora: Date; modoNumero: ModoAgente; tetoAtual: ModoAgente | null },
): Promise<number> {
  const linhas = await tx<{ criado_em: Date; dados: { antes?: { modoMaximo?: unknown } } }[]>`
    SELECT criado_em, dados FROM auditoria
     WHERE tenant_id = tenant_atual() AND entidade = 'agente_tenant' AND acao = 'agente.config_alterada'
       AND criado_em > ${p.inicio} AND criado_em <= ${p.agora}
     ORDER BY criado_em DESC LIMIT ${MAX_MUDANCAS_AUDITADAS}`
  // Sem linha em agente_tenant o teto é autônomo (= sem teto): o PUT audita 'autonomo' nesse caso.
  const mudancas: MudancaDeTeto[] = linhas.map((l) => {
    const antes = l.dados.antes?.modoMaximo
    return { em: new Date(l.criado_em).toISOString(), antes: ehModoAgente(antes) ? antes : null }
  })
  return msPausadosPeloTeto({ inicio: p.inicio.toISOString(), agora: p.agora.toISOString(), modoNumero: p.modoNumero, tetoAtual: p.tetoAtual, mudancas })
}

/**
 * O painel de go-live de um número. null = número inexistente (ou de outro
 * tenant: invisível pelo RLS). `podeConferir` vem de quem pede (admin).
 */
export async function coletarGoLive(
  tx: Sql, p: { canalId: string; agora: Date; podeConferir?: boolean }, coletores: Coletores = COLETORES,
): Promise<GoLiveDto | null> {
  const [canal] = await tx<{ id: string; fuso: string | null }[]>`
    SELECT cc.id, (SELECT fuso FROM tenant WHERE id = tenant_atual()) AS fuso
      FROM canal_conectado cc WHERE cc.tenant_id = tenant_atual() AND cc.id = ${p.canalId}`
  if (!canal) return null

  const [cfg] = await tx<{ modo: string; recorte: unknown }[]>`
    SELECT modo, recorte FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${p.canalId}`
  const modoNumero: ModoAgente = cfg && ehModoAgente(cfg.modo) ? cfg.modo : 'desligado'
  const recorte = cfg?.recorte ?? null
  const fatos = await lerFatosDoModo(tx, p.agora, p.canalId)
  const fase: FaseAgente = faseDoModo({ modoNumero, recorte })
  const agora = await modoEfetivoDoCanal(tx, { canalId: p.canalId, agora: p.agora })

  const modo = MODO_DA_FASE[fase]
  const { inicio, estimado } = await inicioDaFase(tx, { canalId: p.canalId, modoNumero, recorte, modo, agora: p.agora })
  // Dias pausados pelo teto não contam: a contagem anda como se a fase tivesse começado depois.
  const pausadoMs = inicio ? await msPausados(tx, { inicio, agora: p.agora, modoNumero, tetoAtual: fatos.modoTenant }) : 0
  const inicioEfetivo = inicio ? new Date(inicio.getTime() + pausadoMs) : null
  const dias = inicioEfetivo ? Math.max(0, Math.floor((p.agora.getTime() - inicioEfetivo.getTime()) / DIA_MS)) : 0
  const diasUteis = inicioEfetivo ? diasUteisEntre(momentoNoFuso(inicioEfetivo, canal.fuso).data, momentoNoFuso(p.agora, canal.fuso).data) : 0
  const janela = janelaDaFase(fase, dias)
  const ctx: ContextoColeta = {
    canalId: p.canalId, agora: p.agora, fuso: canal.fuso, modo,
    desde: new Date(p.agora.getTime() - janela.dias * DIA_MS),
    desdeCritica: new Date(p.agora.getTime() - janela.diasCritica * DIA_MS),
  }

  const medidas: Partial<Record<FonteMedida, MedidasFase[FonteMedida]>> = {}
  for (const fonte of FONTES_DA_FASE[fase]) {
    try {
      medidas[fonte] = await emSavepoint(tx, (sp) => (coletores[fonte] as Coletor<typeof fonte>)(sp, ctx))
    } catch (e) {
      // Degrada visível: o critério diz que a fonte falhou; os outros seguem.
      console.warn(JSON.stringify({ evento: 'go_live.fonte_falhou', fonte, canalId: p.canalId, erro: e instanceof Error ? e.message.slice(0, 200) : 'desconhecido' }))
      medidas[fonte] = indisponivel('A fonte não respondeu agora. Tente de novo; se persistir, avise o suporte.')
    }
  }

  const r = avaliarFase({ fase, diasCorridos: dias, diasUteis, medidas: medidas as Partial<MedidasFase> })
  return {
    ...r,
    canalId: p.canalId, rotuloFase: ROTULO_FASE[fase],
    dias, diasUteis, inicioFase: inicio ? inicio.toISOString() : null, inicioEstimado: estimado,
    janelaDias: janela.dias,
    modoNumero, pausadoPeloTeto: pausadoPeloTeto(modoNumero, fatos.modoTenant),
    diasPausados: Math.round((pausadoMs / DIA_MS) * 10) / 10, podeConferir: p.podeConferir ?? false,
    modoAgora: { modo: agora.modo, origem: agora.origem, motivo: agora.motivo },
    alvosProposta: true,
  }
}
