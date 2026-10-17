import {
  CRITERIOS_RUBRICA, META_CONCORDANCIA, MIN_REVISADAS_CONCORDANCIA, ROTULO_CRITERIO, semanaDaData,
  type CorpoRevisao, type CriterioRubrica, type DecisaoRevisao, type GravidadeQualidade, type ItemAmostraRevisaoDto,
  type MotivoAmostra, type RevisaoDto, type SomaConcordancia, type VereditoRevisao,
} from '@geracrm/shared'
import type { Tom } from './qualidade.regras.js'

/**
 * Regras PURAS da aba Revisão (ADR-031 §5, raia P16) — testadas em
 * revisao.regras.spec.ts. O componente só liga isto à tela.
 */

/** "85%" a partir de 0..1; "—" sem valor. */
export function formatarPercentual(f: number | null): string {
  if (f === null) return '—'
  return `${String(Math.round(f * 1000) / 10).replace('.', ',')}%`
}

/** A situação da concordância em uma linha: meta, poucas revisões, falso negativo crítico. */
export function situacaoDaConcordancia(s: SomaConcordancia): { rotulo: string; tom: Tom; detalhe: string | null } {
  if (s.comparaveis === 0) {
    return { rotulo: 'Sem revisões comparáveis', tom: 'neutro', detalhe: s.revisadas > 0 ? 'As revisões desta semana não têm nota do juiz para comparar.' : null }
  }
  if (s.falsosNegativosCritica > 0) {
    return { rotulo: 'Crítica que o juiz não viu', tom: 'erro', detalhe: `${s.falsosNegativosCritica} conversa(s) com crítica vista só pela revisão humana. Vire regra ou caso de teste antes de avançar de fase.` }
  }
  if (s.comparaveis < MIN_REVISADAS_CONCORDANCIA) {
    return { rotulo: 'Poucas revisões', tom: 'atencao', detalhe: `${s.comparaveis} de ${MIN_REVISADAS_CONCORDANCIA} com nota do juiz — a concordância só vale como critério de fase a partir de ${MIN_REVISADAS_CONCORDANCIA}.` }
  }
  if ((s.concordancia ?? 0) >= META_CONCORDANCIA) return { rotulo: 'Na meta', tom: 'sucesso', detalhe: null }
  return { rotulo: 'Abaixo da meta', tom: 'erro', detalhe: 'Calibre o juiz com as conversas em que ele divergiu e revise de novo na semana seguinte.' }
}

export function rotuloMotivo(m: MotivoAmostra | null): string {
  if (m === 'critica') return 'Crítica'
  if (m === 'alta_ou_nota_baixa') return 'Alta ou nota ≤ 3'
  if (m === 'aleatoria') return 'Aleatória'
  return 'Fora da amostra'
}

const MESES = ['jan.', 'fev.', 'mar.', 'abr.', 'maio', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.']

/** '2026-W42' + '2026-10-12' → "Semana 42 · 12 a 18 de out." (cruza mês: "28 de set. a 4 de out."). */
export function rotuloSemana(semana: string, inicio: string): string {
  const n = Number(semana.slice(-2))
  const ini = new Date(`${inicio}T00:00:00Z`)
  if (Number.isNaN(ini.getTime())) return `Semana ${n}`
  const fim = new Date(ini.getTime() + 6 * 86_400_000)
  const di = ini.getUTCDate(), df = fim.getUTCDate()
  const mi = MESES[ini.getUTCMonth()]!, mf = MESES[fim.getUTCMonth()]!
  return mi === mf ? `Semana ${n} · ${di} a ${df} de ${mf}` : `Semana ${n} · ${di} de ${mi} a ${df} de ${mf}`
}

/** A semana de hoje no relógio de quem usa (o servidor confere no fuso da loja). */
export function semanaDeHoje(agora: Date = new Date()): string {
  const d = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`
  return semanaDaData(d)!
}

export function progressoDaAmostra(itens: readonly ItemAmostraRevisaoDto[]): { revisadas: number; total: number } {
  return { revisadas: itens.filter((i) => i.revisao !== null).length, total: itens.length }
}

// ── formulário ──────────────────────────────────────────────────────────────

/** `undefined` = ainda não escolhido; `null` na gravidade = "nenhuma" escolhida. */
export interface FormularioRevisao {
  readonly notas: Readonly<Partial<Record<CriterioRubrica, number>>>
  readonly gravidade: GravidadeQualidade | null | undefined
  readonly veredito: VereditoRevisao | undefined
  readonly decisao: DecisaoRevisao
  readonly responsavel: string
  readonly prazo: string
  readonly observacao: string
}

export function formularioVazio(): FormularioRevisao {
  return { notas: {}, gravidade: undefined, veredito: undefined, decisao: 'nenhuma', responsavel: '', prazo: '', observacao: '' }
}

/** A revisão já gravada → o formulário (regravar substitui). */
export function formularioDe(r: RevisaoDto | null): FormularioRevisao {
  if (!r) return formularioVazio()
  return {
    notas: { ...r.notas }, gravidade: r.gravidade, veredito: r.veredito, decisao: r.decisao,
    responsavel: r.responsavel ?? '', prazo: r.prazo ?? '', observacao: r.observacao ?? '',
  }
}

export type ErrosFormulario = Partial<Record<'notas' | 'gravidade' | 'veredito' | 'responsavel' | 'prazo', string>>

/** Valida e monta o corpo do POST. O revisor e o tenant vêm do token — nunca daqui. */
export function corpoDoFormulario(avaliacaoId: string, f: FormularioRevisao): { ok: true; corpo: CorpoRevisao } | { ok: false; erros: ErrosFormulario } {
  const erros: ErrosFormulario = {}
  const faltam = CRITERIOS_RUBRICA.filter((c) => typeof f.notas[c] !== 'number')
  if (faltam.length > 0) erros.notas = `Dê nota a ${faltam.map((c) => ROTULO_CRITERIO[c]).join(', ')}.`
  if (f.gravidade === undefined) erros.gravidade = 'Escolha a gravidade que você viu (ou Nenhuma).'
  if (!f.veredito) erros.veredito = 'Escolha o veredito.'
  if (f.decisao !== 'nenhuma') {
    if (!f.responsavel.trim()) erros.responsavel = 'Quem cuida desta decisão?'
    if (!f.prazo || !semanaDaData(f.prazo)) erros.prazo = 'Informe o prazo.'
  }
  if (Object.keys(erros).length > 0) return { ok: false, erros }
  return {
    ok: true,
    corpo: {
      avaliacaoId,
      notas: Object.fromEntries(CRITERIOS_RUBRICA.map((c) => [c, f.notas[c]!])) as Record<CriterioRubrica, number>,
      gravidade: f.gravidade ?? null,
      veredito: f.veredito!,
      decisao: f.decisao,
      responsavel: f.decisao === 'nenhuma' ? null : f.responsavel.trim(),
      prazo: f.decisao === 'nenhuma' ? null : f.prazo,
      observacao: f.observacao.trim() || null,
    },
  }
}

/** O resultado da revisão gravada em uma linha (o que divergiu do juiz). */
export function resultadoDaRevisao(r: RevisaoDto): { rotulo: string; tom: Tom } {
  if (r.concorda === null) return { rotulo: 'Sem nota do juiz nesta conversa — a revisão não entra na concordância.', tom: 'neutro' }
  if (r.concorda) return { rotulo: 'Você concorda com o juiz e com as regras.', tom: 'sucesso' }
  const div = CRITERIOS_RUBRICA.filter((c) => r.porCriterio[c] === false).map((c) => ROTULO_CRITERIO[c])
  if (!r.concordaGravidade) div.push('gravidade')
  return { rotulo: `Diverge do juiz em: ${div.join(', ')}.`, tom: 'atencao' }
}

export function rotuloGravidade(g: GravidadeQualidade | null): string {
  return g === 'CRITICA' ? 'Crítica' : g === 'ALTA' ? 'Alta' : g === 'MEDIA' ? 'Média' : 'Nenhuma'
}

/** Erros nomeados das ações da revisão. */
export function mensagemDaFalhaRevisao(codigo: string, padrao: string): string {
  return ({
    'revisao.avaliacao_nao_encontrada': 'Esta avaliação não existe mais. Recarregue a amostra.',
    'revisao.campo_invalido': 'Confira os campos da revisão.',
    'canal.nao_encontrado': 'Este número não existe mais.',
    'acesso.papel_insuficiente': 'Só gestor ou administrador revisa. Peça a um administrador.',
  } as Record<string, string>)[codigo] ?? padrao
}
