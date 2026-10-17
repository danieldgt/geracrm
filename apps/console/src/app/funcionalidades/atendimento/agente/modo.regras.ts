import {
  DIAS_RECORTE, MODOS_FORA_DO_RECORTE, ROTULO_SEGMENTO_RECORTE, SEGMENTOS_RECORTE, exigeConfirmacao, textoDeConfirmacao,
  type ModoAgente, type ModoForaDoRecorte, type OrigemModo, type ParteForaDoRecorte, type RecorteAgente, type SegmentoRecorte,
} from '@geracrm/shared'
import type { HorarioAtendimento } from '../../../compartilhado/ui/index.js'

/**
 * Regras PURAS do MODO na tela do agente (ADR-028, raia P14): o selo do modo
 * efetivo, de onde veio a restrição, o recorte como formulário e a confirmação
 * digitada. Sem DOM, sem Angular — `modo.regras.spec.ts` cobre.
 *
 * ⚠️ A DECISÃO do modo efetivo é da API (`decidirModoEfetivo`, shared); a tela
 *    só apresenta o que o servidor calculou — calcular de novo aqui daria dois
 *    relógios e dois fusos.
 */

/** O que o GET de configuração traz sobre o modo (campos opcionais: a API anterior não manda). */
export interface ModoNaConfig {
  readonly recorte?: RecorteAgente | null
  readonly recorteInvalido?: boolean
  readonly tenant?: { readonly modoMaximo: ModoAgente }
  readonly modoEfetivo?: {
    readonly modo: ModoAgente
    readonly origem: OrigemModo
    readonly motivo: string | null
    readonly foraDoRecorte: readonly ParteForaDoRecorte[]
    readonly dependeDoContato: boolean
    readonly momento: { readonly diaIso: number; readonly hora: string }
  }
  readonly podeConfigurar?: boolean
  readonly reservaLlm?: ReservaLlm
}

export interface ReservaLlm {
  readonly provedor: string | null
  readonly configurada: boolean
  readonly faltaParaReserva: readonly string[]
  readonly situacao: 'principal' | 'reserva'
  readonly reservaAteEm: string | null
  readonly modelosBloqueados: number
}

export interface TetoDoTenant {
  readonly modoMaximo: ModoAgente
  readonly atualizadoEm: string | null
  readonly atualizadoPor: string | null
  readonly podeConfigurar: boolean
}

const PARTE: Readonly<Record<ParteForaDoRecorte, string>> = { horario: 'horário', segmento: 'segmento do cliente' }
const NOME_MODO: Readonly<Record<ModoAgente, string>> = { desligado: 'desligado', sombra: 'sombra', assistido: 'assistido', autonomo: 'autônomo' }

/**
 * A frase sob o selo: de onde veio o modo efetivo. ⚠️ Nomeia o NÍVEL que
 * restringiu — "por que ele não responde?" se resolve onde a frase aponta.
 */
export function fraseOrigem(e: NonNullable<ModoNaConfig['modoEfetivo']>, modoDoNumero: ModoAgente): string {
  if (e.origem === 'tenant') {
    return `Limitado pelo teto da conta (vale para todos os números): este número está em ${NOME_MODO[modoDoNumero]}, mas a conta permite no máximo ${NOME_MODO[e.modo]}.`
  }
  if (e.origem === 'recorte') {
    if (e.motivo === 'recorte_invalido') return 'O recorte salvo está inválido — por segurança o agente atua em sombra. Revise o recorte e salve.'
    const partes = e.foraDoRecorte.map((p) => PARTE[p]).join(' e ')
    return `Agora está fora do recorte (${partes}): o modo cai para ${NOME_MODO[e.modo]}. Dentro do recorte, vale ${NOME_MODO[modoDoNumero]}.`
  }
  return e.dependeDoContato
    ? `Vale o modo deste número no horário de agora; o segmento do cliente decide conversa a conversa.`
    : 'Vale o modo deste número.'
}

// ─── Recorte como formulário ───────────────────────────────────────────────

export interface FormularioRecorte {
  readonly ativo: boolean
  readonly usaHorario: boolean
  readonly horario: HorarioAtendimento
  readonly segmentos: readonly SegmentoRecorte[]
  readonly foraDoRecorte: ModoForaDoRecorte
}

const HORARIO_PADRAO: HorarioAtendimento = {
  seg: { de: '08:00', ate: '18:00' }, ter: { de: '08:00', ate: '18:00' }, qua: { de: '08:00', ate: '18:00' },
  qui: { de: '08:00', ate: '18:00' }, sex: { de: '08:00', ate: '18:00' }, sab: null, dom: null,
}

export function recorteParaFormulario(r: RecorteAgente | null | undefined): FormularioRecorte {
  if (!r) return { ativo: false, usaHorario: true, horario: HORARIO_PADRAO, segmentos: [], foraDoRecorte: 'sombra' }
  const horario: HorarioAtendimento = {}
  for (const d of DIAS_RECORTE) horario[d] = r.horario?.[d] ?? null
  return {
    ativo: r.horario !== null || r.segmentosRfv.length > 0,
    usaHorario: r.horario !== null,
    horario: r.horario ? horario : HORARIO_PADRAO,
    segmentos: [...r.segmentosRfv],
    foraDoRecorte: r.foraDoRecorte,
  }
}

/** O erro do recorte, ou null. As mesmas regras do schema da API, ditas para gente. */
export function erroDoRecorte(f: FormularioRecorte): string | null {
  if (!f.ativo) return null
  const dias = DIAS_RECORTE.filter((d) => f.horario[d])
  if (!f.usaHorario && f.segmentos.length === 0) return 'Escolha um horário ou ao menos um segmento — ou desligue o recorte.'
  if (f.usaHorario && dias.length === 0) return 'Marque ao menos um dia no horário do recorte.'
  for (const d of dias) {
    const faixa = f.horario[d]!
    if (!/^\d{2}:\d{2}$/.test(faixa.de) || !/^\d{2}:\d{2}$/.test(faixa.ate)) return 'Preencha início e fim de cada dia marcado (HH:MM).'
    if (faixa.de === faixa.ate) return 'Início e fim iguais num dia do recorte.'
  }
  return null
}

/** O corpo `recorte` do PUT: null = sem recorte. Só dias abertos vão. */
export function recorteParaSalvar(f: FormularioRecorte): RecorteAgente | null {
  if (!f.ativo) return null
  let horario: RecorteAgente['horario'] = null
  if (f.usaHorario) {
    const h: Record<string, { de: string; ate: string }> = {}
    for (const d of DIAS_RECORTE) { const faixa = f.horario[d]; if (faixa?.de && faixa.ate) h[d] = { de: faixa.de, ate: faixa.ate } }
    horario = h as RecorteAgente['horario']
  }
  return { horario, segmentosRfv: [...f.segmentos], foraDoRecorte: f.foraDoRecorte }
}

export const SEGMENTOS = SEGMENTOS_RECORTE
export const ROTULO_SEGMENTO = ROTULO_SEGMENTO_RECORTE
export const MODOS_FORA = MODOS_FORA_DO_RECORTE
export const ROTULO_FORA: Readonly<Record<ModoForaDoRecorte, string>> = {
  desligado: 'Desligado — fora do recorte ele não atua',
  sombra: 'Sombra — registra o que diria, não envia',
  assistido: 'Assistido — sugere ao vendedor',
}

// ─── Confirmação digitada ──────────────────────────────────────────────────

/** O pedido de confirmação para a troca, ou null se a troca não pede. */
export function pedidoDeConfirmacao(atual: ModoAgente | null, novo: ModoAgente, alvo: 'numero' | 'conta'):
  { titulo: string; mensagem: string; acao: string; digitar: string } | null {
  if (!exigeConfirmacao(alvo === 'conta' ? (atual ?? 'autonomo') : atual, novo)) return null
  const onde = alvo === 'conta' ? 'em TODOS os números da conta' : 'neste número'
  return novo === 'desligado'
    ? {
        titulo: alvo === 'conta' ? 'Desligar o agente na conta inteira?' : 'Desligar o agente?',
        mensagem: `O agente para de atuar ${onde}. As mensagens continuam gravadas e as conversas vão para a equipe.`,
        acao: 'Desligar', digitar: textoDeConfirmacao(novo),
      }
    : {
        titulo: alvo === 'conta' ? 'Liberar o modo autônomo na conta?' : 'Deixar o agente autônomo?',
        mensagem: `O agente passa a responder SOZINHO aos clientes ${onde}, dentro da alçada e do recorte. Guardrails continuam valendo.`,
        acao: 'Deixar autônomo', digitar: textoDeConfirmacao(novo),
      }
}

/**
 * Tirar o recorte de um número que CONTINUA autônomo solta o robô para qualquer
 * hora e qualquer cliente: pede "autonomo" digitado, como a API (P14).
 */
export function pedidoAoTirarRecorte(modoSalvo: ModoAgente, modoNovo: ModoAgente, tinhaRecorte: boolean, recorteNovo: RecorteAgente | null):
  { titulo: string; mensagem: string; acao: string; digitar: string } | null {
  if (!(modoSalvo === 'autonomo' && modoNovo === 'autonomo' && tinhaRecorte && recorteNovo === null)) return null
  return {
    titulo: 'Tirar o recorte do agente autônomo?',
    mensagem: 'Sem recorte, o agente responde sozinho a qualquer hora e a qualquer cliente deste número.',
    acao: 'Tirar o recorte', digitar: textoDeConfirmacao('autonomo'),
  }
}

// ─── Reserva de LLM (P5) ───────────────────────────────────────────────────

/** Uma linha sobre a reserva de provedor; `tom` para o badge. */
export function fraseReserva(r: ReservaLlm | undefined, agora: Date = new Date()): { texto: string; tom: 'neutro' | 'atencao' | 'sucesso' } | null {
  if (!r) return null
  if (r.situacao === 'reserva') {
    const ate = r.reservaAteEm ? new Date(r.reservaAteEm) : null
    const quando = ate && ate > agora ? ` até ${ate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''
    return { texto: `O provedor principal falhou: respondendo pela reserva${quando}. Volta sozinho ao principal.`, tom: 'atencao' }
  }
  if (r.faltaParaReserva.length > 0) return { texto: `Reserva pedida, mas falta configurar no servidor: ${r.faltaParaReserva.join(', ')}.`, tom: 'atencao' }
  if (r.configurada) return { texto: `Reserva pronta (${r.provedor}): se o principal falhar duas vezes seguidas, ela assume.`, tom: 'sucesso' }
  return { texto: 'Sem reserva de provedor: se o principal cair, as conversas vão para a equipe.', tom: 'neutro' }
}
