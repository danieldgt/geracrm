/**
 * REGRAS PURAS de "Devolver ao agente" e "Reatribuir" no inbox (G1).
 * Quem barra de verdade é o servidor; aqui só se decide o que MOSTRAR e se o
 * formulário já pode ser enviado (a mesma regra do contrato da API).
 */

export const MOTIVOS_DEVOLUCAO = [
  { id: 'resolvido_pelo_humano', rotulo: 'Assunto resolvido pela equipe' },
  { id: 'cliente_quer_continuar_com_agente', rotulo: 'O cliente quer continuar com o agente' },
  { id: 'fora_do_horario', rotulo: 'Fora do horário de atendimento' },
  { id: 'outro', rotulo: 'Outro' },
] as const
export type MotivoDevolucao = (typeof MOTIVOS_DEVOLUCAO)[number]['id']

export const TETO_TEXTO = 300

export type Conducao = 'agente' | 'humano' | 'aguardando'
export const CONDUCOES: readonly { readonly id: Conducao; readonly rotulo: string }[] = [
  { id: 'agente', rotulo: 'Agente' },
  { id: 'humano', rotulo: 'Humano' },
  { id: 'aguardando', rotulo: 'Aguardando' },
]

export interface AtendimentoDaThread { readonly estado: string }

/** Só há o que devolver quando uma PESSOA conduz (atendimento aberto e assumido). */
export function podeDevolver(atendimento: AtendimentoDaThread | null | undefined): boolean {
  return !!atendimento && atendimento.estado === 'em_atendimento'
}

/** Reatribuir exige gestão E um atendimento aberto (assumido ou na fila). */
export function podeReatribuir(atendimento: AtendimentoDaThread | null | undefined, gestao: boolean): boolean {
  return gestao && !!atendimento && atendimento.estado !== 'encerrado'
}

/** `null` = pode enviar; senão, o texto que a tela mostra. "Outro" exige a observação. */
export function erroDevolucao(f: { motivo: MotivoDevolucao | null; observacao: string }): string | null {
  if (!f.motivo) return 'Escolha o motivo.'
  const obs = f.observacao.trim()
  if (obs.length > TETO_TEXTO) return `A observação aceita até ${TETO_TEXTO} caracteres.`
  if (f.motivo === 'outro' && !obs) return 'Descreva o motivo.'
  return null
}

export function erroReatribuicao(f: { usuarioId: string | null; motivo: string }): string | null {
  if (!f.usuarioId) return 'Escolha para quem reatribuir.'
  const m = f.motivo.trim()
  if (!m) return 'Diga o motivo.'
  if (m.length > TETO_TEXTO) return `O motivo aceita até ${TETO_TEXTO} caracteres.`
  return null
}

/** Corpo do POST: a observação só vai quando digitada ("Outro" a exige, validado antes). */
export function corpoDevolucao(f: { motivo: MotivoDevolucao; observacao: string }): { motivo: MotivoDevolucao; observacao?: string } {
  const obs = f.observacao.trim()
  return obs ? { motivo: f.motivo, observacao: obs } : { motivo: f.motivo }
}

/** Clicar no chip ativo o desliga (volta a "todas as condutas"). */
export function alternarConducao(atual: Conducao | null, clicada: Conducao): Conducao | null {
  return atual === clicada ? null : clicada
}
