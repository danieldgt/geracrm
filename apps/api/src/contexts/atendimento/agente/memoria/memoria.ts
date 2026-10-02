import { randomUUID } from 'node:crypto'
import type { Sql } from '../../../../db/index.js'

/**
 * MEMÓRIA DE LONGO PRAZO DO CLIENTE — `cliente_memoria` (0090).
 *
 * O que o agente aprende hoje e vale amanhã: preferência, objeção, contexto
 * de compra, restrição. Um fato por linha, curto, contestável e revogável.
 *
 * ⚠️ A REGRA QUE NÃO ADMITE EXCEÇÃO: nunca PII sensível. CPF, CNPJ, telefone,
 *    e-mail, CEP e endereço são recusados AQUI, por padrão de texto, antes de
 *    qualquer INSERT — o modelo não tem como gravar documento do cliente nem
 *    "sem querer". Cadastro é `contato`; memória é venda.
 *
 * Deduplicação pelo texto normalizado, garantida pelo índice único parcial da
 * tabela — dois turnos anotando o mesmo fato ao mesmo tempo não geram duas
 * linhas.
 */

export const TIPOS_MEMORIA = ['preferencia', 'objecao', 'contexto', 'restricao'] as const
export type TipoMemoria = (typeof TIPOS_MEMORIA)[number]

export const MAX_FATO = 300
const LIMITE_LEITURA_PADRAO = 12
const LIMITE_LEITURA_MAX = 50

export type PadraoSensivel = 'cnpj' | 'cpf' | 'telefone' | 'cep' | 'email' | 'endereco' | 'numero_longo'

/**
 * Padrões de dado sensível, do mais específico ao mais genérico. O último é a
 * rede: qualquer sequência de 10+ dígitos (com ou sem separadores) é documento
 * ou telefone até prova em contrário — e memória não precisa de número longo.
 */
const PADROES: readonly { readonly nome: PadraoSensivel; readonly regex: RegExp }[] = [
  { nome: 'cnpj', regex: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/ },
  { nome: 'cpf', regex: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/ },
  { nome: 'telefone', regex: /(?:\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/ },
  { nome: 'cep', regex: /\b\d{5}-?\d{3}\b/ },
  { nome: 'email', regex: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  // Logradouro seguido de número a até 60 caracteres: "mora na Rua das Flores, 123".
  { nome: 'endereco', regex: /\b(?:rua|r\.|avenida|av\.?|travessa|tv\.|alameda|al\.|rodovia|rod\.|estrada|pra[çc]a|largo|quadra|lote|cond(?:om[ií]nio)?\.?)\b[^\n]{0,60}?\d/iu },
  { nome: 'numero_longo', regex: /(?:\d[\s.\-()/]*){10,}/ },
]

/** Devolve o padrão sensível encontrado, ou null quando o fato é seguro de guardar. */
export function detectarDadoSensivel(fato: string): PadraoSensivel | null {
  for (const p of PADROES) if (p.regex.test(fato)) return p.nome
  return null
}

/** Minúsculas, sem acento, sem pontuação, espaços colapsados — a chave de deduplicação. */
export function normalizarFato(fato: string): string {
  return fato
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export interface EntradaMemoria {
  readonly contatoId: string
  readonly tipo: TipoMemoria
  readonly fato: string
  readonly origemMensagemId?: string | null | undefined
  /** 0..1; padrão 0.8. */
  readonly confianca?: number | undefined
  readonly validoAte?: Date | null | undefined
}

export type ResultadoAnotar =
  | { readonly resultado: 'ok'; readonly id: string }
  | { readonly resultado: 'duplicado'; readonly id: string }
  | { readonly resultado: 'fato_sensivel'; readonly padrao: PadraoSensivel }
  | { readonly resultado: 'fato_invalido'; readonly motivo: 'vazio' | 'longo' }
  | { readonly resultado: 'contato_nao_encontrado' }

export async function anotarMemoria(tx: Sql, e: EntradaMemoria): Promise<ResultadoAnotar> {
  const fato = e.fato.replace(/\s+/g, ' ').trim()
  if (fato === '') return { resultado: 'fato_invalido', motivo: 'vazio' }
  if (fato.length > MAX_FATO) return { resultado: 'fato_invalido', motivo: 'longo' }
  const padrao = detectarDadoSensivel(fato)
  if (padrao) return { resultado: 'fato_sensivel', padrao }
  const normalizado = normalizarFato(fato)
  if (normalizado === '') return { resultado: 'fato_invalido', motivo: 'vazio' }

  const [contato] = await tx<{ id: string }[]>`
    SELECT id FROM contato WHERE tenant_id = tenant_atual() AND id = ${e.contatoId}`
  if (!contato) return { resultado: 'contato_nao_encontrado' }

  const confianca = Math.min(Math.max(e.confianca ?? 0.8, 0), 1)
  const id = randomUUID()
  const [gravado] = await tx<{ id: string }[]>`
    INSERT INTO cliente_memoria (tenant_id, id, contato_id, tipo, fato, fato_normalizado, origem_mensagem_id, confianca, valido_ate)
    VALUES (tenant_atual(), ${id}, ${e.contatoId}, ${e.tipo}, ${fato}, ${normalizado},
            ${e.origemMensagemId ?? null}, ${confianca.toFixed(2)}, ${e.validoAte ?? null})
    ON CONFLICT (tenant_id, contato_id, fato_normalizado) WHERE revogado_em IS NULL DO NOTHING
    RETURNING id`
  if (gravado) return { resultado: 'ok', id: gravado.id }

  const [existente] = await tx<{ id: string }[]>`
    SELECT id FROM cliente_memoria
     WHERE tenant_id = tenant_atual() AND contato_id = ${e.contatoId}
       AND fato_normalizado = ${normalizado} AND revogado_em IS NULL`
  return { resultado: 'duplicado', id: existente!.id }
}

export interface MemoriaLida {
  readonly id: string
  readonly tipo: TipoMemoria
  readonly fato: string
  readonly confianca: number
  readonly validoAte: Date | null
  readonly origemMensagemId: string | null
  readonly criadoEm: Date
}

/**
 * Página de memória VIGENTE (não revogada, não expirada) de um contato, da mais
 * recente para a mais antiga — por cursor, como toda lista.
 */
export async function listarMemoria(
  tx: Sql, contatoId: string,
  opcoes: { cursor?: { criadoEm: string; id: string } | null; limite?: number; agora?: Date } = {},
): Promise<{ itens: MemoriaLida[]; proximoCursor: { criadoEm: string; id: string } | null }> {
  const limite = Math.min(Math.max(opcoes.limite ?? LIMITE_LEITURA_PADRAO, 1), LIMITE_LEITURA_MAX)
  const agora = opcoes.agora ?? new Date()
  const cur = opcoes.cursor ?? null
  const linhas = await tx<{
    id: string; tipo: TipoMemoria; fato: string; confianca: string; valido_ate: Date | null
    origem_mensagem_id: string | null; criado_em: Date
  }[]>`
    SELECT id, tipo, fato, confianca::text, valido_ate, origem_mensagem_id, criado_em
      FROM cliente_memoria
     WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}
       AND revogado_em IS NULL
       AND (valido_ate IS NULL OR valido_ate > ${agora}::timestamptz)
       AND ${cur === null ? tx`true` : tx`(criado_em, id) < (${cur.criadoEm}::timestamptz, ${cur.id}::uuid)`}
     ORDER BY criado_em DESC, id DESC
     LIMIT ${limite + 1}`
  const temMais = linhas.length > limite
  const pagina = temMais ? linhas.slice(0, limite) : linhas
  const ultimo = pagina[pagina.length - 1]
  return {
    itens: pagina.map((l) => ({
      id: l.id, tipo: l.tipo, fato: l.fato, confianca: Number(l.confianca), validoAte: l.valido_ate,
      origemMensagemId: l.origem_mensagem_id, criadoEm: l.criado_em,
    })),
    proximoCursor: temMais && ultimo ? { criadoEm: ultimo.criado_em.toISOString(), id: ultimo.id } : null,
  }
}

/**
 * O que vai para o prompt do turno: os N fatos mais recentes e vigentes, no
 * formato "[preferencia] gosta de tamanho G".
 */
export async function lerMemoria(tx: Sql, contatoId: string, limite = LIMITE_LEITURA_PADRAO, agora = new Date()): Promise<string[]> {
  const { itens } = await listarMemoria(tx, contatoId, { limite, agora })
  return itens.map((m) => `[${m.tipo}] ${m.fato}`)
}

/** Revoga um fato (fica na trilha, sai do prompt). `false` = não existe ou já revogado. */
export async function revogarMemoria(tx: Sql, id: string, agora = new Date()): Promise<boolean> {
  const r = await tx`
    UPDATE cliente_memoria SET revogado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${id} AND revogado_em IS NULL`
  return r.count === 1
}
