import type { Sql } from '../../../db/index.js'
import type { ContextoDoLead } from './porta.js'

/**
 * O QUE JÁ SABEMOS sobre quem está do outro lado, antes de o agente abrir a boca.
 *
 * ⚠️ Existe por um motivo de produto, não de arquitetura: três dos seis sinais de
 * qualificação (§4.1 do escopo) **já estão no nosso banco** — histórico de
 * compra, interações e cadastro. Um agente que pergunta o CNPJ de quem compra há
 * dois anos soa como formulário, não como atendimento, e é o jeito mais rápido de
 * a pessoa desistir da conversa.
 *
 * ⚠️ **Só entra aqui o que ajuda a conversar.** O número do CNPJ, o endereço
 * completo e o telefone NÃO melhoram a resposta e sairiam do nosso perímetro à
 * toa — a conversa enviada ao fornecedor já é tratamento de dado pessoal por si
 * só. Por isso o contexto carrega `temCnpj: boolean`, e não o documento.
 */
export async function carregarContextoDoLead(
  sql: Sql, conversaId: string,
): Promise<ContextoDoLead | null> {
  const [linha] = await sql<{
    nome: string | null
    qtd_vendas: number | null
    ultima_venda_em: Date | null
    compras_ano: number
    cidade: string | null
    tem_cnpj: boolean
  }[]>`
    SELECT ct.nome, ct.qtd_vendas, ct.ultima_venda_em,
           -- ⚠️ Conta de verdade o último ANO, e ignora cancelada. Usar o total
           --    de sempre faria um cliente que sumiu há três anos parecer ativo,
           --    e o agente trataria como recorrente quem já foi embora.
           (SELECT count(*)::int FROM venda v
             WHERE v.tenant_id = ct.tenant_id AND v.contato_id = ct.id
               AND v.cancelada_em IS NULL
               AND v.ocorrida_em > now() - interval '1 year') AS compras_ano,
           (SELECT e.cidade FROM contato_endereco e
             WHERE e.tenant_id = ct.tenant_id AND e.contato_id = ct.id
               AND e.cidade IS NOT NULL
             ORDER BY e.principal DESC NULLS LAST, e.seq
             LIMIT 1) AS cidade,
           -- Só a EXISTÊNCIA do documento; o número nunca sai daqui.
           EXISTS (SELECT 1 FROM contato_documento d
                    WHERE d.tenant_id = ct.tenant_id AND d.contato_id = ct.id
                      AND d.tipo = 'cnpj') AS tem_cnpj
      FROM conversa cv
      JOIN contato ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contato_id
     WHERE cv.tenant_id = tenant_atual() AND cv.id = ${conversaId}`

  if (!linha) return null

  return {
    nome: primeiroNome(linha.nome),
    // ⚠️ "É cliente" é ter comprado algum dia; "compras no último ano" é o que
    //    diz se ele está ativo. São perguntas diferentes e o agente usa as duas.
    jaEhCliente: (linha.qtd_vendas ?? 0) > 0,
    comprasNoUltimoAno: linha.compras_ano,
    ultimaCompraEm: linha.ultima_venda_em ? linha.ultima_venda_em.toISOString().slice(0, 10) : null,
    cidade: linha.cidade?.trim() || null,
    temCnpj: linha.tem_cnpj,
  }
}

/**
 * ⚠️ Só o primeiro nome vai para o fornecedor. "Daniel" conversa igual a
 * "Daniel Alencar Barros Tavares" e carrega menos gente identificável para fora
 * do nosso perímetro — e razão social inteira num prompt não ajuda ninguém.
 */
function primeiroNome(nome: string | null): string | null {
  const limpo = nome?.trim()
  if (!limpo) return null
  return limpo.split(/\s+/)[0] ?? null
}
