import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { playbookPadrao, type ConteudoPlaybook } from '@geracrm/shared'
import { criarApp } from '../../../../app.js'
import { encerrarBanco, comTenantServico } from '../../../../db/index.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import { depsPlaybook } from '../rotas-playbook.js'
import { ferramentaMemoriaAnotar } from '../memoria/ferramenta-memoria.js'
import { montarFerramentas } from '../ferramentas/montar.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { ContextoFerramenta } from '../ferramentas/porta.js'
import type { Ligacoes } from '../ferramentas/ligacoes-porta.js'

/**
 * PLAYBOOK COMERCIAL VERSIONADO (P17) — ponta a ponta no banco real, dois
 * tenants: importação idempotente, rascunho, a tela que NÃO desliga guardrail,
 * publicação (admin, observação, auditoria, espelho), imutabilidade no banco,
 * histórico/restaurar, playbook da conta, sandbox em modo seco (limites, ações,
 * guardrails), "a partir de documento" (só rascunho) e — o PRONTO — publicar
 * muda a próxima mensagem de um turno real.
 */
const A = 'a1170000-0000-4000-8000-000000000001'
const B = 'a1170000-0000-4000-8000-000000000002'
const PV_A = 'a1170000-1111-4000-8000-000000000001'
const PV_B = 'a1170000-1111-4000-8000-000000000002'
const PLANO = 'a1170000-3333-4000-8000-000000000001'
const MODELO = 'a1170000-4444-4000-8000-000000000001'
const CANAL = 'a1170000-5555-4000-8000-000000000001'
const CANAL2 = 'a1170000-5555-4000-8000-000000000002'
const CANAL3 = 'a1170000-5555-4000-8000-000000000003'
const CANAL_B = 'a1170000-5555-4000-8000-000000000009'
const CONTATO = 'a1170000-6666-4000-8000-000000000001'
const CONVERSA = 'a1170000-7777-4000-8000-000000000001'
const ADMIN_OUTRO = 'a1170000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
/** Conexão com o PAPEL DA APLICAÇÃO (RLS vale) — skill geracrm-testes. */
const app_ = (t: string) => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { 'geracrm.tenant_id': t } as never })
let app: FastifyInstance
const chamar = (t: string, m: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, corpo?: unknown) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo !== undefined ? { payload: corpo as object } : {}) })

const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true as const, mensagemId: crypto.randomUUID() }
}) as never
const ligacoesFalsas = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })
function llmQueDiz(mensagens: string[]): PortaLlmFerramentas {
  return {
    nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(): Promise<ResultadoLaco> {
      return { ok: true, saida: { mensagens, confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 1, saida: 1, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    },
  }
}

async function conteudoDe(t: string, canalId: string | null): Promise<ConteudoPlaybook> {
  const r = (await chamar(t, 'GET', `/v1/agente/playbook${canalId ? `?canalId=${canalId}` : ''}`)).json() as { rascunho: { conteudo: ConteudoPlaybook } | null; publicada: { conteudo: ConteudoPlaybook } | null }
  return structuredClone(r.rascunho?.conteudo ?? r.publicada?.conteudo ?? playbookPadrao())
}
const espelho = async (canal: string) => (await dono<{ playbook: { numero: number; escopo: string; conteudo: ConteudoPlaybook } | null; persona: Record<string, unknown>; qualificacao: string[] }[]>`
  SELECT playbook, persona, qualificacao FROM agente_config WHERE tenant_id = ${A} AND canal_id = ${canal}`)[0]!

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.IA_PROVEDOR = 'simulado'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-playbook-p17', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-playbook-p17', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${`Playbook ${t.slice(-1)}`}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  for (const [t, c] of [[A, CANAL], [A, CANAL2], [A, CANAL3], [B, CANAL_B]] as const) {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${c}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento)
             VALUES (${A}, ${CANAL}, ${JSON.stringify({ seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null })}::text::jsonb) ON CONFLICT DO NOTHING`
  // O número 1 já configurado HOJE (antes do playbook): é daqui que sai a v1.
  for (const c of [CANAL, CANAL2]) {
    await dono`
      INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, qualificacao, compliance)
      VALUES (${A}, ${c}, true, 'autonomo', 'Entrega em 3 dias úteis.', false, false,
              ${JSON.stringify({ nome: 'Lia', loja: 'Atacado Sol', tom: 'neutro', usaEmojis: false })}::text::jsonb,
              ${JSON.stringify(['volume', 'prazo'])}::text::jsonb, ${JSON.stringify({ frasesProibidas: ['consignação'], gatilhosHandoff: [] })}::text::jsonb)`
  }
  await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo) VALUES (${B}, ${CANAL_B}, false, 'desligado')`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${A}, ${CONTATO}, 'Ana Cliente', true)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${A}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1)`
  // Aviso de privacidade vigente: o turno real não abre com a apresentação.
  await dono`INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
             VALUES (${A}, ${crypto.randomUUID()}, ${CONTATO}, ${CONVERSA}, ${CANAL}, ${crypto.randomUUID()}, 'aviso', 'padrao', 'agente')`
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  depsPlaybook.llm = null
  for (const t of [A, B]) {
    // Versões publicadas são imutáveis até para o dono: limpeza desliga o trigger nesta sessão.
    await dono.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`
      await tx`DELETE FROM agente_playbook_versao WHERE tenant_id = ${t}`
    })
    for (const tab of ['agente_simulacao_trava', 'aviso_privacidade', 'cliente_memoria', 'agente_decisao', 'agente_sessao', 'agente_tarefa', 'atendimento', 'notificacao', 'auditoria', 'agente_config',
      'pedido', 'mensagem', 'conversa', 'contato_identidade_externa', 'contato', 'usuario_filial', 'usuario', 'canal_configuracao', 'canal_conectado', 'outbox', 'alerta']) {
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

describe('Importação inicial (v1 a partir de agente_config)', () => {
  it('dado número configurado sem playbook, quando importa, então nasce a v1 publicada igual à config — e repetir não cria outra', async () => {
    const g = (await chamar(A, 'GET', `/v1/agente/playbook?canalId=${CANAL}`)).json() as { importavel: boolean; publicada: unknown }
    expect(g).toMatchObject({ importavel: true, publicada: null })
    const r = await chamar(A, 'POST', '/v1/agente/playbook/importar', { canalId: CANAL })
    expect(r.statusCode).toBe(201)
    const v1 = (r.json() as { publicada: { numero: number; origem: string; conteudo: ConteudoPlaybook } }).publicada
    expect(v1).toMatchObject({ numero: 1, origem: 'importada' })
    expect(v1.conteudo.persona).toMatchObject({ nome: 'Lia', loja: 'Atacado Sol' })
    expect(v1.conteudo.qualificacao.map((q) => q.slot)).toEqual(['volume', 'prazo'])
    expect(v1.conteudo.compliance.frasesProibidas).toEqual(['consignação'])
    const de2 = await chamar(A, 'POST', '/v1/agente/playbook/importar', { canalId: CANAL })
    expect(de2.statusCode).toBe(200)
    expect(de2.json()).toMatchObject({ importada: false })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_playbook_versao WHERE tenant_id = ${A} AND canal_id = ${CANAL}`
    expect(n!.n).toBe(1)
    const e = await espelho(CANAL)
    expect(e.playbook).toMatchObject({ numero: 1, escopo: 'numero' })
    expect(e.qualificacao).toEqual(['volume', 'prazo'])
  })
})

describe('A tela nunca desliga guardrail', () => {
  it.each([
    ['persona.identificaComoRobo = false', (c: any) => { c.persona.identificaComoRobo = false }],
    ['acoes.atendimento_transferir = false', (c: any) => { c.acoes.atendimento_transferir = false }],
    ['remover frase proibida da base', (c: any) => { c.compliance.removerBase = ['garantia_sem_fonte'] }],
    ['desligar o filtro', (c: any) => { c.guardrails = { filtroDeSaida: false } }],
    ['mensagem de transferência com prazo', (c: any) => { c.mensagens.handoff = 'Uma pessoa te responde em até 2 horas.' }],
    ['abertura com preço', (c: any) => { c.mensagens.abertura = 'Oi! Camisetas a partir de R$ 19,90.' }],
  ])('dado PUT com %s, então 422 e nada muda', async (_n, mexer) => {
    const c = await conteudoDe(A, CANAL)
    mexer(c)
    const r = await chamar(A, 'PUT', '/v1/agente/playbook/rascunho', { canalId: CANAL, conteudo: c })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { erro: string }).erro).toBe('playbook.invalido')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_playbook_versao WHERE tenant_id = ${A} AND publicada_em IS NULL`
    expect(n!.n).toBe(0)
  })

  it('dado compliance do playbook vazio, a frase da base continua barrada no turno (só acrescenta)', async () => {
    enviados.length = 0
    const r = await conduzirTurnoVendedor(
      { tenant_id: A, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [await msg('tem garantia?')], tentativas: 1, executar_em: new Date() },
      { llm: llmQueDiz(['Garantimos entrega amanhã para você. Quer ver os modelos?']), ligacoes: ligacoesFalsas, enviar: enviarFalso },
    )
    expect(r.mensagens!.join(' ')).not.toMatch(/garantimos entrega/i)
  })
})

async function msg(texto: string): Promise<string> {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${A}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return id
}

describe('Rascunho → publicar → a próxima mensagem muda (turno real)', () => {
  const RESPOSTA = 'Fazemos frete grátis na sua região. Qual cor você prefere? E qual tamanho?'
  const turno = async () => {
    enviados.length = 0
    await dono`DELETE FROM agente_sessao WHERE tenant_id = ${A} AND conversa_id = ${CONVERSA}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${A}`
    return conduzirTurnoVendedor(
      { tenant_id: A, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [await msg('quero camisetas')], tentativas: 1, executar_em: new Date() },
      { llm: llmQueDiz([RESPOSTA]), ligacoes: ligacoesFalsas, enviar: enviarFalso },
    )
  }

  it('antes de publicar, a resposta sai como o modelo escreveu', async () => {
    const r = await turno()
    expect(r.desfecho).toBe('respondeu')
    expect(enviados.join(' ')).toContain('frete grátis')
    expect(enviados.join(' ')).toContain('Qual cor você prefere?')
  })

  it('rascunho salvo NÃO muda o turno; observação curta e não-admin não publicam; publicar muda a próxima mensagem', async () => {
    const c = await conteudoDe(A, CANAL)
    c.compliance.frasesProibidas.push('frete grátis')
    c.estilo.maxPerguntas = 1
    c.mensagens.handoff = 'Combinado, {nome}! Uma pessoa da equipe segue com você por aqui.'
    // O número está fora do expediente (horário sempre fechado): vale a de fora do horário.
    c.mensagens.foraDoHorario = 'Anotado! No próximo horário de atendimento alguém da equipe segue com você por aqui.'
    const put = await chamar(A, 'PUT', '/v1/agente/playbook/rascunho', { canalId: CANAL, conteudo: c })
    expect(put.statusCode).toBe(200)
    const g = (await chamar(A, 'GET', `/v1/agente/playbook?canalId=${CANAL}`)).json() as { diff: { secao: string; mudou: boolean }[] }
    expect(g.diff.filter((d) => d.mudou).map((d) => d.secao)).toEqual(['estilo', 'mensagens', 'compliance'])

    await turno()
    expect(enviados.join(' ')).toContain('frete grátis') // rascunho não vale para cliente

    const curta = await chamar(A, 'POST', '/v1/agente/playbook/publicar', { canalId: CANAL, observacao: 'ok' })
    expect(curta.statusCode).toBe(422)
    expect((curta.json() as { erro: string }).erro).toBe('playbook.observacao_invalida')

    // Sem papel de admin (o tenant passa a ter um admin atribuído que não é quem chama): 403.
    const [eu] = await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = ${A} AND cognito_sub = ${`dev-${A}`}`
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${ADMIN_OUTRO}, 'sub-admin-p17', 'Ada', 'ada@p17.test')`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${A}, ${ADMIN_OUTRO}, NULL, 'admin'), (${A}, ${eu!.id}, NULL, 'vendedor')`
    const semPapel = await chamar(A, 'POST', '/v1/agente/playbook/publicar', { canalId: CANAL, observacao: 'Tirar frete grátis do discurso.' })
    expect(semPapel.statusCode).toBe(403)
    await dono`UPDATE usuario_filial SET papel = 'admin' WHERE tenant_id = ${A} AND usuario_id = ${eu!.id}`

    const pub = await chamar(A, 'POST', '/v1/agente/playbook/publicar', { canalId: CANAL, observacao: 'Tirar frete grátis do discurso.' })
    expect(pub.statusCode).toBe(200)
    expect(pub.json()).toMatchObject({ versao: { numero: 2, estado: 'publicada', observacao: 'Tirar frete grátis do discurso.' }, numerosAlcancados: 1 })
    const [v1] = await dono<{ arquivada_em: Date | null }[]>`SELECT arquivada_em FROM agente_playbook_versao WHERE tenant_id = ${A} AND canal_id = ${CANAL} AND numero = 1`
    expect(v1!.arquivada_em).not.toBeNull()
    const [aud] = await dono<{ dados: Record<string, unknown> }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'agente.playbook_publicado' ORDER BY criado_em DESC LIMIT 1`
    expect(aud!.dados).toMatchObject({ numero: 2, observacao: 'Tirar frete grátis do discurso.', secoesAlteradas: ['estilo', 'mensagens', 'compliance'], anterior: { numero: 1 } })
    expect((await espelho(CANAL)).playbook).toMatchObject({ numero: 2 })

    const r = await turno()
    expect(r.desfecho).toBe('respondeu')
    const saiu = enviados.join(' ')
    expect(saiu).not.toContain('frete grátis')
    expect(saiu).toContain('E qual tamanho?')
    expect(saiu).not.toContain('Qual cor você prefere?')
    const [d] = await dono<{ guardrails: { codigo: string }[] }[]>`
      SELECT guardrails FROM agente_decisao WHERE tenant_id = ${A} ORDER BY criado_em DESC LIMIT 1`
    expect(d!.guardrails.map((x) => x.codigo)).toContain('max_perguntas')
  })

  it('a mensagem de transferência publicada é a que sai no gatilho de "quero um humano"', async () => {
    enviados.length = 0
    await dono`DELETE FROM agente_sessao WHERE tenant_id = ${A}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${A}`
    const r = await conduzirTurnoVendedor(
      { tenant_id: A, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: [await msg('quero falar com um atendente')], tentativas: 1, executar_em: new Date() },
      { llm: llmQueDiz(['não deveria chamar']), ligacoes: ligacoesFalsas, enviar: enviarFalso },
    )
    expect(r.desfecho).toBe('handoff')
    expect(enviados[0]).toBe('Anotado! No próximo horário de atendimento alguém da equipe segue com você por aqui.')
    await dono`DELETE FROM atendimento WHERE tenant_id = ${A}`
  })
})

describe('Versão imutável no banco (papel da aplicação, RLS)', () => {
  it('publicada não muda nem se apaga; arquivar só uma vez; outro tenant não vê', async () => {
    const sqlA = app_(A)
    const sqlB = app_(B)
    try {
      const [pub] = await sqlA<{ id: string }[]>`SELECT id FROM agente_playbook_versao WHERE canal_id = ${CANAL} AND numero = 2`
      await expect(sqlA`UPDATE agente_playbook_versao SET conteudo = '{}'::jsonb WHERE id = ${pub!.id}`).rejects.toThrow(/imutável/)
      await expect(sqlA`UPDATE agente_playbook_versao SET observacao = 'mudando a história' WHERE id = ${pub!.id}`).rejects.toThrow(/imutável/)
      await expect(sqlA`DELETE FROM agente_playbook_versao WHERE id = ${pub!.id}`).rejects.toThrow(/imutável/)
      const [arq] = await sqlA<{ id: string }[]>`SELECT id FROM agente_playbook_versao WHERE canal_id = ${CANAL} AND numero = 1`
      await expect(sqlA`UPDATE agente_playbook_versao SET arquivada_em = now() WHERE id = ${arq!.id}`).rejects.toThrow(/imutável/)
      expect(await sqlB`SELECT id FROM agente_playbook_versao`).toHaveLength(0)
      await expect(sqlB`INSERT INTO agente_playbook_versao (tenant_id, id, conteudo, origem) VALUES (${A}, ${crypto.randomUUID()}, '{}'::jsonb, 'manual')`).rejects.toThrow()
      expect((await chamar(B, 'GET', `/v1/agente/playbook/versoes/${pub!.id}`)).statusCode).toBe(404)
      expect((await chamar(B, 'GET', `/v1/agente/playbook?canalId=${CANAL}`)).statusCode).toBe(404)
    } finally {
      await sqlA.end(); await sqlB.end()
    }
  })
})

describe('Histórico e restaurar', () => {
  it('lista por cursor, mostra o diff contra a publicada, e restaurar publica a cópia como versão nova', async () => {
    const lista = (await chamar(A, 'GET', `/v1/agente/playbook/versoes?canalId=${CANAL}`)).json() as { itens: { id: string; numero: number; estado: string }[]; proximoCursor: string | null }
    expect(lista.itens.map((v) => [v.numero, v.estado])).toEqual([[2, 'publicada'], [1, 'arquivada']])
    expect(lista.itens[0]).not.toHaveProperty('conteudo')
    const v1 = lista.itens[1]!
    const det = (await chamar(A, 'GET', `/v1/agente/playbook/versoes/${v1.id}`)).json() as { diffContraPublicada: { secao: string; mudou: boolean }[] }
    expect(det.diffContraPublicada.filter((d) => d.mudou).map((d) => d.secao)).toEqual(['estilo', 'mensagens', 'compliance'])

    // Com rascunho aberto, restaurar recusa (não apaga trabalho).
    await chamar(A, 'POST', '/v1/agente/playbook/rascunho', { canalId: CANAL })
    const bloqueado = await chamar(A, 'POST', `/v1/agente/playbook/versoes/${v1.id}/restaurar`, { observacao: 'Voltar ao discurso antigo.' })
    expect(bloqueado.statusCode).toBe(409)
    expect((await chamar(A, 'DELETE', `/v1/agente/playbook/rascunho?canalId=${CANAL}`)).statusCode).toBe(200)

    const r = await chamar(A, 'POST', `/v1/agente/playbook/versoes/${v1.id}/restaurar`, { observacao: 'Voltar ao discurso antigo.' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ versao: { numero: 3, origem: 'restaurada', baseadaEm: v1.id } })
    expect((await espelho(CANAL)).playbook!.conteudo.estilo.maxPerguntas).toBeNull()
    const [aud] = await dono<{ dados: Record<string, unknown> }[]>`
      SELECT dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'agente.playbook_publicado' ORDER BY criado_em DESC LIMIT 1`
    expect(aud!.dados).toMatchObject({ numero: 3, restauradaDe: { id: v1.id, numero: 1 } })
    const p2 = (await chamar(A, 'GET', `/v1/agente/playbook/versoes?canalId=${CANAL}&cursor=3`)).json() as { itens: { numero: number }[] }
    expect(p2.itens.map((v) => v.numero)).toEqual([2, 1])
  })
})

describe('Playbook da conta (canal NULL)', () => {
  it('publicado na conta, vale para os números sem playbook próprio — inclusive os configurados depois — e não pisa no número que tem o seu', async () => {
    const c = playbookPadrao()
    c.persona = { nome: 'Bia', loja: 'Atacado Sol', tom: 'formal', usaEmojis: false, saudacao: '' }
    c.qualificacao = [{ slot: 'cnpj', pergunta: 'Você compra com CNPJ?', obrigatorio: true, ativo: true }]
    expect((await chamar(A, 'PUT', '/v1/agente/playbook/rascunho', { canalId: null, conteudo: c })).statusCode).toBe(200)
    const pub = await chamar(A, 'POST', '/v1/agente/playbook/publicar', { observacao: 'Padrão da conta para números novos.' })
    expect(pub.statusCode).toBe(200)
    expect(pub.json()).toMatchObject({ versao: { numero: 1, canalId: null }, numerosAlcancados: 1 })
    const e2 = await espelho(CANAL2)
    expect(e2.playbook).toMatchObject({ escopo: 'tenant', numero: 1 })
    expect(e2.persona).toMatchObject({ nome: 'Bia', tom: 'formal', identificaComoRobo: true })
    expect(e2.qualificacao).toEqual(['cnpj'])
    expect((await espelho(CANAL)).playbook).toMatchObject({ escopo: 'numero', numero: 3 })
    // Número configurado DEPOIS (por qualquer rota) nasce com o playbook da conta.
    expect((await chamar(A, 'PUT', `/v1/canais/${CANAL3}/agente/compliance`, { frasesProibidas: [], gatilhosHandoff: [] })).statusCode).toBe(200)
    expect((await espelho(CANAL3)).playbook).toMatchObject({ escopo: 'tenant' })
  })

  it('com playbook vigente, a tela de configuração não edita persona/roteiro por fora (409) e mostra o vigente', async () => {
    const g = (await chamar(A, 'GET', `/v1/canais/${CANAL2}/agente`)).json() as { playbookVigente: unknown }
    expect(g.playbookVigente).toMatchObject({ numero: 1, escopo: 'tenant' })
    const r = await chamar(A, 'PUT', `/v1/canais/${CANAL2}/agente`, { modo: 'autonomo', politicas: 'Entrega em 3 dias úteis.', persona: { nome: 'Outra' } })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'agente.campo_do_playbook', campos: ['persona'] })
    const igual = await chamar(A, 'PUT', `/v1/canais/${CANAL2}/agente`, { modo: 'autonomo', politicas: 'Entrega em 3 dias úteis.', persona: { nome: 'Bia' }, qualificacao: ['cnpj'] })
    expect(igual.statusCode).toBe(200)
  })
})

describe('Sandbox (simular com playbook, modo seco)', () => {
  it('roda o RASCUNHO: a mensagem de transferência do rascunho sai, ações e guardrails voltam, nada vai para a fila', async () => {
    const c = await conteudoDe(A, CANAL)
    c.mensagens.foraDoHorario = 'Perfeito! Já chamei alguém do time para seguir com você aqui.'
    expect((await chamar(A, 'PUT', '/v1/agente/playbook/rascunho', { canalId: CANAL, conteudo: c })).statusCode).toBe(200)
    const r = await chamar(A, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'quero falar com um atendente', playbook: 'rascunho' })
    expect(r.statusCode).toBe(200)
    const s = r.json() as { mensagens: string[]; playbook: { tipo: string }; modoSeco: boolean; guardrails: { codigo: string }[]; acoes: unknown[] }
    expect(s.playbook.tipo).toBe('rascunho')
    expect(s.modoSeco).toBe(true)
    expect(s.mensagens.join(' ')).toContain('Já chamei alguém do time')
    expect(s.guardrails.map((g) => g.codigo)).toContain('pedido_humano')
    const pub = (await chamar(A, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'quero falar com um atendente', playbook: 'publicada' })).json() as { mensagens: string[]; playbook: { tipo: string; numero: number } }
    expect(pub.playbook).toMatchObject({ tipo: 'publicada', numero: 3 })
    expect(pub.mensagens.join(' ')).not.toContain('Já chamei alguém do time')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${A}`
    expect(n!.n).toBe(0)
  })

  it('ações do rascunho mudam o menu: proposta desligada some; as de escrita voltam como registradas', async () => {
    const c = await conteudoDe(A, CANAL)
    c.acoes.proposta = false
    await chamar(A, 'PUT', '/v1/agente/playbook/rascunho', { canalId: CANAL, conteudo: c })
    const com = (await chamar(A, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'pode fechar o pedido', playbook: 'publicada' })).json() as { acoes: { ferramenta: string; escrita: boolean }[] }
    expect(com.acoes).toContainEqual(expect.objectContaining({ ferramenta: 'pedido_propor', escrita: true }))
    const sem = (await chamar(A, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'pode fechar o pedido', playbook: 'rascunho' })).json() as { acoes: { ferramenta: string }[] }
    expect(sem.acoes.map((a) => a.ferramenta)).not.toContain('pedido_propor')
    await chamar(A, 'DELETE', `/v1/agente/playbook/rascunho?canalId=${CANAL}`)
  })

  it('sem rascunho, pedir o rascunho é 422; uma simulação por vez (409); 20 mensagens e acabou (422)', async () => {
    expect((await chamar(A, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'oi', playbook: 'rascunho' })).json()).toMatchObject({ erro: 'playbook.sem_rascunho' })
    await dono`INSERT INTO agente_simulacao_trava (tenant_id, token, ate) VALUES (${A}, ${crypto.randomUUID()}, now() + interval '1 minute')
               ON CONFLICT (tenant_id) DO UPDATE SET token = EXCLUDED.token, ate = EXCLUDED.ate`
    const ocupado = await chamar(A, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'oi' })
    expect(ocupado.statusCode).toBe(409)
    expect(ocupado.json()).toMatchObject({ erro: 'agente.simulacao_em_andamento' })
    await dono`DELETE FROM agente_simulacao_trava WHERE tenant_id = ${A}`
    const [conv] = await dono<{ id: string }[]>`
      SELECT cv.id FROM conversa cv JOIN contato_identidade_externa ie ON ie.tenant_id = cv.tenant_id AND ie.contato_id = cv.contato_id
       WHERE cv.tenant_id = ${A} AND ie.id_externo = ${`sim:${CANAL}`}`
    const [ja] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${A} AND conversa_id = ${conv!.id} AND direcao = 'entrante'`
    for (let i = ja!.n; i < 20; i++) {
      await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo) VALUES (${A}, ${crypto.randomUUID()}, ${conv!.id}, 'entrante', 'texto', '{"texto":"x"}'::jsonb)`
    }
    const limite = await chamar(A, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'oi' })
    expect(limite.statusCode).toBe(422)
    expect(limite.json()).toMatchObject({ erro: 'agente.simulacao_limite' })
    await chamar(A, 'DELETE', `/v1/canais/${CANAL}/agente/simular`)
    expect((await chamar(A, 'POST', `/v1/canais/${CANAL}/agente/simular`, { mensagem: 'oi' })).statusCode).toBe(200)
  })

  it.each(['simulacao', 'copiloto'] as const)('memoria_anotar em %s NÃO grava cliente_memoria; em turno real grava', async (modo) => {
    const ctx = (m: string): ContextoFerramenta => ({ tenantId: A, conversaId: CONVERSA, contatoId: CONTATO, canalId: CANAL, perfil: 'varejo' as never, sessaoId: null, modo: m as never, agora: new Date() })
    const f = ferramentaMemoriaAnotar()
    const r = await f.executar(ctx(modo), { tipo: 'preferencia', fato: `prefere camiseta azul (${modo})` } as never)
    expect(r).toMatchObject({ ok: true, saida: { anotado: true, modoSeco: true } })
    const conta = () => comTenantServico(A, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM cliente_memoria WHERE tenant_id = tenant_atual() AND contato_id = ${CONTATO} AND fato LIKE ${`%(${modo})%`}`)
    expect((await conta())[0]!.n).toBe(0)
    await f.executar(ctx('autonomo'), { tipo: 'preferencia', fato: `prefere camiseta azul (${modo})` } as never)
    expect((await conta())[0]!.n).toBe(1)
  })
})

describe('Ações habilitáveis no menu (montarFerramentas)', () => {
  it('desligadas saem do menu; transferir e perfil ficam sempre', () => {
    const l: Ligacoes = {
      catalogo: {} as never, pedido: {} as never, conhecimento: { async buscar() { return { trechos: [] } } },
      acoes: { catalogo: false, pedido: true, proposta: false, memoria: false, conhecimento: false },
    }
    const { ferramentas, capacidades } = montarFerramentas(l)
    const nomes = ferramentas.map((f) => f.nome)
    expect(nomes).toEqual(['pedido_ver', 'pedido_itens', 'atendimento_transferir', 'cliente_perfil'])
    expect(capacidades).toEqual({ catalogo: false, pedido: true, conhecimento: false, proposta: false })
    const tudoDesligado = montarFerramentas({ ...l, acoes: { catalogo: false, pedido: false, proposta: false, memoria: false, conhecimento: false } })
    expect(tudoDesligado.ferramentas.map((f) => f.nome)).toEqual(['atendimento_transferir', 'cliente_perfil'])
  })
})

describe('Atualizar a partir de documento (só rascunho)', () => {
  const sugestao = (extra: Record<string, unknown> = {}) => ({
    orientacoes: 'Comece pelo volume; ofereça a grade completa antes de falar de cor.',
    qualificacao: null,
    mensagens: { abertura: null, handoff: null, foraDoHorario: null, avisoEspera: null, despedida: 'Obrigada, {nome}! Qualquer coisa, é só chamar.' },
    frasesProibidasNovas: ['pronta entrega'], gatilhosHandoffNovos: ['advogado'],
    resumoMudancas: ['Nova orientação de abordagem por volume.', 'Despedida padronizada.'],
    ...extra,
  })
  const llmCom = (...saidas: unknown[]): PortaLlmFerramentas => {
    let i = 0
    return {
      nome: 'falso', capacidades: { ferramentas: false, saidaEstruturada: true, cacheDePrefixo: false },
      async rodar(): Promise<ResultadoLaco> {
        const saida = saidas[Math.min(i++, saidas.length - 1)]
        return { ok: true, saida, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 1000, saida: 200, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
      },
    }
  }

  it('dado arquivo txt, então vira RASCUNHO com resumo; ações e persona intactas; a publicada não muda', async () => {
    depsPlaybook.llm = llmCom(sugestao({ acoes: { catalogo: false } }))
    const antes = await espelho(CANAL)
    const texto = 'Política comercial 2026: sempre perguntar volume primeiro e apresentar a grade completa.'
    const r = await chamar(A, 'POST', '/v1/agente/playbook/a-partir-de-documento', {
      canalId: CANAL, nome: 'politica-2026.txt', tipo: 'text/plain', conteudoBase64: Buffer.from(texto).toString('base64'),
    })
    expect(r.statusCode).toBe(201)
    const s = r.json() as { versao: { estado: string; origem: string; documentoNome: string; conteudo: ConteudoPlaybook }; resumoMudancas: string[] }
    expect(s.versao).toMatchObject({ estado: 'rascunho', origem: 'documento', documentoNome: 'politica-2026.txt' })
    expect(s.resumoMudancas).toHaveLength(2)
    expect(s.versao.conteudo.acoes).toEqual(antes.playbook!.conteudo.acoes)
    expect(s.versao.conteudo.persona).toEqual(antes.playbook!.conteudo.persona)
    expect(s.versao.conteudo.compliance.frasesProibidas).toEqual([...antes.playbook!.conteudo.compliance.frasesProibidas, 'pronta entrega'])
    expect((await espelho(CANAL)).playbook!.numero).toBe(antes.playbook!.numero)
    // De novo com rascunho aberto: 409, sem chamar o LLM para nada.
    expect((await chamar(A, 'POST', '/v1/agente/playbook/a-partir-de-documento', { canalId: CANAL, texto })).statusCode).toBe(409)
    await chamar(A, 'DELETE', `/v1/agente/playbook/rascunho?canalId=${CANAL}`)
  })

  it('dado o LLM insistindo em valor na mensagem, então 422 nomeado e nenhum rascunho', async () => {
    const ruim = sugestao({ mensagens: { abertura: 'Oi! Tudo a partir de R$ 19,90.', handoff: null, foraDoHorario: null, avisoEspera: null, despedida: null } })
    depsPlaybook.llm = llmCom(ruim, ruim)
    const r = await chamar(A, 'POST', '/v1/agente/playbook/a-partir-de-documento', { canalId: CANAL, texto: 'Promoção de lançamento: tudo a partir de dezenove e noventa.' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'playbook.sugestao_invalida', campos: ['mensagens.abertura'] })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_playbook_versao WHERE tenant_id = ${A} AND publicada_em IS NULL`
    expect(n!.n).toBe(0)
  })
})
