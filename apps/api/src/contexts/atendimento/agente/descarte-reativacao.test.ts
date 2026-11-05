import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import postgres from 'postgres'
import { normalizarTelefone } from '@geracrm/shared'

/**
 * DESCARTE APÓS A CADÊNCIA E REATIVAÇÃO 30/90 (raia G5) — a sequência de retornos
 * acaba sem resposta, passa o prazo, o contato vai a Descartado (`sem_resposta`)
 * sem mensagem; depois, aos 30 e 90 dias (± espalhamento), a reativação sai pela
 * política das ativas, com teto por número.
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
const { ingerirMensagemEntrante } = await import('../ingestao-mensagem.js')
const {
  reabrirContatoDescartadoSemResposta, executarDescarte, espalhamentoDaReativacao, instanteDoMarco, ESPALHAMENTO_REATIVACAO_MS,
} = await import('./descarte-reativacao.js')

const T = 'b55e0000-0000-4000-8000-000000000001'
const T2 = 'b55e0000-0000-4000-8000-000000000002'
const PV = 'b55e0000-1111-4000-8000-000000000001'
const PV2 = 'b55e0000-1111-4000-8000-000000000002'
const PLANO = 'b55e0000-3333-4000-8000-000000000001'
const MODELO = 'b55e0000-4444-4000-8000-000000000001'
const NAO = 'b55e0000-5555-4000-8000-000000000001'
const OF = 'b55e0000-5555-4000-8000-000000000002'
const NAO2 = 'b55e0000-5555-4000-8000-000000000003'
const IG = 'b55e0000-5555-4000-8000-000000000004'
const CONTATO = 'b55e0000-6666-4000-8000-000000000001'
const CONTATO2 = 'b55e0000-6666-4000-8000-000000000002'
const CONTATO3 = 'b55e0000-6666-4000-8000-000000000003'
const CONV_NAO = 'b55e0000-7777-4000-8000-000000000001'
const CONV_OF = 'b55e0000-7777-4000-8000-000000000002'
const CONV_NAO2 = 'b55e0000-7777-4000-8000-000000000003'
const CONV_NAO3 = 'b55e0000-7777-4000-8000-000000000004'
const CONV_IG = 'b55e0000-7777-4000-8000-000000000005'
const TPL = 'b55e0000-8888-4000-8000-000000000001'
const TEL = '5585988880201'
const CHAVE = normalizarTelefone(TEL)!.chaveBloqueio

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

/** O descarte é DESLIGADO por padrão: aqui o número o liga (72 h) salvo quando o teste diz outra coisa. */
const configurar = (tenant: string, canal: string, ativas: Record<string, unknown> = {}, modo = 'autonomo') => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, ativas)
  VALUES (${tenant}, ${canal}, true, ${modo}, 'Entrega em 3 dias.', false, false, '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb,
          ${JSON.stringify({ descarteAposHoras: 72, ...ativas })}::text::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET ativas = EXCLUDED.ativas, modo = EXCLUDED.modo`
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
/** O instante do marco `passo` da reativação para um contato (descarte + dias ± espalhamento). */
const marco = (descartadoEm: Date, passo: number, dias: readonly number[] = [30, 90], contatoId = CONTATO) =>
  instanteDoMarco({ descartadoEm, dias, contatoId, passo })!
const entrante = (id: string, texto: string, recebidaEm: Date) => ({ deE164: TEL, idExterno: id, tipo: 'texto' as const, texto, recebidaEm })
const horaEmSaoPaulo = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
function portao(): { p: Promise<void>; abrir: () => void } {
  let abrir!: () => void
  const p = new Promise<void>((ok) => { abrir = ok })
  return { p, abrir }
}

/** O T3 (último retorno) vence e sai: é o gatilho do descarte. O relógio do teste é o AGORA. */
async function fimDaCadencia(conversaId: string, canalId: string, tenant = T): Promise<void> {
  await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, criado_em)
             VALUES (${tenant}, ${randomUUID()}, ${conversaId}, ${canalId}, 'combinado', ${new Date(AGORA.getTime() - 1000)},
                     'pendente', 3, ${new Date(AGORA.getTime() - H)})`
  expect(await processar(AGORA, tenant)).toMatchObject({ enviados: 1 })
  textos = []; espiao.templates = []
}
/** Leva o contato ao descarte automático e devolve o instante em que ele ocorreu. */
async function descartarPeloSistema(conversaId: string, canalId: string): Promise<Date> {
  await fimDaCadencia(conversaId, canalId)
  expect(await processar(DESCARTE)).toMatchObject({ contatosDescartados: 1, descartados: 0 })
  return DESCARTE
}
const template = (status: string) => dono`UPDATE template_versao SET status_meta = ${status}
  WHERE tenant_id = ${T} AND template_id = ${TPL}`
/** Reativação já ENVIADA hoje por um número (outra conversa do mesmo número). */
const reativacaoEnviada = (canal: string, conversa: string, em: Date) => dono`
  INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, concluido_em, criado_em)
  VALUES (${T}, ${randomUUID()}, ${conversa}, ${canal}, 'reativacao', ${em}, 'enviado', 1, ${em}, ${em})`

const TABELAS = [
  'agente_retorno', 'agente_tarefa', 'tarefa_pos_ingestao', 'notificacao', 'auditoria', 'lista_bloqueio', 'consentimento_contato',
  'mensagem_id_externo', 'mensagem', 'outbox', 'atendimento', 'pedido', 'campanha_envio', 'campanha', 'canal_aquecimento', 'agente_tenant',
]

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
             VALUES (${T}, ${IG}, 'instagram', 'meta_oficial', 'Instagram', 'conectado', ${cred}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T2}, ${NAO2}, 'whatsapp_nao_oficial', 'plugzapi', 'Não oficial 2', 'conectando', ${cred}) ON CONFLICT DO NOTHING`
  for (const [t, c, tel] of [[T, CONTATO, TEL], [T2, CONTATO2, '5585988880202'], [T, CONTATO3, '5585988880203']] as const) {
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${c}, 'Joana Prado', true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${t}, ${c}, 1, ${tel}, ${normalizarTelefone(tel)!.chaveBloqueio}, true, true, 'teste') ON CONFLICT DO NOTHING`
  }
  for (const [t, conv, canal, c] of [
    [T, CONV_NAO, NAO, CONTATO], [T, CONV_OF, OF, CONTATO], [T2, CONV_NAO2, NAO2, CONTATO2], [T, CONV_NAO3, NAO, CONTATO3], [T, CONV_IG, IG, CONTATO3],
  ] as const) {
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conv}, ${canal}, ${c}, 1) ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO template (tenant_id, id, nome, categoria, idioma) VALUES (${T}, ${TPL}, 'reativacao_g5', 'MARKETING', 'pt_BR') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
             VALUES (${T}, ${TPL}, 1, '{"body":{"texto":"Oi, {{1}}! Sentimos sua falta. Responda SAIR para não receber."}}'::jsonb, 'APPROVED') ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  textos = []; espiao.templates = []
  for (const t of [T, T2]) {
    for (const tab of TABELAS) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${t}`
    await dono`UPDATE conversa SET ultima_entrante_em = NULL WHERE tenant_id = ${t}`
    await dono`UPDATE contato SET qualificado = NULL, qualificado_em = NULL, descarte_motivo = NULL, qtd_vendas = 0,
                                  recebe_campanhas = true, recebe_automacoes = true WHERE tenant_id = ${t}`
  }
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, ${TEL}, ${CHAVE}, true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL WHERE tenant_id = ${T}`
  await configurar(T, NAO); await configurar(T, OF); await configurar(T, IG); await configurar(T2, NAO2)
  await template('APPROVED')
})

afterAll(async () => {
  for (const t of [...TABELAS, 'agente_config', 'conversa', 'contato_telefone', 'contato', 'template_versao', 'template', 'canal_configuracao', 'canal_conectado']) {
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
  it('⚠️ DESLIGADO por padrão: número sem configuração explícita não agenda o descarte', async () => {
    await dono`UPDATE agente_config SET ativas = '{}'::jsonb WHERE tenant_id = ${T} AND canal_id = ${NAO}`
    await fimDaCadencia(CONV_NAO, NAO)
    expect(await pendentes(T, CONV_NAO)).toEqual([])
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('⚠️ linha de descarte JÁ agendada por número que não ligou explicitamente: cancelada na execução', async () => {
    await dono`UPDATE agente_config SET ativas = '{"limiteDia": 2}'::jsonb WHERE tenant_id = ${T} AND canal_id = ${NAO}`
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, criado_em)
               VALUES (${T}, ${randomUUID()}, ${CONV_NAO}, ${NAO}, 'descarte_sem_resposta', ${DESCARTE}, 'pendente', 1, ${AGORA})`
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, contatosDescartados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ estado: 'cancelado', detalhe: 'descarte_desligado' })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('ligado (72 h): o último retorno sai e o descarte é AGENDADO para 72 h depois, sem descartar ainda', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ motivo: 'descarte_sem_resposta', estado: 'pendente' })
    expect(p!.executar_em).toEqual(DESCARTE)
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('⚠️ 71 h 59 depois: nada; 72 h: Descartado `sem_resposta`, auditado com ator = sistema, SEM mensagem, com desfecho próprio', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    expect(await processar(new Date(DESCARTE.getTime() - 60_000))).toMatchObject({ vencidos: 0 })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })

    // B3: o descarte do contato NÃO é o "descartados" do limite das ativas.
    expect(await processar(DESCARTE)).toMatchObject({ vencidos: 1, contatosDescartados: 1, descartados: 0, enviados: 0 })
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

  it('⚠️ contato que JÁ COMPROU (qtd_vendas > 0) nunca é descartado: nem agenda, e o agendado é cancelado', async () => {
    await dono`UPDATE contato SET qtd_vendas = 1 WHERE id = ${CONTATO}`
    await fimDaCadencia(CONV_NAO, NAO)
    expect(await pendentes(T, CONV_NAO)).toEqual([])   // nem agenda

    await dono`UPDATE contato SET qtd_vendas = 0 WHERE id = ${CONTATO}`
    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`UPDATE contato SET qtd_vendas = 2 WHERE id = ${CONTATO}`   // a venda chegou do ERP depois do agendamento
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, contatosDescartados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ estado: 'cancelado', detalhe: 'contato_com_compra' })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('⚠️ contato com pedido EFETIVADO (sem venda contada ainda) também não é descartado', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado, origem, total_centavos, total_pecas, efetivado_em)
               VALUES (${T}, ${randomUUID()}, ${CONTATO}, ${CONV_NAO}, 'efetivado', 'agente', 4990, 1, ${AGORA})`
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, contatosDescartados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ detalhe: 'contato_com_compra' })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('⚠️ modo efetivo: número em sombra (ou kill switch do tenant) cancela o descarte — é ação automática do agente', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`UPDATE agente_config SET modo = 'sombra' WHERE tenant_id = ${T} AND canal_id = ${NAO}`
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, contatosDescartados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)!.detalhe).toMatch(/^modo:sombra/)
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })

    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
    await dono`UPDATE agente_config SET modo = 'autonomo' WHERE tenant_id = ${T} AND canal_id = ${NAO}`
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${T}, 'desligado')`
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, contatosDescartados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)!.detalhe).toMatch(/^modo:desligado/)
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('⚠️ o cliente respondeu antes do prazo: o descarte NÃO acontece (ingestão cancela; o cinto do worker também)', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    await comTenantServico(T, (tx) => cancelarRetornosDaConversa(tx, CONV_NAO))
    expect(await processar(DESCARTE)).toMatchObject({ vencidos: 0 })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ motivo: 'descarte_sem_resposta', estado: 'cancelado', detalhe: 'cliente_escreveu' })
  })

  it('cinto do worker: webhook que correu sem cancelar (ultima_entrante_em depois do agendamento) → cancelado', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`UPDATE conversa SET ultima_entrante_em = ${new Date(AGORA.getTime() + 10 * H)} WHERE tenant_id = ${T} AND id = ${CONV_NAO}`
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, contatosDescartados: 0 })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
  })

  it('⚠️ o cliente escreveu em OUTRO número do mesmo contato: conta (última entrante é do contato) → cancelado', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    await dono`UPDATE conversa SET ultima_entrante_em = ${new Date(AGORA.getTime() + 10 * H)} WHERE tenant_id = ${T} AND id = ${CONV_OF}`
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, contatosDescartados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ detalhe: 'cliente_escreveu' })
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
    expect(await processar(DESCARTE)).toMatchObject({ cancelados: 1, contatosDescartados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ estado: 'cancelado', detalhe: 'contato_ja_avaliado' })
    expect(await contato()).toEqual({ qualificado: true, descarte_motivo: null })
  })
})

describe('Corrida descarte × resposta do cliente (duas transações)', () => {
  it('⚠️ a resposta trava a conversa ANTES: o descarte espera o commit dela e não descarta', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    const ingeriu = portao(); const solta = portao()
    const ingestao = comTenantServico(T, async (tx) => {
      const r = await ingerirMensagemEntrante(tx, NAO, entrante('g5-corrida-1', 'oi, ainda tenho interesse', new Date(DESCARTE.getTime() - 60_000)))
      ingeriu.abrir()
      await solta.p
      return r
    })
    await ingeriu.p
    let terminou = false
    const worker = processar(DESCARTE).then((r) => { terminou = true; return r })
    await esperar(400)
    expect(terminou).toBe(false)   // parado na trava da conversa
    solta.abrir()
    expect((await ingestao).ok).toBe(true)
    expect(await worker).toMatchObject({ contatosDescartados: 0 })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
    expect((await retornos(T, CONV_NAO)).find((r) => r.motivo === 'descarte_sem_resposta')).toMatchObject({ estado: 'cancelado' })
    expect(await auditorias('contato.descartado_sem_resposta')).toHaveLength(0)
  })

  it('⚠️ o descarte trava a conversa ANTES: a resposta espera o commit dele e REABRE o contato', async () => {
    await fimDaCadencia(CONV_NAO, NAO)
    const descartou = portao(); const solta = portao()
    const descarte = comTenantServico(T, async (tx) => {
      const r = await executarDescarte(tx, { conversaId: CONV_NAO, canalId: NAO, criadoEm: AGORA }, DESCARTE)
      descartou.abrir()
      await solta.p
      return r
    })
    await descartou.p
    let terminou = false
    const ingestao = comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, NAO, entrante('g5-corrida-2', 'oi, ainda tenho interesse', new Date(DESCARTE.getTime() + 60_000))))
      .then((r) => { terminou = true; return r })
    await esperar(400)
    expect(terminou).toBe(false)   // parada na trava da conversa
    solta.abrir()
    expect(await descarte).toMatchObject({ tipo: 'descartado' })
    expect((await ingestao).ok).toBe(true)
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
    expect(await auditorias('contato.descartado_sem_resposta')).toHaveLength(1)
    expect(await auditorias('contato.reaberto_por_resposta')).toHaveLength(1)
  })
})

describe('Reativação aos 30 e 90 dias', () => {
  it('desligada por padrão: descartar não agenda reativação', async () => {
    await descartarPeloSistema(CONV_NAO, NAO)
    expect(await pendentes(T, CONV_NAO)).toEqual([])
  })

  it('espalhamento determinístico por contato: ±3 dias, o mesmo contato sempre no mesmo instante, lote espalhado', () => {
    expect(espalhamentoDaReativacao(CONTATO, 1)).toBe(espalhamentoDaReativacao(CONTATO, 1))
    const valores = Array.from({ length: 200 }, () => espalhamentoDaReativacao(randomUUID(), 1))
    expect(valores.every((v) => Math.abs(v) <= ESPALHAMENTO_REATIVACAO_MS)).toBe(true)
    // 200 contatos descartados no mesmo dia caem em pelo menos 6 dias diferentes da semana em torno do marco.
    expect(new Set(valores.map((v) => Math.floor((v + ESPALHAMENTO_REATIVACAO_MS) / D))).size).toBeGreaterThanOrEqual(6)
  })

  it('ligada: no marco (30 d ± espalhamento) sai UMA reativação (texto no não-oficial) e a de 90 d é agendada do descarte', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    const m1 = marco(quando, 1)
    expect(Math.abs(m1.getTime() - (quando.getTime() + 30 * D))).toBeLessThanOrEqual(3 * D)
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ motivo: 'reativacao', tentativa: 1 })
    expect(p!.executar_em).toEqual(m1)

    expect(await processar(new Date(m1.getTime() - 60_000))).toMatchObject({ vencidos: 0 })
    expect(await processar(m1)).toMatchObject({ enviados: 1 })
    expect(textos).toEqual([TEXTO_REATIVACAO])
    const [q] = await pendentes(T, CONV_NAO)
    expect(q).toMatchObject({ motivo: 'reativacao', tentativa: 2 })
    expect(q!.executar_em).toEqual(marco(quando, 2))   // contado do descarte, não do envio

    expect(await processar(marco(quando, 2))).toMatchObject({ enviados: 1 })
    expect(textos).toHaveLength(2)
    expect(await pendentes(T, CONV_NAO)).toEqual([])   // acabaram os marcos
    expect(await contato()).toEqual({ qualificado: false, descarte_motivo: 'sem_resposta' })   // continua Descartado até responder
  })

  it('⚠️ opt-out / lista de bloqueio: a reativação NÃO sai, fica cancelada com o motivo e não agenda o próximo marco', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo) VALUES (${T}, ${CHAVE}, 'opt_out')`
    expect(await processar(marco(quando, 1))).toMatchObject({ cancelados: 1, enviados: 0 })
    expect(textos).toEqual([])
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ motivo: 'reativacao', estado: 'cancelado', detalhe: 'opt_out' })
    expect(await pendentes(T, CONV_NAO)).toEqual([])
  })

  it('⚠️ contato SEM telefone com chave (estrangeiro/Instagram) e opt-out só no consentimento: não reativa', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T} AND contato_id = ${CONTATO}`
    await dono`INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, registrado_em)
               VALUES (${T}, ${CONTATO}, 'whatsapp', false, 'opt_out_mensagem', ${quando})`
    expect(await processar(marco(quando, 1))).toMatchObject({ cancelados: 1, enviados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ detalhe: 'opt_out' })
  })

  it('⚠️ contato que não recebe campanhas/automações: não reativa', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    await dono`UPDATE contato SET recebe_campanhas = false WHERE id = ${CONTATO}`
    expect(await processar(marco(quando, 1))).toMatchObject({ cancelados: 1, enviados: 0 })
    expect((await retornos(T, CONV_NAO)).at(-1)).toMatchObject({ detalhe: 'contato_nao_recebe' })
    expect(textos).toEqual([])
  })

  it('⚠️ Instagram: o descarte não agenda reativação, e uma linha agendada nele é cancelada', async () => {
    await configurar(T, IG, { reativacao: REATIVA })
    await fimDaCadencia(CONV_IG, IG)
    expect(await processar(DESCARTE)).toMatchObject({ contatosDescartados: 1 })
    expect(await pendentes(T, CONV_IG)).toEqual([])
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, criado_em)
               VALUES (${T}, ${randomUUID()}, ${CONV_IG}, ${IG}, 'reativacao', ${new Date(DESCARTE.getTime() + 30 * D)}, 'pendente', 1, ${DESCARTE})`
    expect(await processar(new Date(DESCARTE.getTime() + 30 * D))).toMatchObject({ cancelados: 1, enviados: 0 })
    expect((await retornos(T, CONV_IG)).at(-1)).toMatchObject({ detalhe: 'canal_sem_reativacao' })
  })

  it('expediente: a reativação que vence no domingo espera a segunda 09:00 (fuso do tenant)', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    await expediente(NAO, COMERCIAL)
    // O descarte (sex 23/10, 12:00) não é mensagem: roda. A reativação é posta no domingo 22/11.
    await fimDaCadencia(CONV_NAO, NAO)
    expect(await processar(DESCARTE)).toMatchObject({ contatosDescartados: 1 })
    const domingo = new Date('2026-11-22T15:00:00Z')
    await dono`UPDATE agente_retorno SET executar_em = ${domingo} WHERE tenant_id = ${T} AND motivo = 'reativacao' AND estado = 'pendente'`
    expect(await processar(domingo)).toMatchObject({ adiados: 1, enviados: 0 })
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ detalhe: 'fora_do_expediente' })
    expect(p!.executar_em).toEqual(new Date('2026-11-23T12:00:00Z'))
    expect(await processar(new Date('2026-11-23T12:00:00Z'))).toMatchObject({ enviados: 1 })
  })

  it('limite do dia por conversa (ativas já enviadas hoje) descarta a reativação — não acumula — e o próximo marco segue', async () => {
    await configurar(T, NAO, { reativacao: REATIVA, limiteDia: 1, limiteSemana: 2 })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    const agoraR = marco(quando, 1)
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, concluido_em, criado_em)
               VALUES (${T}, ${randomUUID()}, ${CONV_NAO}, ${NAO}, 'combinado', ${new Date(agoraR.getTime() - H)}, 'enviado', 1,
                       ${new Date(agoraR.getTime() - H)}, ${new Date(agoraR.getTime() - H)})`
    expect(await processar(agoraR)).toMatchObject({ descartados: 1, enviados: 0 })
    expect(textos).toEqual([])
    // M5: o marco de 90 d não morre porque o de 30 d foi barrado.
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ motivo: 'reativacao', tentativa: 2 })
    expect(p!.executar_em).toEqual(marco(quando, 2))
  })

  it('o descarte automático NÃO conta como ativa enviada no limite do dia', async () => {
    await configurar(T, NAO, { reativacao: { ...REATIVA, dias: [7, 90] }, limiteDia: 1, limiteSemana: 1 })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    // O T3 saiu há 10 dias (fora da semana); o descarte é "enviado" no estado, mas não é mensagem.
    const agoraR = new Date(quando.getTime() + 7 * D)
    await dono`UPDATE agente_retorno SET executar_em = ${agoraR} WHERE tenant_id = ${T} AND motivo = 'reativacao' AND estado = 'pendente'`
    expect(await processar(agoraR)).toMatchObject({ enviados: 1 })
  })

  it('⚠️ teto POR NÚMERO: com a cota de reativações do dia esgotada (outra conversa do número), adia para 00:00 do dia seguinte', async () => {
    await configurar(T, NAO, { reativacao: { ...REATIVA, limiteDia: 1 } })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    const agoraR = marco(quando, 1)
    await reativacaoEnviada(NAO, CONV_NAO3, new Date(agoraR.getTime() - 60_000))
    expect(await processar(agoraR)).toMatchObject({ adiados: 1, enviados: 0 })
    expect(textos).toEqual([])
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ motivo: 'reativacao', tentativa: 1, detalhe: 'limite_reativacao_dia' })
    expect(p!.executar_em.getTime()).toBeGreaterThan(agoraR.getTime())
    expect(p!.executar_em.getTime()).toBeLessThanOrEqual(agoraR.getTime() + D)
    expect(horaEmSaoPaulo(p!.executar_em)).toBe('00:00')
    // No dia seguinte a cota zera e ela sai.
    expect(await processar(p!.executar_em)).toMatchObject({ enviados: 1 })
    expect(textos).toEqual([TEXTO_REATIVACAO])
  })

  it('ativas suspensas por qualidade adiam a reativação (não envia)', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = ${quando}, ativas_suspensas_motivo = 'qualidade:RED' WHERE tenant_id = ${T} AND id = ${NAO}`
    expect(await processar(marco(quando, 1))).toMatchObject({ adiados: 1, enviados: 0 })
    expect(textos).toEqual([])
  })

  it('⚠️ não-oficial SEM texto configurado: nada é enviado (recusado "sem_texto_reativacao")', async () => {
    await configurar(T, NAO, { reativacao: { ...REATIVA, texto: null } })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    expect(await processar(marco(quando, 1))).toMatchObject({ recusados: 1, enviados: 0 })
    expect(textos).toEqual([])
    expect((await retornos(T, CONV_NAO)).find((r) => r.tentativa === 1 && r.motivo === 'reativacao')).toMatchObject({ estado: 'recusado', detalhe: 'sem_texto_reativacao' })
  })

  it('não-oficial em aquecimento sem cota hoje (campanhas): adia para 00:00 do dia seguinte, não envia', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    const agoraR = marco(quando, 1)
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
    const [p] = await pendentes(T, CONV_NAO)
    expect(p).toMatchObject({ detalhe: 'aquecimento_do_numero' })
    expect(horaEmSaoPaulo(p!.executar_em)).toBe('00:00')
  })

  it('⚠️ as reativações CONSOMEM a cota do aquecimento (somadas às campanhas)', async () => {
    await configurar(T, NAO, { reativacao: { ...REATIVA, limiteDia: 200 } })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    const agoraR = marco(quando, 1)
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em, ativo) VALUES (${T}, ${NAO}, ${agoraR}, true)
               ON CONFLICT (tenant_id, canal_id) DO UPDATE SET iniciado_em = EXCLUDED.iniciado_em, ativo = true`
    for (let i = 0; i < 20; i++) await reativacaoEnviada(NAO, CONV_NAO3, new Date(agoraR.getTime() - 60_000))
    expect(await processar(agoraR)).toMatchObject({ adiados: 1, enviados: 0 })
    expect((await pendentes(T, CONV_NAO))[0]).toMatchObject({ detalhe: 'aquecimento_do_numero' })
  })

  it('OFICIAL: sempre por template aprovado (nunca texto livre), com o primeiro nome', async () => {
    await configurar(T, OF, { templateRetorno: TPL, reativacao: { ...REATIVA, templateId: TPL, texto: 'texto que o oficial NÃO usa' } })
    const quando = await descartarPeloSistema(CONV_OF, OF)
    expect(await processar(marco(quando, 1))).toMatchObject({ enviados: 1 })
    expect(textos).toEqual([])
    expect(espiao.templates).toEqual([{ para: TEL, nome: 'reativacao_g5', idioma: 'pt_BR', variaveis: ['Joana'] }])
  })

  it('OFICIAL sem template, ou com template pausado: recusado, sem enviar — e o próximo marco é agendado mesmo assim', async () => {
    await configurar(T, OF, { templateRetorno: TPL, reativacao: { ...REATIVA, templateId: null } })
    const quando = await descartarPeloSistema(CONV_OF, OF)
    expect(await processar(marco(quando, 1))).toMatchObject({ recusados: 1 })
    expect((await retornos(T, CONV_OF)).find((r) => r.motivo === 'reativacao' && r.tentativa === 1)).toMatchObject({ estado: 'recusado', detalhe: 'sem_template' })

    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
    await dono`UPDATE contato SET qualificado = NULL, qualificado_em = NULL, descarte_motivo = NULL WHERE id = ${CONTATO}`
    await configurar(T, OF, { templateRetorno: TPL, reativacao: { ...REATIVA, templateId: TPL } })
    const q2 = await descartarPeloSistema(CONV_OF, OF)
    await template('PAUSED')
    expect(await processar(marco(q2, 1))).toMatchObject({ recusados: 1 })
    expect((await retornos(T, CONV_OF)).find((r) => r.motivo === 'reativacao' && r.tentativa === 1)).toMatchObject({ estado: 'recusado', detalhe: 'template_indisponivel' })
    expect(espiao.templates).toEqual([])
    // M5: template pausado no 30 d não mata o 90 d — quando a Meta liberar, ele sai.
    const [p] = await pendentes(T, CONV_OF)
    expect(p).toMatchObject({ motivo: 'reativacao', tentativa: 2 })
    expect(p!.executar_em).toEqual(marco(q2, 2))
    await template('APPROVED')
    expect(await processar(marco(q2, 2))).toMatchObject({ enviados: 1 })
    expect(espiao.templates).toHaveLength(1)
  })
})

describe('Resposta do cliente', () => {
  it('⚠️ responde à reativação: pendentes canceladas e o contato volta a "novo" (auditado, ator = sistema)', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    const quando = await descartarPeloSistema(CONV_NAO, NAO)
    expect(await processar(marco(quando, 1))).toMatchObject({ enviados: 1 })
    const resposta = new Date(marco(quando, 1).getTime() + D)
    await comTenantServico(T, async (tx) => {
      await cancelarRetornosDaConversa(tx, CONV_NAO)
      expect(await reabrirContatoDescartadoSemResposta(tx, CONV_NAO, resposta)).toBe(true)
    })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
    expect(await pendentes(T, CONV_NAO)).toEqual([])   // a reativação de 90 d morreu
    expect(await processar(marco(quando, 2))).toMatchObject({ vencidos: 0 })
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

  it('⚠️ contato na lista de bloqueio não é reaberto', async () => {
    await descartarPeloSistema(CONV_NAO, NAO)
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo) VALUES (${T}, ${CHAVE}, 'opt_out')`
    expect(await comTenantServico(T, (tx) => reabrirContatoDescartadoSemResposta(tx, CONV_NAO, new Date(DESCARTE.getTime() + D), 'oi'))).toBe(false)
    expect(await contato()).toEqual({ qualificado: false, descarte_motivo: 'sem_resposta' })
  })

  it('ponta a ponta (ingestão): o descartado por sem_resposta responde → reabre e a reativação pendente morre', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    await descartarPeloSistema(CONV_NAO, NAO)
    expect(await pendentes(T, CONV_NAO)).toHaveLength(1)
    const r = await comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, NAO, entrante('g5-e2e-1', 'Oi! Ainda quero ver o catálogo', new Date(DESCARTE.getTime() + D))))
    expect(r).toMatchObject({ ok: true, conversaId: CONV_NAO, contatoId: CONTATO })
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
    expect((await retornos(T, CONV_NAO)).find((x) => x.motivo === 'reativacao')).toMatchObject({ estado: 'cancelado', detalhe: 'cliente_escreveu' })
  })

  it('⚠️ ponta a ponta (ingestão): "PARE" NÃO reabre o contato (e a reativação pendente morre)', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    await descartarPeloSistema(CONV_NAO, NAO)
    const r = await comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, NAO, entrante('g5-e2e-2', 'PARE', new Date(DESCARTE.getTime() + D))))
    expect(r).toMatchObject({ ok: true, conversaId: CONV_NAO })
    expect(await contato()).toEqual({ qualificado: false, descarte_motivo: 'sem_resposta' })
    expect(await auditorias('contato.reaberto_por_resposta')).toHaveLength(0)
    expect(await pendentes(T, CONV_NAO)).toEqual([])
  })

  it('⚠️ a resposta em OUTRO número do contato cancela o descarte/reativação pendentes de todas as conversas dele', async () => {
    await configurar(T, NAO, { reativacao: REATIVA })
    await descartarPeloSistema(CONV_NAO, NAO)
    // O cliente responde pelo número oficial (outra conversa, mesmo contato).
    await comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, OF, entrante('g5-e2e-3', 'oi', new Date(DESCARTE.getTime() + D))))
    expect(await pendentes(T, CONV_NAO)).toEqual([])
    expect(await contato()).toEqual({ qualificado: null, descarte_motivo: null })
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

    expect(await processar(DESCARTE, T)).toMatchObject({ vencidos: 1, contatosDescartados: 1 })
    expect(await contato(CONTATO)).toEqual({ qualificado: false, descarte_motivo: 'sem_resposta' })
    expect(await contato(CONTATO2)).toEqual({ qualificado: null, descarte_motivo: null })   // T2 intocado
    expect((await pendentes(T2, CONV_NAO2))).toHaveLength(1)

    expect(await processar(DESCARTE, T2)).toMatchObject({ vencidos: 1, cancelados: 1, contatosDescartados: 0 })
    expect(await contato(CONTATO2)).toEqual({ qualificado: null, descarte_motivo: null })
    expect((await retornos(T2, CONV_NAO2))[0]).toMatchObject({ estado: 'cancelado', detalhe: 'descarte_desligado' })
    const aud = await dono<{ tenant_id: string }[]>`SELECT tenant_id FROM auditoria WHERE acao = 'contato.descartado_sem_resposta' AND tenant_id IN (${T}, ${T2})`
    expect(aud.map((a) => a.tenant_id)).toEqual([T])
  })
})
