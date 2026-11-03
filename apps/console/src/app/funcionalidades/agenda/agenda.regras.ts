import {
  CORES_EVENTO, LEMBRETES_EVENTO_MIN, MODALIDADES_EVENTO, TIPOS_EVENTO, periodosSobrepoem,
  type CorEvento, type EventoAgenda, type StatusEvento,
} from '@geracrm/shared'

/** Regras puras da Agenda (grade do mês, "+N", conflito local, formulário). Sem DOM — testadas à parte. */

/** Máximo de eventos desenhados por dia na grade; o resto vira "+N". */
export const EVENTOS_POR_DIA_NA_GRADE = 3

export const ROTULO_TIPO_EVENTO: Readonly<Record<string, string>> = {
  reuniao: 'Reunião', ligacao: 'Ligação', visita: 'Visita', outro: 'Outro',
}
export const ROTULO_MODALIDADE: Readonly<Record<string, string>> = { presencial: 'Presencial', online: 'Online' }
export const ROTULO_STATUS_EVENTO: Readonly<Record<StatusEvento, string>> = {
  agendado: 'Agendado', realizado: 'Realizado', nao_compareceu: 'Não compareceu', cancelado: 'Cancelado',
}
export const ROTULO_COR: Readonly<Record<CorEvento, string>> = {
  acao: 'Laranja', sucesso: 'Verde', atencao: 'Amarelo', erro: 'Vermelho', ia: 'Roxo', neutro: 'Cinza',
}
export const OPCOES_TIPO_EVENTO = TIPOS_EVENTO.map((v) => ({ valor: v, rotulo: ROTULO_TIPO_EVENTO[v]! }))
export const OPCOES_MODALIDADE = MODALIDADES_EVENTO.map((v) => ({ valor: v, rotulo: ROTULO_MODALIDADE[v]! }))
export const OPCOES_COR = CORES_EVENTO.map((v) => ({ valor: v, rotulo: ROTULO_COR[v] }))
export const OPCOES_LEMBRETE = [
  { valor: '', rotulo: 'Sem lembrete' },
  ...LEMBRETES_EVENTO_MIN.map((m) => ({ valor: String(m), rotulo: m === 1440 ? '1 dia antes' : m === 60 ? '1 hora antes' : `${m} min antes` })),
]
export const rotuloStatusEvento = (s: string): string => ROTULO_STATUS_EVENTO[s as StatusEvento] ?? s
export const rotuloTipoEvento = (t: string): string => ROTULO_TIPO_EVENTO[t] ?? t

/** Tom do `ui-badge` para o status. */
export function tomDoStatus(s: StatusEvento): 'info' | 'sucesso' | 'atencao' | 'neutro' {
  return s === 'agendado' ? 'info' : s === 'realizado' ? 'sucesso' : s === 'nao_compareceu' ? 'atencao' : 'neutro'
}

// ── Datas (sempre no horário do navegador, como as Tarefas) ──────────────────

const dois = (n: number): string => String(n).padStart(2, '0')

/** "YYYY-MM-DD" no horário local. */
export function diaIso(d: Date): string {
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`
}
/** "HH:MM" no horário local. */
export const horaLocal = (d: Date): string => `${dois(d.getHours())}:${dois(d.getMinutes())}`

/** Data (YYYY-MM-DD) + hora (HH:MM) locais → ISO UTC; null se inválida. */
export function isoDeDataHora(data: string, hora: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(hora)) return null
  const d = new Date(`${data}T${hora}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
export const DIAS_DA_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const
export const rotuloMes = (ano: number, mes: number): string => `${MESES[mes]} de ${ano}`

/** Mês de referência (mes: 0-11). */
export interface MesRef { readonly ano: number; readonly mes: number }

/** Navega N meses (negativo volta), virando o ano quando preciso. */
export function mudarMes(ref: MesRef, delta: number): MesRef {
  const total = ref.ano * 12 + ref.mes + delta
  return { ano: Math.floor(total / 12), mes: ((total % 12) + 12) % 12 }
}

export interface DiaGrade {
  readonly iso: string
  readonly dia: number
  /** Pertence ao mês exibido (os de fora são o "rabo" da semana anterior/seguinte). */
  readonly doMes: boolean
  readonly hoje: boolean
}

/**
 * Grade do mês: semanas de domingo a sábado, de 4 a 6 linhas, cobrindo do domingo da semana do dia 1
 * até o sábado da semana do último dia. `hojeIso` é injetado (testável, sem relógio global).
 */
export function montarGradeMes(ref: MesRef, hojeIso: string): DiaGrade[][] {
  const primeiro = new Date(ref.ano, ref.mes, 1)
  const ultimo = new Date(ref.ano, ref.mes + 1, 0)
  const inicio = new Date(ref.ano, ref.mes, 1 - primeiro.getDay())
  const fim = new Date(ref.ano, ref.mes, ultimo.getDate() + (6 - ultimo.getDay()))
  const semanas: DiaGrade[][] = []
  for (let d = new Date(inicio); d <= fim; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)) {
    const semana: DiaGrade[] = []
    for (let i = 0; i < 7; i++) {
      const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i)
      const iso = diaIso(dia)
      semana.push({ iso, dia: dia.getDate(), doMes: dia.getMonth() === ref.mes, hoje: iso === hojeIso })
    }
    semanas.push(semana)
  }
  return semanas
}

/** Janela (de/ate, inclusive) que a grade cobre — é o que se pede à API (no máximo 42 dias < 62). */
export function janelaDaGrade(grade: readonly (readonly DiaGrade[])[]): { de: string; ate: string } {
  const primeira = grade[0]?.[0]
  const ultima = grade[grade.length - 1]?.[6]
  return { de: primeira?.iso ?? '', ate: ultima?.iso ?? '' }
}

// ── Eventos na grade ─────────────────────────────────────────────────────────

type EventoVista = Pick<EventoAgenda, 'id' | 'inicio' | 'fim'>

/**
 * Agrupa por dia local. Evento que atravessa dias aparece em cada um; um fim exatamente à meia-noite
 * não "vaza" para o dia seguinte. Dentro do dia, ordena por início.
 */
export function eventosPorDia<T extends EventoVista>(eventos: readonly T[]): Map<string, T[]> {
  const mapa = new Map<string, T[]>()
  for (const e of [...eventos].sort((a, b) => a.inicio.localeCompare(b.inicio) || a.id.localeCompare(b.id))) {
    const ini = new Date(e.inicio)
    const fim = new Date(e.fim)
    const ultimoMs = Math.max(ini.getTime(), fim.getTime() - 1)
    for (let d = new Date(ini.getFullYear(), ini.getMonth(), ini.getDate()); d.getTime() <= ultimoMs;
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const k = diaIso(d)
      const lista = mapa.get(k)
      if (lista) lista.push(e); else mapa.set(k, [e])
    }
  }
  return mapa
}

/** O que cabe na célula do dia e quantos ficam de fora ("+N"). */
export function cabeNoDia<T>(lista: readonly T[], max: number = EVENTOS_POR_DIA_NA_GRADE): { visiveis: T[]; restantes: number } {
  if (lista.length <= max) return { visiveis: [...lista], restantes: 0 }
  // Quando não cabem todos, o último slot vira o "+N" (que também ocupa uma linha).
  return { visiveis: lista.slice(0, max - 1), restantes: lista.length - (max - 1) }
}

/** Primeiro evento AGENDADO do mesmo responsável que se sobrepõe ao candidato (aviso antes de enviar; a API é a regra). */
export function conflitoLocal<T extends Pick<EventoAgenda, 'id' | 'inicio' | 'fim' | 'responsavelId' | 'status'>>(
  existentes: readonly T[],
  candidato: { inicio: string; fim: string; responsavelId: string | null; ignorarId?: string | null },
): T | null {
  return existentes.find((e) =>
    e.status === 'agendado' && e.id !== (candidato.ignorarId ?? null)
    && (candidato.responsavelId === null || e.responsavelId === candidato.responsavelId)
    && periodosSobrepoem(e, candidato)) ?? null
}

// ── Formulário ───────────────────────────────────────────────────────────────

export interface FormEvento {
  readonly titulo: string
  readonly descricao: string
  readonly contatoId: string
  readonly data: string
  readonly inicio: string
  readonly fim: string
  readonly tipo: string
  readonly modalidade: string
  readonly local: string
  readonly link: string
  readonly lembrete: string
  readonly cor: string
  readonly responsavelId: string
}
export type ErrosEvento = Partial<Record<'titulo' | 'data' | 'inicio' | 'fim' | 'link', string>>

export const formVazio = (data = ''): FormEvento => ({
  titulo: '', descricao: '', contatoId: '', data, inicio: '09:00', fim: '10:00', tipo: 'reuniao',
  modalidade: 'presencial', local: '', link: '', lembrete: '15', cor: 'acao', responsavelId: '',
})

export function validarEvento(f: FormEvento): ErrosEvento {
  const e: Record<string, string> = {}
  if (!f.titulo.trim()) e['titulo'] = 'Dê um título.'
  else if (f.titulo.trim().length > 120) e['titulo'] = 'Máximo de 120 caracteres.'
  if (!f.data) e['data'] = 'Informe a data.'
  if (!f.inicio) e['inicio'] = 'Informe o início.'
  if (!f.fim) e['fim'] = 'Informe o fim.'
  const ini = isoDeDataHora(f.data, f.inicio)
  const fim = isoDeDataHora(f.data, f.fim)
  if (ini && fim && fim <= ini) e['fim'] = 'O fim precisa ser depois do início.'
  if (f.link.trim() && !/^https?:\/\/\S+$/i.test(f.link.trim())) e['link'] = 'Comece com http:// ou https://.'
  return e
}

/** Corpo de POST/PUT. Campos vazios vão como null (a API assume os padrões). null se data/hora inválidas. */
export function payloadEvento(f: FormEvento, versao?: number): Record<string, unknown> | null {
  const inicio = isoDeDataHora(f.data, f.inicio)
  const fim = isoDeDataHora(f.data, f.fim)
  if (!inicio || !fim || !f.titulo.trim()) return null
  return {
    titulo: f.titulo.trim(), descricao: f.descricao.trim() || null, contatoId: f.contatoId || null,
    responsavelId: f.responsavelId || null, inicio, fim, tipo: f.tipo, modalidade: f.modalidade,
    local: f.local.trim() || null, link: f.link.trim() || null,
    lembreteMin: f.lembrete ? Number(f.lembrete) : null, cor: f.cor,
    ...(versao !== undefined ? { versao } : {}),
  }
}

/** Formulário preenchido a partir de um evento (edição/reagendar). */
export function formDoEvento(e: EventoAgenda): FormEvento {
  const ini = new Date(e.inicio)
  return {
    titulo: e.titulo, descricao: e.descricao ?? '', contatoId: e.contatoId ?? '', data: diaIso(ini),
    inicio: horaLocal(ini), fim: horaLocal(new Date(e.fim)), tipo: e.tipo, modalidade: e.modalidade,
    local: e.local ?? '', link: e.link ?? '', lembrete: e.lembreteMin ? String(e.lembreteMin) : '', cor: e.cor,
    responsavelId: e.responsavelId,
  }
}

/** Status que a UI oferece como ação a partir do atual (agendado: concluir/faltou/cancelar). */
export function acoesDoStatus(s: StatusEvento): readonly StatusEvento[] {
  return s === 'agendado' ? ['realizado', 'nao_compareceu', 'cancelado'] : []
}

/** Texto do 409 `agenda.horario_ocupado` (corpo do erro): nomeia o evento que ocupa o horário. null se for outro erro. */
export function textoDoConflito(corpo: unknown): string | null {
  const c = corpo as { erro?: string; conflito?: { titulo: string; inicio: string; fim: string } } | null
  if (c?.erro !== 'agenda.horario_ocupado' || !c.conflito) return null
  const { titulo, inicio, fim } = c.conflito
  return `Esse horário já está ocupado por "${titulo}" (${horaLocal(new Date(inicio))}–${horaLocal(new Date(fim))}). Escolha outro horário.`
}
