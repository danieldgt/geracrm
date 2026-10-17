import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { PERSONA_PADRAO } from '@geracrm/shared'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { enviarTextoNaConversa, enviarTextoParaContato } from '../../envio-conversa.js'
import { criarEtapaGatilhosEntrada } from './gatilhos-entrada.js'
import type { ContextoPipeline } from './tipos.js'

/**
 * GATILHOS DE ENTRADA (raia P4) — no turno de verdade, com banco real e
 * WhatsApp falso: o que não passa pelo modelo, o que é bloqueado e o que é
 * enviado. ⚠️ A prova central: depois do opt-out NENHUM caminho entrega.
 */
const T = 'b4a40000-0000-4000-8000-000000000001'
const PV = 'b4a40000-1111-4000-8000-000000000001'
const PLANO = 'b4a40000-3333-4000-8000-000000000001'
const MODELO = 'b4a40000-4444-4000-8000-000000000001'
const CANAL = 'b4a40000-5555-4000-8000-000000000001'
const CONTATO = 'b4a40000-6666-4000-8000-000000000001'
const CONVERSA = 'b4a40000-7777-4000-8000-000000000001'
const CHAVE = '5585988880401'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

/** WhatsApp falso: registra o texto e, no momento do envio, se o número JÁ estava bloqueado. */
const enviados: { texto: string; bloqueadoNaHora: boolean; marcador: string | undefined }[] = []
let envioFalha = false
const enviarFalso = (async (_t: string, _c: string, texto: string, _n: unknown, _a: unknown, op?: { marcador?: string }) => {
  const [b] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM lista_bloqueio WHERE tenant_id = ${T}`
  enviados.push({ texto, bloqueadoNaHora: (b?.n ?? 0) > 0, marcador: op?.marcador })
  if (envioFalha) return { ok: false, classe: 'transporte', motivo: 'provedor_fora', conversaId: CONVERSA }
  const id = crypto.randomUUID()
  // Como o gateway faria: a mensagem existe no histórico com o marcador.
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status)
             VALUES (${T}, ${id}, ${CONVERSA}, 'saliente', 'texto', ${JSON.stringify({ texto, automatica: op?.marcador })}::text::jsonb, 'enviada')`
  return { ok: true, conversaId: CONVERSA, mensagemId: id }
}) as never

let chamadasLlm = 0
const llm: PortaLlmFerramentas = {
  nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
  async rodar(): Promise<ResultadoLaco> {
    chamadasLlm += 1
    return { ok: true, saida: { mensagens: ['Posso te ajudar com os produtos.'], confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 1, saida: 1, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
  },
}
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })
const pipeline = { gatilhos: criarEtapaGatilhosEntrada({ enviar: enviarFalso }) }

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false,
          ${JSON.stringify({ nome: 'Lia', loja: 'Loja Gatilho' })}::text::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`

const mensagemDoCliente = async (texto: string, tipo = 'texto', extra: Record<string, unknown> = {}): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', ${tipo}, ${JSON.stringify({ texto, ...extra })}::text::jsonb, now())`
  return id
}
const turno = async (ids: string[]) => conduzirTurnoVendedor(
  { tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() } as Tarefa,
  { llm, ligacoes, enviar: enviarFalso, pipeline },
)
const ultimaDecisao = async () => (await dono<{ desfecho: string; handoff_motivo: string | null; portao_motivo: string | null; guardrails: { codigo: string; gravidade: string }[] }[]>`
  SELECT desfecho, handoff_motivo, portao_motivo, guardrails FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!
const sessoes = () => dono<{ estado: string; turnos: number }[]>`SELECT estado, turnos FROM agente_sessao WHERE tenant_id = ${T}`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-gatilhos-entrada', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-gatilhos-entrada', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Gatilhos', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::text::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Ana Compradora', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, ${CHAVE}, ${CHAVE}, true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0; chamadasLlm = 0; envioFalha = false
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_retorno', 'agente_sessao', 'notificacao', 'mensagem', 'atendimento', 'aviso_privacidade', 'lista_bloqueio', 'consentimento_contato', 'tenant_privacidade', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE contato SET recebe_campanhas = true, recebe_automacoes = true WHERE tenant_id = ${T}`
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_retorno', 'agente_sessao', 'agente_config', 'notificacao', 'auditoria', 'aviso_privacidade', 'lista_bloqueio', 'consentimento_contato', 'tenant_privacidade', 'atendimento', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Opt-out — "pare" bloqueia sem LLM', () => {
  it('dado "pare" em autônomo, então confirma ANTES de bloquear, bloqueia, cancela retornos, encerra a sessão e não chama o modelo', async () => {
    await configurar('autonomo')
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, ${CANAL}, 'proposta_sem_resposta', now() + interval '1 hour', 'pendente')`
    const r = await turno([await mensagemDoCliente('PARE!')])

    expect(chamadasLlm).toBe(0)
    expect(r.desfecho).toBe('handoff')
    expect(r.handoff?.motivo).toBe('opt_out')
    expect(enviados).toHaveLength(1)
    expect(enviados[0]!.texto).toBe('Certo, Ana. Não vamos mais te enviar mensagens por aqui.')
    expect(enviados[0]!.bloqueadoNaHora).toBe(false) // a confirmação saiu ANTES do bloqueio

    const [b] = await dono<{ motivo: string; origem: string }[]>`SELECT motivo, origem FROM lista_bloqueio WHERE tenant_id = ${T} AND chave_bloqueio = ${CHAVE}`
    expect(b).toEqual({ motivo: 'opt_out', origem: 'agente' })
    const [c] = await dono<{ recebe_campanhas: boolean; recebe_automacoes: boolean }[]>`SELECT recebe_campanhas, recebe_automacoes FROM contato WHERE id = ${CONTATO}`
    expect(c).toEqual({ recebe_campanhas: false, recebe_automacoes: false })
    const consent = await dono<{ tipo: string; origem: string }[]>`SELECT tipo, origem FROM consentimento_contato WHERE tenant_id = ${T} ORDER BY tipo`
    expect(consent.map((x) => x.tipo)).toEqual(['automacoes', 'campanhas', 'whatsapp'])
    expect(consent.every((x) => x.origem === 'opt_out_mensagem')).toBe(true)
    const [ret] = await dono<{ estado: string; detalhe: string }[]>`SELECT estado, detalhe FROM agente_retorno WHERE tenant_id = ${T}`
    expect(ret).toEqual({ estado: 'cancelado', detalhe: 'opt_out' })
    expect((await sessoes()).every((s) => s.estado !== 'ativa')).toBe(true)
    const d = await ultimaDecisao()
    expect(d.guardrails.map((g) => g.codigo)).toContain('opt_out')
  })

  it('dado o opt-out registrado, então NENHUM caminho entrega: agente, retorno, conversa e campanha são recusados', async () => {
    await configurar('autonomo')
    await turno([await mensagemDoCliente('não quero mais receber mensagens')])
    enviados.length = 0
    const saidasAntes = (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T} AND direcao = 'saliente' AND status = 'enviada'`)[0]!.n

    // Caminho 1: o próprio agente, num turno novo (com o atendimento já encerrado pela pessoa).
    await dono`UPDATE atendimento SET estado = 'encerrado', encerrado_em = now() WHERE tenant_id = ${T}`
    const r = await turno([await mensagemDoCliente('oi, tem camiseta?')])
    expect(r.desfecho).toBe('silencio')
    expect(chamadasLlm).toBe(0)
    expect(enviados).toHaveLength(0)

    // Caminho 2: a etapa, isolada, com o contato bloqueado → silêncio sem estado.
    const ctx: ContextoPipeline = {
      tenantId: T, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'autonomo', agora: new Date(),
      cfgExtra: {}, persona: PERSONA_PADRAO, estado: {}, historico: [], primeiraResposta: true, foraDoExpediente: false,
      entrantes: [{ id: crypto.randomUUID(), tipo: 'texto', texto: 'é robô?', transcricaoPendente: false, transcricaoFalhou: false }],
    }
    expect(await pipeline.gatilhos.executar(ctx)).toEqual({ tipo: 'silencio', motivo: 'contato_bloqueado' })

    // Caminho 3: o gateway único (inbox, resumo de pedido, automação) e a campanha.
    const naConversa = await enviarTextoNaConversa(T, CONVERSA, 'Oi, Ana! Promoção hoje.', 'Vendedora', new Date(), { ehDisparo: false })
    expect(naConversa).toMatchObject({ ok: false, classe: 'recusa', motivo: 'bloqueado' })
    const campanha = await enviarTextoParaContato(T, CANAL, CONTATO, 'Campanha de outubro')
    expect(campanha).toMatchObject({ ok: false, motivo: 'bloqueado' })

    // Caminho 4: o retorno do agente (follow-up) sai pelo MESMO caminho programático — recusado.
    // (Não roda `processarRetornos` aqui: o advisory lock global dele disputaria com retorno.test.ts.)
    const retorno = await enviarTextoNaConversa(T, CONVERSA, 'Ainda tem interesse?', null, new Date(), { ehDisparo: true, marcador: 'retorno' })
    expect(retorno).toMatchObject({ ok: false, motivo: 'bloqueado' })

    const saidasDepois = (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T} AND direcao = 'saliente' AND status = 'enviada'`)[0]!.n
    expect(saidasDepois).toBe(saidasAntes)
  })

  it('dado "cancelar pedido", então NÃO é opt-out: o modelo responde e nada é bloqueado', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('quero cancelar o pedido')])
    expect(chamadasLlm).toBe(1)
    expect(r.desfecho).toBe('respondeu')
    expect((await dono`SELECT 1 FROM lista_bloqueio WHERE tenant_id = ${T}`).length).toBe(0)
  })

  it('dado "pare" em sombra, então bloqueia do mesmo jeito mas o robô não envia nada', async () => {
    await configurar('sombra')
    const r = await turno([await mensagemDoCliente('pare')])
    expect(r.handoff?.motivo).toBe('opt_out')
    expect(enviados).toHaveLength(0)
    expect(chamadasLlm).toBe(0)
    expect((await dono`SELECT 1 FROM lista_bloqueio WHERE tenant_id = ${T}`).length).toBe(1)
    expect((await dono`SELECT 1 FROM atendimento WHERE tenant_id = ${T}`).length).toBe(0)
  })
})

describe('Abertura e aviso de privacidade', () => {
  it('dado a primeira fala do agente em autônomo, então a abertura identifica a assistente, o aviso é registrado e o modelo responde depois', async () => {
    await configurar('autonomo')
    await dono`INSERT INTO tenant_privacidade (tenant_id, url, versao) VALUES (${T}, 'https://loja.test/privacidade', 'v2')`
    const r = await turno([await mensagemDoCliente('oi, tem camiseta?')])
    expect(r.desfecho).toBe('respondeu')
    expect(enviados.map((e) => e.marcador)).toEqual(['agente_abertura', 'agente'])
    expect(enviados[0]!.texto).toContain('Sou Lia, assistente virtual da Loja Gatilho')
    expect(enviados[0]!.texto).toContain('https://loja.test/privacidade')
    const avisos = await dono<{ versao: string; origem: string; texto: string; mensagem_id: string }[]>`
      SELECT versao, origem, texto, mensagem_id FROM aviso_privacidade WHERE tenant_id = ${T}`
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toMatchObject({ versao: 'v2', origem: 'agente', texto: enviados[0]!.texto })

    // Segunda mensagem: o agente já falou — sem nova abertura, sem novo aviso.
    enviados.length = 0
    await turno([await mensagemDoCliente('e calça?')])
    expect(enviados.map((e) => e.marcador)).toEqual(['agente'])
    expect((await dono`SELECT 1 FROM aviso_privacidade WHERE tenant_id = ${T}`).length).toBe(1)
  })

  it('dado o envio da abertura recusado, então o aviso NUNCA é registrado e a falha fica marcada', async () => {
    await configurar('autonomo')
    envioFalha = true
    await turno([await mensagemDoCliente('oi')])
    expect((await dono`SELECT 1 FROM aviso_privacidade WHERE tenant_id = ${T}`).length).toBe(0)
    const d = await ultimaDecisao()
    expect(d.guardrails).toContainEqual(expect.objectContaining({ codigo: 'abertura_nao_enviada', gravidade: 'ALTA' }))
  })

  it('dado modo sombra, então não há abertura (o robô não fala)', async () => {
    await configurar('sombra')
    await turno([await mensagemDoCliente('oi')])
    expect(enviados).toHaveLength(0)
    expect((await dono`SELECT 1 FROM aviso_privacidade WHERE tenant_id = ${T}`).length).toBe(0)
  })
})

describe('"É robô?"', () => {
  it('1ª vez resposta fixa honesta sem modelo; 2ª vez transfere por pergunta_robo', async () => {
    await configurar('autonomo')
    // O agente já se apresentou antes (não é a primeira fala).
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'saliente', 'texto', '{"texto":"oi","automatica":"agente_abertura"}'::jsonb, 'enviada')`
    const r1 = await turno([await mensagemDoCliente('vc é um robô?')])
    expect(chamadasLlm).toBe(0)
    expect(r1.desfecho).toBe('respondeu')
    expect(enviados.at(-1)!.texto).toContain('inteligência artificial')
    const r2 = await turno([await mensagemDoCliente('é robô mesmo?')])
    expect(chamadasLlm).toBe(0)
    expect(r2.handoff?.motivo).toBe('pergunta_robo')
    expect(enviados.at(-1)!.texto).toMatch(/pessoa da equipe/)
  })

  it('na primeira fala, a abertura já responde: não repete a identificação e conta a pergunta', async () => {
    await configurar('autonomo')
    await turno([await mensagemDoCliente('isso é um bot?')])
    expect(enviados.map((e) => e.marcador)).toEqual(['agente_abertura'])
    const [s] = await dono<{ estado_agente: { gatilhos?: { perguntouRobo?: boolean } } }[]>`SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s!.estado_agente.gatilhos?.perguntouRobo).toBe(true)
  })
})

describe('Pedido de humano e reclamação', () => {
  it('dado "vou no Procon", então transfere por reclamação com aviso sem prazo, sem modelo', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('isso é um absurdo, vou no Procon')])
    expect(chamadasLlm).toBe(0)
    expect(r.handoff?.motivo).toBe('reclamacao')
    expect(enviados).toHaveLength(1)
    expect(enviados[0]!.texto).toMatch(/próximo horário de atendimento/) // canal sempre fechado
    const [a] = await dono<{ estado: string }[]>`SELECT estado FROM atendimento WHERE tenant_id = ${T}`
    expect(a!.estado).toBe('na_fila')
  })

  it('gatilho extra do número (compliance) transfere por gatilho_playbook', async () => {
    const ctx: ContextoPipeline = {
      tenantId: T, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'simulacao', agora: new Date(),
      cfgExtra: { compliance: { frasesProibidas: [], gatilhosHandoff: ['nota fiscal'] } }, persona: PERSONA_PADRAO, estado: {},
      historico: [], primeiraResposta: true, foraDoExpediente: false,
      entrantes: [{ id: crypto.randomUUID(), tipo: 'texto', texto: 'preciso da Nota Fiscal do mês', transcricaoPendente: false, transcricaoFalhou: false }],
    }
    expect(await pipeline.gatilhos.executar(ctx)).toMatchObject({ tipo: 'resposta_fixa', handoff: { motivo: 'gatilho_playbook' } })
  })
})

describe('Áudio', () => {
  it('dado áudio ainda transcrevendo, então silêncio SEM abrir sessão', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('', 'audio', { transcricao_tentativas: 0 })])
    expect(r.desfecho).toBe('silencio')
    expect(r.motivo).toBe('audio_transcrevendo')
    expect(chamadasLlm).toBe(0)
    expect(enviados).toHaveLength(0)
    expect(await sessoes()).toHaveLength(0)
  })

  it('dado áudio perdido, então o 1º pede texto e o 2º transfere por audio_sem_transcricao', async () => {
    await configurar('autonomo')
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'saliente', 'texto', '{"texto":"oi","automatica":"agente_abertura"}'::jsonb, 'enviada')`
    const r1 = await turno([await mensagemDoCliente('', 'audio', { transcricao_tentativas: 3 })])
    expect(r1.desfecho).toBe('respondeu')
    expect(enviados.at(-1)!.texto).toMatch(/por escrito/)
    const r2 = await turno([await mensagemDoCliente('', 'audio', { transcricao_tentativas: 3 })])
    expect(r2.handoff?.motivo).toBe('audio_sem_transcricao')
    expect(chamadasLlm).toBe(0)
  })
})
