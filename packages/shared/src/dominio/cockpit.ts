/**
 * COCKPIT DO GESTOR (raia D1) — o contrato de `GET /v1/gestao/cockpit` e `/itens`.
 *
 * TypeScript puro: consumido pela API (que monta) e pelo console (que desenha). A ordem, os
 * rótulos e a regra de "esquecido" moram aqui para as duas pontas não divergirem.
 */

export const AGRUPAMENTOS_COCKPIT = ['filial', 'vendedor'] as const
export type AgrupamentoCockpit = (typeof AGRUPAMENTOS_COCKPIT)[number]
export const ehAgrupamentoCockpit = (v: unknown): v is AgrupamentoCockpit =>
  (AGRUPAMENTOS_COCKPIT as readonly unknown[]).includes(v)

/** Os seis cards, na ordem em que a tela os mostra. */
export const CARDS_COCKPIT = [
  'aguardandoHumano', 'slaEstouradoHoje', 'esquecidos', 'reunioesHoje', 'naoCompareceuHoje', 'semProximoPasso',
] as const
export type CardCockpit = (typeof CARDS_COCKPIT)[number]
export const ehCardCockpit = (v: unknown): v is CardCockpit => (CARDS_COCKPIT as readonly unknown[]).includes(v)

/** Cards que só existem com o módulo Agenda ligado (vêm `null` com ele desligado). */
export const CARDS_DE_AGENDA: readonly CardCockpit[] = ['reunioesHoje', 'naoCompareceuHoje']
export const cardDeAgenda = (c: CardCockpit): boolean => CARDS_DE_AGENDA.includes(c)

export const ROTULO_CARD_COCKPIT: Readonly<Record<CardCockpit, string>> = {
  aguardandoHumano: 'Aguardando humano',
  slaEstouradoHoje: 'SLA estourado hoje',
  esquecidos: 'Esquecidos',
  reunioesHoje: 'Reuniões hoje',
  naoCompareceuHoje: 'Não compareceu hoje',
  semProximoPasso: 'Sem próximo passo',
}

/** Esquecido = em funil ou qualificado, sem toque há mais de N dias. */
export const DIAS_ESQUECIDO_PADRAO = 7
export const DIAS_ESQUECIDO_MAX = 365

/** Faixa de espera de quem aguarda um humano — mesma régua do cronômetro do SLA (verde/amarelo/vermelho). */
export type FaixaAguardando = 'ok' | 'atencao' | 'estourado'

export interface PorFaixa { readonly ok: number; readonly atencao: number; readonly estourado: number }

export interface CardsCockpit {
  readonly aguardandoHumano: { readonly total: number; readonly porFaixa: PorFaixa }
  readonly slaEstouradoHoje: number
  readonly esquecidos: number
  /** `null` = módulo Agenda desligado: o card some da tela. */
  readonly reunioesHoje: number | null
  readonly naoCompareceuHoje: number | null
  readonly semProximoPasso: number
}

export interface GrupoCockpit {
  /** `usuario.id` (vendedor), `filial.id` (filial) ou `sem` (sem responsável / sem filial). */
  readonly chave: string
  readonly rotulo: string
  readonly aguardandoHumano: number
  readonly slaEstouradoHoje: number
  readonly esquecidos: number
  readonly reunioesHoje: number | null
  readonly naoCompareceuHoje: number | null
  readonly semProximoPasso: number
}

export interface RespostaCockpit {
  readonly agrupar: AgrupamentoCockpit
  readonly dias: number
  /** Instante (ISO) em que a API montou os números. */
  readonly geradoEm: string
  readonly cards: CardsCockpit
  readonly grupos: readonly GrupoCockpit[]
}

export type TipoItemCockpit = 'conversa' | 'contato' | 'evento'

export interface ItemCockpit {
  readonly tipo: TipoItemCockpit
  /** Chave da linha: conversa.id, atendimento.id (SLA estourado), contato.id ou evento_agenda.id. Para abrir, use `conversaId`/`contatoId`. */
  readonly id: string
  readonly rotulo: string
  readonly contatoId: string | null
  readonly contato: string | null
  /** Para abrir no trilho; `null` quando o contato nunca conversou. */
  readonly conversaId: string | null
  readonly responsavelId: string | null
  readonly responsavel: string | null
  /** Desde quando (ISO): início da espera, vencimento do SLA, último toque, início do evento… */
  readonly desde: string
  readonly faixa: FaixaAguardando | null
  /** Só `evento`: status e versão (concorrência otimista) para as ações rápidas. */
  readonly eventoStatus: string | null
  readonly eventoVersao: number | null
  /** Rota do console que abre o item. */
  readonly link: string
}

export interface RespostaItensCockpit {
  readonly itens: readonly ItemCockpit[]
  readonly proximoCursor: string | null
}
