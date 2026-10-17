import {
  ajustarMensagemHandoff, complianceEfetivo, filtrarSaida, lerComplianceExtra, lerPlaybookVigente,
  limitesDoPlaybook, mencionaQuemRetoma, LIMITES_COMPLIANCE, TEXTO_RETOMADA,
} from '@geracrm/shared'
import type { EtapaPosResposta, MarcaGuardrail } from './tipos.js'
import { marca } from './tipos.js'

const ETAPA = 'filtro-saida'

/** Quando o filtro removeu a resposta inteira: o cliente sabe que alguém confirma, sem prazo. */
export const MENSAGEM_FILTRO_ESVAZIOU =
  'Vou pedir para um vendedor da equipe confirmar essa informação com você por aqui, neste mesmo número.'

/**
 * FILTRO DE SAÍDA COM NEGAÇÃO (raia P2; ADR-029 §3).
 *
 * Para cada mensagem: `filtrarSaida` com a lista BASE B2B do código +
 * as frases EXTRAS do número (`agente_config.compliance`, lido a cada turno —
 * mudou na tela, vale no turno seguinte). Frase proibida → removida (marca
 * CRITICA 'removido'); hesitação em afirmação de negócio → frase removida (ALTA);
 * outras hesitações → 'reescrito'/'registrado'; nota obrigatória → 'anexado'.
 *
 * - Mensagem que ficou vazia sai do lote. Se TODAS ficaram vazias, a cadeia
 *   BLOQUEIA: nada do que o modelo escreveu sobrou, então a conversa vai ao
 *   humano (`incerteza`) com uma mensagem fixa, sem prazo.
 * - Com `handoff`, `ajustarMensagemHandoff`: sai promessa de prazo, sai número
 *   de negócio quando nenhum veio de fonte no turno, e o cliente fica sabendo
 *   que alguém da equipe retoma por aqui (anexado na última mensagem).
 *
 * Vale em todo modo: a etapa não olha `ctx.modo` (a sugestão do assistido e a
 * decisão da sombra/simulação saem filtradas e com as marcas).
 *
 * PLAYBOOK (P17, leitura tolerante de `cfgExtra.playbook` — o espelho da
 * versão publicada): as frases proibidas do playbook SOMAM às do número (só
 * acrescentam), e o estilo vira `limites` de `filtrarSaida` — máximo de
 * caracteres e de perguntas por mensagem são APLICADOS aqui, não só pedidos no
 * prompt. ⚠️ O PREFIXO do sistema (abertura: identificação como assistente +
 * aviso de privacidade) também passa por aqui e NÃO leva limite — isenção pela
 * origem (`entrada.prefixo`), nunca por reconhecer o texto.
 */
export const etapaFiltroSaida: EtapaPosResposta = {
  nome: ETAPA,
  async executar(ctx, entrada) {
    const playbook = lerPlaybookVigente(ctx.cfgExtra['playbook'])?.conteudo
    const compliance = complianceEfetivo(lerComplianceExtra(ctx.cfgExtra['compliance']), playbook)
    const limites = limitesDoPlaybook(playbook)
    const guardrails: MarcaGuardrail[] = []
    // Número + playbook passam de duas listas cheias (não deveria, a validação limita):
    // o excedente não vale, e isso fica registrado — nunca cortado em silêncio.
    if (compliance.frasesProibidas.length > LIMITES_COMPLIANCE.maxItens * 2) {
      guardrails.push(marca(ETAPA, 'compliance_cortado', 'INFO', 'registrado', `${compliance.frasesProibidas.length} frases extras; valem ${LIMITES_COMPLIANCE.maxItens * 2}`))
    }
    // Escassez ("poucas unidades") só é verdade com saldo BAIXO de ferramenta
    // de catálogo/estoque NESTE turno (`saldoBaixoVisto`: 0 < saldo ≤
    // LIMIAR_ESCASSEZ, do registro de ferramentas). Saldo 0 ou alto desmente a frase. ⚠️ Um número qualquer de fonte (preço, prazo) não abona:
    // ausente ou false = escassez vetada (fail-closed).
    const estoqueComFonte = entrada.saldoBaixoVisto === true
    let mensagens: string[] = []
    for (const m of entrada.mensagens) {
      const comLimites = Object.keys(limites).length > 0 && entrada.prefixo !== true
      const r = filtrarSaida(m, { extras: compliance.frasesProibidas, estoqueComFonte, ...(comLimites ? { limites } : {}) })
      for (const o of r.ocorrencias) guardrails.push(marca(ETAPA, o.id, o.gravidade, o.acao, o.trecho))
      if (!r.esvaziado) mensagens.push(r.texto)
    }

    if (mensagens.length === 0 && entrada.mensagens.length > 0) {
      guardrails.push(marca(ETAPA, 'resposta_esvaziada', 'CRITICA', 'bloqueado'))
      return {
        mensagens: [], guardrails,
        bloquear: {
          motivo: 'incerteza',
          resumo: 'O filtro de saída removeu a resposta inteira do agente (frases proibidas); confirme a informação com o cliente.',
          mensagensSubstitutas: [MENSAGEM_FILTRO_ESVAZIOU],
        },
      }
    }

    if (entrada.handoff) {
      const semNumeros = entrada.centavosVistos.size === 0 && entrada.numerosVistos.size === 0
      const ajustadas: string[] = []
      for (const m of mensagens) {
        const a = ajustarMensagemHandoff(m, { semNumeros, anexarRetomada: false })
        for (const o of a.ocorrencias) guardrails.push(marca(ETAPA, o.id, o.gravidade, o.acao, o.trecho))
        if (a.texto) ajustadas.push(a.texto)
      }
      if (!ajustadas.some(mencionaQuemRetoma)) {
        guardrails.push(marca(ETAPA, 'retomada_handoff', 'INFO', 'anexado'))
        const ultima = ajustadas.pop()
        ajustadas.push(ultima ? `${ultima} ${TEXTO_RETOMADA}` : TEXTO_RETOMADA)
      }
      mensagens = ajustadas
    }

    return { mensagens, guardrails }
  },
}

