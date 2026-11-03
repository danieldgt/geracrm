import { TIPOS_TAREFA, type TipoTarefa } from '@geracrm/shared'
import type { Aba } from '../../compartilhado/ui/index.js'

/** Regras puras da tela de Tarefas e do modal (sem DOM, testadas à parte). */

export type AbaTarefa = 'hoje' | 'atrasadas' | 'abertas' | 'concluidas'
export type CartaoTarefa = 'pendentes' | 'atrasadas' | 'hoje' | 'semana'

export const ABAS_TAREFA: readonly Aba[] = [
  { id: 'hoje', rotulo: 'Hoje' },
  { id: 'atrasadas', rotulo: 'Atrasadas' },
  { id: 'abertas', rotulo: 'Abertas' },
  { id: 'concluidas', rotulo: 'Concluídas' },
]

const ROTULO_TIPO: Readonly<Record<TipoTarefa, string>> = {
  ligacao: 'Ligação', whatsapp: 'WhatsApp', reuniao: 'Reunião', email: 'E-mail', visita: 'Visita', outro: 'Outro',
}
export const rotuloTipoTarefa = (t: string): string => ROTULO_TIPO[t as TipoTarefa] ?? t
export const OPCOES_TIPO_TAREFA = TIPOS_TAREFA.map((t) => ({ valor: t, rotulo: ROTULO_TIPO[t] }))

export interface FiltrosTarefa {
  readonly situacao: string
  readonly busca: string
  readonly tipo: string
  readonly responsavelId: string
  readonly de: string
  readonly ate: string
  readonly contatoId: string | null
}
export const FILTROS_VAZIOS: FiltrosTarefa = {
  situacao: 'hoje', busca: '', tipo: '', responsavelId: '', de: '', ate: '', contatoId: null,
}

/** Parâmetros da query de `GET /v1/tarefas` (vazios são omitidos por `queryDeLista`). */
export function parametrosDaLista(f: FiltrosTarefa, cursor: string | null = null): Record<string, string | null> {
  return {
    situacao: f.situacao, q: f.busca.trim() || null, tipo: f.tipo || null, responsavelId: f.responsavelId || null,
    de: f.de || null, ate: f.ate || null, contatoId: f.contatoId, cursor,
  }
}

/** Cartão clicável → filtro: Pendentes = abertas; os demais têm aba/situação própria. */
export function situacaoDoCartao(c: CartaoTarefa): string {
  return c === 'pendentes' ? 'abertas' : c
}

/** A aba "ativa" que corresponde à situação (semana não tem aba: nenhuma fica marcada). */
export function abaDaSituacao(situacao: string): string {
  return ABAS_TAREFA.some((a) => a.id === situacao) ? situacao : ''
}

/** Há algum filtro além da aba? (decide o texto do estado vazio e o botão Limpar). */
export function temFiltroAtivo(f: FiltrosTarefa): boolean {
  return !!(f.busca.trim() || f.tipo || f.responsavelId || f.de || f.ate)
}

/** Data (YYYY-MM-DD) + hora (HH:MM), no horário do navegador, → ISO UTC. null se inválida. */
export function venceEmIso(data: string, hora: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(hora)) return null
  const d = new Date(`${data}T${hora}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export interface FormTarefa {
  readonly contatoId: string
  readonly tipo: string
  readonly titulo: string
  readonly data: string
  readonly hora: string
  readonly responsavelId: string
  readonly descricao: string
}
export type ErrosTarefa = Partial<Record<'contatoId' | 'titulo' | 'data' | 'hora', string>>

/** Erros por campo; `contatoObrigatorio` é falso quando o modal é aberto sem contato (tarefa avulsa). */
export function validarTarefa(f: FormTarefa, contatoObrigatorio = false): ErrosTarefa {
  const e: Record<string, string> = {}
  if (contatoObrigatorio && !f.contatoId) e['contatoId'] = 'Escolha o contato.'
  if (!f.titulo.trim()) e['titulo'] = 'Dê um título.'
  else if (f.titulo.trim().length > 200) e['titulo'] = 'Use até 200 caracteres.'
  if (!f.data) e['data'] = 'Informe a data.'
  if (!f.hora) e['hora'] = 'Informe a hora.'
  return e
}

/**
 * Maps the `campos` of an API 422 (`tarefa.entrada_invalida` family) to the form fields,
 * so the message lands on the field instead of a generic banner. Unknown fields are ignored.
 */
export function errosDoServidor(campos: readonly string[] | undefined): ErrosTarefa {
  const e: Record<string, string> = {}
  for (const c of campos ?? []) {
    if (c === 'contatoId') e['contatoId'] = 'Contato não encontrado.'
    else if (c === 'titulo') e['titulo'] = 'Título inválido (até 200 caracteres).'
    else if (c === 'venceEm') e['data'] = 'Data ou hora inválida.'
  }
  return e
}

/** Corpo do `POST /v1/tarefas`. Campos vazios não vão (a API assume os padrões). */
export function payloadTarefa(f: FormTarefa): Record<string, string> | null {
  const venceEm = venceEmIso(f.data, f.hora)
  if (!venceEm || !f.titulo.trim()) return null
  const p: Record<string, string> = { titulo: f.titulo.trim(), venceEm, tipo: f.tipo || 'outro' }
  if (f.contatoId) p['contatoId'] = f.contatoId
  if (f.responsavelId) p['responsavelId'] = f.responsavelId
  if (f.descricao.trim()) p['descricao'] = f.descricao.trim()
  return p
}

/** Corpo do `POST /v1/tarefas/:id/concluir`. */
export const payloadConcluir = (resultado: string): { resultado?: string } => {
  const r = resultado.trim()
  return r ? { resultado: r } : {}
}
