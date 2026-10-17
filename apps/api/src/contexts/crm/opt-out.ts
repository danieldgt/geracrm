import type { Sql } from '../../db/index.js'

/**
 * OPT-OUT PEDIDO PELO PRÓPRIO CONTATO ("pare", "me tira da lista") — raia P4.
 *
 * Reaproveita o que já existe e é respeitado em TODOS os caminhos de envio:
 *
 *   - `lista_bloqueio` (0009), por `chave_bloqueio` (55+DDD+8, INV-50): o
 *     GATEWAY ÚNICO recusa qualquer envio para o número — agente, retorno,
 *     campanha, automação e o humano no inbox (`destinoBloqueado`). É a
 *     garantia de "nada sai depois do opt-out"; não existe caminho que pule.
 *   - `contato.recebe_campanhas/recebe_automacoes = false`: a audiência das
 *     campanhas e o motor de automação já filtram por eles.
 *   - `consentimento_contato`: o rastro LGPD de quando e por que mudou
 *     (origem `opt_out_mensagem`, prevista desde a 0009).
 *
 * ⚠️ TODOS os telefones do contato entram na lista, não só o principal: quem
 *    pediu para parar pediu para a pessoa, e trocar o principal depois não
 *    pode reabrir o envio.
 * ⚠️ Idempotente: repetir "pare" não duplica nem falha.
 * ⚠️ Chamar DEPOIS de enviar a confirmação — com o bloqueio gravado, o
 *    gateway recusa inclusive a confirmação.
 * Chamar sob tenant (RLS); na transação do chamador.
 */
export async function registrarOptOut(
  tx: Sql, p: { contatoId: string; origem: string; agora: Date },
): Promise<{ chaves: readonly string[] }> {
  const chaves = await tx<{ chave_bloqueio: string }[]>`
    INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem, bloqueado_em)
    SELECT DISTINCT tenant_atual(), ct.chave_bloqueio, 'opt_out', ${p.origem}, ${p.agora}::timestamptz
      FROM contato_telefone ct
     WHERE ct.tenant_id = tenant_atual() AND ct.contato_id = ${p.contatoId} AND ct.chave_bloqueio IS NOT NULL
    ON CONFLICT (tenant_id, chave_bloqueio) DO NOTHING
    RETURNING chave_bloqueio`
  const [mudou] = await tx<{ id: string }[]>`
    UPDATE contato SET recebe_campanhas = false, recebe_automacoes = false
     WHERE tenant_id = tenant_atual() AND id = ${p.contatoId} AND (recebe_campanhas OR recebe_automacoes)
    RETURNING id`
  if (mudou || chaves.length > 0) {
    await tx`
      INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, registrado_em)
      SELECT tenant_atual(), ${p.contatoId}, t, false, 'opt_out_mensagem', ${p.agora}::timestamptz
        FROM unnest(ARRAY['campanhas', 'automacoes', 'whatsapp']) AS t
      ON CONFLICT DO NOTHING`
  }
  return { chaves: chaves.map((c) => c.chave_bloqueio) }
}

/** Algum telefone do contato está na lista de bloqueio? Sob tenant. */
export async function contatoBloqueado(tx: Sql, contatoId: string): Promise<boolean> {
  const [l] = await tx<{ bloqueado: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM contato_telefone ct
        JOIN lista_bloqueio lb ON lb.tenant_id = ct.tenant_id AND lb.chave_bloqueio = ct.chave_bloqueio
       WHERE ct.tenant_id = tenant_atual() AND ct.contato_id = ${contatoId}) AS bloqueado`
  return l?.bloqueado ?? false
}
