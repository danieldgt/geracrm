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
 *
 * ⚠️ Mapa cheio descarta a entrada MAIS ANTIGA (LRU simples: o `Map` guarda a
 * ordem de inserção e cada uso reinsere a chave no fim). Recusar quando cheio
 * fazia de um scanner com milhares de IPs um bloqueio de TODOS os legítimos — o
 * limitador virava a negação de serviço que devia impedir. Descartar o mais
 * antigo, no pior caso, devolve a cota a quem estava parado havia mais tempo.
 */
export function criarLimiteTaxa(opcoes: OpcoesLimite): LimiteTaxa {
  const maxChaves = opcoes.maxChaves ?? 10_000
  const contagem = new Map<string, { balde: number; usos: number }>()

  return {
    permitir(chave: string, agora: number): boolean {
      const balde = Math.floor(agora / opcoes.janelaMs)
      const atual = contagem.get(chave)

      if (!atual || atual.balde !== balde) {
        if (atual) contagem.delete(chave)
        // ⚠️ Poda antes de crescer, nunca por temporizador: um `setInterval` de
        //    limpeza sobrevive ao processo de teste e segura o encerramento.
        while (contagem.size >= maxChaves) {
          const maisAntiga = contagem.keys().next().value as string
          contagem.delete(maisAntiga)
        }
        contagem.set(chave, { balde, usos: 1 })
        return true
      }

      // Uso recente vai para o fim da fila: o descarte pega quem está parado.
      contagem.delete(chave)
      contagem.set(chave, atual)
      if (atual.usos >= opcoes.teto) return false
      atual.usos++
      return true
    },
    tamanho: () => contagem.size,
  }
}
