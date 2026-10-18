import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

// ⚠️ POOL PEQUENO DE PROPÓSITO (revisão P13): 5 conexões, teto de copiloto 3. Com o antigo
//    `sql.reserve()` por geração, N copilotos em paralelo prendiam o pool e a instância travava.
//    `vi.hoisted` roda antes dos imports, então o pool de db/index.ts nasce com este tamanho.
vi.hoisted(() => { process.env.DB_POOL_MAX = '5' })
import postgres from 'postgres'
import Fastify, { type FastifyInstance } from 'fastify'
import { PRAZO_COPILOTO_MS } from '@geracrm/shared'
import { criarApp } from '../../../app.js'
import { encerrarBanco } from '../../../db/index.js'
import { cifrar } from '../../integracao/cofre.js'
import { pluginTenant } from '../../../plugins/tenant.js'
import { rotasSugestao } from './rotas-sugestao.js'
import { conduzirTurnoVendedor } from './vendedor.js'
import { MAX_COPILOTOS_SIMULTANEOS, copilotosEmAndamento, modoDoCopiloto } from './sugestao.js'
import { despacharParaTeste, assinar } from '../eventos/barramento.js'
import type { PortaLlmFerramentas, ResultadoLaco } from './porta-llm.js'
import type { Ligacoes } from './ferramentas/ligacoes-porta.js'

/**
 * SUGESTÃO DO ASSISTIDO, COPILOTO E MÉTRICA DE EDIÇÃO (raia P13) — pela HTTP, banco real, sob o
 * papel da aplicação (a API conecta como geracrm_api). O WhatsApp é falso (fábrica de canal mockada).
 */
const enviadosAoCanal: string[] = []
vi.mock('../canais/fabrica.js', () => ({
  criarCanal: () => ({
    enviarTexto: async (_para: string, texto: string) => { enviadosAoCanal.push(texto); return { ok: true, idExterno: `ext-${enviadosAoCanal.length}` } },
    enviarImagem: async (_para: string, _img: string, legenda?: string) => { enviadosAoCanal.push(legenda ?? '[imagem]'); return { ok: true, idExterno: `ext-${enviadosAoCanal.length}` } },
  }),
}))

const T = 'b7130000-0000-4000-8000-000000000001'
const OUTRO = 'b7130000-0000-4000-8000-000000000002'
const PV = 'b7130000-1111-4000-8000-000000000001'
const PV2 = 'b7130000-1111-4000-8000-000000000002'
const PLANO = 'b7130000-3333-4000-8000-000000000001'
const MODELO = 'b7130000-4444-4000-8000-000000000001'
const CANAL = 'b7130000-5555-4000-8000-000000000001'
const CANAL_B = 'b7130000-5555-4000-8000-000000000002'
const CONTATO = 'b7130000-6666-4000-8000-000000000001'
const CONTATO_B = 'b7130000-6666-4000-8000-000000000002'
const CONVERSA = 'b7130000-7777-4000-8000-000000000001'
const CONVERSA_B = 'b7130000-7777-4000-8000-000000000002'
const URL_PRIVACIDADE = 'https://loja-p13.test/privacidade'
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
/** Conexão sob o papel da APLICAÇÃO com o tenant B fixo — prova de RLS sem o dono. */
const appComoB = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { 'geracrm.tenant_id': OUTRO } as never })

let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>, a: FastifyInstance = app) =>
  a.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis. Pagamento por PIX.', false, false,
          '{"nome":"Lia","loja":"Loja P13"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`

const doCliente = async (texto: string, conversa = CONVERSA, tenant = T): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${tenant}, ${id}, ${conversa}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, clock_timestamp())`
  await dono`UPDATE conversa SET ultima_entrante_em = now() WHERE tenant_id = ${tenant} AND id = ${conversa}`
  return id
}

/** Uma decisão-sugestão gravada direto (o turno real é exercitado no primeiro teste). */
const decisao = async (p: {
  modo: string; mensagens: string[]; desfecho?: string; guardrails?: unknown[]; tenant?: string; conversa?: string; canal?: string
  /** As entrantes que o turno respondeu (pareamento da sombra). */
  mensagensIds?: string[]
}): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`
    INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, resposta, confianca, guardrails, mensagens_ids, criado_em)
    VALUES (${p.tenant ?? T}, ${id}, ${p.conversa ?? CONVERSA}, ${p.canal ?? CANAL}, ${p.modo}, ${p.desfecho ?? 'sugeriu'},
            ${JSON.stringify({ mensagens: p.mensagens, confianca: 0.9 })}::text::jsonb, 0.9,
            ${JSON.stringify(p.guardrails ?? [])}::text::jsonb, ${p.mensagensIds ?? []}::uuid[], clock_timestamp())`
  return id
}
const linha = async (id: string) => (await dono<{
  sugestao_estado: string | null; sugestao_similaridade: string | null; sugestao_mensagem_id: string | null; sombra_similaridade: string | null
}[]>`SELECT sugestao_estado, sugestao_similaridade::text, sugestao_mensagem_id, sombra_similaridade::text FROM agente_decisao WHERE tenant_id = ${T} AND id = ${id}`)[0]!
const contar = async (tabela: string, tenant = T) =>
  (await dono.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${tabela} WHERE tenant_id = '${tenant}'`))[0]!.n

function llmQueDiz(texto: string): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> {
      return { ok: true, saida: { mensagens: [texto], confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    } }
}
function llmLento(ms: number): PortaLlmFerramentas {
  return { nome: 'lento', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> { await new Promise((r) => setTimeout(r, ms)); return llmQueDiz('tarde demais').rodar({} as never) } }
}
const llmQueFalha: PortaLlmFerramentas = { nome: 'falha', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
  async rodar(): Promise<ResultadoLaco> { return { ok: false, motivo: 'indisponivel' as never, detalhe: 'simulada' } } }
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } } as unknown as Ligacoes)

/** App mínima com o copiloto apontado para uma porta de modelo de teste. */
async function appCom(llm: PortaLlmFerramentas, prazoMs: number): Promise<FastifyInstance> {
  const a = Fastify()
  await a.register(pluginTenant)
  await a.register(rotasSugestao, { copiloto: { llm, prazoMs } })
  await a.ready()
  return a
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.IA_PROVEDOR = 'simulado'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-rotas-sugestao', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-rotas-sugestao', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, canal, contato, conversa, fone] of [
    [T, PV, CANAL, CONTATO, CONVERSA, '5585999913001'], [OUTRO, PV2, CANAL_B, CONTATO_B, CONVERSA_B, '5585999913002'],
  ] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, 'Sugestao', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    // ⚠️ Oficial (meta_oficial), não PlugZapi: o vigia de conexão de OUTRO arquivo de teste varre
    //    todos os tenants e sondaria um canal PlugZapi com credencial (derrubando-o para
    //    'desconectado' no meio deste arquivo). Sessão do oficial não cai — o vigia pula.
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
               VALUES (${t}, ${canal}, 'whatsapp_oficial', 'meta_oficial', 'Loja', 'conectado', ${cifrar({ phoneNumberId: `P13-${t.slice(-1)}`, token: 'tok' })})
               ON CONFLICT DO NOTHING`
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${t}, ${canal}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${contato}, 'Cliente P13', true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${t}, ${contato}, 1, ${fone}, ${fone}, true, true, 'teste') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conversa}, ${canal}, ${contato}, 1) ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO tenant_privacidade (tenant_id, url, versao) VALUES (${T}, ${URL_PRIVACIDADE}, 'v2') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})
beforeEach(async () => {
  enviadosAoCanal.length = 0
  for (const t of ['agente_decisao', 'agente_sessao', 'agente_tarefa', 'atendimento', 'aviso_privacidade', 'cliente_memoria', 'copiloto_geracao', 'mensagem', 'outbox']) {
    for (const ten of [T, OUTRO]) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${ten}'`)
  }
  await configurar('assistido')
  // Janela de 24h aberta (canal oficial): o envio humano precisa passar pelo gateway.
  await dono`UPDATE conversa SET ultima_entrante_em = now() WHERE tenant_id IN (${T}, ${OUTRO})`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_sessao', 'agente_tarefa', 'agente_config', 'agente_tenant', 'atendimento', 'aviso_privacidade', 'tenant_privacidade',
    'mensagem', 'conversa', 'contato_telefone', 'contato', 'auditoria', 'usuario', 'canal_configuracao', 'canal_conectado', 'outbox', 'alerta', 'metrica_diaria']) {
    for (const ten of [T, OUTRO]) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${ten}'`).catch(() => undefined)
  }
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${OUTRO})`
  await app.close(); await encerrarBanco(); await dono.end(); await appComoB.end()
})

describe('A sugestão do assistido chega ao vendedor', () => {
  it('dado um turno em assistido, quando o inbox pede a sugestão, então recebe o texto, a origem e o selo do modo', async () => {
    const id = await doCliente('vocês entregam em Fortaleza?')
    const r = await conduzirTurnoVendedor(
      { tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [id], tentativas: 1, executar_em: new Date() },
      { llm: llmQueDiz('Entregamos sim! Quer que eu veja o frete para o seu CEP?'), ligacoes },
    )
    expect(r.desfecho).toBe('sugeriu')
    const g = await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)
    expect(g.statusCode).toBe(200)
    const b = g.json() as { sugestao: { decisaoId: string; origem: string; texto: string; naoEnvie: boolean; avisos: unknown[] }; modoAgente: string; copilotoDisponivel: boolean }
    expect(b.sugestao).toMatchObject({ decisaoId: r.decisaoId, origem: 'assistido', texto: 'Entregamos sim! Quer que eu veja o frete para o seu CEP?', naoEnvie: false, avisos: [] })
    expect(b.modoAgente).toBe('assistido')
    expect(b.copilotoDisponivel).toBe(true)
  })

  it('marcas de guardrail viram avisos por gravidade: CRÍTICA = não envie; opt-out a confirmar em destaque', async () => {
    await decisao({ modo: 'assistido', mensagens: ['Vou confirmar os valores certinhos com a equipe e já te retorno.'], desfecho: 'handoff', guardrails: [
      { etapa: 'guardrail-reais', codigo: 'valor_sem_fonte', gravidade: 'CRITICA', acao: 'substituido' },
      { etapa: 'gatilhos-entrada', codigo: 'opt_out_confirmar', gravidade: 'ALTA', acao: 'registrado' },
      { etapa: 'gatilhos-entrada', codigo: 'opt_out', gravidade: 'INFO', acao: 'registrado' },
    ] })
    const b = (await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: { naoEnvie: boolean; optOutAConfirmar: boolean; avisos: { codigo: string; gravidade: string }[] } }
    expect(b.sugestao.naoEnvie).toBe(true)
    expect(b.sugestao.optOutAConfirmar).toBe(true)
    // O opt-out a confirmar vai no destaque (`optOutAConfirmar`), não repetido nos avisos (Pvis2).
    expect(b.sugestao.avisos.map((a) => a.codigo)).toEqual(['valor_sem_fonte'])
  })

  it('sombra não aparece para o vendedor; sem sugestão → null; humano respondeu depois → some', async () => {
    await decisao({ modo: 'sombra', mensagens: ['texto da sombra'] })
    expect(((await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: unknown }).sugestao).toBeNull()
    await decisao({ modo: 'assistido', mensagens: ['sugestão velha'] })
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, 'saliente', 'texto', '{"texto":"respondi pelo celular"}'::jsonb, clock_timestamp())`
    expect(((await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: unknown }).sugestao).toBeNull()
  })
})

describe('Envio a partir da sugestão — enviada × editada + similaridade', () => {
  it('dado o texto igual, então grava enviada com similaridade 1 e o conteúdo da mensagem não carrega o id', async () => {
    const d = await decisao({ modo: 'assistido', mensagens: ['Temos a caixa com 12 unidades.', 'Quer que eu separe?'] })
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Temos a caixa com 12 unidades.\n\nQuer que eu separe?', sugestaoDecisaoId: d })
    expect(r.statusCode).toBe(200)
    const b = r.json() as { mensagemId: string; sugestao: { registrada: boolean; estado: string; similaridade: number } }
    expect(b.sugestao).toEqual({ registrada: true, estado: 'enviada', similaridade: 1 })
    expect(await linha(d)).toMatchObject({ sugestao_estado: 'enviada', sugestao_similaridade: '1.000', sugestao_mensagem_id: b.mensagemId })
    const [m] = await dono<{ conteudo: Record<string, unknown> }[]>`SELECT conteudo FROM mensagem WHERE tenant_id = ${T} AND id = ${b.mensagemId}`
    expect(m!.conteudo).toEqual({ texto: 'Temos a caixa com 12 unidades.\n\nQuer que eu separe?' })
    expect(enviadosAoCanal.length).toBe(1)
  })

  it('dado o texto editado, então grava editada com a similaridade medida no servidor; reenviar não decide de novo', async () => {
    const d = await decisao({ modo: 'copiloto', mensagens: ['Temos a caixa com 12 unidades, entrega amanhã.'] })
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Temos a caixa com 24 unidades, entrega amanhã.', sugestaoDecisaoId: d })
    const s = (r.json() as { sugestao: { estado: string; similaridade: number } }).sugestao
    expect(s.estado).toBe('editada')
    expect(s.similaridade).toBeGreaterThan(0.5)
    expect(s.similaridade).toBeLessThan(1)
    const de_novo = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'outra', sugestaoDecisaoId: d })
    expect(de_novo.statusCode).toBe(200) // nunca bloqueia o envio
    expect((de_novo.json() as { sugestao: unknown }).sugestao).toEqual({ registrada: false, motivo: 'ja_decidida' })
    expect((await linha(d)).sugestao_estado).toBe('editada')
  })

  it('responder sem usar marca as pendentes como superadas e publica agente.sugestao só com ids', async () => {
    const d1 = await decisao({ modo: 'assistido', mensagens: ['primeira'] })
    const d2 = await decisao({ modo: 'assistido', mensagens: ['segunda'] })
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'respondi do meu jeito' })
    expect((await linha(d1)).sugestao_estado).toBe('superada')
    expect((await linha(d2)).sugestao_estado).toBe('superada')
    const evs = await dono<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox WHERE tenant_id = ${T} AND tipo = 'agente.sugestao'`
    expect(evs.length).toBe(1)
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['conversaId', 'decisaoId'])
  })

  it('sugestão barrada pela qualidade (nao_envie): selo no GET, 422 no texto inalterado, editada passa', async () => {
    const texto = 'Garantimos a entrega amanhã sem falta.'
    const d = await decisao({ modo: 'assistido', mensagens: [texto], guardrails: [
      { etapa: 'regras-qualidade', codigo: 'nao_envie', gravidade: 'CRITICA', acao: 'bloqueado', trecho: 'promessa de prazo sem fonte' },
    ] })
    const g = (await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: { bloqueada: boolean; motivoBloqueio: string; naoEnvie: boolean } }
    expect(g.sugestao).toMatchObject({ bloqueada: true, motivoBloqueio: 'promessa de prazo sem fonte', naoEnvie: true })

    const antes = await contar('mensagem')
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: `  ${texto} `, sugestaoDecisaoId: d })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { erro: string }).erro).toBe('sugestao.bloqueada')
    expect(await contar('mensagem')).toBe(antes) // nada gravado
    expect(enviadosAoCanal).toEqual([]) // nada despachado
    expect((await linha(d)).sugestao_estado).toBeNull()

    // Mesmas palavras, só pontuação/caixa/ordem (similaridade 1): continua barrado.
    const quase = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'garantimos a entrega AMANHÃ, sem falta!!', sugestaoDecisaoId: d })
    expect(quase.statusCode).toBe(422)
    expect(await contar('mensagem')).toBe(antes)

    const ok = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'A entrega está prevista para amanhã; confirmo com a transportadora.', sugestaoDecisaoId: d })
    expect(ok.statusCode).toBe(200)
    expect((await linha(d)).sugestao_estado).toBe('editada')
  })

  it('outra CRÍTICA (não nao_envie) só avisa: o texto inalterado sai', async () => {
    const d = await decisao({ modo: 'assistido', mensagens: ['Texto qualquer.'], guardrails: [{ etapa: 'filtro-saida', codigo: 'oferece_desconto', gravidade: 'CRITICA', acao: 'removido' }] })
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Texto qualquer.', sugestaoDecisaoId: d })
    expect(r.statusCode).toBe(200)
    expect((await linha(d)).sugestao_estado).toBe('enviada')
  })

  it('id de sugestão de outra conversa é ignorado sem bloquear o envio', async () => {
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'oi', sugestaoDecisaoId: crypto.randomUUID() })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { sugestao: unknown }).sugestao).toEqual({ registrada: false, motivo: 'nao_encontrada' })
    // E o id cru do corpo não vai para o outbox (nada foi decidido).
    expect((await dono`SELECT 1 FROM outbox WHERE tenant_id = ${T} AND tipo = 'agente.sugestao'`).length).toBe(0)
  })

  it('sugestaoDecisaoId malformado é descartado: a mensagem sai (200) e nada é decidido', async () => {
    const d = await decisao({ modo: 'assistido', mensagens: ['texto'] })
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'texto', sugestaoDecisaoId: 'nao-e-uuid' })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { sugestao?: unknown }).sugestao).toBeUndefined()
    expect((await linha(d)).sugestao_estado).toBe('superada') // respondeu sem usar
  })

  it('"Usar" e reescrever por cima (similaridade < 0,2) conta como superada, não editada', async () => {
    const d = await decisao({ modo: 'assistido', mensagens: ['Temos o sabão neutro em caixa com 12 unidades, entrega amanhã.'] })
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Bom dia! Vou ver com o gerente e te chamo.', sugestaoDecisaoId: d })
    expect((r.json() as { sugestao: { estado: string } }).sugestao.estado).toBe('superada')
    const l = await linha(d)
    expect(l.sugestao_estado).toBe('superada')
    expect(l.sugestao_mensagem_id).toBeNull()
    expect(Number(l.sugestao_similaridade)).toBeLessThan(0.2)
  })

  it('superar pendentes não toca decisões que não são sugestão (sombra, silêncio)', async () => {
    const sombra = await decisao({ modo: 'sombra', mensagens: ['x'] })
    const silencio = await decisao({ modo: 'assistido', mensagens: ['y'], desfecho: 'silencio' })
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'oi' })
    expect((await linha(sombra)).sugestao_estado).toBeNull()
    expect((await linha(silencio)).sugestao_estado).toBeNull()
  })
})

describe('Descartar', () => {
  it('descarta uma vez (200), a segunda é 409, id desconhecido é 404, e audita', async () => {
    const d = await decisao({ modo: 'assistido', mensagens: ['texto'] })
    expect((await chamar(T, 'POST', `/v1/agente/sugestoes/${d}/descartar`, { motivo: 'tom errado' })).statusCode).toBe(200)
    expect((await linha(d)).sugestao_estado).toBe('descartada')
    const b = await chamar(T, 'POST', `/v1/agente/sugestoes/${d}/descartar`)
    expect(b.statusCode).toBe(409)
    expect((b.json() as { erro: string; estado: string })).toMatchObject({ erro: 'sugestao.ja_decidida', estado: 'descartada' })
    expect((await chamar(T, 'POST', `/v1/agente/sugestoes/${crypto.randomUUID()}/descartar`)).statusCode).toBe(404)
    const [a] = await dono<{ dados: { motivo: string } }[]>`SELECT dados FROM auditoria WHERE tenant_id = ${T} AND acao = 'agente.sugestao_descartada' AND entidade_id = ${d}`
    expect(a!.dados.motivo).toBe('tom errado')
    expect(((await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: unknown }).sugestao).toBeNull()
  })
  it('decisão de sombra não é sugestão: não descarta', async () => {
    const d = await decisao({ modo: 'sombra', mensagens: ['texto'] })
    expect((await chamar(T, 'POST', `/v1/agente/sugestoes/${d}/descartar`)).statusCode).toBe(404)
  })
})

describe('Sombra × humano', () => {
  it('pareia pela ENTRANTE que gerou a decisão e junta as mensagens humanas até a próxima entrante', async () => {
    const e = await doCliente('qual o prazo de entrega?')
    const d = await decisao({ modo: 'sombra', mensagens: ['Entregamos em 3 dias úteis pela transportadora.'], mensagensIds: [e] })
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Entregamos em 3 dias úteis' })
    const parcial = Number((await linha(d)).sombra_similaridade)
    expect(parcial).toBeLessThan(1)
    // A 2ª mensagem humana COMPLETA a resposta: a similaridade é recalculada sobre o conjunto.
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'pela transportadora!' })
    expect((await linha(d)).sombra_similaridade).toBe('1.000')
  })
  it('chegou outra entrante sem decisão de sombra: a resposta humana NÃO é pareada com a decisão antiga', async () => {
    const e1 = await doCliente('qual o prazo?')
    const d = await decisao({ modo: 'sombra', mensagens: ['Entregamos em 3 dias.'], mensagensIds: [e1] })
    await doCliente('e o frete?') // o turno de sombra desta ainda não rodou
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Entregamos em 3 dias.' })
    expect((await linha(d)).sombra_similaridade).toBeNull()
  })
  it('mensagem de automação (marcador) não conta como resposta humana', async () => {
    const e = await doCliente('oi')
    const d = await decisao({ modo: 'sombra', mensagens: ['Olá! Como posso ajudar?'], mensagensIds: [e] })
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, 'saliente', 'texto', '{"texto":"Promoção da semana!","automatica":"automacao"}'::jsonb, clock_timestamp())`
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Olá! Como posso ajudar?' })
    expect((await linha(d)).sombra_similaridade).toBe('1.000')
  })
})

describe('Aviso de privacidade no envio humano (P4)', () => {
  it('texto com o link do tenant enviado com sucesso grava a prova com origem humano', async () => {
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: `Nosso aviso de privacidade: ${URL_PRIVACIDADE}` })
    const mid = (r.json() as { mensagemId: string }).mensagemId
    const avisos = await dono<{ origem: string; versao: string; mensagem_id: string }[]>`SELECT origem, versao, mensagem_id FROM aviso_privacidade WHERE tenant_id = ${T}`
    expect(avisos).toEqual([{ origem: 'humano', versao: 'v2', mensagem_id: mid }])
  })
  it('texto sem o aviso não grava nada', async () => {
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Bom dia!' })
    expect(await contar('aviso_privacidade')).toBe(0)
  })
})

describe('Copiloto sob demanda — só leitura', () => {
  it('o prazo do contrato é 20 s', () => { expect(PRAZO_COPILOTO_MS).toBe(20_000) })

  it('gera a sugestão e NADA vai ao cliente: sem mensagem, sessão, atendimento ou evento; só a decisão copiloto', async () => {
    await configurar('sombra')
    await doCliente('qual o prazo de entrega?')
    const antes = { msg: await contar('mensagem'), outbox: await contar('outbox') }
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`)
    expect(r.statusCode).toBe(200)
    const s = (r.json() as { sugestao: { origem: string; texto: string; decisaoId: string } }).sugestao
    expect(s.origem).toBe('copiloto')
    expect(s.texto.length).toBeGreaterThan(0)
    expect(await contar('mensagem')).toBe(antes.msg)
    expect(await contar('outbox')).toBe(antes.outbox)
    expect(await contar('agente_sessao')).toBe(0)
    expect(await contar('atendimento')).toBe(0)
    expect(enviadosAoCanal).toEqual([])
    const ds = await dono<{ modo: string; enviada: boolean; sessao_id: string | null }[]>`SELECT modo, enviada, sessao_id FROM agente_decisao WHERE tenant_id = ${T}`
    expect(ds).toEqual([{ modo: 'copiloto', enviada: false, sessao_id: null }])
    // E vira a sugestão vigente da conversa.
    expect(((await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: { decisaoId: string } }).sugestao.decisaoId).toBe(s.decisaoId)
  })

  it('agente desligado (kill switch) → 409 agente.desligado sem chamar o modelo', async () => {
    await configurar('desligado')
    let chamou = false
    const espiao: PortaLlmFerramentas = { ...llmQueDiz('x'), async rodar(e) { chamou = true; return llmQueDiz('x').rodar(e) } }
    const a = await appCom(espiao, 1000)
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)
    expect(r.statusCode).toBe(409)
    expect((r.json() as { erro: string }).erro).toBe('agente.desligado')
    expect(chamou).toBe(false)
    expect(await contar('agente_decisao')).toBe(0)
    const g = (await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { copilotoDisponivel: boolean; motivoIndisponivel: string }
    expect(g).toMatchObject({ copilotoDisponivel: false, motivoIndisponivel: 'agente.desligado' })
    await a.close()
  })

  it('modelo que não responde no prazo → 502 copiloto.indisponivel; nada enviado', async () => {
    const a = await appCom(llmLento(400), 50)
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)
    expect(r.statusCode).toBe(502)
    expect((r.json() as { erro: string }).erro).toBe('copiloto.indisponivel')
    // Uma segunda geração enquanto a primeira ainda roda é recusada (uma por conversa).
    expect(((await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)).json() as { erro: string }).erro).toBe('copiloto.em_andamento')
    await new Promise((res) => setTimeout(res, 500))
    expect(enviadosAoCanal).toEqual([])
    expect(await contar('agente_sessao')).toBe(0)
    await a.close()
  })

  it('modelo que falha → 502 copiloto.indisponivel', async () => {
    const a = await appCom(llmQueFalha, 1000)
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)
    expect(r.statusCode).toBe(502)
    expect((r.json() as { erro: string }).erro).toBe('copiloto.indisponivel')
    await a.close()
  })

  it('número sem agente configurado → 409 agente.sem_configuracao', async () => {
    await dono`DELETE FROM agente_config WHERE tenant_id = ${T}`
    expect(((await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`)).json() as { erro: string }).erro).toBe('agente.sem_configuracao')
    expect(((await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { motivoIndisponivel: string }).motivoIndisponivel).toBe('agente.sem_configuracao')
  })

  it('kill switch do TENANT (agente_tenant.modo_maximo desligado) → 409 agente.desligado sem chamar o modelo', async () => {
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'desligado')
               ON CONFLICT (tenant_id) DO UPDATE SET modo_maximo = 'desligado'`
    try {
      let chamou = false
      const a = await appCom({ ...llmQueDiz('x'), async rodar(e) { chamou = true; return llmQueDiz('x').rodar(e) } }, 1000)
      const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)
      expect(r.statusCode).toBe(409)
      expect((r.json() as { erro: string }).erro).toBe('agente.desligado')
      expect(chamou).toBe(false)
      await a.close()
    } finally {
      await dono`DELETE FROM agente_tenant WHERE tenant_id = ${T}`
    }
  })

  it('FORA DO RECORTE (cai para sombra): o copiloto continua disponível e gera', async () => {
    // Quarta, 12:00 em São Paulo; o recorte só vale domingo das 08:00 às 09:00.
    const QUARTA_MEIO_DIA = new Date('2026-10-14T15:00:00Z')
    await dono`UPDATE agente_config SET recorte = ${JSON.stringify({ horario: { dom: { de: '08:00', ate: '09:00' } }, segmentosRfv: [], foraDoRecorte: 'sombra' })}::text::jsonb
               WHERE tenant_id = ${T} AND canal_id = ${CANAL}`
    try {
      expect(await modoDoCopiloto(T, { canalId: CANAL, contatoId: CONTATO, configurado: true, agora: QUARTA_MEIO_DIA })).toBe('sombra')
      await doCliente('tem sabão neutro?')
      const a = await Fastify()
      await a.register(pluginTenant)
      await a.register(rotasSugestao, { copiloto: { llm: llmQueDiz('Temos sim! Quer que eu separe?'), prazoMs: 2000, agora: QUARTA_MEIO_DIA } })
      await a.ready()
      const g = (await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`, undefined, a)).json() as { modoAgente: string; copilotoDisponivel: boolean }
      expect(g).toMatchObject({ modoAgente: 'sombra', copilotoDisponivel: true })
      const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)
      expect(r.statusCode).toBe(200)
      expect((r.json() as { sugestao: { origem: string; texto: string } }).sugestao).toMatchObject({ origem: 'copiloto', texto: 'Temos sim! Quer que eu separe?' })
      await a.close()
    } finally {
      await dono`UPDATE agente_config SET recorte = NULL WHERE tenant_id = ${T} AND canal_id = ${CANAL}`
    }
  })

  it('teto diário do número atingido → 409 copiloto.sem_sugestao (orcamento_do_dia) com mensagem explícita', async () => {
    await dono`UPDATE agente_config SET orcamento_dia_centavos = 1 WHERE tenant_id = ${T} AND canal_id = ${CANAL}`
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, custo_centavos, criado_em)
               VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, ${CANAL}, 'assistido', 'silencio', 5, now())`
    try {
      let chamou = false
      const a = await appCom({ ...llmQueDiz('x'), async rodar(e) { chamou = true; return llmQueDiz('x').rodar(e) } }, 2000)
      const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)
      expect(r.statusCode).toBe(409)
      expect(r.json()).toMatchObject({ erro: 'copiloto.sem_sugestao', motivo: 'orcamento_do_dia', mensagem: expect.stringMatching(/Limite diário de IA deste número atingido/) })
      expect(chamou).toBe(false)
      await a.close()
    } finally {
      await dono`UPDATE agente_config SET orcamento_dia_centavos = NULL WHERE tenant_id = ${T} AND canal_id = ${CANAL}`
    }
  })
})

describe('Copiloto — concorrência, atraso e autoria', () => {
  it('quem pediu fica gravado: o pedinte vê "por mim"; outro vendedor vê o nome', async () => {
    await doCliente('tem sabão neutro?')
    await dono`INSERT INTO usuario (tenant_id, id, nome, email, cognito_sub) VALUES (${T}, ${crypto.randomUUID()}, 'Bia Vendas', 'bia@p13.test', 'sub-p13-bia') ON CONFLICT DO NOTHING`
    const a = await appCom(llmQueDiz('Temos sim!'), 2000)
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)
    expect((r.json() as { sugestao: { pedidaPor: { porMim: boolean } } }).sugestao.pedidaPor).toMatchObject({ porMim: true })
    // Outro vendedor (outro sub) abre a conversa.
    const [bia] = await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = ${T} AND cognito_sub = 'sub-p13-bia'`
    const [d] = await dono<{ id: string; pedida_por: string }[]>`SELECT id, sugestao_pedida_por AS pedida_por FROM agente_decisao WHERE tenant_id = ${T} AND modo = 'copiloto'`
    await dono`UPDATE agente_decisao SET sugestao_pedida_por = ${bia!.id} WHERE tenant_id = ${T} AND id = ${d!.id}`
    const g = (await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: { pedidaPor: unknown } }
    expect(g.sugestao.pedidaPor).toEqual({ nome: 'Bia Vendas', porMim: false })
    expect(d!.pedida_por).toBeTruthy()
    await a.close()
    await dono`DELETE FROM usuario WHERE tenant_id = ${T} AND cognito_sub = 'sub-p13-bia'`
  })

  it('concessão por conversa ENTRE instâncias: linha viva → em_andamento; linha expirada → assume', async () => {
    await dono`INSERT INTO copiloto_geracao (tenant_id, conversa_id, token, expira_em)
               VALUES (${T}, ${CONVERSA}, ${crypto.randomUUID()}, now() + interval '1 minute')`
    const a = await appCom(llmQueDiz('x'), 1000)
    expect((await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)).json()).toMatchObject({ erro: 'copiloto.em_andamento' })
    // Outra instância morreu no meio: a concessão expira e a próxima geração entra.
    await dono`UPDATE copiloto_geracao SET expira_em = now() - interval '1 second' WHERE tenant_id = ${T} AND conversa_id = ${CONVERSA}`
    expect((await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)).statusCode).toBe(200)
    // Terminou: a concessão some (DELETE pelo token).
    expect(await contar('copiloto_geracao')).toBe(0)
    await a.close()
  })

  it('N gerações paralelas com pool pequeno: só o teto do processo entra (503 copiloto.ocupado), nada trava e o inbox segue respondendo', async () => {
    const N = 7
    const conversas: string[] = []
    for (let i = 0; i < N; i++) {
      const contato = crypto.randomUUID(), conversa = crypto.randomUUID()
      await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${contato}, ${`Paralelo ${i}`}, true)`
      await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${conversa}, ${CANAL}, ${contato}, 1)`
      conversas.push(conversa)
    }
    expect(MAX_COPILOTOS_SIMULTANEOS).toBeLessThan(5) // abaixo do pool
    const a = await appCom(llmLento(400), 3000)
    const pedidos = conversas.map((c) => chamar(T, 'POST', `/v1/conversas/${c}/sugestao/gerar`, undefined, a))
    // Enquanto as gerações rodam, a instância continua atendendo leitura do inbox.
    await new Promise((res) => setTimeout(res, 100))
    const inicio = Date.now()
    const g = await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`, undefined, a)
    expect(g.statusCode).toBe(200)
    expect(Date.now() - inicio).toBeLessThan(1000)
    const rs = await Promise.all(pedidos)
    const ocupados = rs.filter((r) => r.statusCode === 503)
    expect(ocupados.length).toBe(N - MAX_COPILOTOS_SIMULTANEOS)
    expect(ocupados[0]!.json()).toMatchObject({ erro: 'copiloto.ocupado' })
    expect(rs.filter((r) => r.statusCode !== 503).length).toBe(MAX_COPILOTOS_SIMULTANEOS)
    await new Promise((res) => setTimeout(res, 200))
    expect(copilotosEmAndamento()).toBe(0)
    expect(await contar('copiloto_geracao')).toBe(0)
    await a.close()
    await dono`DELETE FROM agente_decisao WHERE tenant_id = ${T} AND conversa_id = ANY(${conversas}::uuid[])`
    await dono`DELETE FROM conversa WHERE tenant_id = ${T} AND id = ANY(${conversas}::uuid[])`
    await dono`DELETE FROM contato WHERE tenant_id = ${T} AND nome LIKE 'Paralelo %'`
  })

  it('copiloto ainda sem o carimbo de quem pediu não aparece no GET (ninguém lê "você pediu" por engano)', async () => {
    const d = await decisao({ modo: 'copiloto', mensagens: ['sugestão sem dono ainda'] })
    expect(((await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: unknown }).sugestao).toBeNull()
    const [u] = await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = ${T} LIMIT 1`
    if (u) {
      await dono`UPDATE agente_decisao SET sugestao_pedida_por = ${u.id} WHERE tenant_id = ${T} AND id = ${d}`
      expect(((await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: { decisaoId: string } }).sugestao.decisaoId).toBe(d)
    }
  })

  it('turno que termina DEPOIS do prazo publica agente.sugestao (só ids) e a sugestão aparece no GET', async () => {
    await doCliente('tem pronta entrega?')
    const a = await appCom(llmLento(200), 30)
    expect((await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)).statusCode).toBe(502)
    expect((await dono`SELECT 1 FROM outbox WHERE tenant_id = ${T} AND tipo = 'agente.sugestao'`).length).toBe(0)
    await new Promise((res) => setTimeout(res, 600))
    const evs = await dono<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox WHERE tenant_id = ${T} AND tipo = 'agente.sugestao'`
    expect(evs.length).toBe(1)
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['conversaId', 'decisaoId'])
    const g = (await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: { origem: string; texto: string } }
    expect(g.sugestao).toMatchObject({ origem: 'copiloto', texto: 'tarde demais' })
    await a.close()
  })

  // Revisão P13 (MÉDIA), fechada pela P17: `memoria_anotar` não grava em simulação nem no copiloto.
  it('[P17] copiloto não grava memória do cliente mesmo se o modelo chamar memoria_anotar', async () => {
    await doCliente('prefiro pagar no boleto')
    const anotador: PortaLlmFerramentas = { nome: 'anotador', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
      async rodar(e): Promise<ResultadoLaco> {
        await e.executar('memoria_anotar', { tipo: 'preferencia', fato: 'prefere boleto' })
        return llmQueDiz('Anotado! Posso montar o pedido?').rodar(e)
      } }
    const antes = await contar('cliente_memoria')
    const a = await appCom(anotador, 2000)
    expect((await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`, undefined, a)).statusCode).toBe(200)
    expect(await contar('cliente_memoria')).toBe(antes)
    await a.close()
  })
})

describe('Aviso de privacidade na legenda de imagem (P4)', () => {
  it('imagem com legenda contendo o link do tenant grava a prova com origem humano', async () => {
    const r = await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'imagem', imagem: 'https://exemplo.test/catalogo.png', legenda: `Catálogo e privacidade: ${URL_PRIVACIDADE}` })
    expect(r.statusCode).toBe(200)
    const mid = (r.json() as { mensagemId: string }).mensagemId
    expect(await dono`SELECT origem FROM aviso_privacidade WHERE tenant_id = ${T} AND mensagem_id = ${mid}`).toEqual([{ origem: 'humano' }])
  })
})

describe('Métricas vêm do banco', () => {
  it('conta geradas, enviadas, editadas, descartadas, superadas, CRÍTICA e sombra × humano', async () => {
    const enviada = await decisao({ modo: 'assistido', mensagens: ['a b c palavra'] })
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'a b c palavra', sugestaoDecisaoId: enviada })
    const editada = await decisao({ modo: 'assistido', mensagens: ['Temos caixa com doze unidades'] })
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Temos caixa com dez unidades', sugestaoDecisaoId: editada })
    const descartada = await decisao({ modo: 'assistido', mensagens: ['xx'], guardrails: [{ etapa: 'f', codigo: 'oferece_desconto', gravidade: 'CRITICA', acao: 'removido' }] })
    await chamar(T, 'POST', `/v1/agente/sugestoes/${descartada}/descartar`)
    await decisao({ modo: 'assistido', mensagens: ['pendente'] })
    await decisao({ modo: 'copiloto', mensagens: ['do copiloto'] })
    await decisao({ modo: 'sombra', mensagens: ['Entrega em três dias úteis'], mensagensIds: [await doCliente('qual o prazo?')] })
    await chamar(T, 'POST', `/v1/conversas/${CONVERSA}/mensagens`, { tipo: 'texto', texto: 'Entrega em três dias úteis' })
    await decisao({ modo: 'assistido', mensagens: ['ainda pendente'] })

    const m = (await chamar(T, 'GET', '/v1/agente/sugestoes/metricas?dias=7')).json() as {
      assistido: Record<string, number | null>; copiloto: Record<string, number | null>; sombra: Record<string, number | null>
    }
    expect(m.assistido).toMatchObject({ geradas: 5, enviadas: 1, editadas: 1, descartadas: 1, superadas: 1, pendentes: 1, criticas: 1, taxaUso: 0.4, taxaSemEdicao: 0.5 })
    expect(m.assistido['similaridadeMediaEditadas']).toBeGreaterThan(0)
    expect(m.copiloto).toMatchObject({ geradas: 1, superadas: 1 })
    expect(m.sombra).toMatchObject({ comparados: 1, acimaDoLimiar: 1, taxaAcimaDoLimiar: 1, limiar: 0.6 })
    // Por canal: o do outro tenant não existe aqui → zero.
    expect(((await chamar(T, 'GET', `/v1/agente/sugestoes/metricas?canalId=${CANAL_B}`)).json() as { assistido: { geradas: number } }).assistido.geradas).toBe(0)
  })
})

describe('Isolamento entre tenants (RLS)', () => {
  it('tenant B não lê nem decide a sugestão do tenant A; métricas de B não veem A', async () => {
    const d = await decisao({ modo: 'assistido', mensagens: ['segredo do A'] })
    expect((await chamar(OUTRO, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'POST', `/v1/agente/sugestoes/${d}/descartar`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'POST', `/v1/conversas/${CONVERSA}/sugestao/gerar`)).statusCode).toBe(404)
    expect(((await chamar(OUTRO, 'GET', '/v1/agente/sugestoes/metricas')).json() as { assistido: { geradas: number } }).assistido.geradas).toBe(0)
    // Envio no tenant B citando a decisão de A: a mensagem segue, a decisão de A não muda.
    const r = await chamar(OUTRO, 'POST', `/v1/conversas/${CONVERSA_B}/mensagens`, { tipo: 'texto', texto: 'segredo do A', sugestaoDecisaoId: d })
    expect((r.json() as { sugestao: unknown }).sugestao).toEqual({ registrada: false, motivo: 'nao_encontrada' })
    expect((await linha(d)).sugestao_estado).toBeNull()
    // Sob o papel da aplicação com o tenant B: nem enxerga, nem altera.
    expect((await appComoB`SELECT id FROM agente_decisao WHERE id = ${d}`).length).toBe(0)
    expect((await appComoB`UPDATE agente_decisao SET sugestao_estado = 'descartada', sugestao_usada_em = now() WHERE id = ${d}`).count).toBe(0)
    expect((await linha(d)).sugestao_estado).toBeNull()
  })
})

describe('Tempo real: agente.sugestao sem conteúdo', () => {
  it('o evento do turno assistido e o do descarte levam só ids; a aba recebe só tipo e conversa', async () => {
    const id = await doCliente('tem pronta entrega?')
    await conduzirTurnoVendedor(
      { tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [id], tentativas: 1, executar_em: new Date() },
      { llm: llmQueDiz('Temos pronta entrega do sabão neutro, conteúdo secreto.'), ligacoes },
    )
    const s = ((await chamar(T, 'GET', `/v1/conversas/${CONVERSA}/sugestao`)).json() as { sugestao: { decisaoId: string } }).sugestao
    await chamar(T, 'POST', `/v1/agente/sugestoes/${s.decisaoId}/descartar`)
    const evs = await dono<{ payload: Record<string, unknown> }[]>`SELECT payload FROM outbox WHERE tenant_id = ${T} AND tipo = 'agente.sugestao'`
    expect(evs.length).toBe(2)
    for (const e of evs) {
      expect(Object.keys(e.payload).sort()).toEqual(['conversaId', 'decisaoId'])
      expect(JSON.stringify(e.payload)).not.toMatch(/secreto|sabão/)
    }
    const recebidos: unknown[] = []
    const sair = assinar(T, (ev) => recebidos.push(ev))
    const deB: unknown[] = []
    const sairB = assinar(OUTRO, (ev) => deB.push(ev))
    despacharParaTeste({ tenantId: T, id: 1, tipo: 'agente.sugestao', conversaId: CONVERSA })
    sair(); sairB()
    expect(recebidos).toEqual([{ id: 1, tipo: 'agente.sugestao', conversaId: CONVERSA }])
    expect(deB).toEqual([])
  })
})
