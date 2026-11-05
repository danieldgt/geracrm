/**
 * ROTEAMENTO POR FILIAL E RODÍZIO (raia G4 — plano-paridade-am #71, #91).
 *
 * TypeScript puro: a API decide com estas funções (ingestão, handoff, simulação)
 * e o console explica a decisão com as MESMAS palavras (`ROTULO_MOTIVO_FILIAL`).
 *
 * Aqui:
 *   - o contrato das regras (`corpoRegraRoteamento`, `RegraRoteamento`);
 *   - `dddDoTelefone` — o DDD de um telefone brasileiro;
 *   - `resolverFilial` — a filial do contato, pela precedência fixa;
 *   - `proximoDoRodizio` — o próximo da vez (por id), voltando ao início.
 *
 * ⚠️ PRIORIDADE não escolhe entre níveis nem entre a regra do número e a geral:
 *    é só a ORDEM DE EXIBIÇÃO e o desempate entre regras do MESMO alcance (com a
 *    unicidade número+tipo+valor, isso quase nunca acontece). A tela diz isso.
 */
import { z } from 'zod'
import { normalizarTelefone } from './telefone.js'

// ── regras ─────────────────────────────────────────────────────────────────

export const TIPOS_REGRA_ROTEAMENTO = ['ddd', 'origem', 'padrao'] as const
export type TipoRegraRoteamento = (typeof TIPOS_REGRA_ROTEAMENTO)[number]

export const ROTULO_TIPO_REGRA: Record<TipoRegraRoteamento, string> = {
  ddd: 'DDD', origem: 'Origem', padrao: 'Padrão',
}

/** Os 67 DDDs do plano nacional. Fora daqui o telefone não é brasileiro (ou é inválido). */
export const DDDS_BRASIL: readonly string[] = [
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
]
const DDDS = new Set(DDDS_BRASIL)
export function dddValido(v: string): boolean { return DDDS.has(v) }

export const LIMITES_ROTEAMENTO = { prioridadeMin: 0, prioridadeMax: 9999, prioridadePadrao: 100 } as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = (msg: string) => z.string().regex(UUID, msg).transform((s) => s.toLowerCase())

/**
 * POST /v1/roteamento/regras. No PATCH vale o mesmo objeto com tudo opcional
 * (`corpoRegraRoteamentoParcial`) e a coerência tipo × valor é conferida depois
 * de mesclar com a regra gravada.
 */
const camposRegra = {
  tipo: z.enum(TIPOS_REGRA_ROTEAMENTO, { message: 'Tipo deve ser DDD, origem ou padrão.' }),
  /** DDD (2 dígitos) | id da origem | null no padrão. */
  valor: z.string().trim().nullable(),
  filialId: uuid('Escolha a filial.'),
  /** null = vale para todos os números. */
  canalId: uuid('Número inválido.').nullable(),
  prioridade: z.number().int('Prioridade é um número inteiro.')
    .min(LIMITES_ROTEAMENTO.prioridadeMin, 'Prioridade mínima é 0.')
    .max(LIMITES_ROTEAMENTO.prioridadeMax, 'Prioridade máxima é 9999.'),
  ativa: z.boolean(),
}

export const corpoRegraRoteamento = z.object({
  ...camposRegra,
  canalId: camposRegra.canalId.default(null),
  valor: camposRegra.valor.default(null),
  prioridade: camposRegra.prioridade.default(LIMITES_ROTEAMENTO.prioridadePadrao),
  ativa: camposRegra.ativa.default(true),
}).strict()
export type CorpoRegraRoteamento = z.output<typeof corpoRegraRoteamento>

export const corpoRegraRoteamentoParcial = z.object(camposRegra).partial().strict()
export type CorpoRegraRoteamentoParcial = z.output<typeof corpoRegraRoteamentoParcial>

/** O valor bate com o tipo? Devolve a mensagem do problema ou null. Normaliza para gravar. */
export function validarValorDaRegra(
  tipo: TipoRegraRoteamento, valor: string | null,
): { ok: true; valor: string | null } | { ok: false; mensagem: string } {
  const v = valor?.trim() ? valor.trim() : null
  if (tipo === 'padrao') return v === null ? { ok: true, valor: null } : { ok: false, mensagem: 'A regra padrão não tem valor.' }
  if (tipo === 'ddd') {
    if (v === null || !/^\d{2}$/.test(v)) return { ok: false, mensagem: 'Informe o DDD com 2 dígitos.' }
    return dddValido(v) ? { ok: true, valor: v } : { ok: false, mensagem: `O DDD ${v} não existe.` }
  }
  if (v === null || !UUID.test(v)) return { ok: false, mensagem: 'Escolha a origem.' }
  return { ok: true, valor: v.toLowerCase() }
}

/** Uma regra como a API devolve (GET /v1/roteamento/regras). */
export interface RegraRoteamento {
  readonly id: string
  readonly tipo: TipoRegraRoteamento
  readonly valor: string | null
  /** Nome da origem (tipo 'origem'); null nos demais. */
  readonly valorRotulo: string | null
  readonly filialId: string
  readonly filialNome: string
  readonly filialAtiva: boolean
  readonly canalId: string | null
  readonly canalNome: string | null
  readonly prioridade: number
  readonly ativa: boolean
  readonly atualizadoEm: string
}

// ── telefone ───────────────────────────────────────────────────────────────

/** DDD de um telefone brasileiro (com ou sem +55), ou null quando não dá para saber. */
export function dddDoTelefone(telefone: string | null | undefined): string | null {
  if (!telefone) return null
  const t = normalizarTelefone(telefone)
  return t && dddValido(t.ddd) ? t.ddd : null
}

// ── resolução da filial ────────────────────────────────────────────────────

/** O mínimo de uma regra para decidir (lido sob RLS pela API). */
export interface RegraAplicavel {
  readonly id: string
  readonly canalId: string | null
  readonly tipo: TipoRegraRoteamento
  readonly valor: string | null
  readonly filialId: string
  readonly prioridade: number
  readonly ativa: boolean
  /** A filial de destino está ativa? Regra para filial desativada não roteia. */
  readonly filialAtiva: boolean
}

export interface FatosDaFilial {
  /** `contato.filial_id` já gravado, SE a filial estiver ativa (null senão). */
  readonly filialDoContato: string | null
  readonly origemId: string | null
  readonly ddd: string | null
  /** O número pelo qual o contato fala. null = sem número (só regras gerais). */
  readonly canalId: string | null
  /** `canal_conectado.filial_id` do número, SE ativa. */
  readonly filialDoNumero: string | null
}

export const MOTIVOS_FILIAL = ['contato', 'origem', 'ddd', 'padrao_numero', 'filial_numero', 'padrao_geral', 'nenhuma'] as const
export type MotivoFilial = (typeof MOTIVOS_FILIAL)[number]

export const ROTULO_MOTIVO_FILIAL: Record<MotivoFilial, string> = {
  contato: 'filial já gravada no contato',
  origem: 'regra por origem',
  ddd: 'regra por DDD',
  padrao_numero: 'regra padrão do número',
  filial_numero: 'filial do próprio número',
  padrao_geral: 'regra padrão geral',
  nenhuma: 'nenhuma regra casou',
}

export interface FilialResolvida {
  readonly filialId: string | null
  readonly motivo: MotivoFilial
  /** A regra que decidiu (null em contato, filial do número e nenhuma). */
  readonly regraId: string | null
}

const ordemDaRegra = (canalId: string | null) => (a: RegraAplicavel, b: RegraAplicavel): number => {
  // Específica do número antes da geral; depois prioridade (menor vence); depois id (estável).
  const ea = a.canalId !== null && a.canalId === canalId ? 0 : 1
  const eb = b.canalId !== null && b.canalId === canalId ? 0 : 1
  if (ea !== eb) return ea - eb
  if (a.prioridade !== b.prioridade) return a.prioridade - b.prioridade
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * A FILIAL do contato (puro). Precedência FIXA — a primeira que decide vence:
 *   1. a filial já gravada no contato;
 *   2. regra por ORIGEM do contato;
 *   3. regra por DDD do telefone;
 *   4. regra PADRÃO do número;
 *   5. a filial do próprio número (`canal_conectado.filial_id`) — o número de
 *      uma filial é, sem regra nenhuma, o sinal mais forte de onde o cliente está;
 *   6. regra PADRÃO geral (todos os números);
 *   7. nenhuma.
 * Em 2 e 3, a regra do número vence a geral; no mesmo alcance, a menor
 * prioridade. Regra inativa, de outro número ou de filial desativada é ignorada.
 */
export function resolverFilial(regras: readonly RegraAplicavel[], f: FatosDaFilial): FilialResolvida {
  if (f.filialDoContato) return { filialId: f.filialDoContato, motivo: 'contato', regraId: null }
  const validas = regras.filter((r) => r.ativa && r.filialAtiva && (r.canalId === null || r.canalId === f.canalId))
  const achar = (tipo: TipoRegraRoteamento, valor: string | null, soDoNumero?: boolean): RegraAplicavel | undefined =>
    validas
      .filter((r) => r.tipo === tipo && r.valor === valor && (soDoNumero === undefined || (soDoNumero ? r.canalId !== null : r.canalId === null)))
      .sort(ordemDaRegra(f.canalId))[0]
  const origem = f.origemId ? achar('origem', f.origemId.toLowerCase()) : undefined
  if (origem) return { filialId: origem.filialId, motivo: 'origem', regraId: origem.id }
  const ddd = f.ddd ? achar('ddd', f.ddd) : undefined
  if (ddd) return { filialId: ddd.filialId, motivo: 'ddd', regraId: ddd.id }
  const padraoNumero = f.canalId ? achar('padrao', null, true) : undefined
  if (padraoNumero) return { filialId: padraoNumero.filialId, motivo: 'padrao_numero', regraId: padraoNumero.id }
  if (f.filialDoNumero) return { filialId: f.filialDoNumero, motivo: 'filial_numero', regraId: null }
  const padraoGeral = achar('padrao', null, false)
  if (padraoGeral) return { filialId: padraoGeral.filialId, motivo: 'padrao_geral', regraId: padraoGeral.id }
  return { filialId: null, motivo: 'nenhuma', regraId: null }
}

// ── rodízio ────────────────────────────────────────────────────────────────

/**
 * O próximo da vez (puro): o primeiro id MAIOR que o último escolhido, entre os
 * elegíveis em ordem de id; no fim da lista volta ao primeiro. Lista vazia → null.
 * ⚠️ Por id, não por posição: quem sai ou entra no meio não embaralha a vez dos outros.
 */
export function proximoDoRodizio(elegiveis: readonly string[], ultimo: string | null): string | null {
  const ids = [...new Set(elegiveis)].sort()
  if (ids.length === 0) return null
  return (ultimo ? ids.find((id) => id > ultimo) : undefined) ?? ids[0]!
}

// ── simulação ──────────────────────────────────────────────────────────────

/** GET /v1/roteamento/simular — sem efeito colateral, sem avançar o rodízio. */
export interface SimulacaoRoteamento {
  readonly ddd: string | null
  readonly filial: { readonly id: string; readonly nome: string } | null
  readonly motivo: MotivoFilial
  readonly regraId: string | null
  /** Quem seria escolhido AGORA no rodízio da entrada (vendedores da filial que atendem o número). */
  readonly vendedor: { readonly id: string; readonly nome: string } | null
  /** Quantos estão na vez (ativos, não ausentes, que atendem o número). */
  readonly elegiveis: number
  /**
   * A filial resolvida está FORA do escopo de quem simula (gestor de outra
   * filial): `filial`, `vendedor` e `regraId` vêm nulos — só se diz "outra filial".
   */
  readonly foraDoEscopo: boolean
  /** O rodízio na entrada está ligado neste número? (null sem número) */
  readonly rodizioNaEntrada: boolean | null
}

/** GET /v1/roteamento/numeros — a chave por número. */
export interface NumeroRoteamento {
  readonly id: string
  readonly nome: string
  readonly tipo: string
  readonly filialId: string | null
  readonly rodizioNaEntrada: boolean
}
