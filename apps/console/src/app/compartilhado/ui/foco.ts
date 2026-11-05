/**
 * Lógica pura de foco para diálogos (modal). Sem Angular: testável em jsdom.
 * O `ui-modal` usa estas funções; o `ui-confirmar` mantém a sua própria cola.
 */
export const SELETOR_FOCAVEL =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Elementos focáveis dentro do contêiner, na ordem do DOM. */
export function focaveisDe(raiz: ParentNode): HTMLElement[] {
  return Array.from(raiz.querySelectorAll<HTMLElement>(SELETOR_FOCAVEL))
    .filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true')
}

/** Primeiro CAMPO de formulário; na falta, o primeiro focável; na falta, null. */
export function primeiroAlvoDeFoco(raiz: ParentNode): HTMLElement | null {
  const campo = raiz.querySelector<HTMLElement>(
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
  )
  return campo ?? focaveisDe(raiz)[0] ?? null
}

/**
 * Tab/Shift+Tab preso no contêiner: no último vai ao primeiro, e vice-versa.
 * Devolve true quando tratou o evento (o chamador chama preventDefault).
 */
export function prenderTab(raiz: HTMLElement, tecla: { key: string; shiftKey: boolean }, ativo: Element | null): boolean {
  if (tecla.key !== 'Tab') return false
  const lista = focaveisDe(raiz)
  if (lista.length === 0) { raiz.focus(); return true }
  const primeiro = lista[0]!
  const ultimo = lista[lista.length - 1]!
  const fora = !ativo || !raiz.contains(ativo) || ativo === raiz
  if (tecla.shiftKey && (fora || ativo === primeiro)) { ultimo.focus(); return true }
  if (!tecla.shiftKey && (fora || ativo === ultimo)) { primeiro.focus(); return true }
  return false
}

/** Devolve o foco a quem o tinha antes de abrir (se ainda estiver no documento). */
export function devolverFoco(anterior: Element | null): void {
  if (anterior instanceof HTMLElement && anterior.isConnected) anterior.focus()
}

/**
 * Leva o foco ao PRIMEIRO campo com erro (`aria-invalid="true"`) dentro do contêiner — o que a
 * regra de formulário pede depois de um 422. Espera o próximo quadro, para o `[erro]` já ter
 * virado atributo no DOM. Sem campo inválido, não mexe no foco.
 */
export function focarPrimeiroInvalido(raiz: ParentNode | null = typeof document === 'undefined' ? null : document): void {
  if (!raiz) return
  const agendar = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 0)
  agendar(() => {
    const dialogo = (raiz as Element).querySelector?.('[role="dialog"]') ?? null
    const alvo = (dialogo ?? raiz).querySelector?.<HTMLElement>('[aria-invalid="true"]')
    alvo?.focus()
  })
}
