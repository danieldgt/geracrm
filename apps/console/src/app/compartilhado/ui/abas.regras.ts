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
