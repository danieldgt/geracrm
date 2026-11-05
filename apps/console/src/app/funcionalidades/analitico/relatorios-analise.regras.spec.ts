import { describe, it, expect } from 'vitest'
import { paraCsv } from '../../compartilhado/ui/csv.js'
import {
  adicionarVendedor, alternarSecao, avisoCsv, avisoTruncado, csvComparativo, csvDesempenho, csvFilialPorDia, csvRaioX, csvVisaoGeral,
  erroDosFiltros, FILTROS_VAZIOS, filtrosAtivos, formatarDataHora, intensidade, localDoContato, queryDosFiltros, queryVendedores,
  removerVendedor, resumoWhatsappImprimivel, SECOES_IMPRIMIVEIS, textoLimiteVendedores,
  type GrupoCoorte, type RespostaDesempenho, type RespostaRaioX, type RespostaVisaoGeral, type VendedorEscolhido,
} from './relatorios-analise.regras.js'
import { mensagemDoErro } from './relatorios-gestao.regras.js'

const v = (n: number): VendedorEscolhido => ({ id: `id-${n}`, nome: `Vendedor ${n}` })
const grupo = (rotulo: string, contatos: number): GrupoCoorte => ({ chave: rotulo, rotulo, contatos, convertidos: 1, taxa: 0.5, valorCentavos: 12345, percentual: 0.25 })

describe('comparativo: escolha de vendedores', () => {
  it('adiciona sem repetir', () => {
    const a = adicionarVendedor([], v(1))
    expect(a).toEqual({ lista: [v(1)], motivo: null })
    expect(adicionarVendedor(a.lista, v(1))).toEqual({ lista: [v(1)], motivo: 'repetido' })
  })
  it('limite de 10: o 11º é recusado e a lista não muda', () => {
    let lista: readonly VendedorEscolhido[] = []
    for (let i = 1; i <= 10; i++) lista = adicionarVendedor(lista, v(i)).lista
    expect(lista).toHaveLength(10)
    const r = adicionarVendedor(lista, v(11))
    expect(r.motivo).toBe('limite')
    expect(r.lista).toBe(lista)
  })
  it('remover libera a vaga', () => {
    let lista: readonly VendedorEscolhido[] = Array.from({ length: 10 }, (_, i) => v(i + 1))
    lista = removerVendedor(lista, 'id-3')
    expect(lista).toHaveLength(9)
    expect(adicionarVendedor(lista, v(11)).motivo).toBeNull()
  })
  it('query e contador', () => {
    expect(queryVendedores([v(1), v(2)])).toBe('vendedores=id-1,id-2')
    expect(textoLimiteVendedores(3)).toBe('3 de 10')
    expect(textoLimiteVendedores(10)).toBe('10 de 10 (limite atingido)')
  })
  it('erros tipificados da API têm texto em pt-BR', () => {
    expect(mensagemDoErro('relatorio.vendedores_demais')).toContain('10')
    expect(mensagemDoErro('relatorio.filtro_invalido')).toContain('filtro')
    expect(mensagemDoErro('relatorio.nao_encontrado')).toContain('acesso')
  })
})

describe('contatos completo: filtros', () => {
  it('só os preenchidos entram na query; UF em maiúsculas; busca aparada e codificada', () => {
    expect(queryDosFiltros(FILTROS_VAZIOS)).toBe('')
    expect(queryDosFiltros({ ...FILTROS_VAZIOS, uf: ' sp ', busca: ' ana & cia ', convertido: 'sim' }))
      .toBe('uf=SP&convertido=sim&busca=ana%20%26%20cia')
  })
  it('conta filtros ativos', () => {
    expect(filtrosAtivos(FILTROS_VAZIOS)).toBe(0)
    expect(filtrosAtivos({ ...FILTROS_VAZIOS, uf: 'SP', busca: '  ' })).toBe(1)
  })
  it('valida UF e busca antes de chamar a API', () => {
    expect(erroDosFiltros(FILTROS_VAZIOS)).toBeNull()
    expect(erroDosFiltros({ ...FILTROS_VAZIOS, uf: 'SPP' })).toContain('2 letras')
    expect(erroDosFiltros({ ...FILTROS_VAZIOS, busca: 'a' })).toContain('2 letras')
    expect(erroDosFiltros({ ...FILTROS_VAZIOS, uf: 'rj', busca: 'ab' })).toBeNull()
  })
  it('aviso do CSV do servidor', () => {
    expect(avisoCsv(true)).toContain('1000')
    expect(avisoCsv(false)).toBe('Arquivo gerado.')
  })
  it('data no fuso do tenant e local do contato', () => {
    expect(formatarDataHora('2026-10-01T02:59:59Z', 'America/Sao_Paulo')).toContain('30/09/2026')
    expect(formatarDataHora('2026-10-01T03:00:00Z', 'America/Sao_Paulo')).toContain('01/10/2026')
    expect(formatarDataHora('lixo', 'America/Sao_Paulo')).toBe('—')
    expect(formatarDataHora('2026-10-01T03:00:00Z', 'Fuso/Inexistente')).not.toBe('—')
    expect(localDoContato({ cidade: 'Campinas', uf: 'SP' })).toBe('Campinas / SP')
    expect(localDoContato({ cidade: null, uf: 'SP' })).toBe('SP')
    expect(localDoContato({ cidade: null, uf: null })).toBe('—')
  })
})

describe('CSVs (valores em reais com vírgula, percentual 0-100)', () => {
  it('comparativo: uma linha por vendedor e o total', () => {
    const totais = { contatosNovos: 5, tarefasConcluidas: 3, conversoes: 2, taxa: 0.4, pedidos: 3, valorCentavos: 35000, ticketMedioCentavos: 11667 }
    const csv = csvComparativo({
      itens: [{ usuarioId: 'a', nome: 'Vera', contatosNovos: 3, tarefasConcluidas: 2, conversoes: 1, taxa: 0.3333, pedidos: 2, valorCentavos: 28000, ticketMedioCentavos: 14000 }],
      totais,
    })
    expect(csv.linhas).toHaveLength(2)
    expect(csv.linhas[1]).toMatchObject({ nome: 'Total', valor: 350, taxa: 40 })
    expect(paraCsv(csv.colunas, csv.linhas)).toContain('Vera;3;2;1;33,33;2;280;140')
  })
  it('visão geral: total, filiais e formulários; filial × dia em colunas por dia', () => {
    const r: RespostaVisaoGeral = {
      periodo: { inicio: '2026-09-01', fim: '2026-09-02', fuso: 'America/Sao_Paulo' },
      totais: { contatos: 5, convertidos: 2, taxa: 0.4, pedidos: 3, valorCentavos: 35000, ticketMedioCentavos: 11667, respostasFormulario: 3 },
      porFilial: [grupo('Filial X', 3)], porFilialTruncado: false,
      filialPorDia: { dias: ['2026-09-01', '2026-09-02'], series: [{ chave: 'x', rotulo: 'Filial X', total: 3, porDia: [2, 1] }], truncado: false },
      porFormulario: [{ chave: 'f', rotulo: 'LP Verão', respostas: 2, contatos: 1, convertidos: 1, valorCentavos: 28000 }], porFormularioTruncado: false,
    }
    const geral = csvVisaoGeral(r)
    expect(geral.linhas.map((l) => l['quadro'])).toEqual(['Total', 'Filial', 'Formulário'])
    const dia = csvFilialPorDia(r.filialPorDia)
    expect(dia.colunas.map((c) => c.rotulo)).toEqual(['Filial', 'Total', '2026-09-01', '2026-09-02'])
    expect(dia.linhas[0]).toMatchObject({ filial: 'Filial X', total: 3, '2026-09-01': 2, '2026-09-02': 1 })
  })
  it('raio-x e desempenho: blocos por quadro', () => {
    const rx: RespostaRaioX = {
      periodo: { inicio: 'a', fim: 'b', fuso: 'x' }, eixo: 'vendedor', chave: 'k', rotulo: 'Vera',
      cartoes: { contatos: 3, convertidos: 1, taxa: 0.3333, pedidos: 2, valorCentavos: 28000, ticketMedioCentavos: 14000, respostas: null, tarefasConcluidas: 2 },
      porDia: [{ dia: '2026-09-01', contatos: 2, convertidos: 0 }], origens: [grupo('Instagram', 1)], origensTruncado: false,
      qualificacao: [grupo('Novo', 3)], ufs: [grupo('SP', 2)], ufsTruncado: false,
    }
    expect(csvRaioX(rx).linhas.map((l) => l['quadro'])).toEqual(['Resumo', 'Origem', 'Qualificação', 'UF', 'Dia'])
    const dsp: RespostaDesempenho = {
      periodo: { inicio: 'a', fim: 'b', fuso: 'x' }, contatos: 5,
      completude: [{ campo: 'telefone', rotulo: 'Telefone', preenchidos: 1, total: 5, percentual: 0.2 }], cadastroCompleto: 1,
      tipoPessoa: [grupo('Pessoa física (CPF)', 2)], qualificacao: [], origem: [], canal: [grupo('Zap', 2)], uf: [], cidade: [], funil: [],
      truncado: { origem: false, canal: false, uf: false, cidade: false, funil: false },
    }
    const linhas = csvDesempenho(dsp).linhas
    expect(linhas[0]).toMatchObject({ quadro: 'Completude', rotulo: 'Telefone', percentual: 20 })
    expect(linhas.map((l) => l['quadro'])).toEqual(['Completude', 'Tipo de pessoa', 'Canal'])
  })
  it('aviso de top N só quando truncado', () => {
    expect(avisoTruncado(false)).toBe('')
    expect(avisoTruncado(true, 20)).toContain('20')
  })
})

describe('imprimíveis', () => {
  it('alterna seções e nunca fica sem nenhuma', () => {
    let ativas: readonly (typeof SECOES_IMPRIMIVEIS)[number][] = [...SECOES_IMPRIMIVEIS]
    ativas = alternarSecao(ativas, 'funil')
    expect(ativas).toEqual(['origens', 'motivos', 'whatsapp'])
    ativas = alternarSecao(ativas, 'funil')
    expect(ativas).toEqual(['funil', 'origens', 'motivos', 'whatsapp']) // volta na ordem do relatório
    expect(alternarSecao(['motivos'], 'motivos')).toEqual(['motivos'])
  })
  it('resumo do WhatsApp para o papel', () => {
    const r = resumoWhatsappImprimivel({
      cartoes: { recebidas: 1200, enviadas: 30, enviadasHumanas: 10, enviadasAutomaticas: 20, falhas: 0, conversasIniciadas: 4, atendimentos: 6, respondidasNoLimite: 3, pctNoLimite: 0.5 },
      primeiraResposta: [], porDia: [{ dia: '2026-09-01', recebidas: 1, enviadas: 2 }],
    })
    expect(r.cartoes[0]).toEqual({ rotulo: 'Mensagens recebidas', valor: '1.200' })
    expect(r.dias).toHaveLength(1)
  })
  it('intensidade do mapa filial × dia', () => {
    expect(intensidade(0, 10)).toBe(0)
    expect(intensidade(5, 10)).toBe(0.5)
    expect(intensidade(3, 0)).toBe(0)
  })
})
