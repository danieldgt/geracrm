import { TURNOS_ENTRE_AVALIACOES, amostraEfetiva, naAmostra, type GatilhoAvaliacao } from '@geracrm/shared'
import { comTenantServico, type Sql } from '../db/index.js'
import type { PortaLlmFerramentas } from '../contexts/atendimento/agente/porta-llm.js'
import { registrarRegrasPendentes, julgarSessao, tetoJuizEfetivo, type DesfechoJuiz } from '../contexts/atendimento/agente/qualidade/avaliacao.js'
import { juizDoAmbiente } from '../contexts/atendimento/agente/qualidade/juiz.js'

/**
 * WORKER DE QUALIDADE EM PRODUÇÃO (ADR-031, raia P12) — fora do caminho da
 * resposta. Agendado pela P0 em `server.ts` (a cada minuto, com batimento).
 *
 * Cada passada, como DONO para achar trabalho e sob o TENANT para gravar:
 *   1. REGRAS — toda decisão com resposta (sombra, assistido, autônomo,
 *      copiloto; não a simulação) ganha a sua avaliação 'regras', lida das
 *      marcas do turno. 100%, custo zero.
 *   2. JUIZ — só sessões na AMOSTRA ESTÁVEL (FNV-1a do id da conversa contra
 *      `qualidade_amostra` ou o padrão do modo), quando:
 *        - a sessão terminou (gatilho 'fim_sessao') e ainda não foi julgada no
 *          fim nem depois do último turno; ou
 *        - está ativa e andou 10 turnos desde o último julgamento ('turnos').
 *      O juiz avalia a ÚLTIMA decisão com resposta da sessão; teto MENSAL por
 *      número (`qualidade_teto_mes_centavos`); alerta ao bater no teto.
 *
 * Idempotente por (decisão, tipo): duas passadas (ou dois processos — a trava
 * consultiva já evita) nunca avaliam nem cobram duas vezes.
 */
export const INTERVALO_QUALIDADE_MS = 60_000
const LOTE_REGRAS = 500
const LOTE_JUIZ = 10
/** Sessões mais velhas que isso não são mais julgadas (o worker não revisita o histórico ao ligar). */
const JANELA_JUIZ_DIAS = 14

export interface RelatorioQualidade {
  readonly processadas: number
  readonly regras: number
  readonly julgadas: number
  readonly falhas: number
  readonly noTeto: number
  /** Por que o juiz não rodou nesta passada (sem credencial) — null quando rodou. */
  readonly juizIndisponivel: string | null
}

/**
 * Dependências injetáveis, todas OPCIONAIS (`server.ts` passa `{}`):
 * `juiz` troca a porta do ambiente (testes: porta falsa); `somenteTenant`
 * restringe a passada a um tenant (testes contra banco compartilhado).
 */
export interface DepsQualidade {
  readonly juiz?: PortaLlmFerramentas | undefined
  readonly modeloJuiz?: string | undefined
  readonly somenteTenant?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}

interface Candidata {
  readonly tenant_id: string
  readonly sessao_id: string
  readonly conversa_id: string
  readonly canal_id: string
  readonly canal_nome: string
  readonly modo: string | null
  readonly estado: string
  readonly turnos: number
  readonly amostra: string | null
  readonly teto: string | null
  readonly politicas: string | null
  readonly decisao_id: string | null
}

export async function processarQualidade(dono: Sql, deps: DepsQualidade = {}, agora: Date = new Date()): Promise<RelatorioQualidade> {
  const vazio: RelatorioQualidade = { processadas: 0, regras: 0, julgadas: 0, falhas: 0, noTeto: 0, juizIndisponivel: null }
  const [trava] = await dono<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${`qualidade_agente:${deps.somenteTenant ?? '*'}`})) AS ok`
  if (!trava?.ok) return vazio
  try {
    const regras = await registrarRegrasPendentes(dono, comTenantServico, { agora, lote: LOTE_REGRAS, somenteTenant: deps.somenteTenant })

    const ambiente = deps.juiz ? null : juizDoAmbiente(deps.env)
    const porta = deps.juiz ?? ambiente?.porta ?? null
    const modelo = deps.modeloJuiz ?? ambiente?.modelo
    if (!porta) return { ...vazio, processadas: regras, regras, juizIndisponivel: ambiente?.motivoIndisponivel ?? 'sem juiz' }

    const candidatas = await candidatasAoJuiz(dono, agora, deps.somenteTenant, tetoJuizEfetivo(null, deps.env))
    let julgadas = 0, falhas = 0, noTeto = 0
    for (const c of candidatas) {
      // A amostra no SQL é um pré-filtro; esta é a régua (a mesma do shared).
      if (!c.decisao_id || !naAmostra(c.conversa_id, amostraEfetiva(c.amostra === null ? null : Number(c.amostra), c.modo))) continue
      const gatilho: GatilhoAvaliacao = c.estado === 'ativa' ? 'turnos' : 'fim_sessao'
      const d: DesfechoJuiz = await comTenantServico(c.tenant_id, (tx) => julgarSessao(tx, {
        tenantId: c.tenant_id, sessaoId: c.sessao_id, decisaoId: c.decisao_id!, conversaId: c.conversa_id, canalId: c.canal_id,
        canalNome: c.canal_nome, modo: c.modo ?? 'sombra', turnos: c.turnos, gatilho, politicas: c.politicas,
        tetoMesCentavos: tetoJuizEfetivo(c.teto, deps.env),
      }, { porta, modelo }))
      if (d === 'avaliada') julgadas++
      else if (d === 'falhou') falhas++
      else if (d === 'teto') noTeto++
    }
    return { processadas: regras + julgadas + falhas, regras, julgadas, falhas, noTeto, juizIndisponivel: null }
  } finally {
    await dono`SELECT pg_advisory_unlock(hashtext(${`qualidade_agente:${deps.somenteTenant ?? '*'}`}))`
  }
}

/**
 * Sessões que pedem juiz: terminaram sem julgamento final, ou andaram 10 turnos
 * desde o último. A amostra entra já no SQL (`qualidade_fracao_estavel`, a
 * mesma FNV-1a do shared) — sem isso, as fora da amostra ocupariam o lote a
 * cada passada.
 */
async function candidatasAoJuiz(dono: Sql, agora: Date, somenteTenant: string | undefined, tetoAmbiente: number): Promise<readonly Candidata[]> {
  const desde = new Date(agora.getTime() - JANELA_JUIZ_DIAS * 86_400_000)
  return dono<Candidata[]>`
    WITH s AS (
      SELECT s.tenant_id, s.id AS sessao_id, s.conversa_id, s.canal_id, s.modo, s.estado, s.turnos,
             ac.qualidade_amostra::text AS amostra, ac.qualidade_teto_mes_centavos::text AS teto, ac.politicas,
             cc.nome_amigavel AS canal_nome,
             (SELECT max(a.turnos) FROM agente_avaliacao a
               WHERE a.tenant_id = s.tenant_id AND a.sessao_id = s.id AND a.tipo = 'juiz') AS ultimos_turnos,
             EXISTS (SELECT 1 FROM agente_avaliacao a
                      WHERE a.tenant_id = s.tenant_id AND a.sessao_id = s.id AND a.tipo = 'juiz'
                        AND a.gatilho IN ('fim_sessao', 'manual')) AS fim_julgado
        FROM agente_sessao s
        JOIN agente_config ac ON ac.tenant_id = s.tenant_id AND ac.canal_id = s.canal_id
        JOIN canal_conectado cc ON cc.tenant_id = s.tenant_id AND cc.id = s.canal_id
       WHERE s.iniciada_em > ${desde} AND s.turnos > 0
         ${somenteTenant ? dono`AND s.tenant_id = ${somenteTenant}` : dono``}
         AND qualidade_fracao_estavel(s.conversa_id::text) < coalesce(ac.qualidade_amostra,
               CASE s.modo WHEN 'sombra' THEN 1 WHEN 'assistido' THEN 0.2 WHEN 'autonomo' THEN 0.05 ELSE 0 END)
         -- Número no teto do mês (ou com juiz desligado, teto 0) nem entra: senão ocuparia o lote.
         AND (SELECT coalesce(sum(a.custo_centavos), 0) FROM agente_avaliacao a JOIN tenant t ON t.id = a.tenant_id
               WHERE a.tenant_id = s.tenant_id AND a.canal_id = s.canal_id AND a.tipo = 'juiz'
                 AND a.criado_em >= date_trunc('month', now() AT TIME ZONE coalesce(t.fuso, 'America/Sao_Paulo')) AT TIME ZONE coalesce(t.fuso, 'America/Sao_Paulo'))
             < coalesce(ac.qualidade_teto_mes_centavos, ${tetoAmbiente})
    )
    SELECT s.tenant_id, s.sessao_id, s.conversa_id, s.canal_id, s.canal_nome, s.modo, s.estado, s.turnos, s.amostra, s.teto, s.politicas,
           (SELECT d.id FROM agente_decisao d
             WHERE d.tenant_id = s.tenant_id AND d.sessao_id = s.sessao_id AND d.resposta IS NOT NULL
               AND d.desfecho IN ('respondeu', 'sugeriu', 'handoff', 'superada')
             ORDER BY d.criado_em DESC, d.id DESC LIMIT 1) AS decisao_id
      FROM s
     WHERE ((s.estado <> 'ativa' AND NOT s.fim_julgado AND coalesce(s.ultimos_turnos, -1) < s.turnos)
        OR (s.estado = 'ativa' AND s.turnos >= coalesce(s.ultimos_turnos, 0) + ${TURNOS_ENTRE_AVALIACOES}))
       AND EXISTS (SELECT 1 FROM agente_decisao d WHERE d.tenant_id = s.tenant_id AND d.sessao_id = s.sessao_id AND d.resposta IS NOT NULL
                     AND d.desfecho IN ('respondeu', 'sugeriu', 'handoff', 'superada'))
     ORDER BY s.turnos DESC
     LIMIT ${LOTE_JUIZ}`
}
