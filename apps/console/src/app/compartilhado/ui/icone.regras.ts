import { ICONES } from './icones-lucide.js'

/**
 * Regras do ícone, sem Angular: testáveis em node, sem TestBed.
 * Mesmo padrão de `modelos-ia.regras.ts` — o componente só cola a regra no template.
 */

/** Desenho de reserva para nome desconhecido: um círculo, visível mas inofensivo. */
const DESENHO_DESCONHECIDO = '<circle cx="12" cy="12" r="10"/>'

/** Avisa uma vez por nome, para não afogar o console quando o mesmo nome se repete. */
const jaAvisados = new Set<string>()

/**
 * Marcação interna do ícone + se o nome existe. Nome desconhecido vira círculo e
 * avisa uma vez no console.
 *
 * ⚠️ `Object.hasOwn`, não `ICONES[nome]`: sem isso, um nome como `constructor`
 * ou `toString` acharia a propriedade herdada do objeto e devolveria uma função.
 */
export function marcacaoDoIcone(nome: string): { markup: string; conhecido: boolean } {
  const markup = Object.hasOwn(ICONES, nome) ? ICONES[nome] : undefined
  if (markup !== undefined) return { markup, conhecido: true }
  if (!jaAvisados.has(nome)) {
    jaAvisados.add(nome)
    console.warn(`[ui-icone] ícone desconhecido: "${nome}"`)
  }
  return { markup: DESENHO_DESCONHECIDO, conhecido: false }
}

/**
 * Acessibilidade do ícone: decorativo (sem rótulo) é escondido do leitor de tela;
 * com rótulo ele vira uma imagem nomeada. Nunca os dois ao mesmo tempo.
 */
export function atributosDeAcessibilidade(rotulo: string | undefined): {
  'aria-hidden': 'true' | null
  role: 'img' | null
  'aria-label': string | null
} {
  if (rotulo) return { 'aria-hidden': null, role: 'img', 'aria-label': rotulo }
  return { 'aria-hidden': 'true', role: null, 'aria-label': null }
}
