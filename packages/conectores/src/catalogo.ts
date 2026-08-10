import type { Capacidades } from './porta.js'
import type { EsquemaCredencial } from './credencial.js'
import { CAPACIDADES_GERACLOUD } from './geracloud/conector.js'

/**
 * O catálogo de ERPs que sabemos conectar.
 *
 * ⚠️ É a ÚNICA lista. A tela de configuração lê daqui — não tem uma segunda
 * lista de ERPs no console, nem um `<option>` escrito à mão. Duas listas
 * divergem no primeiro ERP novo, e a que diverge é sempre a da tela: alguém
 * adiciona o conector, esquece o `<option>`, e o ERP existe mas ninguém
 * consegue escolher.
 */

export interface ConectorDisponivel {
  readonly codigo: string
  readonly nome: string
  /** Uma linha sobre quem usa esse ERP. Ajuda a pessoa a se reconhecer. */
  readonly descricao: string
  readonly esquemaCredencial: EsquemaCredencial
  /**
   * Capacidades DECLARADAS. ⚠️ São a expectativa; o teste de conexão
   * redescobre as reais, que podem ser menores numa instalação antiga.
   */
  readonly capacidades: Capacidades
}

/** ⚠️ Nenhuma capacidade por padrão: conector novo não herda otimismo. */
const NENHUMA: Capacidades = {
  ingestaoClientes: false, ingestaoProdutos: false, ingestaoPedidos: false,
  cargaHistorica: false, saldoSincrono: false, tabelaPrecoSincrona: false,
  creditoCliente: false, escritaPedido: false, webhookDeVenda: false, fidelidade: false,
}

export const CONECTORES: readonly ConectorDisponivel[] = [
  {
    codigo: 'geracloud',
    nome: 'GeraCloud',
    descricao: 'ERP e PDV da Gera3. Clientes, catálogo com grade, vendas e cashback.',
    capacidades: CAPACIDADES_GERACLOUD,
    esquemaCredencial: {
      // ⚠️ O GeraCloud autentica com o MESMO usuário e senha da retaguarda — os
      //    que a pessoa já usa para entrar no sistema. Não é token: por dentro
      //    o login passa por um servidor de identidade (Keycloak), mas isso é
      //    detalhe do adaptador e não aparece para quem preenche.
      preRequisito:
        'Use um usuário da retaguarda do GeraCloud com permissão de leitura — ' +
        'o mesmo login e senha que você usa para entrar no sistema. ' +
        'Recomendamos criar um usuário só para a integração, em vez de usar o do dono: ' +
        'assim dá para revogar o acesso sem trocar a senha de ninguém.',
      campos: [
        {
          nome: 'baseUrl',
          rotulo: 'Endereço do servidor',
          tipo: 'url',
          obrigatorio: true,
          ajuda: 'O mesmo endereço que o PDV usa. Se não souber, pergunte a quem instalou.',
          exemplo: 'https://api.geracloud.com.br',
        },
        {
          nome: 'usuario',
          rotulo: 'Usuário',
          tipo: 'texto',
          obrigatorio: true,
          ajuda: 'O login do usuário de integração no GeraCloud.',
        },
        {
          nome: 'senha',
          rotulo: 'Senha',
          tipo: 'senha',
          obrigatorio: true,
        },
      ],
    },
  },
  {
    codigo: 'generico_token',
    nome: 'Outro ERP (por token)',
    descricao: 'Para ERPs que expõem uma API autenticada por token.',
    capacidades: NENHUMA,
    esquemaCredencial: {
      preRequisito:
        'Gere um token de leitura no seu ERP antes de continuar. ' +
        'Costuma ficar em Configurações → Integrações ou Configurações → API.',
      campos: [
        {
          nome: 'baseUrl',
          rotulo: 'Endereço da API',
          tipo: 'url',
          obrigatorio: true,
          exemplo: 'https://erp.suaempresa.com.br/api',
        },
        {
          nome: 'token',
          rotulo: 'Token de acesso',
          // ⚠️ Token é 'senha', não 'texto': ele autentica igual a uma, então
          //    mascara na tela, não entra em log e não volta em resposta.
          tipo: 'senha',
          obrigatorio: true,
          ajuda: 'Cole o token inteiro, sem a palavra "Bearer".',
        },
      ],
    },
  },
]

export function conectorPorCodigo(codigo: string): ConectorDisponivel | undefined {
  return CONECTORES.find((c) => c.codigo === codigo)
}

/**
 * Valida a credencial contra o esquema declarado.
 *
 * ⚠️ Devolve erro POR CAMPO, não uma mensagem geral. "Credencial incompleta"
 * obriga a pessoa a conferir tudo de novo; "Senha é obrigatória" aponta.
 */
export function validarCredencial(
  esquema: EsquemaCredencial,
  valores: Record<string, unknown>,
): { ok: true } | { ok: false; erros: Record<string, string> } {
  const erros: Record<string, string> = {}

  for (const campo of esquema.campos) {
    const valor = valores[campo.nome]
    if (campo.obrigatorio && (typeof valor !== 'string' || valor.trim() === '')) {
      erros[campo.nome] = `${campo.rotulo} é obrigatório.`
      continue
    }
    if (typeof valor === 'string' && campo.tipo === 'url' && valor.trim() !== '') {
      // ⚠️ Endereço sem esquema é o erro mais comum aqui, e o sintoma é
      //    "indisponível" — que manda a pessoa procurar problema de rede.
      if (!/^https?:\/\//i.test(valor.trim())) {
        erros[campo.nome] = 'O endereço precisa começar com https://'
      }
    }
  }

  // ⚠️ Campo que não está no esquema é recusado, não ignorado: ele viria de um
  //    formulário desatualizado, e guardá-lo cifrado faria a credencial ter um
  //    valor que ninguém sabe de onde veio.
  for (const chave of Object.keys(valores)) {
    if (!esquema.campos.some((c) => c.nome === chave)) {
      erros[chave] = 'Campo não faz parte deste ERP.'
    }
  }

  return Object.keys(erros).length > 0 ? { ok: false, erros } : { ok: true }
}
