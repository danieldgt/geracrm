import { ConectorGeraCloud, autenticarGeraCloud, type ConectorErp } from '@geracrm/conectores'
import type { Sql } from '../../db/index.js'
import { decifrar } from './cofre.js'

/**
 * Monta o conector de ERP do tenant a partir da conexão cadastrada.
 *
 * ⚠️ Existe porque a rota de efetivar passava `null` e o pedido caía sempre em
 * `degradado` — a escrita no GeraCloud estava pronta, testada contra o ERP de
 * verdade, e NÃO ERA USADA. Era a maior distância do produto entre "existe" e
 * "chega ao cliente".
 *
 * ⚠️ A credencial é POR TENANT e cifrada em repouso: a credencial de um cliente
 * jamais pode alcançar outro. Por isso ela sai daqui, sob RLS, e nunca de
 * variável de ambiente — ao contrário da chave do LLM, que é nossa.
 */

/** Cache de token por conexão: autenticar a cada pedido seria absurdo. */
const sessoes = new Map<string, { token: string; expiraEmMs: number }>()

export interface ConexaoDoTenant {
  readonly conectorNome: string
  readonly sistema: string
  readonly conector: ConectorErp | null
}

/**
 * A conexão fonte-de-venda do tenant, já com o adaptador pronto.
 *
 * ⚠️ Devolve `conector: null` — e NÃO lança — quando não há conexão, o conector
 * é desconhecido ou a credencial não abre. Quem chama trata isso como
 * degradação visível (ADR-008): o rascunho fica intacto e a tela oferece o
 * registro manual. Lançar aqui transformaria "ERP não configurado" em erro 500.
 */
export async function conectorDoTenant(tx: Sql): Promise<ConexaoDoTenant> {
  const [cx] = await tx<{
    id: string; conector: string; credenciais_cifradas: Buffer | null
  }[]>`
    SELECT id, conector, credenciais_cifradas
      FROM conexao_erp
     WHERE tenant_id = tenant_atual() AND fonte_de_venda
     LIMIT 1`

  if (!cx) return { conectorNome: '', sistema: '', conector: null }
  // `sistema` identifica a origem do id externo do contato (`erp:<conexao>`).
  const sistema = `erp:${cx.id}`
  if (!cx.credenciais_cifradas) return { conectorNome: cx.conector, sistema, conector: null }

  if (cx.conector !== 'geracloud') {
    // ⚠️ Conector sem adaptador de escrita não é erro: é degradação declarada.
    return { conectorNome: cx.conector, sistema, conector: null }
  }

  const cred = decifrar(cx.credenciais_cifradas) as Record<string, string>
  const baseUrl = cred['baseUrl'] ?? process.env.GERACLOUD_BASE_URL ?? ''
  if (!baseUrl || !cred['usuario'] || !cred['senha']) {
    return { conectorNome: cx.conector, sistema, conector: null }
  }

  const chave = cx.id
  const obterToken = async (): Promise<string> => {
    const atual = sessoes.get(chave)
    // ⚠️ 30 s de folga: um token que expira NO MEIO da escrita produziria um 401
    //    depois do POST ter sido enviado — o pior desfecho, porque o pedido pode
    //    ter entrado e nós trataríamos como falha.
    if (atual && Date.now() < atual.expiraEmMs - 30_000) return atual.token
    const auth = await autenticarGeraCloud(
      { baseUrl, usuario: cred['usuario']!, senha: cred['senha']! } as never, fetch)
    if (!auth.ok) throw new Error(`login no ERP: ${auth.motivo}`)
    sessoes.set(chave, {
      token: auth.sessao.accessToken,
      expiraEmMs: Date.now() + auth.sessao.expiraEm * 1000,
    })
    return auth.sessao.accessToken
  }

  return {
    conectorNome: cx.conector,
    sistema,
    // ⚠️ 30 s: a escrita do orçamento leva ~7 s medidos (4 buscas + POST), e o
    //    padrão de 2 s do adaptador é para LEITURA — com ele, toda escrita
    //    abortava e virava `resposta_perdida`, que manda para conferência humana
    //    em vez de retentar.
    conector: new ConectorGeraCloud({ baseUrl, obterToken, timeoutMs: 30_000 }) as unknown as ConectorErp,
  }
}
