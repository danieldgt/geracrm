/**
 * A DIFERENÇA que vai para a auditoria quando alguém muda a configuração do
 * agente (ADR-028 §5, ação `agente.config_alterada`).
 *
 * ⚠️ Grava só o que MUDOU, nos dois lados: `{antes: {modo: 'sombra'}, depois:
 *    {modo: 'autonomo'}}`. A linha inteira duas vezes por PUT esconderia a
 *    mudança no meio de vinte campos iguais — e políticas de 20 mil caracteres
 *    entrariam inteiras na trilha a cada clique em "Salvar".
 */

/** Colunas que não são configuração (chave, carimbo de tempo). */
const IGNORADAS = new Set(['tenant_id', 'canal_id', 'atualizado_em', 'criado_em'])
/** Texto longo entra cortado: a auditoria diz QUE mudou; o texto inteiro está na tela. */
const MAX_TEXTO = 500

export interface DiferencaConfig {
  readonly antes: Readonly<Record<string, unknown>>
  readonly depois: Readonly<Record<string, unknown>>
  /** Nomes das colunas que mudaram, em ordem alfabética. */
  readonly campos: readonly string[]
}

function cortar(v: unknown): unknown {
  return typeof v === 'string' && v.length > MAX_TEXTO ? `${v.slice(0, MAX_TEXTO)}… (${v.length} caracteres)` : v
}

/** JSON estável (chaves ordenadas) — `{a,b}` e `{b,a}` são a mesma configuração. */
function estavel(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(estavel).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${estavel((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** Diferença rasa entre duas linhas de configuração (`to_jsonb(ac.*)`). `antes` null = criação. */
export function diferencaDeConfig(
  antes: Readonly<Record<string, unknown>> | null, depois: Readonly<Record<string, unknown>>,
): DiferencaConfig {
  const a: Record<string, unknown> = {}
  const d: Record<string, unknown> = {}
  const chaves = new Set([...Object.keys(antes ?? {}), ...Object.keys(depois)])
  for (const k of [...chaves].sort()) {
    if (IGNORADAS.has(k)) continue
    const va = antes ? antes[k] ?? null : null
    const vd = depois[k] ?? null
    if (estavel(va) === estavel(vd)) continue
    a[k] = cortar(va)
    d[k] = cortar(vd)
  }
  return { antes: a, depois: d, campos: Object.keys(d) }
}
