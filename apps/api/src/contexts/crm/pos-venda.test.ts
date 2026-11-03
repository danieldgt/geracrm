import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { normalizarTelefone } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { encerrarBanco } from '../../db/index.js'
import { cifrar } from '../integracao/cofre.js'
import { executarNoTenant } from './automacao-motor.js'
import { processarRetornos } from '../atendimento/agente/retorno.js'
import { ferramentaRegistrarNps } from '../atendimento/agente/ferramentas/pos-venda.js'
import type { ContextoFerramenta } from '../atendimento/agente/ferramentas/porta.js'

/**
 * PÓS-VENDA POR AUTOMAÇÃO (raia G3): gatilho `pedido_efetivado` + ação
 * `agente_envia` agenda UMA ativa por pedido + roteiro, que o worker de retornos
 * envia pela política das ativas — e o NPS enviado abre o roteiro que libera a
 * ferramenta `registrar_nps`.
 * Banco real; relógio SEMPRE injetado (AGORA), nunca o do host; envio falso pelo
 * contrato da porta (`enviar`/`enviarTemplate`). UUIDs exclusivos deste arquivo.
 */
const T = 'c3a00000-0000-4000-8000-000000000001'
const T2 = 'c3a00000-0000-4000-8000-000000000002'
const PV = 'c3a00000-1111-4000-8000-000000000001'
const PV2 = 'c3a00000-1111-4000-8000-000000000002'
const PLANO = 'c3a00000-3333-4000-8000-000000000001'
const MODELO = 'c3a00000-4444-4000-8000-000000000001'
const NAO = 'c3a00000-5555-4000-8000-000000000001'
const OF = 'c3a00000-5555-4000-8000-000000000002'
const NAO2 = 'c3a00000-5555-4000-8000-000000000003'
const CONTATO = 'c3a00000-6666-4000-8000-000000000001'
const CONTATO_OF = 'c3a00000-6666-4000-8000-000000000002'
const CONTATO2 = 'c3a00000-6666-4000-8000-000000000003'
const CONV = 'c3a00000-7777-4000-8000-000000000001'
const CONV_OF = 'c3a00000-7777-4000-8000-000000000002'
const CONV2 = 'c3a00000-7777-4000-8000-000000000003'
const TPL = 'c3a00000-8888-4000-8000-000000000001'
const GESTOR = 'c3a00000-9999-4000-8000-000000000001'
const TEL = '5585988870301'
const TEL_OF = '5585988870302'
const TEL2 = '5585988870303'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const H = 3_600_000
const D = 24 * H
/** Terça, 20/10/2026, 12:00 em São Paulo. */
const AGORA = new Date('2026-10-20T15:00:00Z')
const COMERCIAL = {
  seg: { de: '09:00', ate: '18:00' }, ter: { de: '09:00', ate: '18:00' }, qua: { de: '09:00', ate: '18:00' },
  qui: { de: '09:00', ate: '18:00' }, sex: { de: '09:00', ate: '18:00' }, sab: null, dom: null,
}

let textos: { conversaId: string; texto: string }[] = []
let templates: { conversaId: string; templateId: string }[] = []
const enviar = (async (_t: string, conversaId: string, texto: string) => {
  textos.push({ conversaId, texto })
  return { ok: true, conversaId, mensagemId: randomUUID() }
}) as never
const enviarTemplate = (async (_t: string, conversaId: string, templateId: string) => {
  templates.push({ conversaId, templateId })
  return { ok: true, conversaId, mensagemId: randomUUID() }
}) as never

const configurar = (tenant: string, canal: string, modo = 'autonomo') => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada, ativas)
  VALUES (${tenant}, ${canal}, true, ${modo}, 'Entrega em 3 dias.', false, false, '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativas = EXCLUDED.ativas`

async function regra(tenant: string, p: { dias?: number; roteiro?: string; texto?: string | null; templateId?: string | null; id?: string }): Promise<string> {
  const id = p.id ?? randomUUID()
  await dono`INSERT INTO automacao (tenant_id, id, nome, gatilho, gatilho_param, acao, acao_param, criado_em)
             VALUES (${tenant}, ${id}, 'Pós-venda', 'pedido_efetivado', ${JSON.stringify({ diasDepois: p.dias ?? 0 })}::text::jsonb,
                     'agente_envia', ${JSON.stringify({ roteiro: p.roteiro ?? 'agradecimento', texto: p.texto === undefined ? 'Obrigado pela compra, {nome}!' : p.texto, templateId: p.templateId ?? null })}::text::jsonb,
                     ${new Date(AGORA.getTime() - 30 * D)})`
  return id
}
async function pedido(tenant: string, contato: string, conversa: string | null, efetivadoEm: Date): Promise<string> {
  const id = randomUUID()
  await dono`INSERT INTO pedido (tenant_id, id, contato_id, conversa_id, estado, total_centavos, efetivado_em)
             VALUES (${tenant}, ${id}, ${contato}, ${conversa}, 'efetivado', 10000, ${efetivadoEm})`
  return id
}
const motor = (agora: Date, tenant = T) => executarNoTenant(dono as unknown as Sql, tenant, agora)
const processar = (agora: Date, tenant = T) => processarRetornos(dono as never, { enviar, enviarTemplate, somenteTenant: tenant }, agora)
const linhas = (tenant = T) => dono<{ pedido_id: string; roteiro: string; estado: string; detalhe: string | null; texto: string | null; conversa_id: string; executar_em: Date }[]>`
  SELECT pedido_id, roteiro, estado, detalhe, texto, conversa_id, executar_em FROM agente_retorno
   WHERE tenant_id = ${tenant} AND motivo = 'pos_venda' ORDER BY criado_em, roteiro`

const TABELAS = [
  'agente_retorno', 'agente_sessao', 'automacao_execucao', 'automacao', 'nps_resposta', 'tarefa', 'notificacao', 'outbox',
  'lista_bloqueio', 'consentimento_contato', 'atendimento', 'pedido', 'canal_aquecimento', 'agente_tenant', 'mensagem',
]

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-g3-pos-venda', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-g3-pos-venda', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'G3 Pós-venda'], [T2, PV2, 'G3 Pós-venda 2']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  const cred = cifrar({ token: 'x' })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${NAO}, 'whatsapp_nao_oficial', 'plugzapi', 'Não oficial', 'conectado', ${cred}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${OF}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado', ${cred}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T2}, ${NAO2}, 'whatsapp_nao_oficial', 'plugzapi', 'Não oficial 2', 'conectado', ${cred}) ON CONFLICT DO NOTHING`
  for (const [t, c, tel, conv, canal] of [
    [T, CONTATO, TEL, CONV, NAO], [T, CONTATO_OF, TEL_OF, CONV_OF, OF], [T2, CONTATO2, TEL2, CONV2, NAO2],
  ] as const) {
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${c}, 'Joana Prado', true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${t}, ${c}, 1, ${tel}, ${normalizarTelefone(tel)!.chaveBloqueio}, true, true, 'teste') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conv}, ${canal}, ${c}, 1) ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO template (tenant_id, id, nome, categoria, idioma) VALUES (${T}, ${TPL}, 'pos_venda_g3', 'MARKETING', 'pt_BR') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
             VALUES (${T}, ${TPL}, 1, '{"body":{"texto":"Oi, {{1}}! Obrigado pela compra."}}'::jsonb, 'APPROVED') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${GESTOR}, 'sub-gestor-g3', 'Gil Gestor', 'gil@g3.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${GESTOR}, NULL, 'gestor') ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  textos = []; templates = []
  for (const t of [T, T2]) {
    for (const tab of TABELAS) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${t}`
    // Janela de 24h ABERTA por padrão (cliente falou há 1 h).
    await dono`UPDATE conversa SET ultima_entrante_em = ${new Date(AGORA.getTime() - H)} WHERE tenant_id = ${t}`
    await dono`UPDATE contato SET recebe_automacoes = true, recebe_campanhas = true, ativo = true WHERE tenant_id = ${t}`
  }
  await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL WHERE tenant_id = ${T}`
  await configurar(T, NAO); await configurar(T, OF); await configurar(T2, NAO2)
})

afterAll(async () => {
  for (const t of [...TABELAS, 'agente_config', 'conversa', 'contato_telefone', 'contato', 'template_versao', 'template',
    'canal_configuracao', 'canal_conectado', 'usuario_filial', 'usuario']) {
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

describe('Automação pedido_efetivado → agente_envia', () => {
  it('dado pedido efetivado, quando o motor roda duas vezes e o worker também, então agenda e envia UMA vez (idempotente por pedido+roteiro)', async () => {
    await regra(T, {})
    const p = await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    expect(await motor(AGORA)).toBe(1)
    expect(await motor(AGORA)).toBe(0)
    expect(await linhas()).toEqual([expect.objectContaining({ pedido_id: p, roteiro: 'agradecimento', estado: 'pendente', texto: 'Obrigado pela compra, Joana Prado!' })])
    expect(await processar(AGORA)).toMatchObject({ enviados: 1 })
    expect(await processar(AGORA)).toMatchObject({ vencidos: 0 })
    expect(await motor(new Date(AGORA.getTime() + H))).toBe(0)
    expect(textos).toEqual([{ conversaId: CONV, texto: 'Obrigado pela compra, Joana Prado!' }])
    expect((await linhas())[0]).toMatchObject({ estado: 'enviado' })
  })

  it('duas regras com o MESMO roteiro não mandam duas vezes; roteiros diferentes do mesmo pedido saem um de cada vez', async () => {
    await regra(T, {}); await regra(T, {})
    await regra(T, { roteiro: 'nps', texto: 'De 0 a 10, que nota você dá?' })
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    // Um pendente por conversa: a segunda mensagem espera a próxima passada.
    expect(await motor(AGORA)).toBe(1)
    await processar(AGORA)
    expect(await motor(AGORA)).toBe(1)
    await processar(AGORA)
    expect(await motor(AGORA)).toBe(0)
    expect(textos.map((t) => t.texto).sort()).toEqual(['De 0 a 10, que nota você dá?', 'Obrigado pela compra, Joana Prado!'])
  })

  it('"dias depois": nada antes do prazo; no dia, agenda; não é retroativo a pedidos de antes da regra nem velhos demais', async () => {
    await regra(T, { dias: 3 })
    const p = await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - 2 * D))
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - 40 * D)) // antes da regra existir
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - 20 * D)) // passou da janela
    expect(await motor(AGORA)).toBe(0)
    expect(await motor(new Date(AGORA.getTime() + D))).toBe(1)
    expect((await linhas()).map((l) => l.pedido_id)).toEqual([p])
  })

  it('cada pedido do mesmo cliente recebe o seu (age por pedido, não por contato)', async () => {
    await regra(T, {})
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - 2 * H))
    expect(await motor(AGORA)).toBe(1)
    await processar(AGORA)
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    expect(await motor(AGORA)).toBe(1)
    await processar(AGORA)
    expect(textos).toHaveLength(2)
  })

  it('⚠️ opt-out (lista de bloqueio): a ativa é cancelada e NADA é enviado', async () => {
    await regra(T, {})
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    await motor(AGORA)
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo) VALUES (${T}, ${normalizarTelefone(TEL)!.chaveBloqueio}, 'opt_out')`
    expect(await processar(AGORA)).toMatchObject({ cancelados: 1, enviados: 0 })
    expect(textos).toEqual([])
    expect((await linhas())[0]).toMatchObject({ estado: 'cancelado', detalhe: 'opt_out' })
  })

  it('⚠️ "não receber automações": não agenda; e se mudou depois de agendado, cancela', async () => {
    await regra(T, {})
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    await dono`UPDATE contato SET recebe_automacoes = false WHERE tenant_id = ${T} AND id = ${CONTATO}`
    expect(await motor(AGORA)).toBe(0)
    await dono`UPDATE contato SET recebe_automacoes = true WHERE tenant_id = ${T} AND id = ${CONTATO}`
    expect(await motor(AGORA)).toBe(1)
    await dono`UPDATE contato SET recebe_automacoes = false WHERE tenant_id = ${T} AND id = ${CONTATO}`
    expect(await processar(AGORA)).toMatchObject({ cancelados: 1, enviados: 0 })
    expect((await linhas())[0]).toMatchObject({ detalhe: 'contato_nao_recebe' })
  })

  it('fora do expediente: adia para a próxima abertura (não gasta, não envia)', async () => {
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${NAO}, ${JSON.stringify(COMERCIAL)}::text::jsonb)`
    await regra(T, {})
    const noite = new Date('2026-10-20T23:30:00Z') // 20:30 em São Paulo
    await pedido(T, CONTATO, CONV, new Date(noite.getTime() - H))
    await motor(noite)
    expect(await processar(noite)).toMatchObject({ adiados: 1, enviados: 0 })
    const [l] = await linhas()
    expect(l).toMatchObject({ estado: 'pendente', detalhe: 'fora_do_expediente' })
    expect(l!.executar_em.toISOString()).toBe('2026-10-21T12:00:00.000Z')
  })

  it('⚠️ humano conduzindo: não agenda enquanto o atendimento está aberto; aberto depois de agendado, cancela', async () => {
    await regra(T, {})
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    const at = randomUUID()
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
               VALUES (${T}, ${at}, ${CONV}, ${NAO}, proximo_numero(${T}, 'protocolo'), NULL, 'em_atendimento', now())`
    expect(await motor(AGORA)).toBe(0)
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T} AND id = ${at}`
    expect(await motor(AGORA)).toBe(1)
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
               VALUES (${T}, ${randomUUID()}, ${CONV}, ${NAO}, proximo_numero(${T}, 'protocolo'), NULL, 'em_atendimento', now())`
    expect(await processar(AGORA)).toMatchObject({ cancelados: 1, enviados: 0 })
    expect((await linhas())[0]).toMatchObject({ detalhe: 'humano_atendendo' })
  })

  it('agente fora do autônomo no número (sombra): a ativa não sai', async () => {
    await configurar(T, NAO, 'sombra')
    await regra(T, {})
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    await motor(AGORA)
    expect(await processar(AGORA)).toMatchObject({ enviados: 0 })
    expect(textos).toEqual([])
  })

  it('OFICIAL dentro da janela de 24h: sai o texto', async () => {
    await regra(T, { templateId: TPL })
    await pedido(T, CONTATO_OF, CONV_OF, new Date(AGORA.getTime() - H))
    await motor(AGORA)
    expect(await processar(AGORA)).toMatchObject({ enviados: 1 })
    expect(textos).toEqual([{ conversaId: CONV_OF, texto: 'Obrigado pela compra, Joana Prado!' }])
    expect(templates).toEqual([])
  })

  it('⚠️ OFICIAL fora da janela: só o template aprovado da automação — nunca texto livre', async () => {
    await dono`UPDATE conversa SET ultima_entrante_em = ${new Date(AGORA.getTime() - 25 * H)} WHERE tenant_id = ${T} AND id = ${CONV_OF}`
    await regra(T, { templateId: TPL })
    await pedido(T, CONTATO_OF, CONV_OF, new Date(AGORA.getTime() - H))
    await motor(AGORA)
    expect(await processar(AGORA)).toMatchObject({ enviados: 1 })
    expect(textos).toEqual([])
    expect(templates).toEqual([{ conversaId: CONV_OF, templateId: TPL }])
  })

  it('⚠️ OFICIAL fora da janela SEM template: recusado ("sem_template"), nada sai', async () => {
    await dono`UPDATE conversa SET ultima_entrante_em = NULL WHERE tenant_id = ${T} AND id = ${CONV_OF}`
    await regra(T, {})
    await pedido(T, CONTATO_OF, CONV_OF, new Date(AGORA.getTime() - H))
    await motor(AGORA)
    expect(await processar(AGORA)).toMatchObject({ recusados: 1, enviados: 0 })
    expect((await linhas())[0]).toMatchObject({ estado: 'recusado', detalhe: 'sem_template' })
    expect(textos).toEqual([]); expect(templates).toEqual([])
  })

  it('⚠️ NÃO-OFICIAL só com template: recusado ("sem_texto_pos_venda") — template é do oficial', async () => {
    await regra(T, { texto: null, templateId: TPL })
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    await motor(AGORA)
    expect(await processar(AGORA)).toMatchObject({ recusados: 1, enviados: 0 })
    expect((await linhas())[0]).toMatchObject({ detalhe: 'sem_texto_pos_venda' })
    expect(templates).toEqual([])
  })

  it('⚠️ NÃO-OFICIAL em aquecimento sem cota hoje: adia para o dia seguinte; o pós-venda enviado consome a cota', async () => {
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em, ativo) VALUES (${T}, ${NAO}, ${AGORA}, true)
               ON CONFLICT (tenant_id, canal_id) DO UPDATE SET iniciado_em = EXCLUDED.iniciado_em, ativo = true`
    // Teto do dia 0 = 20: 20 pós-vendas já enviados hoje por este número (outra conversa do mesmo número).
    const conv3 = randomUUID()
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${conv3}, ${NAO}, ${CONTATO_OF}, 1)`
    for (let i = 0; i < 20; i++) {
      const ped = await pedido(T, CONTATO_OF, conv3, new Date(AGORA.getTime() - 50 * D))
      await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, concluido_em, criado_em, pedido_id, roteiro)
                 VALUES (${T}, ${randomUUID()}, ${conv3}, ${NAO}, 'pos_venda', ${AGORA}, 'enviado', 1, ${new Date(AGORA.getTime() - 60_000)}, ${AGORA}, ${ped}, 'agradecimento')`
    }
    await regra(T, {})
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    await motor(AGORA)
    expect(await processar(AGORA)).toMatchObject({ adiados: 1, enviados: 0 })
    expect((await linhas()).find((l) => l.conversa_id === CONV)).toMatchObject({ estado: 'pendente', detalhe: 'aquecimento_do_numero' })
  })

  it('dois tenants: a regra de A não agenda pedido de B', async () => {
    await regra(T, {})
    await pedido(T2, CONTATO2, CONV2, new Date(AGORA.getTime() - H))
    expect(await motor(AGORA)).toBe(0)
    expect(await linhas(T2)).toEqual([])
  })
})

describe('Roteiro NPS: o envio abre a sessão e libera registrar_nps', () => {
  const ctx = async (modo: ContextoFerramenta['modo'] = 'autonomo'): Promise<ContextoFerramenta> => {
    const [s] = await dono<{ id: string }[]>`SELECT id FROM agente_sessao WHERE tenant_id = ${T} AND conversa_id = ${CONV} AND estado = 'ativa'`
    return { tenantId: T, conversaId: CONV, contatoId: CONTATO, canalId: NAO, perfil: 'varejo', sessaoId: s?.id ?? null, modo, agora: AGORA }
  }
  async function npsEnviado(): Promise<void> {
    await regra(T, { roteiro: 'nps', texto: 'De 0 a 10, que nota você dá para a compra?' })
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    await motor(AGORA)
    expect(await processar(AGORA)).toMatchObject({ enviados: 1 })
  }

  it('sem pesquisa enviada → erro tipificado nps.nao_perguntado, nada gravado', async () => {
    const r = await ferramentaRegistrarNps().executar(await ctx(), { nota: 9, comentario: null } as never)
    expect(r).toMatchObject({ ok: false })
    expect((r as { erro: string }).erro).toMatch(/^nps\.nao_perguntado/)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM nps_resposta WHERE tenant_id = ${T}`
    expect(n!.n).toBe(0)
  })

  it('pesquisa enviada → a sessão guarda o roteiro; promotor grava origem agente, sem tarefa; a segunda vez é recusada', async () => {
    await npsEnviado()
    const [s] = await dono<{ estado_agente: { posVenda: { roteiro: string } } }[]>`
      SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T} AND conversa_id = ${CONV} AND estado = 'ativa'`
    expect(s!.estado_agente.posVenda).toMatchObject({ roteiro: 'nps' })
    const r = await ferramentaRegistrarNps().executar(await ctx(), { nota: 10, comentario: 'Adorei' } as never)
    expect(r).toMatchObject({ ok: true, saida: { registrado: true, detrator: false } })
    const nps = await dono<{ nota: number; origem: string; atendente_id: string | null; contato_id: string }[]>`
      SELECT nota, origem, atendente_id, contato_id FROM nps_resposta WHERE tenant_id = ${T}`
    expect(nps).toEqual([{ nota: 10, origem: 'agente', atendente_id: null, contato_id: CONTATO }])
    const [t] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM tarefa WHERE tenant_id = ${T}`
    expect(t!.n).toBe(0)
    const de_novo = await ferramentaRegistrarNps().executar(await ctx(), { nota: 3, comentario: null } as never)
    expect((de_novo as { erro: string }).erro).toMatch(/^nps\.nao_perguntado/)
  })

  it('⚠️ detrator (≤ 6) → tarefa para o gestor e notificação, no mesmo commit', async () => {
    await npsEnviado()
    const r = await ferramentaRegistrarNps().executar(await ctx(), { nota: 4, comentario: 'Chegou atrasado' } as never)
    expect(r).toMatchObject({ ok: true, saida: { detrator: true } })
    const tarefas = await dono<{ responsavel_id: string | null; titulo: string; contato_id: string }[]>`
      SELECT responsavel_id, titulo, contato_id FROM tarefa WHERE tenant_id = ${T}`
    expect(tarefas).toEqual([{ responsavel_id: GESTOR, titulo: 'NPS detrator (nota 4) — falar com o cliente', contato_id: CONTATO }])
    const notif = await dono<{ usuario_id: string; tipo: string }[]>`SELECT usuario_id, tipo FROM notificacao WHERE tenant_id = ${T}`
    expect(notif).toEqual([{ usuario_id: GESTOR, tipo: 'nps.detrator' }])
  })

  it('modo sombra (pessoa conduz): responde em modo seco, não grava', async () => {
    await npsEnviado()
    const r = await ferramentaRegistrarNps().executar(await ctx('sombra'), { nota: 2, comentario: null } as never)
    expect(r).toMatchObject({ ok: true, saida: { modoSeco: true } })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM nps_resposta WHERE tenant_id = ${T}`
    expect(n!.n).toBe(0)
  })

  it('roteiro de AGRADECIMENTO não libera nota', async () => {
    await regra(T, {})
    await pedido(T, CONTATO, CONV, new Date(AGORA.getTime() - H))
    await motor(AGORA); await processar(AGORA)
    const r = await ferramentaRegistrarNps().executar(await ctx(), { nota: 9, comentario: null } as never)
    expect(r).toMatchObject({ ok: false })
  })

  it('pesquisa vencida (mais de 7 dias) não libera nota', async () => {
    await npsEnviado()
    const c = await ctx()
    const r = await ferramentaRegistrarNps().executar({ ...c, agora: new Date(AGORA.getTime() + 8 * D) }, { nota: 9, comentario: null } as never)
    expect(r).toMatchObject({ ok: false })
  })
})
