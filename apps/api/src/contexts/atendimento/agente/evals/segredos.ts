/**
 * Nenhum script de operação imprime credencial (`agente:smoke`, `agente:avaliar --juiz`):
 * toda saída passa por aqui antes de ir para o terminal. Apaga o valor de qualquer
 * variável de ambiente com cara de segredo (KEY, TOKEN, SECRET, SENHA, PASSWORD) e
 * padrões de chave (Bearer …, sk-…) — inclusive dentro da mensagem de erro do fornecedor.
 */

const NOME_DE_SEGREDO = /(KEY|TOKEN|SECRET|SENHA|PASSWORD|PASSWD|CREDENCIAL)/i

/** Valores de variáveis com cara de segredo (≥ 6 caracteres), do mais longo ao mais curto. */
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

/** Limpa cada texto de um objeto ANTES de serializar (o JSON escaparia aspas/barras de um segredo). */
export function limparSegredos(v: unknown, segredos: readonly string[]): unknown {
  if (typeof v === 'string') return semSegredos(v, segredos)
  if (Array.isArray(v)) return v.map((x) => limparSegredos(x, segredos))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limparSegredos(x, segredos)]))
  return v
}
