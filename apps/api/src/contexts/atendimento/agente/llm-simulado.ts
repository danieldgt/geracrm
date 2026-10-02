import type { PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco, CapacidadesLlmFerramentas, ChamadaRegistrada } from './porta-llm.js'

/**
 * MODELO SIMULADO — um "vendedor" de regras, determinístico, atrás da MESMA
 * porta do Claude.
 *
 * Existe por três motivos, nenhum deles "economizar":
 *  1. Testar o laço inteiro (fila → portão → ferramentas → guardrail → envio →
 *     auditoria) sem rede e sem dinheiro — é o que a suíte determinística usa.
 *  2. Demonstrar o produto num ambiente sem chave (dev, playground, CI).
 *  3. Ser o "oráculo" das conversas douradas: a sequência de ferramentas que o
 *     modelo real deveria seguir está escrita aqui.
 *
 * ⚠️ Nunca em produção com cliente real: `IA_PROVEDOR=simulado` é recusado
 * quando NODE_ENV=production.
 */
export class LlmSimulado implements PortaLlmFerramentas {
  readonly nome = 'simulado'
  readonly capacidades: CapacidadesLlmFerramentas = { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false }

  async rodar(p: PedidoDeLaco): Promise<ResultadoLaco> {
    const inicio = Date.now()
    const chamadas: ChamadaRegistrada[] = []
    const tem = (n: string) => p.ferramentas.some((f) => f.nome === n)
    const chamar = async (nome: string, entrada: unknown) => {
      const t0 = Date.now()
      const r = await p.executar(nome, entrada)
      chamadas.push({ nome, entrada, saida: r.ok ? r.saida : null, ms: Date.now() - t0, ...(r.ok ? {} : { erro: r.erro }) })
      return r
    }
    const fim = (saida: unknown) => ({
      ok: true as const, saida,
      rastro: { chamadas, rodadas: chamadas.length + 1, uso: { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'simulado', latenciaMs: Date.now() - inicio, parouPor: 'fim' as const },
    })
    const ultimas = p.mensagens.filter((m) => m.papel === 'cliente')
    const texto = (ultimas[ultimas.length - 1]?.texto ?? '').trim()
    const t = normalizar(texto)
    const primeira = !p.mensagens.some((m) => m.papel === 'nos')
    const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`

    // 1. Pedido de humano / reclamação → transfere.
    if (/\b(humano|atendente|pessoa|alguem|reclama\w*|problema|defeito|cobranca|nota fiscal|troca\w*|devolu\w*)\b/.test(t) && tem('atendimento_transferir')) {
      const motivo = /reclama|problema|defeito|cobranca|nota fiscal|troca|devolu/.test(t) ? 'reclamacao' : 'pedido_de_humano'
      await chamar('atendimento_transferir', { motivo, resumo: `Cliente escreveu: "${texto.slice(0, 120)}"` })
      return fim({ mensagens: ['Claro, vou chamar uma pessoa da equipe para continuar com você. Já aviso aqui.'], confianca: 0.95, fase: 'handoff', handoff: { motivo, resumo: `Cliente pediu: ${texto.slice(0, 200)}` } })
    }

    // 2. Confirmação / fechar → propõe.
    if (/\b(fecha|fechar|finaliza|pode mandar|manda o resumo|proposta|resumo do pedido|fechado)\b/.test(t) && tem('pedido_propor')) {
      const r = await chamar('pedido_propor', {})
      const s = r.ok ? (r.saida as { situacao?: string; totalCentavos?: number; detalhe?: string | null }) : { situacao: 'indisponivel' }
      if (s.situacao === 'ok') {
        return fim({ mensagens: [`Acabei de te enviar o resumo do pedido${typeof s.totalCentavos === 'number' ? ` (total ${brl(s.totalCentavos)})` : ''}. Me confirma com um "sim" que eu encaminho.`], confianca: 0.9, fase: 'proposta' })
      }
      if (s.situacao === 'vazio') return fim({ mensagens: ['Ainda não temos itens no pedido. Me diz o que você quer levar que eu monto para você.'], confianca: 0.8, fase: 'recomendacao' })
      if (s.situacao === 'regras') return fim({ mensagens: [`Antes de fechar: ${s.detalhe ?? 'o pedido não atende às regras da loja'}.`], confianca: 0.8, fase: 'recomendacao' })
      if (tem('atendimento_transferir')) {
        await chamar('atendimento_transferir', { motivo: 'incerteza', resumo: `Não consegui enviar a proposta (${s.situacao}${s.detalhe ? `: ${s.detalhe}` : ''}).` })
        return fim({ mensagens: ['Não consegui enviar o resumo agora. Vou pedir para uma pessoa da equipe fechar com você.'], confianca: 0.5, fase: 'handoff', handoff: { motivo: 'incerteza', resumo: `Proposta não enviada: ${s.situacao}` } })
      }
      return fim({ mensagens: ['Não consegui enviar o resumo agora; tento de novo em instantes.'], confianca: 0.5, fase: 'recomendacao' })
    }

    // 3. "quero 2 camiseta verde g" → busca + adiciona.
    const m = t.match(/\b(?:quero|adiciona|coloca|me ve|manda|vou levar|leva)\s+(\d+)\s+(?:de\s+|do\s+|da\s+|un\w*\s+de\s+)?(.+)$/)
    if (m && tem('catalogo_buscar') && tem('pedido_itens')) {
      const qtd = Number(m[1])
      const busca = await chamar('catalogo_buscar', { consulta: m[2]!.trim(), limite: null })
      const itens = (busca.ok ? (busca.saida as { itens?: { produto: string; skus: { skuId: string; atributos: Record<string, string>; precoCentavos: number | null; saldo: number | null | 'desconhecido' }[] }[] }).itens : []) ?? []
      // Escolhe a variação que o cliente nomeou ("verde", "G", "mensal"); senão a primeira com preço e saldo.
      const skus = itens[0]?.skus ?? []
      const comPreco = skus.filter((s) => s.precoCentavos !== null)
      const casa = (s: { atributos: Record<string, string> }) => Object.values(s.atributos).filter((v) => t.includes(normalizar(String(v)))).length
      const sku = [...comPreco].sort((a, b) => casa(b) - casa(a) || Number(b.saldo !== 0) - Number(a.saldo !== 0))[0] ?? skus[0]
      if (!sku) return fim({ mensagens: [`Não encontrei "${m[2]!.trim()}" no catálogo. Pode me dizer de outro jeito, ou me conta o que você procura?`], confianca: 0.7, fase: 'descoberta' })
      const add = await chamar('pedido_itens', { acao: 'adicionar', skuId: sku.skuId, seq: null, quantidade: qtd })
      if (!add.ok) return fim({ mensagens: [`Não consegui incluir esse item: ${add.erro}. Quer tentar outro?`], confianca: 0.6, fase: 'recomendacao' })
      const s = add.saida as { totalCentavos?: number; situacao?: string }
      if (s.situacao && s.situacao !== 'ok') return fim({ mensagens: [`Não consegui incluir: ${s.situacao}. Posso ver outra opção?`], confianca: 0.6, fase: 'recomendacao' })
      return fim({ mensagens: [`Incluí ${qtd}x ${itens[0]!.produto}${Object.values(sku.atributos).length ? ` (${Object.values(sku.atributos).join(' ')})` : ''} no seu pedido.${typeof s.totalCentavos === 'number' ? ` Total até agora: ${brl(s.totalCentavos)}.` : ''}`, 'Quer adicionar mais alguma coisa ou fechamos?'], confianca: 0.9, fase: 'recomendacao' })
    }

    // 4. Pergunta de política → base de conhecimento.
    if (/\b(prazo|entrega|frete|pagamento|pix|cartao|boleto|troca|devolu|horario|funciona)\b/.test(t) && tem('conhecimento_buscar')) {
      const r = await chamar('conhecimento_buscar', { pergunta: texto })
      const trechos = r.ok ? ((r.saida as { trechos?: { texto: string }[] }).trechos ?? []) : []
      if (trechos.length) return fim({ mensagens: [trechos[0]!.texto.slice(0, 400)], confianca: 0.85, fase: 'descoberta' })
      if (tem('atendimento_transferir')) {
        await chamar('atendimento_transferir', { motivo: 'incerteza', resumo: `Pergunta sem resposta nas políticas: "${texto.slice(0, 120)}"` })
        return fim({ mensagens: ['Essa eu não tenho aqui — vou pedir para uma pessoa da equipe te responder.'], confianca: 0.5, fase: 'handoff', handoff: { motivo: 'incerteza', resumo: texto.slice(0, 200) } })
      }
    }

    // 5. Qualquer outra coisa com substância → busca no catálogo.
    if (texto.split(/\s+/).length >= 1 && tem('catalogo_buscar') && !/^(oi|ola|bom dia|boa tarde|boa noite|opa|e ai)[!. ]*$/.test(t)) {
      const busca = await chamar('catalogo_buscar', { consulta: texto, limite: null })
      const itens = (busca.ok ? (busca.saida as { itens?: { produto: string; skus: { atributos: Record<string, string>; precoCentavos: number | null }[] }[] }).itens : []) ?? []
      if (itens.length) {
        const linhas = itens.slice(0, 3).map((i) => {
          const com = i.skus.find((s) => s.precoCentavos !== null)
          return `${i.produto}${com && com.precoCentavos !== null ? ` — a partir de ${brl(com.precoCentavos)}` : ''}`
        })
        return fim({ mensagens: [`Encontrei estas opções:\n${linhas.join('\n')}`, 'Qual delas te interessa? Me diz a quantidade que eu já monto o pedido.'], confianca: 0.85, fase: 'recomendacao' })
      }
      return fim({ mensagens: [`Não encontrei nada com "${texto.slice(0, 60)}". Me conta um pouco mais do que você procura?`], confianca: 0.7, fase: 'descoberta' })
    }

    // 6. Saudação.
    return fim({ mensagens: [primeira ? 'Oi! Aqui é o atendimento automático da loja. Me conta o que você está procurando?' : 'Me conta o que você precisa que eu te ajudo.'], confianca: 0.9, fase: 'descoberta' })
  }
}

function normalizar(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
