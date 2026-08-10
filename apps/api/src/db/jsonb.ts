/**
 * Serializa um valor para gravar em coluna jsonb.
 *
 * ⚠️ SEMPRE use com `::text::jsonb`, nunca com `::jsonb` sozinho.
 *
 *    Escrever `${JSON.stringify(obj)}::jsonb` grava um jsonb do tipo STRING —
 *    a string JSON inteira dentro de aspas — em vez do objeto:
 *
 *      SELECT jsonb_typeof(atributos) FROM sku;   -- 'string', não 'object'
 *
 *    O driver marca o parâmetro como JSON e o Postgres codifica de novo. Nada
 *    falha: o INSERT passa, a coluna parece preenchida e o dado volta como
 *    texto. O que quebra é silencioso e só aparece muito depois —
 *    `atributos->>'tamanho'` retorna NULL para sempre e o índice GIN não casa
 *    com nada, então o filtro "todos os tamanho G" devolve vazio sem erro.
 *
 *    O `::text` força o parâmetro a ir como texto puro, e aí o Postgres faz o
 *    parse de verdade.
 */
export function jsonbDe(valor: unknown): string {
  return JSON.stringify(valor)
}
