import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import postgres from 'postgres'

/**
 * DESCARTE APÓS A CADÊNCIA E REATIVAÇÃO 30/90 (raia G5) — a sequência de retornos
 * acaba sem resposta, passa o prazo, o contato vai a Descartado (`sem_resposta`)
 * sem mensagem; depois, aos 30 e 90 dias, a reativação sai pela política das ativas.
 * Banco real; relógio SEMPRE injetado (AGORA + deslocamentos), nunca o do host;
 * WhatsApp falso pelo contrato da porta.
 */
const espiao = vi.hoisted(() => ({ templates: [] as { para: string; nome: string; idioma: string; variaveis: readonly string[] }[] }))
vi.mock('../canais/fabrica.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../canais/fabrica.js')>()
  return {
    ...real,
    criarCanal: () => ({
      tipo: 'whatsapp_oficial', capacidades: {},
      async enviarTexto() { return { ok: true, idExterno: 'texto-1' } },
      async enviarTemplate(para: string, t: { nome: string; idioma: string; variaveis: readonly string[] }) {
        espiao.templates.push({ para, ...t })
        return { ok: true, idExterno: `tpl-${espiao.templates.length}` }
      },
    }),
  }
})

const { comTenantServico, encerrarBanco } = await import('../../../db/index.js')
const { cifrar } = await import('../../integracao/cofre.js')
const { processarRetornos, cancelarRetornosDaConversa } = await import('./retorno.js')
const { reabrirContatoDescartadoSemResposta } = await import('./descarte-reativacao.js')

const T = 'b11b0000-0000-4000-8000-000000000001'
const T2 = 'b11b0000-0000-4000-8000-000000000002'
const PV = 'b11b0000-1111-4000-8000-000000000001'
const PV2 = 'b11b0000-1111-4000-8000-000000000002'
const PLANO = 'b11b0000-3333-4000-8000-000000000001'
const MODELO = 'b11b0000-4444-4000-8000-000000000001'
const NAO = 'b11b0000-5555-4000-8000-000000000001'
const OF = 'b11b0000-5555-4000-8000-000000000002'
const NAO2 = 'b11b0000-5555-4000-8000-000000000003'
const CONTATO = 'b11b0000-6666-4000-8000-000000000001'
const CONTATO2 = 'b11b0000-6666-4000-8000-000000000002'
const CONV_NAO = 'b11b0000-7777-4000-8000-000000000001'
const CONV_OF = 'b11b0000-7777-4000-8000-000000000002'
const CONV_NAO2 = 'b11b0000-7777-4000-8000-000000000003'
const TPL = 'b11b0000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const H = 3_600_000
const D = 24 * H
/** Terça, 20/10/2026, 12:00 em São Paulo — o fim da cadência (T3 enviado). */
const AGORA = new Date('2026-10-20T15:00:00Z')
const DESCARTE = new Date(AGORA.getTime() + 72 * H)
const COMERCIAL = {
  seg: { de: '09:00', ate: '18:00' }, ter: { de: '09:00', ate: '18:00' }, qua: { de: '09:00', ate: '18:00' },
  qui: { de: '09:00', ate: '18:00' }, sex: { de: '09:00', ate: '18:00' }, sab: null, dom: null,
}
const TEXTO_REATIVACAO = 'Oi! Faz um tempo que não nos falamos. Posso ajudar com algo?'
const REATIVA = { ativa: true, dias: [30, 90], templateId: null, texto: TEXTO_REATIVACAO }

let textos: string[] = []
const enviarFalso = (async (_t: string, conversaId: string, texto: string) => {
  textos.push(texto)
  return { ok: true, conversaId, mensagemId: randomUUID() }
}) as never

const configurar = (tenant: string, canal: string, ativas: Record<string, unknown> = {}) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, ativas)
  VALUES (${tenant}, ${canal}, true, 'autonomo', 'Entrega em 3 dias.', false, false, '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb,
          ${JSON.stringify(ativas)}::text::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET ativas = EXCLUDED.ativas`
const expediente = (canal: string, horario: unknown) => dono`
  INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento)
  VALUES (${T}, ${canal}, ${JSON.stringify(horario)}::text::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET horario_atendimento = EXCLUDED.horario_atendimento`
const processar = (agora: Date, tenant = T) => processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: tenant }, agora)
const retornos = (tenant: string, conversaId: string) => dono<{ motivo: string; estado: string; detalhe: string | null; executar_em: Date; tentativa: number }[]>`
  SELECT motivo, estado, detalhe, executar_em, tentativa FROM agente_retorno
   WHERE tenant_id = ${tenant} AND conversa_id = ${conversaId} ORDER BY criado_em, tentativa, motivo`
const pendentes = async (tenant: string, conversaId: string) => (await retornos(tenant, conversaId)).filter((r) => r.estado === 'pendente')
const contato = async (id = CONTATO) => (await dono<{ qualificado: boolean | null; descarte_motivo: string | null }[]>`
  SELECT qualificado, descarte_motivo FROM contato WHERE id = ${id}`)[0]!
const auditorias = (acao: string) => dono<{ ator_id: string | null; dados: { de: string; para: string; origem: string; motivo: string | null } }[]>`
  SELECT ator_id, dados FROM auditoria WHERE tenant_id = ${T} AND acao = ${acao}`

/** O T3 (último retorno) vence e sai: é o gatilho do descarte. O relógio do teste é o AGORA. */
async function fimDaCadencia(conversaId: string, canalId: string): Promise<void> {
  await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, criado_em)
             VALUES (${T}, ${randomUUID()}, ${conversaId}, ${canalId}, 'combinado', ${new Date(AGORA.getTime() - 1000)},
                     'pendente', 3, ${new Date(AGORA.getTime() - H)})`
  expect(await processar(AGORA)).toMatchObject({ enviados: 1 })
  textos = []; espiao.templates = []
}
/** Leva o contato ao descarte automático e devolve o instante em que ele ocorreu. */
async function descartarPeloSistema(conversaId: string, canalId: string): Promise<Date> {
  await fimDaCadencia(conversaId, canalId)
  expect(await processar(DESCARTE)).toMatchObject({ descartados: 1 })
  return DESCARTE
}
const template = (status: string) => dono`UPDATE template_versao SET status_meta = ${status}
  WHERE tenant_id = ${T} AND template_id = ${TPL}`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-g5-descarte', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-g5-descarte', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'G5 Descarte'], [T2, PV2, 'G5 Descarte 2']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  const cred = cifrar({ token: 'x' })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${NAO}, 'whatsapp_nao_oficial', 'plugzapi', 'Não oficial', 'conectando', ${cred}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${OF}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado',
                     ${cifrar({ phoneNumberId: 'P', token: 't', wabaId: 'W', telefone: '5585900002222' })}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T2}, ${NAO2}, 'whatsapp_nao_oficial', 'plugzapi', 'Não oficial 2', 'conectando', ${cred}) ON CONFLICT DO NOTHING`
  for (const [t, c, tel] of [[T, CONTATO, '5585988880201'], [T2, CONTATO2, '5585988880202']] as const) {
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${c}, 'Joana Prado', true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${t}, ${c}, 1, ${tel}, ${tel.slice(0, -1)}, true, true, 'teste') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONV_NAO}, ${NAO}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONV_OF}, ${OF}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T2}, ${CONV_NAO2}, ${NAO2}, ${CONTATO2}, 1) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO template (tenant_id, id, nome, categoria, idioma) VALUES (${T}, ${TPL}, 'reativacao_g5', 'MARKETING', 'pt_BR') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
             VALUES (${T}, ${TPL}, 1, '{"body":{"texto":"Oi, {{1}}! Sentimos sua falta. Responda SAIR para não receber."}}'::jsonb, 'APPROVED') ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  textos = []; espiao.templates = []
  for (const t of [T, T2]) {
    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${t}`
    await dono`DELETE FROM mensagem WHERE tenant_id = ${t}`
    await dono`DELETE FROM auditoria WHERE tenant_id = ${t}`
    await dono`DELETE FROM lista_bloqueio WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${t}`
    await dono`UPDATE conversa SET ultima_entrante_em = NULL WHERE tenant_id = ${t}`
    await dono`UPDATE contato SET qualificado = NULL, qualificado_em = NULL, descarte_motivo = NULL WHERE tenant_id = ${t}`
  }
  await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL WHERE tenant_id = ${T}`
  await configurar(T, NAO); await configurar(T, OF); await configurar(T2, NAO2)
  await template('APPROVED')
})

afterAll(async () => {
  for (const t of ['agente_retorno', 'auditoria', 'lista_bloqueio', 'agente_config', 'mensagem', 'outbox', 'conversa', 'contato_telefone', 'contato', 'template_versao', 'template', 'canal_configuracao', 'canal_conectado']) {
    for (const id of [T, T2]) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${id}'`)
  }
  for (const [t, pv] of [[T, PV], [T2, PV2]] as const) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t} AND id = ${pv}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Descarte após o fim da cadência', () => {
  it('o último retorno sai e o descarte é AGENDADO para 72 h depois (padrão), sem descartar ainda', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ motivo: 'descarte_sem_resposta', estado: 'pendente' })
    expect(p!.executar_em).toEqual(DESCARTE)
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('⚠️ 71 h 59 depois: nada; 72 h: Descartado `sem_resposta`, auditado com ator = sistema, SEM mensagem', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    expect(await processar(new Date(DESCARTE.getTime() - 60_000))).toMatchObject({ vencidos: 0 })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })

    expect(await processar(DESCARTE)).toMatchObject({ vencidos: 1, descartados: 1, enviados: 0 })
    expect(await contato()).toEqual({ qualificado: false, descarte_motivo: 'sem_resposta' })
    expect(textos).toEqual([])
    const [m] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T}`
    expect(m!.n).toBe(0)
    const aud = await auditorias('contato.descartado_sem_resposta')
    expect(aud).toHaveLength(1)
    expect(aud[0]).toMatchObject({ ator_id: null, dados: { de: 'novo', para: 'descartado', motivo: 'sem_resposta', origem: 'sistema' } })
    // Sem reativação ligada: nada mais agendado.
    expect(await pendentes(T, CONV_NAO)).toEqual([])
  })

  it('o prazo é configurável (24 h) e 0 desliga o descarte', async () => {
    await configurar(T, NAO, { descarteAposHoras: 24 })
    await fimDaCadencia(CONV_NAO, NAO)
    expect((await pendentes(T, CONV_NAO))[0]!.executar_em).toEqual(new Date(AGORA.getTime() + 24 * H))

    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
    await configurar(T, NAO, { descarteAposHoras: 0 })
    await fimDaCadencia(CONV_NAO, NAO)
    expect(await pendentes(T, CONV_NAO)).toEqual([])
  })

  it('⚠️ o cliente respondeu antes do prazo: o descarte NÃO acontece (ingestão cancela; o cinto do worker também)', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    // Caminho da ingestão: cancela os pendentes da conversa.
    await comTenantServico(T, (tx) => cancelarRetornosDaConversa(tx, CONV_NAO))
    expect(await processar(DESCARTE)).toMatchObject({ vencidos: 0 })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ motivo: 'descarte_sem_resposta', estado: 'cancelado', detalhe: 'cliente_escreveu' })
  })

  it('cinto do worker: webhook que correu sem cancelar (ultima_entrante_em depois do agendamento) → cancelado', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`UPDATE conversa SET ultima_entrante_em = ${new Date(AGORA.getTime() + 10 * H)} WHERE tenant_id = ${T} AND id = ${CONV_NAO}`
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, descartados: 0 })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('contato já qualificado (ou descartado à mão) não é descartado por silêncio', async () => {
    await dono`UPDATE contato SET qualificado = true, qualificado_em = ${AGORA} WHERE id = ${CONTATO}`
    await fimDaCadencia(CONV_NAO, NAO)
    expect(await pendentes(T, CONV_NAO)).toEqual([])   // nem agenda
    expect(await contato()).toEqual({ qualificado: true, descarte_motivo: null })
  })

  it('qualificado entre o agendamento e o prazo → cancelado "contato_ja_avaliado"', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`UPDATE contato SET qualificado = true, qualificado_em = ${AGORA} WHERE id = ${CONTATO}`
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, descartados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ estado: 'cancelado', detalhe: 'contato_ja_avaliado' })
    expect(await contato()).toEqual({ qualificado: true, descarte_motivo: null })
  })
})

describe('Reativação aos 30 e 90 dias', () => {
  it('desligada por padrão: descartar não agenda reativação', async () => {
    await descartarPeloSistema(CONV_NAO, NAO)
    expect(await pendentes(T, CONV_NAO)).toEqual([])
  })

  it('ligada: 30 d depois do descarte sai UMA reativação (texto no não-oficial) e a de 90 d é agendada do descarte', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ motivo: 'reativacao', tentativa: 1 })
    expect(p!.executar_em).toEqual(new Date(quando.getTime() + 30 * D))

    expect(await processar(new Date(quando.getTime() + 30 * D - 60_000))).toMatchObject({ vencidos: 0 })
    expect(await processar(new Date(quando.getTime() + 30 * D))).toMatchObject({ enviados: 1 })
    expect(textos).toEqual([TEXTO_REATIVACAO])
    const [q] = await pendentes(T, CONV_NAO)
    expect(q).toMatchObject({ motivo: 'reativacao', tentativa: 2 })
    expect(q!.executar_em).toEqual(new Date(quando.getTime() + 90 * D))   // contado do descarte, não do envio

    expect(await processar(new Date(quando.getTime() + 90 * D))).toMatchObject({ enviados: 1 })
    expect(textos).toHaveLength(2)
    expect(await pendentes(T, CONV_NAO)).toEqual([])   // acabaram os marcos
    expect(await contato()).toEqual({ qualificado: false, descarte_motivo: 'sem_resposta' })   // continua Descartado até responder
  })

  it('⚠️ opt-out / lista de bloqueio: a reativação NÃO sai e fica cancelada com o motivo', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo) VALUES (${T}, '558598888020', 'opt_out')`
    expect(await processar(new Date(quando.getTime() + 30 * D))).toMatchObject({ cancelados: 1, enviados: 0 })
    expect(textos).toEqual([])
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ motivo: 'reativacao', estado: 'cancelado', detalhe: 'opt_out' })
  })

  it('expediente: a reativação que vence no domingo espera a segunda 09:00 (fuso do tenant)', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    await expediente(NAO, COMERCIAL)
    // O descarte (sex 23/10, 12:00) não é mensagem: roda; a reativação cai em 22/11 (domingo).
    await fimDaCadencia(CONV_NAO, NAO)
    expect(await processar(DESCARTE)).toMatchObject({ descartados: 1 })
    const domingo = new Date(DESCARTE.getTime() + 30 * D)
    expect(await processar(domingo)).toMatchObject({ adiados: 1, enviados: 0 })
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ detalhe: 'fora_do_expediente' })
    expect(p!.executar_em).toEqual(new Date('2026-11-23T12:00:00Z'))
    expect(await processar(new Date('2026-11-23T12:00:00Z'))).toMatchObject({ enviados: 1 })
  })

  it('limite do dia (ativas já enviadas hoje) descarta a reativação — não acumula', async () => {
    await configurar(T, NAO, { reativacao: REATIVA, limiteDia: 1, limiteSemana: 2 })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    const agoraR = new Date(quando.getTime() + 30 * D)
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, concluido_em, criado_em)
               VALUES (${T}, ${randomUUID()}, ${CONV_NAO}, ${NAO}, 'combinado', ${new Date(agoraR.getTime() - H)}, 'enviado', 1,
                       ${new Date(agoraR.getTime() - H)}, ${new Date(agoraR.getTime() - H)})`
    expect(await processar(agoraR)).toMatchObject({ descartados: 1, enviados: 0 })
    expect(textos).toEqual([])
  })

  it('o descarte automático NÃO conta como ativa enviada no limite do dia', async () => {
    await configurar(T, NAO, { reativacao: { ...REATIVA, dias: [7, 90] }, limiteDia: 1, limiteSemana: 1 })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    // O T3 saiu há 3 dias (fora do dia); o descarte é "enviado" no estado, mas não é mensagem.
    expect(await processar(new Date(quando.getTime() + 7 * D))).toMatchObject({ enviados: 1 })
  })

  it('ativas suspensas por qualidade adiam a reativação (não envia)', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = ${quando}, ativas_suspensas_motivo = 'qualidade:RED' WHERE tenant_id = ${T} AND id = ${NAO}`
    expect(await processar(new Date(quando.getTime() + 30 * D))).toMatchObject({ adiados: 1, enviados: 0 })
    expect(textos).toEqual([])
  })

  it('⚠️ não-oficial SEM texto configurado: nada é enviado (recusado "sem_texto_reativacao")', async () => {
    await configurar(T, NAO, { reativacao: { ...REATIVA, texto: null } })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    expect(await processar(new Date(quando.getTime() + 30 * D))).toMatchObject({ recusados: 1, enviados: 0 })
    expect(textos).toEqual([])
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ estado: 'recusado', detalhe: 'sem_texto_reativacao' })
  })

  it('não-oficial em aquecimento sem cota hoje: adia um dia, não envia', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    const agoraR = new Date(quando.getTime() + 30 * D)
    // Aquecimento iniciado hoje: teto 20; 20 disparos de campanha já feitos.
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em, ativo) VALUES (${T}, ${NAO}, ${agoraR}, true)
               ON CONFLICT (tenant_id, canal_id) DO UPDATE SET iniciado_em = EXCLUDED.iniciado_em, ativo = true`
    for (let i = 0; i < 20; i++) {   // uma campanha por disparo: o envio é único por (campanha, contato)
      const camp = randomUUID()
      await dono`INSERT INTO campanha (tenant_id, id, nome, canal_id, mensagem, estado) VALUES (${T}, ${camp}, 'c', ${NAO}, 'oi', 'rascunho')`
      await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id, estado, enviado_em)
                 VALUES (${T}, ${randomUUID()}, ${camp}, ${CONTATO}, 'enviado', ${agoraR})`
    }
    expect(await processar(agoraR)).toMatchObject({ adiados: 1, enviados: 0 })
    expect(textos).toEqual([])
    await dono`DELETE FROM campanha_envio WHERE tenant_id = ${T}`
    await dono`DELETE FROM campanha WHERE tenant_id = ${T}`
    await dono`DELETE FROM canal_aquecimento WHERE tenant_id = ${T}`
  })

  it('OFICIAL: sempre por template aprovado (nunca texto livre), com o primeiro nome', async () => {
    await configurar(T, OF, { templateRetorno: TPL, reativacao: { ...REATIVA, templateId: TPL, texto: 'texto que o oficial NÃO usa' } })
    const quando = await descartarPeloSistema(CONV_OF, OF)
    expect(await processar(new Date(quando.getTime() + 30 * D))).toMatchObject({ enviados: 1 })
    expect(textos).toEqual([])
    expect(espiao.templates).toEqual([{ para: '5585988880201', nome: 'reativacao_g5', idioma: 'pt_BR', variaveis: ['Joana'] }])
  })

  it('OFICIAL sem template, ou com template pausado: recusado, sem enviar', async () => {
    await configurar(T, OF, { templateRetorno: TPL, reativacao: { ...REATIVA, templateId: null } })
    const quando = await descartarPeloSistema(CONV_OF, OF)
    expect(await processar(new Date(quando.getTime() + 30 * D))).toMatchObject({ recusados: 1 })
    expect((await retornos(T, CONV_OF)).at(-1)).toMatchObject({ estado: 'recusado', detalhe: 'sem_template' })

    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
    await dono`UPDATE contato SET qualificado = NULL, qualificado_em = NULL, descarte_motivo = NULL WHERE id = ${CONTATO}`
    await configurar(T, OF, { templateRetorno: TPL, reativacao: { ...REATIVA, templateId: TPL } })
    const q2 = await descartarPeloSistema(CONV_OF, OF)
    await template('PAUSED')
    expect(await processar(new Date(q2.getTime() + 30 * D))).toMatchObject({ recusados: 1 })
    expect((await retornos(T, CONV_OF)).at(-1)).toMatchObject({ estado: 'recusado', detalhe: 'template_indisponivel' })
    expect(espiao.templates).toEqual([])
  })
})

describe('Resposta do cliente', () => {
  it('⚠️ responde à reativação: pendentes canceladas e o contato volta a "novo" (auditado, ator = sistema)', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    expect(await processar(new Date(quando.getTime() + 30 * D))).toMatchObject({ enviados: 1 })
    const resposta = new Date(quando.getTime() + 31 * D)
    await comTenantServico(T, async (tx) => {
      await cancelarRetornosDaConversa(tx, CONV_NAO)
      expect(await reabrirContatoDescartadoSemResposta(tx, CONV_NAO, resposta)).toBe(true)
    })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
    expect(await pendentes(T, CONV_NAO)).toEqual([])   // a reativação de 90 d morreu
    expect(await processar(new Date(quando.getTime() + 90 * D))).toMatchObject({ vencidos: 0 })
    const aud = await auditorias('contato.reaberto_por_resposta')
    expect(aud).toHaveLength(1)
    expect(aud[0]).toMatchObject({ ator_id: null, dados: { de: 'descartado', para: 'novo', origem: 'sistema' } })
  })

  it('descarte MANUAL nunca é reaberto pelo robô quando o cliente escreve', async () => {
    await dono`UPDATE contato SET qualificado = false, qualificado_em = ${AGORA}, descarte_motivo = NULL WHERE id = ${CONTATO}`
    const reabriu = await comTenantServico(T, (tx) => reabrirContatoDescartadoSemResposta(tx, CONV_NAO, AGORA))
    expect(reabriu).toBe(false)
    expect(await contato()).toEqual({ qualificado: false, descarte_motivo: null })
  })

  it('descartado e reativação pendente: qualquer resposta (mesmo sem reativação enviada) reabre', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    await comTenantServico(T, async (tx) => {
      await cancelarRetornosDaConversa(tx, CONV_NAO)
      await reabrirContatoDescartadoSemResposta(tx, CONV_NAO, new Date(quando.getTime() + D))
    })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ motivo: 'reativacao', estado: 'cancelado', detalhe: 'cliente_escreveu' })
  })
})

describe('Dois tenants', () => {
  it('cada tenant usa a SUA configuração e a passada de um não toca o outro', async () => {
    await configurar(T2, NAO2, { descarteAposHoras: 0 })   // T2 não descarta
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, criado_em)
               VALUES (${T2}, ${randomUUID()}, ${CONV_NAO2}, ${NAO2}, 'descarte_sem_resposta', ${DESCARTE}, 'pendente', 1, ${AGORA})`

    expect(await processar(DESCARTE, T)).toMatchObject({ vencidos: 1, descartados: 1 })
    expect(await contato(CONTATO)).toEqual({ qualificado: false, descarte_motivo: 'sem_resposta' })
    expect(await contato(CONTATO2)).toEqual({ qualificado: null, descarte_motivo: null })   // T2 intocado
    expect((await pendentes(T2, CONV_NAO2))).toHaveLength(1)

    expect(await processar(DESCARTE, T2)).toMatchObject({ vencidos: 1, cancelados: 1, descartados: 0 })
    expect(await contato(CONTATO2)).toEqual({ qualificado: null, descarte_motivo: null })
    expect((await retornos(T2, CONV_NAO2))[0]).toMatchObject({ estado: 'cancelado', detalhe: 'descarte_desligado' })
    const aud = await dono<{ tenant_id: string }[]>`SELECT tenant_id FROM auditoria WHERE acao = 'contato.descartado_sem_resposta' AND tenant_id IN (${T}, ${T2})`
    expect(aud.map((a) => a.tenant_id)).toEqual([T])
  })
})
