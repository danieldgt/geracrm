/**
 * O HORÁRIO DE ATENDIMENTO do canal — a pergunta "a loja está aberta agora?".
 *
 * ⚠️ Mora sozinho porque é usado por DOIS lados que não podem se importar entre
 * si: a disponibilidade da equipe (`disponibilidade.ts`) e a resposta de
 * ausência (`ausencia.ts`), que desde 2026-09-01 pergunta à disponibilidade
 * antes de falar. Deixar o expediente dentro de um dos dois criaria um ciclo de
 * import — e o conserto preguiçoso do ciclo é duplicar a função, que é
 * exatamente o erro que produziu o robô falando por cima de atendente.
 */

/** Faixa de atendimento de um dia. `null` = fechado. */
export interface Faixa { readonly de: string; readonly ate: string }
export type HorarioAtendimento = Record<string, Faixa | null>

/** 1 (segunda) … 7 (domingo) — o `ID` do `to_char` do Postgres. */
const DIA_POR_ISO: Record<number, string> = {
  1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab', 7: 'dom',
}

/**
 * Está fora do expediente?
 *
 * ⚠️ **Horário não configurado devolve `false`** — ou seja, a loja conta como
 * ABERTA. Quem não declarou expediente não declarou fechamento: assumir
 * "fechado" faria todo tenant que nunca abriu essa tela responder
 * automaticamente 24h por dia.
 *
 * ⚠️ Isto sozinho NÃO decide mais se o produto responde: desde 2026-09-01 a
 * pergunta é "tem alguém para atender?" (`ninguemDisponivel`), e o expediente é
 * uma das três coisas que ela considera. Dentro do expediente com a equipe toda
 * offline, o cliente também ficava no vácuo — era o buraco.
 *
 * ⚠️ Faixa que vira a meia-noite (22:00–02:00) é tratada: sem isso, uma loja que
 * atende à noite seria considerada fechada durante o próprio expediente.
 */
export function foraDoExpediente(
  horario: HorarioAtendimento | null | undefined, diaIso: number, horaLocal: string,
): boolean {
  if (!horario || Object.keys(horario).length === 0) return false

  const faixa = horario[DIA_POR_ISO[diaIso] ?? '']
  if (!faixa?.de || !faixa?.ate) return true   // dia declarado como fechado

  // Comparação lexicográfica de "HH:MM" — funciona porque o formato é fixo.
  return faixa.de <= faixa.ate
    ? horaLocal < faixa.de || horaLocal >= faixa.ate
    : horaLocal < faixa.de && horaLocal >= faixa.ate   // faixa que cruza a meia-noite
}

// ─────────────────────────────────────────────────────────────────────────────
// Feriados e PRÓXIMA ABERTURA (raia P11; contrato também para a P18 — SLA).
//
// ⚠️ Aqui a hora NÃO entra pronta do banco: para achar "quando abre de novo" é
//    preciso andar no calendário LOCAL do tenant e voltar para um instante.
//    A conversão usa o fuso explícito (Intl, IANA) e é conferida no próprio
//    instante convertido — é o que acerta a virada de horário de verão
//    (testado com America/New_York). Nunca use o fuso do servidor.
// ─────────────────────────────────────────────────────────────────────────────

/** "AAAA-MM-DD" (só aquele dia) ou "MM-DD" (todo ano). */
export type Feriados = readonly string[]

export interface PartesLocais {
  /** Data local "AAAA-MM-DD". */
  readonly data: string
  /** 1 (segunda) … 7 (domingo). */
  readonly diaIso: number
  /** "HH:MM" local. */
  readonly hora: string
}

const formatadores = new Map<string, Intl.DateTimeFormat>()
function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatadores.set(fuso, f)
  }
  return f
}

function campos(instante: Date, fuso: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {}
  for (const x of formatador(fuso).formatToParts(instante)) {
    if (x.type !== 'literal') p[x.type] = Number(x.value)
  }
  return { y: p['year']!, m: p['month']!, d: p['day']!, h: p['hour']! % 24, mi: p['minute']!, s: p['second']! }
}

const dois = (n: number): string => String(n).padStart(2, '0')

/** Data, dia da semana e hora LOCAIS de um instante no fuso dado. */
export function partesLocais(instante: Date, fuso: string): PartesLocais {
  const c = campos(instante, fuso)
  const diaUtc = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay()   // 0 = domingo
  return { data: `${c.y}-${dois(c.m)}-${dois(c.d)}`, diaIso: diaUtc === 0 ? 7 : diaUtc, hora: `${dois(c.h)}:${dois(c.mi)}` }
}

/** Quanto o relógio local está À FRENTE do UTC naquele instante (ms). */
function deslocamento(instante: Date, fuso: string): number {
  const c = campos(instante, fuso)
  const comoUtc = Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s)
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000
}

/**
 * O instante em que o relógio LOCAL marca `data hora` no fuso. Na hora que não
 * existe (pulo do horário de verão) cai uma hora depois — nunca antes.
 */
export function instanteLocal(data: string, hora: string, fuso: string): Date {
  const [y, m, d] = data.split('-').map(Number) as [number, number, number]
  const [h, mi] = hora.split(':').map(Number) as [number, number]
  const ingenuo = Date.UTC(y, m - 1, d, h, mi)
  const t1 = ingenuo - deslocamento(new Date(ingenuo), fuso)
  // Segunda passada: o deslocamento do PRÓPRIO instante (vale na virada).
  const t2 = ingenuo - deslocamento(new Date(t1), fuso)
  return new Date(Math.max(t1, t2))
}

function somarDias(data: string, n: number): string {
  const [y, m, d] = data.split('-').map(Number) as [number, number, number]
  const x = new Date(Date.UTC(y, m - 1, d + n))
  return `${x.getUTCFullYear()}-${dois(x.getUTCMonth() + 1)}-${dois(x.getUTCDate())}`
}

/** A data local é feriado? "MM-DD" casa em qualquer ano. */
export function ehFeriado(feriados: Feriados | null | undefined, data: string): boolean {
  if (!feriados || feriados.length === 0) return false
  return feriados.includes(data) || feriados.includes(data.slice(5))
}

export type SituacaoExpediente = 'aberto' | 'fora_do_expediente' | 'feriado'

/**
 * O expediente está aberto NESTE instante, contando feriados?
 *
 * ⚠️ Mesma régua de `foraDoExpediente` (horário vazio = aberto; faixa que vira
 * a meia-noite é do próprio dia). Feriado fecha o DIA LOCAL inteiro — inclusive
 * com horário não configurado: quem declarou o feriado declarou fechamento.
 */
export function situacaoDoExpediente(
  horario: HorarioAtendimento | null | undefined, feriados: Feriados | null | undefined, instante: Date, fuso: string,
): SituacaoExpediente {
  const p = partesLocais(instante, fuso)
  if (ehFeriado(feriados, p.data)) return 'feriado'
  return foraDoExpediente(horario, p.diaIso, p.hora) ? 'fora_do_expediente' : 'aberto'
}

/** Quantos dias à frente procurar a abertura antes de desistir. */
const HORIZONTE_DIAS = 31

/**
 * QUANDO o expediente abre de novo, a partir de `instante` — o próprio
 * `instante` se já estiver aberto. `null` = nenhuma abertura no horizonte
 * (todos os dias fechados): quem chama decide o que fazer.
 *
 * Contrato também para a P18 (SLA do handoff): pura, sem banco, fuso IANA do
 * tenant (`tenant.fuso`), feriados de `canal_configuracao.feriados`.
 */
export function proximaAbertura(
  horario: HorarioAtendimento | null | undefined, feriados: Feriados | null | undefined, instante: Date, fuso: string,
): Date | null {
  if (situacaoDoExpediente(horario, feriados, instante, fuso) === 'aberto') return instante
  const hoje = partesLocais(instante, fuso).data
  const semHorario = !horario || Object.keys(horario).length === 0
  for (let n = 0; n <= HORIZONTE_DIAS; n++) {
    const data = somarDias(hoje, n)
    if (ehFeriado(feriados, data)) continue
    // Sem horário declarado, só o feriado fecha: abre à meia-noite seguinte.
    if (semHorario) {
      if (n > 0) return instanteLocal(data, '00:00', fuso)
      continue
    }
    const diaIso = partesLocais(instanteLocal(data, '12:00', fuso), fuso).diaIso
    const faixa = horario[DIA_POR_ISO[diaIso] ?? '']
    if (!faixa?.de || !faixa?.ate) continue
    const abre = instanteLocal(data, faixa.de, fuso)
    if (abre.getTime() > instante.getTime()) return abre
  }
  return null
}
