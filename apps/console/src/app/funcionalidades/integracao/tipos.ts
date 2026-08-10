/**
 * O que a API de integração devolve.
 *
 * ⚠️ Não há nenhum tipo de credencial aqui além de `CredencialResumo`. A
 * credencial entra e nunca sai — se um dia aparecer um campo com valor de
 * senha neste arquivo, o invariante já foi quebrado do lado do servidor.
 */

export type TipoCampo = 'texto' | 'senha' | 'url'

export interface CampoCredencial {
  readonly nome: string
  readonly rotulo: string
  readonly tipo: TipoCampo
  readonly obrigatorio: boolean
  readonly ajuda?: string
  readonly exemplo?: string
}

export interface EsquemaCredencial {
  readonly campos: readonly CampoCredencial[]
  readonly preRequisito?: string
}

export interface ConectorDisponivel {
  readonly codigo: string
  readonly nome: string
  readonly descricao: string
  readonly esquemaCredencial: EsquemaCredencial
  readonly capacidades: Readonly<Record<string, boolean>>
}

export type EstadoConexao = 'configurando' | 'ativa' | 'com_erro' | 'pausada'

export type MotivoFalha =
  | 'credencial_invalida' | 'sem_permissao' | 'indisponivel' | 'resposta_inesperada'

export interface Conexao {
  readonly id: string
  readonly conector: string
  readonly nomeAmigavel: string
  readonly estado: EstadoConexao
  readonly capacidades: Readonly<Record<string, boolean>>
  readonly papelFiscal: boolean
  readonly fonteDeVenda: boolean
  readonly identificacaoRemota: string | null
  readonly ultimaValidacaoEm: string | null
  readonly ultimaTentativaEm: string | null
  readonly ultimoErro: string | null
  readonly ultimoErroMotivo: MotivoFalha | null
  /** ⚠️ Só isto: se existe e quais campos tem. Nunca os valores. */
  readonly credencial: { readonly configurada: boolean; readonly camposPreenchidos: readonly string[] }
}

export type ResultadoTeste =
  | { ok: true; capacidades: Record<string, boolean>; identificacao?: string }
  | { ok: false; motivo: MotivoFalha; detalhe?: string }

export interface ErroApi {
  readonly erro: string
  readonly mensagem: string
  readonly detalhe?: { campos?: Record<string, string>; comoResolver?: string; campo?: string }
}

/**
 * As capacidades, com o nome que a pessoa entende e o que muda no produto.
 *
 * ⚠️ O texto de ausência descreve a CONSEQUÊNCIA, não a falta. "Sem saldo
 * síncrono" não diz nada a quem vende; "a tela mostra o saldo da última
 * sincronização, com a hora" diz exatamente o que vai acontecer — que é a
 * degradação visível do ADR-008.
 */
export const CAPACIDADES: readonly { chave: string; rotulo: string; ausente: string }[] = [
  { chave: 'ingestaoClientes', rotulo: 'Importar clientes',
    ausente: 'Os clientes precisam ser cadastrados à mão ou por planilha.' },
  { chave: 'ingestaoProdutos', rotulo: 'Importar catálogo',
    ausente: 'O catálogo não aparece no pedido assistido.' },
  { chave: 'ingestaoPedidos', rotulo: 'Importar vendas',
    ausente: 'Sem histórico de compra não há recompra, RFV nem atribuição de receita.' },
  { chave: 'cargaHistorica', rotulo: 'Carga histórica',
    ausente: 'Só entram as vendas daqui para frente — o RFV começa do zero.' },
  { chave: 'saldoSincrono', rotulo: 'Saldo em tempo real',
    ausente: 'A tela mostra o saldo da última sincronização, sempre com a hora.' },
  { chave: 'tabelaPrecoSincrona', rotulo: 'Preço em tempo real',
    ausente: 'O preço vem da última sincronização, com a hora ao lado.' },
  { chave: 'creditoCliente', rotulo: 'Limite de crédito',
    ausente: 'O bloco de crédito não aparece na tela de pedido.' },
  { chave: 'escritaPedido', rotulo: 'Enviar pedido ao ERP',
    ausente: 'O pedido vira um rascunho para exportar; o lançamento é feito no ERP.' },
  { chave: 'webhookDeVenda', rotulo: 'Aviso imediato de venda',
    ausente: 'A sincronização é agendada, então a atribuição de receita tem atraso.' },
  { chave: 'fidelidade', rotulo: 'Saldo de fidelidade',
    ausente: 'Blocos de cashback não aparecem e não dá para segmentar por saldo.' },
]

/** Mensagem por motivo de falha. Espelha `MENSAGEM_FALHA` do pacote de conectores. */
export const MENSAGEM_FALHA: Record<MotivoFalha, { titulo: string; acao: string }> = {
  credencial_invalida: {
    titulo: 'O ERP recusou essas credenciais',
    acao: 'Confira os dados de acesso e teste de novo.',
  },
  sem_permissao: {
    titulo: 'Conectamos, mas este usuário não tem acesso aos dados',
    acao: 'Peça no ERP para liberar leitura de clientes, produtos e vendas para este usuário.',
  },
  indisponivel: {
    titulo: 'O ERP não respondeu',
    acao: 'As credenciais foram salvas. Teste de novo em alguns minutos.',
  },
  resposta_inesperada: {
    titulo: 'O endereço respondeu, mas não parece ser este ERP',
    acao: 'Confira se o endereço está completo e aponta para o servidor certo.',
  },
}
