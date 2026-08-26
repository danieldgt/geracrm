import type { PedidoDeTurno, PropostaDeTurno } from './porta.js'

/**
 * A INSTRUÇÃO e o ESQUEMA DE SAÍDA — iguais para todo fornecedor.
 *
 * ⚠️ Mora aqui porque há mais de um adaptador (Anthropic direto e OpenRouter), e
 * duas cópias do prompt divergiriam no primeiro ajuste. O sintoma seria o pior
 * possível: o agente se comportando de um jeito num cliente e de outro noutro,
 * dependendo de qual fornecedor estava configurado — e ninguém conseguindo
 * reproduzir o relato.
 *
 * ⚠️ **Nenhuma regra de negócio aqui.** Preço, pedido mínimo e prazo são
 * domínio. O que entra é o que o CLIENTE curou (políticas) e o que já sabemos
 * do lead. Regra escrita no prompt falha em silêncio e ninguém testa.
 */

/**
 * O esquema da resposta, em JSON Schema neutro. Cada adaptador embrulha isto no
 * formato do seu fornecedor (ferramenta da Anthropic, function da OpenAI).
 */
export const ESQUEMA_RESPOSTA = {
  nome: 'responder_ao_lead',
  descricao: 'Responde ao lead e propõe o próximo passo.',
  parametros: {
    type: 'object',
    properties: {
      texto: { type: 'string', description: 'A mensagem a enviar, em pt-BR, curta.' },
      proximoPasso: { type: 'string', enum: ['continuar', 'entregar', 'desistir'] },
      motivo: { type: 'string', description: 'Por que entregar ou desistir. Vazio se continuar.' },
      extraido: {
        type: 'object',
        description: 'Só o que o LEAD disse nesta conversa. Nunca deduza nem invente.',
        properties: {
          tipoCompra: { type: 'string', enum: ['consumo_final', 'revenda'] },
          cidade: { type: 'string' },
          volume: { type: 'string' },
          cnpj: { type: 'string' },
        },
      },
    },
    required: ['texto', 'proximoPasso'],
  },
} as const

export function instrucaoDeSistema(p: PedidoDeTurno): string {
  const l = p.lead
  const sabemos = [
    l.nome ? `Nome: ${l.nome}.` : null,
    l.jaEhCliente
      ? `JÁ É CLIENTE (${l.comprasNoUltimoAno} compras no último ano).`
      : 'Ainda não é cliente.',
    l.ultimaCompraEm ? `Última compra em ${l.ultimaCompraEm}.` : null,
    l.cidade ? `Cidade: ${l.cidade}.` : null,
    l.temCnpj ? 'CNPJ já cadastrado.' : null,
  ].filter(Boolean).join(' ')

  return [
    'Você atende no WhatsApp de uma loja, FORA DO HORÁRIO comercial.',
    'Seu papel é entender o que a pessoa precisa e preparar a entrega para um humano pela manhã.',
    '',
    'REGRAS:',
    `- Escreva em pt-BR, no máximo ${p.maxCaracteres} caracteres, tom de gente.`,
    '- NUNCA fale preço, prazo de entrega ou desconto que não esteja nas POLÍTICAS abaixo.',
    '- NUNCA prometa, feche pedido ou confirme disponibilidade.',
    '- NÃO pergunte o que já sabemos (abaixo). Pergunte só o que falta.',
    '- Se a pessoa pedir humano, reclamar, cobrar ou falar de problema com pedido: proximoPasso = entregar.',
    '- Se não souber responder pelas políticas: proximoPasso = entregar, com o motivo.',
    '- Em extraido, só o que a pessoa DISSE nesta conversa. Nunca deduza.',
    '',
    `O QUE JÁ SABEMOS: ${sabemos || 'nada além do contato.'}`,
    '',
    'POLÍTICAS DA LOJA:',
    p.politicas.trim(),
  ].join('\n')
}

/**
 * Normaliza o que veio da ferramenta, seja qual for o fornecedor.
 *
 * ⚠️ `proximoPasso` desconhecido vira `continuar`: não se confia no modelo para
 * decidir sair da conversa por um valor que a gente não reconhece.
 */
export function propostaDoRetorno(
  entrada: Record<string, unknown> | undefined,
): PropostaDeTurno | null {
  const texto = typeof entrada?.['texto'] === 'string' ? entrada['texto'].trim() : ''
  if (!texto) return null

  const passo = entrada?.['proximoPasso']
  return {
    texto,
    proximoPasso: passo === 'entregar' || passo === 'desistir' ? passo : 'continuar',
    motivo: typeof entrada?.['motivo'] === 'string' ? entrada['motivo'] : '',
    extraidoBruto: (entrada?.['extraido'] ?? {}) as Record<string, string | number | boolean | null>,
  }
}
