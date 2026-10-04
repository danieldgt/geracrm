// ⚠️ Import direto do arquivo puro, não do barrel `ui/index.js`: o barrel puxa componentes
// Angular e este módulo roda em spec de node sem TestBed.
import { rotuloProvedor, type ModeloIa } from '../../../compartilhado/ui/modelos-ia.regras.js'

/**
 * Regras PURAS do seletor de modelo na tela do agente — o que é específico de
 * "o cliente escolhe um modelo por número". O que é comum ao painel do staff
 * (custo, qualidade, badges, grupos) mora em `compartilhado/ui/modelos-ia.regras`.
 */

/** O que `GET /v1/agente/modelos` devolve: só o que ESTE tenant pode escolher. */
export interface CatalogoDoTenant {
  readonly itens: readonly ModeloIa[]
  /** O provedor que atende quando o canal não escolhe nada — `null` se o servidor não tem como. */
  readonly provedorPadrao: string | null
  /** Variáveis que faltam para o padrão funcionar, pelo NOME. */
  readonly faltaPadrao: readonly string[]
}

/** O valor "nenhum modelo escolhido" no formulário (a API recebe `null`). */
export const MODELO_PADRAO_DO_SERVIDOR = ''

export interface OpcaoPadrao {
  readonly rotulo: string
  readonly explicacao: string
  /** Falso quando o servidor não tem a chave do provedor padrão — a opção aparece desabilitada. */
  readonly disponivel: boolean
}

/**
 * A primeira opção da lista, sempre: "Padrão do servidor (<provedor>)".
 * ⚠️ Com `faltaPadrao`, a opção vira aviso COM O NOME da variável — genérico
 * manda abrir chamado, nome manda resolver.
 */
export function opcaoPadraoDoServidor(c: Pick<CatalogoDoTenant, 'provedorPadrao' | 'faltaPadrao'>): OpcaoPadrao {
  if (c.faltaPadrao.length > 0 || !c.provedorPadrao) {
    const falta = c.faltaPadrao.length > 0 ? ` Falta configurar: ${c.faltaPadrao.join(', ')}.` : ''
    return {
      rotulo: 'Padrão do servidor — indisponível',
      explicacao: `O servidor não tem como atender sem um modelo escolhido.${falta} Escolha um modelo da lista.`,
      disponivel: false,
    }
  }
  return {
    rotulo: `Padrão do servidor (${rotuloProvedor(c.provedorPadrao)})`,
    explicacao: 'Usa o modelo configurado no servidor. Muda junto quando a Gera3 atualizar o padrão.',
    disponivel: true,
  }
}

/**
 * O código salvo neste canal não está mais na lista (o staff restringiu depois
 * que o cliente escolheu). ⚠️ Não pode sumir em silêncio: o canal continua
 * apontando para ele até alguém salvar de novo. Devolve o código para a tela
 * mostrar um card desabilitado com aviso; `null` quando está tudo em ordem.
 */
export function escolhaForaDaLista(codigoSalvo: string, itens: readonly Pick<ModeloIa, 'codigo'>[]): string | null {
  const c = codigoSalvo.trim()
  if (!c) return null
  return itens.some((m) => m.codigo === c) ? null : c
}

/** O card de um modelo pode ser escolhido? Indisponível no servidor desabilita, com o motivo visível. */
export function podeEscolher(m: Pick<ModeloIa, 'disponivel'>): boolean {
  return m.disponivel
}

/** Erro do seletor: o 422 chega mapeado por campo; aqui só se lê a chave certa. */
export function erroDoSeletor(erros: Readonly<Record<string, string>>): string | null {
  return erros['modelo'] ?? null
}
