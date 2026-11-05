import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Contrato dos componentes de lista. O ambiente de teste é node (sem DOM), então a
 * regra mora em funções puras (lista.regras, periodo, csv — testadas à parte) e aqui
 * se garante a casca: seletor, OnPush, exportação no index e entradas/saídas combinadas.
 */
const aqui = dirname(fileURLToPath(import.meta.url))
const ler = (f: string): string => readFileSync(resolve(aqui, f), 'utf8')

const componentes: { arquivo: string; classe: string; seletor: string; api: RegExp[] }[] = [
  { arquivo: 'tabela.componente.ts', classe: 'TabelaComponente', seletor: 'ui-tabela',
    api: [/colunas = input\.required/, /linhas = input/, /chaveLinha = input/, /selecionavel = input/, /selecionados = model/,
      /carregando = input/, /<table class="tabela"/, /<thead>/, /height: 40px/, /tabular-nums/, /white-space: nowrap/,
      /\[indeterminate\]/, /rolagem-x/, /select="\[uiVazio\]"/] },
  { arquivo: 'filtros.componente.ts', classe: 'FiltrosComponente', seletor: 'ui-filtros',
    api: [/DEBOUNCE_BUSCA_MS = 300/, /buscar = output/, /aplicar = output/, /limpar = output/, /align-items: end/, /container: filtros \/ inline-size/,
      /\[value\]="termo"/] },
  { arquivo: 'paginacao.componente.ts', classe: 'PaginacaoComponente', seletor: 'ui-paginacao',
    api: [/mostrados = input\.required/, /total = input/, /temMais = input/, /carregando = input/, /mais = output/, /Carregar mais/] },
  { arquivo: 'acoes-lote.componente.ts', classe: 'AcoesLoteComponente', seletor: 'ui-acoes-lote',
    api: [/quantidade = input\.required/, /limpar = output/, /Limpar seleção/, /@if \(quantidade\(\) > 0\)/] },
  { arquivo: 'stat-card.componente.ts', classe: 'StatCardComponente', seletor: 'ui-stat-card',
    api: [/valor = input\.required/, /rotulo = input\.required/, /tom = input<TomStat>/, /rotuloAcima = input/, /txt-kpi/,
      /--acao-suave/, /--sucesso-suave/, /--atencao-suave/, /--erro-suave/, /--ia-suave/] },
  { arquivo: 'filtro-periodo.componente.ts', classe: 'FiltroPeriodoComponente', seletor: 'ui-filtro-periodo',
    api: [/inicio = model/, /fim = model/, /aplicar = output/, /ATALHOS_PERIODO/, /<ng-content/] },
  { arquivo: 'botao-csv.componente.ts', classe: 'BotaoCsvComponente', seletor: 'ui-botao-csv',
    api: [/colunas = input\.required/, /linhas = input/, /arquivo = input/, /paraCsv/] },
]

describe.each(componentes)('$classe', ({ arquivo, classe, seletor, api }) => {
  const src = ler(arquivo)
  it('declara seletor e usa OnPush', () => {
    expect(src).toContain(`selector: '${seletor}'`)
    expect(src).toContain('ChangeDetectionStrategy.OnPush')
    expect(src).toContain(`export class ${classe}`)
  })
  it('expõe a API combinada', () => {
    for (const re of api) expect(src, String(re)).toMatch(re)
  })
  it('é exportado pelo index', () => {
    expect(ler('index.ts')).toContain(`${classe}`)
  })
  it('não usa estilo em linha com cor literal nem funções de cor', () => {
    expect(src).not.toMatch(/rgba?\(|hsla?\(/)
  })
})

describe('paginação por cursor', () => {
  it('não existe página numerada nem OFFSET', () => {
    const src = ler('paginacao.componente.ts')
    expect(src).not.toMatch(/offset|pagina\(|irParaPagina/i)
  })
})
