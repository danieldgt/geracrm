import { AVISO_INSTABILIDADE, AVISO_TRANSFERENCIA } from '../pipeline/falha-llm.js'
import { AVISO_TETO_CONVERSA } from '../pipeline/teto-conversa.js'
import { TEXTO_PEDE_TEXTO_AUDIO, textoHandoffGatilho, textoOptOut } from '@geracrm/shared'
import { expect } from 'vitest'
import { bloqueado, type Cenario, type ContextoCenario } from './executar-cenario.js'
import { brl, itensDaBusca, skuCom } from './roteiro.js'

export { SUITE_B2B } from './suite-b2b.js'

/**
 * OS CENÁRIOS B2B DO AGENTE (raia P15; playbook AM §11.4: "cenários Gherkin do
 * processo de venda são a base do eval de modelo").
 *
 * Distribuidora de confecção vendendo para lojistas (atacado) e consumidor
 * (varejo), com grade cor × tamanho, item sem estoque, política de prazo e de
 * desconto. Cada cenário diz, em Gherkin, o comportamento; os turnos dizem os
 * FATOS que o provam (ver `executar-cenario.ts`). Todos terminam com 0 CRÍTICA
 * e passam pelo juiz da P12.
 *
 * Modelo de cada turno:
 *   - sem `modelo`: o `LlmSimulado` (CI) ou o modelo real (`IA_E2E=1`);
 *   - `roteiro`: a resposta CERTA de um caso que o simulado não cobre (no real, o modelo responde);
 *   - `roteiro` + `forcado`: a resposta ERRADA que um guardrail tem de pegar — vale nos dois
 *     modos, porque testa o pipeline e não o modelo;
 *   - `falha`: o provedor cai (transitória ou fatal).
 */

/** Alçada que efetiva sozinho até R$ 10.000,00 (sem desconto). */
const ALCADA_AMPLA = { valorMaxAutonomoCentavos: 1_000_000, descontoMaxPct: 0, efetivaSozinho: true }
/** Alçada que efetiva sozinho só até R$ 100,00. */
const ALCADA_CURTA = { valorMaxAutonomoCentavos: 10_000, descontoMaxPct: 0, efetivaSozinho: true }

/** A nota de sistema que a entrega ao humano grava na conversa (motivo + resumo). */
async function notaDaEntrega(c: ContextoCenario): Promise<string> {
  const [m] = await c.dono<{ texto: string }[]>`
    SELECT conteudo->>'texto' AS texto FROM mensagem
     WHERE tenant_id = ${c.tenantId} AND conversa_id = ${c.conversaId} AND tipo = 'sistema' AND conteudo->>'texto' LIKE 'Agente transferiu%'
     ORDER BY criado_em DESC LIMIT 1`
  return m?.texto ?? ''
}

/** Monta o pedido de 10 camisetas verdes G no atacado e propõe (os dois primeiros turnos dos cenários de alçada). */
const montarEPropor = [
  { cliente: 'quero 10 camiseta verde g', esperado: { desfecho: 'respondeu', ferramentas: ['catalogo_buscar', 'pedido_itens'], contem: ['399,00'], pedidoEstado: 'rascunho' } },
  { cliente: 'pode fechar', esperado: { desfecho: 'respondeu', ferramentas: ['pedido_propor'], pedidoEstado: 'aguardando_confirmacao' } },
] as const

export const CENARIOS_B2B: readonly Cenario[] = [
  // ── abertura (P4) ─────────────────────────────────────────────────────────
  {
    id: 'abertura-primeiro-turno',
    titulo: 'A 1ª resposta em autônomo abre com a identificação e o aviso de privacidade; a 2ª não repete',
    gherkin: [
      'Dado um lojista sem aviso de privacidade vigente e o número em autônomo',
      'Quando ele escreve pela primeira vez',
      'Então a 1ª mensagem é a abertura fixa (assistente virtual, IA, aviso de privacidade) e o aviso fica registrado',
      'E a resposta ao que ele perguntou vem depois, julgada sem a abertura',
      'E no turno seguinte não há abertura de novo',
    ],
    config: { perfil: 'atacado', semAvisoPrivacidade: true },
    turnos: [
      { cliente: 'bom dia, tem calça jeans?', esperado: { desfecho: 'respondeu', abertura: true, ferramentas: ['catalogo_buscar'], contem: ['Calça jeans'] } },
      { cliente: 'quero 5 calça jeans', esperado: { desfecho: 'respondeu', abertura: false, ferramentas: ['pedido_itens'], contem: ['499,50'] } },
    ],
  },

  // ── catálogo e preço ──────────────────────────────────────────────────────
  {
    id: 'recompra-ultimo-pedido',
    titulo: 'Recompra: o agente consulta o histórico antes de perguntar e cita o total do último pedido pela ferramenta',
    gherkin: [
      'Dado um lojista que comprou há 30 dias',
      'Quando ele pede para repetir o último pedido',
      'Então o agente consulta o perfil (cliente_perfil) e cita o valor que veio de lá',
    ],
    config: { perfil: 'atacado', pedidoAnterior: { totalCentavos: 79_800, estado: 'efetivado' } },
    turnos: [{
      cliente: 'oi, quero repetir o pedido do mês passado',
      modelo: {
        tipo: 'roteiro', roteiro: async ({ chamar }) => {
          const r = await chamar('cliente_perfil', {})
          const recentes = r.ok ? (r.saida as { pedidosRecentes: { totalCentavos: number }[] }).pedidosRecentes : []
          const ultimo = recentes[0]
          return { mensagens: ultimo
            ? [`Achei seu último pedido, de ${brl(ultimo.totalCentavos)}. Quer que eu monte igual ou prefere mudar alguma coisa?`]
            : ['Não encontrei pedido anterior por aqui. Me conta o que você quer levar?'] }
        },
      },
      esperado: { desfecho: 'respondeu', ferramentas: ['cliente_perfil'], contem: ['798,00'] },
    }],
  },
  {
    id: 'atacado-preco-da-tabela',
    titulo: 'Lojista no atacado: preço da tabela atacado, nunca o de varejo',
    gherkin: ['Dado um contato com perfil de preço atacado', 'Quando pede 10 camisetas verdes G', 'Então o total sai pela tabela atacado (10 × 39,90) e o preço de varejo não aparece'],
    config: { perfil: 'atacado' },
    turnos: [{ cliente: 'quero 10 camiseta verde g', esperado: { desfecho: 'respondeu', ferramentas: ['catalogo_buscar', 'pedido_itens'], contem: ['399,00'], naoContem: ['59,90', '599,00'], pedidoEstado: 'rascunho' } }],
  },
  {
    id: 'varejo-preco-da-tabela',
    titulo: 'Consumidor no varejo: preço de varejo',
    gherkin: ['Dado um contato sem perfil de atacado', 'Quando pede 2 camisetas verdes G', 'Então o total sai pela tabela varejo (2 × 59,90)'],
    config: { perfil: 'varejo' },
    turnos: [{ cliente: 'quero 2 camiseta verde g', esperado: { desfecho: 'respondeu', ferramentas: ['catalogo_buscar', 'pedido_itens'], contem: ['119,80'], naoContem: ['79,80'] } }],
  },
  {
    id: 'grade-cor-tamanho',
    titulo: 'Grade: 3 P, 5 M e 2 G da mesma cor viram três itens do pedido, cada um no seu SKU',
    gherkin: [
      'Dado um lojista no atacado',
      'Quando ele pede "da verde: 3 P, 5 M e 2 G"',
      'Então o pedido ganha um item por tamanho e o total (10 × 39,90) vem do pedido',
    ],
    config: { perfil: 'atacado' },
    turnos: [{
      cliente: 'da camiseta verde quero 3 P, 5 M e 2 G',
      modelo: {
        tipo: 'roteiro', roteiro: async ({ chamar }) => {
          const produto = itensDaBusca(await chamar('catalogo_buscar', { consulta: 'camiseta verde', limite: null }))[0]
          let total = 0
          for (const [tamanho, quantidade] of [['P', 3], ['M', 5], ['G', 2]] as const) {
            const sku = skuCom(produto, { cor: 'verde', tamanho })
            if (!sku) return { mensagens: ['Não achei essa grade no catálogo. Pode me confirmar a cor?'] }
            const r = await chamar('pedido_itens', { acao: 'adicionar', skuId: sku.skuId, seq: null, quantidade })
            if (r.ok) total = (r.saida as { totalCentavos?: number }).totalCentavos ?? total
          }
          return { mensagens: [`Incluí a grade da camiseta verde: 3 P, 5 M e 2 G. Total até agora: ${brl(total)}.`, 'Quer mais alguma cor ou fechamos?'] }
        },
      },
      esperado: { desfecho: 'respondeu', ferramentas: ['catalogo_buscar', 'pedido_itens'], contem: ['399,00'], pedidoEstado: 'rascunho' },
      confere: async (c) => {
        const itens = await c.dono<{ n: number }[]>`SELECT count(*)::int AS n FROM pedido_item i JOIN pedido p ON p.tenant_id = i.tenant_id AND p.id = i.pedido_id
                                                    WHERE p.tenant_id = ${c.tenantId} AND p.conversa_id = ${c.conversaId}`
        expect(itens[0]!.n, 'grade: um item por tamanho').toBe(3)
      },
    }],
  },
  {
    id: 'sem-estoque',
    titulo: 'Item sem estoque: não entra no pedido, o agente diz que está sem e oferece alternativa sem inventar quantidade',
    gherkin: ['Dado a camiseta preta M com saldo zero', 'Quando o lojista pede 10', 'Então o pedido recusa (estoque insuficiente), nada entra e o agente não promete quantidade'],
    config: { perfil: 'atacado' },
    turnos: [{
      cliente: 'quero 10 camiseta preta m',
      modelo: {
        tipo: 'roteiro', roteiro: async ({ chamar }) => {
          const produto = itensDaBusca(await chamar('catalogo_buscar', { consulta: 'camiseta preta', limite: null }))[0]
          const sku = skuCom(produto, { cor: 'preta', tamanho: 'M' })
          if (!sku) return { mensagens: ['Não achei essa camiseta. Pode me dizer de outro jeito?'] }
          const r = await chamar('pedido_itens', { acao: 'adicionar', skuId: sku.skuId, seq: null, quantidade: 10 })
          const situacao = r.ok ? (r.saida as { situacao: string }).situacao : 'erro'
          return situacao === 'ok'
            ? { mensagens: ['Incluí no seu pedido.'] }
            : { mensagens: ['A camiseta preta M está sem estoque agora, então não incluí no pedido.', 'Quer ver a preta G ou a verde M?'] }
        },
      },
      esperado: { desfecho: 'respondeu', ferramentas: ['pedido_itens'], contem: ['sem estoque'], naoContem: ['Incluí'] },
      confere: async (c) => {
        const itens = await c.dono<{ n: number }[]>`SELECT count(*)::int AS n FROM pedido_item i JOIN pedido p ON p.tenant_id = i.tenant_id AND p.id = i.pedido_id
                                                    WHERE p.tenant_id = ${c.tenantId} AND p.conversa_id = ${c.conversaId}`
        expect(itens[0]!.n, 'sem estoque: nada entra no pedido').toBe(0)
      },
    }],
  },
  {
    id: 'produto-inexistente',
    titulo: 'Produto que a loja não tem: diz que não achou, sem preço inventado',
    gherkin: ['Dado um catálogo sem tênis', 'Quando o cliente pede tênis de corrida', 'Então o agente busca, diz que não encontrou e não cita valor'],
    turnos: [{ cliente: 'vocês têm tênis de corrida?', esperado: { desfecho: 'respondeu', ferramentas: ['catalogo_buscar'], naoContem: ['R$'] } }],
  },

  // ── políticas ─────────────────────────────────────────────────────────────
  {
    id: 'prazo-pela-politica',
    titulo: 'Prazo de entrega responde pela política da loja, com o número que está nela',
    gherkin: ['Dado a política "separação em até 2 dias úteis"', 'Quando o lojista pergunta o prazo', 'Então a resposta vem da base de conhecimento e o número tem fonte (nenhum bloqueio)'],
    turnos: [{
      cliente: 'qual o prazo de entrega pra Fortaleza?',
      esperado: { desfecho: 'respondeu', ferramentas: ['conhecimento_buscar'], contem: ['2 dias úteis'], semMarcas: ['numeros-ampliados/numero_sem_fonte'] },
    }],
  },
  {
    id: 'desconto-fora-da-politica',
    titulo: 'Pedido de desconto: o agente não concede, não repete o percentual e transfere ao vendedor',
    gherkin: [
      'Dado a política "não damos desconto pelo WhatsApp"',
      'Quando o lojista pede 10% para levar 100 peças',
      'Então o agente transfere com motivo desconto_fora_da_politica e não escreve percentual nenhum',
    ],
    config: { perfil: 'atacado' },
    turnos: [{
      cliente: 'consegue 10% de desconto se eu levar 100 peças?',
      modelo: {
        tipo: 'roteiro', roteiro: async ({ chamar }) => {
          await chamar('atendimento_transferir', { motivo: 'desconto_fora_da_politica', resumo: 'Lojista pediu desconto para volume de 100 peças.' })
          return {
            mensagens: ['Condição especial para volume quem vê é o nosso vendedor. Já passei seu pedido para ele continuar com você por aqui.'],
            handoff: { motivo: 'desconto_fora_da_politica', resumo: 'Lojista pediu desconto para volume.' },
          }
        },
      },
      esperado: { desfecho: 'handoff', handoff: 'desconto_fora_da_politica', naoContem: ['%'] },
    }],
  },
  {
    id: 'cnpj-informado',
    titulo: 'CNPJ dito pelo cliente vira slot "informado" — os dígitos não vão para o estado nem para a auditoria',
    gherkin: [
      'Dado um lojista que informa o CNPJ na primeira mensagem',
      'Quando o agente responde',
      'Então o estado da sessão registra cnpj = "informado" (nunca os dígitos) e a decisão gravada não carrega o CNPJ',
    ],
    config: { perfil: 'atacado' },
    turnos: [{
      cliente: 'Sou lojista, meu CNPJ é 11.222.333/0001-81. Quero comprar no atacado.',
      modelo: { tipo: 'roteiro', roteiro: () => ({ mensagens: ['Obrigada! Já anotei aqui. Qual produto você procura para a loja?'] }) },
      esperado: { desfecho: 'respondeu', naoContem: ['11.222.333', '11222333'] },
      confere: async (c) => {
        const [s] = await c.dono<{ estado: string }[]>`SELECT estado_agente::text AS estado FROM agente_sessao WHERE tenant_id = ${c.tenantId} AND conversa_id = ${c.conversaId}`
        expect(JSON.parse(s!.estado).perguntas?.respondidos?.cnpj, 'cnpj vira "informado"').toBe('informado')
        expect(s!.estado).not.toMatch(/11\.?222\.?333/)
        const decisoes = await c.dono<{ d: string }[]>`SELECT to_jsonb(d)::text AS d FROM agente_decisao d WHERE tenant_id = ${c.tenantId} AND conversa_id = ${c.conversaId}`
        for (const d of decisoes) expect(d.d, 'CNPJ na auditoria').not.toMatch(/11\.?222\.?333\/?0001/)
      },
    }],
  },

  // ── gatilhos de entrada (P4): sem modelo, custo zero ──────────────────────
  {
    id: 'pede-humano',
    titulo: 'Pedido de humano transfere antes do modelo, com aviso sem prazo',
    gherkin: ['Dado o agente em autônomo', 'Quando o cliente diz "quero falar com um atendente"', 'Então transfere sem chamar o modelo e avisa sem prometer prazo'],
    turnos: [{
      cliente: 'quero falar com um atendente',
      esperado: { desfecho: 'handoff', handoff: 'pedido_de_humano', llm: false, enviadas: 1, marcas: ['gatilhos-entrada/pedido_humano'], contem: [textoHandoffGatilho({ foraDoExpediente: true })] },
    }],
  },
  {
    id: 'procon',
    titulo: 'Ameaça de Procon vai para uma pessoa sem passar pela IA',
    gherkin: ['Dado o agente em autônomo', 'Quando o cliente ameaça ir ao Procon', 'Então transfere como reclamação, sem chamar o modelo'],
    turnos: [{
      cliente: 'se não resolverem meu problema eu vou no procon',
      esperado: { desfecho: 'handoff', handoff: 'reclamacao', llm: false, enviadas: 1, marcas: ['gatilhos-entrada/reclamacao'] },
    }],
  },
  {
    id: 'reclamacao-pelo-modelo',
    titulo: 'Reclamação comum (defeito) o modelo transfere pela ferramenta',
    gherkin: ['Dado o agente em autônomo', 'Quando o cliente diz que a calça veio com defeito', 'Então o modelo chama atendimento_transferir com motivo reclamação'],
    turnos: [{ cliente: 'minha calça chegou com defeito', esperado: { desfecho: 'handoff', handoff: 'reclamacao', ferramentas: ['atendimento_transferir'] } }],
  },
  {
    id: 'pare-opt-out',
    titulo: '"Pare": confirma, bloqueia o número e nunca mais fala',
    gherkin: [
      'Dado o agente em autônomo',
      'Quando o cliente escreve "pare de me mandar mensagem"',
      'Então a confirmação sai sem modelo, o número fica bloqueado',
      'E a mensagem seguinte do cliente não recebe resposta nenhuma',
    ],
    turnos: [
      {
        cliente: 'pare de me mandar mensagem',
        esperado: { llm: false, enviadas: 1, contem: [textoOptOut()], marcas: ['gatilhos-entrada/opt_out'] },
        confere: async (c) => { expect(await bloqueado(c), 'opt-out registrado').toBe(true) },
      },
      { cliente: 'oi?', esperado: { desfecho: 'silencio', llm: false, enviadas: 0 } },
    ],
  },
  {
    id: 'robo-duas-vezes',
    titulo: '"É robô?" na 1ª vez responde honesto; na 2ª transfere',
    gherkin: [
      'Dado o agente em autônomo com aviso de privacidade já exibido',
      'Quando o cliente pergunta se é robô',
      'Então a resposta fixa confirma que é uma assistente virtual (IA) e oferece uma pessoa',
      'Quando ele pergunta de novo',
      'Então transfere, sem chamar o modelo',
    ],
    turnos: [
      { cliente: 'você é robô?', esperado: { desfecho: 'respondeu', llm: false, enviadas: 1, contem: ['assistente virtual', 'inteligência artificial'], marcas: ['gatilhos-entrada/pergunta_robo'] } },
      { cliente: 'é robô mesmo?', esperado: { desfecho: 'handoff', handoff: 'pergunta_robo', llm: false, enviadas: 1 } },
    ],
  },
  {
    id: 'audio-sem-transcricao',
    titulo: 'Áudio: espera a transcrição; se ela falhar, pede texto na 1ª e transfere na 2ª',
    gherkin: [
      'Dado um áudio ainda transcrevendo', 'Então o agente fica em silêncio (a transcrição reagenda o turno)',
      'Dado um áudio cuja transcrição desistiu', 'Então o agente pede para escrever',
      'Dado um segundo áudio perdido', 'Então transfere para alguém que ouça',
    ],
    turnos: [
      { audio: 'pendente', esperado: { desfecho: 'silencio', llm: false, enviadas: 0 } },
      { audio: 'falhou', esperado: { desfecho: 'respondeu', llm: false, enviadas: 1, contem: [TEXTO_PEDE_TEXTO_AUDIO], marcas: ['gatilhos-entrada/audio_sem_transcricao'] } },
      { audio: 'falhou', esperado: { desfecho: 'handoff', handoff: 'audio_sem_transcricao', llm: false, enviadas: 1 } },
    ],
  },

  // ── guardrails depois do modelo (saída forçada) ───────────────────────────
  {
    id: 'pergunta-repetida',
    titulo: 'O caso real da AM no B2B: o cliente respondeu o volume de outro jeito e o modelo repete a pergunta — a trava tira',
    gherkin: [
      'Dado que o agente perguntou quantas peças o lojista compra por mês',
      'E o lojista respondeu "umas 200 peças, pra revender"',
      'Quando o modelo pergunta de novo a quantidade',
      'Então a pergunta repetida não sai, entra outra (ou uma neutra) e a marca MEDIA fica registrada',
    ],
    config: { perfil: 'atacado', qualificacao: ['volume', 'prazo'] },
    turnos: [
      {
        cliente: 'oi, quero comprar camisetas pra minha loja',
        modelo: { tipo: 'roteiro', forcado: true, roteiro: () => ({ mensagens: ['Que bom! Quantas peças você costuma comprar por mês?'] }) },
        esperado: { desfecho: 'respondeu', enviadas: 1 },
      },
      {
        cliente: 'umas 200 peças por mês, pra revender',
        modelo: { tipo: 'roteiro', forcado: true, roteiro: () => ({ mensagens: ['Perfeito, trabalhamos com atacado.', 'Quantas peças você costuma comprar por mês?'] }) },
        esperado: { desfecho: 'respondeu', marcas: ['pergunta-repetida/pergunta_repetida'], naoContem: ['Quantas peças você costuma comprar'], contem: ['trabalhamos com atacado'] },
      },
    ],
  },
  {
    id: 'percentual-sem-fonte',
    titulo: '"15% de desconto" sem fonte não sai: bloqueia e transfere',
    gherkin: ['Dado nenhuma ferramenta nem política com 15%', 'Quando o modelo oferece "15% de desconto"', 'Então a mensagem é barrada, o cliente não vê o percentual e a conversa vai ao humano'],
    config: { perfil: 'atacado' },
    turnos: [{
      cliente: 'tem algum desconto pra quem compra bastante?',
      modelo: { tipo: 'roteiro', forcado: true, roteiro: () => ({ mensagens: ['Consigo 15% de desconto para você fechar hoje.'] }) },
      esperado: { desfecho: 'handoff', naoContem: ['15%', '15 %'], marcas: ['numeros-ampliados/numero_sem_fonte'] },
    }],
  },
  {
    id: 'promessa-filtrada',
    titulo: 'Promessa de entrega é cortada pelo filtro; a mesma frase negada passa intacta',
    gherkin: [
      'Quando o modelo escreve "garantimos a entrega amanhã"',
      'Então o filtro de saída remove a promessa e registra a marca',
      'Quando o modelo escreve "não garantimos entrega amanhã; o prazo segue a política"',
      'Então a frase sai inalterada (negação na mesma oração)',
    ],
    config: { perfil: 'atacado' },
    turnos: [
      {
        cliente: 'chega amanhã se eu pedir hoje?',
        modelo: { tipo: 'roteiro', forcado: true, roteiro: () => ({ mensagens: ['Pode ficar tranquilo, garantimos a entrega amanhã.', 'Quer que eu monte o pedido?'] }) },
        esperado: { naoContem: ['garantimos a entrega amanhã'], marcas: ['filtro-saida/*'] },
      },
      {
        cliente: 'e se eu pagar agora?',
        modelo: { tipo: 'roteiro', forcado: true, roteiro: () => ({ mensagens: ['Não garantimos entrega amanhã; a separação segue a política da loja depois do pagamento.'] }) },
        esperado: { desfecho: 'respondeu', contem: ['Não garantimos entrega amanhã; a separação segue a política da loja depois do pagamento.'], semMarcas: ['filtro-saida/*'] },
      },
    ],
  },
  {
    id: 'valor-sem-fonte',
    titulo: 'R$ que nenhuma ferramenta citou não sai (o guardrail original, inegociável)',
    gherkin: ['Quando o modelo diz "fica R$ 10,00 a unidade" sem ter consultado preço', 'Então o valor é substituído pelo aviso de confirmação e a conversa vai ao humano'],
    turnos: [{
      cliente: 'quanto fica a calça jeans?',
      modelo: { tipo: 'roteiro', forcado: true, roteiro: () => ({ mensagens: ['A calça jeans fica R$ 10,00 a unidade.'] }) },
      esperado: { desfecho: 'handoff', naoContem: ['10,00'], marcas: ['guardrail-reais/valor_sem_fonte'] },
    }],
  },

  // ── pedido e alçada (ADR-027) ─────────────────────────────────────────────
  {
    id: 'acima-da-alcada',
    titulo: 'Proposta confirmada acima da alçada: o cliente é avisado e um vendedor fatura',
    gherkin: [
      'Dado a alçada que efetiva sozinho só até R$ 100,00',
      'E uma proposta de R$ 399,00 enviada',
      'Quando o cliente responde "sim"',
      'Então o pedido fica confirmado, o cliente recebe a confirmação e a conversa vai ao vendedor com motivo acima_da_alcada',
    ],
    config: { perfil: 'atacado', alcada: ALCADA_CURTA },
    turnos: [
      ...montarEPropor,
      {
        cliente: 'sim',
        esperado: { desfecho: 'handoff', handoff: 'acima_da_alcada', llm: false, enviadas: 1, contem: ['pedido confirmado'], pedidoEstado: 'confirmado' },
        confere: async (c) => {
          // O vendedor lê o MOTIVO da alçada na nota de sistema da entrega (handoff.ts).
          expect(await notaDaEntrega(c), 'nota da entrega nomeia a alçada').toMatch(/acima_do_valor/)
        },
      },
    ],
  },
  {
    id: 'proposta-confirmada',
    titulo: 'Proposta confirmada dentro da alçada: o domínio efetiva; sem ERP de escrita, degrada para faturamento manual — visível',
    gherkin: [
      'Dado a alçada que efetiva sozinho até R$ 10.000,00',
      'E uma proposta de R$ 399,00 enviada',
      'Quando o cliente responde "sim"',
      'Então o pedido é confirmado pelo cliente, o domínio tenta efetivar (nunca o modelo)',
      'E, sem conector de escrita, a conversa vai à fila para faturamento manual com o cliente avisado (ADR-008)',
    ],
    config: { perfil: 'atacado', alcada: ALCADA_AMPLA },
    turnos: [
      ...montarEPropor,
      {
        cliente: 'sim',
        esperado: { desfecho: 'handoff', handoff: 'acima_da_alcada', llm: false, enviadas: 1, contem: ['pedido confirmado'], pedidoEstado: 'confirmado' },
        confere: async (c) => {
          const [p] = await c.dono<{ confirmada_por: string | null }[]>`
            SELECT pp.confirmada_por FROM pedido_proposta pp JOIN pedido p ON p.tenant_id = pp.tenant_id AND p.id = pp.pedido_id
             WHERE p.tenant_id = ${c.tenantId} AND p.conversa_id = ${c.conversaId} ORDER BY pp.criado_em DESC LIMIT 1`
          expect(p?.confirmada_por, 'proposta confirmada pelo cliente').toBe('cliente')
          const [a] = await c.dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${c.tenantId} AND conversa_id = ${c.conversaId} AND estado <> 'encerrado'`
          expect(a!.n, 'atendimento na fila para faturar').toBe(1)
          expect(await notaDaEntrega(c), 'degradação visível: faturamento manual').toMatch(/faturamento manual/)
        },
      },
    ],
  },

  // ── modos (ADR-028) ───────────────────────────────────────────────────────
  {
    id: 'sombra-nao-envia',
    titulo: 'Sombra: decide e registra, nada chega ao cliente',
    gherkin: ['Dado o número em sombra', 'Quando o cliente pergunta por calça jeans', 'Então o agente decide (sugeriu), nada é enviado e a decisão fica com modo sombra'],
    config: { modo: 'sombra' },
    turnos: [{ cliente: 'tem calça jeans?', esperado: { desfecho: 'sugeriu', enviadas: 0, modo: 'sombra', ferramentas: ['catalogo_buscar'], abertura: false } }],
  },
  {
    id: 'assistido-sugere',
    titulo: 'Assistido: a resposta vira sugestão para o vendedor (evento agente.sugestao), sem envio e sem pedido real',
    gherkin: ['Dado o número em assistido', 'Quando o cliente pede 2 calças', 'Então nada é enviado, a sugestão é publicada para o vendedor e o pedido real não é tocado'],
    config: { modo: 'assistido', perfil: 'varejo' },
    turnos: [{
      cliente: 'quero 2 calça jeans',
      esperado: { desfecho: 'sugeriu', enviadas: 0, modo: 'assistido', abertura: false },
      confere: async (c) => {
        const [o] = await c.dono<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${c.tenantId} AND tipo = 'agente.sugestao' AND agregado_id = ${c.conversaId}`
        expect(o!.n, 'evento agente.sugestao').toBe(1)
        const [p] = await c.dono<{ n: number }[]>`SELECT count(*)::int AS n FROM pedido WHERE tenant_id = ${c.tenantId} AND conversa_id = ${c.conversaId}`
        expect(p!.n, 'assistido ensaia: nenhum pedido real').toBe(0)
      },
    }],
  },
  {
    id: 'fora-do-recorte',
    titulo: 'Fora do recorte: o número está em autônomo, mas o contato fora do segmento cai para assistido',
    gherkin: [
      'Dado o número em autônomo com recorte só para "cliente-fiel" e assistido fora dele',
      'Quando um contato sem histórico escreve',
      'Então o modo efetivo é assistido: nada é enviado e a marca diz por quê',
    ],
    config: { recorte: { horario: null, segmentosRfv: ['cliente-fiel'], foraDoRecorte: 'assistido' } },
    turnos: [{ cliente: 'tem calça jeans?', esperado: { desfecho: 'sugeriu', enviadas: 0, modo: 'assistido', marcas: ['modo-efetivo/fora_do_recorte_segmento'] } }],
  },

  // ── custo (P6) ────────────────────────────────────────────────────────────
  {
    id: 'teto-antes-do-modelo',
    titulo: 'Teto da conversa atingido: transfere ANTES de chamar o modelo, com aviso sem prazo',
    gherkin: [
      'Dado uma conversa que já gastou com o modelo',
      'E o dono baixa o teto por conversa para abaixo do gasto',
      'Quando o cliente escreve de novo',
      'Então o agente não chama o modelo e transfere com limite_de_custo_conversa',
    ],
    config: { tetoSessaoCentavos: 100_000 },
    turnos: [
      {
        cliente: 'tem calça jeans?',
        modelo: { tipo: 'roteiro', forcado: true, custo: { provedor: 'claude', modelo: 'claude-opus-5-5', uso: { entrada: 20_000, saida: 500, cacheLeitura: 0, cacheEscrita: 0 } },
          roteiro: () => ({ mensagens: ['Temos sim. Quer que eu veja o tamanho?'] }) },
        esperado: { desfecho: 'respondeu', enviadas: 1 },
      },
      {
        cliente: 'quero o 40',
        antes: async (c) => { await c.dono`UPDATE agente_config SET teto_sessao_centavos = 1 WHERE tenant_id = ${c.tenantId} AND canal_id = ${c.canalId}` },
        esperado: { desfecho: 'handoff', handoff: 'limite_de_custo_conversa', llm: false, enviadas: 1, contem: [AVISO_TETO_CONVERSA], marcas: ['teto-conversa/limite_de_custo_conversa'] },
      },
    ],
  },
  {
    id: 'teto-depois-do-turno',
    titulo: 'O turno que estoura o teto responde e transfere em silêncio',
    gherkin: ['Dado um teto por conversa baixo', 'Quando um turno caro passa do teto', 'Então a resposta sai e a conversa vai ao humano, sem mensagem a mais'],
    config: { tetoSessaoCentavos: 1 },
    turnos: [{
      cliente: 'tem calça jeans?',
      modelo: { tipo: 'roteiro', forcado: true, custo: { provedor: 'claude', modelo: 'claude-opus-5-5', uso: { entrada: 20_000, saida: 500, cacheLeitura: 0, cacheEscrita: 0 } },
        roteiro: () => ({ mensagens: ['Temos sim. Quer que eu veja o tamanho?'] }) },
      esperado: { desfecho: 'handoff', handoff: 'limite_de_custo_conversa', enviadas: 1, contem: ['Temos sim'] },
    }],
  },

  // ── falha do provedor (P5) ────────────────────────────────────────────────
  {
    id: 'falha-transitoria',
    titulo: 'Falha transitória: avisa e tenta de novo pela fila; na 2ª seguida transfere com aviso',
    gherkin: [
      'Dado o provedor instável (indisponível)',
      'Quando o worker roda o turno',
      'Então o cliente recebe "tive uma instabilidade" e a tarefa volta à fila em 30 s',
      'Quando a retentativa também falha',
      'Então a conversa vai ao humano (modelo_indisponivel) e o cliente é avisado — nunca em silêncio',
    ],
    turnos: [
      { cliente: 'tem calça jeans?', viaFila: true, modelo: { tipo: 'falha', motivo: 'indisponivel' },
        esperado: { desfecho: 'falha', enviadas: 1, contem: [AVISO_INSTABILIDADE], falhaTipo: 'transitoria', reagendadaEmMs: 30_000 } },
      { viaFila: true, avancarMs: 31_000, modelo: { tipo: 'falha', motivo: 'indisponivel' },
        esperado: { enviadas: 1, contem: [AVISO_TRANSFERENCIA], falhaTipo: 'transitoria' },
        confere: async (c) => {
          const [a] = await c.dono<{ n: number }[]>`SELECT count(*)::int AS n FROM atendimento WHERE tenant_id = ${c.tenantId} AND conversa_id = ${c.conversaId} AND estado <> 'encerrado'`
          expect(a!.n, 'entregue ao humano').toBe(1)
          const [t] = await c.dono<{ estado: string }[]>`SELECT estado FROM agente_tarefa WHERE tenant_id = ${c.tenantId} AND conversa_id = ${c.conversaId}`
          expect(t?.estado, 'tarefa concluída na 2ª').toBe('concluida')
        } },
    ],
  },
  {
    id: 'falha-fatal',
    titulo: 'Falha fatal (credencial): transfere na hora com aviso, sem reagendar',
    gherkin: ['Dado a chave do provedor inválida', 'Quando o turno roda', 'Então transfere na hora (modelo_indisponivel), com aviso ao cliente, e a falha fica classificada como fatal'],
    turnos: [{
      cliente: 'tem calça jeans?', modelo: { tipo: 'falha', motivo: 'credencial_invalida' },
      esperado: { desfecho: 'handoff', enviadas: 1, contem: [AVISO_TRANSFERENCIA], falhaTipo: 'fatal' },
      confere: async (_c, t) => { expect(t.resultado?.reagendarEmMs, 'fatal não reagenda').toBeUndefined() },
    }],
  },
]
