import { conformidade } from '../conformidade.js'
import { ConectorGeraCloud } from './conector.js'

/**
 * O GeraCloud passa pela mesma suíte que qualquer outro adaptador.
 *
 * O `fetch` é dublado com respostas no formato REAL do pdv-core — payload
 * aninhado em codigoBarra → produto/cor/tamanho, paginação Spring
 * (content/last), dinheiro decimal. Dublar com o formato que gostaríamos que
 * fosse não prova nada.
 */
const respostas: Record<string, unknown> = {
  '/clientespdv': {
    last: true,
    content: [
      {
        id: 4471, nome: 'SATURNO E ALVES', sobrenome: 'LTDA',
        cnpj: '60.631.000/0014-30', cpf: '990.694.824-87',
        telefone: '(81) 99861-7049', email: 'apvcprmd@gmail.com',
        usernameVendedor: 'EDUARDA', status: 0,
      },
    ],
  },
  '/estoques': {
    last: true,
    content: [
      {
        id: 900, quantidade: 3, quantidadeDecimal: 3,
        codigoBarra: {
          id: 22625, valor: '7891234567890',
          produto: { referencia: '22625', descricao: 'CONJUNTO LAILA' },
          cor: { descricao: 'VERDE' },
          tamanho: { descricao: 'G' },
          subTamanho: { descricao: '42' },
        },
      },
    ],
  },
  '/estoques/tela-venda': {
    content: [{ idCodigoBarra: 22625, codigoBarra: { id: 22625 }, quantidadeDecimal: 3, valorVenda: 146.0 }],
  },
  '/vendas': { last: true, content: [] },
}

const buscarDublado: typeof fetch = async (url) => {
  const caminho = new URL(String(url)).pathname
  const corpo = respostas[caminho] ?? { content: [], last: true }
  return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } })
}

conformidade(() => new ConectorGeraCloud({
  baseUrl: 'https://erp.exemplo/api',
  token: 'dublê',
  buscar: buscarDublado,
}))
