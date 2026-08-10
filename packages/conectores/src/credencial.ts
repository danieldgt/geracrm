/**
 * O formato da credencial de cada ERP, DECLARADO pelo conector.
 *
 * ⚠️ Existe para que a tela de configuração não tenha
 * `if (conector === 'geracloud') { … } else { … }`.
 *
 * O GeraCloud autentica com usuário e senha; outros ERPs usam token; o próximo
 * vai pedir também a URL da instância, ou um par chave/segredo. Com o `if` na
 * tela, cada ERP novo é um commit no console — e o console não conhece ERP
 * nenhum (ADR-008: só o contexto `integracao` conhece formato de ERP).
 *
 * Aqui o conector DECLARA seus campos e a tela desenha o formulário a partir
 * disso. ERP novo entra sem nenhuma linha no console.
 */

export interface CampoCredencial {
  /** Chave no objeto de credencial. Vai cifrada; nunca volta para a tela. */
  readonly nome: string
  readonly rotulo: string
  /**
   * ⚠️ `senha` não é só a máscara na tela: o campo também não vai para log,
   * não entra em mensagem de erro e não volta em resposta de API.
   */
  readonly tipo: 'texto' | 'senha' | 'url'
  readonly obrigatorio: boolean
  /**
   * ⚠️ Texto de ajuda com ONDE ACHAR o valor, não o que ele é. Quem preenche é
   * o dono da loja, não um desenvolvedor: "Token de API" não ajuda ninguém;
   * "Configurações → Integrações → Gerar token" ajuda.
   */
  readonly ajuda?: string | undefined
  readonly exemplo?: string | undefined
}

export interface EsquemaCredencial {
  readonly campos: readonly CampoCredencial[]
  /**
   * O que a pessoa precisa ter feito ANTES de chegar nesta tela.
   * ⚠️ Sem isto, a tela pede um token que ainda não existe e o erro que aparece
   * é "credencial inválida" — que manda procurar no lugar errado.
   */
  readonly preRequisito?: string | undefined
}

export type Credencial = Readonly<Record<string, string>>

/**
 * Resultado de testar uma conexão.
 *
 * ⚠️ Falha de teste é retorno tipificado, não exceção: "senha errada" e "ERP
 * fora do ar" pedem ações opostas da pessoa — corrigir o que digitou, ou
 * esperar e tentar de novo. Um `throw` genérico apaga essa diferença, e a tela
 * acaba mostrando "erro ao conectar" para os dois.
 */
export type ResultadoTeste =
  | {
      ok: true
      /** ⚠️ Capacidades REDESCOBERTAS no teste, não as declaradas no código:
       *  o mesmo ERP em versão antiga pode não ter o endpoint de saldo. */
      capacidades: Record<string, boolean>
      /** Algo que prove que conectou no lugar certo — nome da empresa, CNPJ.
       *  Sem isso a pessoa não tem como perceber que conectou na loja errada. */
      identificacao?: string | undefined
    }
  | { ok: false; motivo: MotivoFalhaTeste; detalhe?: string | undefined }

export type MotivoFalhaTeste =
  /** Credencial recusada. ⚠️ A ação é da pessoa: conferir o que digitou. */
  | 'credencial_invalida'
  /** Conectou e autenticou, mas o usuário não tem permissão para o que
   *  precisamos ler. ⚠️ Diferente de credencial inválida: a senha está certa,
   *  falta liberar acesso no ERP — e quem libera costuma ser outra pessoa. */
  | 'sem_permissao'
  /** Não respondeu. A ação é esperar, não redigitar. */
  | 'indisponivel'
  /** Respondeu, mas não é o que esperávamos — URL de outro sistema, por exemplo. */
  | 'resposta_inesperada'

/** Mensagem para a tela. Fica aqui, e não no console, porque o motivo nasce aqui. */
export const MENSAGEM_FALHA: Record<MotivoFalhaTeste, { titulo: string; acao: string }> = {
  credencial_invalida: {
    titulo: 'O ERP recusou essas credenciais',
    acao: 'Confira usuário e senha e teste de novo.',
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
