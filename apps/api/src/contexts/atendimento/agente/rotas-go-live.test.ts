import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { CRITERIOS_RUBRICA, semanaDaData, type GoLiveDto, type CriterioFase } from '@geracrm/shared'
import { comTenantServico, encerrarBanco } from '../../../db/index.js'
import { pluginTenant } from '../../../plugins/tenant.js'
import { rotasGoLive } from './rotas-go-live.js'
import { COLETORES, coletarGoLive, semanasDaJanela, type Coletores } from './go-live.js'

/**
 * GO-LIVE (raia P19) — banco real, dois tenants. Dados semeados por FONTE
 * (decisões, P12, P13, P16, P4, pedido, P18), RLS, papel, e a degradação de
 * cada fonte (fonte que falha → critério indisponível, os outros seguem).
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
const U_VENDEDOR = 'c0a19000-6666-4000-8000-000000000003'
const U_B = 'c0a19000-6666-4000-8000-000000000004'
const U_ADMIN = 'c0a19000-6666-4000-8000-000000000002'
const SUB_VENDEDOR = 'sub-vendedor-go-live'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
/** Protocolo do atendimento: único por tenant. */
const protocolo = { proximo: 1 }

const h = (t: string, sub?: string) => ({ 'x-tenant-id': t, ...(sub ? { 'x-teste-sub': sub } : {}) })
const goLive = async (t: string, canal: string, sub?: string) =>
  app.inject({ method: 'GET', url: `/v1/agente/go-live?canalId=${canal}`, headers: h(t, sub) })
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

/** A troca auditada de modo: é dela que sai o início da fase. */
async function trocouModoHa(t: string, canal: string, dias: number): Promise<void> {
  await dono`INSERT INTO auditoria (tenant_id, id, acao, entidade, entidade_id, dados, criado_em)
             VALUES (${t}, ${crypto.randomUUID()}, 'agente.config_alterada', 'agente_config', ${canal},
                     ${JSON.stringify({ antes: {}, depois: {}, campos: ['modo'] })}::text::jsonb, now() - make_interval(days => ${dias}))`
}

async function conversas(t: string, canal: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => crypto.randomUUID())
  const cts = ids.map(() => crypto.randomUUID())
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) SELECT ${t}::uuid, x, 'Cliente', true FROM unnest(${cts}::uuid[]) AS x`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, ultima_entrante_em)
             SELECT ${t}::uuid, u.c, ${canal}::uuid, u.k, 1, now() - interval '1 hour' FROM unnest(${ids}::uuid[], ${cts}::uuid[]) AS u(c, k)`
  return ids
}

interface OpcoesDecisao {
  readonly modo: string
  readonly desfecho?: string
  readonly vezes?: number
  readonly custo?: number
  readonly latencia?: number | null
  readonly enviada?: boolean
  readonly guardrails?: unknown[]
  readonly numeros?: unknown[]
  readonly sombra?: number | null
  readonly sugestao?: 'enviada' | 'editada' | 'descartada' | null
  readonly comSessao?: boolean
  readonly horasAtras?: number
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
      await dono`
        INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, sessao_id, modo, desfecho, resposta, custo_centavos, latencia_ms,
                                    enviada, guardrails, numeros_bloqueados, sombra_similaridade, sugestao_estado, sugestao_usada_em, criado_em)
        VALUES (${t}, ${id}, ${c}, ${canal}, ${sessao}, ${o.modo}, ${o.desfecho ?? 'sugeriu'}, '{"mensagens":["Temos sim."]}'::jsonb,
                ${o.custo ?? 0}, ${o.latencia ?? null}, ${o.enviada ?? false},
                ${JSON.stringify(o.guardrails ?? [])}::text::jsonb, ${JSON.stringify(o.numeros ?? [])}::text::jsonb,
                ${o.sombra ?? null}, ${o.sugestao ?? null}, ${o.sugestao ? new Date() : null},
                now() - make_interval(hours => ${(o.horasAtras ?? 2) + i}))`
    }
  }
  return ids
}

async function avaliacao(t: string, canal: string, decisaoId: string, conversaId: string, p: { pior?: 'CRITICA' | null; nota?: number }): Promise<string> {
  const id = crypto.randomUUID()
  if (p.nota !== undefined) {
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, origem, tipo, gatilho, notas, nota_media, modelo)
               VALUES (${t}, ${id}, ${decisaoId}, ${conversaId}, ${canal}, 'sugestao', 'juiz', 'fim_sessao',
                       ${JSON.stringify(Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, p.nota])))}::text::jsonb, ${p.nota}, 'simulado')`
  } else {
    await dono`INSERT INTO agente_avaliacao (tenant_id, id, decisao_id, conversa_id, canal_id, origem, tipo, gatilho, violacoes, pior_gravidade, acao)
               VALUES (${t}, ${id}, ${decisaoId}, ${conversaId}, ${canal}, 'sugestao', 'regras', 'turno', '[]'::jsonb, ${p.pior ?? null}, ${p.pior ? 'registrado' : null})`
  }
  return id
}

async function revisao(t: string, canal: string, avaliacaoId: string, conversaId: string, concorda: boolean): Promise<void> {
  const semana = semanaDaData(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }))!
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
                     ${p.confirmado ? new Date(Date.now() - 3_600_000) : null}, ${p.estado === 'cancelado' ? new Date() : null}, ${p.estado === 'cancelado' ? 'desfeito pelo vendedor' : null})`
}

/** Atendimento com SLA armado (P18). `resposta`: 'no_prazo' | 'atrasada' | null (estourado sem resposta) | 'pendente'. */
async function handoffComSla(t: string, canal: string, conversaId: string, r: 'no_prazo' | 'atrasada' | 'estourado' | 'pendente'): Promise<void> {
  const inicio = new Date(Date.now() - 2 * 3_600_000)
  const vence = r === 'pendente' ? new Date(Date.now() + 3_600_000) : new Date(Date.now() - 3_600_000)
  const respondido = r === 'no_prazo' ? new Date(vence.getTime() - 60_000) : r === 'atrasada' ? new Date(vence.getTime() + 60_000) : null
  await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado, sla_inicio_em, sla_vence_em, sla_respondido_em,
                                      sla_estourado_em)
             VALUES (${t}, ${crypto.randomUUID()}, ${conversaId}, ${canal}, ${900_000 + protocolo.proximo++}, 'na_fila', ${inicio}, ${vence}, ${respondido},
                     ${r === 'estourado' ? vence : null})`
}

async function limpar(t: string): Promise<void> {
  for (const tab of ['agente_revisao', 'agente_avaliacao', 'agente_decisao', 'agente_sessao', 'atendimento', 'pedido', 'mensagem', 'conversa',
    'contato', 'agente_config', 'agente_tenant', 'auditoria']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
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
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_VENDEDOR}, ${SUB_VENDEDOR}, 'Vito', 'vito@golive.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${U_B}, ${`dev-${B}`}, 'Beto', 'beto@golive.test') ON CONFLICT DO NOTHING`
  // Com um admin atribuído o tenant sai do modo fundador: o papel passa a valer para todos.
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${U_ADMIN}, 'sub-admin-go-live', 'Ada', 'ada@golive.test') ON CONFLICT DO NOTHING`
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
    await config(A, CANAL_A, 'sombra'); await trocouModoHa(A, CANAL_A, 15)
    await config(B, CANAL_B, 'sombra'); await trocouModoHa(B, CANAL_B, 15)
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

// ── fases e fontes ──────────────────────────────────────────────────────────

describe('Fase vem do modo do número (P14) e o painel só informa', () => {
  it('sem configuração → homologação: douradas, smoke e playground indisponíveis com o motivo; não avança', async () => {
    const r = await goLive(A, CANAL_A)
    const b = r.json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'homologacao', rotuloFase: 'Homologação', proximaFase: 'sombra', podeAvancar: false, alvosProposta: true })
    for (const id of ['douradas', 'smoke', 'playground_conversas', 'playground_critica']) {
      expect(crit(b, id)).toMatchObject({ ok: null, indisponivel: true })
      expect(crit(b, id).motivo).toBeTruthy()
    }
    expect(b.pendencias.indisponiveis).toHaveLength(4)
    expect(b.modoAgora.modo).toBe('desligado')
  })

  it('teto do tenant em sombra rebaixa um número autônomo para a fase sombra', async () => {
    await config(A, CANAL_A, 'autonomo')
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${A}, 'sombra')`
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b.fase).toBe('sombra')
    expect(b.modoAgora).toMatchObject({ modo: 'sombra', origem: 'tenant' })
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

describe('Sombra — decisões, P12 (CRÍTICA e juiz), P16 (concordância), P13 (similaridade), P6 e P7', () => {
  it('tudo semeado nos alvos → verde e pode avançar para assistido', async () => {
    await config(A, CANAL_A, 'sombra'); await trocouModoHa(A, CANAL_A, 16)
    const convs = await conversas(A, CANAL_A, 50)
    // 150 turnos; 90 com similaridade 0,7 e 60 com 0,3 (60% acima do limiar); custo 50/turno = R$ 1,50/conversa.
    const altos = await decidir(A, CANAL_A, convs.slice(0, 30), { modo: 'sombra', vezes: 3, custo: 50, sombra: 0.7 })
    await decidir(A, CANAL_A, convs.slice(30), { modo: 'sombra', vezes: 3, custo: 50, sombra: 0.3 })
    // 2 turnos com número bloqueado em 150 (1,3%): um R$ e um P7 substituído — mais um sem bloqueio (registrado).
    await dono`UPDATE agente_decisao SET numeros_bloqueados = '[{"centavos":100}]'::jsonb WHERE tenant_id = ${A} AND id = ${altos[0]!}`
    await dono`UPDATE agente_decisao SET guardrails = '[{"etapa":"numeros-ampliados","codigo":"numero_sem_fonte","gravidade":"CRITICA","acao":"substituido"}]'::jsonb WHERE tenant_id = ${A} AND id = ${altos[1]!}`
    await dono`UPDATE agente_decisao SET guardrails = '[{"etapa":"numeros-ampliados","codigo":"numero_sem_fonte","gravidade":"ALTA","acao":"registrado"}]'::jsonb WHERE tenant_id = ${A} AND id = ${altos[2]!}`
    // Juiz nota 4,5 em 20 conversas; revisão humana concorda nas 20.
    for (let i = 0; i < 20; i++) {
      const av = await avaliacao(A, CANAL_A, altos[i * 3]!, convs[i]!, { nota: 4.5 })
      await revisao(A, CANAL_A, av, convs[i]!, true)
    }
    // Regras sem CRÍTICA (o que escapou: nada).
    await avaliacao(A, CANAL_A, altos[3]!, convs[1]!, { pior: null })

    const r = await goLive(A, CANAL_A)
    expect(r.statusCode).toBe(200)
    const b = r.json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'sombra', proximaFase: 'assistido', dias: 16, inicioEstimado: false })
    expect(b.diasUteis).toBeGreaterThanOrEqual(10)
    expect(crit(b, 'turnos')).toMatchObject({ valor: '150', ok: true })
    expect(crit(b, 'conversas')).toMatchObject({ valor: '50', ok: true })
    expect(crit(b, 'similaridade_sombra')).toMatchObject({ valor: '60% de 150', ok: true })
    expect(crit(b, 'custo_conversa')).toMatchObject({ valor: 'R$ 1,50', ok: true })
    expect(crit(b, 'numeros_bloqueados')).toMatchObject({ valor: '1,3% (2 de 150)', ok: true })
    expect(crit(b, 'nota_juiz')).toMatchObject({ valor: '4,50 em 20', ok: true })
    expect(crit(b, 'concordancia')).toMatchObject({ valor: '100% em 20', ok: true })
    expect(crit(b, 'critica')).toMatchObject({ valor: '0', ok: true, fonte: expect.stringContaining('P12') })
    expect(b.criterios.every((c) => c.ok === true)).toBe(true)
    expect(b).toMatchObject({ podeAvancar: true, recomendacao: 'avancar' })
  })

  it('uma CRÍTICA que escapou (P12) reprova; concordância abaixo de 20 tira a validade da nota', async () => {
    await config(A, CANAL_A, 'sombra'); await trocouModoHa(A, CANAL_A, 12)
    const convs = await conversas(A, CANAL_A, 5)
    const ds = await decidir(A, CANAL_A, convs, { modo: 'sombra', vezes: 2 })
    await avaliacao(A, CANAL_A, ds[0]!, convs[0]!, { pior: 'CRITICA' })
    const av = await avaliacao(A, CANAL_A, ds[2]!, convs[1]!, { nota: 5 })
    await revisao(A, CANAL_A, av, convs[1]!, true)

    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'critica')).toMatchObject({ valor: '1', ok: false })
    expect(crit(b, 'concordancia')).toMatchObject({ ok: false, valor: '100% em 1' })
    expect(crit(b, 'nota_juiz').ok).toBe(false)
    expect(crit(b, 'nota_juiz').motivo).toMatch(/concordância/)
    expect(b.podeAvancar).toBe(false)
    expect(b.pendencias.reprovados).toEqual(expect.arrayContaining(['critica', 'concordancia', 'nota_juiz', 'turnos', 'conversas']))
  })

  it('sem auditoria da troca de modo, o início é estimado pela 1ª decisão no modo', async () => {
    await config(A, CANAL_A, 'sombra')
    const convs = await conversas(A, CANAL_A, 1)
    await decidir(A, CANAL_A, convs, { modo: 'sombra', horasAtras: 24 * 5 + 1 })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ inicioEstimado: true, dias: 5 })
  })
})

describe('Assistido — sugestões (P13) e CRÍTICA', () => {
  it('uso e sem-edição vêm das sugestões do banco', async () => {
    await config(A, CANAL_A, 'assistido'); await trocouModoHa(A, CANAL_A, 14)
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

describe('Autônomo num recorte — latência, handoff, opt-out (P4), conversão, pedidos e SLA (P18)', () => {
  const RECORTE = { horario: { dias: ['seg', 'ter', 'qua', 'qui', 'sex'], de: '08:00', ate: '18:00' } }

  it('cada fonte medida no número, comparando com a coorte humana', async () => {
    await config(A, CANAL_A, 'autonomo', RECORTE); await trocouModoHa(A, CANAL_A, 22)
    const ag = await conversas(A, CANAL_A, 40)
    const hu = await conversas(A, CANAL_A, 40)
    // 40 conversas do agente, 1ª resposta 2 s (uma em 9 s fica fora do p95 de 40? não: 1/40 = 2,5% → p95 2 s).
    await decidir(A, CANAL_A, ag.slice(0, 39), { modo: 'autonomo', desfecho: 'respondeu', enviada: true, latencia: 2000, comSessao: true })
    await decidir(A, CANAL_A, ag.slice(39), { modo: 'autonomo', desfecho: 'respondeu', enviada: true, latencia: 9000, comSessao: true })
    // 8 handoffs (20%).
    await decidir(A, CANAL_A, ag.slice(0, 8), { modo: 'autonomo', desfecho: 'handoff', horasAtras: 1 })
    // 1 opt-out pelo gatilho (2,5%) → reprova o ≤ 1%.
    await decidir(A, CANAL_A, ag.slice(10, 11), {
      modo: 'autonomo', desfecho: 'respondeu', horasAtras: 1,
      guardrails: [{ etapa: 'gatilhos-entrada', codigo: 'opt_out', gravidade: 'INFO', acao: 'registrado' }],
    })
    // Conversão: agente 8/40 = 20%; humano 8/40 = 20%.
    for (const c of ag.slice(0, 7)) await pedido(A, c, { origem: 'agente', estado: 'confirmado', confirmado: true })
    await pedido(A, ag[7]!, { origem: 'agente', estado: 'cancelado', confirmado: true }) // confirmado e depois cancelado
    for (const c of hu.slice(0, 8)) await pedido(A, c, { origem: 'humano', estado: 'efetivado', confirmado: false })
    // SLA: 9 no prazo, 1 atrasado → 90%; 1 pendente não entra.
    for (const c of ag.slice(0, 9)) await handoffComSla(A, CANAL_A, c, 'no_prazo')
    await handoffComSla(A, CANAL_A, ag[9]!, 'atrasada')
    await handoffComSla(A, CANAL_A, ag[10]!, 'pendente')

    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'autonomo_recorte', proximaFase: 'autonomo_amplo', dias: 22 })
    expect(crit(b, 'dias').ok).toBe(true)
    expect(crit(b, 'p95_primeira')).toMatchObject({ valor: '2,0 s (40)', ok: true })
    expect(crit(b, 'handoff')).toMatchObject({ valor: '20% (8 de 40)', ok: true })
    expect(crit(b, 'opt_out')).toMatchObject({ valor: '2,5% (1 de 40)', ok: false })
    expect(crit(b, 'conversao')).toMatchObject({ valor: 'agente 20% (40) × humano 20% (40)', ok: true })
    expect(crit(b, 'pedido_errado')).toMatchObject({ valor: '1 de 8 confirmados', ok: false })
    expect(crit(b, 'sla_handoff')).toMatchObject({ valor: '90% de 10 · 1 em aberto', ok: true, fonte: expect.stringContaining('P18') })
    expect(b).toMatchObject({ podeAvancar: false, recomendacao: 'manter' })
    expect([...b.pendencias.reprovados].sort()).toEqual(['opt_out', 'pedido_errado'])
  })

  it('autônomo amplo com critério violado recomenda voltar ao recorte (sem mudar o modo)', async () => {
    await config(A, CANAL_A, 'autonomo')
    const convs = await conversas(A, CANAL_A, 5)
    const ds = await decidir(A, CANAL_A, convs, { modo: 'autonomo', desfecho: 'respondeu', enviada: true, latencia: 1000, comSessao: true })
    await avaliacao(A, CANAL_A, ds[0]!, convs[0]!, { pior: 'CRITICA' })
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(b).toMatchObject({ fase: 'autonomo_amplo', proximaFase: null, podeAvancar: false, recomendacao: 'voltar', voltarPara: 'autonomo_recorte', janelaDias: 30 })
    const [c] = await dono<{ modo: string }[]>`SELECT modo FROM agente_config WHERE tenant_id = ${A} AND canal_id = ${CANAL_A}`
    expect(c!.modo).toBe('autonomo')
  })
})

// ── degradação ──────────────────────────────────────────────────────────────

describe('Degradação: fonte ausente ou que falha vira "indisponível" e o resto segue', () => {
  it('SLA (P18) sem nenhum handoff medido → indisponível com o motivo, não "verde"', async () => {
    await config(A, CANAL_A, 'autonomo', { segmentosRfv: ['campeoes'] })
    const convs = await conversas(A, CANAL_A, 1)
    await handoffComSla(A, CANAL_A, convs[0]!, 'pendente')
    const b = (await goLive(A, CANAL_A)).json() as GoLiveDto
    expect(crit(b, 'sla_handoff')).toMatchObject({ ok: null, indisponivel: true, valor: null })
    expect(crit(b, 'sla_handoff').motivo).toMatch(/1 ainda no prazo/)
  })

  const FALHA = async (): Promise<never> => { throw new Error('relation "x" does not exist') }

  it.each([
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
  ] as const)('%s: fonte %s fora → %j indisponíveis; transação segue viva', async (modo, fonte, ids) => {
    await config(A, CANAL_A, modo, modo === 'autonomo' ? RECORTE_SEG : null)
    const coletores = { ...COLETORES, [fonte]: FALHA } as Coletores
    const r = await comTenantServico(A, (tx) => coletarGoLive(tx, { canalId: CANAL_A, agora: new Date() }, coletores))
    expect(r).not.toBeNull()
    for (const id of ids) expect(crit(r!, id)).toMatchObject({ ok: null, indisponivel: true, valor: null, motivo: expect.stringMatching(/não respondeu/) })
    // As outras fontes foram medidas (o savepoint isolou a falha).
    const outros = r!.criterios.filter((c) => !(ids as readonly string[]).includes(c.id) && c.id !== 'sla_handoff')
    expect(outros.length).toBeGreaterThan(0)
    expect(outros.every((c) => c.ok !== null)).toBe(true)
    expect(r!.podeAvancar).toBe(false)
  })
})

const RECORTE_SEG = { segmentosRfv: ['campeoes'] }

describe('Apoio', () => {
  it('semanas da janela no fuso da loja, da mais antiga à atual, com teto', () => {
    const agora = new Date('2026-10-17T12:00:00Z')
    expect(semanasDaJanela(new Date('2026-10-01T12:00:00Z'), agora, 'America/Sao_Paulo')).toEqual(['2026-W40', '2026-W41', '2026-W42'])
    expect(semanasDaJanela(new Date('2025-01-01T12:00:00Z'), agora, 'America/Sao_Paulo')).toHaveLength(13)
  })
})
