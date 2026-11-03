import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { playbookPadrao, type ConteudoPlaybook, type ObjecaoPlaybook } from '@geracrm/shared'
import { criarApp } from '../../../app.js'
import { comTenantServico, encerrarBanco } from '../../../db/index.js'
import { conduzirTurnoVendedor } from './vendedor.js'
import { ligacoesPadrao } from './ferramentas/ligacoes.js'
import { montarFerramentas } from './ferramentas/montar.js'
import { gravarObjecoesDoTurno } from './objecoes.js'
import { ferramentaRegistrarObjecao } from './ferramentas/objecao.js'
import { registroDeFerramentas, type ContextoFerramenta } from './ferramentas/porta.js'
import type { Ligacoes } from './ferramentas/ligacoes-porta.js'
import type { ChamadaRegistrada, PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco } from './porta-llm.js'
import { blocoObjecoes, instrucoesDoPlaybook } from './instrucao-vendedor.js'
import { criarEtapaObjecoesSeguidas } from './pipeline/objecoes-seguidas.js'
import { violacoesDoTurno } from './pipeline/regras-qualidade.js'
import { ligacoesDoSandbox } from './playbook/simulacao.js'
import type { ContextoPipeline, EntradaPosResposta } from './pipeline/tipos.js'

/**
 * OBJEÇÕES (raia G2) — ferramenta `registrar_objecao`, etapa `objecoes-seguidas`,
 * regra de qualidade e o resumo, no banco real com dois tenants.
 *
 *   - a ferramenta grava o fato (autônomo/assistido), recusa código desconhecido
 *     com erro tipificado e é seca em sombra/simulação/copiloto;
 *   - a etapa entrega ao humano na 3ª NÃO revertida seguida; revertida zera;
 *   - ação desligada no playbook tira a ferramenta do menu;
 *   - o resumo agrega por código, sob RLS.
 */
const A = 'a6200000-0000-4000-8000-000000000001'
const B = 'a6200000-0000-4000-8000-000000000002'
const PV_A = 'a6200000-1111-4000-8000-000000000001'
const PV_B = 'a6200000-1111-4000-8000-000000000002'
const PLANO = 'a6200000-3333-4000-8000-000000000001'
const MODELO = 'a6200000-4444-4000-8000-000000000001'
const CANAL = 'a6200000-5555-4000-8000-000000000001'
const CANAL_SOMBRA = 'a6200000-5555-4000-8000-000000000002'
const CANAL_ASSIST = 'a6200000-5555-4000-8000-000000000003'
const CANAL_B = 'a6200000-5555-4000-8000-000000000009'
const CONTATO = 'a6200000-6666-4000-8000-000000000001'
const CONTATO_B = 'a6200000-6666-4000-8000-000000000009'
const CONVERSA = 'a6200000-7777-4000-8000-000000000001'
const CONVERSA_SOMBRA = 'a6200000-7777-4000-8000-000000000002'
const CONVERSA_ASSIST = 'a6200000-7777-4000-8000-000000000003'
const CONVERSA_B = 'a6200000-7777-4000-8000-000000000009'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
const chamar = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } })

const CARO: ObjecaoPlaybook = {
  codigo: 'OBJ-01', ativo: true, objecao: 'Achou caro', gatilhos: ['caro', 'muito caro'],
  resposta: 'Entendo a preocupação com o investimento. Posso mostrar opções do catálogo que cabem melhor no orçamento da loja?',
}
const PENSAR: ObjecaoPlaybook = {
  codigo: 'OBJ-02', ativo: true, objecao: 'Vai pensar', gatilhos: ['vou pensar'],
  resposta: 'Claro, sem pressa. Quer que eu deixe um resumo pronto para você decidir com calma?',
}
const INATIVA: ObjecaoPlaybook = { ...PENSAR, codigo: 'OBJ-03', ativo: false, objecao: 'Já compra de outro', gatilhos: ['outro fornecedor'] }

function conteudo(o: { objecoes?: ObjecaoPlaybook[]; acaoObjecoes?: boolean } = {}): ConteudoPlaybook {
  const c = playbookPadrao()
  return { ...c, objecoes: o.objecoes ?? [CARO, PENSAR, INATIVA], acoes: { ...c.acoes, objecoes: o.acaoObjecoes ?? true } }
}
const espelho = (c: ConteudoPlaybook) => ({ versaoId: crypto.randomUUID(), numero: 3, escopo: 'numero', publicadaEm: new Date().toISOString(), conteudo: c })

async function publicarNoEspelho(canal: string, c: ConteudoPlaybook): Promise<void> {
  await dono`UPDATE agente_config SET playbook = ${JSON.stringify(espelho(c))}::text::jsonb WHERE tenant_id = ${A} AND canal_id = ${canal}`
}

async function msg(t: string, conversa: string, texto: string): Promise<string> {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${t}, ${id}, ${conversa}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return id
}

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true as const, mensagemId: crypto.randomUUID() }
}) as never

/** Modelo falso que registra as objeções dadas e responde; guarda o menu de ferramentas de cada chamada. */
function llmQueRegistra(registros: { codigo: string; revertida: boolean }[], mensagens: string[]) {
  const menus: string[][] = []
  const resultados: ChamadaRegistrada[] = []
  const porta: PortaLlmFerramentas = {
    nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(p: PedidoDeLaco): Promise<ResultadoLaco> {
      menus.push(p.ferramentas.map((f) => f.nome))
      const chamadas: ChamadaRegistrada[] = []
      for (const r of registros) {
        if (!p.ferramentas.some((f) => f.nome === 'registrar_objecao')) break
        const s = await p.executar('registrar_objecao', { ...r, observacao: null })
        const c = { nome: 'registrar_objecao', entrada: r, saida: s.ok ? s.saida : null, ms: 1, ...(s.ok ? {} : { erro: s.erro }) }
        chamadas.push(c); resultados.push(c)
      }
      return { ok: true, saida: { mensagens, confianca: 0.9 }, rastro: { chamadas, rodadas: 1, uso: { entrada: 1, saida: 1, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    },
  }
  return { porta, menus, resultados }
}

const turno = (conversa: string, canal: string, ids: string[], llm: PortaLlmFerramentas) => conduzirTurnoVendedor(
  { tenant_id: A, id: crypto.randomUUID(), conversa_id: conversa, canal_id: canal, mensagens_ids: ids, tentativas: 1, executar_em: new Date() },
  { llm, ligacoes: ligacoesPadrao, enviar: enviarFalso },
)

const ctxFerr = (modo: string): ContextoFerramenta => ({
  tenantId: A, conversaId: CONVERSA, contatoId: CONTATO, canalId: CANAL, perfil: 'varejo' as never, sessaoId: null, modo: modo as never, agora: new Date(),
})
const contarFatos = async (t = A) => (await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_objecao WHERE tenant_id = ${t}`)[0]!.n

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.IA_PROVEDOR = 'simulado'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-objecoes-g2', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-objecoes-g2', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`Objecoes ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  const fechado = JSON.stringify({ seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null })
  for (const [t, c, modo] of [[A, CANAL, 'autonomo'], [A, CANAL_SOMBRA, 'sombra'], [A, CANAL_ASSIST, 'assistido'], [B, CANAL_B, 'autonomo']] as const) {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${c}, 'whatsapp_nao_oficial', 'Loja', 'conectado')`
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${t}, ${c}, ${fechado}::text::jsonb)`
    await dono`
      INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona)
      VALUES (${t}, ${c}, true, ${modo}, 'Vendemos confecção no atacado.', false, false,
              ${JSON.stringify({ nome: 'Lia', loja: 'Atacado Sol', tom: 'neutro', usaEmojis: false })}::text::jsonb)`
  }
  for (const [t, contato, conversa, canal] of [[A, CONTATO, CONVERSA, CANAL], [A, CONTATO, CONVERSA_SOMBRA, CANAL_SOMBRA], [A, CONTATO, CONVERSA_ASSIST, CANAL_ASSIST], [B, CONTATO_B, CONVERSA_B, CANAL_B]] as const) {
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${contato}, 'Ana Cliente', true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conversa}, ${canal}, ${contato}, 1)`
    await dono`INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
               VALUES (${t}, ${crypto.randomUUID()}, ${contato}, ${conversa}, ${canal}, ${crypto.randomUUID()}, 'aviso', 'padrao', 'agente')`
  }
  await publicarNoEspelho(CANAL, conteudo())
  await publicarNoEspelho(CANAL_SOMBRA, conteudo())
  await publicarNoEspelho(CANAL_ASSIST, conteudo())
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  for (const t of [A, B]) {
    for (const tab of ['agente_objecao', 'agente_avaliacao', 'agente_decisao', 'agente_sessao', 'agente_tarefa', 'atendimento', 'notificacao', 'aviso_privacidade',
      'cliente_memoria', 'pedido', 'mensagem', 'conversa', 'contato', 'agente_config', 'usuario_filial', 'usuario', 'canal_configuracao', 'canal_conectado', 'outbox', 'alerta', 'auditoria']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app?.close(); await encerrarBanco(); await dono.end()
})

describe('Ferramenta registrar_objecao', () => {
  beforeEach(async () => { await dono`DELETE FROM agente_objecao WHERE tenant_id = ${A}` })

  it('dado código ativo, então devolve o registro do turno (com texto e observação) e NÃO grava: a gravação é do turno confirmado', async () => {
    const f = ferramentaRegistrarObjecao([CARO, PENSAR])
    const r = await f.executar(ctxFerr('autonomo'), { codigo: 'obj-01', revertida: false, observacao: 'achou caro' } as never)
    expect(r).toMatchObject({ ok: true, saida: { registrada: true, codigo: 'OBJ-01', revertida: false }, objecao: { codigo: 'OBJ-01', revertida: false, objecao: 'Achou caro', observacao: 'achou caro' } })
    expect(await contarFatos()).toBe(0)
  })

  it('dado o mesmo código duas vezes no turno, então a 2ª é ok idempotente e não empilha de novo nos efeitos', async () => {
    const reg = registroDeFerramentas(ctxFerr('autonomo'), [ferramentaRegistrarObjecao([CARO, PENSAR])])
    const a = await reg.executar('registrar_objecao', { codigo: 'OBJ-01', revertida: false, observacao: null })
    const b = await reg.executar('registrar_objecao', { codigo: 'OBJ-01', revertida: false, observacao: null })
    expect(a).toMatchObject({ ok: true }); expect(b).toMatchObject({ ok: true, saida: { registrada: true, codigo: 'OBJ-01' } })
    await reg.executar('registrar_objecao', { codigo: 'OBJ-02', revertida: true, observacao: null })
    expect(reg.efeitos.objecoes.map((o) => o.codigo)).toEqual(['OBJ-01', 'OBJ-02'])
  })

  it('gravarObjecoesDoTurno: autônomo e assistido gravam (observação mascarada), um fato por código; sombra/simulação/copiloto não', async () => {
    const objecoes = [
      { codigo: 'OBJ-01', revertida: false, objecao: 'Achou caro', observacao: 'cliente do 5585988887777 achou caro' },
      { codigo: 'OBJ-01', revertida: false, objecao: 'Achou caro' },
    ]
    const base = { canalId: CANAL, conversaId: CONVERSA, contatoId: CONTATO, sessaoId: null, agora: new Date(), objecoes }
    for (const modo of ['sombra', 'simulacao', 'copiloto']) await comTenantServico(A, (tx) => gravarObjecoesDoTurno(tx, { ...base, modo }))
    expect(await contarFatos()).toBe(0)
    await comTenantServico(A, (tx) => gravarObjecoesDoTurno(tx, { ...base, modo: 'assistido' }))
    expect(await contarFatos()).toBe(1)
    const [l] = await dono<{ objecao: string; observacao: string }[]>`SELECT objecao, observacao FROM agente_objecao WHERE tenant_id = ${A}`
    expect(l!.objecao).toBe('Achou caro')
    expect(l!.observacao).not.toContain('5585988887777')
  })

  it('dado código inexistente (ou inativo) no playbook, então erro tipificado "codigo_desconhecido" e nada gravado', async () => {
    const f = ferramentaRegistrarObjecao([CARO, INATIVA])
    for (const codigo of ['OBJ-99', 'OBJ-03']) {
      const r = await f.executar(ctxFerr('autonomo'), { codigo, revertida: false, observacao: null } as never)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.erro).toMatch(/^codigo_desconhecido: /)
        expect(r.erro).toContain('OBJ-01')
      }
    }
    expect(await contarFatos()).toBe(0)
  })

  it.each(['sombra', 'simulacao', 'copiloto'])('dado modo %s, então responde em modo seco e NÃO grava na tabela', async (modo) => {
    const r = await ferramentaRegistrarObjecao([CARO]).executar(ctxFerr(modo), { codigo: 'OBJ-01', revertida: true, observacao: null } as never)
    expect(r).toMatchObject({ ok: true, saida: { modoSeco: true }, objecao: { codigo: 'OBJ-01', revertida: true } })
    expect(await contarFatos()).toBe(0)
  })
})

describe('Ações permitidas: a ferramenta entra no menu só com a ação ligada e objeção ativa', () => {
  const base: Ligacoes = { conhecimento: { async buscar() { return { trechos: [] } } } }
  const todas = { catalogo: true, pedido: true, proposta: true, memoria: true, conhecimento: true, objecoes: true }
  it.each([
    ['ligada com objeção ativa', { ...base, acoes: todas, objecoes: [CARO] }, true],
    ['desligada', { ...base, acoes: { ...todas, objecoes: false }, objecoes: [CARO] }, false],
    ['ligada sem objeção', { ...base, acoes: todas }, false],
    ['ligada só com inativa', { ...base, acoes: todas, objecoes: [INATIVA] }, false],
  ] as const)('%s', (_n, l, oferecida) => {
    expect(montarFerramentas(l as Ligacoes).ferramentas.map((f) => f.nome).includes('registrar_objecao')).toBe(oferecida)
  })

  it('ligacoesPadrao lê as objeções ATIVAS do playbook publicado do número; o sandbox usa as do rascunho', async () => {
    const l = await ligacoesPadrao({ tenantId: A, politicas: '', modo: 'autonomo', canalId: CANAL })
    expect(l.objecoes?.map((o) => o.codigo)).toEqual(['OBJ-01', 'OBJ-02'])
    const s = await ligacoesDoSandbox(ligacoesPadrao, CANAL, { ...todas }, [PENSAR])({ tenantId: A, politicas: '', modo: 'simulacao', canalId: CANAL })
    expect(s.objecoes?.map((o) => o.codigo)).toEqual(['OBJ-02'])
    const semObj = await ligacoesDoSandbox(ligacoesPadrao, CANAL, { ...todas }, [])({ tenantId: A, politicas: '', modo: 'simulacao', canalId: CANAL })
    expect(semObj.objecoes).toBeUndefined()
  })

  it('dado a ação desligada no playbook publicado, então o turno NÃO oferece a ferramenta ao modelo', async () => {
    await publicarNoEspelho(CANAL, conteudo({ acaoObjecoes: false }))
    try {
      await dono`DELETE FROM agente_sessao WHERE tenant_id = ${A}`
      const m = llmQueRegistra([{ codigo: 'OBJ-01', revertida: false }], ['Entendo. Quer ver opções?'])
      await turno(CONVERSA, CANAL, [await msg(A, CONVERSA, 'achei caro')], m.porta)
      expect(m.menus[0]).not.toContain('registrar_objecao')
      expect(m.resultados).toHaveLength(0)
    } finally {
      await publicarNoEspelho(CANAL, conteudo())
      await dono`DELETE FROM atendimento WHERE tenant_id = ${A}`
      await dono`DELETE FROM agente_sessao WHERE tenant_id = ${A}`
    }
  })
})

describe('Etapa objecoes-seguidas (pura, turno injetado)', () => {
  const etapa = criarEtapaObjecoesSeguidas({ turnoAtual: async () => 4 })
  const ctx = (estado: Record<string, unknown> = {}, modo = 'autonomo'): ContextoPipeline => ({
    tenantId: A, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: 's', modo: modo as never, agora: new Date(),
    cfgExtra: { playbook: espelho(conteudo()) }, persona: { nome: 'Lia', loja: 'Atacado Sol', tom: 'neutro', usaEmojis: false, saudacao: '', idioma: 'pt-BR', identificaComoRobo: true },
    estado, historico: [], entrantes: [], primeiraResposta: false, foraDoExpediente: false,
  })
  const entrada = (objecoesDoTurno: { codigo: string; revertida: boolean }[], handoff: EntradaPosResposta['handoff'] = null): EntradaPosResposta => ({
    mensagens: ['Entendo. Quer ver opções?'], handoff, centavosVistos: new Set(), numerosVistos: new Set(), falasAnterioresDoAgente: [], objecoesDoTurno,
  })
  const doEstado = (rs: boolean[]) => ({ objecoes: rs.map((revertida, i) => ({ codigo: i % 2 ? 'OBJ-02' : 'OBJ-01', revertida, turno: i + 1 })) })

  it('dado turno sem objeção, então não mexe em nada (nem no estado)', async () => {
    const r = await etapa.executar(ctx(doEstado([false, false])), entrada([]))
    expect(r).toEqual({ mensagens: ['Entendo. Quer ver opções?'], guardrails: [] })
  })

  it('dado a 3ª NÃO revertida seguida, então bloqueia com objecoes_seguidas, troca pelo aviso e resume com os códigos', async () => {
    const r = await etapa.executar(ctx(doEstado([false, false])), entrada([{ codigo: 'OBJ-01', revertida: false }]))
    expect(r.bloquear?.motivo).toBe('objecoes_seguidas')
    expect(r.bloquear?.resumo).toContain('OBJ-01 (Achou caro)')
    expect(r.bloquear?.resumo).toContain('OBJ-02 (Vai pensar)')
    expect(r.mensagens).toHaveLength(1)
    expect(r.mensagens[0]).not.toContain('opções')
    expect((r.estado as { objecoes: unknown[] }).objecoes).toHaveLength(3)
    expect((r.estado as { objecoes: { turno: number }[] }).objecoes[2]!.turno).toBe(4)
    expect(r.guardrails.map((g) => g.codigo)).toEqual(['objecao_registrada', 'objecoes_seguidas'])
  })

  it('dado uma revertida no meio, então a contagem zera e não transfere', async () => {
    const r = await etapa.executar(ctx(doEstado([false, true])), entrada([{ codigo: 'OBJ-01', revertida: false }]))
    expect(r.bloquear).toBeUndefined()
    expect((r.estado as { objecoes: unknown[] }).objecoes).toHaveLength(3)
  })

  it('dado a 3ª revertida, então não transfere', async () => {
    const r = await etapa.executar(ctx(doEstado([false, false])), entrada([{ codigo: 'OBJ-01', revertida: true }]))
    expect(r.bloquear).toBeUndefined()
  })

  it('dado três chamadas no MESMO turno, então contam UMA (não transfere); três turnos seguidos transferem', async () => {
    const tres = [1, 2, 3].map(() => ({ codigo: 'OBJ-02', revertida: false }))
    const r = await etapa.executar(ctx(), entrada(tres))
    expect(r.bloquear).toBeUndefined()
    const estado = (r.estado as { objecoes: unknown[] }).objecoes
    expect(estado).toHaveLength(1)
    // turnos seguidos: o estado de cada turno alimenta o seguinte.
    const t2 = await etapa.executar(ctx({ objecoes: estado }), entrada(tres))
    expect(t2.bloquear).toBeUndefined()
    const t3 = await etapa.executar(ctx({ objecoes: (t2.estado as { objecoes: unknown[] }).objecoes }), entrada(tres))
    expect(t3.bloquear?.motivo).toBe('objecoes_seguidas')
  })

  it('dado revertida e não revertida no mesmo turno, então prevalece a revertida (zera a contagem)', async () => {
    const r = await etapa.executar(ctx(doEstado([false, false])), entrada([{ codigo: 'OBJ-01', revertida: false }, { codigo: 'OBJ-02', revertida: true }]))
    expect(r.bloquear).toBeUndefined()
    const l = (r.estado as { objecoes: { codigo: string; revertida: boolean }[] }).objecoes
    expect(l).toHaveLength(3)
    expect(l.at(-1)).toMatchObject({ codigo: 'OBJ-02', revertida: true })
  })

  it('dado handoff já decidido por outro motivo, ou copiloto, então só registra', async () => {
    const outro = await etapa.executar(ctx(doEstado([false, false])), entrada([{ codigo: 'OBJ-01', revertida: false }], { motivo: 'incerteza', resumo: 'x' }))
    expect(outro.bloquear).toBeUndefined()
    expect(outro.estado).toBeDefined()
    const cop = await etapa.executar(ctx(doEstado([false, false]), 'copiloto'), entrada([{ codigo: 'OBJ-01', revertida: false }]))
    expect(cop.bloquear).toBeUndefined()
  })

  it('a lista do estado tem teto (as mais recentes ficam)', async () => {
    const r = await etapa.executar(ctx(doEstado(Array.from({ length: 30 }, () => true))), entrada([{ codigo: 'OBJ-01', revertida: false }]))
    const l = (r.estado as { objecoes: { revertida: boolean }[] }).objecoes
    expect(l).toHaveLength(30)
    expect(l.at(-1)!.revertida).toBe(false)
  })
})

describe('Turno real: 3 objeções seguidas sem reverter → handoff', () => {
  beforeEach(async () => {
    enviados.length = 0
    for (const tab of ['agente_objecao', 'agente_decisao', 'agente_sessao', 'atendimento', 'notificacao']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${A}'`)
  })

  it('autônomo: grava os fatos e o estado; na 3ª transfere com o motivo novo e o atendimento nasce na fila', async () => {
    const falas = ['achei caro', 'vou pensar', 'continua muito caro']
    const codigos = ['OBJ-01', 'OBJ-02', 'OBJ-01']
    const respostas = ['Entendo. Quer ver opções mais em conta?', 'Claro! Posso deixar um resumo pronto?', 'Entendo a preocupação. Quer ver outra linha?']
    const desfechos: string[] = []
    for (let i = 0; i < 3; i++) {
      const m = llmQueRegistra([{ codigo: codigos[i]!, revertida: false }], [respostas[i]!])
      const r = await turno(CONVERSA, CANAL, [await msg(A, CONVERSA, falas[i]!)], m.porta)
      desfechos.push(r.desfecho)
      if (i === 2) expect(r.handoff).toMatchObject({ motivo: 'objecoes_seguidas' })
    }
    expect(desfechos).toEqual(['respondeu', 'respondeu', 'handoff'])
    expect(await contarFatos()).toBe(3)
    const [s] = await dono<{ estado: string; estado_agente: { objecoes: { codigo: string; revertida: boolean; turno: number }[] } }[]>`
      SELECT estado, estado_agente FROM agente_sessao WHERE tenant_id = ${A} AND conversa_id = ${CONVERSA}`
    expect(s!.estado).toBe('entregue')
    expect(s!.estado_agente.objecoes.map((o) => [o.codigo, o.turno])).toEqual([['OBJ-01', 1], ['OBJ-02', 2], ['OBJ-01', 3]])
    const [d] = await dono<{ handoff_motivo: string }[]>`SELECT handoff_motivo FROM agente_decisao WHERE tenant_id = ${A} ORDER BY criado_em DESC LIMIT 1`
    expect(d!.handoff_motivo).toBe('objecoes_seguidas')
    const [at] = await dono<{ estado: string }[]>`SELECT estado FROM atendimento WHERE tenant_id = ${A} AND conversa_id = ${CONVERSA}`
    expect(at!.estado).toBe('na_fila')
    // A última mensagem é o aviso de transferência, não a 3ª tentativa de convencer.
    expect(enviados.at(-1)).not.toContain('outra linha')
  })

  it('autônomo: o modelo chama o mesmo código três vezes no turno — conta uma, um fato, sem transferir', async () => {
    const m = llmQueRegistra(Array.from({ length: 3 }, () => ({ codigo: 'OBJ-01', revertida: false })), ['Entendo. Quer ver opções mais em conta?'])
    const r = await turno(CONVERSA, CANAL, [await msg(A, CONVERSA, 'achei caro')], m.porta)
    expect(r.desfecho).toBe('respondeu')
    expect(await contarFatos()).toBe(1)
    const [s] = await dono<{ estado_agente: { objecoes: unknown[] } }[]>`SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${A} AND conversa_id = ${CONVERSA}`
    expect(s!.estado_agente.objecoes).toHaveLength(1)
  })

  it('turno superado (chegou mensagem nova): não grava o fato nem soma no estado', async () => {
    const m = llmQueRegistra([{ codigo: 'OBJ-01', revertida: false }], ['Entendo. Quer ver opções?'])
    const rodar = m.porta.rodar.bind(m.porta)
    const porta: PortaLlmFerramentas = { ...m.porta, async rodar(p) { const r = await rodar(p); await msg(A, CONVERSA, 'outra coisa'); return r } }
    const r = await turno(CONVERSA, CANAL, [await msg(A, CONVERSA, 'achei caro')], porta)
    expect(r.desfecho).toBe('superada')
    expect(await contarFatos()).toBe(0)
    expect(enviados).toHaveLength(0)
  })

  it('retry: envio recusado não grava; o turno refeito grava uma vez só', async () => {
    const ids = [await msg(A, CONVERSA, 'achei caro')]
    const recusa = (async () => ({ ok: false as const, motivo: 'fora_da_janela' })) as never
    const m1 = llmQueRegistra([{ codigo: 'OBJ-01', revertida: false }], ['Entendo. Quer ver opções?'])
    const r1 = await conduzirTurnoVendedor(
      { tenant_id: A, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() },
      { llm: m1.porta, ligacoes: ligacoesPadrao, enviar: recusa })
    expect(r1.desfecho).toBe('falha')
    expect(await contarFatos()).toBe(0)
    const m2 = llmQueRegistra([{ codigo: 'OBJ-01', revertida: false }], ['Entendo. Quer ver opções?'])
    const r2 = await turno(CONVERSA, CANAL, ids, m2.porta)
    expect(r2.desfecho).toBe('respondeu')
    expect(await contarFatos()).toBe(1)
  })

  it('assistido: a 3ª objeção seguida vira handoff SEM envio (encerra a sessão sem entrega) e grava os fatos', async () => {
    const codigos = ['OBJ-01', 'OBJ-02', 'OBJ-01']
    const desfechos: string[] = []
    for (let i = 0; i < 3; i++) {
      const m = llmQueRegistra([{ codigo: codigos[i]!, revertida: false }], [`Entendo, resposta ${i}.`])
      const r = await turno(CONVERSA_ASSIST, CANAL_ASSIST, [await msg(A, CONVERSA_ASSIST, 'achei caro')], m.porta)
      desfechos.push(r.desfecho)
    }
    expect(desfechos).toEqual(['sugeriu', 'sugeriu', 'handoff'])
    expect(enviados).toHaveLength(0)
    expect(await contarFatos()).toBe(3)
    const [s] = await dono<{ estado: string }[]>`SELECT estado FROM agente_sessao WHERE tenant_id = ${A} AND conversa_id = ${CONVERSA_ASSIST}`
    expect(s!.estado).not.toBe('ativa')
    const [d] = await dono<{ handoff_motivo: string }[]>`SELECT handoff_motivo FROM agente_decisao WHERE tenant_id = ${A} AND conversa_id = ${CONVERSA_ASSIST} ORDER BY criado_em DESC LIMIT 1`
    expect(d!.handoff_motivo).toBe('objecoes_seguidas')
  })

  it('autônomo: uma revertida no meio zera — três registros não transferem', async () => {
    const seq = [false, true, false]
    for (let i = 0; i < 3; i++) {
      const m = llmQueRegistra([{ codigo: 'OBJ-01', revertida: seq[i]! }], [`Resposta ${['um', 'dois', 'tres'][i]}.`])
      const r = await turno(CONVERSA, CANAL, [await msg(A, CONVERSA, 'achei caro')], m.porta)
      expect(r.desfecho).toBe('respondeu')
    }
  })

  it('código desconhecido no turno: o modelo recebe o erro e nada é registrado', async () => {
    const m = llmQueRegistra([{ codigo: 'OBJ-42', revertida: false }], ['Entendo. Quer ver opções?'])
    await turno(CONVERSA, CANAL, [await msg(A, CONVERSA, 'achei caro')], m.porta)
    expect(m.resultados[0]!.erro).toMatch(/^codigo_desconhecido/)
    expect(await contarFatos()).toBe(0)
    const [s] = await dono<{ estado_agente: Record<string, unknown> }[]>`SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${A} AND conversa_id = ${CONVERSA}`
    expect(s!.estado_agente['objecoes']).toBeUndefined()
  })

  it('sombra: registra no estado da sessão, NÃO na tabela', async () => {
    const m = llmQueRegistra([{ codigo: 'OBJ-02', revertida: false }], ['Claro, sem pressa.'])
    const r = await turno(CONVERSA_SOMBRA, CANAL_SOMBRA, [await msg(A, CONVERSA_SOMBRA, 'vou pensar')], m.porta)
    expect(r.desfecho).toBe('sugeriu')
    expect(await contarFatos()).toBe(0)
    const [s] = await dono<{ estado_agente: { objecoes: { codigo: string }[] } }[]>`
      SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${A} AND conversa_id = ${CONVERSA_SOMBRA}`
    expect(s!.estado_agente.objecoes.map((o) => o.codigo)).toEqual(['OBJ-02'])
  })
})

describe('Prompt e qualidade', () => {
  it('o <playbook> lista as objeções ativas (código, gatilhos, referência); sem a ação, não cita a ferramenta', () => {
    const txt = instrucoesDoPlaybook(conteudo(), 3)
    expect(txt).toMatch(/<playbook versao="v3">[\s\S]*<objecoes>[\s\S]*OBJ-01 · Achou caro · gatilhos: caro \| muito caro · referência: "Entendo[\s\S]*<\/objecoes>[\s\S]*<\/playbook>/)
    expect(txt).not.toContain('OBJ-03')
    expect(txt).toContain('registrar_objecao')
    expect(blocoObjecoes(conteudo({ acaoObjecoes: false }))).not.toContain('registrar_objecao')
    expect(blocoObjecoes(conteudo({ objecoes: [] }))).toBe('')
  })

  it('regra objecao_fora_do_catalogo: gatilho casou, sem registro e fora da referência → MEDIA; com registro → nada', async () => {
    const ctx: ContextoPipeline = {
      tenantId: A, conversaId: CONVERSA, canalId: CANAL, contatoId: CONTATO, sessaoId: null, modo: 'autonomo', agora: new Date(),
      cfgExtra: { playbook: espelho(conteudo()) }, persona: { nome: 'Lia', loja: '', tom: 'neutro', usaEmojis: false, saudacao: '', idioma: 'pt-BR', identificaComoRobo: true },
      estado: {}, historico: [], primeiraResposta: false, foraDoExpediente: false,
      entrantes: [{ id: 'm', tipo: 'texto', texto: 'achei muito caro', transcricaoPendente: false, transcricaoFalhou: false }],
    }
    const e = (objecoesDoTurno: { codigo: string; revertida: boolean }[]): EntradaPosResposta => ({
      mensagens: ['Beleza! Qual tamanho você quer?'], handoff: null, centavosVistos: new Set(), numerosVistos: new Set(), falasAnterioresDoAgente: [], objecoesDoTurno,
    })
    const sem = await violacoesDoTurno(ctx, e([]))
    expect(sem.violacoes.find((v) => v.regra === 'objecao_fora_do_catalogo')).toMatchObject({ gravidade: 'MEDIA', detalhe: 'OBJ-01' })
    const com = await violacoesDoTurno(ctx, e([{ codigo: 'OBJ-01', revertida: false }]))
    expect(com.violacoes.map((v) => v.regra)).not.toContain('objecao_fora_do_catalogo')
    const semPlaybook = await violacoesDoTurno({ ...ctx, cfgExtra: {} }, e([]))
    expect(semPlaybook.violacoes.map((v) => v.regra)).not.toContain('objecao_fora_do_catalogo')
  })
})

describe('GET /v1/agente/objecoes/resumo (dois tenants)', () => {
  beforeAll(async () => {
    await dono`DELETE FROM agente_objecao WHERE tenant_id IN (${A}, ${B})`
    const fato = (t: string, canal: string, conversa: string, contato: string, codigo: string, objecao: string, revertida: boolean, diasAtras: number) => dono`
      INSERT INTO agente_objecao (tenant_id, id, canal_id, conversa_id, contato_id, codigo, objecao, revertida, criado_em)
      VALUES (${t}, ${crypto.randomUUID()}, ${canal}, ${conversa}, ${contato}, ${codigo}, ${objecao}, ${revertida}, now() - make_interval(days => ${diasAtras}))`
    await fato(A, CANAL, CONVERSA, CONTATO, 'OBJ-01', 'Achou caro (antigo)', false, 3)
    await fato(A, CANAL, CONVERSA, CONTATO, 'OBJ-01', 'Achou caro', true, 1)
    await fato(A, CANAL, CONVERSA, CONTATO, 'OBJ-01', 'Achou caro', false, 2)
    await fato(A, CANAL_SOMBRA, CONVERSA_SOMBRA, CONTATO, 'OBJ-02', 'Vai pensar', true, 1)
    await fato(A, CANAL, CONVERSA, CONTATO, 'OBJ-02', 'Vai pensar', false, 45)
    await fato(B, CANAL_B, CONVERSA_B, CONTATO_B, 'OBJ-07', 'Do outro tenant', false, 1)
  })

  it('agrega por código na janela (vezes, revertidas, %, o texto mais recente), da conta ou do número', async () => {
    const conta = await chamar(A, '/v1/agente/objecoes/resumo?dias=30')
    expect(conta.statusCode).toBe(200)
    expect(conta.json()).toEqual({
      dias: 30, canalId: null,
      itens: [
        { codigo: 'OBJ-01', objecao: 'Achou caro', vezes: 3, revertidas: 1, percentualRevertida: 33 },
        { codigo: 'OBJ-02', objecao: 'Vai pensar', vezes: 1, revertidas: 1, percentualRevertida: 100 },
      ],
    })
    const numero = (await chamar(A, `/v1/agente/objecoes/resumo?dias=30&canalId=${CANAL}`)).json() as { itens: { codigo: string }[] }
    expect(numero.itens.map((i) => i.codigo)).toEqual(['OBJ-01'])
    const longa = (await chamar(A, '/v1/agente/objecoes/resumo?dias=90')).json() as { itens: { codigo: string; vezes: number }[] }
    expect(longa.itens.find((i) => i.codigo === 'OBJ-02')!.vezes).toBe(2)
  })

  it('RLS: o outro tenant não vê nem consulta pelo número alheio', async () => {
    const b = (await chamar(B, '/v1/agente/objecoes/resumo')).json() as { dias: number; itens: { codigo: string }[] }
    expect(b.dias).toBe(30)
    expect(b.itens.map((i) => i.codigo)).toEqual(['OBJ-07'])
    expect((await chamar(B, `/v1/agente/objecoes/resumo?canalId=${CANAL}`)).statusCode).toBe(404)
    expect((await chamar(A, '/v1/agente/objecoes/resumo?canalId=xyz')).statusCode).toBe(404)
  })
})
