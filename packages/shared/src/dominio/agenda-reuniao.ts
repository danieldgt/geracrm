/**
 * REUNIÃO MARCADA PELO CRM E PELO AGENTE (raia C3) — regras puras compartilhadas
 * por API e console. TypeScript puro: nada de framework, nada de relógio do host
 * (o `agora` é sempre injetado).
 *
 * Vale só com o módulo Agenda ligado (C2). Três caminhos usam estas regras:
 *   1. a grade de horários livres (`GET /v1/agenda/horarios-livres`);
 *   2. a ferramenta `agendar_reuniao` do agente (ofertar → o cliente escolhe → confirmar);
 *   3. o worker de avisos ao cliente (lembretes H-24/H-2 e o no-show).
 */
import type { ModoDoTurno } from './agente-vendedor.js'

// ─────────────────────────── grade de horários ───────────────────────────

/** Faixa de um dia ("HH:MM"). Mesmo formato do expediente do número (`canal_configuracao.horario_atendimento`). */
export interface FaixaHorario { readonly de: string; readonly ate: string }
export type HorarioSemanal = Readonly<Record<string, FaixaHorario | null>>

/**
 * Expediente usado quando o número não declarou o dele. ⚠️ Para ATENDIMENTO, horário vazio
 * vale "aberto 24h" (`expediente.ts`); para REUNIÃO isso ofertaria 3h da manhã — então o vazio
 * cai neste padrão comercial (seg–sex, 09:00–18:00).
 */
export const EXPEDIENTE_REUNIAO_PADRAO: HorarioSemanal = {
  seg: { de: '09:00', ate: '18:00' }, ter: { de: '09:00', ate: '18:00' }, qua: { de: '09:00', ate: '18:00' },
  qui: { de: '09:00', ate: '18:00' }, sex: { de: '09:00', ate: '18:00' }, sab: null, dom: null,
}

export const DURACOES_REUNIAO_MIN = [15, 30, 45, 60, 90, 120] as const
export type DuracaoReuniaoMin = (typeof DURACOES_REUNIAO_MIN)[number]
export const DURACAO_REUNIAO_PADRAO: DuracaoReuniaoMin = 30
export const ehDuracaoReuniao = (v: unknown): v is DuracaoReuniaoMin => (DURACOES_REUNIAO_MIN as readonly unknown[]).includes(v)

/** Passo da grade: começa de meia em meia hora. */
export const PASSO_GRADE_REUNIAO_MIN = 30
/** Não oferta horário que começa daqui a menos disto (ninguém se prepara em 5 minutos). */
export const ANTECEDENCIA_MIN_REUNIAO = 30
/** Até quantos dias à frente se marca. */
export const DIAS_MAX_REUNIAO = 60
/** Quantas opções o agente oferta de uma vez (o cliente escolhe entre poucas). */
export const OPCOES_POR_OFERTA = 3
/** A oferta do agente vale por isto; depois o "sim" não confirma mais. */
export const VALIDADE_OFERTA_HORAS = 24

const DIA_POR_ISO: Readonly<Record<number, string>> = { 1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab', 7: 'dom' }

/** "HH:MM" → minutos do dia; inválido → null. */
export function minutosDoDia(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const h = Number(m[1]); const mi = Number(m[2])
  return h <= 23 && mi <= 59 ? h * 60 + mi : null
}
const doisDigitos = (n: number): string => String(n).padStart(2, '0')
export const hhmm = (minutos: number): string => `${doisDigitos(Math.floor(minutos / 60))}:${doisDigitos(minutos % 60)}`

/**
 * A faixa de reunião de um dia da semana (1 = segunda … 7 = domingo). Horário nulo ou vazio
 * → `EXPEDIENTE_REUNIAO_PADRAO`. Dia declarado fechado → null.
 */
export function faixaDeReuniao(horario: HorarioSemanal | null | undefined, diaIso: number): FaixaHorario | null {
  const base = horario && Object.keys(horario).length > 0 ? horario : EXPEDIENTE_REUNIAO_PADRAO
  const f = base[DIA_POR_ISO[diaIso] ?? '']
  return f?.de && f?.ate ? f : null
}

/**
 * Os horários candidatos de um dia (antes de tirar a agenda): de `passo` em `passo` dentro da
 * faixa, cabendo a duração inteira. Faixa que vira a meia-noite fica só com a parte do próprio
 * dia (até 24:00) — reunião de madrugada não é caso de uso.
 */
export function candidatosDoDia(
  faixa: FaixaHorario, duracaoMin: number, passoMin: number = PASSO_GRADE_REUNIAO_MIN,
): { de: string; ate: string }[] {
  const ini = minutosDoDia(faixa.de); const fimBruto = minutosDoDia(faixa.ate)
  if (ini === null || fimBruto === null || duracaoMin <= 0 || passoMin <= 0) return []
  // Faixa que vira a meia-noite (ou vai até ela) termina às 23:59 do próprio dia.
  const fim = fimBruto > ini ? fimBruto : 23 * 60 + 59
  const saida: { de: string; ate: string }[] = []
  for (let m = ini; m + duracaoMin <= fim; m += passoMin) saida.push({ de: hhmm(m), ate: hhmm(m + duracaoMin) })
  return saida
}

/** Um horário livre na resposta da API (instantes ISO 8601). */
export interface HorarioLivre { readonly inicio: string; readonly fim: string }

/** Quem pode receber a reunião: o responsável do contato primeiro, depois os da mesma filial. */
export interface VendedorParaReuniao {
  readonly usuarioId: string
  readonly nome: string
  /** É o dono da carteira do contato hoje. */
  readonly responsavelDoContato: boolean
}

export interface RespostaHorariosLivres {
  readonly usuarioId: string
  readonly dia: string
  readonly duracaoMin: number
  /** De onde veio a faixa: o expediente do número ou o padrão comercial. */
  readonly origemExpediente: 'numero' | 'padrao'
  /** O dia está fechado (feriado ou dia sem expediente) — a tela diz isso em vez de "sem horários". */
  readonly fechado: boolean
  readonly horarios: readonly HorarioLivre[]
}

/** Erros tipificados da marcação (o 409 é o que a tela mais precisa nomear). */
export const ERROS_REUNIAO = {
  horarioOcupado: 'agenda.horario_ocupado',
  horarioPassado: 'agenda.horario_passado',
  responsavelProibido: 'agenda.responsavel_proibido',
  responsavelInvalido: 'agenda.responsavel_invalido',
  semContato: 'agenda.conversa_sem_contato',
} as const

// ─────────────────────────── a ferramenta do agente ───────────────────────────

/**
 * A ferramenta `agendar_reuniao` entra no turno? ⚠️ Decisão em CÓDIGO (ADR-029): desligada,
 * ela não é registrada — não basta instruir o prompt. Exige as TRÊS coisas:
 *   - o módulo Agenda ligado no tenant;
 *   - a chave "O agente pode marcar reuniões" ligada NO NÚMERO (padrão desligado);
 *   - o número configurado em `assistido` ou `autonomo` (número em sombra/desligado não marca).
 */
export function agendaNoTurno(p: { moduloAtivo: boolean; chaveLigada: boolean; modoDoNumero: string | null | undefined }): boolean {
  return p.moduloAtivo && p.chaveLigada && (p.modoDoNumero === 'assistido' || p.modoDoNumero === 'autonomo')
}

/**
 * Com a ferramenta no turno, ela CRIA o evento ou só responde como se criasse?
 * Efeito real só no modo efetivo `autonomo` (é quando a oferta chegou de fato ao cliente).
 * Sombra (recorte/kill switch), assistido (quem envia é a pessoa), simulação e copiloto → seco.
 */
export function efeitoDaAgenda(modo: ModoDoTurno): 'real' | 'seco' {
  return modo === 'autonomo' ? 'real' : 'seco'
}

/** Uma opção ofertada ao cliente (numerada a partir de 1). */
export interface OpcaoOfertada {
  readonly n: number
  readonly usuarioId: string
  readonly inicio: string
  readonly fim: string
  /** Hora LOCAL "HH:MM" (o cliente escolhe pela hora ou pelo número). */
  readonly hora: string
  /** Data LOCAL "AAAA-MM-DD". */
  readonly data: string
}

export type EscolhaDeHorario =
  | { readonly tipo: 'escolheu'; readonly n: number }
  | { readonly tipo: 'recusou' }
  | { readonly tipo: 'indefinido' }

function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const NEGACAO = /\b(nao|nenhum|nenhuma|outro|outra|outros|outras|desmarca|cancela|cancelar|nem)\b/
const AFIRMATIVO = /^(sim|ok|okay|pode ser|pode|pode marcar|pode agendar|confirmo|confirmado|confirma|fechado|fechou|combinado|beleza|blz|perfeito|otimo|isso|isso mesmo|marca|marcado|agendado|aceito|bora|vamos)\b/
const ORDINAIS: Readonly<Record<string, number>> = { primeira: 1, primeiro: 1, segunda: 2, segundo: 2, terceira: 3, terceiro: 3 }

/** Horas que o texto menciona: "15h", "15:30", "15h30", "15 horas", "as 15". Minutos 0 se ausentes. */
function horasCitadas(n: string): string[] {
  const achadas = new Set<string>()
  for (const m of n.matchAll(/\b(\d{1,2})(?::(\d{2})|h(\d{2})?|\s?horas?\b)/g)) {
    const h = Number(m[1]); const mi = Number(m[2] ?? m[3] ?? 0)
    if (h <= 23 && mi <= 59) achadas.add(`${doisDigitos(h)}:${doisDigitos(mi)}`)
  }
  for (const m of n.matchAll(/\bas (\d{1,2})\b(?!\s*(?:de|\/))/g)) {
    const h = Number(m[1]); if (h <= 23) achadas.add(`${doisDigitos(h)}:00`)
  }
  return [...achadas]
}

/** Número de opção citado: "1", "opcao 2", "a 3", "numero 1", "primeira". */
function opcaoCitada(n: string): number | null {
  const so = /^(?:a |o |opcao |opção |numero |n )?(\d)[.!]?$/.exec(n)
  if (so) return Number(so[1])
  const m = /\b(?:opcao|numero)\s*(\d)\b/.exec(n)
  if (m) return Number(m[1])
  for (const [palavra, v] of Object.entries(ORDINAIS)) if (new RegExp(`\\b(a |o )?${palavra}\\b`).test(n)) return v
  return null
}

/**
 * O que o cliente escolheu entre as opções ofertadas — PURO e conservador. ⚠️ É o que sustenta
 * "nunca cria evento sem confirmação explícita do cliente": na dúvida, `indefinido`.
 *   - negação ("não", "outro", "nenhum") → `recusou`;
 *   - número da opção ou hora que casa com UMA opção → `escolheu`;
 *   - afirmativo puro ("sim", "pode ser") só vale quando foi ofertada UMA opção;
 *   - qualquer ambiguidade (hora que casa com duas, número inexistente) → `indefinido`.
 */
export function interpretarEscolhaDeHorario(texto: string, opcoes: readonly Pick<OpcaoOfertada, 'n' | 'hora'>[]): EscolhaDeHorario {
  const n = normalizar(texto)
  if (!n || opcoes.length === 0) return { tipo: 'indefinido' }
  if (NEGACAO.test(n)) return { tipo: 'recusou' }
  const numero = opcaoCitada(n)
  if (numero !== null) return opcoes.some((o) => o.n === numero) ? { tipo: 'escolheu', n: numero } : { tipo: 'indefinido' }
  const horas = horasCitadas(n)
  if (horas.length > 0) {
    const casam = opcoes.filter((o) => horas.includes(o.hora))
    return casam.length === 1 ? { tipo: 'escolheu', n: casam[0]!.n } : { tipo: 'indefinido' }
  }
  if (AFIRMATIVO.test(n) && n.length <= 30 && opcoes.length === 1) return { tipo: 'escolheu', n: opcoes[0]!.n }
  return { tipo: 'indefinido' }
}

// ─────────────────────────── avisos ao cliente ───────────────────────────

export const TIPOS_AVISO_REUNIAO = ['h24', 'h2', 'noshow'] as const
export type TipoAvisoReuniao = (typeof TIPOS_AVISO_REUNIAO)[number]

const HORA_MS = 3_600_000
/** Antecedência de cada lembrete. */
export const ANTECEDENCIA_LEMBRETE_MS: Readonly<Record<'h24' | 'h2', number>> = { h24: 24 * HORA_MS, h2: 2 * HORA_MS }
/** Depois do FIM do evento, quanto esperar alguém marcar "realizado" antes de tratar como no-show. */
export const NOSHOW_TOLERANCIA_MIN = 120
/** Depois do convite para remarcar, quanto esperar o cliente remarcar antes de passar a uma pessoa. */
export const NOSHOW_PRAZO_RESPOSTA_HORAS = 24

/**
 * Qual lembrete está devido AGORA para um evento agendado? PURO.
 *   - H-24 vale entre inicio−24h e inicio−2h; H-2 entre inicio−2h e o início.
 *   - Evento marcado DEPOIS do ponto do lembrete não recebe aquele lembrete (quem marcou há
 *     10 minutos para amanhã cedo não precisa de "lembrete de amanhã"); H-2 continua valendo.
 *   - Fora de `agendado` (realizado, cancelado, não compareceu) → nada.
 */
export function lembreteDevido(
  e: { inicio: Date; criadoEm: Date; status: string }, agora: Date,
): 'h24' | 'h2' | null {
  if (e.status !== 'agendado') return null
  const t = agora.getTime(); const ini = e.inicio.getTime(); const criado = e.criadoEm.getTime()
  if (t >= ini) return null
  const p2 = ini - ANTECEDENCIA_LEMBRETE_MS.h2
  const p24 = ini - ANTECEDENCIA_LEMBRETE_MS.h24
  if (t >= p2) return criado <= p2 ? 'h2' : null
  if (t >= p24) return criado <= p24 ? 'h24' : null
  return null
}

/**
 * O evento virou no-show? PURO. "Não compareceu" marcado pela pessoa, ou `agendado` que passou
 * do fim + tolerância sem ninguém marcar "realizado". Realizado/cancelado nunca.
 */
export function noShowDevido(e: { fim: Date; status: string }, agora: Date): boolean {
  if (e.status === 'nao_compareceu') return true
  return e.status === 'agendado' && agora.getTime() >= e.fim.getTime() + NOSHOW_TOLERANCIA_MIN * 60_000
}

/**
 * Como o aviso sai pelo gateway — PURO (ADR-021, skill whatsapp-meta):
 *   - oficial dentro da janela de 24h → texto (gratuito, com data e hora);
 *   - oficial fora da janela → SÓ o template aprovado configurado no número; sem ele → recusa;
 *   - não-oficial → SÓ texto, e só dentro da cota de aquecimento do dia;
 *   - outros canais (Instagram) → texto dentro da janela, senão recusa (não há template).
 */
export type DecisaoAvisoReuniao =
  | { readonly acao: 'texto' }
  | { readonly acao: 'template'; readonly templateId: string }
  | { readonly acao: 'recusar'; readonly motivo: 'sem_template' | 'template_indisponivel' | 'aquecimento_esgotado' | 'janela_fechada' }

export function decidirAvisoReuniao(p: {
  tipoCanal: string; janelaAberta: boolean
  template: { id: string; aprovado: boolean; compativel: boolean } | null
  aquecimentoRestante: number
}): DecisaoAvisoReuniao {
  if (p.tipoCanal === 'whatsapp_nao_oficial') {
    return p.aquecimentoRestante > 0 ? { acao: 'texto' } : { acao: 'recusar', motivo: 'aquecimento_esgotado' }
  }
  if (p.janelaAberta) return { acao: 'texto' }
  if (p.tipoCanal !== 'whatsapp_oficial') return { acao: 'recusar', motivo: 'janela_fechada' }
  if (!p.template) return { acao: 'recusar', motivo: 'sem_template' }
  if (!p.template.aprovado || !p.template.compativel) return { acao: 'recusar', motivo: 'template_indisponivel' }
  return { acao: 'template', templateId: p.template.id }
}

const primeiro = (nome: string | null | undefined): string => (nome ?? '').trim().split(/\s+/)[0] ?? ''

/** Texto do lembrete (dentro da janela / não-oficial). Dados do banco, nunca do modelo. */
export function textoLembreteReuniao(p: { tipo: 'h24' | 'h2'; contato: string | null; data: string; hora: string; responsavel: string | null }): string {
  const ola = primeiro(p.contato) ? `Olá, ${primeiro(p.contato)}!` : 'Olá!'
  const quando = p.tipo === 'h24' ? `amanhã (${p.data}) às ${p.hora}` : `hoje às ${p.hora}`
  const com = primeiro(p.responsavel) ? ` com ${primeiro(p.responsavel)}` : ''
  return `${ola} Passando para lembrar da nossa reunião ${quando}${com}. Se precisar remarcar, é só responder por aqui.`
}

/** Texto do convite para remarcar depois do no-show (dentro da janela / não-oficial). */
export function textoReagendamento(p: { contato: string | null; data: string; hora: string }): string {
  const ola = primeiro(p.contato) ? `Olá, ${primeiro(p.contato)}!` : 'Olá!'
  return `${ola} Sentimos sua falta na reunião de ${p.data} às ${p.hora}. Quer remarcar? Responda com o melhor dia e horário para você.`
}

// ─────────────────────────── configuração por número ───────────────────────────

/** `GET/PUT /v1/canais/:id/agente/agenda` — a chave do número e os templates dos avisos. */
export interface ConfigAgendaDoAgente {
  /** "O agente pode marcar reuniões" — padrão DESLIGADO. */
  readonly reunioes: boolean
  /** Template aprovado do lembrete (oficial, fora da janela). Só {{1}} = primeiro nome. */
  readonly templateLembreteId: string | null
  /** Template aprovado do convite para remarcar após no-show. */
  readonly templateReagendarId: string | null
}
