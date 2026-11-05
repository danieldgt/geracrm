export interface Aba { readonly id: string; readonly rotulo: string; readonly icone?: string; readonly contador?: number; readonly rota?: string }

/**
 * Aba ativa: com `rota` na aba, vale a URL atual (a mais específica que casa);
 * senão vale o `ativa` explícito; senão a primeira.
 */
export function abaAtiva(abas: readonly Aba[], ativa: string, url: string): string {
  const caminho = url.split(/[?#]/)[0] ?? ''
  const porRota = abas
    .filter((a) => a.rota && (caminho === a.rota || caminho.startsWith(a.rota.replace(/\/$/, '') + '/')))
    .sort((a, b) => (b.rota?.length ?? 0) - (a.rota?.length ?? 0))[0]
  if (porRota) return porRota.id
  if (abas.some((a) => a.id === ativa)) return ativa
  return abas[0]?.id ?? ''
}

/** Navegação por setas (circular), Home e End. Devolve null para outras teclas. */
export function proximaAba(abas: readonly Aba[], atualId: string, tecla: string): string | null {
  if (abas.length === 0) return null
  const i = Math.max(0, abas.findIndex((a) => a.id === atualId))
  if (tecla === 'ArrowRight') return abas[(i + 1) % abas.length]!.id
  if (tecla === 'ArrowLeft') return abas[(i - 1 + abas.length) % abas.length]!.id
  if (tecla === 'Home') return abas[0]!.id
  if (tecla === 'End') return abas[abas.length - 1]!.id
  return null
}

/** Id da aba que tem o foco, lido do elemento focado (ou de um filho dele); null fora das abas. */
export function abaFocada(alvo: { closest(seletor: string): { getAttribute(nome: string): string | null } | null } | null): string | null {
  return alvo?.closest('[data-aba]')?.getAttribute('data-aba') ?? null
}

/** Seletor de atributo para a aba, com o id escapado (id vem de dado: aspas e barras não quebram a busca). */
export function seletorDaAba(id: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS
  const escapado = css?.escape ? css.escape(id) : id.replace(/["\\]/g, '\\$&')
  return `[data-aba="${escapado}"]`
}

/** Id do elemento da aba quando a tela usa painel (`aria-labelledby` do tabpanel aponta para ele). */
export const idDaAba = (idPainel: string, abaId: string): string => `${idPainel}-aba-${abaId}`
