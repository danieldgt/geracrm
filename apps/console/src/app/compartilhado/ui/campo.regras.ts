import { centavosParaReais, reaisParaCentavos } from './dinheiro.js'

/** Regras puras dos controles de formulário (ids, ARIA, dinheiro) — testadas sem DOM. */

let contador = 0
/** Id estável por instância, usado em for/id e aria-describedby. */
export function proximoIdCampo(prefixo = 'ui-campo'): string {
  contador += 1
  return `${prefixo}-${contador}`
}

export interface EntradaAria { id: string; erro: string | null; dica: string; obrigatorio: boolean }
export interface SaidaAria {
  ariaInvalid: 'true' | null
  ariaRequired: 'true' | null
  /** Erro vem antes da dica; null quando não há nenhuma. */
  ariaDescribedBy: string | null
}
export const idErro = (id: string): string => `${id}-erro`
export const idDica = (id: string): string => `${id}-dica`

export function atributosAria(e: EntradaAria): SaidaAria {
  const ids = [e.erro ? idErro(e.id) : null, e.dica ? idDica(e.id) : null].filter((x): x is string => x !== null)
  return {
    ariaInvalid: e.erro ? 'true' : null,
    ariaRequired: e.obrigatorio ? 'true' : null,
    ariaDescribedBy: ids.length ? ids.join(' ') : null,
  }
}

/** 123456 → "1.234,56" (exibição dentro do campo, sem R$). */
export function centavosParaTexto(centavos: number | null | undefined): string {
  const t = centavosParaReais(centavos)
  if (!t) return ''
  const [inteira = '0', dec = '00'] = t.split(',')
  const sinal = inteira.startsWith('-') ? '-' : ''
  const milhar = inteira.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${sinal}${milhar},${dec}`
}

export type TipoCampo =
  | 'text' | 'email' | 'tel' | 'number' | 'password' | 'search'
  | 'date' | 'time' | 'datetime-local' | 'textarea' | 'dinheiro'

/** Texto digitado → valor do controle (centavos, número ou texto). */
export function valorDoControle(tipo: TipoCampo, texto: string): string | number | null {
  if (tipo === 'dinheiro') return reaisParaCentavos(texto)
  if (tipo === 'number') {
    if (texto.trim() === '') return null
    const n = Number(texto)
    return Number.isFinite(n) ? n : null
  }
  return texto
}

/** Valor do controle → texto exibido. */
export function textoDoValor(tipo: TipoCampo, valor: unknown): string {
  if (valor === null || valor === undefined) return ''
  if (tipo === 'dinheiro') return typeof valor === 'number' ? centavosParaTexto(valor) : ''
  return String(valor)
}

/** Estilos comuns de rótulo/dica/erro/controle, só tokens (tamanho vem das classes .txt-* no template) — usado por campo, select e select-paginado. */
export const ESTILOS_CONTROLE = `
  :host { display: block; min-width: 0; }
  :host(.largo) { grid-column: 1 / -1; }
  .campo { display: flex; flex-direction: column; gap: var(--espacamento-1); }
  .rotulo { font-weight: 500; color: var(--texto); }
  .obrigatorio { color: var(--erro); margin-left: 2px; }
  .linha { display: flex; gap: var(--espacamento-2); align-items: stretch; }
  .linha > .controle { flex: 1; min-width: 0; }
  .controle {
    min-height: var(--densidade-alvo-clique-console);
    padding: var(--espacamento-2) var(--espacamento-3);
    border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
    background: var(--fundo); color: var(--texto); font: inherit; width: 100%; box-sizing: border-box;
  }
  textarea.controle { resize: vertical; min-height: 88px; }
  .controle::placeholder { color: var(--texto-secundario); }
  .controle:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
  .controle[aria-invalid='true'] { border-color: var(--borda-erro); }
  .controle:disabled { opacity: .6; }
  .dica { color: var(--texto-secundario); }
  .msg-erro { color: var(--erro); }
`
