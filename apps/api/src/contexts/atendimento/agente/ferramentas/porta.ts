import { z } from 'zod'
import { NumerosVistos, numerosDeSaida, percentuaisDeSaida, type ModoDoTurno, type PerfilPreco } from '@geracrm/shared'
import type { DefinicaoFerramentaLlm, ResultadoExecucaoFerramenta } from '../porta-llm.js'
import type { enviarTextoNaConversa } from '../../envio-conversa.js'

/**
 * FERRAMENTAS DO VENDEDOR — a única forma de o modelo tocar o nosso banco.
 *
 * ⚠️ Menor privilégio por construção: cada ferramenta é uma função pequena, sob
 * RLS, com entrada validada por Zod, que devolve dados ou um erro nomeado.
 * Não existe ferramenta para efetivar pedido, apagar, alterar preço, nem para
 * ler outro contato. Se o modelo "quiser" algo que não está aqui, ele não tem
 * como — e é assim que deve ser.
 *
 * ⚠️ `centavos` na saída: todo valor monetário que a ferramenta mostrou ao
 * modelo. É o conjunto que o guardrail numérico aceita na resposta — número
 * que não veio daqui é alucinação, por definição (CLAUDE.md).
 *
 * ⚠️ `numeros` na saída: idem para percentual, quantidade e prazo (P7). Ferramenta
 * que mostra saldo, quantidade ou prazo ao modelo e não os devolve aqui faz o
 * guardrail ampliado barrar a resposta certa.
 */

export interface ContextoFerramenta {
  readonly tenantId: string
  readonly conversaId: string
  readonly contatoId: string
  readonly canalId: string
  readonly perfil: PerfilPreco
  readonly sessaoId: string | null
  readonly modo: ModoDoTurno
  readonly agora: Date
  /** O envio pelo gateway que o turno usa — injetável em teste; a proposta sai por ele. */
  readonly enviar?: typeof enviarTextoNaConversa | undefined
}

export type SaidaFerramenta =
  | {
      readonly ok: true
      readonly saida: unknown
      /** Valores monetários expostos ao modelo nesta chamada, em centavos. */
      readonly centavos?: readonly number[] | undefined
      /**
       * Números de negócio (quantidade, saldo, prazo, %) expostos ao modelo nesta
       * chamada — a fonte do guardrail ampliado (P7). Use `numerosDeSaida`.
       */
      readonly numeros?: readonly number[] | undefined
      /**
       * Percentuais expostos ao modelo — SÓ número escrito com % ou campo
       * percentual (`percentuaisDe`). Fonte tipada: um número qualquer nunca abona "%".
       */
      readonly percentuais?: readonly number[] | undefined
      /**
       * Esta chamada mostrou ao modelo um SALDO de estoque apurado (número, não
       * `null`/'desconhecido'). É o que abona escassez ("restam poucas unidades")
       * no filtro de saída (P2) — use `saldoApuradoEm`.
       */
      readonly saldoVisto?: boolean | undefined
      /** Efeito colateral que o turno precisa saber (handoff pedido, proposta enviada). */
      readonly efeito?: 'handoff' | 'proposta_enviada' | 'pedido_alterado' | undefined
      readonly handoff?: { motivo: string; resumo: string } | undefined
    }
  | { readonly ok: false; readonly erro: string }

export interface Ferramenta<I = unknown> {
  readonly nome: string
  readonly descricao: string
  readonly entrada: z.ZodType<I>
  executar(ctx: ContextoFerramenta, entrada: I): Promise<SaidaFerramenta>
}

/** Converte o Zod da ferramenta para o JSON Schema estrito que o modelo recebe. */
export function definicaoParaLlm(f: Ferramenta<never>): DefinicaoFerramentaLlm {
  return { nome: f.nome, descricao: f.descricao, esquema: esquemaEstrito(f.entrada) }
}

export function esquemaEstrito(schema: z.ZodType): Record<string, unknown> {
  const bruto = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  delete bruto['$schema']
  return fecharObjetos(bruto) as Record<string, unknown>
}

/** `additionalProperties: false` em todo objeto — exigência do `strict: true`. */
function fecharObjetos(n: unknown): unknown {
  if (Array.isArray(n)) return n.map(fecharObjetos)
  if (n && typeof n === 'object') {
    const o = { ...(n as Record<string, unknown>) }
    if (o['type'] === 'object') {
      o['additionalProperties'] = false
      const props = o['properties'] as Record<string, unknown> | undefined
      if (props) o['required'] = Object.keys(props)
    }
    for (const k of Object.keys(o)) o[k] = fecharObjetos(o[k])
    return o
  }
  return n
}

export interface RegistroDeFerramentas {
  readonly lista: readonly Ferramenta<never>[]
  readonly definicoes: readonly DefinicaoFerramentaLlm[]
  /** Centavos acumulados em todas as chamadas do turno. */
  readonly centavosVistos: Set<number>
  /**
   * Números de negócio (%, quantidade, prazo) vistos em ferramenta neste turno —
   * a fonte do guardrail ampliado (raia P7 preenche; P0 só abre o campo).
   */
  readonly numerosVistos: NumerosVistos
  /** Alguma ferramenta de catálogo/estoque devolveu saldo apurado neste turno (P0c-j). */
  readonly saldoDeEstoqueVisto: boolean
  readonly efeitos: { handoff: { motivo: string; resumo: string } | null; propostaEnviada: boolean; pedidoAlterado: boolean }
  executar(nome: string, entradaBruta: unknown): Promise<ResultadoExecucaoFerramenta>
}

/**
 * Monta o registro: valida entrada, executa sob o contexto, acumula centavos e
 * efeitos. ⚠️ Nunca lança — erro vira `{ok:false, erro}` que volta ao modelo
 * como `tool_result` de erro, e o laço continua.
 */
export function registroDeFerramentas(
  ctx: ContextoFerramenta, ferramentas: readonly Ferramenta<never>[],
): RegistroDeFerramentas {
  const porNome = new Map(ferramentas.map((f) => [f.nome, f]))
  const centavosVistos = new Set<number>()
  const numerosVistos = new NumerosVistos()
  const efeitos = { handoff: null as { motivo: string; resumo: string } | null, propostaEnviada: false, pedidoAlterado: false }
  let saldoVisto = false
  return {
    lista: ferramentas,
    definicoes: ferramentas.map(definicaoParaLlm),
    centavosVistos,
    numerosVistos,
    get saldoDeEstoqueVisto() { return saldoVisto },
    efeitos,
    async executar(nome, entradaBruta) {
      const f = porNome.get(nome)
      if (!f) return { ok: false, erro: `ferramenta desconhecida: ${nome}` }
      const parse = f.entrada.safeParse(entradaBruta ?? {})
      if (!parse.success) return { ok: false, erro: `entrada inválida: ${parse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }
      try {
        const r = await f.executar(ctx, parse.data as never)
        if (!r.ok) return { ok: false, erro: r.erro }
        for (const c of r.centavos ?? []) centavosVistos.add(c)
        for (const n of r.numeros ?? []) numerosVistos.add(n)
        for (const n of r.percentuais ?? []) numerosVistos.percentuais.add(n)
        if (r.saldoVisto) saldoVisto = true
        if (r.efeito === 'handoff' && r.handoff) efeitos.handoff = r.handoff
        if (r.efeito === 'proposta_enviada') efeitos.propostaEnviada = true
        if (r.efeito === 'pedido_alterado') efeitos.pedidoAlterado = true
        return { ok: true, saida: r.saida }
      } catch (e) {
        return { ok: false, erro: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/** Números de negócio de uma saída (pula centavos, ids, `seq`, datas ISO). */
export function numerosDe(saida: unknown): number[] {
  return [...numerosDeSaida(saida)]
}

/** Percentuais de uma saída: campo percentual ou "N%" escrito num texto. */
export function percentuaisDe(saida: unknown): number[] {
  return [...percentuaisDeSaida(saida)]
}

/**
 * A saída mostra algum saldo APURADO (campo `saldo` numérico)? `null` (não
 * controla estoque) e 'desconhecido' (ERP não informou) não contam: não dão
 * base para dizer "restam poucas unidades".
 */
export function saldoApuradoEm(saida: unknown): boolean {
  if (Array.isArray(saida)) return saida.some(saldoApuradoEm)
  if (saida && typeof saida === 'object') {
    return Object.entries(saida as Record<string, unknown>).some(([k, v]) =>
      (k === 'saldo' && typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'object' && saldoApuradoEm(v)))
  }
  return false
}

/** Coleta recursivamente todos os campos `*Centavos` de uma saída. */
export function centavosDe(saida: unknown, acc: number[] = []): number[] {
  if (Array.isArray(saida)) { for (const s of saida) centavosDe(s, acc); return acc }
  if (saida && typeof saida === 'object') {
    for (const [k, v] of Object.entries(saida as Record<string, unknown>)) {
      if (/centavos$/i.test(k) && typeof v === 'number' && Number.isInteger(v)) acc.push(v)
      else centavosDe(v, acc)
    }
  }
  return acc
}
