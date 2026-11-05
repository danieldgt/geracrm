import {
  apenasDigitos, dividirEtiquetas, ehTipoTarefa, normalizarCabecalho, normalizarTelefone, parseDataHora, parseQualificacao,
  parseSimNao, reaisParaCentavos, validarCnpj, validarCpf, type DePara, type TelefoneNormalizado, type TipoTarefa,
} from '@geracrm/shared'

/**
 * Leitura de UMA linha do arquivo importado (raia H1). Puro — sem banco. Devolve o dado já normalizado ou o
 * MOTIVO da rejeição.
 *
 * ⚠️ O motivo é um CÓDIGO (`telefone_invalido`), nunca o valor da célula: ele vai para `importacao_item.motivo`
 *    e para o relatório que o gestor baixa — dado pessoal não pode sair por ali.
 * ⚠️ Aviso ≠ rejeição: referência que não resolve (origem, etiqueta, vendedor) importa a linha e fica como aviso.
 */

export type Lido<T> = { readonly ok: true; readonly dado: T } | { readonly ok: false; readonly motivo: string }

/** Acesso às células pelo de-para (campo → nome da coluna) e pelas colunas do arquivo. */
export class LinhaCsv {
  private readonly indices = new Map<string, number>()
  constructor(colunas: readonly string[], dePara: DePara, private readonly campos: readonly string[]) {
    for (const [campo, coluna] of Object.entries(dePara)) {
      const i = colunas.indexOf(coluna)
      if (i >= 0) this.indices.set(campo, i)
    }
  }
  /** Texto da célula, aparado; vazio vira `undefined`. */
  v(campo: string): string | undefined {
    const i = this.indices.get(campo)
    const t = i === undefined ? '' : (this.campos[i] ?? '').trim()
    return t === '' ? undefined : t
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UF = /^[A-Z]{2}$/

function documentoDe(bruto: string | undefined): { documento: string | null; tipo: 'cnpj' | 'cpf' | null } | 'invalido' {
  if (!bruto) return { documento: null, tipo: null }
  const d = apenasDigitos(bruto)
  if (d.length === 14 && validarCnpj(d)) return { documento: d, tipo: 'cnpj' }
  if (d.length === 11 && validarCpf(d)) return { documento: d, tipo: 'cpf' }
  return 'invalido'
}

// ---------------------------------------------------------------------------
// Contatos
// ---------------------------------------------------------------------------

export interface ContatoLido {
  readonly nome: string
  readonly telefone: TelefoneNormalizado
  readonly whatsapp: boolean | null
  readonly email: string | null
  readonly razaoSocial: string | null
  readonly nomeFantasia: string | null
  readonly documento: string | null
  readonly endereco: {
    readonly cep: string | null; readonly logradouro: string | null; readonly numero: string | null
    readonly complemento: string | null; readonly bairro: string | null; readonly cidade: string | null; readonly uf: string | null
  }
  readonly origem: string | null
  readonly etiquetas: readonly string[]
  readonly vendedorEmail: string | null
  readonly qualificacao: 'novo' | 'qualificado' | 'descartado' | null
  readonly observacoes: string | null
  readonly criadoEm: Date | null
}

export function lerContato(l: LinhaCsv, agora: Date): Lido<ContatoLido> {
  const nome = l.v('nome')
  if (!nome) return { ok: false, motivo: 'nome_vazio' }
  if (nome.length > 200) return { ok: false, motivo: 'nome_muito_longo' }
  const telBruto = l.v('telefone')
  if (!telBruto) return { ok: false, motivo: 'telefone_vazio' }
  const telefone = normalizarTelefone(telBruto)
  if (!telefone) return { ok: false, motivo: 'telefone_invalido' }

  const doc = documentoDe(l.v('documento'))
  if (doc === 'invalido') return { ok: false, motivo: 'documento_invalido' }

  const email = l.v('email')
  if (email && (email.length > 200 || !EMAIL.test(email))) return { ok: false, motivo: 'email_invalido' }

  const cepBruto = l.v('cep')
  const cep = cepBruto ? apenasDigitos(cepBruto) : null
  if (cep !== null && cep.length !== 8) return { ok: false, motivo: 'cep_invalido' }
  const ufBruta = l.v('uf')?.toUpperCase() ?? null
  if (ufBruta !== null && !UF.test(ufBruta)) return { ok: false, motivo: 'uf_invalida' }

  const qualBruta = l.v('qualificacao')
  const qualificacao = qualBruta === undefined ? null : (parseQualificacao(qualBruta) ?? 'invalida')
  if (qualificacao === 'invalida') return { ok: false, motivo: 'qualificacao_invalida' }

  const criadoBruto = l.v('criado_em')
  let criadoEm: Date | null = null
  if (criadoBruto) {
    criadoEm = parseDataHora(criadoBruto)
    if (!criadoEm || criadoEm.getTime() > agora.getTime()) return { ok: false, motivo: 'criado_em_invalido' }
  }

  const waBruto = l.v('whatsapp')
  // Vazio ou ilegível = NÃO informado (null); nunca vira "tem WhatsApp" por omissão.
  const whatsapp = waBruto === undefined ? null : parseSimNao(waBruto)
  const limitado = (c: string, max: number) => { const t = l.v(c); return t ? t.slice(0, max) : null }

  return {
    ok: true,
    dado: {
      nome, telefone, whatsapp, email: email ?? null,
      razaoSocial: limitado('razao_social', 200), nomeFantasia: limitado('nome_fantasia', 200),
      documento: doc.documento,
      endereco: {
        cep, logradouro: limitado('logradouro', 200), numero: limitado('numero', 20), complemento: limitado('complemento', 100),
        bairro: limitado('bairro', 100), cidade: limitado('cidade', 100), uf: ufBruta,
      },
      origem: limitado('origem', 60),
      etiquetas: dividirEtiquetas(l.v('etiquetas') ?? ''),
      vendedorEmail: l.v('vendedor')?.toLowerCase() ?? null,
      qualificacao, observacoes: limitado('observacoes', 5000), criadoEm,
    },
  }
}

// ---------------------------------------------------------------------------
// Identificação do contato (vendas e tarefas)
// ---------------------------------------------------------------------------

export interface ChaveContato {
  readonly chaveBloqueio: string | null
  readonly documento: string | null
}

/** Telefone/documento da linha. `null` quando a linha não traz nenhum dos dois; `invalida` quando traz e não presta. */
function lerChaveContato(l: LinhaCsv): Lido<ChaveContato | null> {
  const telBruto = l.v('telefone')
  const docBruto = l.v('documento')
  let chaveBloqueio: string | null = null
  if (telBruto) {
    const t = normalizarTelefone(telBruto)
    if (!t) return { ok: false, motivo: 'telefone_invalido' }
    chaveBloqueio = t.chaveBloqueio
  }
  const doc = documentoDe(docBruto)
  if (doc === 'invalido') return { ok: false, motivo: 'documento_invalido' }
  if (!chaveBloqueio && !doc.documento) return { ok: true, dado: null }
  return { ok: true, dado: { chaveBloqueio, documento: doc.documento } }
}

// ---------------------------------------------------------------------------
// Vendas históricas
// ---------------------------------------------------------------------------

export interface VendaLida {
  readonly contato: ChaveContato
  readonly ocorridaEm: Date
  readonly valorCentavos: number
  readonly referencia: string | null
  readonly descricao: string | null
}

export function lerVenda(l: LinhaCsv, agora: Date): Lido<VendaLida> {
  const chave = lerChaveContato(l)
  if (!chave.ok) return chave
  if (!chave.dado) return { ok: false, motivo: 'contato_nao_informado' }
  const dataBruta = l.v('data')
  const ocorridaEm = dataBruta ? parseDataHora(dataBruta) : null
  if (!ocorridaEm) return { ok: false, motivo: 'data_invalida' }
  if (ocorridaEm.getTime() > agora.getTime()) return { ok: false, motivo: 'data_futura' }
  const valorBruto = l.v('valor')
  const valorCentavos = valorBruto ? reaisParaCentavos(valorBruto) : null
  if (valorCentavos === null || valorCentavos <= 0) return { ok: false, motivo: 'valor_invalido' }
  const referencia = l.v('referencia')
  if (referencia && referencia.length > 120) return { ok: false, motivo: 'referencia_muito_longa' }
  return { ok: true, dado: { contato: chave.dado, ocorridaEm, valorCentavos, referencia: referencia ?? null, descricao: l.v('descricao')?.slice(0, 500) ?? null } }
}

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------

export interface TarefaLida {
  readonly contato: ChaveContato | null
  readonly titulo: string
  readonly tipo: TipoTarefa
  readonly venceEm: Date
  readonly responsavelEmail: string | null
  readonly descricao: string | null
}

const SINONIMOS_TIPO: Readonly<Record<string, TipoTarefa>> = {
  ligacao: 'ligacao', ligar: 'ligacao', telefone: 'ligacao', whatsapp: 'whatsapp', zap: 'whatsapp', reuniao: 'reuniao',
  'e mail': 'email', email: 'email', visita: 'visita', outro: 'outro',
}

export function lerTarefa(l: LinhaCsv): Lido<TarefaLida> {
  const titulo = l.v('titulo')
  if (!titulo) return { ok: false, motivo: 'titulo_vazio' }
  if (titulo.length > 200) return { ok: false, motivo: 'titulo_muito_longo' }
  const chave = lerChaveContato(l)
  if (!chave.ok) return chave
  const vBruto = l.v('vence_em')
  const venceEm = vBruto ? parseDataHora(vBruto, 9) : null
  if (!venceEm) return { ok: false, motivo: 'vencimento_invalido' }
  const tBruto = l.v('tipo')
  let tipo: TipoTarefa = 'outro'
  if (tBruto) {
    const t = SINONIMOS_TIPO[normalizarCabecalho(tBruto)]
    if (!t || !ehTipoTarefa(t)) return { ok: false, motivo: 'tipo_invalido' }
    tipo = t
  }
  return {
    ok: true,
    dado: { contato: chave.dado, titulo, tipo, venceEm, responsavelEmail: l.v('responsavel')?.toLowerCase() ?? null, descricao: l.v('descricao')?.slice(0, 5000) ?? null },
  }
}
