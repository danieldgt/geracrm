import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'
import { etapaRegrasQualidade } from './regras-qualidade.js'

/**
 * PAUSA EM CRÍTICA (ADR-031 §3, raia P12) — o turno de verdade (banco real,
 * WhatsApp falso), com o LLM falso escrevendo uma violação que as etapas
 * anteriores NÃO pegam ("sem nota fiscal" é da lista B2B da qualidade, não do
 * filtro P2). Prova:
 *   - autônomo: a resposta crítica NÃO sai, a conversa vai ao humano
 *     (`qualidade_violacao_critica`) sem mensagem extra, e o alerta abre;
 *   - assistido: a sugestão fica, marcada "não envie", com alerta;
 *   - simulação: pausa igual ao autônomo (o playground mostra o real), sem alerta;
 *   - resposta limpa: sai, sem marca; MEDIA só registra.
 *
 * ⚠️ Não depende do nº exato de mensagens enviadas: com a P4 a 1ª resposta de
 *    sessão em autônomo pode sair com a abertura antes ([abertura, resposta]).
 */
const T = 'c0de1200-0000-4000-8000-000000000001'
const PV = 'c0de1200-1111-4000-8000-000000000001'
const PLANO = 'c0de1200-3333-4000-8000-000000000001'
const MODELO = 'c0de1200-4444-4000-8000-000000000001'
const CANAL = 'c0de1200-5555-4000-8000-000000000001'
const CONTATO = 'c0de1200-6666-4000-8000-000000000001'
const CONVERSA = 'c0de1200-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })

function llmQueDiz(mensagens: string[]): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> {
      return { ok: true, saida: { mensagens, confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    } }
}

const CRITICA = 'Dá para fazer sem nota fiscal, fica mais barato.'

const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias úteis.', false, false, '{"nome":"Lia","loja":"Loja Qualidade"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`

const tarefaPara = async (texto: string): Promise<Tarefa> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return { tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [id], tentativas: 1, executar_em: new Date() }
}
const turno = async (resposta: string[], simulacao = false) => {
  const tarefa = await tarefaPara('tem caixa de papelão?')
  return conduzirTurnoVendedor(tarefa, { llm: llmQueDiz(resposta), ligacoes, enviar: enviarFalso, simulacao })
}
const ultimaDecisao = async () => (await dono<{
  desfecho: string; handoff_motivo: string | null; enviada: boolean; mensagens_saida_ids: string[]; resposta: { mensagens: string[] } | null
  guardrails: { etapa: string; codigo: string; gravidade: string; acao: string; trecho?: string }[]
}[]>`SELECT desfecho, handoff_motivo, enviada, mensagens_saida_ids, resposta, guardrails FROM agente_decisao WHERE tenant_id = ${T} ORDER BY criado_em DESC LIMIT 1`)[0]!
const alertas = async () => dono<{ tipo: string; severidade: string; mensagem: string }[]>`
  SELECT tipo, severidade, mensagem FROM alerta WHERE tenant_id = ${T} AND resolvido_em IS NULL
     AND tipo IN ('agente_violacao_critica', 'agente_qualidade_teto')`
const atendimentos = async () => (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${T} AND estado <> 'encerrado'`)[0]!.n
const daQualidade = <M extends { etapa: string }>(g: M[]): M[] => g.filter((x) => x.etapa === 'regras-qualidade')

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-qualidade-turno', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-qualidade-turno', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Qualidade Turno', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente Qualidade', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATO}, 1, '5585999991277', '5585999991277', true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  enviados.length = 0
  for (const t of ['aviso_privacidade', 'agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem', 'alerta', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
})
afterAll(async () => {
  for (const t of ['aviso_privacidade', 'agente_avaliacao', 'agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'mensagem', 'alerta', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('Etapa isolada: mesmo estoqueComFonte do P2', () => {
  it('"poucas unidades" com saldo BAIXO visto no turno (saldoBaixoVisto, P0c) não é CRÍTICA; sem ele, é', async () => {
    const ctx = { tenantId: T, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'assistido', agora: new Date(),
      cfgExtra: {}, persona: {} as never, estado: {}, historico: [], entrantes: [], primeiraResposta: false, foraDoExpediente: false } as const
    const base = { handoff: null, centavosVistos: new Set<number>(), numerosVistos: new Set<number>(), falasAnterioresDoAgente: [] }
    const msg = ['Temos sim, restam poucas unidades em estoque.']
    const com = await etapaRegrasQualidade.executar(ctx as never, { ...base, mensagens: msg, saldoBaixoVisto: true } as never)
    expect(com.guardrails.filter((g) => g.gravidade === 'CRITICA')).toEqual([])
    const sem = await etapaRegrasQualidade.executar(ctx as never, { ...base, mensagens: msg } as never)
    expect(sem.guardrails.some((g) => g.gravidade === 'CRITICA')).toBe(true)
    // Saldo visto mas NÃO baixo (ou o nome antigo do campo) não abona a escassez.
    const naoBaixo = await etapaRegrasQualidade.executar(ctx as never, { ...base, mensagens: msg, saldoBaixoVisto: false, saldoDeEstoqueVisto: true } as never)
    expect(naoBaixo.guardrails.some((g) => g.gravidade === 'CRITICA')).toBe(true)
    await dono`DELETE FROM alerta WHERE tenant_id = ${T}`
  })
})

describe('Etapa isolada: número abonado só pela memória do contato (P0c)', () => {
  it('não é violação, mas fica a marca INFO numero_da_memoria; sem a memória, é ALTA', async () => {
    const ctx = { tenantId: T, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'assistido', agora: new Date(),
      cfgExtra: {}, persona: {} as never, estado: {}, historico: [], entrantes: [], primeiraResposta: false, foraDoExpediente: false } as const
    const base = { handoff: null, centavosVistos: new Set<number>(), numerosVistos: new Set<number>(), falasAnterioresDoAgente: [] }
    const msg = ['Posso separar 37 unidades para você.']
    const com = await etapaRegrasQualidade.executar(ctx as never, { ...base, mensagens: msg, numerosDoCliente: new Set([37]) })
    expect(com.guardrails.map((g) => [g.codigo, g.gravidade])).toEqual([['numero_da_memoria', 'INFO']])
    const sem = await etapaRegrasQualidade.executar(ctx as never, { ...base, mensagens: msg })
    expect(sem.guardrails.map((g) => [g.codigo, g.gravidade])).toEqual([['numero_sem_fonte', 'ALTA']])
  })
})

describe('Regras de qualidade no turno (P12)', () => {
  it('autônomo: violação CRÍTICA não sai, transfere com qualidade_violacao_critica sem mensagem extra, e alerta', async () => {
    await configurar('autonomo')
    const r = await turno([CRITICA])
    expect(r.desfecho).toBe('handoff')
    expect(enviados.some((t) => /nota fiscal/i.test(t))).toBe(false)
    // NADA sai — nem a abertura da P4 (decisão b da revisão): ela é descartada e marcada.
    expect(enviados).toEqual([])
    const d = await ultimaDecisao()
    // ⚠️ `enviada` sai true em autônomo mesmo sem mensagem (vendedor.ts, pendência P0c); o que vale é não ter saída.
    expect(d).toMatchObject({ desfecho: 'handoff', handoff_motivo: 'qualidade_violacao_critica', mensagens_saida_ids: [] })
    expect(d.resposta!.mensagens).toEqual([])
    expect(daQualidade(d.guardrails).filter((g) => g.codigo !== 'abertura_descartada_pausa')).toEqual([
      expect.objectContaining({ codigo: 'palavra_proibida', gravidade: 'CRITICA', acao: 'registrado' }),
      { etapa: 'regras-qualidade', codigo: 'qualidade_violacao_critica', gravidade: 'CRITICA', acao: 'handoff' },
    ])
    // O contato não tem aviso de privacidade vigente: a P4 montou a abertura — e ela foi descartada.
    expect(d.guardrails).toContainEqual({ etapa: 'regras-qualidade', codigo: 'abertura_descartada_pausa', gravidade: 'INFO', acao: 'removido' })
    expect((await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM aviso_privacidade WHERE tenant_id = ${T}`)[0]!.n).toBe(0)
    expect(await atendimentos()).toBe(1)
    const a = await alertas()
    expect(a).toEqual([expect.objectContaining({ tipo: 'agente_violacao_critica', severidade: 'critico' })])
    expect(a[0]!.mensagem).not.toMatch(/nota fiscal, fica/) // o alerta não carrega o texto
  })

  it('assistido: a sugestão fica, marcada "não envie", com alerta — e nada é enviado', async () => {
    await configurar('assistido')
    const r = await turno([CRITICA])
    expect(r.desfecho).toBe('sugeriu')
    expect(enviados).toEqual([])
    const d = await ultimaDecisao()
    expect(d.resposta!.mensagens).toEqual([CRITICA])
    expect(daQualidade(d.guardrails).map((g) => [g.codigo, g.gravidade, g.acao])).toEqual([
      ['palavra_proibida', 'CRITICA', 'registrado'], ['nao_envie', 'CRITICA', 'bloqueado'],
    ])
    expect((await alertas()).map((x) => x.tipo)).toEqual(['agente_violacao_critica'])
    expect(await atendimentos()).toBe(0)
  })

  it('simulação: pausa como o autônomo, mas não abre alerta (é o playground)', async () => {
    await configurar('autonomo')
    const r = await turno([CRITICA], true)
    expect(r.desfecho).toBe('handoff')
    expect(r).toMatchObject({ mensagens: [] })
    expect(enviados).toEqual([])
    expect(await alertas()).toEqual([])
  })

  it('resposta limpa sai sem marca; várias perguntas só registram MEDIA e saem', async () => {
    await configurar('autonomo')
    await turno(['Temos sim! Quantas caixas você precisa?'])
    expect(enviados.some((t) => t.includes('Quantas caixas'))).toBe(true)
    expect(daQualidade((await ultimaDecisao()).guardrails)).toEqual([])

    enviados.length = 0
    const r = await turno(['Temos sim! Qual o tamanho? E a quantidade?'])
    expect(r.desfecho).toBe('respondeu')
    expect(enviados.some((t) => t.includes('Qual o tamanho'))).toBe(true)
    expect(daQualidade((await ultimaDecisao()).guardrails).map((g) => [g.codigo, g.gravidade])).toEqual([['multiplas_perguntas', 'MEDIA']])
    expect(await alertas()).toEqual([])
  })

  it('frase proibida que o filtro P2 já tirou NÃO pausa (foi corrigida antes de sair)', async () => {
    await configurar('autonomo')
    const r = await turno(['Temos sim. Garantimos entrega amanhã.'])
    expect(r.desfecho).toBe('respondeu')
    expect(enviados.some((t) => /garantimos/i.test(t))).toBe(false)
    const d = await ultimaDecisao()
    expect(d.guardrails.some((g) => g.etapa === 'filtro-saida' && g.gravidade === 'CRITICA')).toBe(true)
    expect(daQualidade(d.guardrails).filter((g) => g.gravidade === 'CRITICA')).toEqual([])
    expect(await alertas()).toEqual([])
  })
})
