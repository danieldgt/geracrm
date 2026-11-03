import { describe, it, expect } from 'vitest'
import {
  ABAS_FICHA, ORDEM_SELOS, acoesVisiveis, camposDeInformacao, estadoDaAcao, formatarTamanho, itemParaExibicao,
  linhasPerfilDeCompra, mesclarFeed, selosDaFicha, validarArquivo, type DadosFicha, type ItemFeed,
} from './ficha.regras.js'

const base: DadosFicha = {
  id: 'c1', nome: 'Zé', razaoSocial: null, nomeFantasia: null, email: null, modalidade: 'atacado', prioridade: 'alta',
  temperatura: 'quente', qualificado: null, valorEstimadoCentavos: null, observacoes: null,
  telefones: [{ seq: 1 }],
  metricas: { totalCentavos: 123456, ticketMedioCentavos: 5000, diasSemComprar: 12, segmento: { codigo: 'campeao', rotulo: 'Campeão' } },
}

describe('selosDaFicha', () => {
  it('ordem fixa: segmento, qualificação, prioridade, temperatura, modalidade', () => {
    expect(selosDaFicha(base).map((s) => s.id)).toEqual([...ORDEM_SELOS])
    expect(selosDaFicha(base).map((s) => s.rotulo)).toEqual(['Campeão', 'Novo', 'Prioridade alta', 'Quente', 'Atacado'])
  })
  it('vazio não aparece (sem vendas, sem prioridade); qualificação sempre aparece', () => {
    const s = selosDaFicha({ ...base, metricas: null, prioridade: null, temperatura: null, modalidade: null })
    expect(s.map((x) => x.id)).toEqual(['qualificacao'])
  })
  it('qualificado/descartado mudam rótulo e tom; segmento carrega o código RFV para a cor', () => {
    expect(selosDaFicha({ ...base, qualificado: true })[1]).toMatchObject({ rotulo: 'Qualificado', tom: 'sucesso' })
    expect(selosDaFicha({ ...base, qualificado: false })[1]).toMatchObject({ rotulo: 'Descartado', tom: 'erro' })
    expect(selosDaFicha(base)[0]!.codigoRfv).toBe('campeao')
  })
  it('urgente é erro; alta é atenção; temperatura quente é erro', () => {
    expect(selosDaFicha({ ...base, prioridade: 'urgente' })[2]!.tom).toBe('erro')
    expect(selosDaFicha(base)[2]!.tom).toBe('atencao')
    expect(selosDaFicha(base)[3]!.tom).toBe('erro')
  })
})

describe('acoesVisiveis', () => {
  const ids = (f: Parameters<typeof acoesVisiveis>[0], agenda = false) => acoesVisiveis(f, agenda).map((a) => a.id)
  it('contato novo: pode qualificar e descartar', () => {
    expect(ids(base)).toEqual(['editar', 'conversar', 'novo-pedido', 'nova-tarefa', 'agendar', 'qualificar', 'descartar'])
  })
  it('qualificado só pode descartar; descartado só pode qualificar', () => {
    expect(ids({ ...base, qualificado: true })).not.toContain('qualificar')
    expect(ids({ ...base, qualificado: true })).toContain('descartar')
    expect(ids({ ...base, qualificado: false })).toContain('qualificar')
    expect(ids({ ...base, qualificado: false })).not.toContain('descartar')
  })
  it('sem telefone, Conversar fica desabilitado com a dica; Agenda desligada, Agendar desabilitado', () => {
    const a = acoesVisiveis({ ...base, telefones: [] })
    expect(a.find((x) => x.id === 'conversar')).toMatchObject({ desabilitada: true })
    expect(a.find((x) => x.id === 'conversar')!.dica).toContain('telefone')
    expect(a.find((x) => x.id === 'agendar')).toMatchObject({ desabilitada: true, dica: 'Disponível com o módulo Agenda.' })
    expect(acoesVisiveis(base, true).find((x) => x.id === 'agendar')!.desabilitada).toBe(false)
  })
  it('a ação vira o estado que a API entende', () => {
    expect(estadoDaAcao('qualificar')).toBe('qualificado')
    expect(estadoDaAcao('descartar')).toBe('descartado')
  })
})

describe('feed', () => {
  const item = (o: Partial<ItemFeed> & { id: string }): ItemFeed => ({
    tipo: 'comentario', em: '2026-11-03T10:00:00.000Z', autor: null, texto: 'x', ...o,
  })
  it('monta a exibição: ícone, rótulo, tom e autor (ausente = Sistema)', () => {
    expect(itemParaExibicao(item({ id: 'a', tipo: 'tarefa_concluida', autor: { id: 'u', nome: 'Vera' } })))
      .toMatchObject({ icone: 'check-square', rotuloTipo: 'Tarefa concluída', tom: 'sucesso', autor: 'Vera' })
    expect(itemParaExibicao(item({ id: 'b', tipo: 'handoff' })).autor).toBe('Sistema')
  })
  it('mesclar não repete id (item novo empurrou a borda) e preserva a ordem', () => {
    const a = [item({ id: '1' }), item({ id: '2' })]
    const m = mesclarFeed(a, [item({ id: '2' }), item({ id: '3' })])
    expect(m.map((i) => i.id)).toEqual(['1', '2', '3'])
  })
})

describe('perfil de compra', () => {
  it('agrupa por tipo na ordem preferência, objeção, contexto, restrição', () => {
    const l = linhasPerfilDeCompra([
      { id: '1', tipo: 'restricao', fato: 'só paga a prazo' }, { id: '2', tipo: 'preferencia', fato: 'tamanho G' },
      { id: '3', tipo: 'desconhecido', fato: 'x' }, { id: '4', tipo: 'objecao', fato: 'acha caro' },
    ])
    expect(l.map((i) => i.rotulo)).toEqual(['Preferência', 'Objeção', 'Restrição', 'desconhecido'])
    expect(l[0]!.valor).toBe('tamanho G')
  })
  it('vazio devolve lista vazia (a tela explica que o agente preenche conversando)', () => {
    expect(linhasPerfilDeCompra([])).toEqual([])
  })
})

describe('informações da lateral', () => {
  it('traz carteira, origem, criado, total, ticket e dias sem comprar; sem carteira diz "Sem carteira"', () => {
    const l = camposDeInformacao({ ...base, origem: 'Indicação', criadoEm: '2026-01-05T12:00:00.000Z', vendedor: { id: 'u', nome: 'Vera' } })
    expect(l.map((i) => i.rotulo)).toEqual(['Segmento', 'Vendedor', 'Origem', 'Criado em', 'Total em vendas', 'Ticket médio', 'Dias sem comprar'])
    expect(l.find((i) => i.rotulo === 'Vendedor')!.valor).toBe('Vera')
    expect(l.find((i) => i.rotulo === 'Dias sem comprar')!.valor).toBe(12)
    expect(camposDeInformacao(base).find((i) => i.rotulo === 'Vendedor')!.valor).toBe('Sem carteira')
    expect(camposDeInformacao({ ...base, metricas: null }).find((i) => i.rotulo === 'Total em vendas')!.valor).toBeNull()
  })
})

describe('arquivos', () => {
  it('valida tipo, tamanho e vazio como conveniência (a API é a regra)', () => {
    expect(validarArquivo({ name: 'proposta.pdf', size: 1000 })).toBeNull()
    expect(validarArquivo({ name: 'virus.exe', size: 1000 })).toContain('Tipo não permitido')
    expect(validarArquivo({ name: 'sem-extensao', size: 1000 })).toContain('Tipo não permitido')
    expect(validarArquivo({ name: 'grande.pdf', size: 15 * 1024 * 1024 + 1 })).toContain('15 MB')
    expect(validarArquivo({ name: 'vazio.txt', size: 0 })).toContain('vazio')
  })
  it('formata o tamanho legível', () => {
    expect(formatarTamanho(512)).toBe('512 B')
    expect(formatarTamanho(2048)).toBe('2 KB')
    expect(formatarTamanho(3 * 1024 * 1024)).toBe('3,0 MB')
  })
})

describe('abas', () => {
  it('na ordem do plano: Feed, Dados, Pedidos, Tarefas, WhatsApp, Agenda', () => {
    expect(ABAS_FICHA.map((a) => a.rotulo)).toEqual(['Feed', 'Dados', 'Pedidos', 'Tarefas', 'WhatsApp', 'Agenda'])
  })
})
