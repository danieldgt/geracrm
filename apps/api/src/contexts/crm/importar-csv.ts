import { normalizarTelefone } from '@geracrm/shared'

/**
 * Parser + validação de CSV de contatos (importação). Puro — sem banco.
 *
 * ⚠️ A validação é NO SERVIDOR: o arquivo vem do usuário. Nome é obrigatório;
 * telefone e documento são opcionais mas, se vierem, têm de ser válidos (o
 * telefone é normalizado pela MESMA função do resto — INV-50).
 *
 * Auto-detecta o separador (`,` ou `;` — planilha BR costuma usar `;`) e mapeia
 * as colunas pelo cabeçalho, tolerante a acento/caixa.
 */

export interface LinhaContato {
  readonly nome: string
  readonly e164?: string
  readonly chaveBloqueio?: string
  readonly documento?: string
  readonly tipoDocumento?: 'cnpj' | 'cpf'
}

export interface RejeicaoLinha {
  readonly linha: number
  readonly motivo: string
}

export interface ResultadoParse {
  readonly linhas: readonly LinhaContato[]
  readonly rejeicoes: readonly RejeicaoLinha[]
}

/** Divide uma linha respeitando aspas duplas ("a, b" fica inteiro). */
function dividir(linha: string, sep: string): string[] {
  const campos: string[] = []
  let atual = ''
  let aspas = false
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i]!
    if (aspas) {
      if (ch === '"') {
        if (linha[i + 1] === '"') { atual += '"'; i++ } // aspas escapada ""
        else aspas = false
      } else atual += ch
    } else if (ch === '"') {
      aspas = true
    } else if (ch === sep) {
      campos.push(atual); atual = ''
    } else atual += ch
  }
  campos.push(atual)
  return campos.map((c) => c.trim())
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

/** Acha o índice da coluna cujo cabeçalho casa com um dos apelidos. */
function acharCol(cabecalho: string[], apelidos: string[]): number {
  return cabecalho.findIndex((h) => apelidos.includes(norm(h)))
}

export function parseCsvContatos(texto: string): ResultadoParse {
  const linhasBrutas = texto.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (linhasBrutas.length < 2) return { linhas: [], rejeicoes: [{ linha: 0, motivo: 'csv_sem_dados' }] }

  // Separador: o que aparecer mais no cabeçalho.
  const cab = linhasBrutas[0]!
  const sep = (cab.match(/;/g)?.length ?? 0) > (cab.match(/,/g)?.length ?? 0) ? ';' : ','
  const cabecalho = dividir(cab, sep)

  const iNome = acharCol(cabecalho, ['nome', 'name', 'razao social', 'razao', 'cliente'])
  const iTel = acharCol(cabecalho, ['telefone', 'celular', 'phone', 'whatsapp', 'fone', 'tel'])
  const iDoc = acharCol(cabecalho, ['documento', 'cnpj', 'cpf', 'cnpj/cpf', 'doc'])
  if (iNome < 0) return { linhas: [], rejeicoes: [{ linha: 1, motivo: 'sem_coluna_nome' }] }

  const linhas: LinhaContato[] = []
  const rejeicoes: RejeicaoLinha[] = []

  for (let i = 1; i < linhasBrutas.length; i++) {
    const campos = dividir(linhasBrutas[i]!, sep)
    const nome = (campos[iNome] ?? '').trim()
    if (!nome) { rejeicoes.push({ linha: i + 1, motivo: 'nome_vazio' }); continue }

    const linha: { -readonly [K in keyof LinhaContato]: LinhaContato[K] } = { nome }

    const telBruto = iTel >= 0 ? (campos[iTel] ?? '').trim() : ''
    if (telBruto) {
      const tel = normalizarTelefone(telBruto)
      if (!tel) { rejeicoes.push({ linha: i + 1, motivo: 'telefone_invalido' }); continue }
      linha.e164 = tel.e164
      linha.chaveBloqueio = tel.chaveBloqueio
    }

    const docBruto = iDoc >= 0 ? (campos[iDoc] ?? '').replace(/\D/g, '') : ''
    if (docBruto) {
      if (docBruto.length === 14) { linha.documento = docBruto; linha.tipoDocumento = 'cnpj' }
      else if (docBruto.length === 11) { linha.documento = docBruto; linha.tipoDocumento = 'cpf' }
      else { rejeicoes.push({ linha: i + 1, motivo: 'documento_invalido' }); continue }
    }

    linhas.push(linha)
  }

  return { linhas, rejeicoes }
}
