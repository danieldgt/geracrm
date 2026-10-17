/**
 * SLA DO HANDOFF — fatia mínima de INB-22 (raia P18, ADR-034).
 *
 * TypeScript puro: consumido pela API (worker, rotas, handoff) e pelo console
 * (cronômetro, configuração). O que depende do EXPEDIENTE (`somarMinutosUteis`)
 * mora na API, ao lado de `expediente.ts` (P11) — reescrever o calendário aqui
 * criaria a segunda cópia da régua "a loja está aberta?".
 *
 * Aqui:
 *   - configuração por número (`SLA_PADRAO`, `corpoSlaConfig`);
 *   - `rotearHandoff` — para quem vai o cliente que o agente transferiu;
 *   - `faixaDoCronometro` — verde → amarelo → vermelho;
 *   - os textos FIXOS da mensagem única de espera (sem prometer prazo).
 */
import { z } from 'zod'

// ── configuração ───────────────────────────────────────────────────────────

export interface ConfigSla {
  /** Minutos ÚTEIS até o SLA: notifica o gestor e grava `sla_estourado_em`. */
  readonly slaMinutos: number
  /** Minutos ÚTEIS até liberar a reatribuição (2º limiar). Sempre > slaMinutos. */
  readonly reatribuicaoMinutos: number
  /** Manda a mensagem ÚNICA de espera ao cliente no SLA. */
  readonly avisoEspera: boolean
}

/** Sem linha em `atendimento_sla_config`: o padrão vale (ADR-034). */
export const SLA_PADRAO: ConfigSla = { slaMinutos: 30, reatribuicaoMinutos: 60, avisoEspera: true }

export const LIMITES_SLA = { slaMin: 5, slaMax: 480, reatribuicaoMax: 1440 } as const

export const corpoSlaConfig = z.object({
  slaMinutos: z.number().int()
    .min(LIMITES_SLA.slaMin, `O SLA precisa de pelo menos ${LIMITES_SLA.slaMin} minutos.`)
    .max(LIMITES_SLA.slaMax, `O SLA pode ter no máximo ${LIMITES_SLA.slaMax} minutos (8 horas úteis).`),
  reatribuicaoMinutos: z.number().int()
    .max(LIMITES_SLA.reatribuicaoMax, `A reatribuição pode esperar no máximo ${LIMITES_SLA.reatribuicaoMax} minutos.`),
  avisoEspera: z.boolean(),
}).strict().refine((c) => c.reatribuicaoMinutos > c.slaMinutos, {
  message: 'A reatribuição tem de vir DEPOIS do SLA.', path: ['reatribuicaoMinutos'],
})
export type CorpoSlaConfig = z.output<typeof corpoSlaConfig>

/** GET /v1/canais/:id/sla */
export interface EstadoSlaConfig {
  readonly config: ConfigSla
  /** true = não há linha; o padrão está valendo. */
  readonly padrao: boolean
  readonly padroes: ConfigSla
  readonly fuso: string
  readonly horarioConfigurado: boolean
  readonly atualizadoEm: string | null
}

// ── roteamento ─────────────────────────────────────────────────────────────

export interface PessoaRoteavel {
  readonly id: string
  readonly ativo: boolean
  /** Marcou "Estou ausente". Ausente não recebe handoff. */
  readonly ausente: boolean
}

export interface EntradaRoteamento {
  /** Dono da carteira do contato (carteira_atribuicao aberta), se houver. */
  readonly donoCarteira: PessoaRoteavel | null
  /** Quem tem permissão no número (`usuario_canal`). Ordem não importa. */
  readonly pool: readonly PessoaRoteavel[]
  /** O último do pool que recebeu um handoff NESTE número (rodízio). */
  readonly ultimoDoRodizio: string | null
  /** Admin/gestor/supervisor ativos, em ordem de preferência. */
  readonly gestores: readonly PessoaRoteavel[]
}

export type DestinoHandoff = 'dono_carteira' | 'pool' | 'gestor' | 'ninguem'

export interface Roteamento {
  readonly destino: DestinoHandoff
  readonly usuarioId: string | null
}

const disponivel = (p: PessoaRoteavel | null | undefined): p is PessoaRoteavel => !!p && p.ativo && !p.ausente

/**
 * Para quem vai o handoff (puro, sem banco):
 *   1. o DONO DA CARTEIRA, se ativo e não ausente — quem tem a relação responde;
 *   2. o POOL do número, em RODÍZIO: o próximo (por id) depois do último que
 *      recebeu; volta ao primeiro no fim da lista;
 *   3. um GESTOR ativo;
 *   4. ninguém — a fila do número continua sendo avisada como antes.
 */
export function rotearHandoff(e: EntradaRoteamento): Roteamento {
  if (disponivel(e.donoCarteira)) return { destino: 'dono_carteira', usuarioId: e.donoCarteira.id }
  const pool = [...new Map(e.pool.filter(disponivel).map((p) => [p.id, p])).values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (pool.length > 0) {
    const proximo = e.ultimoDoRodizio ? pool.find((p) => p.id > e.ultimoDoRodizio!) : undefined
    return { destino: 'pool', usuarioId: (proximo ?? pool[0]!).id }
  }
  const gestor = e.gestores.find(disponivel)
  if (gestor) return { destino: 'gestor', usuarioId: gestor.id }
  return { destino: 'ninguem', usuarioId: null }
}

// ── cronômetro ─────────────────────────────────────────────────────────────

/** GET /v1/conversas/:id/sla e o card da fila no kanban. Instantes em ISO. */
export interface CronometroSla {
  readonly atendimentoId: string
  readonly inicioEm: string
  readonly venceEm: string
  readonly reatribuicaoVenceEm: string | null
  readonly estouradoEm: string | null
  readonly reatribuicaoLiberadaEm: string | null
  readonly respondidoEm: string | null
  readonly avisoEspera: { readonly em: string; readonly resultado: string | null } | null
  readonly responsavel: string | null
  /** Fuso IANA do tenant: os horários do cronômetro são mostrados nele. */
  readonly fuso: string
}

export type FaixaCronometro = 'verde' | 'amarelo' | 'vermelho' | 'respondido'

/** Fração do prazo a partir da qual o cronômetro fica amarelo. */
export const FRACAO_AMARELO = 2 / 3

/**
 * A cor do cronômetro neste instante: verde até 2/3 do prazo, amarelo até o
 * vencimento, vermelho depois. Respondido pára o relógio. ⚠️ O prazo é o
 * instante `venceEm` (já em minutos ÚTEIS): fora do expediente o relógio de
 * parede anda, mas o vencimento já está na próxima abertura.
 */
export function faixaDoCronometro(
  c: Pick<CronometroSla, 'inicioEm' | 'venceEm' | 'respondidoEm' | 'estouradoEm'>, agora: Date,
): FaixaCronometro {
  if (c.respondidoEm) return 'respondido'
  const inicio = Date.parse(c.inicioEm)
  const vence = Date.parse(c.venceEm)
  const t = agora.getTime()
  if (c.estouradoEm || t >= vence) return 'vermelho'
  const total = vence - inicio
  if (total <= 0) return 'vermelho'
  return (t - inicio) / total >= FRACAO_AMARELO ? 'amarelo' : 'verde'
}

/** "12 min", "1 h 05", "2 d 3 h" — para "faltam X" / "estourado há X". */
export function duracaoCurta(ms: number): string {
  const min = Math.max(0, Math.floor(Math.abs(ms) / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

// ── mensagem única de espera ───────────────────────────────────────────────

/**
 * Texto FIXO da espera, no expediente. ⚠️ Sem prazo ("em breve", "em 5
 * minutos") e sem número: é cortesia, não promessa — e passa pelo filtro P2 e
 * pela rede de R$ do mesmo jeito (teste no shared).
 */
export const TEXTO_AVISO_ESPERA =
  'Sua mensagem está com a nossa equipe e uma pessoa vai continuar o atendimento por aqui, neste mesmo número. Obrigado pela paciência!'

/** Fora do expediente (ou feriado) no momento do aviso. */
export const TEXTO_AVISO_ESPERA_FORA =
  'Sua mensagem está com a nossa equipe e uma pessoa continua o atendimento por aqui no próximo horário de atendimento. Obrigado pela paciência!'

/**
 * Fora do expediente com texto do PLAYBOOK (P17) que não fala do próximo
 * horário: o complemento é anexado — o cliente não pode ler "uma pessoa vai
 * continuar" às 22h e esperar resposta na hora.
 */
export const COMPLEMENTO_AVISO_FORA = 'Uma pessoa da equipe continua no próximo horário de atendimento.'
export function falaDoProximoHorario(texto: string): boolean {
  return /pr[óo]ximo\s+hor[áa]rio/i.test(texto)
}

export const RESULTADOS_AVISO_ESPERA = [
  'pendente', 'enviada', 'desligado', 'humano_respondeu', 'conversa_com_agente',
  'opt_out', 'janela_fechada', 'texto_bloqueado', 'falhou',
] as const
export type ResultadoAvisoEspera = (typeof RESULTADOS_AVISO_ESPERA)[number]

export const ROTULO_AVISO_ESPERA: Record<ResultadoAvisoEspera, string> = {
  pendente: 'mensagem de espera em envio',
  enviada: 'mensagem de espera enviada',
  desligado: 'mensagem de espera desligada no número',
  humano_respondeu: 'sem mensagem de espera: alguém já respondeu',
  conversa_com_agente: 'sem mensagem de espera: conversa voltou ao agente',
  opt_out: 'sem mensagem de espera: cliente em opt-out',
  janela_fechada: 'sem mensagem de espera: janela de 24 h fechada',
  texto_bloqueado: 'sem mensagem de espera: texto barrado pelo filtro',
  falhou: 'mensagem de espera não saiu (canal recusou)',
}

/** Placeholders aceitos na mensagem do playbook (P17): {nome}, {assistente}, {empresa}. */
export function renderizarAvisoEspera(modelo: string, v: { nome?: string | null; assistente?: string | null; empresa?: string | null }): string {
  return modelo
    .replace(/\{nome\}/g, (v.nome ?? '').trim().split(/\s+/)[0] ?? '')
    .replace(/\{assistente\}/g, (v.assistente ?? '').trim())
    .replace(/\{empresa\}/g, (v.empresa ?? '').trim())
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .trim()
}
