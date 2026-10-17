import { describe, it, expect } from 'vitest'
import {
  aberturaDoPlaybook, aplicarSugestao, complianceEfetivo, diffPorSecao, errosDaMensagemPronta, lerPlaybookVigente,
  limitesDoPlaybook, mensagemProntaSegura, personaDoPlaybook, playbookDaConfig, playbookPadrao, renderizarMensagem,
  slotsDoPlaybook, validarPlaybook, type ConteudoPlaybook,
} from './agente-playbook.js'
import { filtrarSaida } from './agente-filtro.js'

const valido = (): ConteudoPlaybook => ({
  ...playbookPadrao(),
  persona: { nome: 'Lia', loja: 'Atacado Sol', tom: 'neutro', usaEmojis: false, saudacao: '' },
  qualificacao: [
    { slot: 'volume', pergunta: 'Quantas peças você costuma comprar por pedido?', obrigatorio: true, ativo: true },
    { slot: 'cidade', pergunta: 'Para qual cidade seria a entrega?', obrigatorio: false, ativo: false },
  ],
})

describe('Playbook — a tela só acrescenta restrição (ADR-029 §5)', () => {
  it('dado conteúdo válido, então passa e deduplica o compliance', () => {
    const c = valido()
    c.compliance = { frasesProibidas: ['Consignação', 'consignacao'], gatilhosHandoff: [] }
    const r = validarPlaybook(c)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.conteudo.compliance.frasesProibidas).toEqual(['Consignação'])
  })

  it.each([
    ['desligar a identificação como assistente', (c: Record<string, any>) => { c['persona'].identificaComoRobo = false }],
    ['desligar transferir', (c: Record<string, any>) => { c['acoes'].atendimento_transferir = false }],
    ['remover frase da base', (c: Record<string, any>) => { c['compliance'].removerBase = ['garantia_sem_fonte'] }],
    ['desligar o filtro', (c: Record<string, any>) => { c['guardrails'] = { filtro: false } }],
    ['desligar o guardrail numérico', (c: Record<string, any>) => { c['estilo'].numeroSemFonte = true }],
  ])('dado tentativa de %s, então é recusada com campo nomeado', (_n, mexer) => {
    const c = structuredClone(valido()) as unknown as Record<string, any>
    mexer(c)
    const r = validarPlaybook(c)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erros[0]!.mensagem).toMatch(/não permitido|guardrails/i)
  })

  it('dado mensagem pronta com R$, %, marcador desconhecido, frase proibida ou prazo no aviso, então é recusada', () => {
    expect(errosDaMensagemPronta('Hoje sai por R$ 10,00!', 'abertura')).toMatch(/valor em reais/)
    expect(errosDaMensagemPronta('Ganhe 10% na primeira compra', 'abertura')).toMatch(/percentual/)
    expect(errosDaMensagemPronta('Oi {cliente}!', 'abertura')).toMatch(/Marcador desconhecido/)
    expect(errosDaMensagemPronta('Garantimos entrega amanhã para você.', 'abertura')).toMatch(/filtro de segurança/)
    expect(errosDaMensagemPronta('Uma pessoa te responde em até 2 horas.', 'handoff')).toMatch(/prazo/)
    expect(errosDaMensagemPronta('Oi, {nome}! Aqui é {assistente}, da {empresa}.', 'abertura')).toBeNull()
  })

  it('dado slot repetido ou proposta sem pedido, então é recusado', () => {
    const c = valido()
    c.qualificacao.push({ slot: 'volume', pergunta: 'De novo: quantas peças?', obrigatorio: false, ativo: true })
    c.acoes = { ...c.acoes, pedido: false, proposta: true }
    const r = validarPlaybook(c)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erros.map((e) => e.campo)).toEqual(['qualificacao[2].slot', 'acoes.proposta'])
  })
})

describe('Importação e espelho', () => {
  it('dado agente_config de hoje, então a v1 reproduz persona, slots e compliance (nada muda ao importar)', () => {
    const c = playbookDaConfig({
      persona: { nome: 'Lia', loja: 'Sol', tom: 'formal', usaEmojis: true, saudacao: 'Olá!', identificaComoRobo: true, lixo: 1 },
      qualificacao: ['volume', 'inexistente', 'prazo', 'volume'],
      compliance: { frasesProibidas: ['consignação', 'x'], gatilhosHandoff: ['advogado'] },
    })
    expect(c.persona).toEqual({ nome: 'Lia', loja: 'Sol', tom: 'formal', usaEmojis: true, saudacao: 'Olá!' })
    expect(slotsDoPlaybook(c)).toEqual(['volume', 'prazo'])
    expect(c.compliance).toEqual({ frasesProibidas: ['consignação'], gatilhosHandoff: ['advogado'] })
    expect(c.estilo).toEqual({ tratamento: 'voce', maxCaracteres: null, maxPerguntas: null, orientacoes: '' })
    expect(validarPlaybook(c).ok).toBe(true)
    expect(personaDoPlaybook(c).identificaComoRobo).toBe(true)
  })

  it('dado espelho inválido, então lê como sem playbook (o padrão do código vale)', () => {
    expect(lerPlaybookVigente(null)).toBeNull()
    expect(lerPlaybookVigente({ versaoId: 'x', numero: 1, conteudo: { estilo: 1 } })).toBeNull()
    expect(lerPlaybookVigente({ versaoId: 'x', numero: 2, escopo: 'tenant', publicadaEm: '2026-10-17', conteudo: valido() })?.escopo).toBe('tenant')
  })

  it('compliance efetivo = número ∪ playbook; limites só quando definidos', () => {
    const c = valido()
    c.compliance = { frasesProibidas: ['frete grátis'], gatilhosHandoff: ['advogado'] }
    expect(complianceEfetivo({ frasesProibidas: ['consignação', 'Frete Grátis'], gatilhosHandoff: [] }, c))
      .toEqual({ frasesProibidas: ['consignação', 'Frete Grátis'], gatilhosHandoff: ['advogado'] })
    expect(limitesDoPlaybook(c)).toEqual({})
    c.estilo = { ...c.estilo, maxPerguntas: 1, maxCaracteres: 200 }
    expect(limitesDoPlaybook(c)).toEqual({ maxCaracteres: 200, maxPerguntas: 1 })
  })

  it('maxPerguntas aplicado no filtro de saída: fica a última pergunta', () => {
    const r = filtrarSaida('Temos em várias cores. Qual cor você prefere? E qual tamanho?', { limites: { maxPerguntas: 1 } })
    expect(r.texto).toBe('Temos em várias cores. E qual tamanho?')
  })
})

describe('Mensagens prontas', () => {
  it('placeholders: {nome} sem nome some com a vírgula', () => {
    expect(renderizarMensagem('Oi, {nome}! Sou {assistente}, da {empresa}.', { nome: 'Ana Maria', assistente: 'Lia', empresa: 'Sol' }))
      .toBe('Oi, Ana! Sou Lia, da Sol.')
    expect(renderizarMensagem('Oi, {nome}! Tudo bem?', { assistente: 'Lia' })).toBe('Oi! Tudo bem?')
  })

  it('abertura do playbook SEMPRE identifica a assistente e mostra o aviso de privacidade', () => {
    const sem = aberturaDoPlaybook('Oi, {nome}! Que bom te ver por aqui.', { assistenteNome: 'Lia', loja: 'Sol', clienteNome: 'Ana' })
    expect(sem).toBe('Oi, Ana! Que bom te ver por aqui. Sou Lia, assistente virtual da Sol (uma inteligência artificial). Esta conversa fica registrada para te atender melhor.')
    const com = aberturaDoPlaybook('Oi! Sou {assistente}, assistente virtual da {empresa}', { assistenteNome: 'Lia', loja: 'Sol', privacidade: { url: 'https://sol.test/privacidade' } })
    expect(com).toBe('Oi! Sou Lia, assistente virtual da Sol. Esta conversa fica registrada para te atender melhor. Aviso de privacidade: https://sol.test/privacidade')
  })

  it('mensagem que a base de hoje bloqueia não é usada (volta o texto do código)', () => {
    const c = valido()
    c.mensagens = { ...c.mensagens, handoff: 'Garantimos entrega amanhã, já te passo.' }
    expect(mensagemProntaSegura(c, 'handoff', { assistente: 'Lia' })).toBeNull()
    c.mensagens = { ...c.mensagens, handoff: 'Combinado, {nome}! Uma pessoa da equipe segue com você por aqui.' }
    expect(mensagemProntaSegura(c, 'handoff', { assistente: 'Lia' })).toBe('Combinado! Uma pessoa da equipe segue com você por aqui.')
  })
})

describe('diffPorSecao', () => {
  it('dado nada mudou, então nenhuma seção mudou', () => {
    expect(diffPorSecao(valido(), valido()).every((d) => !d.mudou)).toBe(true)
  })

  it('aponta campo a campo, com antes e depois, e a ordem do roteiro', () => {
    const a = valido()
    const b = valido()
    b.estilo = { ...b.estilo, maxPerguntas: 1 }
    b.compliance = { frasesProibidas: ['frete grátis'], gatilhosHandoff: [] }
    b.acoes = { ...b.acoes, memoria: false }
    const d = Object.fromEntries(diffPorSecao(a, b).map((x) => [x.secao, x]))
    expect(d['estilo']!.mudancas).toEqual([{ campo: 'Máx. perguntas por mensagem', antes: 'sem limite', depois: '1' }])
    expect(d['compliance']!.mudancas).toEqual([{ campo: 'Frase proibida: frete gratis', antes: null, depois: 'frete grátis' }])
    expect(d['acoes']!.mudancas).toEqual([{ campo: 'Anotar memória do cliente', antes: 'ligada', depois: 'desligada' }])
    expect(d['persona']!.mudou).toBe(false)
    const c = valido()
    c.qualificacao = [...c.qualificacao].reverse()
    const ordem = diffPorSecao(a, c).find((x) => x.secao === 'qualificacao')!
    expect(ordem.mudou).toBe(true)
  })

  it('dado sem anterior, então tudo é novo', () => {
    const d = diffPorSecao(null, valido())
    expect(d.find((x) => x.secao === 'persona')!.mudancas[0]).toMatchObject({ antes: null })
  })
})

describe('Sugestão a partir de documento', () => {
  it('nunca mexe em persona, limites de estilo nem ações; compliance só ganha itens', () => {
    const atual = valido()
    atual.compliance = { frasesProibidas: ['consignação'], gatilhosHandoff: [] }
    atual.estilo = { ...atual.estilo, maxPerguntas: 1 }
    const novo = aplicarSugestao(atual, {
      orientacoes: 'Pergunte primeiro o volume; ofereça a grade completa.',
      qualificacao: null,
      mensagens: { abertura: 'Oi, {nome}! Bem-vindo à {empresa}.', handoff: null, foraDoHorario: null, avisoEspera: null, despedida: null },
      frasesProibidasNovas: ['pronta entrega'], gatilhosHandoffNovos: [],
      resumoMudancas: ['Nova orientação de abordagem.'],
    }) as ConteudoPlaybook
    expect(novo.persona).toEqual(atual.persona)
    expect(novo.acoes).toEqual(atual.acoes)
    expect(novo.estilo.maxPerguntas).toBe(1)
    expect(novo.estilo.orientacoes).toMatch(/grade completa/)
    expect(novo.compliance.frasesProibidas).toEqual(['consignação', 'pronta entrega'])
    expect(novo.mensagens.abertura).toBe('Oi, {nome}! Bem-vindo à {empresa}.')
    expect(validarPlaybook(novo).ok).toBe(true)
  })
})
