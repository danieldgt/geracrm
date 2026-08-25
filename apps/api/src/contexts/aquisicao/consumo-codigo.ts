import { randomUUID } from 'node:crypto'
import { extrairCodigoOrigem } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/**
 * O CÓDIGO CHEGOU (agencia-mkt, AQ-45) — o momento em que a landing page vira
 * atribuição.
 *
 * O lead clicou no anúncio, passou pela LP, abriu o WhatsApp com o texto pronto e
 * mandou. Aqui a mensagem entrante é lida, o código é extraído e a sessão anônima
 * (`midia_sessao_lp`) se transforma no primeiro toque de mídia do contato
 * (`midia_lead_origem`).
 *
 * ⚠️ **Roda dentro da transação da ingestão.** Origem e mensagem nascem no mesmo
 * commit: uma origem sem a conversa que a originou seria um lead fantasma no
 * relatório de mídia.
 *
 * ⚠️ **Toda saída é um estado NOMEADO, e "não achou" é o caso comum.** O lead
 * pode apagar o texto pronto antes de enviar — o desenho inteiro (0059) assume a
 * perda. A razão entre sessões criadas e consumidas é a métrica de saúde da
 * atribuição; ela só significa alguma coisa se os motivos forem distinguíveis.
 */

export type ResultadoConsumo =
  | 'sem_codigo'
  | 'sessao_desconhecida'
  | 'ja_consumida'
  | 'registrada'

interface Sessao {
  id: string
  lp_id: string | null
  plataforma: string | null
  click_id: string | null
  click_id_tipo: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  campanha_externa_id: string | null
  anuncio_externo_id: string | null
  consentimento_texto: string | null
  criado_em: Date
}

export async function consumirCodigoOrigem(
  tx: Sql, contatoId: string, texto: string,
): Promise<ResultadoConsumo> {
  const codigo = extrairCodigoOrigem(texto)
  if (!codigo) return 'sem_codigo'

  /**
   * ⚠️ Consome e lê no MESMO `UPDATE`. Um `SELECT` antes do `UPDATE` deixaria a
   * janela em que duas mensagens com o mesmo código (o lead mandou duas vezes)
   * criam duas origens — e o contato apareceria com dois "primeiros toques" para
   * o mesmo clique. O `WHERE consumida_em IS NULL` é a trava.
   */
  const [sessao] = await tx<Sessao[]>`
    UPDATE midia_sessao_lp
       SET consumida_em = now()
     WHERE tenant_id = tenant_atual() AND codigo = ${codigo} AND consumida_em IS NULL
    RETURNING id, lp_id, plataforma, click_id, click_id_tipo, utm_source, utm_medium,
              utm_campaign, campanha_externa_id, anuncio_externo_id, consentimento_texto, criado_em`

  if (!sessao) {
    // ⚠️ Distinguir os dois casos importa: "já consumida" é o lead repetindo a
    //    mensagem (normal); "desconhecida" é falso positivo do extrator — uma
    //    palavra de 6 letras que passou pelo filtro. Contá-los juntos esconderia
    //    um extrator ficando burro.
    const [existe] = await tx<{ id: string }[]>`
      SELECT id FROM midia_sessao_lp
       WHERE tenant_id = tenant_atual() AND codigo = ${codigo}`
    return existe ? 'ja_consumida' : 'sessao_desconhecida'
  }

  /**
   * ⚠️ `primeira` só se o contato ainda não tem toque nenhum. O índice parcial
   * `midia_origem_primeira_unica` (INV-61) garante um por contato; calcular aqui
   * evita bater nele — e um contato que volta por um segundo anúncio ganha um
   * toque novo sem perder o primeiro (a origem é 1:N de propósito).
   */
  await tx`
    INSERT INTO midia_lead_origem
      (tenant_id, id, contato_id, sessao_id, plataforma, campanha_externa_id,
       anuncio_externo_id, click_id, click_id_tipo, utm_source, utm_medium, utm_campaign,
       modo_entrada, primeira, consentimento_texto, consentimento_em)
    SELECT tenant_atual(), ${randomUUID()}, ${contatoId}, ${sessao.id},
           ${sessao.plataforma}, ${sessao.campanha_externa_id}, ${sessao.anuncio_externo_id},
           ${sessao.click_id}, ${sessao.click_id_tipo}, ${sessao.utm_source},
           ${sessao.utm_medium}, ${sessao.utm_campaign},
           'inbound_wa',
           NOT EXISTS (SELECT 1 FROM midia_lead_origem o
                        WHERE o.tenant_id = tenant_atual() AND o.contato_id = ${contatoId}),
           ${sessao.consentimento_texto},
           -- ⚠️ Par coerente (CHECK do 0059): sem texto, não há carimbo. E o
           --    carimbo é o do CLIQUE, não o de agora — foi ali que a pessoa leu.
           ${sessao.consentimento_texto ? sessao.criado_em : null}`

  return 'registrada'
}
