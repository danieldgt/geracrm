import { TURNOS_ENTRE_AVALIACOES, amostraEfetiva, naAmostra, type GatilhoAvaliacao } from '@geracrm/shared'
import { randomUUID } from 'node:crypto'
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
 * Idempotente por (decisão, tipo): duas passadas (ou dois processos — a
 * concessão por sessão já evita) nunca avaliam nem cobram duas vezes.
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

/**
 * Quanto a concessão de uma sessão vale: o lote inteiro julgado em série com o juiz no
 * prazo máximo (45 s) cabe com folga. Instância que morreu no meio: a sessão volta depois disso.
 */
export const TTL_CONCESSAO_JUIZ_MS = LOTE_JUIZ * 60_000 + 5 * 60_000

/** Sessão escolhida e reservada para este processo, com o token que solta a concessão. */
interface Reservada extends Candidata { readonly token: string }

/**
 * ⚠️ TRAVA E CONEXÃO (P0d). Nada aqui segura conexão durante o juiz:
 *   1. regras: idempotentes por (decisão, tipo) — rodam sem trava;
 *   2. lote: `pg_try_advisory_xact_lock` numa transação CURTA que só escolhe as
 *      candidatas e grava a concessão com TTL de cada uma (`qualidade_juiz_concessao`);
 *      o commit solta a trava (era `pg_try_advisory_lock` de sessão pelo pool: com
 *      pool > 1 o unlock caía noutra conexão e a trava vazava);
 *   3. juiz: fora de qualquer transação; ao terminar, a concessão sai pelo token.
 * Com pool de 1 (o `donoAquisicao` é compartilhado por ~13 workers), outro worker consulta
 * normalmente enquanto o juiz pensa.
 */
export async function processarQualidade(dono: Sql, deps: DepsQualidade = {}, agora: Date = new Date()): Promise<RelatorioQualidade> {
  const vazio: RelatorioQualidade = { processadas: 0, regras: 0, julgadas: 0, falhas: 0, noTeto: 0, juizIndisponivel: null }
  const regras = await registrarRegrasPendentes(dono, comTenantServico, { agora, lote: LOTE_REGRAS, somenteTenant: deps.somenteTenant })

  const ambiente = deps.juiz ? null : juizDoAmbiente(deps.env)
  const porta = deps.juiz ?? ambiente?.porta ?? null
  const modelo = deps.modeloJuiz ?? ambiente?.modelo
  if (!porta) return { ...vazio, processadas: regras, regras, juizIndisponivel: ambiente?.motivoIndisponivel ?? 'sem juiz' }

  const reservadas = await reservarLote(dono, agora, deps)
  let julgadas = 0, falhas = 0, noTeto = 0
  for (const c of reservadas) {
    try {
      const gatilho: GatilhoAvaliacao = c.estado === 'ativa' ? 'turnos' : 'fim_sessao'
      const d: DesfechoJuiz = await julgarSessao((fn) => comTenantServico(c.tenant_id, fn), {
        tenantId: c.tenant_id, sessaoId: c.sessao_id, decisaoId: c.decisao_id!, conversaId: c.conversa_id, canalId: c.canal_id,
        canalNome: c.canal_nome, modo: c.modo ?? 'sombra', turnos: c.turnos, gatilho, politicas: c.politicas,
        tetoMesCentavos: tetoJuizEfetivo(c.teto, deps.env),
      }, { porta, modelo })
      if (d === 'avaliada') julgadas++
      else if (d === 'falhou') falhas++
      else if (d === 'teto') noTeto++
    } finally {
      await dono`DELETE FROM qualidade_juiz_concessao WHERE tenant_id = ${c.tenant_id} AND sessao_id = ${c.sessao_id} AND token = ${c.token}`
    }
  }
  return { processadas: regras + julgadas + falhas, regras, julgadas, falhas, noTeto, juizIndisponivel: null }
}

/**
 * Escolhe e RESERVA o lote numa transação curta, sob trava de transação (outra instância
 * na mesma hora sai sem lote, sem esperar). Só volta a sessão cuja concessão este processo
 * gravou: a de outra instância, ainda viva, fica de fora.
 */
async function reservarLote(dono: Sql, agora: Date, deps: DepsQualidade): Promise<readonly Reservada[]> {
  const token = randomUUID()
  const expiraEm = new Date(agora.getTime() + TTL_CONCESSAO_JUIZ_MS)
  return dono.begin(async (tx) => {
    const [trava] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`qualidade_agente:${deps.somenteTenant ?? '*'}`})) AS ok`
    if (!trava?.ok) return []
    const candidatas = (await candidatasAoJuiz(tx as unknown as Sql, agora, deps.somenteTenant, tetoJuizEfetivo(null, deps.env)))
      // A amostra no SQL é um pré-filtro; esta é a régua (a mesma do shared).
      .filter((c) => c.decisao_id && naAmostra(c.conversa_id, amostraEfetiva(c.amostra === null ? null : Number(c.amostra), c.modo)))
    const reservadas: Reservada[] = []
    for (const c of candidatas) {
      const pegou = await tx`
        INSERT INTO qualidade_juiz_concessao (tenant_id, sessao_id, token, expira_em)
        VALUES (${c.tenant_id}, ${c.sessao_id}, ${token}, ${expiraEm})
        ON CONFLICT (tenant_id, sessao_id) DO UPDATE
           SET token = EXCLUDED.token, expira_em = EXCLUDED.expira_em, criado_em = now()
         WHERE qualidade_juiz_concessao.expira_em < ${agora}
        RETURNING sessao_id`
      if (pegou.length > 0) reservadas.push({ ...c, token })
    }
    return reservadas
  }) as Promise<readonly Reservada[]>
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
        JOIN tenant t ON t.id = s.tenant_id
        CROSS JOIN LATERAL (SELECT coalesce((SELECT name FROM pg_timezone_names WHERE name = t.fuso), 'America/Sao_Paulo') AS fuso_ok) fz
       WHERE s.iniciada_em > ${desde} AND s.turnos > 0
         -- Sessão com concessão viva (outra instância julgando agora) fica de fora do lote.
         AND NOT EXISTS (SELECT 1 FROM qualidade_juiz_concessao q
                          WHERE q.tenant_id = s.tenant_id AND q.sessao_id = s.id AND q.expira_em >= ${agora})
         ${somenteTenant ? dono`AND s.tenant_id = ${somenteTenant}` : dono``}
         AND qualidade_fracao_estavel(s.conversa_id::text) < coalesce(ac.qualidade_amostra,
               CASE s.modo WHEN 'sombra' THEN 1 WHEN 'assistido' THEN 0.2 WHEN 'autonomo' THEN 0.05 ELSE 0 END)
         -- Número no teto do mês (ou com juiz desligado, teto 0) nem entra: senão ocuparia o lote.
         -- ⚠️ Fuso do tenant VALIDADO no SQL (texto livre: um inválido derrubaria a passada de todos).
         AND (SELECT coalesce(sum(a.custo_centavos), 0) FROM agente_avaliacao a
               WHERE a.tenant_id = s.tenant_id AND a.canal_id = s.canal_id AND a.tipo = 'juiz'
                 AND a.criado_em >= date_trunc('month', now() AT TIME ZONE fz.fuso_ok) AT TIME ZONE fz.fuso_ok)
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
