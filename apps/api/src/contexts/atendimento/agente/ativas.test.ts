import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import postgres from 'postgres'
import { ATIVAS_PADRAO } from '@geracrm/shared'

/**
 * MENSAGENS ATIVAS DO AGENTE (raia P11) — a política aplicada ao retorno:
 * suspensão por qualidade (adia), expediente e feriado (adia para a próxima
 * abertura), limites dia/semana (descarta) e, no OFICIAL fora de 24h, template
 * aprovado ou recusa nomeada. Banco real; WhatsApp falso (adaptador mockado
 * pelo contrato da porta — nunca a Graph API).
 */
const espiao = vi.hoisted(() => ({ templates: [] as { para: string; nome: string; idioma: string; variaveis: readonly string[] }[], falha: null as null | { motivo: string; detalhe: string } }))
vi.mock('../canais/fabrica.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../canais/fabrica.js')>()
  return {
    ...real,
    criarCanal: () => ({
      tipo: 'whatsapp_oficial', capacidades: {},
      async enviarTexto() { return { ok: true, idExterno: 'texto-1' } },
      async enviarTemplate(para: string, t: { nome: string; idioma: string; variaveis: readonly string[] }) {
        espiao.templates.push({ para, ...t })
        if (espiao.falha) return { ok: false, ...espiao.falha }
        return { ok: true, idExterno: `tpl-${espiao.templates.length}` }
      },
    }),
  }
})

const { comTenantServico, encerrarBanco } = await import('../../../db/index.js')
const { cifrar } = await import('../../integracao/cofre.js')
const { agendarRetorno, processarRetornos, textoDoRetorno } = await import('./retorno.js')
const { decidirAtiva, ADIAMENTO_SUSPENSAS_MS } = await import('./ativas.js')
const { liberarAtivas } = await import('../qualidade-numero.js')

const T = 'b11a0000-0000-4000-8000-000000000001'
const PV = 'b11a0000-1111-4000-8000-000000000001'
const PLANO = 'b11a0000-3333-4000-8000-000000000001'
const MODELO = 'b11a0000-4444-4000-8000-000000000001'
const NAO = 'b11a0000-5555-4000-8000-000000000001'
const OF = 'b11a0000-5555-4000-8000-000000000002'
const CONTATO = 'b11a0000-6666-4000-8000-000000000001'
const CONV_NAO = 'b11a0000-7777-4000-8000-000000000001'
const CONV_OF = 'b11a0000-7777-4000-8000-000000000002'
const TPL = 'b11a0000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const H = 3_600_000
/** Terça, 20/10/2026, 12:00 em São Paulo (fuso padrão do tenant). */
const AGORA = new Date('2026-10-20T15:00:00Z')
const COMERCIAL = {
  seg: { de: '09:00', ate: '18:00' }, ter: { de: '09:00', ate: '18:00' }, qua: { de: '09:00', ate: '18:00' },
  qui: { de: '09:00', ate: '18:00' }, sex: { de: '09:00', ate: '18:00' }, sab: null, dom: null,
}

interface Envio { conversaId: string; texto: string }
let textos: Envio[] = []
const enviarFalso = (async (_t: string, conversaId: string, texto: string) => {
  textos.push({ conversaId, texto })
  return { ok: true, conversaId, mensagemId: randomUUID() }
}) as never

const configurar = (canal: string, ativas: Record<string, unknown> = {}) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, ativas)
  VALUES (${T}, ${canal}, true, 'autonomo', 'Entrega em 3 dias.', false, false, '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb,
          ${JSON.stringify(ativas)}::text::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET ativas = EXCLUDED.ativas`
const expediente = (canal: string, horario: unknown, feriados: string[] = []) => dono`
  INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento, feriados)
  VALUES (${T}, ${canal}, ${JSON.stringify(horario)}::text::jsonb, ${JSON.stringify(feriados)}::text::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET horario_atendimento = EXCLUDED.horario_atendimento, feriados = EXCLUDED.feriados`
const agendar = async (conversaId: string, canalId: string, executarEm = new Date(AGORA.getTime() - 1000)) => {
  await comTenantServico(T, (tx) => agendarRetorno(tx, { conversaId, canalId, motivo: 'combinado', executarEm }))
  // O relógio do teste é fixo (AGORA): o retorno "nasce" um minuto antes dele,
  // senão a regra "o cliente escreveu depois de agendado" compara com o relógio real.
  await dono`UPDATE agente_retorno SET criado_em = ${new Date(Math.min(executarEm.getTime(), AGORA.getTime()) - 60_000)}
              WHERE tenant_id = ${T} AND conversa_id = ${conversaId} AND estado = 'pendente'`
}
const retornos = (conversaId: string) => dono<{ estado: string; detalhe: string | null; executar_em: Date; tentativa: number }[]>`
  SELECT estado, detalhe, executar_em, tentativa FROM agente_retorno WHERE tenant_id = ${T} AND conversa_id = ${conversaId}
   ORDER BY criado_em, tentativa`
const enviadoHa = (conversaId: string, canalId: string, ms: number) => dono`
  INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, concluido_em)
  VALUES (${T}, ${randomUUID()}, ${conversaId}, ${canalId}, 'carrinho_abandonado', ${new Date(AGORA.getTime() - ms)}, 'enviado', 1,
          ${new Date(AGORA.getTime() - ms)})`
const processar = (agora = AGORA) => processarRetornos(dono as never, { enviar: enviarFalso, somenteTenant: T }, agora)
const template = (status: string, corpo = 'Oi, {{1}}! Seu pedido continua salvo por aqui.') =>
  dono`UPDATE template_versao SET status_meta = ${status}, motivo_rejeicao = ${status === 'REJECTED' ? 'teste' : null},
                                  corpo = ${JSON.stringify({ body: { texto: corpo } })}::text::jsonb
        WHERE tenant_id = ${T} AND template_id = ${TPL}`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-p11-ativas', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-p11-ativas', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'P11 Ativas', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${NAO}, 'whatsapp_nao_oficial', 'plugzapi', 'Não oficial', 'conectando', ${cifrar({ token: 'x' })}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${OF}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado',
                     ${cifrar({ phoneNumberId: 'P', token: 't', wabaId: 'W', telefone: '5585900002222' })}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Joana Prado', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585988880101', '55858888010', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONV_NAO}, ${NAO}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONV_OF}, ${OF}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO template (tenant_id, id, nome, categoria, idioma) VALUES (${T}, ${TPL}, 'retorno_p11', 'UTILITY', 'pt_BR') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
             VALUES (${T}, ${TPL}, 1, '{"body":{"texto":"Oi, {{1}}!"}}'::jsonb, 'PENDING') ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  textos = []; espiao.templates = []; espiao.falha = null
  await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${T}`
  await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL WHERE tenant_id = ${T}`
  await dono`UPDATE conversa SET ultima_entrante_em = NULL WHERE tenant_id = ${T}`
  await configurar(NAO); await configurar(OF)
  await template('PENDING')
})

afterAll(async () => {
  for (const t of ['agente_retorno', 'agente_config', 'mensagem', 'outbox', 'conversa', 'contato_telefone', 'contato', 'template_versao', 'template', 'canal_configuracao', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Suspensão por qualidade do número', () => {
  it('dado número com ativas suspensas, quando o retorno vence, então ADIA uma hora sem enviar e sem gastar tentativa', async () => {
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = now(), ativas_suspensas_motivo = 'qualidade:FLAGGED' WHERE tenant_id = ${T} AND id = ${NAO}`
    await agendar(CONV_NAO, NAO)
    expect(await processar()).toMatchObject({ adiados: 1, enviados: 0 })
    expect(textos).toEqual([])
    const [r] = await retornos(CONV_NAO)
    expect(r).toMatchObject({ estado: 'pendente', detalhe: 'ativas_suspensas', tentativa: 1 })
    expect(r!.executar_em.getTime()).toBe(AGORA.getTime() + ADIAMENTO_SUSPENSAS_MS)
  })

  it('liberado (qualidade voltou), o MESMO retorno adiado sai na passada seguinte', async () => {
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = now(), ativas_suspensas_motivo = 'qualidade:FLAGGED' WHERE tenant_id = ${T} AND id = ${NAO}`
    await agendar(CONV_NAO, NAO)
    expect(await processar()).toMatchObject({ adiados: 1 })
    await comTenantServico(T, (tx) => liberarAtivas(tx, NAO, AGORA))
    expect(await processar(new Date(AGORA.getTime() + ADIAMENTO_SUSPENSAS_MS))).toMatchObject({ enviados: 1 })
    expect(textos[0]!.texto).toBe(textoDoRetorno('combinado', 1, null))
    expect((await retornos(CONV_NAO)).find((r) => r.tentativa === 1)).toMatchObject({ estado: 'enviado' })
  })
})

describe('Expediente e feriado', () => {
  it('⚠️ fora do expediente (terça 20:00) adia para 09:00 de quarta, no fuso do tenant', async () => {
    await expediente(NAO, COMERCIAL)
    const noite = new Date('2026-10-20T23:00:00Z')
    await agendar(CONV_NAO, NAO, new Date(noite.getTime() - 1000))
    expect(await processar(noite)).toMatchObject({ adiados: 1, enviados: 0 })
    const [r] = await retornos(CONV_NAO)
    expect(r).toMatchObject({ estado: 'pendente', detalhe: 'fora_do_expediente' })
    expect(r!.executar_em).toEqual(new Date('2026-10-21T12:00:00Z'))

    // Na abertura, sai.
    expect(await processar(new Date('2026-10-21T12:00:00Z'))).toMatchObject({ enviados: 1 })
  })

  it('⚠️ fronteira: 17:59 sai; 18:00 já adia', async () => {
    await expediente(NAO, COMERCIAL)
    await agendar(CONV_NAO, NAO, new Date('2026-10-20T20:00:00Z'))
    expect(await processar(new Date('2026-10-20T20:59:00Z'))).toMatchObject({ enviados: 1 })
    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
    await agendar(CONV_NAO, NAO, new Date('2026-10-20T20:00:00Z'))
    expect(await processar(new Date('2026-10-20T21:00:00Z'))).toMatchObject({ adiados: 1 })
  })

  it('⚠️ feriado: no dia, adia com o motivo "feriado" e pula para o próximo dia útil', async () => {
    await expediente(NAO, COMERCIAL, ['10-20', '2026-10-21'])
    await agendar(CONV_NAO, NAO)
    expect(await processar()).toMatchObject({ adiados: 1 })
    const [r] = await retornos(CONV_NAO)
    expect(r).toMatchObject({ detalhe: 'feriado' })
    expect(r!.executar_em).toEqual(new Date('2026-10-22T12:00:00Z'))
  })

  it('sem horário configurado, as ativas saem a qualquer hora (a tela avisa)', async () => {
    await agendar(CONV_NAO, NAO, new Date('2026-10-21T05:00:00Z'))
    expect(await processar(new Date('2026-10-21T06:00:00Z'))).toMatchObject({ enviados: 1 })
  })
})

describe('Limites por dia e por semana', () => {
  it('dado o limite do dia atingido, então DESCARTA (não acumula para amanhã)', async () => {
    await configurar(NAO, { limiteDia: 1, limiteSemana: 4 })
    await enviadoHa(CONV_NAO, NAO, 2 * H)
    await agendar(CONV_NAO, NAO)
    expect(await processar()).toMatchObject({ descartados: 1, enviados: 0 })
    expect((await retornos(CONV_NAO)).at(-1)).toMatchObject({ estado: 'cancelado', detalhe: 'limite_dia' })
  })

  it('a ativa de mais de 24h atrás não conta no dia, mas conta na semana', async () => {
    await configurar(NAO, { limiteDia: 1, limiteSemana: 2 })
    await enviadoHa(CONV_NAO, NAO, 30 * H)
    await enviadoHa(CONV_NAO, NAO, 3 * 24 * H)
    await agendar(CONV_NAO, NAO)
    expect(await processar()).toMatchObject({ descartados: 1 })
    expect((await retornos(CONV_NAO)).at(-1)).toMatchObject({ detalhe: 'limite_semana' })
  })

  it('o cliente respondeu depois das ativas → a contagem zera', async () => {
    await configurar(NAO, { limiteDia: 1, limiteSemana: 1 })
    await enviadoHa(CONV_NAO, NAO, 3 * H)
    await dono`UPDATE conversa SET ultima_entrante_em = ${new Date(AGORA.getTime() - 2 * H)} WHERE tenant_id = ${T} AND id = ${CONV_NAO}`
    // Agendado DEPOIS da resposta do cliente (senão a regra "cliente escreveu" cancela).
    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T} AND estado = 'pendente'`
    await agendar(CONV_NAO, NAO)
    expect(await processar()).toMatchObject({ enviados: 1 })
  })
})

describe('⚠️ Oficial fora da janela de 24h: template aprovado ou recusa (ADR-021: só no oficial)', () => {
  it('sem template configurado → recusado "sem_template", sem chamar o canal', async () => {
    await agendar(CONV_OF, OF)
    expect(await processar()).toMatchObject({ recusados: 1, enviados: 0 })
    expect((await retornos(CONV_OF))[0]).toMatchObject({ estado: 'recusado', detalhe: 'sem_template' })
    expect(espiao.templates).toEqual([])
    expect(textos).toEqual([])
  })

  it('template configurado mas não aprovado (PENDING/PAUSED) → recusado "template_indisponivel"', async () => {
    await configurar(OF, { templateRetorno: TPL })
    await template('PAUSED')
    await agendar(CONV_OF, OF)
    expect(await processar()).toMatchObject({ recusados: 1 })
    expect((await retornos(CONV_OF))[0]).toMatchObject({ detalhe: 'template_indisponivel' })
  })

  it('template com {{2}} → recusado "template_incompativel" (não inventamos o valor)', async () => {
    await configurar(OF, { templateRetorno: TPL })
    await template('APPROVED', 'Oi, {{1}}! Seu pedido {{2}} está salvo.')
    await agendar(CONV_OF, OF)
    await processar()
    expect((await retornos(CONV_OF))[0]).toMatchObject({ estado: 'recusado', detalhe: 'template_incompativel' })
  })

  it('template APROVADO → sai o template pelo canal, com o primeiro nome no {{1}}, e o corpo renderizado no histórico', async () => {
    await configurar(OF, { templateRetorno: TPL })
    await template('APPROVED')
    await agendar(CONV_OF, OF)
    expect(await processar()).toMatchObject({ enviados: 1 })
    expect(textos).toEqual([])   // não foi texto livre
    expect(espiao.templates).toEqual([{ para: '5585988880101', nome: 'retorno_p11', idioma: 'pt_BR', variaveis: ['Joana'] }])
    const [m] = await dono<{ conteudo: { texto: string; template: { nome: string }; automatica: string }; status: string }[]>`
      SELECT conteudo, status FROM mensagem WHERE tenant_id = ${T} AND conversa_id = ${CONV_OF}`
    expect(m).toMatchObject({ status: 'enviada', conteudo: { texto: 'Oi, Joana! Seu pedido continua salvo por aqui.', template: { nome: 'retorno_p11' }, automatica: 'retorno' } })
  })

  it('⚠️ a Meta recusa o template no envio (132001, não existe) → recusado na hora, sem reagendar nem gastar a cadência', async () => {
    await configurar(OF, { templateRetorno: TPL })
    await template('APPROVED')
    espiao.falha = { motivo: 'resposta_inesperada', detalhe: 'template recusado pela Meta (132001)' }
    await agendar(CONV_OF, OF)
    expect(await processar()).toMatchObject({ recusados: 1, reagendados: 0, enviados: 0 })
    expect(await retornos(CONV_OF)).toEqual([expect.objectContaining({ estado: 'recusado', detalhe: 'permanente: resposta_inesperada' })])
  })

  it('template cuja única variável é {{2}} → incompatível (só {{1}} é preenchível)', async () => {
    await configurar(OF, { templateRetorno: TPL })
    await template('APPROVED', 'Seu pedido {{2}} está salvo.')
    await agendar(CONV_OF, OF)
    await processar()
    expect((await retornos(CONV_OF))[0]).toMatchObject({ estado: 'recusado', detalhe: 'template_incompativel' })
  })

  it('⚠️ fronteira da janela: 23h59 depois da última do cliente ainda é texto; 24h exatas já é template', async () => {
    await configurar(OF, { templateRetorno: TPL })
    await template('APPROVED')
    await dono`UPDATE conversa SET ultima_entrante_em = ${new Date(AGORA.getTime() - 24 * H + 60_000)} WHERE tenant_id = ${T} AND id = ${CONV_OF}`
    await agendar(CONV_OF, OF)
    expect(await processar()).toMatchObject({ enviados: 1 })
    expect(textos).toHaveLength(1)
    expect(espiao.templates).toHaveLength(0)

    await dono`DELETE FROM agente_retorno WHERE tenant_id = ${T}`
    await dono`UPDATE conversa SET ultima_entrante_em = ${new Date(AGORA.getTime() - 24 * H)} WHERE tenant_id = ${T} AND id = ${CONV_OF}`
    await agendar(CONV_OF, OF)
    expect(await processar()).toMatchObject({ enviados: 1 })
    expect(espiao.templates).toHaveLength(1)
  })

  it('não-oficial fora de 24h envia TEXTO — janela e template são do oficial', async () => {
    await configurar(NAO, { templateRetorno: TPL })
    await agendar(CONV_NAO, NAO)
    expect(await processar()).toMatchObject({ enviados: 1 })
    expect(textos).toHaveLength(1)
    expect(espiao.templates).toEqual([])
  })
})

describe('Decisão pura — a ordem das regras', () => {
  const base = {
    tipoCanal: 'whatsapp_oficial', suspensaDesde: null, horario: null, feriados: [], fuso: 'America/Sao_Paulo',
    config: ATIVAS_PADRAO, ultimaEntranteEm: null, enviadasDia: 0, enviadasSemana: 0, template: null,
  }
  it('suspensão vence expediente; expediente vence limite; limite vence janela', () => {
    expect(decidirAtiva({ ...base, suspensaDesde: AGORA, horario: { ter: null }, enviadasDia: 9 }, AGORA)).toMatchObject({ acao: 'adiar', motivo: 'ativas_suspensas' })
    expect(decidirAtiva({ ...base, horario: { ter: null }, enviadasDia: 9 }, AGORA)).toMatchObject({ acao: 'adiar', motivo: 'fora_do_expediente' })
    expect(decidirAtiva({ ...base, enviadasDia: 9 }, AGORA)).toMatchObject({ acao: 'descartar', motivo: 'limite_dia' })
    expect(decidirAtiva(base, AGORA)).toMatchObject({ acao: 'recusar', motivo: 'sem_template' })
  })
})
