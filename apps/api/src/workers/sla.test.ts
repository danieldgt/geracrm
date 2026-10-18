import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { SLA_PADRAO, TEXTO_AVISO_ESPERA, TEXTO_AVISO_ESPERA_FORA, playbookPadrao, type ConteudoPlaybook } from '@geracrm/shared'
import { criarApp } from '../app.js'
import { comTenantServico, encerrarBanco } from '../db/index.js'
import { entregarParaHumano } from '../contexts/atendimento/agente/handoff.js'
import { notificarMensagemEntrante } from '../contexts/atendimento/notificacao.js'
import type { enviarTextoNaConversa } from '../contexts/atendimento/envio-conversa.js'
import { processarSla, textoDaEspera } from './sla.js'

/**
 * SLA DO HANDOFF (raia P18, ADR-034) — banco real, dois tenants.
 *
 *   - o handoff ARMA o SLA (minutos úteis) e ROTEIA (dono da carteira → pool → gestor);
 *   - o worker: estouro com UMA notificação por gestor + alerta; 2º limiar libera a
 *     reatribuição; UMA mensagem de espera (idempotente); nunca com humano já
 *     respondendo, opt-out, janela fechada, conversa com o agente ou aviso desligado;
 *   - assumir: reservado ao responsável até a liberação; gestão assume sempre;
 *     depois do limiar, qualquer um (e reatribui de quem não respondeu);
 *   - fila/kanban mostram o handoff com o SLA; performance mede "SLA cumprido";
 *   - configuração por número: GET padrão, PUT só admin, auditado, 422 nomeado;
 *   - RLS: o outro tenant não vê config nem cronômetro.
 */
const A = 'c18a0000-0000-4000-8000-000000000001'
const B = 'c18a0000-0000-4000-8000-000000000002'
const PV_A = 'c18a0000-1111-4000-8000-000000000001'
const PV_B = 'c18a0000-1111-4000-8000-000000000002'
const PLANO = 'c18a0000-3333-4000-8000-000000000001'
const MODELO = 'c18a0000-4444-4000-8000-000000000001'
const OFICIAL = 'c18a0000-5555-4000-8000-000000000001'
const NAO_OFICIAL = 'c18a0000-5555-4000-8000-000000000002'
const CANAL_B = 'c18a0000-5555-4000-8000-000000000003'
const EU = 'c18a0000-6666-4000-8000-000000000001' // o usuário do header de dev (sub "dev-<A>")
const ANA = 'c18a0000-6666-4000-8000-000000000002'
const BIA = 'c18a0000-6666-4000-8000-000000000003'
const GESTOR = 'c18a0000-6666-4000-8000-000000000004'
const DONO_CARTEIRA = 'c18a0000-6666-4000-8000-000000000005'
const ADM = 'c18a0000-6666-4000-8000-000000000006'
const EU_B = 'c18a0000-6666-4000-8000-000000000007'
const FILIAL = 'c18a0000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const enviados: { conversaId: string; texto: string; marcador?: string | undefined }[] = []
let recusaDoGateway: string | null = null
let explodirEm: string | null = null
const enviarFalso: typeof enviarTextoNaConversa = async (_t, conversaId, texto, _r, _a, op = {}) => {
  enviados.push({ conversaId, texto, marcador: op.marcador })
  if (explodirEm === conversaId) throw new Error('rede caiu')
  if (recusaDoGateway) return { ok: false, classe: 'recusa', motivo: recusaDoGateway, conversaId }
  return { ok: true, conversaId, mensagemId: randomUUID() }
}
const min = (n: number, base: Date) => new Date(base.getTime() + n * 60_000)
const passada = (agora: Date, t = A) => processarSla(dono as never, { somenteTenant: t, enviar: enviarFalso }, agora)
const pedir = (metodo: 'GET' | 'PUT' | 'POST', url: string, tenant = A, payload?: object) =>
  app.inject({ method: metodo, url, headers: { 'x-tenant-id': tenant }, ...(payload ? { payload } : {}) })

/**
 * Uma conversa nova (um contato por conversa) no canal, com a última entrante há `entranteHaMin`.
 * ⚠️ P0e: pelo relógio do PROCESSO — a janela de 24h é medida contra o `agora` da passada.
 */
async function novaConversa(p: { canal?: string; tenant?: string; entranteHaMin?: number; conduzida?: 'humano' | 'ia'; dono?: string; origem?: string } = {}) {
  const t = p.tenant ?? A
  const contato = randomUUID(), conversa = randomUUID()
  const fone = `55859${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo, origem_carga) VALUES (${t}, ${contato}, 'Cliente Sla', true, ${p.origem ?? null})`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${t}, ${contato}, 1, ${fone}, ${fone}, true, true, 'teste')`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, conduzida_por, ultima_entrante_em, ultima_direcao, ultima_mensagem_em)
             VALUES (${t}, ${conversa}, ${p.canal ?? NAO_OFICIAL}, ${contato}, 1, ${p.conduzida ?? 'ia'},
                     ${new Date(Date.now() - (p.entranteHaMin ?? 1) * 60_000)}, 'entrante', ${new Date()})`
  if (p.dono) {
    await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, origem) VALUES (${t}, ${randomUUID()}, ${contato}, ${p.dono}, 'manual')`
  }
  return { conversa, contato, fone }
}

/** O agente transfere: atendimento na fila + SLA armado. */
async function handoff(conversa: string, agora: Date, canal = NAO_OFICIAL, t = A) {
  return comTenantServico(t, (tx) => entregarParaHumano(tx, { conversaId: conversa, canalId: canal, sessaoId: null, motivo: 'pedido_humano', resumo: 'quer falar com gente', agora }))
}
const atendimentoDe = async (conversa: string) => (await dono<{
  id: string; sla_inicio_em: Date; sla_vence_em: Date; reatribuicao_vence_em: Date; aviso_espera_previsto_em: Date
  sla_estourado_em: Date | null; reatribuicao_liberada_em: Date | null; aviso_espera_em: Date | null
  aviso_espera_resultado: string | null; sla_respondido_em: Date | null; responsavel_id: string | null
  atendente_id: string | null; estado: string
}[]>`SELECT * FROM atendimento WHERE conversa_id = ${conversa}`)[0]!
const notificacoes = (conversa: string, tipo: string) => dono<{ usuario_id: string; vezes: number }[]>`
  SELECT usuario_id, vezes FROM notificacao WHERE conversa_id = ${conversa} AND tipo = ${tipo} ORDER BY usuario_id`
/** ⚠️ Uma pendência por (usuário, conversa): o aviso do SLA REESCREVE o título da que já existe (e soma `vezes`). */
const avisosCom = (conversa: string, trecho: string) => dono<{ usuario_id: string }[]>`
  SELECT usuario_id FROM notificacao WHERE conversa_id = ${conversa} AND titulo LIKE ${'%' + trecho + '%'} ORDER BY usuario_id`
const vezesDe = async (conversa: string, usuario: string) =>
  (await dono<{ vezes: number }[]>`SELECT vezes FROM notificacao WHERE conversa_id = ${conversa} AND usuario_id = ${usuario}`)[0]?.vezes

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-p18', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-p18', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, 'P18', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${A}, ${OFICIAL}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado'),
                    (${A}, ${NAO_OFICIAL}, 'whatsapp_nao_oficial', 'plugzapi', 'Loja', 'conectado'),
                    (${B}, ${CANAL_B}, 'whatsapp_nao_oficial', 'plugzapi', 'Loja B', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${A}, ${FILIAL}, 'Matriz') ON CONFLICT DO NOTHING`
  for (const [id, sub, nome] of [[EU, `dev-${A}`, 'Eu'], [ANA, 'sub-p18-ana', 'Ana'], [BIA, 'sub-p18-bia', 'Bia'],
    [GESTOR, 'sub-p18-gestor', 'Gil'], [DONO_CARTEIRA, 'sub-p18-dono', 'Dora'], [ADM, 'sub-p18-adm', 'Adm']] as const) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${id}, ${sub}, ${nome}, ${sub + '@p18.test'}) ON CONFLICT DO NOTHING`
  }
  // B: o usuário do header de dev existe (modo fundador = admin) — a recusa em B é de RLS (404), não de papel.
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${B}, ${EU_B}, ${`dev-${B}`}, 'Eu B', 'eub@p18.test') ON CONFLICT DO NOTHING`
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  enviados.length = 0; recusaDoGateway = null; explodirEm = null
  for (const t of ['notificacao', 'alerta', 'auditoria', 'atendimento_evento', 'atendimento_etapa_historico', 'mensagem',
    'agente_decisao', 'atendimento', 'carteira_atribuicao', 'conversa', 'contato_telefone', 'contato', 'lista_bloqueio', 'usuario_canal',
    'usuario_filial', 'atendimento_sla_config', 'canal_configuracao', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  }
  await dono`UPDATE usuario SET ativo = true, ausente = false WHERE tenant_id = ${A}`
  // Gestão declarada: Gil é gestor, Adm é admin (encerra o modo fundador); EU sou vendedor.
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel)
             VALUES (${A}, ${GESTOR}, NULL, 'gestor'), (${A}, ${ADM}, NULL, 'admin'), (${A}, ${EU}, NULL, 'vendedor')`
})

afterAll(async () => {
  for (const t of ['notificacao', 'alerta', 'auditoria', 'atendimento_evento', 'atendimento_etapa_historico', 'mensagem', 'agente_decisao', 'atendimento',
    'carteira_atribuicao', 'conversa', 'contato_telefone', 'contato', 'lista_bloqueio', 'usuario_canal', 'usuario_filial',
    'atendimento_sla_config', 'canal_configuracao', 'outbox', 'atendimento_etapa', 'agente_config', 'canal_conectado', 'usuario', 'filial']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  }
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('handoff arma o SLA e roteia', () => {
  it('sem horário: vence em 30 min, reatribuição em 60, espera devida no SLA; conversa vai para humano', async () => {
    const { conversa } = await novaConversa()
    const t0 = new Date()
    await handoff(conversa, t0)
    const a = await atendimentoDe(conversa)
    expect(a.estado).toBe('na_fila')
    expect(a.sla_inicio_em.toISOString()).toBe(t0.toISOString())
    expect(a.sla_vence_em.toISOString()).toBe(min(SLA_PADRAO.slaMinutos, t0).toISOString())
    expect(a.reatribuicao_vence_em.toISOString()).toBe(min(SLA_PADRAO.reatribuicaoMinutos, t0).toISOString())
    expect(a.aviso_espera_previsto_em.toISOString()).toBe(a.sla_vence_em.toISOString())
  })

  it('fora do expediente: vence na próxima abertura + limiar; a espera é devida antes, em minutos de parede', async () => {
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento)
               VALUES (${A}, ${NAO_OFICIAL}, ${JSON.stringify({ seg: { de: '08:00', ate: '18:00' } })}::text::jsonb)`
    const { conversa } = await novaConversa()
    const t0 = new Date('2026-10-19T23:00:00Z') // segunda 20:00 em SP, fechado
    await handoff(conversa, t0)
    const a = await atendimentoDe(conversa)
    expect(a.sla_vence_em.toISOString()).toBe('2026-10-26T11:30:00.000Z') // próxima segunda 08:30 SP
    expect(a.aviso_espera_previsto_em.toISOString()).toBe(min(30, t0).toISOString())
  })

  it('roteia ao dono da carteira ativo; ausente cai no pool em rodízio; sem pool, no gestor', async () => {
    const c1 = await novaConversa({ dono: DONO_CARTEIRA })
    await handoff(c1.conversa, new Date())
    expect((await atendimentoDe(c1.conversa)).responsavel_id).toBe(DONO_CARTEIRA)
    // A notificação do handoff vai SÓ ao responsável.
    expect((await notificacoes(c1.conversa, 'agente.handoff')).map((n) => n.usuario_id)).toEqual([DONO_CARTEIRA])

    await dono`UPDATE usuario SET ausente = true WHERE id = ${DONO_CARTEIRA}`
    await dono`INSERT INTO usuario_canal (tenant_id, usuario_id, canal_id) VALUES (${A}, ${ANA}, ${NAO_OFICIAL}), (${A}, ${BIA}, ${NAO_OFICIAL})`
    const c2 = await novaConversa({ dono: DONO_CARTEIRA })
    await handoff(c2.conversa, new Date(Date.now() + 1000))
    const c3 = await novaConversa()
    await handoff(c3.conversa, new Date(Date.now() + 2000))
    const c4 = await novaConversa()
    await handoff(c4.conversa, new Date(Date.now() + 3000))
    const r = [await atendimentoDe(c2.conversa), await atendimentoDe(c3.conversa), await atendimentoDe(c4.conversa)].map((a) => a.responsavel_id)
    expect(r).toEqual([ANA, BIA, ANA]) // rodízio por id

    await dono`DELETE FROM usuario_canal WHERE tenant_id = ${A}`
    const c5 = await novaConversa()
    await handoff(c5.conversa, new Date())
    expect((await atendimentoDe(c5.conversa)).responsavel_id).toBe(GESTOR)
    // Rota 'gestor' (tenant sem usuario_canal): o aviso vai a TODOS os gestores, não a um só.
    expect((await notificacoes(c5.conversa, 'agente.handoff')).map((n) => n.usuario_id)).toEqual([GESTOR, ADM].sort())
  })
})

describe('worker do SLA', () => {
  it('antes do prazo não faz nada', async () => {
    const { conversa } = await novaConversa({ conduzida: 'humano' })
    const t0 = new Date()
    await handoff(conversa, t0)
    const r = await passada(min(29, t0))
    expect(r.processadas).toBe(0)
    expect(enviados).toEqual([])
  })

  it('no SLA: estoura, notifica o gestor UMA vez, abre alerta e manda UMA mensagem de espera — idempotente', async () => {
    const { conversa } = await novaConversa()
    const t0 = new Date()
    await handoff(conversa, t0)
    const r1 = await passada(min(31, t0))
    expect(r1).toMatchObject({ estourados: 1, liberados: 0, avisos: { enviada: 1 } })
    expect(enviados).toEqual([{ conversaId: conversa, texto: TEXTO_AVISO_ESPERA, marcador: 'sla_aviso_espera' }])
    const a = await atendimentoDe(conversa)
    expect(a.sla_estourado_em).not.toBeNull()
    expect(a.aviso_espera_resultado).toBe('enviada')
    // Gestores (gestor e admin) avisados; Gil já tinha a pendência do handoff (era o responsável): o título troca.
    expect((await avisosCom(conversa, 'SLA do atendimento estourado')).map((n) => n.usuario_id)).toEqual([GESTOR, ADM].sort())
    const vezesGil = await vezesDe(conversa, GESTOR)
    const vezesAdm = await vezesDe(conversa, ADM)
    const [al] = await dono<{ mensagem: string }[]>`SELECT mensagem FROM alerta WHERE tenant_id = ${A} AND tipo = 'sla_handoff_estourado' AND resolvido_em IS NULL`
    expect(al!.mensagem).toMatch(/^1 cliente/)
    const [ev] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${A} AND tipo = 'atendimento.mudou' AND agregado_id = ${conversa}`
    expect(ev!.n).toBeGreaterThan(0)

    // Passadas seguintes (e concorrentes) não repetem nada.
    await Promise.all([passada(min(32, t0)), passada(min(33, t0))])
    await passada(min(40, t0))
    expect(enviados).toHaveLength(1)
    expect(await vezesDe(conversa, GESTOR)).toBe(vezesGil)
    expect(await vezesDe(conversa, ADM)).toBe(vezesAdm)
  })

  it('no 2º limiar libera a reatribuição e avisa o pool do número', async () => {
    await dono`INSERT INTO usuario_canal (tenant_id, usuario_id, canal_id) VALUES (${A}, ${ANA}, ${NAO_OFICIAL}), (${A}, ${BIA}, ${NAO_OFICIAL})`
    const { conversa } = await novaConversa()
    const t0 = new Date()
    await handoff(conversa, t0)
    await passada(min(31, t0))
    expect((await atendimentoDe(conversa)).reatribuicao_liberada_em).toBeNull()
    const r = await passada(min(61, t0))
    expect(r.liberados).toBe(1)
    expect((await atendimentoDe(conversa)).reatribuicao_liberada_em).not.toBeNull()
    expect((await avisosCom(conversa, 'qualquer pessoa do número pode assumir')).map((n) => n.usuario_id)).toEqual([ANA, BIA].sort())
    expect((await passada(min(70, t0))).liberados).toBe(0)
  })

  it('humano já respondeu: marca respondido, não estoura, não manda espera e fecha o alerta', async () => {
    const outra = await novaConversa()
    const t0 = new Date()
    await handoff(outra.conversa, t0)
    await passada(min(31, t0)) // abre o alerta por esta
    const { conversa } = await novaConversa()
    await handoff(conversa, t0)
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, enviada_por_id, criado_em)
               VALUES (${A}, ${randomUUID()}, ${conversa}, 'saliente', 'texto', '{"texto":"oi"}'::jsonb, ${ANA}, ${min(10, t0)})`
    enviados.length = 0
    const r = await passada(min(31, t0))
    expect(r.respondidos).toBe(1)
    const a = await atendimentoDe(conversa)
    expect(a.sla_respondido_em!.toISOString()).toBe(min(10, t0).toISOString())
    expect(a.sla_estourado_em).toBeNull()
    expect(a.aviso_espera_em).toBeNull()
    expect(enviados).toEqual([])
    // A outra é respondida depois → o alerta fecha.
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, enviada_por_id, criado_em)
               VALUES (${A}, ${randomUUID()}, ${outra.conversa}, 'saliente', 'texto', '{"texto":"oi"}'::jsonb, ${ANA}, ${min(35, t0)})`
    await passada(min(36, t0))
    const [al] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM alerta WHERE tenant_id = ${A} AND tipo = 'sla_handoff_estourado' AND resolvido_em IS NULL`
    expect(al!.n).toBe(0)
  })

  it('mensagem automática (sem autor) NÃO conta como resposta humana', async () => {
    const { conversa } = await novaConversa()
    const t0 = new Date()
    await handoff(conversa, t0)
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${A}, ${randomUUID()}, ${conversa}, 'saliente', 'texto', '{"texto":"robô"}'::jsonb, ${min(5, t0)})`
    expect((await passada(min(31, t0))).estourados).toBe(1)
  })

  it.each([
    ['opt-out', 'opt_out'], ['janela fechada (oficial)', 'janela_fechada'], ['conversa voltou ao agente', 'conversa_com_agente'],
    ['aviso desligado no número', 'desligado'],
  ] as const)('não envia com %s — registra %s (e o SLA estoura igual)', async (_n, esperado) => {
    const oficial = esperado === 'janela_fechada'
    const { conversa, fone } = await novaConversa({ canal: oficial ? OFICIAL : NAO_OFICIAL, entranteHaMin: oficial ? 25 * 60 : 1 })
    const t0 = new Date()
    if (esperado === 'desligado') {
      await dono`INSERT INTO atendimento_sla_config (tenant_id, canal_id, sla_minutos, reatribuicao_minutos, aviso_espera) VALUES (${A}, ${NAO_OFICIAL}, 30, 60, false)`
    }
    await handoff(conversa, t0, oficial ? OFICIAL : NAO_OFICIAL)
    if (esperado === 'opt_out') await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo) VALUES (${A}, ${fone}, 'opt_out')`
    if (esperado === 'conversa_com_agente') await dono`UPDATE conversa SET conduzida_por = 'ia' WHERE id = ${conversa}`
    const r = await passada(min(31, t0))
    expect(r.estourados).toBe(1)
    expect(enviados).toEqual([])
    expect((await atendimentoDe(conversa)).aviso_espera_resultado).toBe(esperado)
    const [ev] = await dono<{ motivo: string }[]>`SELECT motivo FROM atendimento_evento WHERE tenant_id = ${A} AND tipo = 'aviso_espera'`
    expect(ev!.motivo).toBe(esperado)
  })

  it('recusa do gateway na hora do envio fica registrada e não repete', async () => {
    const { conversa } = await novaConversa()
    const t0 = new Date()
    await handoff(conversa, t0)
    recusaDoGateway = 'canal_indisponivel'
    await passada(min(31, t0))
    await passada(min(45, t0))
    expect(enviados).toHaveLength(1)
    expect((await atendimentoDe(conversa)).aviso_espera_resultado).toBe('falhou')
  })

  it('fora do expediente a espera diz "no próximo horário de atendimento"', async () => {
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento)
               VALUES (${A}, ${NAO_OFICIAL}, ${JSON.stringify({ seg: { de: '08:00', ate: '18:00' } })}::text::jsonb)`
    const { conversa } = await novaConversa()
    const t0 = new Date('2026-10-19T20:50:00Z') // segunda 17:50 SP
    await handoff(conversa, t0)
    const r = await passada(min(31, t0)) // 18:21 SP: fechado, SLA ainda não venceu
    expect(r.estourados).toBe(0)
    expect(enviados.map((e) => e.texto)).toEqual([TEXTO_AVISO_ESPERA_FORA])
  })

  it('roda com o pool de UMA conexão do server.ts (sem travar na trava reservada)', async () => {
    const unico = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      const { conversa } = await novaConversa()
      const t0 = new Date()
      await handoff(conversa, t0)
      const r = await processarSla(unico as never, { somenteTenant: A, enviar: enviarFalso }, min(31, t0))
      expect(r.estourados).toBe(1)
      expect((await processarSla(unico as never, { somenteTenant: A, enviar: enviarFalso }, min(32, t0))).estourados).toBe(0)
    } finally { await unico.end() }
  })

  it('⚠️ envia FORA da conexão de dono: com o pool de 1 e envio lento, outro worker consulta durante a passada', async () => {
    const unico = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
    try {
      const { conversa } = await novaConversa()
      const t0 = new Date()
      await handoff(conversa, t0)
      let outroWorkerConsultou = false
      const lento: typeof enviarTextoNaConversa = async (_t, conversaId) => {
        // Enquanto a "rede" demora, outro worker usa a MESMA (e única) conexão.
        outroWorkerConsultou = await Promise.race([
          unico`SELECT 1 AS ok`.then(() => true),
          new Promise<boolean>((ok) => setTimeout(() => ok(false), 2_000)),
        ])
        return { ok: true, conversaId, mensagemId: randomUUID() }
      }
      await processarSla(unico as never, { somenteTenant: A, enviar: lento }, min(31, t0))
      expect(outroWorkerConsultou).toBe(true)
      expect((await atendimentoDe(conversa)).aviso_espera_resultado).toBe('enviada')
    } finally { await unico.end() }
  })

  it('exceção num envio grava "falhou" e o lote segue', async () => {
    const c1 = await novaConversa()
    const c2 = await novaConversa()
    const t0 = new Date()
    await handoff(c1.conversa, t0)
    await handoff(c2.conversa, new Date(t0.getTime() + 1000))
    explodirEm = c1.conversa
    const r = await passada(min(32, t0))
    expect(r.avisos).toMatchObject({ falhou: 1, enviada: 1 })
    expect((await atendimentoDe(c1.conversa)).aviso_espera_resultado).toBe('falhou')
    expect((await atendimentoDe(c2.conversa)).aviso_espera_resultado).toBe('enviada')
  })

  it('exceção DENTRO da trava depois de reservas commitadas: reservas viram "falhou", nada sai e a trava é solta', async () => {
    const c1 = await novaConversa()
    const c2 = await novaConversa()
    const t0 = new Date()
    await handoff(c1.conversa, t0)
    await handoff(c2.conversa, new Date(t0.getTime() + 1000))
    let passos = 0
    const explodeNo2 = async () => { if (++passos === 2) throw new Error('banco caiu no meio') }
    await expect(processarSla(dono as never, { somenteTenant: A, enviar: enviarFalso, depoisDoPasso: explodeNo2 }, min(32, t0)))
      .rejects.toThrow('banco caiu no meio')
    expect(enviados).toEqual([])
    expect((await atendimentoDe(c1.conversa)).aviso_espera_resultado).toBe('falhou')
    expect((await atendimentoDe(c2.conversa)).aviso_espera_resultado).toBe('falhou')
    // A trava foi solta: a passada seguinte roda (e não reenvia nada).
    const r = await passada(min(61, t0))
    expect(r.liberados).toBe(2)
    expect(enviados).toEqual([])
  })

  it('handoff de opt-out AMBÍGUO (marca possivel_opt_out, P4) não recebe espera: registra opt_out', async () => {
    const { conversa } = await novaConversa()
    const t0 = new Date()
    await dono`INSERT INTO agente_decisao (tenant_id, id, conversa_id, canal_id, modo, desfecho, handoff_motivo, guardrails, criado_em)
               VALUES (${A}, ${randomUUID()}, ${conversa}, ${NAO_OFICIAL}, 'autonomo', 'handoff', 'incerteza',
                       ${JSON.stringify([{ etapa: 'gatilhos-entrada', codigo: 'possivel_opt_out', gravidade: 'ALTA', acao: 'handoff' }])}::text::jsonb, ${t0})`
    await comTenantServico(A, (tx) => entregarParaHumano(tx, { conversaId: conversa, canalId: NAO_OFICIAL, sessaoId: null, motivo: 'incerteza', resumo: 'possível opt-out', agora: t0 }))
    await passada(min(31, t0))
    expect(enviados).toEqual([])
    expect((await atendimentoDe(conversa)).aviso_espera_resultado).toBe('opt_out')
  })

  it('RLS: a passada de um tenant não toca o outro', async () => {
    const { conversa } = await novaConversa({ tenant: B, canal: CANAL_B })
    const t0 = new Date()
    await handoff(conversa, t0, CANAL_B, B)
    expect((await passada(min(31, t0), A)).processadas).toBe(0)
    expect((await atendimentoDe(conversa)).sla_estourado_em).toBeNull()
    const [vistoPorA] = await comTenantServico(A, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE conversa_id = ${conversa}`)
    expect(vistoPorA!.n).toBe(0)
  })
})

/** O espelho que a P17 grava em `agente_config.playbook` ao publicar. */
const publicado = (ajuste: (c: ConteudoPlaybook) => ConteudoPlaybook) => ({
  versaoId: randomUUID(), numero: 3, escopo: 'numero', publicadaEm: new Date().toISOString(), conteudo: ajuste(playbookPadrao()),
})
const comAviso = (avisoEspera: string) => publicado((c) => ({
  ...c, persona: { ...c.persona, nome: 'Lia', loja: 'Loja X' }, mensagens: { ...c.mensagens, avisoEspera },
}))
describe('texto da espera (helpers da P17)', () => {
  it('usa o avisoEspera do playbook PUBLICADO com placeholders; fora do expediente anexa o próximo horário', () => {
    const agente = { playbook: comAviso('Oi {nome}, aqui é {assistente}: sua mensagem está com a equipe da {empresa}.') }
    expect(textoDaEspera(agente, 'Ana Maria', false)).toBe('Oi Ana, aqui é Lia: sua mensagem está com a equipe da Loja X.')
    expect(textoDaEspera(agente, 'Ana', true)).toMatch(/próximo horário de atendimento\.$/)
  })
  it('espelho inválido (sem versão) é ignorado: vale o texto fixo', () => {
    expect(textoDaEspera({ playbook: { conteudo: { mensagens: { avisoEspera: 'Oi, sua mensagem está com a equipe.' } } } }, null, false)).toBe(TEXTO_AVISO_ESPERA)
  })
  it('playbook que promete prazo ou cita valor cai no texto fixo', () => {
    for (const t of ['Já já um vendedor te responde!', 'Temos desconto de R$ 50,00 para você.']) {
      expect(textoDaEspera({ playbook: comAviso(t) }, null, false)).toBe(TEXTO_AVISO_ESPERA)
    }
  })
  it('compliance do PLAYBOOK também barra (só acrescenta ao do número)', () => {
    const agente = { playbook: publicado((c) => ({ ...c, compliance: { frasesProibidas: ['obrigado pela paciencia'], gatilhosHandoff: [] } })) }
    expect(textoDaEspera(agente, null, false)).toBeNull()
  })
  it('frase proibida do compliance do número barra também o fixo → null (texto_bloqueado)', () => {
    expect(textoDaEspera({ compliance: { frasesProibidas: ['obrigado pela paciencia'], gatilhosHandoff: [] } }, null, false)).toBeNull()
  })
  it('no worker: o playbook publicado em agente_config é o texto que sai', async () => {
    await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, persona, alcada, playbook)
               VALUES (${A}, ${NAO_OFICIAL}, true, 'assistido', 'x', '{"nome":"Lia","loja":"Loja X"}'::jsonb, '{}'::jsonb,
                       ${JSON.stringify(comAviso('Sua mensagem está com a equipe da {empresa}, {nome}.'))}::text::jsonb)
               ON CONFLICT (tenant_id, canal_id) DO UPDATE SET playbook = EXCLUDED.playbook`
    try {
      const { conversa } = await novaConversa()
      const t0 = new Date()
      await handoff(conversa, t0)
      await passada(min(31, t0))
      expect(enviados.map((e) => e.texto)).toEqual(['Sua mensagem está com a equipe da Loja X, Cliente.'])
    } finally {
      await dono`DELETE FROM agente_config WHERE tenant_id = ${A}`
    }
  })
})

describe('assumir o handoff (fila + reatribuição)', () => {
  it('reservado ao responsável até a liberação; o responsável assume', async () => {
    const { conversa } = await novaConversa({ dono: ANA })
    await handoff(conversa, new Date())
    const r = await pedir('POST', `/v1/conversas/${conversa}/assumir`)
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'atendimento.reservado', para: 'Ana' })
    await dono`UPDATE atendimento SET responsavel_id = ${EU} WHERE conversa_id = ${conversa}`
    const ok = await pedir('POST', `/v1/conversas/${conversa}/assumir`)
    expect(ok.statusCode).toBe(201)
    expect(await atendimentoDe(conversa)).toMatchObject({ atendente_id: EU, estado: 'em_atendimento' })
  })

  it('responsável AUSENTE agora não prende a reserva', async () => {
    const { conversa } = await novaConversa({ dono: ANA })
    await handoff(conversa, new Date())
    await dono`UPDATE usuario SET ausente = true WHERE id = ${ANA}`
    expect((await pedir('POST', `/v1/conversas/${conversa}/assumir`)).statusCode).toBe(201)
  })

  it('gestão assume sempre', async () => {
    await dono`UPDATE usuario_filial SET papel = 'supervisor' WHERE usuario_id = ${EU}`
    const { conversa } = await novaConversa({ dono: ANA })
    await handoff(conversa, new Date())
    expect((await pedir('POST', `/v1/conversas/${conversa}/assumir`)).statusCode).toBe(201)
  })

  it('depois do 2º limiar qualquer um assume — inclusive de quem assumiu e não respondeu (auditado)', async () => {
    const { conversa } = await novaConversa({ dono: ANA })
    const t0 = new Date(Date.now() - 61 * 60_000)
    await handoff(conversa, t0)
    const etapa = randomUUID()
    await dono`INSERT INTO atendimento_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES (${A}, ${etapa}, 5, 'p18_aguardando', 'Aguardando nós', 'atendimento')`
    await dono`UPDATE atendimento SET atendente_id = ${ANA}, estado = 'em_atendimento', etapa_id = ${etapa}, entrou_etapa_em = now() - interval '2 hours'
                WHERE conversa_id = ${conversa}`
    // Antes da liberação: é da Ana.
    expect((await pedir('POST', `/v1/conversas/${conversa}/assumir`)).json()).toMatchObject({ erro: 'atendimento.ja_assumido' })
    await passada(new Date())
    const r = await pedir('POST', `/v1/conversas/${conversa}/assumir`)
    expect(r.statusCode).toBe(201)
    const [depois] = await dono<{ atendente_id: string; etapa_id: string; horas: number }[]>`
      SELECT atendente_id, etapa_id, extract(epoch FROM now() - entrou_etapa_em) / 3600 AS horas FROM atendimento WHERE conversa_id = ${conversa}`
    // A reatribuição troca a pessoa e MANTÉM a etapa (e o aging) do card.
    expect(depois).toMatchObject({ atendente_id: EU, etapa_id: etapa })
    expect(Number(depois!.horas)).toBeGreaterThan(1.9)
    const [aud] = await dono<{ dados: { de: string } }[]>`SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'atendimento.reatribuido'`
    expect(aud!.dados.de).toBe(ANA)
  })
})

describe('fila, kanban e cronômetro', () => {
  it('o handoff aparece na fila (contador, inbox, kanban) com o SLA; o cronômetro vem por API', async () => {
    const { conversa } = await novaConversa()
    await handoff(conversa, new Date())
    await dono`UPDATE conversa SET ultima_direcao = 'saliente' WHERE id = ${conversa}` // o agente falou por último
    expect((await pedir('GET', '/v1/fila/contadores')).json().fila).toBe(1)
    expect((await pedir('GET', '/v1/conversas?filtro=fila')).json().itens.map((i: { id: string }) => i.id)).toEqual([conversa])
    const k = (await pedir('GET', '/v1/atendimento-kanban/aguardando')).json()
    expect(k.itens[0]).toMatchObject({ conversaId: conversa, sla: { fuso: 'America/Sao_Paulo', estouradoEm: null } })
    const c = await pedir('GET', `/v1/conversas/${conversa}/sla`)
    expect(c.statusCode).toBe(200)
    expect(c.json().cronometro).toMatchObject({ respondidoEm: null, reatribuicaoLiberadaEm: null })
  })

  it('handoff LEGADO (sem SLA) já respondido não entra na fila', async () => {
    const { conversa } = await novaConversa()
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado) VALUES (${A}, ${randomUUID()}, ${conversa}, ${NAO_OFICIAL}, 918001, 'na_fila')`
    await dono`UPDATE conversa SET ultima_direcao = 'saliente' WHERE id = ${conversa}`
    expect((await pedir('GET', '/v1/fila/contadores')).json().fila).toBe(0)
  })

  it('handoff respondido direto pelo inbox (sem Assumir) sai da fila', async () => {
    const { conversa } = await novaConversa()
    const t0 = new Date()
    await handoff(conversa, t0)
    await dono`UPDATE conversa SET ultima_direcao = 'saliente' WHERE id = ${conversa}`
    expect((await pedir('GET', '/v1/fila/contadores')).json().fila).toBe(1)
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, enviada_por_id, criado_em)
               VALUES (${A}, ${randomUUID()}, ${conversa}, 'saliente', 'texto', '{"texto":"oi"}'::jsonb, ${ANA}, ${min(2, t0)})`
    await passada(min(3, t0))
    expect((await pedir('GET', '/v1/fila/contadores')).json().fila).toBe(0)
    expect((await pedir('GET', '/v1/atendimento-kanban/aguardando')).json().itens).toEqual([])
  })

  it('mensagens seguintes do cliente avisam o responsável roteado (rota gestor: todos os gestores)', async () => {
    const c1 = await novaConversa({ dono: ANA })
    await handoff(c1.conversa, new Date())
    await dono`DELETE FROM notificacao WHERE tenant_id = ${A}`
    await comTenantServico(A, (tx) => notificarMensagemEntrante(tx, { conversaId: c1.conversa }))
    expect((await dono<{ usuario_id: string }[]>`SELECT usuario_id FROM notificacao WHERE conversa_id = ${c1.conversa}`).map((n) => n.usuario_id)).toEqual([ANA])
    const c2 = await novaConversa()
    await handoff(c2.conversa, new Date())
    await dono`DELETE FROM notificacao WHERE tenant_id = ${A}`
    await comTenantServico(A, (tx) => notificarMensagemEntrante(tx, { conversaId: c2.conversa }))
    expect((await dono<{ usuario_id: string }[]>`SELECT usuario_id FROM notificacao WHERE conversa_id = ${c2.conversa} ORDER BY usuario_id`).map((n) => n.usuario_id)).toEqual([GESTOR, ADM].sort())
  })

  it('conversa sem handoff: cronômetro null; outro tenant: 404', async () => {
    const { conversa } = await novaConversa()
    expect((await pedir('GET', `/v1/conversas/${conversa}/sla`)).json()).toEqual({ cronometro: null })
    await handoff(conversa, new Date())
    expect((await pedir('GET', `/v1/conversas/${conversa}/sla`, B)).statusCode).toBe(404)
  })
})

describe('configuração por número', () => {
  const URL = `/v1/canais/${NAO_OFICIAL}/sla`
  it('GET sem linha devolve o padrão', async () => {
    const r = await pedir('GET', URL)
    expect(r.json()).toMatchObject({ config: SLA_PADRAO, padrao: true, fuso: 'America/Sao_Paulo', horarioConfigurado: false })
  })

  it('PUT exige admin (403 nomeado); admin grava, auditado com antes/depois; vale para o próximo handoff', async () => {
    const corpo = { slaMinutos: 15, reatribuicaoMinutos: 45, avisoEspera: false }
    const r = await pedir('PUT', URL, A, corpo)
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ erro: 'acesso.papel_insuficiente' })
    await dono`UPDATE usuario_filial SET papel = 'admin' WHERE usuario_id = ${EU}`
    expect((await pedir('PUT', URL, A, corpo)).statusCode).toBe(200)
    expect((await pedir('GET', URL)).json()).toMatchObject({ config: corpo, padrao: false })
    const [aud] = await dono<{ dados: { antes: { slaMinutos: number; padrao: boolean }; depois: { slaMinutos: number } } }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'atendimento.sla_alterado'`
    expect(aud!.dados).toMatchObject({ antes: { slaMinutos: 30, padrao: true }, depois: { slaMinutos: 15 } })
    const { conversa } = await novaConversa()
    const t0 = new Date()
    await handoff(conversa, t0)
    expect((await atendimentoDe(conversa)).sla_vence_em.toISOString()).toBe(min(15, t0).toISOString())
  })

  it('PUT inválido: 422 com o campo', async () => {
    await dono`UPDATE usuario_filial SET papel = 'admin' WHERE usuario_id = ${EU}`
    const r = await pedir('PUT', URL, A, { slaMinutos: 60, reatribuicaoMinutos: 30, avisoEspera: true })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'sla.invalido', campos: ['reatribuicaoMinutos'] })
  })

  it('RLS: o outro tenant não lê nem grava a configuração', async () => {
    expect((await pedir('GET', URL, B)).statusCode).toBe(404)
    expect((await pedir('PUT', URL, B, SLA_PADRAO)).statusCode).toBe(404)
    const [nada] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento_sla_config WHERE tenant_id IN (${A}, ${B})`
    expect(nada!.n).toBe(0)
    await dono`INSERT INTO atendimento_sla_config (tenant_id, canal_id) VALUES (${A}, ${NAO_OFICIAL})`
    const [n] = await comTenantServico(B, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento_sla_config`)
    expect(n!.n).toBe(0)
  })
})

describe('performance: SLA cumprido', () => {
  it('sem configuração e sem handoff medido: fixo de 5 min', async () => {
    const r = (await pedir('GET', '/v1/performance?dias=7')).json()
    expect(r).toMatchObject({ slaFonte: 'fixo', slaMinutos: 5, slaHandoff: { medidos: 0, pctCumprido: null } })
  })

  it('sem configuração, com handoffs medidos: SLA cumprido pelo padrão (30 min úteis); com configuração: o configurado', async () => {
    const t0 = new Date(Date.now() - 2 * 3_600_000)
    const c1 = await novaConversa(); await handoff(c1.conversa, t0)
    const c2 = await novaConversa(); await handoff(c2.conversa, t0)
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, enviada_por_id, criado_em)
               VALUES (${A}, ${randomUUID()}, ${c1.conversa}, 'saliente', 'texto', '{"texto":"oi"}'::jsonb, ${ANA}, ${min(10, t0)})`
    await passada(new Date())
    const padrao = (await pedir('GET', '/v1/performance?dias=7')).json()
    expect(padrao).toMatchObject({
      slaFonte: 'handoff', slaMinutos: SLA_PADRAO.slaMinutos, slaMinutosVariam: false, dentroSla: 1, respondidos: 2, pctDentroSla: 50,
      slaHandoff: { medidos: 2, cumpridos: 1, estourados: 1, pctCumprido: 50 },
    })
    // Linha sem sla_minutos segue o padrão — não muda a régua.
    await dono`INSERT INTO atendimento_sla_config (tenant_id, canal_id) VALUES (${A}, ${OFICIAL})`
    expect((await pedir('GET', '/v1/performance?dias=7')).json()).toMatchObject({ slaMinutos: 30, slaMinutosVariam: false })
    await dono`INSERT INTO atendimento_sla_config (tenant_id, canal_id, sla_minutos, reatribuicao_minutos) VALUES (${A}, ${NAO_OFICIAL}, 20, 40)`
    const cfg = (await pedir('GET', '/v1/performance?dias=7')).json()
    // O número oficial segue no padrão (30): os SLAs variam entre números.
    expect(cfg).toMatchObject({ slaFonte: 'handoff', slaMinutos: 20, slaMinutosVariam: true, dentroSla: 1, respondidos: 2, pctDentroSla: 50 })
    await dono`UPDATE atendimento_sla_config SET sla_minutos = 20 WHERE tenant_id = ${A} AND canal_id = ${OFICIAL}`
    expect((await pedir('GET', '/v1/performance?dias=7')).json()).toMatchObject({ slaMinutos: 20, slaMinutosVariam: false })
  })

  it('mede na consulta: respondido e encerrado antes de o worker passar conta como cumprido', async () => {
    const t0 = new Date(Date.now() - 3_600_000)
    const c = await novaConversa(); await handoff(c.conversa, t0)
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, enviada_por_id, criado_em)
               VALUES (${A}, ${randomUUID()}, ${c.conversa}, 'saliente', 'texto', '{"texto":"oi"}'::jsonb, ${ANA}, ${min(5, t0)})`
    await dono`UPDATE atendimento SET estado = 'encerrado', encerrado_em = now() WHERE conversa_id = ${c.conversa}`
    const r = (await pedir('GET', '/v1/performance?dias=7')).json()
    expect(r.slaHandoff).toMatchObject({ medidos: 1, cumpridos: 1, estourados: 0, respondidos: 1, pctCumprido: 100 })
  })
})

describe('conversa do playground fora da operação (Pvis2)', () => {
  it('a conversa do "Cliente de simulação" não entra no inbox/trilho, na fila, no kanban nem nos contadores', async () => {
    const agora = new Date()
    // Handoff (na fila): um real e um do playground.
    const real = await novaConversa(); await handoff(real.conversa, agora)
    const sim = await novaConversa({ origem: 'simulacao' }); await handoff(sim.conversa, agora)
    // Entrante assumida por mim (coluna do kanban + "meus"): um real e um do playground.
    const realMeu = await novaConversa({ conduzida: 'humano' })
    const simMeu = await novaConversa({ conduzida: 'humano', origem: 'simulacao' })
    expect((await pedir('POST', `/v1/conversas/${realMeu.conversa}/assumir`)).statusCode).toBe(201)
    expect((await pedir('POST', `/v1/conversas/${simMeu.conversa}/assumir`)).statusCode).toBe(201)

    const ids = (r: { json(): { itens: { id?: string; conversaId?: string }[] } }) => r.json().itens.map((i) => i.id ?? i.conversaId)
    const todas = ids(await pedir('GET', '/v1/conversas'))
    expect(todas).toEqual(expect.arrayContaining([real.conversa, realMeu.conversa]))
    expect(todas).not.toContain(sim.conversa); expect(todas).not.toContain(simMeu.conversa)
    expect(ids(await pedir('GET', '/v1/conversas?filtro=fila'))).toEqual([real.conversa])
    expect(ids(await pedir('GET', '/v1/conversas?filtro=meus'))).toEqual([realMeu.conversa])

    expect((await pedir('GET', '/v1/fila/contadores')).json()).toEqual({ fila: 1, meus: 1 })

    expect(ids(await pedir('GET', '/v1/atendimento-kanban/aguardando'))).toEqual([real.conversa])
    const etapas = (await pedir('GET', '/v1/atendimento-kanban/etapas')).json() as {
      aguardando: { total: number }; itens: { id: string; ordem: number; total: number }[]
    }
    expect(etapas.aguardando.total).toBe(1)
    const primeira = etapas.itens.sort((a, b) => a.ordem - b.ordem)[0]!
    expect(primeira.total).toBe(1)
    expect(ids(await pedir('GET', `/v1/atendimento-kanban/coluna/${primeira.id}`))).toEqual([realMeu.conversa])
  })
})

describe('prévia da conversa (Pvis2)', () => {
  it('a mensagem de sistema do handoff não vira a prévia: a lista mostra a última mensagem real', async () => {
    const c = await novaConversa()
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
               VALUES (${A}, ${randomUUID()}, ${c.conversa}, 'entrante', 'texto', '{"texto":"quero falar com alguém"}'::jsonb, now() - interval '1 minute')`
    await handoff(c.conversa, new Date())
    const [sis] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE conversa_id = ${c.conversa} AND tipo = 'sistema'`
    expect(sis!.n).toBe(1)
    const item = ((await pedir('GET', '/v1/conversas')).json() as { itens: { id: string; ultimaMensagem: unknown }[] })
      .itens.find((i) => i.id === c.conversa)
    expect(item?.ultimaMensagem).toEqual({ texto: 'quero falar com alguém', direcao: 'entrante' })
  })
})
