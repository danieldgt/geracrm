import { describe, it, expect } from 'vitest'
import { paraCsv } from '../../compartilhado/ui/csv.js'
import { escalarBarras } from './relatorio-dimensao.regras.js'
import {
  barrasDeFaixas, barrasDeMensagens, barrasDeVendas, csvConversao, csvOperacional, csvVendas, csvVendedores, csvWhatsapp,
  formatarDias, formatarDuracaoSeg, formatarPercentual, formatarVariacao, mensagemDoErro, nomeDaFaixa, rotuloDoDia,
  tendenciaDe, variacaoPct, type ItemVendas, type RespostaOperacional,
} from './relatorios-gestao.regras.js'

const reais = (c: number): string => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`

describe('variação mês × anterior', () => {
  it('percentual com 1 casa, positivo e negativo', () => {
    expect(variacaoPct(150, 100)).toBe(50)
    expect(variacaoPct(90, 100)).toBe(-10)
    expect(variacaoPct(2, 3)).toBe(-33.3)
    expect(variacaoPct(100, 100)).toBe(0)
  })
  it('sem base: anterior 0 não vira infinito', () => {
    expect(variacaoPct(0, 0)).toBe(0)
    expect(variacaoPct(5, 0)).toBeNull()
  })
  it('tendência e texto sempre com sinal (nunca só cor)', () => {
    expect(tendenciaDe(12.5)).toBe('alta')
    expect(tendenciaDe(-3)).toBe('queda')
    expect(tendenciaDe(0)).toBe('estavel')
    expect(tendenciaDe(null)).toBe('sem-base')
    expect(formatarVariacao(12.5)).toBe('+12,5%')
    expect(formatarVariacao(-3)).toBe('-3%')
    expect(formatarVariacao(0)).toBe('0%')
    expect(formatarVariacao(null)).toBe('sem base')
  })
})

describe('formatação', () => {
  it('duração em segundos', () => {
    expect(formatarDuracaoSeg(null)).toBe('—')
    expect(formatarDuracaoSeg(45)).toBe('45 s')
    expect(formatarDuracaoSeg(60)).toBe('1 min')
    expect(formatarDuracaoSeg(390)).toBe('6 min 30 s')
    expect(formatarDuracaoSeg(3720)).toBe('1 h 2 min')
    expect(formatarDuracaoSeg(7200)).toBe('2 h')
  })
  it('dias, percentual, dia do mês e faixa', () => {
    expect(formatarDias(null)).toBe('—')
    expect(formatarDias(1)).toBe('1 dia')
    expect(formatarDias(44.3)).toBe('44,3 dias')
    expect(formatarPercentual(0.3333)).toBe('33,3%')
    expect(formatarPercentual(null)).toBe('—')
    expect(rotuloDoDia('2026-09-10')).toBe('10/09')
    expect(nomeDaFaixa('0-7')).toBe('0-7 dias')
    expect(nomeDaFaixa('90+')).toBe('Mais de 90 dias')
  })
  it('mensagem do erro de período; código desconhecido cai na orientação de conexão', () => {
    expect(mensagemDoErro('periodo.longo_demais')).toContain('366')
    expect(mensagemDoErro('relatorio.limite_invalido')).toContain('1440')
    expect(mensagemDoErro(null)).toContain('conexão')
    expect(mensagemDoErro('x.y')).toContain('conexão')
  })
})

describe('barras', () => {
  const faixas = [
    { faixa: '0-7', contatos: 3, percentual: 0.75 }, { faixa: '8-15', contatos: 1, percentual: 0.25 }, { faixa: '90+', contatos: 0, percentual: 0 },
  ]
  it('faixas: rótulo ao lado, valor e participação no texto', () => {
    const b = barrasDeFaixas(faixas)
    expect(b.map((x) => x.rotulo)).toEqual(['0-7 dias', '8-15 dias', 'Mais de 90 dias'])
    expect(b[0]!.texto).toBe('3 (75%)')
    expect(escalarBarras(b).map((x) => x.largura)).toEqual([100, 33.3, 0])
  })
  it('a escala preserva o texto do valor', () => {
    expect(escalarBarras(barrasDeFaixas(faixas))[0]!.texto).toBe('3 (75%)')
  })
  it('vendas por valor e mensagens por dia', () => {
    const itens: ItemVendas[] = [{ chave: 'a', rotulo: 'A', pedidos: 2, valorCentavos: 12345, ticketMedioCentavos: 6173, percentual: 0.5 }]
    expect(barrasDeVendas(itens, reais)[0]).toEqual({ chave: 'a', rotulo: 'A', valor: 12345, texto: 'R$ 123,45 (50%)' })
    expect(barrasDeMensagens([{ dia: '2026-09-10', recebidas: 4, enviadas: 9 }], 'enviadas')).toEqual([{ chave: '2026-09-10', rotulo: '10/09', valor: 9 }])
  })
})

describe('linhas de CSV', () => {
  it('vendas: valores em reais e participação em % numéricos', () => {
    const itens: ItemVendas[] = [{ chave: 'a', rotulo: 'Camiseta', pedidos: 2, valorCentavos: 30000, ticketMedioCentavos: 15000, percentual: 0.8571 }]
    const csv = csvVendas(itens, 'Produto')
    expect(csv.colunas[0]).toEqual({ chave: 'rotulo', rotulo: 'Produto' })
    expect(csv.linhas).toEqual([{ rotulo: 'Camiseta', pedidos: 2, valor: 300, ticket: 150, percentual: 85.71 }])
    expect(paraCsv(csv.colunas, csv.linhas)).toContain('Camiseta;2;300;150;85,71')
  })
  it('conversão: faixas e vendedores no mesmo arquivo, média nula vira célula vazia', () => {
    const csv = csvConversao(
      [{ faixa: '90+', contatos: 1, percentual: 0.5 }],
      [{ chave: 'v', rotulo: 'Vera', contatos: 2, mediaDias: 44.3, maisRapidaDias: 7, maisLentaDias: 106 }],
    )
    expect(csv.linhas).toEqual([
      { secao: 'Faixa', item: 'Mais de 90 dias', contatos: 1, percentual: 50 },
      { secao: 'Vendedor', item: 'Vera', contatos: 2, media: 44.3, rapida: 7, lenta: 106 },
    ])
    const texto = paraCsv(csv.colunas, csv.linhas)
    expect(texto).toContain('Vendedor;Vera;2;;44,3;7;106')
  })
  it('vendedores: taxa em % e dinheiro em reais', () => {
    const csv = csvVendedores([{
      usuarioId: 'u', nome: 'Vera', contatosNovos: 4, tarefasConcluidas: 2, conversoes: 1, taxa: 0.25, pedidos: 1,
      valorCentavos: 7000, ticketMedioCentavos: 7000,
    }])
    expect(csv.linhas[0]).toMatchObject({ nome: 'Vera', taxa: 25, valor: 70, ticket: 70 })
    expect(csvVendedores([{ usuarioId: 'u', nome: 'Z', contatosNovos: 0, tarefasConcluidas: 1, conversoes: 0, taxa: null, pedidos: 0, valorCentavos: 0, ticketMedioCentavos: 0 }]).linhas[0]!['taxa']).toBeNull()
  })
  it('operacional: comparativo com variação, depois funil e tops', () => {
    const r: RespostaOperacional = {
      periodo: { inicio: '2026-09-01', fim: '2026-09-30', fuso: 'America/Sao_Paulo' },
      mesAtual: { inicio: '2026-09-01', fim: '2026-09-30', contatosNovos: 6, conversoes: 2, valorCentavos: 35000 },
      mesAnterior: { inicio: '2026-08-01', fim: '2026-08-30', contatosNovos: 4, conversoes: 0, valorCentavos: 4000 },
      funil: [{ chave: 'lead', rotulo: 'Lead', oportunidades: 2 }],
      topOrigens: [{ chave: 'o', rotulo: 'Instagram', total: 5 }], topFormularios: [{ chave: 'f', rotulo: 'LP Verão', total: 3 }],
    }
    const l = csvOperacional(r).linhas
    expect(l[0]).toMatchObject({ item: 'Contatos novos', atual: 6, anterior: 4, variacao: 50 })
    expect(l[1]).toMatchObject({ item: 'Conversões', atual: 2, anterior: 0, variacao: null })
    expect(l[2]).toMatchObject({ item: 'Valor (R$)', atual: 350, anterior: 40, variacao: 775 })
    expect(l.map((x) => x['secao'])).toEqual([
      'Mês atual × anterior', 'Mês atual × anterior', 'Mês atual × anterior',
      'Funil (oportunidades abertas)', 'Top origens (contatos novos)', 'Top formulários (respostas)',
    ])
  })
  it('whatsapp: uma linha por dia', () => {
    expect(csvWhatsapp([{ dia: '2026-09-10', recebidas: 1, enviadas: 2 }]).linhas).toEqual([{ dia: '2026-09-10', recebidas: 1, enviadas: 2 }])
  })
})
