import type { ConhecimentoPorta } from './ligacoes-porta.js'

/**
 * Base de conhecimento MÍNIMA: as políticas curadas do canal, divididas em
 * parágrafos e pontuadas por sobreposição de palavras com a pergunta.
 *
 * ⚠️ Provisória até a raia R3 (documentos versionados + FTS + embeddings). Já
 * cumpre o invariante que importa: o modelo só responde política com um trecho
 * que VEIO daqui, com a fonte "Políticas da loja".
 */
export function conhecimentoDasPoliticas(politicas: string): ConhecimentoPorta {
  const blocos = politicas.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  return {
    async buscar(_ctx, pergunta) {
      const termos = tokens(pergunta)
      const pontuados = blocos
        .map((texto) => ({ texto, pontos: [...tokens(texto)].filter((t) => termos.has(t)).length }))
        .filter((b) => b.pontos > 0)
        .sort((a, b) => b.pontos - a.pontos)
        .slice(0, 3)
      return { trechos: pontuados.map((b) => ({ texto: b.texto, fonte: 'Políticas da loja' })) }
    },
  }
}

function tokens(s: string): Set<string> {
  return new Set(
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4),
  )
}
