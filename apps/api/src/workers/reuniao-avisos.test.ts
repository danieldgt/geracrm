import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { comTenantServico, encerrarBanco } from '../db/index.js'
import { statusAquecimento } from '../contexts/atendimento/aquecimento.js'
import { processarAvisosDeReuniao } from './reuniao-avisos.js'

/**
 * AVISOS DE REUNIÃO AO CLIENTE (C3): lembretes H-24/H-2 pelo gateway (texto na janela, template
 * aprovado fora dela no oficial, não-oficial só texto e contando na cota de aquecimento),
 * idempotentes por evento + tipo; no-show → UM convite para remarcar → handoff se não remarcar;
 * módulo desligado não avisa. Envio falso (contrato do gateway); banco real; prefixo c3f0.
 */
const A = 'c3f00000-0000-4000-8000-00000000000a' // módulo ligado
const B = 'c3f00000-0000-4000-8000-00000000000b' // módulo desligado
const PLANO = 'c3f00000-0001-4000-8000-000000000001'
const MODELO = 'c3f00000-0002-4000-8000-000000000001'
const PV: Record<string, string> = { [A]: 'c3f00000-0003-4000-8000-00000000000a', [B]: 'c3f00000-0003-4000-8000-00000000000b' }
const OF = 'c3f00000-0004-4000-8000-000000000001'   // oficial
const NAO = 'c3f00000-0004-4000-8000-000000000002'  // não-oficial
const OF_B = 'c3f00000-0004-4000-8000-000000000003'
const VEND = 'c3f00000-0005-4000-8000-000000000001'
const VEND_B = 'c3f00000-0005-4000-8000-000000000002'
const CT = 'c3f00000-0006-4000-8000-000000000001'
const CT_B = 'c3f00000-0006-4000-8000-000000000002'
const CV_OF = 'c3f00000-0007-4000-8000-000000000001'
const CV_NAO = 'c3f00000-0007-4000-8000-000000000002'
const CV_B = 'c3f00000-0007-4000-8000-000000000003'
const TPL_LEMBRETE = 'c3f00000-0008-4000-8000-000000000001'
const TPL_REAGENDAR = 'c3f00000-0008-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const H = 3_600_000

const textos: { conversaId: string; texto: string }[] = []
const templates: { conversaId: string; templateId: string }[] = []
const enviarTexto = (async (_t: string, conversaId: string, texto: string) => {
  textos.push({ conversaId, texto })
  return { ok: true as const, conversaId, mensagemId: crypto.randomUUID() }
}) as never
const enviarTemplate = (async (_t: string, conversaId: string, templateId: string) => {
  templates.push({ conversaId, templateId })
  return { ok: true as const, conversaId, mensagemId: crypto.randomUUID() }
}) as never
const passar = (agora: Date, t = A) => processarAvisosDeReuniao(dono as never, agora, { somenteTenant: t, enviarTexto, enviarTemplate })

async function evento(p: { conversa?: string; canal?: string; inicio: Date; status?: string; tenant?: string; contato?: string; criadoEm?: Date }): Promise<string> {
  const id = crypto.randomUUID()
  const t = p.tenant ?? A
  await dono`INSERT INTO evento_agenda (tenant_id, id, titulo, contato_id, responsavel_id, inicio, fim, status, conversa_id, canal_id, origem, criado_em)
             VALUES (${t}, ${id}, 'Reunião com Maria', ${p.contato ?? (t === A ? CT : CT_B)}, ${t === A ? VEND : VEND_B}, ${p.inicio},
                     ${new Date(p.inicio.getTime() + 30 * 60_000)}, ${p.status ?? 'agendado'}, ${p.conversa ?? CV_OF}, ${p.canal ?? OF}, 'conversa',
                     ${p.criadoEm ?? new Date(p.inicio.getTime() - 10 * 24 * H)})`
  return id
}
const avisos = (id: string) => dono<{ tipo: string; estado: string; via: string | null; motivo: string | null }[]>`
  SELECT tipo, estado, via, motivo FROM evento_agenda_aviso WHERE tenant_id = ${A} AND evento_id = ${id} ORDER BY criado_em`
const janela = (conversa: string, aberta: boolean) =>
  dono`UPDATE conversa SET ultima_entrante_em = ${aberta ? new Date(Date.now() - H) : new Date(Date.now() - 3 * 24 * H)} WHERE tenant_id = ${A} AND id = ${conversa}`
const atendimentos = async () => (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${A}`)[0]!.n

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-c3f', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-c3f', 'Varejo') ON CONFLICT DO NOTHING`
  for (const t of [A, B]) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${t}, ${'Avisos ' + t.slice(-1)}, ${PLANO}, ${PV[t]!}, 'America/Sao_Paulo') ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${PV[t]!}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${A}, 'agenda', true) ON CONFLICT (tenant_id, modulo) DO UPDATE SET ativo = true`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES
    (${A}, ${VEND}, 'c3f-vend', 'Ana Lima', 'ana@c3f.test'), (${B}, ${VEND_B}, 'c3f-vend-b', 'Bia', 'bia@c3f.test')`
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${A}, ${CT}, 'Maria Souza'), (${B}, ${CT_B}, 'Outra')`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES
    (${A}, ${OF}, 'whatsapp_oficial', 'Oficial', 'conectado'), (${A}, ${NAO}, 'whatsapp_nao_oficial', 'Zap', 'conectado'),
    (${B}, ${OF_B}, 'whatsapp_oficial', 'Oficial B', 'conectado')`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id) VALUES
    (${A}, ${CV_OF}, ${OF}, ${CT}), (${A}, ${CV_NAO}, ${NAO}, ${CT}), (${B}, ${CV_B}, ${OF_B}, ${CT_B})`
  for (const [id, nome] of [[TPL_LEMBRETE, 'lembrete_reuniao_c3f'], [TPL_REAGENDAR, 'reagendar_reuniao_c3f']] as const) {
    await dono`INSERT INTO template (tenant_id, id, nome, categoria) VALUES (${A}, ${id}, ${nome}, 'UTILITY')`
    await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
               VALUES (${A}, ${id}, 1, ${JSON.stringify({ body: { texto: 'Olá {{1}}, sobre a nossa reunião: responda por aqui.' } })}::text::jsonb, 'APPROVED')`
  }
})

beforeEach(async () => {
  textos.length = 0; templates.length = 0
  for (const t of [A, B]) {
    for (const tab of ['evento_agenda_aviso', 'evento_agenda', 'atendimento', 'mensagem', 'notificacao', 'outbox', 'agente_config', 'canal_aquecimento']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
  }
  await dono`UPDATE conversa SET conduzida_por = 'agente' WHERE tenant_id = ${A}`.catch(() => undefined)
  await dono`INSERT INTO agente_config (tenant_id, canal_id, agenda_template_lembrete, agenda_template_reagendar)
             VALUES (${A}, ${OF}, ${TPL_LEMBRETE}, ${TPL_REAGENDAR})`
  await janela(CV_OF, false); await janela(CV_NAO, false)
})

afterAll(async () => {
  for (const t of [A, B]) {
    for (const tab of ['evento_agenda_aviso', 'evento_agenda', 'atendimento_sla', 'atendimento', 'mensagem', 'notificacao', 'outbox', 'agente_config', 'canal_aquecimento',
      'template_versao', 'template', 'conversa', 'canal_conectado', 'contato', 'usuario', 'tenant_modulo', 'alerta', 'auditoria']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`).catch(() => undefined)
    }
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Lembretes H-24 e H-2', () => {
  it('⚠️ oficial fora da janela: o template aprovado do número, UMA vez só por evento + tipo', async () => {
    const agora = new Date()
    const id = await evento({ inicio: new Date(agora.getTime() + 20 * H) })
    expect((await passar(agora)).lembretes).toBe(1)
    expect((await passar(new Date(agora.getTime() + 60_000))).lembretes).toBe(0)
    expect(templates).toEqual([{ conversaId: CV_OF, templateId: TPL_LEMBRETE }])
    expect(textos).toEqual([])
    expect(await avisos(id)).toEqual([{ tipo: 'h24', estado: 'enviado', via: 'template', motivo: null }])
  })

  it('oficial dentro da janela: texto com data, hora e quem atende; depois o H-2, também uma vez', async () => {
    await janela(CV_OF, true)
    const agora = new Date()
    const inicio = new Date(agora.getTime() + 20 * H)
    const id = await evento({ inicio })
    await passar(agora)
    expect(textos).toHaveLength(1)
    expect(textos[0]!.texto).toMatch(/^Olá, Maria! Passando para lembrar da nossa reunião amanhã \(\d{2}\/\d{2}\) às \d{2}:\d{2} com Ana\./)
    const h2 = new Date(inicio.getTime() - H)
    await passar(h2); await passar(new Date(h2.getTime() + 60_000))
    expect(textos).toHaveLength(2)
    expect(textos[1]!.texto).toMatch(/hoje às/)
    expect((await avisos(id)).map((a) => `${a.tipo}:${a.estado}`)).toEqual(['h24:enviado', 'h2:enviado'])
  })

  it('oficial fora da janela sem template → recusa nomeada, nada sai (nunca texto livre fora da janela)', async () => {
    await dono`UPDATE agente_config SET agenda_template_lembrete = NULL WHERE tenant_id = ${A}`
    const agora = new Date()
    const id = await evento({ inicio: new Date(agora.getTime() + 20 * H) })
    await passar(agora); await passar(new Date(agora.getTime() + 60_000))
    expect([...textos, ...templates]).toEqual([])
    expect(await avisos(id)).toEqual([{ tipo: 'h24', estado: 'recusado', via: null, motivo: 'sem_template' }])
  })

  it('não-oficial: só texto, e o aviso conta na cota de aquecimento do número', async () => {
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em) VALUES (${A}, ${NAO}, now())`
    const agora = new Date()
    await evento({ inicio: new Date(agora.getTime() + 20 * H), conversa: CV_NAO, canal: NAO })
    await passar(agora)
    expect(textos.map((t) => t.conversaId)).toEqual([CV_NAO])
    expect(templates).toEqual([])
    const aq = await comTenantServico(A, (tx) => statusAquecimento(tx, NAO, new Date()))
    expect(aq.usadoHoje).toBe(1)
  })

  it('reagendar (novo início) rearma o lembrete', async () => {
    const agora = new Date()
    const id = await evento({ inicio: new Date(agora.getTime() + 20 * H) })
    await passar(agora)
    const novo = new Date(agora.getTime() + 44 * H)
    await dono`UPDATE evento_agenda SET inicio = ${novo}, fim = ${new Date(novo.getTime() + 30 * 60_000)} WHERE tenant_id = ${A} AND id = ${id}`
    await passar(new Date(novo.getTime() - 20 * H))
    expect(templates).toHaveLength(2)
  })

  it('evento da tela de Agenda (sem conversa), cancelado ou com o módulo desligado → nenhum aviso', async () => {
    const agora = new Date()
    await dono`INSERT INTO evento_agenda (tenant_id, id, titulo, contato_id, responsavel_id, inicio, fim, criado_em)
               VALUES (${A}, gen_random_uuid(), 'Da agenda', ${CT}, ${VEND}, ${new Date(agora.getTime() + 20 * H)}, ${new Date(agora.getTime() + 21 * H)}, now() - interval '5 days')`
    await evento({ inicio: new Date(agora.getTime() + 20 * H), status: 'cancelado' })
    await evento({ inicio: new Date(agora.getTime() + 20 * H), tenant: B, conversa: CV_B, canal: OF_B })
    await passar(agora); await passar(agora, B)
    expect([...textos, ...templates]).toEqual([])
    expect(await dono`SELECT 1 FROM evento_agenda_aviso WHERE tenant_id IN (${A}, ${B})`).toHaveLength(0)
  })
})

describe('No-show', () => {
  it('⚠️ passou sem "realizado": vira "não compareceu" e o cliente recebe UM convite para remarcar', async () => {
    const agora = new Date()
    const id = await evento({ inicio: new Date(agora.getTime() - 3 * H) })
    const r = await passar(agora)
    expect(r.noShows).toBe(1)
    await passar(new Date(agora.getTime() + 60_000))
    expect(templates).toEqual([{ conversaId: CV_OF, templateId: TPL_REAGENDAR }])
    const [e] = await dono<{ status: string }[]>`SELECT status FROM evento_agenda WHERE tenant_id = ${A} AND id = ${id}`
    expect(e!.status).toBe('nao_compareceu')
    expect(await avisos(id)).toEqual([{ tipo: 'noshow', estado: 'aguardando', via: 'template', motivo: null }])
    expect(await atendimentos()).toBe(0)
  })

  it('⚠️ sem remarcar no prazo → handoff para uma pessoa, uma vez só', async () => {
    const agora = new Date()
    const id = await evento({ inicio: new Date(agora.getTime() - 3 * H) })
    await passar(agora)
    await dono`UPDATE evento_agenda_aviso SET criado_em = criado_em - interval '25 hours' WHERE tenant_id = ${A} AND evento_id = ${id}`
    const r = await passar(new Date(agora.getTime() + 25 * H))
    expect(r.handoffs).toBe(1)
    await passar(new Date(agora.getTime() + 26 * H))
    expect(await atendimentos()).toBe(1)
    expect((await avisos(id))[0]).toMatchObject({ estado: 'handoff' })
    const msgs = await dono<{ texto: string }[]>`
      SELECT conteudo->>'texto' AS texto FROM mensagem WHERE tenant_id = ${A} AND conversa_id = ${CV_OF} AND tipo = 'sistema'`
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.texto).toMatch(/faltou à reunião/)
    expect(templates).toHaveLength(1) // o convite não se repete
  })

  it('remarcou no prazo → "reagendado", sem handoff', async () => {
    const agora = new Date()
    const id = await evento({ inicio: new Date(agora.getTime() - 3 * H) })
    await passar(agora)
    await dono`UPDATE evento_agenda_aviso SET criado_em = criado_em - interval '25 hours' WHERE tenant_id = ${A} AND evento_id = ${id}`
    await evento({ inicio: new Date(agora.getTime() + 48 * H), criadoEm: new Date() })
    const r = await passar(new Date(agora.getTime() + 25 * H))
    expect(r.reagendados).toBe(1)
    expect(await atendimentos()).toBe(0)
    expect((await avisos(id))[0]).toMatchObject({ estado: 'reagendado' })
  })

  it('sem como convidar (oficial fora da janela, sem template) → handoff imediato, uma vez só', async () => {
    await dono`UPDATE agente_config SET agenda_template_reagendar = NULL WHERE tenant_id = ${A}`
    const agora = new Date()
    const id = await evento({ inicio: new Date(agora.getTime() - 3 * H) })
    await passar(agora); await passar(new Date(agora.getTime() + 60_000))
    expect([...textos, ...templates]).toEqual([])
    expect(await atendimentos()).toBe(1)
    expect(await avisos(id)).toEqual([{ tipo: 'noshow', estado: 'handoff', via: null, motivo: 'sem_template' }])
  })

  it('"realizado" não é no-show; evento de mais de 7 dias não é acordado; agendado ainda na tolerância espera', async () => {
    const agora = new Date()
    await evento({ inicio: new Date(agora.getTime() - 3 * H), status: 'realizado' })
    await evento({ inicio: new Date(agora.getTime() - 10 * 24 * H), criadoEm: new Date(agora.getTime() - 20 * 24 * H) })
    await evento({ inicio: new Date(agora.getTime() - H) }) // terminou há 30 min: ainda dá tempo de marcar "realizado"
    expect((await passar(agora)).noShows).toBe(0)
    expect([...textos, ...templates]).toEqual([])
  })
})

describe('Isolamento (papel da aplicação)', () => {
  it('⚠️ aviso e oferta de B não aparecem nem são graváveis sob o tenant A', async () => {
    const idB = await evento({ inicio: new Date(Date.now() + 20 * H), tenant: B, conversa: CV_B, canal: OF_B })
    await dono`INSERT INTO evento_agenda_aviso (tenant_id, id, evento_id, tipo, inicio_evento) VALUES (${B}, gen_random_uuid(), ${idB}, 'h24', now())`
    await dono`INSERT INTO reuniao_oferta (tenant_id, id, conversa_id, contato_id, canal_id, opcoes, ofertada_em, expira_em)
               VALUES (${B}, gen_random_uuid(), ${CV_B}, ${CT_B}, ${OF_B}, '[]'::jsonb, now(), now() + interval '1 day')`
    const app = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { 'geracrm.tenant_id': A } as never })
    try {
      expect(await app`SELECT 1 FROM evento_agenda_aviso WHERE tenant_id = ${B}`).toHaveLength(0)
      expect(await app`SELECT 1 FROM reuniao_oferta WHERE tenant_id = ${B}`).toHaveLength(0)
      await expect(app`INSERT INTO evento_agenda_aviso (tenant_id, id, evento_id, tipo, inicio_evento) VALUES (${B}, gen_random_uuid(), ${idB}, 'h2', now())`).rejects.toThrow()
      await expect(app`INSERT INTO reuniao_oferta (tenant_id, id, conversa_id, contato_id, canal_id, opcoes, ofertada_em, expira_em)
                       VALUES (${B}, gen_random_uuid(), ${CV_B}, ${CT_B}, ${OF_B}, '[]'::jsonb, now(), now() + interval '1 day')`).rejects.toThrow()
    } finally {
      await app.end()
      await dono`DELETE FROM reuniao_oferta WHERE tenant_id = ${B}`
    }
  })
})
