import {
  CRITERIOS_RUBRICA, ROTULO_CRITERIO, ROTULO_REGRA_QUALIDADE,
  type AcaoAvaliacao, type AvaliacaoQualidadeDto, type CriterioRubrica, type GravidadeQualidade, type ResumoQualidadeDto,
} from '@geracrm/shared'

/**
 * Regras PURAS da aba Qualidade (ADR-031, raia P12) — testadas em
 * qualidade.regras.spec.ts. O componente só liga isto à tela.
 */

export type FiltroQualidade = 'todas' | 'achados' | 'criticas' | 'juiz'

/** O filtro da tela → os parâmetros da lista. */
export function parametrosDoFiltro(f: FiltroQualidade): Record<string, string> {
  if (f === 'achados') return { comAchado: '1' }
  if (f === 'criticas') return { gravidade: 'CRITICA' }
  if (f === 'juiz') return { tipo: 'juiz' }
  return {}
}

export type Tom = 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'

export function badgeGravidade(g: GravidadeQualidade | null): { rotulo: string; tom: Tom } {
  if (g === 'CRITICA') return { rotulo: 'Crítica', tom: 'erro' }
  if (g === 'ALTA') return { rotulo: 'Alta', tom: 'atencao' }
  if (g === 'MEDIA') return { rotulo: 'Média', tom: 'neutro' }
  return { rotulo: 'Sem violação', tom: 'sucesso' }
}

export function badgeAcao(a: AcaoAvaliacao | null): { rotulo: string; tom: Tom } | null {
  if (a === 'pausa_humano') return { rotulo: 'Pausou e transferiu', tom: 'erro' }
  if (a === 'nao_envie') return { rotulo: 'Sugestão "não envie"', tom: 'erro' }
  return null
}

export function rotuloOrigem(o: AvaliacaoQualidadeDto['origem']): string {
  return o === 'agente' ? 'Autônomo' : 'Sugestão'
}

export function rotuloGatilho(g: AvaliacaoQualidadeDto['gatilho']): string {
  return { turno: 'Regras do turno', fim_sessao: 'Juiz · fim da conversa', turnos: 'Juiz · a cada 10 turnos', manual: 'Juiz · pedido manual' }[g] ?? g
}

export function rotuloRegra(r: string): string {
  return ROTULO_REGRA_QUALIDADE[r as keyof typeof ROTULO_REGRA_QUALIDADE] ?? r
}

/** "3,8" — nota 0–5 com uma casa, vírgula. */
export function formatarNota(n: number | null): string {
  return n === null ? '—' : n.toFixed(1).replace('.', ',')
}

/** Tom de uma nota média: ≤ 3 atenção, ≥ 4 sucesso. */
export function tomDaNota(n: number | null): Tom {
  if (n === null) return 'neutro'
  if (n <= 3) return 'atencao'
  if (n >= 4) return 'sucesso'
  return 'neutro'
}

/** Notas por critério na ordem da rubrica, com rótulo (para barras 0–5). */
export function criteriosDaAvaliacao(a: AvaliacaoQualidadeDto): Array<{ criterio: CriterioRubrica; rotulo: string; nota: number; justificativa: string }> {
  if (!a.notas) return []
  return CRITERIOS_RUBRICA.map((c) => ({ criterio: c, rotulo: ROTULO_CRITERIO[c], nota: a.notas![c].nota, justificativa: a.notas![c].justificativa }))
}

export function mediasDoResumo(r: ResumoQualidadeDto): Array<{ criterio: CriterioRubrica; rotulo: string; media: number | null; largura: number }> {
  return CRITERIOS_RUBRICA.map((c) => {
    const m = r.mediaPorCriterio?.[c] ?? null
    return { criterio: c, rotulo: ROTULO_CRITERIO[c], media: m, largura: m === null ? 0 : Math.round((m / 5) * 100) }
  })
}

/** "20%" a partir de 0..1. */
export function formatarAmostra(a: number): string {
  const p = Math.round(a * 1000) / 10
  return `${String(p).replace('.', ',')}%`
}

/**
 * Texto do campo de amostra (em %) → fração 0..1 para salvar. Vazio = padrão
 * do modo (null). Erro nomeado quando inválido.
 */
export function amostraParaSalvar(texto: string): { ok: true; valor: number | null } | { ok: false; erro: string } {
  const t = texto.trim().replace('%', '').replace(',', '.')
  if (!t) return { ok: true, valor: null }
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, erro: 'Use um percentual entre 0 e 100.' }
  return { ok: true, valor: Math.round(n * 10) / 1000 }
}

/** Fração salva → texto do campo ("" quando é o padrão). */
export function textoDaAmostra(a: number | null): string {
  return a === null ? '' : String(Math.round(a * 1000) / 10).replace('.', ',')
}

/** O estado do juiz em uma linha (degradação visível). */
export function situacaoDoJuiz(j: ResumoQualidadeDto['juiz']): { rotulo: string; tom: Tom; detalhe: string | null } {
  if (!j.disponivel) return { rotulo: 'Juiz indisponível', tom: 'atencao', detalhe: j.motivoIndisponivel ?? 'Sem provedor de IA configurado. As regras seguem em 100% das mensagens.' }
  if (j.tetoMesCentavos === 0) return { rotulo: 'Juiz desligado', tom: 'neutro', detalhe: 'Teto do mês em R$ 0,00 neste número. As regras seguem em 100% das mensagens.' }
  if (j.pausadoPorTeto) return { rotulo: 'Juiz no teto do mês', tom: 'atencao', detalhe: 'O avaliador parou até o mês virar. As regras seguem em 100% das mensagens.' }
  return { rotulo: 'Juiz ativo', tom: 'sucesso', detalhe: null }
}

/** A violação de um item, numa linha. */
export function linhaDaViolacao(v: AvaliacaoQualidadeDto['violacoes'][number]): string {
  return `${rotuloRegra(v.regra)}${v.detalhe ? ` (${v.detalhe})` : ''}`
}

/** Erros nomeados das ações. */
export function mensagemDaFalha(codigo: string, padrao: string): string {
  return ({
    'qualidade.juiz_indisponivel': 'O juiz de qualidade não está configurado neste servidor.',
    'qualidade.teto_atingido': 'O avaliador chegou ao teto do mês neste número.',
    'qualidade.sem_sessao': 'O agente ainda não atuou nesta conversa.',
    'qualidade.sem_falas': 'Não há fala do agente para avaliar nesta conversa.',
    'qualidade.juiz_falhou': 'O avaliador não respondeu agora. Tente de novo em instantes.',
    'acesso.papel_insuficiente': 'Seu papel não permite esta ação. Peça a um administrador.',
  } as Record<string, string>)[codigo] ?? padrao
}
