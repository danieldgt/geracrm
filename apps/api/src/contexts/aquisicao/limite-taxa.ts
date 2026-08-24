/**
 * Limite de taxa para a superfície PÚBLICA da landing page.
 *
 * ⚠️ O endpoint de sessão não tem autenticação — é o preço de a LP rodar no
 * navegador de um desconhecido. Sem limite, um laço trivial enche
 * `midia_sessao_lp` e a métrica de "código perdido" (sessões consumidas ÷
 * criadas) vai a zero, mascarando o sinal que mais importa na atribuição.
 *
 * ⚠️ **É por instância, em memória.** Duas instâncias da API somam o dobro do
 * teto, e um restart zera a contagem. É proteção contra ABUSO TRIVIAL e contra o
 * bot que descobre a URL — não contra ataque distribuído, que se resolve na
 * borda (Railway/CDN), não aqui. Dizer isso em voz alta é melhor do que fingir
 * uma garantia que o desenho não dá.
 */

export interface LimiteTaxa {
  /** Consome uma permissão. `false` = estourou o teto da janela. */
  permitir(chave: string, agora: number): boolean
  /** Quantas chaves estão sendo rastreadas — para o teste ver a poda. */
  tamanho(): number
}

export interface OpcoesLimite {
  /** Permissões por janela. */
  readonly teto: number
  /** Tamanho da janela, em milissegundos. */
  readonly janelaMs: number
  /**
   * ⚠️ Teto de chaves rastreadas. Sem ele, o próprio limitador vira o vazamento:
   * cada IP novo cria uma entrada, e um scanner de porta cria milhões.
   */
  readonly maxChaves?: number
}

/**
 * Janela deslizante simples (contagem por balde de tempo).
 *
 * Escolhi contagem por balde em vez de token bucket porque o que interessa aqui
 * é "quantas sessões este IP criou no último minuto", e o balde responde isso
 * sem guardar timestamp por evento.
 */
export function criarLimiteTaxa(opcoes: OpcoesLimite): LimiteTaxa {
  const maxChaves = opcoes.maxChaves ?? 10_000
  const contagem = new Map<string, { balde: number; usos: number }>()

  return {
    permitir(chave: string, agora: number): boolean {
      const balde = Math.floor(agora / opcoes.janelaMs)
      const atual = contagem.get(chave)

      if (!atual || atual.balde !== balde) {
        // ⚠️ Poda antes de crescer, nunca por temporizador: um `setInterval` de
        //    limpeza sobrevive ao processo de teste e segura o encerramento.
        if (contagem.size >= maxChaves) {
          for (const [k, v] of contagem) if (v.balde !== balde) contagem.delete(k)
          // Ainda cheio (todos no balde atual): é rajada real. Recusa.
          if (contagem.size >= maxChaves) return false
        }
        contagem.set(chave, { balde, usos: 1 })
        return true
      }

      if (atual.usos >= opcoes.teto) return false
      atual.usos++
      return true
    },
    tamanho: () => contagem.size,
  }
}
