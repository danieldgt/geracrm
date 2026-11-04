import type { ColunaCsv } from '../../compartilhado/ui/csv.js'
import {
  rotuloDoDia, type DiaMensagens, type EtapaFunil, type PeriodoApi, type PrimeiraResposta, type RespostaWhatsapp,
  type VendedorDesempenho,
} from './relatorios-gestao.regras.js'

/**
 * Regras puras dos relatórios de análise (E3): contratos da API (rotas-relatorios-analise.ts), escolha de
 * vendedores do comparativo, filtros de contatos, linhas de CSV e erros tipificados. Nada aqui toca HTTP ou DOM.
 */

type Csv = { colunas: ColunaCsv[]; linhas: Record<string, unknown>[] }
const reais = (centavos: number): number => centavos / 100
const pct = (p: number | null): number | null => (p === null ? null : Math.round(p * 10_000) / 100)

// ── Contratos ───────────────────────────────────────────────────────────────────────────────────────

export interface GrupoCoorte {
  readonly chave: string; readonly rotulo: string; readonly contatos: number; readonly convertidos: number
  readonly taxa: number | null; readonly valorCentavos: number; readonly percentual: number
}

export interface RespostaComparativo {
  readonly periodo: PeriodoApi
  readonly itens: readonly VendedorDesempenho[]
  readonly totais: Omit<VendedorDesempenho, 'usuarioId' | 'nome'>
}

export interface TotaisVisao {
  readonly contatos: number; readonly convertidos: number; readonly taxa: number | null; readonly pedidos: number
  readonly valorCentavos: number; readonly ticketMedioCentavos: number; readonly respostasFormulario: number
}
export interface SerieFilialDia { readonly chave: string; readonly rotulo: string; readonly total: number; readonly porDia: readonly number[] }
export interface ItemFormulario {
  readonly chave: string; readonly rotulo: string; readonly respostas: number; readonly contatos: number
  readonly convertidos: number; readonly valorCentavos: number
}
export interface RespostaVisaoGeral {
  readonly periodo: PeriodoApi; readonly totais: TotaisVisao
  readonly porFilial: readonly GrupoCoorte[]; readonly porFilialTruncado: boolean
  readonly filialPorDia: { readonly dias: readonly string[]; readonly series: readonly SerieFilialDia[]; readonly truncado: boolean }
  readonly porFormulario: readonly ItemFormulario[]; readonly porFormularioTruncado: boolean
}

export type Qualificacao = 'novo' | 'qualificado' | 'descartado'
export interface LinhaContato {
  readonly id: string; readonly nome: string; readonly telefone: string | null; readonly email: string | null
  readonly tipoPessoa: 'cpf' | 'cnpj' | null; readonly uf: string | null; readonly cidade: string | null
  readonly origem: string | null; readonly vendedor: string | null; readonly filial: string | null
  readonly qualificacao: Qualificacao; readonly formulario: string | null; readonly criadoEm: string
  readonly convertido: boolean; readonly pedidos: number; readonly valorCentavos: number
}
export interface RespostaContatos {
  readonly periodo: PeriodoApi; readonly itens: readonly LinhaContato[]; readonly proximoCursor: string | null
}

export interface RespostaRaioX {
  readonly periodo: PeriodoApi; readonly eixo: EixoRaioX; readonly chave: string; readonly rotulo: string
  readonly cartoes: {
    readonly contatos: number; readonly convertidos: number; readonly taxa: number | null; readonly pedidos: number
    readonly valorCentavos: number; readonly ticketMedioCentavos: number
    readonly respostas: number | null; readonly tarefasConcluidas: number | null
  }
  readonly porDia: readonly { readonly dia: string; readonly contatos: number; readonly convertidos: number }[]
  readonly origens: readonly GrupoCoorte[]; readonly origensTruncado: boolean
  readonly qualificacao: readonly GrupoCoorte[]
  readonly ufs: readonly GrupoCoorte[]; readonly ufsTruncado: boolean
}

export interface CampoCompletude {
  readonly campo: string; readonly rotulo: string; readonly preenchidos: number; readonly total: number; readonly percentual: number
}
export interface RespostaDesempenho {
  readonly periodo: PeriodoApi; readonly contatos: number
  readonly completude: readonly CampoCompletude[]; readonly cadastroCompleto: number
  readonly tipoPessoa: readonly GrupoCoorte[]; readonly qualificacao: readonly GrupoCoorte[]
  readonly origem: readonly GrupoCoorte[]; readonly canal: readonly GrupoCoorte[]
  readonly uf: readonly GrupoCoorte[]; readonly cidade: readonly GrupoCoorte[]; readonly funil: readonly GrupoCoorte[]
  readonly truncado: { readonly origem: boolean; readonly canal: boolean; readonly uf: boolean; readonly cidade: boolean; readonly funil: boolean }
}

export interface MotivoPerda { readonly chave: string; readonly rotulo: string; readonly total: number; readonly percentual: number }
export interface RespostaMotivosPerda {
  readonly periodo: PeriodoApi; readonly total: number; readonly itens: readonly MotivoPerda[]; readonly truncado: boolean
}
export interface RespostaImprimiveis {
  readonly periodo: PeriodoApi; readonly funil: readonly EtapaFunil[]
  readonly origens: { readonly itens: readonly { readonly chave: string; readonly rotulo: string; readonly contatos: number; readonly convertidos: number; readonly taxa: number | null }[]; readonly truncado: boolean }
  readonly motivosPerda: Omit<RespostaMotivosPerda, 'periodo'>
  readonly whatsapp: Omit<RespostaWhatsapp, 'periodo' | 'limiteMin'>
}

export type EixoRaioX = 'formulario' | 'vendedor' | 'filial'
export const EIXOS_RAIOX: readonly { readonly chave: EixoRaioX; readonly rotulo: string; readonly opcoes: EixoRaioX }[] = [
  { chave: 'formulario', rotulo: 'Formulário', opcoes: 'formulario' },
  { chave: 'vendedor', rotulo: 'Vendedor', opcoes: 'vendedor' },
  { chave: 'filial', rotulo: 'Filial', opcoes: 'filial' },
]

// ── Comparativo: escolha de vendedores ──────────────────────────────────────────────────────────────

export const MAX_COMPARATIVO = 10
export interface VendedorEscolhido { readonly id: string; readonly nome: string }

/** Soma um vendedor à lista (sem repetir, no máximo 10). `motivo` explica a recusa. */
export function adicionarVendedor(
  lista: readonly VendedorEscolhido[], novo: VendedorEscolhido,
): { lista: readonly VendedorEscolhido[]; motivo: 'repetido' | 'limite' | null } {
  if (lista.some((v) => v.id === novo.id)) return { lista, motivo: 'repetido' }
  if (lista.length >= MAX_COMPARATIVO) return { lista, motivo: 'limite' }
  return { lista: [...lista, novo], motivo: null }
}

export function removerVendedor(lista: readonly VendedorEscolhido[], id: string): readonly VendedorEscolhido[] {
  return lista.filter((v) => v.id !== id)
}

export function queryVendedores(lista: readonly VendedorEscolhido[]): string {
  return `vendedores=${lista.map((v) => encodeURIComponent(v.id)).join(',')}`
}

export function textoLimiteVendedores(qtd: number): string {
  return qtd >= MAX_COMPARATIVO ? `${qtd} de ${MAX_COMPARATIVO} (limite atingido)` : `${qtd} de ${MAX_COMPARATIVO}`
}

// ── Contatos completo: filtros ──────────────────────────────────────────────────────────────────────

export interface FiltrosContatosUi {
  qualificacao: '' | Qualificacao
  origemId: string
  vendedorId: string
  filialId: string
  formularioId: string
  uf: string
  tipoPessoa: '' | 'cpf' | 'cnpj' | 'sem'
  convertido: '' | 'sim' | 'nao'
  busca: string
}

export const FILTROS_VAZIOS: FiltrosContatosUi = {
  qualificacao: '', origemId: '', vendedorId: '', filialId: '', formularioId: '', uf: '', tipoPessoa: '', convertido: '', busca: '',
}

/** Query dos filtros preenchidos (vazio sai fora). UF em maiúsculas; busca aparada. */
export function queryDosFiltros(f: FiltrosContatosUi): string {
  const partes: string[] = []
  for (const [chave, valor] of Object.entries(f)) {
    const v = chave === 'uf' ? valor.trim().toUpperCase() : valor.trim()
    if (v !== '') partes.push(`${chave}=${encodeURIComponent(v)}`)
  }
  return partes.join('&')
}

export function filtrosAtivos(f: FiltrosContatosUi): number {
  return Object.values(f).filter((v) => v.trim() !== '').length
}

/** Erros de campo que a tela mostra antes de chamar a API (a API continua sendo a regra). */
export function erroDosFiltros(f: FiltrosContatosUi): string | null {
  if (f.uf.trim() !== '' && !/^[A-Za-z]{2}$/.test(f.uf.trim())) return 'A UF tem 2 letras (ex.: SP).'
  const b = f.busca.trim()
  if (b !== '' && b.length < 2) return 'A busca por nome precisa de ao menos 2 letras.'
  return null
}

export const ROTULO_QUALIFICACAO: Readonly<Record<Qualificacao, string>> = { novo: 'Novo', qualificado: 'Qualificado', descartado: 'Descartado' }
export const ROTULO_TIPO_PESSOA: Readonly<Record<string, string>> = { cpf: 'CPF', cnpj: 'CNPJ' }

export const LIMITE_CSV_SERVIDOR = 1000

/** Aviso do CSV de servidor: o teto de 1.000 linhas e como reduzir. */
export function avisoCsv(truncado: boolean): string {
  return truncado
    ? `O arquivo foi limitado às ${LIMITE_CSV_SERVIDOR} linhas mais recentes. Refine o período ou os filtros para ver o resto.`
    : 'Arquivo gerado.'
}

// ── CSV (valores numéricos; o paraCsv põe a vírgula decimal) ────────────────────────────────────────

const colunasGrupo = (rotulo: string): ColunaCsv[] => [
  { chave: 'rotulo', rotulo }, { chave: 'contatos', rotulo: 'Contatos' }, { chave: 'convertidos', rotulo: 'Convertidos' },
  { chave: 'taxa', rotulo: 'Conversão (%)' }, { chave: 'valor', rotulo: 'Valor (R$)' }, { chave: 'percentual', rotulo: 'Participação (%)' },
]
const linhaGrupo = (g: GrupoCoorte): Record<string, unknown> => ({
  rotulo: g.rotulo, contatos: g.contatos, convertidos: g.convertidos, taxa: pct(g.taxa), valor: reais(g.valorCentavos), percentual: pct(g.percentual),
})

export function csvComparativo(r: Pick<RespostaComparativo, 'itens' | 'totais'>): Csv {
  const l = (nome: string, v: Omit<VendedorDesempenho, 'usuarioId' | 'nome'>) => ({
    nome, contatos: v.contatosNovos, tarefas: v.tarefasConcluidas, conversoes: v.conversoes, taxa: pct(v.taxa),
    pedidos: v.pedidos, valor: reais(v.valorCentavos), ticket: reais(v.ticketMedioCentavos),
  })
  return {
    colunas: [
      { chave: 'nome', rotulo: 'Vendedor' }, { chave: 'contatos', rotulo: 'Contatos novos' }, { chave: 'tarefas', rotulo: 'Tarefas concluídas' },
      { chave: 'conversoes', rotulo: 'Conversões' }, { chave: 'taxa', rotulo: 'Conversão (%)' }, { chave: 'pedidos', rotulo: 'Pedidos' },
      { chave: 'valor', rotulo: 'Valor (R$)' }, { chave: 'ticket', rotulo: 'Ticket médio (R$)' },
    ],
    linhas: [...r.itens.map((v) => l(v.nome, v)), l('Total', r.totais)],
  }
}

export function csvVisaoGeral(r: RespostaVisaoGeral): Csv {
  return {
    colunas: [
      { chave: 'quadro', rotulo: 'Quadro' }, { chave: 'item', rotulo: 'Item' }, { chave: 'contatos', rotulo: 'Contatos' },
      { chave: 'convertidos', rotulo: 'Convertidos' }, { chave: 'respostas', rotulo: 'Respostas' }, { chave: 'valor', rotulo: 'Valor (R$)' },
    ],
    linhas: [
      { quadro: 'Total', item: 'Período', contatos: r.totais.contatos, convertidos: r.totais.convertidos, respostas: r.totais.respostasFormulario, valor: reais(r.totais.valorCentavos) },
      ...r.porFilial.map((g) => ({ quadro: 'Filial', item: g.rotulo, contatos: g.contatos, convertidos: g.convertidos, valor: reais(g.valorCentavos) })),
      ...r.porFormulario.map((f) => ({
        quadro: 'Formulário', item: f.rotulo, contatos: f.contatos, convertidos: f.convertidos, respostas: f.respostas, valor: reais(f.valorCentavos),
      })),
    ],
  }
}

/** Filial × dia: uma linha por filial, uma coluna por dia (contatos novos). */
export function csvFilialPorDia(r: RespostaVisaoGeral['filialPorDia']): Csv {
  return {
    colunas: [{ chave: 'filial', rotulo: 'Filial' }, { chave: 'total', rotulo: 'Total' }, ...r.dias.map((d) => ({ chave: d, rotulo: d }))],
    linhas: r.series.map((s) => ({ filial: s.rotulo, total: s.total, ...Object.fromEntries(r.dias.map((d, i) => [d, s.porDia[i] ?? 0])) })),
  }
}

export function csvRaioX(r: RespostaRaioX): Csv {
  return {
    colunas: [{ chave: 'quadro', rotulo: 'Quadro' }, ...colunasGrupo('Item')],
    linhas: [
      { quadro: 'Resumo', rotulo: r.rotulo, contatos: r.cartoes.contatos, convertidos: r.cartoes.convertidos, taxa: pct(r.cartoes.taxa), valor: reais(r.cartoes.valorCentavos) },
      ...r.origens.map((g) => ({ quadro: 'Origem', ...linhaGrupo(g) })),
      ...r.qualificacao.map((g) => ({ quadro: 'Qualificação', ...linhaGrupo(g) })),
      ...r.ufs.map((g) => ({ quadro: 'UF', ...linhaGrupo(g) })),
      ...r.porDia.map((d) => ({ quadro: 'Dia', rotulo: d.dia, contatos: d.contatos, convertidos: d.convertidos })),
    ],
  }
}

export function csvDesempenho(r: RespostaDesempenho): Csv {
  const bloco = (quadro: string, itens: readonly GrupoCoorte[]) => itens.map((g) => ({ quadro, ...linhaGrupo(g) }))
  return {
    colunas: [{ chave: 'quadro', rotulo: 'Quadro' }, ...colunasGrupo('Item')],
    linhas: [
      ...r.completude.map((c) => ({ quadro: 'Completude', rotulo: c.rotulo, contatos: c.preenchidos, percentual: pct(c.percentual) })),
      ...bloco('Tipo de pessoa', r.tipoPessoa), ...bloco('Status', r.qualificacao), ...bloco('Origem', r.origem),
      ...bloco('Canal', r.canal), ...bloco('UF', r.uf), ...bloco('Cidade', r.cidade), ...bloco('Funil', r.funil),
    ],
  }
}

/** Aviso de "top N": quando a API cortou a lista, a tela diz. */
export function avisoTruncado(truncado: boolean, limite = 20): string {
  return truncado ? `Mostrando os ${limite} maiores; há mais itens fora desta lista.` : ''
}

// ── Imprimíveis ─────────────────────────────────────────────────────────────────────────────────────

export const SECOES_IMPRIMIVEIS = ['funil', 'origens', 'motivos', 'whatsapp'] as const
export type SecaoImprimivel = (typeof SECOES_IMPRIMIVEIS)[number]
export const ROTULO_SECAO: Readonly<Record<SecaoImprimivel, string>> = {
  funil: 'Funil', origens: 'Origens', motivos: 'Motivos de perda', whatsapp: 'WhatsApp',
}

/** Alterna uma seção; nunca deixa o relatório sem nenhuma (imprimir vazio não faz sentido). */
export function alternarSecao(ativas: readonly SecaoImprimivel[], s: SecaoImprimivel): readonly SecaoImprimivel[] {
  if (!ativas.includes(s)) return SECOES_IMPRIMIVEIS.filter((x) => x === s || ativas.includes(x))
  return ativas.length > 1 ? ativas.filter((x) => x !== s) : ativas
}

export function resumoWhatsappImprimivel(w: Pick<RespostaWhatsapp, 'cartoes' | 'primeiraResposta' | 'porDia'>): {
  cartoes: { rotulo: string; valor: string }[]; primeiraResposta: readonly PrimeiraResposta[]; dias: readonly DiaMensagens[]
} {
  const n = (v: number): string => v.toLocaleString('pt-BR')
  return {
    cartoes: [
      { rotulo: 'Mensagens recebidas', valor: n(w.cartoes.recebidas) },
      { rotulo: 'Mensagens enviadas', valor: n(w.cartoes.enviadas) },
      { rotulo: 'Conversas iniciadas', valor: n(w.cartoes.conversasIniciadas) },
      { rotulo: 'Atendimentos', valor: n(w.cartoes.atendimentos) },
    ],
    primeiraResposta: w.primeiraResposta, dias: w.porDia,
  }
}

/** Rótulo curto do dia para o eixo "filial × dia". */
export function rotuloColunaDia(iso: string): string { return rotuloDoDia(iso) }

/** Intensidade 0..1 de uma célula do mapa filial × dia (maior valor da tabela = 1). */
export function intensidade(valor: number, maximo: number): number {
  return maximo > 0 ? Math.round((valor / maximo) * 100) / 100 : 0
}

/** "10/09/2026 09:30" no fuso do tenant (a API manda o instante em UTC). */
export function formatarDataHora(iso: string, fuso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'short', timeStyle: 'short' }).format(d)
  } catch {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(d)
  }
}

/** Texto de "cidade / UF" com o que existir. */
export function localDoContato(c: Pick<LinhaContato, 'cidade' | 'uf'>): string {
  return [c.cidade, c.uf].filter((v): v is string => !!v).join(' / ') || '—'
}
