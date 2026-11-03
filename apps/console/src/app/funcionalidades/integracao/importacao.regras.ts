import {
  CAMPOS_IMPORTACAO, IMPORTACAO_MAX_BYTES, IMPORTACAO_MAX_LINHAS, camposObrigatoriosFaltando, limparDePara, parseCsv, sugerirDePara,
  type CampoImportacao, type DePara, type EstadoImportacao, type TipoImportacao,
} from '@geracrm/shared'
import type { OpcaoSelect } from '../../compartilhado/ui/index.js'

/**
 * Regras PURAS da tela "Importar dados" (raia H1): passos, de-para, motivos, "atualizado há X" e a leitura local do
 * arquivo. A API continua sendo a regra (revalida tudo); aqui é conveniência para a pessoa ver o problema antes de enviar.
 * O de-para sugerido e a conferência usam as MESMAS funções de `@geracrm/shared` que a API.
 */

export const PASSOS = [
  { id: 1, rotulo: 'Tipo' },
  { id: 2, rotulo: 'Arquivo' },
  { id: 3, rotulo: 'Colunas' },
  { id: 4, rotulo: 'Simulação' },
  { id: 5, rotulo: 'Execução' },
  { id: 6, rotulo: 'Conferência' },
] as const
export type PassoId = (typeof PASSOS)[number]['id']

export const CARTOES_TIPO: readonly { tipo: TipoImportacao; titulo: string; descricao: string }[] = [
  { tipo: 'contatos', titulo: 'Contatos', descricao: 'Clientes e leads: nome, telefone, documento, endereço, origem, etiquetas e vendedor.' },
  { tipo: 'vendas', titulo: 'Vendas históricas', descricao: 'Compras passadas por data e valor. Alimentam o RFV e a recompra.' },
  { tipo: 'tarefas', titulo: 'Tarefas', descricao: 'Follow-ups com vencimento, ligados ao contato e ao responsável.' },
]

export const ROTULO_TIPO: Readonly<Record<TipoImportacao, string>> = { contatos: 'Contatos', vendas: 'Vendas históricas', tarefas: 'Tarefas' }

export const ROTULO_ESTADO: Readonly<Record<EstadoImportacao, string>> = {
  simulada: 'Simulada', executando: 'Em execução', concluida: 'Concluída', falhou: 'Falhou', cancelada: 'Cancelada',
}
export type TomEstado = 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'
export const TOM_ESTADO: Readonly<Record<EstadoImportacao, TomEstado>> = {
  simulada: 'neutro', executando: 'info', concluida: 'sucesso', falhou: 'erro', cancelada: 'atencao',
}

/** Motivo-código da API → frase. Código desconhecido aparece como veio (nunca some). */
const MOTIVOS: Readonly<Record<string, string>> = {
  nome_vazio: 'Nome em branco', nome_muito_longo: 'Nome longo demais (máximo 200 caracteres)',
  telefone_vazio: 'Telefone em branco', telefone_invalido: 'Telefone inválido (use DDD + número)',
  documento_invalido: 'CPF/CNPJ inválido', email_invalido: 'E-mail inválido', cep_invalido: 'CEP inválido',
  uf_invalida: 'UF inválida', qualificacao_invalida: 'Qualificação não reconhecida (use novo, qualificado ou descartado)',
  criado_em_invalido: 'Data de criação inválida ou no futuro',
  contato_nao_informado: 'Sem telefone nem CPF/CNPJ do contato', contato_nao_encontrado: 'Contato não encontrado na base',
  data_invalida: 'Data inválida', data_futura: 'Data no futuro', valor_invalido: 'Valor inválido ou zerado',
  referencia_muito_longa: 'Referência longa demais (máximo 120 caracteres)',
  titulo_vazio: 'Título em branco', titulo_muito_longo: 'Título longo demais (máximo 200 caracteres)',
  vencimento_invalido: 'Data de vencimento inválida', tipo_invalido: 'Tipo de tarefa não reconhecido',
  duplicada_no_arquivo: 'Repetida no próprio arquivo', ja_existe: 'Já existe na base (nada a completar)',
  origem_inexistente: 'Origem não cadastrada (linha importada sem origem)',
  etiqueta_inexistente: 'Etiqueta não cadastrada (ignorada)', vendedor_inexistente: 'Vendedor não encontrado (sem carteira)',
  responsavel_inexistente: 'Responsável não encontrado (tarefa sem responsável)',
  data_fora_do_horizonte: 'Data fora do período que o banco comporta', conflito_de_duplicidade: 'Conflito de duplicidade',
  referencia_invalida: 'Referência inválida', texto_muito_longo: 'Texto longo demais', erro_gravacao: 'Erro ao gravar a linha',
  rejeitada: 'Linha rejeitada',
}
export const rotuloMotivo = (codigo: string | null | undefined): string => (codigo ? (MOTIVOS[codigo] ?? codigo) : '')

export const ROTULO_QUALIFICACAO: Readonly<Record<string, string>> = { novo: 'Novo', qualificado: 'Qualificado', descartado: 'Descartado' }

/** Colunas do arquivo como opções do select de de-para. */
export const opcoesDeColuna = (colunas: readonly string[]): OpcaoSelect[] => colunas.map((c) => ({ valor: c, rotulo: c }))

/** Rótulo do campo: obrigatórios levam asterisco no `ui-select` (`obrigatorio`). */
export const camposDoTipo = (tipo: TipoImportacao): readonly CampoImportacao[] => CAMPOS_IMPORTACAO[tipo]

export interface ArquivoLido {
  readonly colunas: readonly string[]
  readonly linhas: number
  readonly deParaSugerido: DePara
  /** Problema que impede de seguir (vazio = pode). */
  readonly problema: string | null
}

/** Lê o CSV no navegador só para mostrar colunas, contagem de linhas e a sugestão de de-para. */
export function lerArquivo(texto: string, tipo: TipoImportacao, bytes: number): ArquivoLido {
  if (bytes > IMPORTACAO_MAX_BYTES) {
    return { colunas: [], linhas: 0, deParaSugerido: {}, problema: 'O arquivo passa de 20 MB. Divida-o em partes.' }
  }
  const csv = parseCsv(texto)
  if (csv.colunas.length === 0 || csv.linhas.length === 0) {
    return { colunas: csv.colunas, linhas: 0, deParaSugerido: {}, problema: 'O arquivo não tem linhas de dados. A primeira linha deve ser o cabeçalho.' }
  }
  if (csv.linhas.length > IMPORTACAO_MAX_LINHAS) {
    return { colunas: csv.colunas, linhas: csv.linhas.length, deParaSugerido: {}, problema: `O arquivo tem ${csv.linhas.length} linhas; o máximo é ${IMPORTACAO_MAX_LINHAS}. Divida-o em partes.` }
  }
  return { colunas: csv.colunas, linhas: csv.linhas.length, deParaSugerido: sugerirDePara(tipo, csv.colunas), problema: null }
}

/** Troca a coluna de um campo; vazio desmapeia. Devolve novo objeto. */
export function mapearCampo(dePara: DePara, campo: string, coluna: string): DePara {
  const { [campo]: _antiga, ...resto } = dePara
  return coluna === '' ? resto : { ...resto, [campo]: coluna }
}

/** Frase para o que falta mapear (vazia = tudo certo). */
export function textoFaltando(tipo: TipoImportacao, dePara: DePara, colunas: readonly string[]): string {
  const limpo = limparDePara(tipo, dePara, colunas)
  const faltando = camposObrigatoriosFaltando(tipo, limpo)
  if (faltando.length === 0) return ''
  const nomes = faltando.map((k) => {
    if (k.includes('_ou_')) return k.split('_ou_').map((x) => rotuloCampo(tipo, x)).join(' ou ')
    return rotuloCampo(tipo, k)
  })
  return `Associe uma coluna a: ${nomes.join(', ')}.`
}

export function rotuloCampo(tipo: TipoImportacao, chave: string): string {
  return CAMPOS_IMPORTACAO[tipo].find((c) => c.chave === chave)?.rotulo.replace(/\s*\(.*\)$/, '') ?? chave
}

/** A coluna escolhida já serve a outro campo? (aviso, não bloqueio: o mesmo dado pode alimentar dois campos) */
export function colunaRepetida(dePara: DePara, campo: string): boolean {
  const c = dePara[campo]
  return !!c && Object.entries(dePara).some(([k, v]) => k !== campo && v === c)
}

/** "atualizado há X" em pt-BR, a partir do ISO do servidor. */
export function atualizadoHa(iso: string, agora: number): string {
  const seg = Math.max(0, Math.floor((agora - Date.parse(iso)) / 1000))
  if (!Number.isFinite(seg)) return ''
  if (seg < 5) return 'atualizado agora'
  if (seg < 60) return `atualizado há ${seg} s`
  const min = Math.floor(seg / 60)
  if (min < 60) return `atualizado há ${min} min`
  return `atualizado há ${Math.floor(min / 60)} h`
}

/** O polling de 3 s continua enquanto a importação roda. */
export const continuaPolling = (estado: EstadoImportacao): boolean => estado === 'executando' || estado === 'simulada'
export const INTERVALO_POLLING_MS = 3_000

/** Valor digitado na coluna "esperado": vazio ou inválido = sem esperado. */
export function esperadoDoTexto(texto: string): number | null {
  const t = texto.trim()
  if (!/^\d{1,9}$/.test(t)) return null
  return Number(t)
}

/** SHA-256 em hex de um arquivo (o MESMO que a API calcula sobre os bytes). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Hash curto para a tela ("a1b2c3d4…f9e8d7c6"). */
export const hashCurto = (h: string): string => (h.length > 20 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h)

/** Decodifica como a API: UTF-8; se vier lixo (U+FFFD), cai para latin1 (planilha salva no Windows). */
export function decodificar(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  return utf8.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(bytes) : utf8
}
