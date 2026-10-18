import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../../db/index.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { etapaModoEfetivo, lerFatosDoModo, modoEfetivoDoCanal, modoEfetivoSeguro, MOTIVO_MODO_INDISPONIVEL } from './modo-efetivo.js'
import { responderAutomaticamente } from '../../resposta-automatica.js'
import { partesLocais } from '../../expediente.js'

/**
 * O MODO EFETIVO num TURNO REAL (raia P14, ADR-028): banco de verdade, WhatsApp
 * falso. Prova que o recorte e o teto do tenant mudam o que o agente FAZ — e que
 * o porquê fica gravado na decisão como marca `modo-efetivo`.
 */
const T = 'c14e0000-0000-4000-8000-000000000001'
const OUTRO = 'c14e0000-0000-4000-8000-000000000002'
const PV = 'c14e0000-1111-4000-8000-000000000001'
const PV2 = 'c14e0000-1111-4000-8000-000000000002'
const PLANO = 'c14e0000-3333-4000-8000-000000000001'
const MODELO = 'c14e0000-4444-4000-8000-000000000001'
const CANAL = 'c14e0000-5555-4000-8000-000000000001'
const CONTATO = 'c14e0000-6666-4000-8000-000000000001'
const CONVERSA = 'c14e0000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'] as const

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })
let chamadasLlm = 0
const llm: PortaLlmFerramentas = { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
  async rodar(): Promise<ResultadoLaco> {
    chamadasLlm++
    return { ok: true, saida: { mensagens: ['Temos sim!'], confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
  } }

const configurar = (modo: string, recorte: unknown) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, recorte)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false, '{"nome":"Lia","loja":"Loja P14"}'::jsonb, '{}'::jsonb,
          ${recorte === null ? null : JSON.stringify(recorte)}::text::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo, recorte = EXCLUDED.recorte`

/** Um horário de recorte que NÃO inclui o dia de hoje no fuso do tenant: o turno de agora está fora. */
/**
 * ⚠️ P0e: "hoje" pelo relógio do PROCESSO — o `agora` que o modo efetivo recebe. Pelo `now()` do
 * contêiner, um relógio horas (ou 15 min, perto da meia-noite) fora do host escolhia o dia errado.
 */
const hojeLocal = () => partesLocais(new Date(), 'America/Sao_Paulo')

async function horarioSemHoje(): Promise<Record<string, { de: string; ate: string }>> {
  const amanha = DIAS[(hojeLocal().diaIso % 7)]!
  return { [amanha]: { de: '00:00', ate: '23:59' } }
}

const tarefa = async (texto: string): Promise<Tarefa> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return { tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [id], tentativas: 1, executar_em: new Date() }
}
const turno = async (texto: string) => conduzirTurnoVendedor(await tarefa(texto), { llm, ligacoes, enviar: enviarFalso })
const ultimaDecisao = async () => (await dono<{ desfecho: string; modo: string; enviada: boolean; portao_motivo: string | null; guardrails: { etapa: string; codigo: string; gravidade: string; acao: string }[] }[]>`
  SELECT desfecho, modo, enviada, portao_motivo, guardrails FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-p14', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-p14', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'P14'], [OUTRO, PV2, 'P14 outro']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`UPDATE tenant SET fuso = 'America/Sao_Paulo' WHERE id IN (${T}, ${OUTRO})`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente P14', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999991414', '5585999991414', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0; chamadasLlm = 0
  await dono`UPDATE tenant SET fuso = 'America/Sao_Paulo' WHERE id = ${T}`
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem', 'agente_tenant']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${T}', '${OUTRO}')`)
  }
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'agente_tenant', 'notificacao', 'atendimento', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${T}', '${OUTRO}')`)
  }
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Turno real com recorte (ADR-028)', () => {
  it('sem recorte e sem teto: autônomo responde e não grava marca de modo', async () => {
    await configurar('autonomo', null)
    const r = await turno('oi')
    expect(r.desfecho).toBe('respondeu')
    expect(enviados).toContain('Temos sim!')
    expect((await ultimaDecisao()).guardrails.filter((g) => g.etapa === 'modo-efetivo')).toEqual([])
  })

  it('fora do horário do recorte: cai para sombra (padrão), não envia e a marca fica na decisão', async () => {
    await configurar('autonomo', { horario: await horarioSemHoje() })
    const r = await turno('oi, tem caixa?')
    expect(r.desfecho).toBe('sugeriu')
    expect(enviados).toEqual([])
    const d = await ultimaDecisao()
    expect(d).toMatchObject({ modo: 'sombra', enviada: false })
    expect(d.guardrails).toContainEqual({ etapa: 'modo-efetivo', codigo: 'fora_do_recorte_horario', gravidade: 'INFO', acao: 'registrado' })
  })

  it('fora do recorte com foraDoRecorte = desligado: o portão cala sem chamar o modelo', async () => {
    await configurar('autonomo', { horario: await horarioSemHoje(), foraDoRecorte: 'desligado' })
    const r = await turno('oi')
    expect(r).toMatchObject({ desfecho: 'silencio' })
    expect(chamadasLlm).toBe(0)
    const d = await ultimaDecisao()
    expect(d).toMatchObject({ modo: 'desligado', portao_motivo: 'agente_desligado' })
    expect(d.guardrails.map((g) => g.codigo)).toEqual(['fora_do_recorte_horario'])
  })

  it('FERIADO do número (calendário da P11) conta como fora do horário do recorte', async () => {
    const l = { dia: hojeLocal().diaIso, data: hojeLocal().data }
    const hoje = DIAS[l.dia - 1]!
    // O horário do recorte cobre hoje o dia todo; só o feriado o derruba.
    await configurar('autonomo', { horario: { [hoje]: { de: '00:00', ate: '23:59' } } })
    await dono`UPDATE canal_configuracao SET feriados = ${JSON.stringify([l.data])}::text::jsonb WHERE tenant_id = ${T} AND canal_id = ${CANAL}`
    try {
      const d = await comTenantServico(T, (tx) => modoEfetivoDoCanal(tx, { canalId: CANAL, contatoId: CONTATO, agora: new Date() }))
      expect(d).toMatchObject({ modo: 'sombra', motivo: 'fora_do_recorte_horario' })
    } finally {
      await dono`UPDATE canal_configuracao SET feriados = '[]'::jsonb WHERE tenant_id = ${T} AND canal_id = ${CANAL}`
    }
    // Sem o feriado, o mesmo recorte deixa autônomo (exceto no último minuto do dia).
    const sem = await comTenantServico(T, (tx) => modoEfetivoDoCanal(tx, { canalId: CANAL, contatoId: CONTATO, agora: new Date() }))
    if (new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo' }) < '23:59') expect(sem.modo).toBe('autonomo')
  })

  it('segmento: lead sem compra fica fora de um recorte só de clientes em dia', async () => {
    await configurar('autonomo', { segmentosRfv: ['cliente-fiel'] })
    await turno('oi')
    const d = await ultimaDecisao()
    expect(d.modo).toBe('sombra')
    expect(d.guardrails.map((g) => g.codigo)).toContain('fora_do_recorte_segmento')
  })

  it('segmento liberado (sem-historico): vale o modo do número', async () => {
    await configurar('autonomo', { segmentosRfv: ['sem-historico'] })
    await turno('oi')
    expect(enviados).toContain('Temos sim!')
  })

  it('teto do tenant em desligado é kill switch: nenhum número fala', async () => {
    await configurar('autonomo', null)
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'desligado')`
    const r = await turno('oi')
    expect(r.desfecho).toBe('silencio')
    expect(chamadasLlm).toBe(0)
    const d = await ultimaDecisao()
    expect(d).toMatchObject({ modo: 'desligado', portao_motivo: 'agente_desligado' })
    expect(d.guardrails.map((g) => g.codigo)).toEqual(['teto_do_tenant'])
  })

  it('o teto de UM tenant não vale para o outro (RLS)', async () => {
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'desligado')`
    const doOutro = await comTenantServico(OUTRO, (tx) => lerFatosDoModo(tx, new Date()))
    expect(doOutro.modoTenant).toBeNull()
    const doDono = await comTenantServico(T, (tx) => lerFatosDoModo(tx, new Date()))
    expect(doDono.modoTenant).toBe('desligado')
    // Leitura direta sob o papel da aplicação, no outro tenant: a linha não existe.
    const linhas = await comTenantServico(OUTRO, (tx) => tx`SELECT tenant_id FROM agente_tenant`)
    expect(linhas).toHaveLength(0)
    const decisao = await etapaModoEfetivo.decidir({ tenantId: OUTRO, canalId: CANAL, contatoId: CONTATO, modoDoNumero: 'autonomo', cfgExtra: {}, agora: new Date() })
    expect(decisao).toEqual({ modo: 'autonomo', motivo: null })
  })
})

/**
 * CONTRATO de `modoEfetivoDoCanal` — o que retorno.ts (P11) e o copiloto (P13)
 * devem perguntar em vez de ler `agente_config.modo`. Espelhe estes casos.
 */
describe('modoEfetivoDoCanal(tx, { canalId, contatoId?, agora })', () => {
  const doCanal = (contatoId?: string) => comTenantServico(T, (tx) => modoEfetivoDoCanal(tx, { canalId: CANAL, contatoId, agora: new Date() }))

  it('sem teto e sem recorte: o modo do número', async () => {
    await configurar('autonomo', null)
    expect(await doCanal(CONTATO)).toMatchObject({ modo: 'autonomo', modoDoNumero: 'autonomo', origem: 'numero', motivo: null })
  })
  it('kill switch do tenant: desligado, origem tenant', async () => {
    await configurar('autonomo', null)
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'desligado')`
    expect(await doCanal(CONTATO)).toMatchObject({ modo: 'desligado', modoDoNumero: 'autonomo', origem: 'tenant', motivo: 'teto_do_tenant' })
  })
  it('fora do horário do recorte: cai, mesmo sem contato', async () => {
    await configurar('autonomo', { horario: await horarioSemHoje() })
    expect(await doCanal()).toMatchObject({ modo: 'sombra', origem: 'recorte', motivo: 'fora_do_recorte_horario' })
  })
  it('recorte por segmento: com contato avalia; sem contato a parte de segmento não é avaliada', async () => {
    await configurar('autonomo', { segmentosRfv: ['cliente-fiel'] })
    expect(await doCanal(CONTATO)).toMatchObject({ modo: 'sombra', motivo: 'fora_do_recorte_segmento' })
    expect(await doCanal()).toMatchObject({ modo: 'autonomo', motivo: null })
  })
  it('número sem configuração: desligado', async () => {
    const outroCanal = await comTenantServico(T, (tx) => modoEfetivoDoCanal(tx, { canalId: crypto.randomUUID(), agora: new Date() }))
    expect(outroCanal).toMatchObject({ modo: 'desligado', modoDoNumero: 'desligado' })
  })
  it('copiloto sob kill switch: modoEfetivoSeguro diz desligado (quem gera sugestão deve calar e não chamar o LLM)', async () => {
    await configurar('assistido', null)
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'desligado')`
    expect(await modoEfetivoSeguro(T, { canalId: CANAL, contatoId: CONTATO, agora: new Date() })).toEqual({ modo: 'desligado', motivo: 'teto_do_tenant' })
  })
})

describe('Falha fechada', () => {
  it('etapa: sem conseguir ler os fatos, cai para sombra com motivo modo_efetivo_indisponivel', async () => {
    const quebrado = { tenantId: 'nao-e-uuid', canalId: CANAL, contatoId: CONTATO, cfgExtra: {}, agora: new Date() }
    expect(await etapaModoEfetivo.decidir({ ...quebrado, modoDoNumero: 'autonomo' })).toEqual({ modo: 'sombra', motivo: MOTIVO_MODO_INDISPONIVEL })
    expect(await etapaModoEfetivo.decidir({ ...quebrado, modoDoNumero: 'assistido' })).toEqual({ modo: 'sombra', motivo: MOTIVO_MODO_INDISPONIVEL })
  })
  it('modoEfetivoSeguro: idem', async () => {
    expect(await modoEfetivoSeguro('nao-e-uuid', { canalId: CANAL, agora: new Date() })).toEqual({ modo: 'sombra', motivo: MOTIVO_MODO_INDISPONIVEL })
  })
})

describe('Fuso inválido no banco', () => {
  it('o turno não quebra (cai no fuso padrão) e o recorte segue valendo', async () => {
    await dono`UPDATE tenant SET fuso = 'Marte/Olympus' WHERE id = ${T}`
    await configurar('autonomo', null)
    const r = await turno('oi')
    expect(r.desfecho).toBe('respondeu')
    const fatos = await comTenantServico(T, (tx) => lerFatosDoModo(tx, new Date()))
    expect(fatos.momento.hora).toMatch(/^\d{2}:\d{2}$/)
  })
})

/**
 * A AUSÊNCIA segue o modo EFETIVO (resposta-automatica.ts): o agente só "toma a
 * vez" da ausência quando vai mesmo responder. ⚠️ Sem rede: uma ausência recente
 * na conversa faz o desfecho ser `ja_respondida` — prova que passou pela ausência.
 */
describe('Ausência sob o modo efetivo', () => {
  const ausenciaRecente = () => dono`
    INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
    VALUES (${T}, ${crypto.randomUUID()}, ${CONVERSA}, 'saliente', 'texto', '{"texto":"Voltamos já","automatica":"ausencia"}'::jsonb, ${new Date(Date.now() - 60_000)})`
  beforeAll(async () => { await dono`UPDATE canal_configuracao SET mensagem_ausencia = 'Voltamos já' WHERE tenant_id = ${T} AND canal_id = ${CANAL}` })

  it('autônomo sem esperar a ausência: o agente responde (a ausência não sai)', async () => {
    await configurar('autonomo', null)
    await ausenciaRecente()
    expect((await responderAutomaticamente(T, CONVERSA, CANAL)).ausencia).toBe('agente_responde')
  })
  it('kill switch do tenant: a ausência sai', async () => {
    await configurar('autonomo', null)
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'desligado')`
    await ausenciaRecente()
    const r = await responderAutomaticamente(T, CONVERSA, CANAL)
    expect(r.ausencia).toBe('ja_respondida')
    expect(r.agenteMotivo).toBe('agente_desligado')
  })
  it('fora do recorte: a ausência sai', async () => {
    await configurar('autonomo', { horario: await horarioSemHoje() })
    await ausenciaRecente()
    expect((await responderAutomaticamente(T, CONVERSA, CANAL)).ausencia).toBe('ja_respondida')
  })
})
