import type { Suite } from './executar-cenario.js'

/**
 * A LOJA DOS CENÁRIOS B2B (dados puros, sem IO): distribuidora de confecção em
 * Fortaleza vendendo para lojistas (atacado) e consumidor (varejo), com grade
 * cor × tamanho, item sem estoque e políticas de prazo e desconto.
 *
 * Usada pelos evals (`cenarios-b2b.ts`) e como configuração de referência do
 * `agente:medir-prefixo` — por isso fica fora dos arquivos que importam o vitest.
 */
export const SUITE_B2B: Suite = {
  nome: 'b2b',
  tenantId: 'e7a15000-0000-4000-8000-000000000001',
  persona: { nome: 'Dora', loja: 'Distribuidora Dourada' },
  catalogo: [
    {
      referencia: 'CAM-100', descricao: 'Camiseta básica algodão', categoria: 'Camisetas', descricaoLonga: 'Camiseta 100% algodão, gola redonda. Grade P, M e G.',
      skus: [
        { atributos: { cor: 'verde', tamanho: 'P' }, precos: { varejo: 5990, atacado: 3990 }, saldo: 40 },
        { atributos: { cor: 'verde', tamanho: 'M' }, precos: { varejo: 5990, atacado: 3990 }, saldo: 60 },
        { atributos: { cor: 'verde', tamanho: 'G' }, precos: { varejo: 5990, atacado: 3990 }, saldo: 120 },
        { atributos: { cor: 'preta', tamanho: 'M' }, precos: { varejo: 5990, atacado: 3990 }, saldo: 0 },
        { atributos: { cor: 'preta', tamanho: 'G' }, precos: { varejo: 5990, atacado: 3990 }, saldo: 8 },
      ],
    },
    {
      referencia: 'CAL-200', descricao: 'Calça jeans skinny', categoria: 'Calças',
      skus: [{ atributos: { cor: 'azul escuro', tamanho: '40' }, precos: { varejo: 15990, atacado: 9990 }, saldo: 50 }],
    },
    {
      referencia: 'MEI-300', descricao: 'Meia cano alto pacote com 12', categoria: 'Meias',
      skus: [{ atributos: { cor: 'branca' }, precos: { varejo: 4990, atacado: 2990 }, saldo: 0 }],
    },
  ],
  politicas: [
    'SOBRE A LOJA',
    'Somos a Distribuidora Dourada, em Fortaleza/CE. Vendemos confecção no atacado para lojistas e no varejo.',
    '',
    'PRAZO DE ENTREGA',
    'Separação em até 2 dias úteis após a confirmação do pagamento. A transportadora entrega no Nordeste em 5 a 8 dias úteis.',
    '',
    'PAGAMENTO',
    'PIX e cartão de crédito. Boleto só para CNPJ com cadastro aprovado pelo financeiro.',
    '',
    'DESCONTO',
    'Não damos desconto pelo WhatsApp. Condição especial para volume é com o vendedor.',
    '',
    'O QUE NÃO RESPONDEMOS POR AQUI',
    'Reclamação, nota fiscal e cobrança: sempre com uma pessoa.',
  ].join('\n'),
}
