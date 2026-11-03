/** Regras puras da anonimização LGPD no console (raia H2). Sem Angular, sem rede. */

/** O que a pessoa digita para confirmar a anonimização definitiva. */
export const TEXTO_CONFIRMACAO_ANONIMIZAR = 'ANONIMIZAR'
/** Código tipificado da API quando o contato tem compra (dado fiscal). */
export const ERRO_CONTATO_COM_COMPRA = 'lgpd.contato_com_compra'

export type MotivoAnonimizacao = 'retencao' | 'opt_out' | 'titular'

export interface RelatorioAnonimizacao {
  readonly de: string
  readonly ate: string
  readonly total: number
  readonly porMotivo: Readonly<Record<MotivoAnonimizacao, number>>
  readonly porModo: Readonly<Record<'completa' | 'canais', number>>
  readonly midiasPendentes: number
  readonly midiasRemovidas: number
  readonly falhas: number
}

/** `GET /v1/lgpd/previa` — modo relatório da anonimização automática. */
export interface PreviaLgpd {
  readonly ativa: boolean
  readonly alteradaEm: string | null
  readonly retencaoMeses: number
  readonly porMotivo: Readonly<Record<'retencao' | 'opt_out', number>>
  readonly total: number
  /** A contagem bateu no teto: "mais de". */
  readonly limitado: boolean
}

/** O que a pessoa digita para LIGAR a anonimização automática. */
export const TEXTO_CONFIRMACAO_AUTOMATICA = 'LIGAR'

/**
 * Texto da tela depois de anonimizar. ⚠️ Só diz "apagado" quando não há objeto do armazenamento
 * pendente; senão diz "em remoção" — o worker apaga os arquivos depois, fora da transação.
 */
export function mensagemAnonimizado(midiasPendentes: number): string {
  if (midiasPendentes <= 0) return 'Dados pessoais apagados.'
  return midiasPendentes === 1
    ? 'Dados pessoais apagados; 1 arquivo em remoção do armazenamento.'
    : `Dados pessoais apagados; ${midiasPendentes} arquivos em remoção do armazenamento.`
}

/** Frase da prévia: quantos a primeira passada anonimizaria. */
export function resumoPrevia(p: Pick<PreviaLgpd, 'porMotivo' | 'total' | 'limitado'>): string {
  if (p.total === 0) return 'Hoje nenhum contato seria anonimizado.'
  const mais = p.limitado ? 'mais de ' : ''
  return `A primeira passada anonimizaria ${mais}${p.total} contato(s): ${p.porMotivo.retencao} pelo fim do prazo de retenção `
    + `e ${p.porMotivo.opt_out} que pediram para sair há mais de 15 dias.`
}

/** Rótulo do motivo de bloqueio; o LGPD aparece junto do motivo original (que é preservado). */
export function rotuloBloqueio(motivo: string, lgpd: boolean): string {
  const base = ({ opt_out: 'Pediu para sair', denuncia: 'Denúncia', manual: 'Manual', invalido: 'Número inválido', lgpd: 'LGPD' } as Record<string, string>)[motivo] ?? motivo
  return lgpd && motivo !== 'lgpd' ? `${base} · LGPD` : base
}

/** Evidência do novo consentimento: 5 a 500 caracteres (a API é a regra; isto é conveniência). */
export function evidenciaValida(texto: string): boolean {
  const t = texto.trim()
  return t.length >= 5 && t.length <= 500
}

const ROTULO_MOTIVO: Readonly<Record<MotivoAnonimizacao, string>> = {
  retencao: 'Fim do prazo de retenção',
  opt_out: 'Pediu para sair (opt-out)',
  titular: 'Pedido do titular',
}

export function rotuloMotivo(m: MotivoAnonimizacao): string { return ROTULO_MOTIVO[m] }

/** Motivos na ordem fixa da tela, com a contagem (zero também aparece). */
export function linhasPorMotivo(r: RelatorioAnonimizacao): { motivo: MotivoAnonimizacao; rotulo: string; total: number }[] {
  return (['retencao', 'opt_out', 'titular'] as const).map((motivo) => ({ motivo, rotulo: ROTULO_MOTIVO[motivo], total: r.porMotivo[motivo] ?? 0 }))
}

/** Primeiro e último dia (AAAA-MM-DD, UTC) do mês de `agora` — o período padrão do painel. */
export function periodoDoMes(agora: Date): { de: string; ate: string } {
  const a = agora.getUTCFullYear(), m = agora.getUTCMonth()
  const ultimo = new Date(Date.UTC(a, m + 1, 0)).getUTCDate()
  const mm = String(m + 1).padStart(2, '0')
  return { de: `${a}-${mm}-01`, ate: `${a}-${mm}-${String(ultimo).padStart(2, '0')}` }
}
