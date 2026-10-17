import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { CRITERIOS_RUBRICA, deslocarSemana, semanaDaData, type GoLiveDto, type CriterioFase } from '@geracrm/shared'
import { comTenantServico, encerrarBanco } from '../../../db/index.js'
import { pluginTenant } from '../../../plugins/tenant.js'
import { rotasGoLive } from './rotas-go-live.js'
import { rotasAgente } from './rotas-agente.js'
import { COLETORES, coletarGoLive, semanasDaJanela, type Coletores } from './go-live.js'
import { metricaSlaHandoff } from '../sla-metrica.js'

/**
 * GO-LIVE (raia P19) — banco real, dois tenants. Dados semeados por FONTE
 * (decisões, mensagens, P12, P13, P16, P4, pedido, P18, conferências 0109),
 * RLS, papel, auditoria, e a degradação de cada fonte (fonte que falha ou
 * amostra que falta → "sem medida", os outros seguem).
 */
const A = 'c0a19000-0000-4000-8000-000000000001'
const B = 'c0a19000-0000-4000-8000-000000000002'
const PV_A = 'c0a19000-1111-4000-8000-000000000001'
const PV_B = 'c0a19000-1111-4000-8000-000000000002'
const PLANO = 'c0a19000-3333-4000-8000-000000000001'
const MODELO = 'c0a19000-4444-4000-8000-000000000001'
const CANAL_A = 'c0a19000-5555-4000-8000-000000000001'
const CANAL_B = 'c0a19000-5555-4000-8000-000000000002'
const U_GESTORA = 'c0a19000-6666-4000-8000-000000000001'
const U_ADMIN = 'c0a19000-6666-4000-8000-000000000002'
const U_VENDEDOR = 'c0a19000-6666-4000-8000-000000000003'
const U_B = 'c0a19000-6666-4000-8000-000000000004'
const SUB_ADMIN = 'sub-admin-go-live'
const SUB_VENDEDOR = 'sub-vendedor-go-live'
const DIA = 86_400_000

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
/** Protocolo do atendimento: único por tenant. */
const protocolo = { proximo: 1 }

const h = (t: string, sub?: string) => ({ 'x-tenant-id': t, ...(sub ? { 'x-teste-sub': sub } : {}) })
const goLive = async (t: string, canal: string, sub?: string) =>
  app.inject({ method: 'GET', url: `/v1/agente/go-live?canalId=${canal}`, headers: h(t, sub) })
const conferir = async (t: string, corpo: Record<string, unknown>, sub = SUB_ADMIN) =>
  app.inject({ method: 'POST', url: '/v1/agente/go-live/conferencia', headers: h(t, sub), payload: corpo })
const crit = (b: GoLiveDto, id: string): CriterioFase => {
  const c = b.criterios.find((x) => x.id === id)
  if (!c) throw new Error(`critério ${id} ausente: ${b.criterios.map((x) => x.id).join(',')}`)
  return c
}

// ── semeadura ───────────────────────────────────────────────────────────────

async function config(t: string, canal: string, modo: string, recorte: unknown = null): Promise<void> {
  await dono`INSERT INTO agente_config (tenant_id, canal_id, modo, recorte, politicas)
             VALUES (${t}, ${canal}, ${modo}, ${recorte === null ? null : JSON.stringify(recorte)}::text::jsonb, 'Políticas da loja de teste.')
             ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, recorte = EXCLUDED.recorte`
}

/** Uma mudança auditada de `agente_config` (o que o PUT da P14 grava). */
async function auditou(t: string, canal: string, dias: number, antes: Record<string, unknown>, depois: Record<string, unknown>, criacao = false): Promise<void> {
  await dono`INSERT INTO auditoria (tenant_id, id, acao, entidade, entidade_id, dados, criado_em)
             VALUES (${t}, ${crypto.randomUUID()}, 'agente.config_alterada', 'agente_config', ${canal},
                     ${JSON.stringify({ antes, depois, campos: Object.keys({ ...antes, ...depois }).sort(), criacao })}::text::jsonb,
                     now() - make_interval(days => ${dias}))`
}
/** Mudança auditada do teto do tenant (kill switch), como o PUT /v1/agente/tenant grava. */
async function tetoMudouHa(t: string, dias: number, antes: string, depois: string): Promise<void> {
  await dono`INSERT INTO auditoria (tenant_id, id, acao, entidade, dados, criado_em)
             VALUES (${t}, ${crypto.randomUUID()}, 'agente.config_alterada', 'agente_tenant',
                     ${JSON.stringify({ antes: { modoMaximo: antes }, depois: { modoMaximo: depois }, campos: ['modo_maximo'] })}::text::jsonb,
                     now() - make_interval(days => ${dias}))`
}

/** Uma versão de playbook publicada agora para o número (P17). */
async function publicouPlaybook(t: string, canal: string): Promise<void> {
  const [n] = await dono<{ n: number }[]>`SELECT coalesce(max(numero), 0)::int + 1 AS n FROM agente_playbook_versao WHERE tenant_id = ${t} AND canal_id = ${canal}`
  await dono`UPDATE agente_playbook_versao SET arquivada_em = now() WHERE tenant_id = ${t} AND canal_id = ${canal} AND publicada_em IS NOT NULL AND arquivada_em IS NULL`
  await dono`INSERT INTO agente_playbook_versao (tenant_id, id, canal_id, numero, conteudo, origem, observacao, publicada_em)
             VALUES (${t}, ${crypto.randomUUID()}, ${canal}, ${n!.n}, '{}'::jsonb, 'manual', 'nova versão do teste', now())`
}

/** A troca de modo auditada que inicia a fase. */
const trocouModoHa = (t: string, canal: string, dias: number, de: string, para: string) => auditou(t, canal, dias, { modo: de }, { modo: para })

async function conversas(t: string, canal: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => crypto.randomUUID())
  const cts = ids.map(() => crypto.randomUUID())
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) SELECT ${t}::uuid, x, 'Cliente', true FROM unnest(${cts}::uuid[]) AS x`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, ultima_entrante_em, ultima_mensagem_em)
             SELECT ${t}::uuid, u.c, ${canal}::uuid, u.k, 1, now() - interval '1 hour', now() - interval '1 hour'
               FROM unnest(${ids}::uuid[], ${cts}::uuid[]) AS u(c, k)`
  return ids
}

/** Uma mensagem do cliente `horasAtras`. */
async function entrante(t: string, conversa: string, horasAtras: number): Promise<string> {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${t}, ${id}, ${conversa}, 'entrante', 'texto', '{"texto":"oi"}'::jsonb, now() - make_interval(secs => ${horasAtras * 3600}))`
  return id
}

/** Uma resposta escrita por uma PESSOA (`enviada_por_id`, a régua da P18). */
async function respostaHumana(t: string, conversa: string, horasAtras: number): Promise<void> {
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, enviada_por_id, criado_em)
             VALUES (${t}, ${crypto.randomUUID()}, ${conversa}, 'saliente', 'texto', '{"texto":"Olá!"}'::jsonb, ${U_GESTORA},
                     now() - make_interval(secs => ${horasAtras * 3600}))`
}

interface OpcoesDecisao {
  readonly modo: string
  readonly desfecho?: string
  readonly vezes?: number
  readonly custo?: number
  readonly enviada?: boolean
  readonly guardrails?: unknown[]
  readonly numeros?: unknown[]
  readonly sombra?: number | null
  readonly sugestao?: 'enviada' | 'editada' | 'descartada' | null
  readonly comSessao?: boolean
  readonly horasAtras?: number
  /** Grava a mensagem do cliente e a resposta: cliente falou `respostaMs` antes da 1ª mensagem do agente. */
  readonly respostaMs?: number
}

/** `vezes` decisões por conversa. Devolve os ids. */
async function decidir(t: string, canal: string, convs: readonly string[], o: OpcoesDecisao): Promise<string[]> {
  const ids: string[] = []
  for (const c of convs) {
    let sessao: string | null = null
    if (o.comSessao) {
      sessao = crypto.randomUUID()
      await dono`INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, modo, turnos, estado, encerrada_em, motivo_saida)
                 VALUES (${t}, ${sessao}, ${c}, ${canal}, ${o.modo}, 1, 'entregue', now(), 'teste')`
    }
    for (let i = 0; i < (o.vezes ?? 1); i++) {
      const id = crypto.randomUUID()
      ids.push(id)
      const horas = (o.horasAtras ?? 2) + i
      let entradas: string[] = [], saidas: string[] = []
      if (o.respostaMs !== undefined) {
        entradas = [await entrante(t, c, horas + o.respostaMs / 3_600_000)]
        const s = crypto.randomUUID()
        await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
                   VALUES (${t}, ${s}, ${c}, 'saliente', 'texto', '{"texto":"Temos sim."}'::jsonb, now() - make_interval(secs => ${horas * 3600}))`
        saidas = [s]
      }
      await dono`
        INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta, custo_centavos,
                                    enviada, guardrails, numeros_bloqueados, sombra_similaridade, sugestao_estado, sugestao_usada_em,
                                    mensagens_ids, mensagens_saida_ids, criado_em)
        VALUES (${t}, ${id}, ${c}, ${canal}, ${sessao}, ${o.modo}, ${o.desfecho ?? 'sugeriu'}, '{"mensagens":["Temos sim."]}'::jsonb,
                ${o.custo ?? 0}, ${o.enviada ?? false},
                ${JSON.stringify(o.guardrails ?? [])}::text::jsonb, ${JSON.stringify(o.numeros ?? [])}::text::jsonb,
                ${o.sombra ?? null}, ${o.sugestao ?? null}, ${o.sugestao ? new Date() : null},
                ${entradas}::uuid[], ${saidas}::uuid[], now() - make_interval(secs => ${horas * 3600}))`
    }
  }
  return ids
}

async function avaliacao(t: string, canal: string, decisaoId: string, conversaId: string, p: { pior?: 'CRITICA' | null; nota?: number; custo?: number }): Promise<string> {
  const id = crypto.randomUUID()
  if (p.nota !== undefined) {
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, origem, tipo, gatilho, notas, nota_media, modelo, custo_centavos)
               VALUES (${t}, ${id}, ${decisaoId}, ${conversaId}, ${canal}, 'sugestao', 'juiz', 'fim_sessao',
                       ${JSON.stringify(Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, p.nota])))}::text::jsonb, ${p.nota}, 'simulado', ${p.custo ?? 0})`
  } else {
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, origem, tipo, gatilho, violacoes, pior_gravidade, acao)
               VALUES (${t}, ${id}, ${decisaoId}, ${conversaId}, ${canal}, 'sugestao', 'regras', 'turno', '[]'::jsonb, ${p.pior ?? null}, ${p.pior ? 'registrado' : null})`
  }
  return id
}

const SEMANA = semanaDaData(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }))!

async function revisao(t: string, canal: string, avaliacaoId: string, conversaId: string, concorda: boolean, semana = SEMANA): Promise<void> {
  const porCriterio = Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, concorda]))
  await dono`INSERT INTO agente_revisao (tenant_id, id, avaliacao_id, revisor_id, conversa_id, canal_id, semana, motivo, notas, veredito,
                                         concordancia, concorda, falso_negativo_critica)
             VALUES (${t}, ${crypto.randomUUID()}, ${avaliacaoId}, ${U_GESTORA}, ${conversaId}, ${canal}, ${semana}, 'aleatoria',
                     ${JSON.stringify(Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, 4])))}::text::jsonb, 'ok',
                     ${JSON.stringify({ ...porCriterio, gravidade: true })}::text::jsonb, ${concorda}, false)`
}

async function pedido(t: string, conversaId: string, p: { origem: 'agente' | 'humano'; estado: string; confirmado: boolean }): Promise<void> {
  await dono`INSERT INTO pedido (tenant_id, id, conversa_id, estado, origem, confirmado_em, cancelado_em, cancelado_motivo)
             VALUES (${t}, ${crypto.randomUUID()}, ${conversaId}, ${p.estado}, ${p.origem},
                     ${p.confirmado ? new Date(Date.now() - 3_600_000) : null}, ${p.estado === 'cancelado' ? new Date() : null},
                     ${p.estado === 'cancelado' ? 'desfeito pelo vendedor' : null})`
}

/** Atendimento com SLA armado (P18). */
async function handoffComSla(t: string, canal: string, conversaId: string, r: 'no_prazo' | 'atrasada' | 'estourado' | 'pendente'): Promise<void> {
  const inicio = new Date(Date.now() - 2 * 3_600_000)
  const vence = r === 'pendente' ? new Date(Date.now() + 3_600_000) : new Date(Date.now() - 3_600_000)
  const respondido = r === 'no_prazo' ? new Date(vence.getTime() - 60_000) : r === 'atrasada' ? new Date(vence.getTime() + 60_000) : null
  await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, sla_inicio_em, sla_vence_em, sla_respondido_em,
                                      sla_estourado_em)
             VALUES (${t}, ${crypto.randomUUID()}, ${conversaId}, ${canal}, ${900_000 + protocolo.proximo++}, 'na_fila', ${inicio}, ${vence}, ${respondido},
                     ${r === 'estourado' ? vence : null})`
}

/** A conversa de simulação do número (a que o playground usa) com N decisões, `criticas` delas com CRÍTICA que escapou. */
async function conversaDeSimulacao(t: string, canal: string, decisoes: number, criticas: number): Promise<string> {
  const [ie] = await dono<{ contato_id: string }[]>`SELECT contato_id FROM contato_identidade_externa WHERE tenant_id = ${t} AND sistema = 'simulacao' AND id_externo = ${`sim:${canal}`}`
  let contato = ie?.contato_id
  if (!contato) {
    contato = crypto.randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${t}, ${contato}, 'Cliente de simulação', 'simulacao', true)`
    await dono`INSERT INTO contato_identidade_externa (tenant_id, contato_id, sistema, id_externo) VALUES (${t}, ${contato}, 'simulacao', ${`sim:${canal}`})`
  }
  const [cv] = await dono<{ id: string }[]>`SELECT id FROM conversa WHERE tenant_id = ${t} AND canal_id = ${canal} AND contato_id = ${contato}`
  const conv = cv?.id ?? crypto.randomUUID()
  if (!cv) await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conv}, ${canal}, ${contato}, 1)`
  const critica = [{ etapa: 'regras-qualidade', codigo: 'palavra_proibida', gravidade: 'CRITICA', acao: 'registrado' }]
  const corrigida = [{ etapa: 'filtro-saida', codigo: 'promessa', gravidade: 'CRITICA', acao: 'removido' }]
  for (let i = 0; i < decisoes; i++) {
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, resposta, guardrails)
               VALUES (${t}, ${crypto.randomUUID()}, ${conv}, ${canal}, 'simulacao', 'sugeriu', '{"mensagens":["x"]}'::jsonb,
                       ${JSON.stringify(i < criticas ? critica : corrigida)}::text::jsonb)`
  }
  return conv
}

async function limpar(t: string): Promise<void> {
  // Versão publicada é imutável por trigger (P17): a limpeza do teste desliga os triggers, como o playbook.test.ts.
  await dono.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`
    await tx`DELETE FROM agente_playbook_versao WHERE tenant_id = ${t}`
  })
  for (const tab of ['agente_homologacao', 'agente_revisao', 'agente_avaliacao', 'agente_decisao', 'agente_sessao', 'atendimento', 'pedido', 'mensagem',
    'conversa', 'contato_identidade_externa', 'contato', 'agente_config', 'agente_tenant', 'auditoria']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  // `auditoria` é particionada por mês a partir do mês da migração: as trocas de modo
  // "há 22 dias" caem no mês anterior. Mesma DDL da 0004, para os 2 meses de trás.
  await dono.unsafe(`DO $$ DECLARE de date; BEGIN
    FOR i IN 1..2 LOOP
      de := (date_trunc('month', now()) - (i || ' month')::interval)::date;
      EXECUTE format('CREATE TABLE IF NOT EXISTS auditoria_%s PARTITION OF auditoria FOR VALUES FROM (%L) TO (%L)',
                     to_char(de, 'YYYY_MM'), de, (de + interval '1 month')::date);
    END LOOP; END $$`)
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-go-live', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-go-live', 'Atacado') ON CONFLICT DO NOTHING`
  for (const [t, pv, canal] of [[A, PV_A, CANAL_A], [B, PV_B, CANAL_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${t}, ${`GoLive ${t.slice(-1)}`}, ${PLANO}, ${pv}, 'America/Sao_Paulo') ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Atacado') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${canal}, 'whatsapp_nao_oficial', ${`Loja ${t.slice(-1)}`}, 'conectado') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_GESTORA}, ${`dev-${A}`}, 'Gina', 'gina@golive.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_ADMIN}, ${SUB_ADMIN}, 'Ada', 'ada@golive.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_VENDEDOR}, ${SUB_VENDEDOR}, 'Vito', 'vito@golive.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${U_B}, ${`dev-${B}`}, 'Beto', 'beto@golive.test') ON CONFLICT DO NOTHING`
  // Com um admin atribuído o tenant sai do modo fundador: o papel passa a valer para todos.
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_ADMIN}, NULL, 'admin')`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_GESTORA}, NULL, 'gestor')`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${U_VENDEDOR}, NULL, 'vendedor')`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('preHandler', async (req) => {
    const sub = req.headers['x-teste-sub']
    if (typeof sub === 'string') { req.usuarioSub = sub; req.usuarioEmail = `${sub}@golive.test` }
  })
  await app.register(rotasGoLive)
  await app.register(rotasAgente)
  await app.ready()
})

afterAll(async () => {
  for (const t of [A, B]) {
    await limpar(t)
    for (const tab of ['usuario_filial', 'usuario', 'canal_conectado']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

beforeEach(async () => { await limpar(A); await limpar(B) })

const RECORTE = { horario: { dias: ['seg', 'ter', 'qua', 'qui', 'sex'], de: '08:00', ate: '18:00' } }

// ── borda ───────────────────────────────────────────────────────────────────

describe('GET /v1/agente/go-live — borda, papel e RLS', () => {
  it('sem canalId (ou inválido) → 422 nomeado', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/agente/go-live', headers: h(A) })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'go_live.campo_invalido', campos: ['canalId'] })
    expect((await goLive(A, 'nao-e-uuid')).statusCode).toBe(422)
  })

  it('vendedor não vê o painel (403); gestora vê', async () => {
    expect((await goLive(A, CANAL_A, SUB_VENDEDOR)).statusCode).toBe(403)
    expect((await goLive(A, CANAL_A)).statusCode).toBe(200)
  })

  it('número de OUTRO tenant é 404 — o RLS esconde o canal', async () => {
    await config(B, CANAL_B, 'sombra')
    expect((await goLive(A, CANAL_B)).statusCode).toBe(404)
  })

  it('os dados do tenant B não entram na medida do tenant A, mesmo com o mesmo modo', async () => {
    await config(A, CANAL_A, 'sombra'); await trocouModoHa(A, CANAL_A, 15, 'desligado', 'sombra')
    await config(B, CANAL_B, 'sombra'); await trocouModoHa(B, CANAL_B, 15, 'desligado', 'sombra')
    const cA = await conversas(A, CANAL_A, 3)
    await decidir(A, CANAL_A, cA, { modo: 'sombra', vezes: 2 })
    const cB = await conversas(B, CANAL_B, 40)
    const dB = await decidir(B, CANAL_B, cB, { modo: 'sombra', vezes: 5, custo: 999 })
    await avaliacao(B, CANAL_B, dB[0]!, cB[0]!, { pior: 'CRITICA' })

    const a = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(a, 'turnos').valor).toBe('6')
    expect(crit(a, 'conversas').valor).toBe('3')
    expect(crit(a, 'critica')).toMatchObject({ valor: '0', ok: true })
    expect(crit(a, 'custo_conversa').valor).toBe('R$ 0,00')

    const b = (await goLive(B, CANAL_B)).json() as GoLiveDto
    expect(crit(b, 'turnos').valor).toBe('200')
    expect(crit(b, 'critica')).toMatchObject({ valor: '1', ok: false })
  })
})

// ── fases e início ──────────────────────────────────────────────────────────

describe('Fase vem do modo do NÚMERO (P14); o painel só informa', () => {
  it('sem configuração → homologação: sem conferência, cada critério diz como registrar; não avança', async () => {
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'homologacao', proximaFase: 'sombra', podeAvancar: false, alvosProposta: true, pausadoPeloTeto: false })
    expect(crit(b, 'douradas')).toMatchObject({ ok: null, indisponivel: true, motivo: expect.stringMatching(/agente:avaliar/) })
    expect(crit(b, 'smoke')).toMatchObject({ ok: null, motivo: expect.stringMatching(/agente:smoke/) })
    expect(crit(b, 'playground_conversas')).toMatchObject({ ok: false, valor: '0' })
    expect(crit(b, 'playground_critica')).toMatchObject({ ok: null })
  })

  it('M4: kill switch do tenant NÃO muda a fase — aparece "pausado pelo teto"', async () => {
    await config(A, CANAL_A, 'autonomo')
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${A}, 'sombra')`
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'autonomo_amplo', modoNumero: 'autonomo', pausadoPeloTeto: true })
    expect(b.modoAgora).toMatchObject({ modo: 'sombra', origem: 'tenant' })
  })

  it('dias pausados pelo teto NÃO contam na fase e aparecem descontados', async () => {
    await config(A, CANAL_A, 'autonomo', RECORTE); await trocouModoHa(A, CANAL_A, 22, 'assistido', 'autonomo')
    await tetoMudouHa(A, 10, 'autonomo', 'sombra') // pausou
    await tetoMudouHa(A, 5, 'sombra', 'autonomo')  // liberou
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'autonomo_recorte', dias: 17, diasPausados: 5, pausadoPeloTeto: false })
    expect(crit(b, 'dias')).toMatchObject({ valor: '17 dias', ok: false })
  })

  it('só admin vê o formulário de conferência (podeConferir)', async () => {
    expect(((await goLive(A, CANAL_A)).json() as GoLiveDto).podeConferir).toBe(false) // gestora
    expect(((await goLive(A, CANAL_A, SUB_ADMIN)).json() as GoLiveDto).podeConferir).toBe(true)
  })

  it('M4: mudança auditada que não troca a fase (horário do recorte) não reinicia a contagem', async () => {
    await config(A, CANAL_A, 'autonomo', { ...RECORTE, foraDoRecorte: 'assistido' })
    await trocouModoHa(A, CANAL_A, 25, 'assistido', 'autonomo')
    await auditou(A, CANAL_A, 3, { recorte: { ...RECORTE, foraDoRecorte: 'sombra' } }, { recorte: { ...RECORTE, foraDoRecorte: 'assistido' } })
    await auditou(A, CANAL_A, 2, { persona: { nome: 'A' } }, { persona: { nome: 'B' } })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'autonomo_recorte', dias: 25, inicioEstimado: false })
  })

  it('M4: tirar o recorte troca a fase e reinicia', async () => {
    await config(A, CANAL_A, 'autonomo', null)
    await trocouModoHa(A, CANAL_A, 40, 'assistido', 'autonomo')
    await auditou(A, CANAL_A, 4, { recorte: RECORTE }, { recorte: null })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'autonomo_amplo', dias: 4 })
  })

  it('sem auditoria que troque a fase, o início é estimado pela 1ª decisão no modo', async () => {
    await config(A, CANAL_A, 'sombra')
    const convs = await conversas(A, CANAL_A, 1)
    await decidir(A, CANAL_A, convs, { modo: 'sombra', horasAtras: 24 * 5 + 1 })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ inicioEstimado: true, dias: 5 })
  })

  it('consultar o painel não muda o modo nem grava auditoria', async () => {
    await config(A, CANAL_A, 'sombra')
    await goLive(A, CANAL_A)
    const [c] = await dono<{ modo: string }[]>`SELECT modo FROM agente_config WHERE tenant_id = ${A} AND canal_id = ${CANAL_A}`
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A}`
    expect(c!.modo).toBe('sombra')
    expect(n!.n).toBe(0)
  })
})

// ── A2: homologação medida ──────────────────────────────────────────────────

describe('A2 — homologação medida: conferência digitada (douradas, smoke) e playground acumulado', () => {
  it('POST conferência: admin grava, auditado com antes/depois; o painel lê; gestora e vendedor 403', async () => {
    expect((await conferir(A, { item: 'smoke', canalId: CANAL_A, ok: true }, `dev-${A}`)).statusCode).toBe(403) // gestora
    expect((await conferir(A, { item: 'smoke', canalId: CANAL_A, ok: true }, SUB_VENDEDOR)).statusCode).toBe(403)

    const r1 = await conferir(A, { item: 'douradas', canalId: CANAL_A, cenarios: 20, criticas: 0 })
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toMatchObject({ item: 'douradas', resultado: { cenarios: 20, criticas: 0 } })
    const r2 = await conferir(A, { item: 'douradas', canalId: CANAL_A, cenarios: 32, criticas: 0 })
    expect(r2.statusCode).toBe(200)
    expect((await conferir(A, { item: 'smoke', canalId: CANAL_A, ok: true })).statusCode).toBe(200)

    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'douradas')).toMatchObject({ ok: true, valor: '32 cenários, 0 CRÍTICA', motivo: expect.stringMatching(/^Declarado por Ada em \d\d\/\d\d/) })
    expect(crit(b, 'smoke')).toMatchObject({ ok: true })

    const aud = await dono<{ dados: { item: string; antes: unknown; depois: unknown }; ator_id: string }[]>`
      SELECT dados, ator_id FROM auditoria WHERE tenant_id = ${A} AND acao = 'agente.go_live_conferencia' ORDER BY criado_em`
    expect(aud).toHaveLength(3)
    expect(aud[1]!.dados).toMatchObject({ item: 'douradas', antes: { cenarios: 20, criticas: 0 }, depois: { cenarios: 32, criticas: 0 } })
    expect(aud[1]!.ator_id).toBe(U_ADMIN)
    const [l] = await dono<{ ator_id: string }[]>`SELECT ator_id FROM agente_homologacao WHERE tenant_id = ${A} AND item = 'douradas'`
    expect(l!.ator_id).toBe(U_ADMIN)
  })

  it('conferência com CRÍTICA ou smoke falho reprova; corpo inválido 422; canal de outro tenant 404', async () => {
    await conferir(A, { item: 'douradas', canalId: CANAL_A, cenarios: 25, criticas: 1 })
    await conferir(A, { item: 'smoke', canalId: CANAL_A, ok: false })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'douradas').ok).toBe(false)
    expect(crit(b, 'smoke').ok).toBe(false)

    const inv = await conferir(A, { item: 'douradas', canalId: CANAL_A, cenarios: 2, criticas: 3 })
    expect(inv.statusCode).toBe(422)
    expect(inv.json()).toMatchObject({ erro: 'go_live.campo_invalido', campos: ['criticas'] })
    expect((await conferir(A, { item: 'playground', canalId: CANAL_A, conversas: 30 })).statusCode).toBe(422)
    expect((await conferir(A, { item: 'smoke', canalId: CANAL_B, ok: true })).statusCode).toBe(404)
  })

  it('conferência com mais de 30 dias não vale', async () => {
    await conferir(A, { item: 'smoke', canalId: CANAL_A, ok: true })
    await dono`UPDATE agente_homologacao SET atualizado_em = now() - interval '31 days' WHERE tenant_id = ${A}`
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'smoke')).toMatchObject({ ok: null, motivo: expect.stringMatching(/30 dias/) })
  })

  it('RLS: a conferência do tenant A não aparece para o B, e o B não grava no número do A', async () => {
    await conferir(A, { item: 'smoke', canalId: CANAL_A, ok: true })
    const visto = await comTenantServico(B, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_homologacao`)
    expect(visto[0]!.n).toBe(0)
    await expect(comTenantServico(B, async (tx) => {
      await tx`SET LOCAL ROLE geracrm_app`
      await tx`INSERT INTO agente_homologacao (tenant_id, canal_id, item, resultado) VALUES (${A}, ${CANAL_A}, 'smoke', '{}'::jsonb)`
    })).rejects.toThrow()
  })

  const reiniciar = (sub = SUB_ADMIN) => app.inject({ method: 'DELETE', url: `/v1/canais/${CANAL_A}/agente/simular`, headers: h(A, sub) })
  type Entrada = { em: string; turnos: number; criticas: number }
  const entradas = async (): Promise<Entrada[]> => {
    const [l] = await dono<{ resultado: { entradas: Entrada[] }; ator_id: string | null }[]>`SELECT resultado, ator_id FROM agente_homologacao WHERE tenant_id = ${A} AND item = 'playground'`
    return l?.resultado.entradas ?? []
  }

  it('playground: cada "Reiniciar" grava UMA entrada {em, turnos, criticas} contada das decisões apagadas', async () => {
    await conversaDeSimulacao(A, CANAL_A, 3, 1) // 1 CRÍTICA que escapou + 2 corrigidas pelo pipeline
    expect((await reiniciar()).statusCode).toBe(200)
    await conversaDeSimulacao(A, CANAL_A, 2, 0) // só 2 decisões: não conta como conversa testada
    expect((await reiniciar()).statusCode).toBe(200)
    await reiniciar() // sem decisões: nenhuma entrada
    await conversaDeSimulacao(A, CANAL_A, 4, 0) // a aberta (ainda não reiniciada) também conta

    const es = await entradas()
    expect(es.map((e) => [e.turnos, e.criticas])).toEqual([[3, 1], [2, 0]])
    const [l] = await dono<{ ator_id: string | null }[]>`SELECT ator_id FROM agente_homologacao WHERE tenant_id = ${A} AND item = 'playground'`
    expect(l!.ator_id).toBe(U_ADMIN)
    const [d] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM usuario WHERE tenant_id = ${A}`
    expect(d!.n).toBe(3) // o reinício não cria usuário (Gina, Ada e Vito já existiam)

    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'playground_conversas')).toMatchObject({ valor: '2', ok: false })
    expect(crit(b, 'playground_critica')).toMatchObject({ valor: '1', ok: false })
  })

  it('dois "Reiniciar" simultâneos contam a conversa UMA vez (DELETE … RETURNING)', async () => {
    await conversaDeSimulacao(A, CANAL_A, 3, 0)
    const rs = await Promise.all([reiniciar(), reiniciar()])
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200])
    expect(await entradas()).toHaveLength(1)
  })

  it('CRÍTICA antiga deixa de contar depois de publicar uma versão nova do playbook', async () => {
    await conversaDeSimulacao(A, CANAL_A, 3, 1)
    await reiniciar()
    expect(crit((await goLive(A, CANAL_A)).json() as GoLiveDto, 'playground_critica')).toMatchObject({ valor: '1', ok: false })
    await new Promise((r) => setTimeout(r, 20))
    await publicouPlaybook(A, CANAL_A)
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'playground_critica')).toMatchObject({ ok: null, motivo: expect.stringMatching(/Contam só os testes depois de/) })
    expect(crit(b, 'playground_conversas')).toMatchObject({ valor: '0' })
    // Teste novo, depois da publicação, volta a contar.
    await conversaDeSimulacao(A, CANAL_A, 3, 0)
    await reiniciar()
    expect(crit((await goLive(A, CANAL_A)).json() as GoLiveDto, 'playground_critica')).toMatchObject({ valor: '0', ok: true })
  })

  it('mudança na configuração do número também corta o playground', async () => {
    await conversaDeSimulacao(A, CANAL_A, 3, 1)
    await reiniciar()
    await new Promise((r) => setTimeout(r, 20))
    await dono`INSERT INTO auditoria (tenant_id, id, acao, entidade, entidade_id, dados) VALUES (${A}, ${crypto.randomUUID()}, 'agente.config_alterada', 'agente_config', ${CANAL_A}, '{"antes":{"persona":1},"depois":{"persona":2},"campos":["persona"]}')`
    expect(crit((await goLive(A, CANAL_A)).json() as GoLiveDto, 'playground_critica')).toMatchObject({ ok: null })
  })

  it('reinícios de mais de 30 dias saem da soma e da linha', async () => {
    await dono`INSERT INTO agente_homologacao (tenant_id, canal_id, item, resultado) VALUES (${A}, ${CANAL_A}, 'playground',
               ${JSON.stringify({ entradas: [{ em: new Date(Date.now() - 31 * DIA).toISOString(), turnos: 5, criticas: 1 }] })}::text::jsonb)`
    expect(crit((await goLive(A, CANAL_A)).json() as GoLiveDto, 'playground_critica')).toMatchObject({ ok: null })
    await conversaDeSimulacao(A, CANAL_A, 3, 0)
    await reiniciar()
    expect((await entradas()).map((e) => e.criticas)).toEqual([0])
  })

  it('homologação verde de ponta a ponta → pode avançar para sombra', async () => {
    await conferir(A, { item: 'douradas', canalId: CANAL_A, cenarios: 39, criticas: 0 })
    await conferir(A, { item: 'smoke', canalId: CANAL_A, ok: true })
    const trinta = Array.from({ length: 30 }, (_, i) => ({ em: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(), turnos: 3, criticas: 0 }))
    await dono`INSERT INTO agente_homologacao (tenant_id, canal_id, item, resultado) VALUES (${A}, ${CANAL_A}, 'playground', ${JSON.stringify({ entradas: trinta })}::text::jsonb)`
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'homologacao', podeAvancar: true, recomendacao: 'avancar' })
  })
})

// ── sombra e assistido ──────────────────────────────────────────────────────

describe('Sombra — decisões, P12 (CRÍTICA e juiz), P16 (concordância), P13 (similaridade), P6 e P7', () => {
  it('tudo semeado nos alvos → verde e pode avançar para assistido; juiz à parte no custo', async () => {
    await config(A, CANAL_A, 'sombra'); await trocouModoHa(A, CANAL_A, 16, 'desligado', 'sombra')
    const convs = await conversas(A, CANAL_A, 50)
    // 150 turnos; 90 com similaridade 0,7 e 60 com 0,3 (60% acima do limiar); custo 50/turno = R$ 1,50/conversa.
    const altos = await decidir(A, CANAL_A, convs.slice(0, 30), { modo: 'sombra', vezes: 3, custo: 50, sombra: 0.7 })
    await decidir(A, CANAL_A, convs.slice(30), { modo: 'sombra', vezes: 3, custo: 50, sombra: 0.3 })
    // 2 turnos com número bloqueado em 150 (1,3%): um R$ e um P7 substituído — mais um registrado (não conta).
    await dono`UPDATE agente_decisao SET numeros_bloqueados = '[{"centavos":100}]'::jsonb WHERE tenant_id = ${A} AND id = ${altos[0]!}`
    await dono`UPDATE agente_decisao SET guardrails = '[{"etapa":"numeros-ampliados","codigo":"numero_sem_fonte","gravidade":"CRITICA","acao":"substituido"}]'::jsonb WHERE tenant_id = ${A} AND id = ${altos[1]!}`
    await dono`UPDATE agente_decisao SET guardrails = '[{"etapa":"numeros-ampliados","codigo":"numero_sem_fonte","gravidade":"ALTA","acao":"registrado"}]'::jsonb WHERE tenant_id = ${A} AND id = ${altos[2]!}`
    // Juiz nota 4,5 em 20 conversas (custo 10 cada); revisão humana concorda nas 20.
    for (let i = 0; i < 20; i++) {
      const av = await avaliacao(A, CANAL_A, altos[i * 3]!, convs[i]!, { nota: 4.5, custo: 10 })
      await revisao(A, CANAL_A, av, convs[i]!, true)
    }
    await avaliacao(A, CANAL_A, altos[3]!, convs[1]!, { pior: null })

    const r = await goLive(A, CANAL_A)
    expect(r.statusCode).toBe(200)
    const b = r.json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'sombra', proximaFase: 'assistido', dias: 16, inicioEstimado: false })
    expect(b.diasUteis).toBeGreaterThanOrEqual(10)
    expect(crit(b, 'turnos')).toMatchObject({ valor: '150', ok: true })
    expect(crit(b, 'conversas')).toMatchObject({ valor: '50', ok: true })
    expect(crit(b, 'similaridade_sombra')).toMatchObject({ valor: '60% de 150', ok: true })
    expect(crit(b, 'custo_conversa')).toMatchObject({ valor: 'R$ 1,50', ok: true, motivo: expect.stringMatching(/Juiz à parte: R\$ 2,00.*fora do alvo/) })
    expect(crit(b, 'numeros_bloqueados')).toMatchObject({ valor: '1,3% (2 de 150)', ok: true })
    expect(crit(b, 'nota_juiz')).toMatchObject({ valor: '4,50 em 20', ok: true })
    expect(crit(b, 'concordancia')).toMatchObject({ valor: '100% em 20', ok: true })
    expect(crit(b, 'critica')).toMatchObject({ valor: '0', ok: true, fonte: expect.stringContaining('P12') })
    expect(b.criterios.filter((c) => c.ok !== true)).toEqual([])
    expect(b).toMatchObject({ podeAvancar: true, recomendacao: 'avancar' })
  })

  it('uma CRÍTICA que escapou (P12) reprova; concordância com < 20 revisadas é "sem medida" e tira a validade da nota', async () => {
    await config(A, CANAL_A, 'sombra'); await trocouModoHa(A, CANAL_A, 12, 'desligado', 'sombra')
    const convs = await conversas(A, CANAL_A, 5)
    const ds = await decidir(A, CANAL_A, convs, { modo: 'sombra', vezes: 2 })
    await avaliacao(A, CANAL_A, ds[0]!, convs[0]!, { pior: 'CRITICA' })
    const av = await avaliacao(A, CANAL_A, ds[2]!, convs[1]!, { nota: 5 })
    await revisao(A, CANAL_A, av, convs[1]!, true)

    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'critica')).toMatchObject({ valor: '1', ok: false })
    expect(crit(b, 'concordancia')).toMatchObject({ ok: null, valor: '100% em 1', motivo: expect.stringMatching(/1 de 20/) })
    expect(crit(b, 'nota_juiz')).toMatchObject({ ok: null, motivo: expect.stringMatching(/concordância/) })
    expect(crit(b, 'similaridade_sombra')).toMatchObject({ ok: null })
    expect(b.podeAvancar).toBe(false)
    expect([...b.pendencias.reprovados].sort()).toEqual(['conversas', 'critica', 'turnos'])
  })

  it('B2: a mesma conversa revisada em duas semanas conta UMA vez no mínimo de 20', async () => {
    await config(A, CANAL_A, 'sombra'); await trocouModoHa(A, CANAL_A, 16, 'desligado', 'sombra')
    const convs = await conversas(A, CANAL_A, 19)
    const ds = await decidir(A, CANAL_A, convs, { modo: 'sombra' })
    const anterior = deslocarSemana(SEMANA, -1)!
    for (let i = 0; i < 19; i++) {
      const av = await avaliacao(A, CANAL_A, ds[i]!, convs[i]!, { nota: 5 })
      await revisao(A, CANAL_A, av, convs[i]!, true)
    }
    // A conversa 0 revisada de novo na semana anterior: na P16 seriam 20 (conversa, semana); aqui são 19 conversas.
    const extra = await avaliacao(A, CANAL_A, (await decidir(A, CANAL_A, [convs[0]!], { modo: 'sombra' }))[0]!, convs[0]!, { nota: 5 })
    await revisao(A, CANAL_A, extra, convs[0]!, true, anterior)
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'concordancia')).toMatchObject({ ok: null, motivo: expect.stringMatching(/19 de 20/) })
  })
})

describe('Assistido — sugestões (P13) e CRÍTICA', () => {
  it('uso e sem-edição vêm das sugestões do banco', async () => {
    await config(A, CANAL_A, 'assistido'); await trocouModoHa(A, CANAL_A, 14, 'sombra', 'assistido')
    const convs = await conversas(A, CANAL_A, 100)
    // 100 sugestões: 40 enviadas, 15 editadas, 45 descartadas → uso 55%, sem edição 72,7% de 55.
    await decidir(A, CANAL_A, convs.slice(0, 40), { modo: 'assistido', sugestao: 'enviada' })
    await decidir(A, CANAL_A, convs.slice(40, 55), { modo: 'assistido', sugestao: 'editada' })
    await decidir(A, CANAL_A, convs.slice(55), { modo: 'assistido', sugestao: 'descartada' })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b.fase).toBe('assistido')
    expect(crit(b, 'sugestoes')).toMatchObject({ valor: '100', ok: true })
    expect(crit(b, 'uso_sugestao')).toMatchObject({ valor: '55% de 100', ok: true })
    expect(crit(b, 'sem_edicao')).toMatchObject({ valor: '72,7% de 55', ok: true })
    expect(crit(b, 'critica').ok).toBe(true)
    expect(b.podeAvancar).toBe(true)
  })
})

// ── autônomo ────────────────────────────────────────────────────────────────

describe('Autônomo num recorte — latência (M1), handoff, opt-out (P4), conversão (M2), pedidos e SLA (P18)', () => {
  it('cada fonte medida no número', async () => {
    await config(A, CANAL_A, 'autonomo', RECORTE); await trocouModoHa(A, CANAL_A, 22, 'assistido', 'autonomo')
    const ag = await conversas(A, CANAL_A, 40)
    // M1: o cliente falou 2 s antes da 1ª mensagem do agente em 39 sessões; 9 s numa (fica fora do p95 de 40).
    await decidir(A, CANAL_A, ag.slice(0, 39), { modo: 'autonomo', desfecho: 'respondeu', enviada: true, respostaMs: 2000, comSessao: true })
    await decidir(A, CANAL_A, ag.slice(39), { modo: 'autonomo', desfecho: 'respondeu', enviada: true, respostaMs: 9000, comSessao: true })
    await decidir(A, CANAL_A, ag.slice(0, 8), { modo: 'autonomo', desfecho: 'handoff', horasAtras: 1 })
    await decidir(A, CANAL_A, ag.slice(10, 11), {
      modo: 'autonomo', desfecho: 'respondeu', horasAtras: 1,
      guardrails: [{ etapa: 'gatilhos-entrada', codigo: 'opt_out', gravidade: 'INFO', acao: 'registrado' }],
    })
    for (const c of ag.slice(0, 7)) await pedido(A, c, { origem: 'agente', estado: 'confirmado', confirmado: true })
    await pedido(A, ag[7]!, { origem: 'agente', estado: 'cancelado', confirmado: true })
    for (const c of ag.slice(0, 9)) await handoffComSla(A, CANAL_A, c, 'no_prazo')
    await handoffComSla(A, CANAL_A, ag[9]!, 'atrasada')
    await handoffComSla(A, CANAL_A, ag[10]!, 'pendente')

    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'autonomo_recorte', proximaFase: 'autonomo_amplo', dias: 22 })
    expect(crit(b, 'dias').ok).toBe(true)
    expect(crit(b, 'p95_primeira')).toMatchObject({ valor: '2,0 s (40 sessões)', ok: true, motivo: expect.stringMatching(/debounce/) })
    expect(crit(b, 'handoff')).toMatchObject({ valor: '20% (8 de 40)', ok: true })
    expect(crit(b, 'opt_out')).toMatchObject({ valor: '2,5% (1 de 40)', ok: false })
    // Conversas recentes (< 14 dias): coorte madura vazia → sem medida, não reprova.
    expect(crit(b, 'conversao')).toMatchObject({ ok: null, motivo: expect.stringMatching(/coorte madura.*viés de seleção/) })
    expect(crit(b, 'pedido_errado')).toMatchObject({ valor: '1 de 8 confirmados', ok: false, motivo: expect.stringMatching(/Aproximação/) })
    expect(crit(b, 'sla_handoff')).toMatchObject({ valor: '90% de 10 · 1 em aberto', ok: true, fonte: expect.stringContaining('P18') })
    expect([...b.pendencias.reprovados].sort()).toEqual(['opt_out', 'pedido_errado'])
    expect(b).toMatchObject({ podeAvancar: false, recomendacao: 'manter' })
  })

  it('M1: p95 é do cliente falar até a 1ª mensagem do agente — não a latência do modelo', async () => {
    await config(A, CANAL_A, 'autonomo')
    const convs = await conversas(A, CANAL_A, 4)
    await decidir(A, CANAL_A, convs, { modo: 'autonomo', desfecho: 'respondeu', enviada: true, respostaMs: 8000, comSessao: true })
    await dono`UPDATE agente_decisao SET latencia_ms = 500 WHERE tenant_id = ${A}`
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'p95_primeira')).toMatchObject({ valor: '8,0 s (4 sessões)', ok: false })
  })

  it('p95 expõe as sessões sem medida (mensagens que não aparecem)', async () => {
    await config(A, CANAL_A, 'autonomo')
    const convs = await conversas(A, CANAL_A, 3)
    await decidir(A, CANAL_A, convs.slice(0, 2), { modo: 'autonomo', desfecho: 'respondeu', enviada: true, respostaMs: 3000, comSessao: true })
    await decidir(A, CANAL_A, convs.slice(2), { modo: 'autonomo', desfecho: 'respondeu', enviada: true, comSessao: true }) // sem mensagens
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'p95_primeira')).toMatchObject({ valor: '3,0 s (2 sessões)', motivo: expect.stringMatching(/1 sessão ficou sem medida/) })
  })

  it('M2: só coortes maduras (≥ 14 dias) entram; inferioridade clara reprova mesmo com pouca amostra', async () => {
    await config(A, CANAL_A, 'autonomo'); await trocouModoHa(A, CANAL_A, 40, 'assistido', 'autonomo')
    const ag = await conversas(A, CANAL_A, 40)
    const hu = await conversas(A, CANAL_A, 40)
    const novas = await conversas(A, CANAL_A, 10)
    await decidir(A, CANAL_A, ag, { modo: 'autonomo', desfecho: 'respondeu', horasAtras: 20 * 24 })
    await decidir(A, CANAL_A, novas, { modo: 'autonomo', desfecho: 'respondeu', horasAtras: 2 }) // imaturas: fora
    for (const c of hu) { await entrante(A, c, 20 * 24); await respostaHumana(A, c, 20 * 24 - 1) }
    for (const c of hu) await pedido(A, c, { origem: 'humano', estado: 'efetivado', confirmado: false })
    // Sem resposta de ninguém (nem agente, nem pessoa): fora das duas coortes.
    for (const c of await conversas(A, CANAL_A, 5)) await entrante(A, c, 20 * 24)
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'conversao')).toMatchObject({ ok: false, valor: expect.stringMatching(/^agente 0% \(n 40\) × humano 100% \(n 40\)/) })
    expect(b).toMatchObject({ recomendacao: 'voltar' })
  })

  it('A1: autônomo amplo com 0 conversas humanas → conversão sem medida e recomendação MANTER', async () => {
    await config(A, CANAL_A, 'autonomo'); await trocouModoHa(A, CANAL_A, 40, 'assistido', 'autonomo')
    const ag = await conversas(A, CANAL_A, 30)
    await decidir(A, CANAL_A, ag, { modo: 'autonomo', desfecho: 'respondeu', enviada: true, respostaMs: 1000, comSessao: true, horasAtras: 20 * 24 })
    await decidir(A, CANAL_A, ag.slice(0, 5), { modo: 'autonomo', desfecho: 'handoff', horasAtras: 20 * 24 - 1 })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b.fase).toBe('autonomo_amplo')
    expect(crit(b, 'conversao')).toMatchObject({ ok: null, motivo: expect.stringMatching(/humana/) })
    expect(b.pendencias.reprovados).toEqual([])
    expect(b).toMatchObject({ recomendacao: 'manter', voltarPara: null })
  })

  it('M3: no amplo, pedido confirmado e cancelado depois é ALERTA (revisar), não manda voltar', async () => {
    await config(A, CANAL_A, 'autonomo')
    const convs = await conversas(A, CANAL_A, 10)
    await decidir(A, CANAL_A, convs, { modo: 'autonomo', desfecho: 'respondeu', enviada: true, respostaMs: 1000, comSessao: true })
    await decidir(A, CANAL_A, convs.slice(0, 2), { modo: 'autonomo', desfecho: 'handoff', horasAtras: 1 })
    for (const c of convs.slice(0, 3)) await pedido(A, c, { origem: 'agente', estado: 'confirmado', confirmado: true })
    await pedido(A, convs[3]!, { origem: 'agente', estado: 'cancelado', confirmado: true })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'pedido_errado')).toMatchObject({ ok: true, alerta: expect.stringMatching(/Revise o pedido cancelado/) })
    expect(b).toMatchObject({ recomendacao: 'manter', pendencias: { alertas: ['pedido_errado'] } })
  })

  it('autônomo amplo com CRÍTICA (reprovação de verdade) recomenda voltar ao recorte, sem mudar o modo', async () => {
    await config(A, CANAL_A, 'autonomo')
    const convs = await conversas(A, CANAL_A, 5)
    const ds = await decidir(A, CANAL_A, convs, { modo: 'autonomo', desfecho: 'respondeu', enviada: true, comSessao: true })
    await avaliacao(A, CANAL_A, ds[0]!, convs[0]!, { pior: 'CRITICA' })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'autonomo_amplo', recomendacao: 'voltar', voltarPara: 'autonomo_recorte', janelaDias: 30 })
    const [c] = await dono<{ modo: string }[]>`SELECT modo FROM agente_config WHERE tenant_id = ${A} AND canal_id = ${CANAL_A}`
    expect(c!.modo).toBe('autonomo')
  })
})

// ── SLA: régua única (B1) ───────────────────────────────────────────────────

describe('B1 — SLA do handoff: a mesma função mede o tenant (/v1/performance) e o número (painel)', () => {
  it('filtra por número; sem número soma o tenant; pctCumprido inteiro, critério sem arredondar', async () => {
    const cs = await conversas(A, CANAL_A, 10) // um atendimento aberto por conversa
    for (const c of cs.slice(0, 9)) await handoffComSla(A, CANAL_A, c, 'no_prazo')
    await handoffComSla(A, CANAL_A, cs[9]!, 'estourado')
    const [cb] = await conversas(B, CANAL_B, 1)
    await handoffComSla(B, CANAL_B, cb!, 'estourado')
    const desde = new Date(Date.now() - 7 * DIA), agora = new Date()
    const doNumero = await comTenantServico(A, (tx) => metricaSlaHandoff(tx, { desde, agora, canalId: CANAL_A }))
    expect(doNumero).toMatchObject({ medidos: 10, cumpridos: 9, estourados: 1, pctCumprido: 90 })
    const doTenantB = await comTenantServico(B, (tx) => metricaSlaHandoff(tx, { desde, agora }))
    expect(doTenantB).toMatchObject({ medidos: 1, cumpridos: 0, pctCumprido: 0 })
    // Limite superior e "venceu?" contra o agora de quem chama: 3 h atrás nenhum SLA tinha começado.
    const antes = await comTenantServico(A, (tx) => metricaSlaHandoff(tx, { desde, agora: new Date(Date.now() - 3 * 3_600_000), canalId: CANAL_A }))
    expect(antes).toMatchObject({ medidos: 0, pendentes: 0, pctCumprido: null })
  })
})

// ── degradação ──────────────────────────────────────────────────────────────

describe('Degradação: fonte que falha vira "sem medida" e o resto segue', () => {
  it('SLA (P18) sem nenhum handoff decidido → sem medida com o motivo, não "verde"', async () => {
    await config(A, CANAL_A, 'autonomo', { segmentosRfv: ['campeoes'] })
    const convs = await conversas(A, CANAL_A, 1)
    await handoffComSla(A, CANAL_A, convs[0]!, 'pendente')
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'sla_handoff')).toMatchObject({ ok: null, indisponivel: true, valor: null, motivo: expect.stringMatching(/1 ainda no prazo/) })
  })

  const FALHA = async (): Promise<never> => { throw new Error('relation "x" does not exist') }

  it.each([
    ['desligado', 'douradas', ['douradas']],
    ['desligado', 'smoke', ['smoke']],
    ['desligado', 'playground', ['playground_conversas', 'playground_critica']],
    ['sombra', 'concordancia', ['concordancia']],
    ['sombra', 'notaJuiz', ['nota_juiz']],
    ['sombra', 'similaridadeSombra', ['similaridade_sombra']],
    ['sombra', 'criticas', ['critica']],
    ['sombra', 'custoPorConversa', ['custo_conversa']],
    ['sombra', 'numerosBloqueados', ['numeros_bloqueados']],
    ['sombra', 'volume', ['turnos', 'conversas']],
    ['assistido', 'sugestoes', ['sugestoes', 'uso_sugestao', 'sem_edicao']],
    ['autonomo', 'latenciaPrimeira', ['p95_primeira']],
    ['autonomo', 'handoff', ['handoff']],
    ['autonomo', 'optOut', ['opt_out']],
    ['autonomo', 'conversao', ['conversao']],
    ['autonomo', 'pedidosErrados', ['pedido_errado']],
    ['autonomo', 'slaHandoff', ['sla_handoff']],
  ] as const)('%s: fonte %s fora → %j sem medida; a transação segue viva', async (modo, fonte, ids) => {
    await config(A, CANAL_A, modo, modo === 'autonomo' ? { segmentosRfv: ['campeoes'] } : null)
    const coletores = { ...COLETORES, [fonte]: FALHA } as Coletores
    const r = await comTenantServico(A, (tx) => coletarGoLive(tx, { canalId: CANAL_A, agora: new Date() }, coletores))
    expect(r).not.toBeNull()
    for (const id of ids) expect(crit(r!, id)).toMatchObject({ ok: null, indisponivel: true, valor: null, motivo: expect.stringMatching(/não respondeu/) })
    // As outras fontes foram lidas (o savepoint isolou a falha): nenhuma outra diz "não respondeu".
    const outros = r!.criterios.filter((c) => !(ids as readonly string[]).includes(c.id))
    expect(outros.length).toBeGreaterThan(0)
    expect(outros.some((c) => /não respondeu/.test(c.motivo ?? ''))).toBe(false)
    expect(r!.podeAvancar).toBe(false)
    expect(r!.recomendacao).not.toBe('voltar')
  })
})

describe('Apoio', () => {
  it('semanas da janela no fuso da loja, da mais antiga à atual, com teto', () => {
    const agora = new Date('2026-10-17T12:00:00Z')
    expect(semanasDaJanela(new Date('2026-10-01T12:00:00Z'), agora, 'America/Sao_Paulo')).toEqual(['2026-W40', '2026-W41', '2026-W42'])
    expect(semanasDaJanela(new Date('2025-01-01T12:00:00Z'), agora, 'America/Sao_Paulo')).toHaveLength(13)
  })
})
