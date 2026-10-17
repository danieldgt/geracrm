import {
  LIMITES_PLAYBOOK, SLOTS_QUALIFICACAO,
  type ConteudoPlaybook, type ErroCampoPlaybook, type GravidadeGuardrail, type ItemQualificacao, type SlotQualificacao,
} from '@geracrm/shared'

/**
 * Regras PURAS da aba Playbook (P17) — sem Angular, testadas em `playbook.regras.spec.ts`.
 */

/** "17/10/2026" — curto, sem hora: a barra de versão diz o dia. */
export function dataCurta(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

/** A frase da barra de versão do escopo. */
export function textoDaBarra(p: {
  escopo: 'numero' | 'tenant'
  publicada: { numero: number | null; publicadaEm: string | null; publicadaPor: string | null } | null
  vigente: { escopo: 'numero' | 'tenant'; numero: number | null } | null
  importavel: boolean
}): string {
  if (p.publicada?.numero) {
    return `Publicada v${p.publicada.numero} em ${dataCurta(p.publicada.publicadaEm)}${p.publicada.publicadaPor ? ` por ${p.publicada.publicadaPor}` : ''}`
  }
  if (p.escopo === 'numero' && p.vigente?.escopo === 'tenant') {
    return `Este número não tem playbook próprio: vale o padrão da conta (v${p.vigente.numero ?? '?'}).`
  }
  if (p.importavel) return 'Sem playbook neste número — o agente segue a configuração atual.'
  return p.escopo === 'tenant' ? 'A conta ainda não tem playbook padrão publicado.' : 'Nenhuma versão publicada ainda.'
}

export const MIN_OBSERVACAO = LIMITES_PLAYBOOK.observacaoMin

/** Observação de publicação/restauração: obrigatória, ≥ 10 caracteres. null = ok. */
export function erroDaObservacao(t: string): string | null {
  const n = t.trim().length
  if (n < MIN_OBSERVACAO) return `Explique o que mudou em ao menos ${MIN_OBSERVACAO} caracteres (faltam ${MIN_OBSERVACAO - n}).`
  if (n > LIMITES_PLAYBOOK.observacaoMax) return `No máximo ${LIMITES_PLAYBOOK.observacaoMax} caracteres.`
  return null
}

/** Erros 422 por campo: `{ 'mensagens.handoff': 'frase' }`. O campo raiz junta o que não tem lugar na tela. */
export function errosPorCampo(erros: readonly ErroCampoPlaybook[]): Readonly<Record<string, string>> {
  const m: Record<string, string> = {}
  for (const e of erros) if (!m[e.campo]) m[e.campo] = e.mensagem
  return m
}

/** Erros que começam com o prefixo (ex.: `qualificacao[2]`) — para mostrar junto do item. */
export function erroDoPrefixo(erros: Readonly<Record<string, string>>, prefixo: string): string | null {
  for (const [k, v] of Object.entries(erros)) if (k === prefixo || k.startsWith(`${prefixo}.`) || k.startsWith(`${prefixo}[`)) return v
  return null
}

/** Move um item da lista (setas do roteiro). Fora dos limites devolve a mesma lista. */
export function moverItem<T>(lista: readonly T[], i: number, delta: -1 | 1): readonly T[] {
  const j = i + delta
  if (i < 0 || i >= lista.length || j < 0 || j >= lista.length) return lista
  const c = [...lista]
  const [x] = c.splice(i, 1)
  c.splice(j, 0, x!)
  return c
}

/** Slots que ainda não estão no roteiro (para "Adicionar pergunta"). */
export function slotsLivres(q: readonly ItemQualificacao[]): readonly SlotQualificacao[] {
  const usados = new Set(q.map((x) => x.slot))
  return SLOTS_QUALIFICACAO.filter((s) => !usados.has(s))
}

export const ROTULO_SLOT: Readonly<Record<SlotQualificacao, string>> = {
  tipoCompra: 'Revenda ou uso próprio', cidade: 'Cidade', volume: 'Volume', prazo: 'Prazo', orcamento: 'Orçamento',
  necessidade: 'Necessidade', cnpj: 'CNPJ',
}

/** Chips: acrescenta sem duplicar (sem acento/caixa) e respeitando o teto. */
export function adicionarChip(lista: readonly string[], valor: string, max: number): { lista: readonly string[]; erro: string | null } {
  const v = valor.replace(/\s+/g, ' ').trim()
  if (v.length < 3) return { lista, erro: 'Use ao menos 3 caracteres.' }
  if (v.length > 80) return { lista, erro: 'Use no máximo 80 caracteres.' }
  const chave = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  if (lista.some((x) => chave(x) === chave(v))) return { lista, erro: 'Já está na lista.' }
  if (lista.length >= max) return { lista, erro: `No máximo ${max} itens.` }
  return { lista: [...lista, v], erro: null }
}

/** O rascunho editado é diferente do salvo? (indicador de alterações não salvas) */
export function temAlteracao(editado: ConteudoPlaybook | null, salvo: ConteudoPlaybook | null): boolean {
  if (!editado || !salvo) return false
  return JSON.stringify(editado) !== JSON.stringify(salvo)
}

/** Número de 120–1000 ou vazio (= sem limite). */
export function numeroOuNulo(bruto: string): number | null {
  const t = bruto.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

export function tomDaGravidade(g: GravidadeGuardrail | string): 'erro' | 'atencao' | 'info' | 'neutro' {
  return g === 'CRITICA' ? 'erro' : g === 'ALTA' ? 'atencao' : g === 'MEDIA' ? 'info' : 'neutro'
}

/** Erro HTTP da aba → frase nomeada. 403 e 409 têm texto próprio; 422 usa a mensagem do servidor. */
export function textoDeFalha(status: number, mensagem: string | undefined, contexto = 'alterar o playbook'): string {
  if (status === 403) return 'Só um administrador pode alterar o playbook.'
  if (status === 0) return 'Sem conexão com o servidor. Confira a internet e tente de novo.'
  if (mensagem) return mensagem
  return `Não foi possível ${contexto} agora. Tente de novo.`
}

/** Erros do sandbox com ação corretiva. */
export function textoDaSimulacao(status: number, erro: string | undefined, mensagem: string | undefined): { texto: string; reiniciar: boolean } {
  if (erro === 'agente.simulacao_em_andamento') return { texto: 'Já há uma simulação rodando nesta conta. Espere alguns segundos e envie de novo.', reiniciar: false }
  if (erro === 'agente.simulacao_limite') return { texto: mensagem ?? 'A conversa de teste chegou ao limite de mensagens. Reinicie para continuar.', reiniciar: true }
  if (erro === 'playbook.sem_rascunho') return { texto: 'Não há rascunho para testar. Clique em Editar para abrir um.', reiniciar: false }
  if (status === 403) return { texto: 'Sem acesso ao playground. Peça a um administrador.', reiniciar: false }
  return { texto: mensagem ?? 'Não foi possível simular agora.', reiniciar: false }
}
