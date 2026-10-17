import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { PERSONA_PADRAO } from '@geracrm/shared'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor, type DepsTurno } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { enviarTextoNaConversa, enviarTextoParaContato } from '../../envio-conversa.js'
import { etapaGatilhosEntrada } from './gatilhos-entrada.js'
import type { ContextoPipeline, EtapaPosResposta } from './tipos.js'

/**
 * GATILHOS DE ENTRADA (raia P4) — no turno de verdade, com o PIPELINE PADRÃO,
 * banco real e WhatsApp falso. A etapa não envia nada: tudo sai pelo rabo
 * comum do turno. ⚠️ Provas centrais: falso opt-out não bloqueia; depois do
 * opt-out NENHUM caminho entrega; a confirmação sai ANTES do bloqueio; o aviso
 * de privacidade só é registrado com envio aceito.
 */
const T = 'b4a40000-0000-4000-8000-000000000001'
const PV = 'b4a40000-1111-4000-8000-000000000001'
const PLANO = 'b4a40000-3333-4000-8000-000000000001'
const MODELO = 'b4a40000-4444-4000-8000-000000000001'
const CANAL = 'b4a40000-5555-4000-8000-000000000001'
const CONTATO = 'b4a40000-6666-4000-8000-000000000001'
const CONVERSA = 'b4a40000-7777-4000-8000-000000000001'
/** Contato SEM telefone (Instagram, estrangeiro sem chave). */
const CONTATO_SEM_TEL = 'b4a40000-6666-4000-8000-000000000002'
const CONVERSA_SEM_TEL = 'b4a40000-7777-4000-8000-000000000002'
const CHAVE = '5585988880401'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

/** WhatsApp falso: registra o texto e, no momento do envio, se o número JÁ estava bloqueado. */
const enviados: { texto: string; bloqueadoNaHora: boolean; conversa: string }[] = []
let envioFalha = false
const enviarFalso = (async (_t: string, conversa: string, texto: string, _n: unknown, _a: unknown, op?: { marcador?: string }) => {
  const [b] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM lista_bloqueio WHERE tenant_id = ${T}`
  enviados.push({ texto, bloqueadoNaHora: (b?.n ?? 0) > 0, conversa })
  if (envioFalha) return { ok: false, classe: 'transporte', motivo: 'provedor_fora', conversaId: conversa }
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status)
             VALUES (${T}, ${id}, ${conversa}, 'saliente', 'texto', ${JSON.stringify({ texto, automatica: op?.marcador })}::text::jsonb, 'enviada')`
  return { ok: true, conversaId: conversa, mensagemId: id }
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

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false,
          ${JSON.stringify({ nome: 'Lia', loja: 'Loja Gatilho' })}::text::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`

const mensagemDoCliente = async (texto: string, tipo = 'texto', extra: Record<string, unknown> = {}, conversa = CONVERSA): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${conversa}, 'entrante', ${tipo}, ${JSON.stringify({ texto, ...extra })}::text::jsonb, now())`
  return id
}
const turno = async (ids: string[], extra: Partial<DepsTurno> = {}, conversa = CONVERSA) => conduzirTurnoVendedor(
  { tenant_id: T, id: crypto.randomUUID(), conversa_id: conversa, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() } as Tarefa,
  { llm, ligacoes, enviar: enviarFalso, ...extra },
)
const diz = async (texto: string, extra: Partial<DepsTurno> = {}) => turno([await mensagemDoCliente(texto)], extra)
type Decisao = { desfecho: string; enviada: boolean; handoff_motivo: string | null; portao_motivo: string | null; mensagens_saida_ids: string[]; resposta: { mensagens: string[] } | null; guardrails: { codigo: string; gravidade: string; acao: string }[] }
const ultimaDecisao = async () => (await dono<Decisao[]>`
  SELECT desfecho, enviada, handoff_motivo, portao_motivo, mensagens_saida_ids, resposta, guardrails FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!
const codigos = (d: Decisao) => d.guardrails.map((g) => g.codigo)
const bloqueios = async () => (await dono`SELECT 1 FROM lista_bloqueio WHERE tenant_id = ${T}`).length
const avisos = () => dono<{ versao: string; origem: string; texto: string; mensagem_id: string }[]>`
  SELECT versao, origem, texto, mensagem_id FROM aviso_privacidade WHERE tenant_id = ${T} ORDER BY exibido_em`
/** Sessão encerrada há 30 dias: a trava de reabertura do portão já venceu, o próximo turno abre sessão nova. */
const encerrarSessoes = async () => {
  await dono`UPDATE agente_sessao SET estado = 'encerrada', motivo_saida = 'teste', encerrada_em = now() - interval '30 days'
              WHERE tenant_id = ${T} AND estado = 'ativa'`
  await dono`UPDATE agente_sessao SET encerrada_em = now() - interval '30 days' WHERE tenant_id = ${T}`
}
/** Contato com aviso VIGENTE: a abertura não aparece (para isolar os outros casos). */
const avisoVigente = () => dono`
  INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
  VALUES (${T}, gen_random_uuid(), ${CONTATO}, ${CONVERSA}, ${CANAL}, gen_random_uuid(), 'Esta conversa fica registrada.', 'padrao', 'agente')`

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
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Ana Compradora', true), (${T}, ${CONTATO_SEM_TEL}, 'Sem Telefone', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, ${CHAVE}, ${CHAVE}, true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1), (${T}, ${CONVERSA_SEM_TEL}, ${CANAL}, ${CONTATO_SEM_TEL}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0; chamadasLlm = 0; envioFalha = false
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_retorno', 'agente_sessao', 'notificacao', 'mensagem', 'atendimento', 'aviso_privacidade', 'lista_bloqueio', 'consentimento_contato', 'tenant_privacidade', 'outbox', 'alerta']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE contato SET recebe_campanhas = true, recebe_automacoes = true WHERE tenant_id = ${T}`
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_retorno', 'agente_sessao', 'agente_config', 'notificacao', 'auditoria', 'aviso_privacidade', 'lista_bloqueio', 'consentimento_contato', 'tenant_privacidade', 'atendimento', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox', 'alerta']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Opt-out em autônomo — "pare" bloqueia sem LLM, DEPOIS da confirmação', () => {
  it('confirma pelo rabo do turno, bloqueia, cancela retornos, encerra a sessão SEM fila e deixa nota + alerta', async () => {
    await configurar('autonomo')
    await avisoVigente()
    await dono`INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, ${CANAL}, 'proposta_sem_resposta', now() + interval '1 hour', 'pendente')`
    const r = await diz('PARE!')

    expect(chamadasLlm).toBe(0)
    expect(r.desfecho).toBe('respondeu')
    expect(enviados.map((e) => e.texto)).toEqual(['Certo. Não vamos mais te enviar mensagens por aqui.'])
    expect(enviados[0]!.bloqueadoNaHora).toBe(false) // a confirmação saiu ANTES do bloqueio
    const d = await ultimaDecisao()
    expect(d.enviada).toBe(true)
    expect(d.mensagens_saida_ids).toHaveLength(1)
    expect(codigos(d)).toContain('opt_out')

    const [b] = await dono<{ motivo: string; origem: string }[]>`SELECT motivo, origem FROM lista_bloqueio WHERE tenant_id = ${T} AND chave_bloqueio = ${CHAVE}`
    expect(b).toEqual({ motivo: 'opt_out', origem: 'agente' })
    const [c] = await dono<{ recebe_campanhas: boolean; recebe_automacoes: boolean }[]>`SELECT recebe_campanhas, recebe_automacoes FROM contato WHERE id = ${CONTATO}`
    expect(c).toEqual({ recebe_campanhas: false, recebe_automacoes: false })
    const [ret] = await dono<{ estado: string; detalhe: string }[]>`SELECT estado, detalhe FROM agente_retorno WHERE tenant_id = ${T}`
    expect(ret).toEqual({ estado: 'cancelado', detalhe: 'opt_out' })
    const [s] = await dono<{ estado: string }[]>`SELECT estado FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s!.estado).toBe('encerrada')
    expect((await dono`SELECT 1 FROM atendimento WHERE tenant_id = ${T}`).length).toBe(0)
    const [nota] = await dono<{ conteudo: { automatica: string; texto: string } }[]>`SELECT conteudo FROM mensagem WHERE tenant_id = ${T} AND tipo = 'sistema'`
    expect(nota!.conteudo.automatica).toBe('opt_out')
    const [al] = await dono<{ tipo: string; mensagem: string }[]>`SELECT tipo, mensagem FROM alerta WHERE tenant_id = ${T}`
    expect(al!.tipo).toBe('opt_out_cliente')
    expect(al!.mensagem).not.toContain(CHAVE)
  })

  it('retry da MESMA tarefa depois da confirmação enviada: não confirma de novo, só completa o bloqueio', async () => {
    await configurar('autonomo')
    await avisoVigente()
    const id = await mensagemDoCliente('pare')
    // A 1ª execução chegou a enviar (o gateway gravou a mensagem) e caiu antes de gravar a decisão.
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'saliente', 'texto',
                       ${JSON.stringify({ texto: 'Certo. Não vamos mais te enviar mensagens por aqui.', automatica: 'agente' })}::text::jsonb, 'enviada', now() + interval '1 second')`
    await turno([id])
    expect(enviados).toHaveLength(0)
    expect(await bloqueios()).toBe(1)
    const d = await ultimaDecisao()
    expect(codigos(d)).toContain('opt_out_confirmacao_ja_enviada')
    expect(codigos(d)).not.toContain('opt_out_confirmacao_nao_enviada')
  })

  it('"pendente" antigo (> 2 min) não prova a confirmação: no retry ela sai de novo; "pendente" recente conta', async () => {
    await configurar('autonomo')
    await avisoVigente()
    const conf = JSON.stringify({ texto: 'Certo. Não vamos mais te enviar mensagens por aqui.', automatica: 'agente' })
    // ⚠️ P0d: tudo no MESMO relógio — o `agora` injetado no turno. Antes as mensagens nasciam com o
    //    `now()` do banco e o turno usava `new Date()`: sob carga (load 30–55) o tempo real entre semear
    //    e rodar passou de 90 s e o "pendente recente" (30 s) virou "antigo" (> 2 min) — 2 de 10 rodadas.
    const agora = new Date()
    const antes = (seg: number) => new Date(agora.getTime() - seg * 1000)
    const entrante = async (seg: number) => {
      const id = crypto.randomUUID()
      await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
                 VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', '{"texto":"pare"}'::jsonb, ${antes(seg)})`
      return id
    }
    const idVelho = await entrante(600)
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'saliente', 'texto', ${conf}::text::jsonb, 'pendente', ${antes(300)})`
    await turno([idVelho], { agora })
    expect(enviados).toHaveLength(1)

    // Recente (o envio pode estar em voo): conta como enviada.
    await dono`DELETE FROM lista_bloqueio WHERE tenant_id = ${T}`
    await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
    await dono`DELETE FROM agente_sessao WHERE tenant_id = ${T}`
    enviados.length = 0
    const idNovo = await entrante(60)
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'saliente', 'texto', ${conf}::text::jsonb, 'pendente', ${antes(30)})`
    await turno([idNovo], { agora })
    expect(enviados).toHaveLength(0)
    expect(await bloqueios()).toBe(1)
  })

  it('confirmação recusada pelo gateway: o bloqueio vale assim mesmo e a falha fica marcada', async () => {
    await configurar('autonomo')
    await avisoVigente()
    envioFalha = true
    await diz('pare')
    expect(await bloqueios()).toBe(1)
    expect(codigos(await ultimaDecisao())).toContain('opt_out_confirmacao_nao_enviada')
  })

  it('depois do opt-out NENHUM caminho entrega: agente, inbox, retorno e campanha são recusados', async () => {
    await configurar('autonomo')
    await avisoVigente()
    await diz('não quero mais receber mensagens')
    enviados.length = 0
    const enviadasAntes = (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T} AND direcao = 'saliente' AND status = 'enviada'`)[0]!.n

    // 1. O próprio agente, num turno novo — logo depois (o portão pode calar antes) e em sessão nova.
    expect((await diz('oi, tem camiseta?')).desfecho).toBe('silencio')
    await encerrarSessoes()
    expect(await diz('oi de novo')).toMatchObject({ desfecho: 'silencio', motivo: 'contato_bloqueado' })
    expect(chamadasLlm).toBe(0)
    expect(enviados).toHaveLength(0)
    // 2. A etapa isolada → silêncio SEM estado.
    const ctx: ContextoPipeline = {
      tenantId: T, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'autonomo', agora: new Date(),
      cfgExtra: {}, persona: PERSONA_PADRAO, estado: {}, historico: [], primeiraResposta: true, foraDoExpediente: false,
      entrantes: [{ id: crypto.randomUUID(), tipo: 'texto', texto: 'é robô?', transcricaoPendente: false, transcricaoFalhou: false }],
    }
    expect(await etapaGatilhosEntrada.executar(ctx)).toEqual({ tipo: 'silencio', motivo: 'contato_bloqueado' })
    // 3. O gateway único (inbox/resumo de pedido/automação), o retorno (mesmo caminho, marcador 'retorno') e a campanha.
    expect(await enviarTextoNaConversa(T, CONVERSA, 'Promoção hoje.', 'Vendedora', new Date(), { ehDisparo: false }))
      .toMatchObject({ ok: false, classe: 'recusa', motivo: 'bloqueado' })
    expect(await enviarTextoNaConversa(T, CONVERSA, 'Ainda tem interesse?', null, new Date(), { ehDisparo: true, marcador: 'retorno' }))
      .toMatchObject({ ok: false, motivo: 'bloqueado' })
    expect(await enviarTextoParaContato(T, CANAL, CONTATO, 'Campanha de outubro')).toMatchObject({ ok: false, motivo: 'bloqueado' })
    const enviadasDepois = (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T} AND direcao = 'saliente' AND status = 'enviada'`)[0]!.n
    expect(enviadasDepois).toBe(enviadasAntes)
  })

  it('contato SEM telefone (Instagram/estrangeiro): o pedido fica no consentimento e o agente cala depois', async () => {
    await configurar('autonomo')
    await turno([await mensagemDoCliente('pare', 'texto', {}, CONVERSA_SEM_TEL)], {}, CONVERSA_SEM_TEL)
    expect(codigos(await ultimaDecisao())).toContain('opt_out_sem_telefone')
    expect(await bloqueios()).toBe(0)
    enviados.length = 0
    await encerrarSessoes()
    const r = await turno([await mensagemDoCliente('oi de novo', 'texto', {}, CONVERSA_SEM_TEL)], {}, CONVERSA_SEM_TEL)
    expect(r).toMatchObject({ desfecho: 'silencio', motivo: 'contato_bloqueado' })
    expect(enviados).toHaveLength(0)
  })
})

describe('Falso opt-out e falso negativo — nada novo é bloqueado sozinho', () => {
  it.each(['quero cancelar o pedido', 'cancelar', 'para quando chega?', 'não quero receber boleto, só pix', 'pare de me mandar boleto errado',
    'parem de me enviar produto vencido', 'não quero receber em caixa', 'me tira dessa lista de espera'])(
    'dado "%s", então o modelo responde e NADA é bloqueado', async (frase) => {
      await configurar('autonomo')
      await avisoVigente()
      await diz(frase)
      expect(chamadasLlm).toBe(1)
      expect(await bloqueios()).toBe(0)
    })

  it.each([
    'não quero mais receber mensagens dessa loja', 'não quero mais receber promoção de produtos',
    'para de mandar mensagem por favor, não tenho interesse em produtos', 'descadastrar meu número do whatsapp da loja',
    'para', 'Para!', 'parar', 'chega', 'não quero mais receber essas coisas', 'não aguento mais mensagem',
  ])('dado "%s" (ambíguo), então vai para uma PESSOA com possivel_opt_out — sem modelo e sem bloqueio', async (frase) => {
    await configurar('autonomo')
    await avisoVigente()
    const r = await diz(frase)
    expect(chamadasLlm).toBe(0)
    expect(r.handoff?.motivo).toBe('incerteza')
    expect(await bloqueios()).toBe(0)
    const d = await ultimaDecisao()
    expect(d.guardrails).toContainEqual(expect.objectContaining({ codigo: 'possivel_opt_out', gravidade: 'ALTA' }))
    expect((await dono`SELECT 1 FROM atendimento WHERE tenant_id = ${T}`).length).toBe(1)
  })

  it.each(['pare por favor', 'pare, obrigado', 'não quero mais mensagens', 'chega de propaganda', 'não me manda mais', 'quero sair da lista',
    'quero parar de receber as mensagens', 'chega de spam', 'nao quero mais ser contatado', 'me bloqueia', 'desinscrever'])(
    'dado "%s" (explícito), então bloqueia', async (frase) => {
      await configurar('autonomo')
      await avisoVigente()
      await diz(frase)
      expect(chamadasLlm).toBe(0)
      expect(await bloqueios()).toBe(1)
    })
})

describe('Opt-out fora do autônomo — o modo diz quem age (ADR-028)', () => {
  it('sombra: só registra a marca; nada enviado, nada bloqueado', async () => {
    await configurar('sombra')
    await diz('pare')
    expect(enviados).toHaveLength(0)
    expect(await bloqueios()).toBe(0)
    const d = await ultimaDecisao()
    expect(d.guardrails).toContainEqual(expect.objectContaining({ codigo: 'opt_out', acao: 'registrado' }))
  })

  it('assistido: sugere a confirmação com o aviso "confirme"; o bloqueio fica com o humano', async () => {
    await configurar('assistido')
    const r = await diz('pare')
    expect(r.desfecho).toBe('sugeriu')
    expect(enviados).toHaveLength(0)
    expect(await bloqueios()).toBe(0)
    const d = await ultimaDecisao()
    expect(d.resposta!.mensagens).toEqual(['Certo. Não vamos mais te enviar mensagens por aqui.'])
    expect(d.guardrails).toContainEqual(expect.objectContaining({ codigo: 'opt_out_confirmar', gravidade: 'ALTA' }))
    expect((await dono`SELECT 1 FROM outbox WHERE tenant_id = ${T} AND tipo = 'agente.sugestao'`).length).toBe(1)
    // Visível antes da P13: nota de sistema na conversa + alerta, sem bloqueio.
    const [nota] = await dono<{ conteudo: { automatica: string; texto: string } }[]>`SELECT conteudo FROM mensagem WHERE tenant_id = ${T} AND tipo = 'sistema'`
    expect(nota!.conteudo).toMatchObject({ automatica: 'opt_out_confirmar' })
    expect(nota!.conteudo.texto).toMatch(/confirme/)
    const [al] = await dono<{ tipo: string }[]>`SELECT tipo FROM alerta WHERE tenant_id = ${T}`
    expect(al!.tipo).toBe('opt_out_confirmar')
  })
})

describe('Abertura e aviso de privacidade', () => {
  it('sessão nova: a abertura vai como PREFIXO pelo rabo do turno, e o aviso é registrado com o id da mensagem aceita', async () => {
    await configurar('autonomo')
    await dono`INSERT INTO tenant_privacidade (tenant_id, url, versao) VALUES (${T}, 'https://loja.test/privacidade', 'v2')`
    const r = await diz('oi, tem camiseta?')
    expect(r.desfecho).toBe('respondeu')
    expect(chamadasLlm).toBe(1)
    expect(enviados).toHaveLength(2)
    expect(enviados[0]!.texto).toContain('Sou Lia, assistente virtual da Loja Gatilho')
    expect(enviados[0]!.texto).toContain('https://loja.test/privacidade')
    expect(enviados[1]!.texto).toBe('Posso te ajudar com os produtos.')
    const d = await ultimaDecisao()
    expect(d.enviada).toBe(true)
    expect(d.resposta!.mensagens[0]).toBe(enviados[0]!.texto)
    const a = await avisos()
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ versao: 'v2', origem: 'agente', texto: enviados[0]!.texto, mensagem_id: d.mensagens_saida_ids[0] })

    // Mesma sessão: sem nova abertura.
    enviados.length = 0
    await diz('e calça?')
    expect(enviados.map((e) => e.texto)).toEqual(['Posso te ajudar com os produtos.'])
    expect(await avisos()).toHaveLength(1)
  })

  it('a abertura passa pelo filtro de saída (P2) como qualquer texto que sai', async () => {
    await configurar('autonomo')
    const filtro: EtapaPosResposta = { nome: 'filtro', async executar(_c, e) { return { mensagens: e.mensagens.map((m) => `${m} [filtrado]`), guardrails: [] } } }
    await diz('oi', { pipeline: { filtro } })
    expect(enviados[0]!.texto).toMatch(/assistente virtual.*\[filtrado\]$/)
  })

  it('envio recusado: o aviso NUNCA é registrado', async () => {
    await configurar('autonomo')
    envioFalha = true
    await diz('oi')
    expect(await avisos()).toHaveLength(0)
  })

  it('nova sessão: sem abertura com aviso vigente; com abertura se a versão mudou ou o aviso passou de 180 dias', async () => {
    await configurar('autonomo')
    await diz('oi')
    expect(await avisos()).toHaveLength(1)

    await encerrarSessoes(); enviados.length = 0
    await diz('voltei')
    expect(enviados).toHaveLength(1) // só a resposta: aviso vigente

    await encerrarSessoes(); enviados.length = 0
    await dono`INSERT INTO tenant_privacidade (tenant_id, versao) VALUES (${T}, 'v3')`
    await diz('voltei de novo')
    expect(enviados).toHaveLength(2)
    expect((await avisos()).map((x) => x.versao)).toEqual(['padrao', 'v3'])

    await encerrarSessoes(); enviados.length = 0
    await dono`DELETE FROM aviso_privacidade WHERE tenant_id = ${T}`
    await dono`INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem, exibido_em)
               VALUES (${T}, gen_random_uuid(), ${CONTATO}, ${CONVERSA}, ${CANAL}, gen_random_uuid(), 'antigo', 'v3', 'agente', now() - interval '181 days')`
    await diz('faz tempo')
    expect(enviados).toHaveLength(2)
  })

  it('a condição é o aviso vigente, não a sessão nova: sessão que nasceu em sombra recebe a abertura ao virar autônomo', async () => {
    await configurar('sombra')
    await diz('oi')
    expect(enviados).toHaveLength(0)
    await configurar('autonomo')
    await diz('e o prazo?')
    expect(enviados).toHaveLength(2)
    expect(enviados[0]!.texto).toContain('assistente virtual')
    expect(await avisos()).toHaveLength(1)
  })

  it('na MESMA sessão a abertura não se repete — nem quando o tenant troca a versão no meio (fica para a próxima sessão)', async () => {
    await configurar('autonomo')
    await diz('oi')
    enviados.length = 0
    await dono`INSERT INTO tenant_privacidade (tenant_id, versao) VALUES (${T}, 'v9')`
    await diz('e o frete?')
    expect(enviados.map((e) => e.texto)).toEqual(['Posso te ajudar com os produtos.'])
    const [s] = await dono<{ estado_agente: { gatilhos?: { aberturaFeita?: boolean } } }[]>`SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T} AND estado = 'ativa'`
    expect(s!.estado_agente.gatilhos?.aberturaFeita).toBe(true)
  })

  it('aberturaFeita só com a abertura de fato enviada (igualdade com as fatias): resposta que cita um trecho não conta', async () => {
    await configurar('autonomo')
    // O filtro troca a abertura inteira: nenhuma mensagem enviada é fatia dela, e a resposta só a cita em parte.
    const filtro: EtapaPosResposta = { nome: 'filtro', async executar(_c, e) {
      return { mensagens: e.mensagens.map((m) => (m.includes('assistente virtual') ? 'Oi!' : m)), guardrails: [] }
    } }
    await diz('oi', { pipeline: { filtro } })
    const [s] = await dono<{ estado_agente: { gatilhos?: { aberturaFeita?: boolean } } }[]>`SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s!.estado_agente.gatilhos?.aberturaFeita).toBeUndefined()
    expect(codigos(await ultimaDecisao())).toContain('abertura_nao_enviada')
  })

  it('aviso com valor (gravado fora da tela): a rede descarta SÓ a abertura; a resposta sai e não vira handoff', async () => {
    await configurar('autonomo')
    await dono`INSERT INTO tenant_privacidade (tenant_id, versao, texto_padrao) VALUES (${T}, 'v1', 'Frete grátis acima de R$ 500,00.')`
    const r = await diz('oi')
    expect(r.desfecho).toBe('respondeu')
    expect(enviados.map((e) => e.texto)).toEqual(['Posso te ajudar com os produtos.'])
    const d = await ultimaDecisao()
    expect(d.guardrails).toContainEqual(expect.objectContaining({ codigo: 'valor_sem_fonte', acao: 'removido' }))
    expect(d.handoff_motivo).toBeNull()
  })

  it('mensagens antigas do agente (antes da P4) não contam como "já viu o aviso"', async () => {
    await configurar('autonomo')
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'saliente', 'texto', '{"texto":"Oi! Posso ajudar?","automatica":"agente"}'::jsonb, 'enviada', now() - interval '30 days')`
    await diz('oi')
    expect(enviados[0]!.texto).toContain('assistente virtual')
  })

  it('simulação MOSTRA a abertura sem enviar nem registrar; sombra não abre', async () => {
    await configurar('autonomo')
    const r = await diz('oi', { simulacao: true })
    expect(enviados).toHaveLength(0)
    expect(r.mensagens![0]).toContain('assistente virtual')
    expect(await avisos()).toHaveLength(0)

    await configurar('sombra')
    await diz('oi')
    expect(enviados).toHaveLength(0)
    expect((await ultimaDecisao()).resposta!.mensagens).toEqual(['Posso te ajudar com os produtos.'])
  })
})

describe('"É robô?"', () => {
  it('1ª vez resposta fixa honesta sem modelo; 2ª vez transfere por pergunta_robo', async () => {
    await configurar('autonomo')
    await avisoVigente()
    const r1 = await diz('vc é um robô?')
    expect(chamadasLlm).toBe(0)
    expect(r1.desfecho).toBe('respondeu')
    expect(enviados.at(-1)!.texto).toContain('inteligência artificial')
    const r2 = await diz('é robô mesmo?')
    expect(chamadasLlm).toBe(0)
    expect(r2.handoff?.motivo).toBe('pergunta_robo')
    expect(enviados.at(-1)!.texto).toMatch(/pessoa da equipe/)
  })

  it('na primeira fala, a abertura já responde: não repete a identificação, conta a pergunta e registra o aviso', async () => {
    await configurar('autonomo')
    await diz('isso é um bot?')
    expect(enviados).toHaveLength(1)
    expect(enviados[0]!.texto).toContain('assistente virtual')
    expect(await avisos()).toHaveLength(1)
    const [s] = await dono<{ estado_agente: { gatilhos?: { perguntouRobo?: boolean } } }[]>`SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T}`
    expect(s!.estado_agente.gatilhos?.perguntouRobo).toBe(true)
  })

  it('"a máquina de cartão quebrou?" não é pergunta sobre a assistente', async () => {
    await configurar('autonomo')
    await avisoVigente()
    await diz('a máquina de cartão quebrou?')
    expect(chamadasLlm).toBe(1)
  })
})

describe('Pedido de humano e ameaça formal', () => {
  it('dado "vou no Procon", então transfere por reclamação com aviso sem prazo, sem modelo', async () => {
    await configurar('autonomo')
    await avisoVigente()
    const r = await diz('isso é um absurdo, vou no Procon')
    expect(chamadasLlm).toBe(0)
    expect(r.handoff?.motivo).toBe('reclamacao')
    expect(enviados).toHaveLength(1)
    expect(enviados[0]!.texto).toMatch(/próximo horário de atendimento/) // canal sempre fechado
    const [a] = await dono<{ estado: string }[]>`SELECT estado FROM atendimento WHERE tenant_id = ${T}`
    expect(a!.estado).toBe('na_fila')
  })

  it('"pode processar o pedido" e "o técnico me liga depois" seguem com o modelo', async () => {
    await configurar('autonomo')
    await avisoVigente()
    await diz('pode processar o pedido')
    await diz('o técnico me liga depois')
    expect(chamadasLlm).toBe(2)
  })

  it('gatilho extra do número (compliance) transfere por gatilho_playbook', async () => {
    const ctx: ContextoPipeline = {
      tenantId: T, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'simulacao', agora: new Date(),
      cfgExtra: { compliance: { frasesProibidas: [], gatilhosHandoff: ['nota fiscal'] } }, persona: PERSONA_PADRAO, estado: {},
      historico: [], primeiraResposta: true, foraDoExpediente: false,
      entrantes: [{ id: crypto.randomUUID(), tipo: 'texto', texto: 'preciso da Nota Fiscal do mês', transcricaoPendente: false, transcricaoFalhou: false }],
    }
    expect(await etapaGatilhosEntrada.executar(ctx)).toMatchObject({ tipo: 'resposta_fixa', handoff: { motivo: 'gatilho_playbook' } })
  })
})

describe('Áudio', () => {
  it('dado áudio ainda transcrevendo, então silêncio SEM abrir sessão', async () => {
    await configurar('autonomo')
    const r = await turno([await mensagemDoCliente('', 'audio', { transcricao_tentativas: 0 })])
    expect(r).toMatchObject({ desfecho: 'silencio', motivo: 'audio_transcrevendo' })
    expect(chamadasLlm).toBe(0)
    expect(enviados).toHaveLength(0)
    expect((await dono`SELECT 1 FROM agente_sessao WHERE tenant_id = ${T}`).length).toBe(0)
  })

  it('dado áudio perdido, então o 1º pede texto e o 2º transfere por audio_sem_transcricao', async () => {
    await configurar('autonomo')
    const r1 = await turno([await mensagemDoCliente('', 'audio', { transcricao_tentativas: 3 })])
    expect(r1.desfecho).toBe('respondeu')
    expect(enviados.at(-1)!.texto).toMatch(/por escrito/)
    const r2 = await turno([await mensagemDoCliente('', 'audio', { transcricao_tentativas: 3 })])
    expect(r2.handoff?.motivo).toBe('audio_sem_transcricao')
    expect(chamadasLlm).toBe(0)
  })
})
