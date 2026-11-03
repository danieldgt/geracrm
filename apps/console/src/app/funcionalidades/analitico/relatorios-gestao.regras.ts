import type { ColunaCsv } from '../../compartilhado/ui/csv.js'

/**
 * Regras puras dos relatórios de gestão (E2): contratos da API, formatação, variação, faixas e linhas de CSV.
 * Nada aqui toca HTTP ou DOM; é o que os testes (`relatorios-gestao.regras.spec.ts`) cobrem.
 */

export interface PeriodoApi { readonly inicio: string; readonly fim: string; readonly fuso: string }

// ── Contratos (espelham as rotas de rotas-relatorios-gestao.ts) ─────────────────────────────────────

export type DimensaoVendas = 'dia' | 'dia-semana' | 'produto' | 'cliente' | 'origem' | 'vendedor' | 'canal'
export interface ItemVendas {
  readonly chave: string; readonly rotulo: string; readonly pedidos: number
  readonly valorCentavos: number; readonly ticketMedioCentavos: number; readonly percentual: number
}
export interface TotaisVendas { readonly pedidos: number; readonly valorCentavos: number; readonly ticketMedioCentavos: number }
export interface RespostaVendas {
  readonly periodo: PeriodoApi; readonly dimensao: DimensaoVendas
  readonly itens: readonly ItemVendas[]; readonly totais: TotaisVendas; readonly truncado: boolean
}

export interface FaixaConversao { readonly faixa: string; readonly contatos: number; readonly percentual: number }
export interface VendedorConversao {
  readonly chave: string; readonly rotulo: string; readonly contatos: number
  readonly mediaDias: number | null; readonly maisRapidaDias: number; readonly maisLentaDias: number
}
export interface RespostaConversao {
  readonly periodo: PeriodoApi; readonly contatos: number
  readonly mediaDias: number | null; readonly maisRapidaDias: number | null; readonly maisLentaDias: number | null
  readonly faixas: readonly FaixaConversao[]; readonly porVendedor: readonly VendedorConversao[]
  readonly porVendedorTruncado: boolean
}

export interface VendedorDesempenho {
  readonly usuarioId: string; readonly nome: string; readonly contatosNovos: number; readonly tarefasConcluidas: number
  readonly conversoes: number; readonly taxa: number | null; readonly pedidos: number
  readonly valorCentavos: number; readonly ticketMedioCentavos: number
}
export interface RespostaVendedores {
  readonly periodo: PeriodoApi; readonly itens: readonly VendedorDesempenho[]; readonly totalVendedores: number
}

export interface JanelaMes {
  readonly inicio: string; readonly fim: string; readonly contatosNovos: number; readonly conversoes: number; readonly valorCentavos: number
}
export interface EtapaFunil { readonly chave: string; readonly rotulo: string; readonly oportunidades: number }
export interface TopItem { readonly chave: string; readonly rotulo: string; readonly total: number }
export interface RespostaOperacional {
  readonly periodo: PeriodoApi; readonly mesAtual: JanelaMes; readonly mesAnterior: JanelaMes
  readonly funil: readonly EtapaFunil[]; readonly topOrigens: readonly TopItem[]; readonly topFormularios: readonly TopItem[]
}

export interface DiaMensagens { readonly dia: string; readonly recebidas: number; readonly enviadas: number }
export interface PrimeiraResposta {
  readonly autor: 'humano' | 'automatico'; readonly atendimentos: number; readonly p50Seg: number | null; readonly p95Seg: number | null
}
export interface RespostaWhatsapp {
  readonly periodo: PeriodoApi; readonly limiteMin: number
  readonly cartoes: {
    readonly recebidas: number; readonly enviadas: number; readonly enviadasHumanas: number; readonly enviadasAutomaticas: number
    readonly conversasIniciadas: number; readonly atendimentos: number; readonly respondidasNoLimite: number
    readonly pctNoLimite: number | null
  }
  readonly porDia: readonly DiaMensagens[]; readonly primeiraResposta: readonly PrimeiraResposta[]
}

// ── Erros de período ────────────────────────────────────────────────────────────────────────────────

const MENSAGENS_ERRO: Readonly<Record<string, string>> = {
  'periodo.longo_demais': 'O período pode ter no máximo 366 dias.',
  'periodo.invertido': 'A data inicial é depois da final.',
  'periodo.invalido': 'Datas inválidas. Use o seletor de datas.',
  'periodo.incompleto': 'Informe a data inicial e a final.',
  'relatorio.limite_invalido': 'O limite de resposta deve ser de 1 a 1440 minutos.',
}

/** Texto para o código tipificado da API; sem código conhecido, a orientação de conexão. */
export function mensagemDoErro(codigo: string | null): string {
  return MENSAGENS_ERRO[codigo ?? ''] ?? 'Confira a conexão e tente de novo.'
}

// ── Formatação e variação ───────────────────────────────────────────────────────────────────────────

const pt = (n: number, casas = 1): string => n.toLocaleString('pt-BR', { maximumFractionDigits: casas })

/** Variação percentual (1 casa). Sem base (anterior 0): 0 se o atual também é 0, senão null (não existe "infinito %"). */
export function variacaoPct(atual: number, anterior: number): number | null {
  if (anterior === 0) return atual === 0 ? 0 : null
  return Math.round(((atual - anterior) / anterior) * 1000) / 10
}

export type Tendencia = 'alta' | 'queda' | 'estavel' | 'sem-base'

export function tendenciaDe(variacao: number | null): Tendencia {
  if (variacao === null) return 'sem-base'
  return variacao > 0 ? 'alta' : variacao < 0 ? 'queda' : 'estavel'
}

/** "+12,5%", "-3%", "0%" ou "sem base" — o sinal e o texto dizem o sentido; a cor só reforça. */
export function formatarVariacao(variacao: number | null): string {
  if (variacao === null) return 'sem base'
  if (variacao === 0) return '0%'
  return `${variacao > 0 ? '+' : '-'}${pt(Math.abs(variacao))}%`
}

/** "12,3%" a partir de 0..1; "—" sem valor. */
export function formatarPercentual(p: number | null): string {
  return p === null ? '—' : `${pt(p * 100)}%`
}

/** "6 min 30 s", "45 s", "1 h 2 min" a partir de segundos; "—" sem valor. */
export function formatarDuracaoSeg(seg: number | null): string {
  if (seg === null) return '—'
  const s = Math.max(0, Math.round(seg))
  if (s < 60) return `${s} s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const r = s % 60
    return r === 0 ? `${m} min` : `${m} min ${r} s`
  }
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** "44,3 dias", "1 dia"; "—" sem valor. */
export function formatarDias(dias: number | null): string {
  if (dias === null) return '—'
  return `${pt(dias)} ${dias === 1 ? 'dia' : 'dias'}`
}

/** "2026-09-10" → "10/09". */
export function rotuloDoDia(iso: string): string {
  const [, m = '', d = ''] = iso.split('-')
  return `${d}/${m}`
}

export function nomeDaFaixa(faixa: string): string {
  return faixa === '90+' ? 'Mais de 90 dias' : `${faixa} dias`
}

// ── Barras ──────────────────────────────────────────────────────────────────────────────────────────

export interface BarraRelatorio { readonly chave: string; readonly rotulo: string; readonly valor: number; readonly texto?: string }

export function barrasDeFaixas(faixas: readonly FaixaConversao[]): BarraRelatorio[] {
  return faixas.map((f) => ({
    chave: f.faixa, rotulo: nomeDaFaixa(f.faixa), valor: f.contatos, texto: `${f.contatos} (${formatarPercentual(f.percentual)})`,
  }))
}

export function barrasDeVendas(itens: readonly ItemVendas[], formatarValor: (centavos: number) => string): BarraRelatorio[] {
  return itens.map((i) => ({
    chave: i.chave, rotulo: i.rotulo, valor: i.valorCentavos, texto: `${formatarValor(i.valorCentavos)} (${formatarPercentual(i.percentual)})`,
  }))
}

export function barrasDeMensagens(dias: readonly DiaMensagens[], campo: 'recebidas' | 'enviadas'): BarraRelatorio[] {
  return dias.map((d) => ({ chave: d.dia, rotulo: rotuloDoDia(d.dia), valor: d[campo] }))
}

// ── CSV (valores numéricos; o paraCsv põe a vírgula decimal) ────────────────────────────────────────

type Csv = { colunas: ColunaCsv[]; linhas: Record<string, unknown>[] }
const reais = (centavos: number): number => centavos / 100
const pct = (p: number | null): number | null => (p === null ? null : Math.round(p * 10_000) / 100)

export function csvVendas(itens: readonly ItemVendas[], rotuloGrupo: string): Csv {
  return {
    colunas: [
      { chave: 'rotulo', rotulo: rotuloGrupo }, { chave: 'pedidos', rotulo: 'Pedidos' }, { chave: 'valor', rotulo: 'Valor (R$)' },
      { chave: 'ticket', rotulo: 'Ticket médio (R$)' }, { chave: 'percentual', rotulo: 'Participação (%)' },
    ],
    linhas: itens.map((i) => ({
      rotulo: i.rotulo, pedidos: i.pedidos, valor: reais(i.valorCentavos), ticket: reais(i.ticketMedioCentavos), percentual: pct(i.percentual),
    })),
  }
}

export function csvConversao(faixas: readonly FaixaConversao[], porVendedor: readonly VendedorConversao[]): Csv {
  return {
    colunas: [
      { chave: 'secao', rotulo: 'Quadro' }, { chave: 'item', rotulo: 'Item' }, { chave: 'contatos', rotulo: 'Contatos' },
      { chave: 'percentual', rotulo: 'Participação (%)' }, { chave: 'media', rotulo: 'Média (dias)' },
      { chave: 'rapida', rotulo: 'Mais rápida (dias)' }, { chave: 'lenta', rotulo: 'Mais lenta (dias)' },
    ],
    linhas: [
      ...faixas.map((f) => ({ secao: 'Faixa', item: nomeDaFaixa(f.faixa), contatos: f.contatos, percentual: pct(f.percentual) })),
      ...porVendedor.map((v) => ({
        secao: 'Vendedor', item: v.rotulo, contatos: v.contatos, media: v.mediaDias, rapida: v.maisRapidaDias, lenta: v.maisLentaDias,
      })),
    ],
  }
}

export function csvVendedores(itens: readonly VendedorDesempenho[]): Csv {
  return {
    colunas: [
      { chave: 'nome', rotulo: 'Vendedor' }, { chave: 'contatos', rotulo: 'Contatos novos' }, { chave: 'tarefas', rotulo: 'Tarefas concluídas' },
      { chave: 'conversoes', rotulo: 'Conversões' }, { chave: 'taxa', rotulo: 'Conversão (%)' }, { chave: 'pedidos', rotulo: 'Pedidos' },
      { chave: 'valor', rotulo: 'Valor (R$)' }, { chave: 'ticket', rotulo: 'Ticket médio (R$)' },
    ],
    linhas: itens.map((v) => ({
      nome: v.nome, contatos: v.contatosNovos, tarefas: v.tarefasConcluidas, conversoes: v.conversoes, taxa: pct(v.taxa),
      pedidos: v.pedidos, valor: reais(v.valorCentavos), ticket: reais(v.ticketMedioCentavos),
    })),
  }
}

export function csvOperacional(r: RespostaOperacional): Csv {
  const linhaMes = (item: string, a: number, b: number, dinheiro = false) => ({
    secao: 'Mês atual × anterior', item, atual: dinheiro ? reais(a) : a, anterior: dinheiro ? reais(b) : b, variacao: variacaoPct(a, b),
  })
  return {
    colunas: [
      { chave: 'secao', rotulo: 'Quadro' }, { chave: 'item', rotulo: 'Item' }, { chave: 'atual', rotulo: 'Atual' },
      { chave: 'anterior', rotulo: 'Anterior' }, { chave: 'variacao', rotulo: 'Variação (%)' },
    ],
    linhas: [
      linhaMes('Contatos novos', r.mesAtual.contatosNovos, r.mesAnterior.contatosNovos),
      linhaMes('Conversões', r.mesAtual.conversoes, r.mesAnterior.conversoes),
      linhaMes('Valor (R$)', r.mesAtual.valorCentavos, r.mesAnterior.valorCentavos, true),
      ...r.funil.map((e) => ({ secao: 'Funil (oportunidades abertas)', item: e.rotulo, atual: e.oportunidades })),
      ...r.topOrigens.map((o) => ({ secao: 'Top origens (contatos novos)', item: o.rotulo, atual: o.total })),
      ...r.topFormularios.map((f) => ({ secao: 'Top formulários (respostas)', item: f.rotulo, atual: f.total })),
    ],
  }
}

export function csvWhatsapp(dias: readonly DiaMensagens[]): Csv {
  return {
    colunas: [{ chave: 'dia', rotulo: 'Dia' }, { chave: 'recebidas', rotulo: 'Recebidas' }, { chave: 'enviadas', rotulo: 'Enviadas' }],
    linhas: dias.map((d) => ({ dia: d.dia, recebidas: d.recebidas, enviadas: d.enviadas })),
  }
}

export const ROTULO_AUTOR: Readonly<Record<PrimeiraResposta['autor'], string>> = {
  humano: 'Atendente (humano)', automatico: 'Automático (agente, ausência, automação)',
}
