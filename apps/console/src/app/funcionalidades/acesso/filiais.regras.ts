/** Regras puras da tela de Filiais (D3.4). */

export const TIPOS_FILIAL = ['matriz', 'filial'] as const
export type TipoFilial = (typeof TIPOS_FILIAL)[number]
export const ROTULO_TIPO: Record<TipoFilial, string> = { matriz: 'Matriz', filial: 'Filial' }

export interface FilialLista {
  readonly id: string
  readonly nome: string
  readonly cidade: string | null
  readonly uf: string | null
  readonly tipo: TipoFilial
  readonly cor: string | null
  readonly ativa: boolean
  readonly usuarios: number
}

export type CampoFilial = 'nome' | 'tipo' | 'cor' | 'uf' | 'ativa'
export interface ErroFilial { readonly campo: CampoFilial | null; readonly mensagem: string }

const ERROS: Record<string, ErroFilial> = {
  'filial.nome_obrigatorio': { campo: 'nome', mensagem: 'Informe o nome da filial.' },
  'filial.tipo_invalido': { campo: 'tipo', mensagem: 'Tipo inválido.' },
  'filial.cor_invalida': { campo: 'cor', mensagem: 'Cor inválida.' },
  'filial.uf_invalida': { campo: 'uf', mensagem: 'UF inválida.' },
  'filial.ativa_invalida': { campo: 'ativa', mensagem: 'Situação inválida.' },
  'filial.matriz_duplicada': { campo: 'tipo', mensagem: 'Já existe uma matriz. Só pode haver uma; torne a outra filial antes.' },
  'filial.nada_a_mudar': { campo: null, mensagem: 'Nada foi alterado.' },
}

export function mapearErroFilial(codigo: string | null): ErroFilial | null {
  return codigo ? (ERROS[codigo] ?? null) : null
}

export function ehTipo(v: string): v is TipoFilial { return (TIPOS_FILIAL as readonly string[]).includes(v) }

export function erroDoNomeFilial(n: string): string | null { return n.trim() ? null : 'Informe o nome.' }

/** "Fortaleza/CE", "Fortaleza", "CE" ou "—". */
export function localDaFilial(f: { cidade: string | null; uf: string | null }): string {
  if (f.cidade && f.uf) return `${f.cidade}/${f.uf}`
  return f.cidade ?? f.uf ?? '—'
}

export interface FormFilial { nome: string; cidade: string; uf: string; tipo: string; cor: string; ativa: boolean }

/** Payload: texto vazio vira `null`; `cor` é a chave da paleta, convertida para #RRGGBB só aqui. */
export function montarPayloadFilial(
  f: FormFilial, hexDaCor: (chave: string) => string | null,
): { nome: string; cidade: string | null; uf: string | null; tipo: TipoFilial; cor: string | null; ativa: boolean } {
  const cidade = f.cidade.trim()
  return {
    nome: f.nome.trim(),
    cidade: cidade || null,
    uf: f.uf || null,
    tipo: ehTipo(f.tipo) ? f.tipo : 'filial',
    cor: f.cor ? hexDaCor(f.cor) : null,
    ativa: f.ativa,
  }
}
