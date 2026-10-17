import { pathToFileURL } from 'node:url'
import {
  faltaParaLlmFerramentas, faltaParaReserva, llmFerramentasDoAmbiente, reservaDoAmbiente,
} from '../fabrica-ferramentas.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'

/**
 * `pnpm --filter @geracrm/api agente:smoke [-- --reserva]`
 *
 * Smoke do provedor de IA configurado (playbook AM §8.1): UMA chamada curta
 * (≤ 64 tokens de saída, sem ferramentas) e imprime provedor, modo (lado
 * principal ou reserva + qual variável de credencial está presente), modelo,
 * latência e uso de tokens. Rodar na homologação, depois de trocar chave ou
 * modelo, e uma vez por mês.
 *
 *   pnpm --filter @geracrm/api agente:smoke                 # o principal (IA_PROVEDOR / IA_MODELO)
 *   pnpm --filter @geracrm/api agente:smoke -- --reserva    # a reserva (IA_RESERVA_PROVEDOR / IA_RESERVA_MODELO)
 *   SMOKE_MODELO=<id> pnpm --filter @geracrm/api agente:smoke   # outro modelo, sem mexer no IA_MODELO
 *
 * ⚠️ NUNCA imprime credencial: só o NOME da variável. Toda saída (inclusive a
 *    mensagem de erro do fornecedor) passa por `semSegredos`, que apaga o valor
 *    de qualquer variável com cara de segredo (KEY, TOKEN, SECRET, SENHA,
 *    PASSWORD) e padrões de chave (Bearer …, sk-…).
 *
 * Saída 0 = respondeu; 1 = falta configuração ou o provedor falhou.
 */

const NOME_DE_SEGREDO = /(KEY|TOKEN|SECRET|SENHA|PASSWORD|PASSWD|CREDENCIAL)/i
const VARIAVEIS_DE_CHAVE: Readonly<Record<string, string>> = {
  claude: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY', maritaca: 'MARITACA_API_KEY',
}

/** Valores de variáveis com cara de segredo (≥ 6 caracteres). */
export function segredosDoAmbiente(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([k, v]) => NOME_DE_SEGREDO.test(k) && typeof v === 'string' && v.trim().length >= 6)
    .map(([, v]) => v!.trim())
    .sort((a, b) => b.length - a.length)
}

/** Apaga segredos de um texto antes de imprimir. */
export function semSegredos(texto: string, segredos: readonly string[]): string {
  let t = texto
  for (const s of segredos) t = t.split(s).join('***')
  return t
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\b(gsk|AIza)[A-Za-z0-9_-]{8,}/g, '$1***')
}

/** O provedor pedido (ou inferido pela chave presente, na mesma ordem da fábrica). */
function provedorPrincipal(env: NodeJS.ProcessEnv): string {
  const p = env.IA_PROVEDOR?.trim()
  if (p) return p
  if (env.ANTHROPIC_API_KEY?.trim()) return 'claude'
  if (env.OPENROUTER_API_KEY?.trim()) return 'openrouter'
  return '(nenhum)'
}

export interface IoSmoke {
  readonly env: NodeJS.ProcessEnv
  readonly escrever: (texto: string) => void
  readonly erro: (texto: string) => void
  /** Troca a porta do ambiente (testes). */
  readonly porta?: PortaLlmFerramentas | undefined
}

export async function executarSmoke(argv: readonly string[], io: IoSmoke): Promise<number> {
  const { env } = io
  const segredos = segredosDoAmbiente(env)
  // Limpa cada texto ANTES de serializar (o JSON escaparia aspas/barras de um segredo) e o JSON inteiro depois.
  const limpar = (v: unknown): unknown => typeof v === 'string' ? semSegredos(v, segredos)
    : Array.isArray(v) ? v.map(limpar)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limpar(x)])) : v
  const imprimir = (o: unknown) => io.escrever(`${semSegredos(JSON.stringify(limpar(o), null, 2), segredos)}\n`)
  const falhar = (o: unknown) => io.erro(`${semSegredos(JSON.stringify(limpar(o)), segredos)}\n`)
  const reserva = argv.includes('--reserva')

  const provedor = reserva ? env.IA_RESERVA_PROVEDOR?.trim() || '(nenhum)' : provedorPrincipal(env)
  const falta = reserva
    ? (env.IA_RESERVA_PROVEDOR?.trim() ? faltaParaReserva(env) : ['IA_RESERVA_PROVEDOR'])
    : faltaParaLlmFerramentas(env)
  const credencial = provedor === 'simulado' ? null : VARIAVEIS_DE_CHAVE[provedor] ?? null
  const modo = { lado: reserva ? 'reserva' : 'principal', credencial: credencial ? `${credencial} (presente: ${env[credencial]?.trim() ? 'sim' : 'não'})` : 'nenhuma' }
  if (falta.length > 0) {
    falhar({ ok: false, provedor, modo, falta })
    return 1
  }

  // ⚠️ O principal SEM a reserva atrás: o smoke diz se ESTE provedor responde,
  //    não se o roteador conseguiu desviar.
  const porta = io.porta ?? (reserva ? reservaDoAmbiente(env)!.porta : llmFerramentasDoAmbiente({ ...env, IA_RESERVA_PROVEDOR: '' }))
  const modeloPedido = env.SMOKE_MODELO?.trim() || (reserva ? env.IA_RESERVA_MODELO?.trim() : env.IA_MODELO?.split(',')[0]?.trim()) || '(padrão do provedor)'
  imprimir({ provedor, modo, modeloPedido })

  const inicio = Date.now()
  let r: ResultadoLaco
  try {
    r = await porta.rodar({
      sistema: [{ texto: 'Teste de conectividade do GeraCRM. Responda no formato pedido.' }],
      mensagens: [{ papel: 'cliente', texto: 'Responda apenas: ok (smoke test).' }],
      ferramentas: [],
      executar: async () => ({ ok: false, erro: 'o smoke não tem ferramentas' }),
      esquemaSaida: { type: 'object', properties: { resposta: { type: 'string' } }, required: ['resposta'], additionalProperties: false },
      limites: { maxRodadas: 1, maxTokensSaida: 64, prazoMs: 30_000 },
      modelo: env.SMOKE_MODELO?.trim() || undefined,
      esforco: 'low',
    })
  } catch (e) {
    falhar({ ok: false, provedor, modo, latenciaMs: Date.now() - inicio, erro: (e as Error).message.slice(0, 500) })
    return 1
  }
  const latenciaMs = r.rastro?.latenciaMs ?? Date.now() - inicio
  if (!r.ok) {
    falhar({ ok: false, provedor: r.rastro?.provedor ?? provedor, modo, modelo: r.rastro?.modelo ?? modeloPedido, latenciaMs, motivo: r.motivo, detalhe: (r.detalhe ?? '').slice(0, 500) })
    return 1
  }
  imprimir({
    ok: true, provedor: r.rastro.provedor ?? porta.nome, modo, modelo: r.rastro.modelo, latenciaMs,
    uso: r.rastro.uso, resposta: JSON.stringify(r.saida).slice(0, 200),
  })
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executarSmoke(process.argv.slice(2), {
    env: process.env,
    escrever: (t) => process.stdout.write(t),
    erro: (t) => process.stderr.write(t),
  }).then(
    (codigo) => process.exit(codigo),
    (e: unknown) => {
      process.stderr.write(`${semSegredos(`agente:smoke falhou: ${(e as Error).message}`, segredosDoAmbiente(process.env))}\n`)
      process.exit(1)
    },
  )
}
