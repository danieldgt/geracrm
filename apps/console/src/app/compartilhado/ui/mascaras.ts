import { apenasDigitos } from '@geracrm/shared'

/**
 * Máscaras de exibição (puras). A regra de VALIDAÇÃO (dígito verificador)
 * fica em `@geracrm/shared` (`validarCpf`/`validarCnpj`); aqui só se formata.
 * Todas aceitam texto parcial, colado com pontuação ou vazio — nunca lançam.
 */
export type TipoMascara = 'cpf' | 'cnpj' | 'cpfCnpj' | 'telefone' | 'cep'

/** Só dígitos. Reuso direto de shared — uma regra só. */
export const soDigitos = apenasDigitos

/** Aplica um molde onde `0` é um dígito; corta o excedente e não deixa pontuação pendurada. */
function aplicarMolde(digitos: string, molde: string): string {
  let saida = ''
  let i = 0
  for (const c of molde) {
    if (i >= digitos.length) break
    if (c === '0') saida += digitos[i++]
    else saida += c
  }
  return saida
}

export function formatarCpf(bruto: string): string {
  return aplicarMolde(soDigitos(bruto).slice(0, 11), '000.000.000-00')
}

export function formatarCnpj(bruto: string): string {
  return aplicarMolde(soDigitos(bruto).slice(0, 14), '00.000.000/0000-00')
}

/** Até 11 dígitos é CPF; a partir do 12º vira CNPJ. */
export function formatarCpfCnpj(bruto: string): string {
  const d = soDigitos(bruto)
  return d.length > 11 ? formatarCnpj(d) : formatarCpf(d)
}

export function formatarCep(bruto: string): string {
  return aplicarMolde(soDigitos(bruto).slice(0, 8), '00000-000')
}

/**
 * Fixo (10 dígitos) e celular (11). Com DDI 55 (12 ou 13 dígitos) mostra "+55 ".
 * ⚠️ 55 também é DDD (RS): só tratamos como país quando já há 12+ dígitos; durante
 * a digitação de um número com DDD 55 a máscara não adivinha.
 */
export function formatarTelefone(bruto: string): string {
  let d = soDigitos(bruto)
  let prefixo = ''
  if (d.startsWith('55') && d.length >= 12) {
    prefixo = '+55 '
    d = d.slice(2, 13)
  } else {
    d = d.slice(0, 11)
  }
  if (!d) return ''
  const ddd = d.slice(0, 2)
  const resto = d.slice(2)
  if (!resto) return `${prefixo}(${ddd}`
  const corte = d.length === 11 ? 5 : 4
  const corpo = resto.length > corte ? `${resto.slice(0, corte)}-${resto.slice(corte)}` : resto
  return `${prefixo}(${ddd}) ${corpo}`
}

const FORMATADORES: Record<TipoMascara, (bruto: string) => string> = {
  cpf: formatarCpf, cnpj: formatarCnpj, cpfCnpj: formatarCpfCnpj, telefone: formatarTelefone, cep: formatarCep,
}

export function formatarMascara(tipo: TipoMascara, bruto: string): string {
  return FORMATADORES[tipo](bruto)
}

/** O que vai para o controle: só dígitos, já respeitando o limite do tipo. */
export function digitosDaMascara(tipo: TipoMascara, bruto: string): string {
  return soDigitos(formatarMascara(tipo, bruto))
}

/**
 * Onde fica o cursor depois de reformatar: conta os dígitos à esquerda do caret no
 * texto antigo (o que o usuário acabou de digitar/apagar/colar) e posiciona o caret
 * logo após esse mesmo número de dígitos no texto novo. Sem dígitos à esquerda → 0;
 * mais dígitos do que o novo texto comporta (corte do limite) → fim do texto.
 */
export function posicaoDoCursor(textoAntigo: string, caretAntigo: number, textoNovo: string): number {
  const alvo = soDigitos(textoAntigo.slice(0, Math.max(0, caretAntigo))).length
  if (alvo === 0) return 0
  let vistos = 0
  for (let i = 0; i < textoNovo.length; i++) {
    if (/\d/.test(textoNovo[i]!)) vistos += 1
    if (vistos === alvo) return i + 1
  }
  return textoNovo.length
}

/** O mínimo de um `<input>` que a máscara precisa — mantém este arquivo livre de DOM. */
export interface ElementoDeTexto {
  value: string
  selectionStart: number | null
  setSelectionRange(inicio: number, fim: number): void
}

/**
 * Escreve o valor formatado DIRETO no elemento (o binding `[value]` não reescreve quando o
 * signal não muda — ex.: digitar "a" num CPF completo deixaria "123a" na tela) e preserva o
 * cursor. `focado` evita mexer em seleção de elemento sem foco. Devolve o texto formatado.
 */
export function aplicarMascaraNoElemento(el: ElementoDeTexto, tipo: TipoMascara, focado: boolean): string {
  const antigo = el.value
  const caret = el.selectionStart ?? antigo.length
  const novo = formatarMascara(tipo, antigo)
  if (novo !== antigo) el.value = novo
  if (focado) {
    const pos = posicaoDoCursor(antigo, caret, novo)
    el.setSelectionRange(pos, pos)
  }
  return novo
}
