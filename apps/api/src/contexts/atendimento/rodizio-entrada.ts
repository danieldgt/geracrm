import type { MotivoFilial } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { auditar } from '../plataforma/auditoria.js'
import { notificarPessoasDaConversa } from './notificacao.js'
import { escolherVendedorDaFilial, filialDoContato } from './roteamento.js'

/**
 * RODÍZIO NA ENTRADA (RN-04, raia G4) — o contato NOVO que a ingestão de
 * mensagem acabou de criar ganha dono pelo rodízio da filial roteada.
 *
 * Regras (todas no código, nenhuma na tela):
 *   - só com `canal_configuracao.rodizio_na_entrada` LIGADO no número (padrão
 *     desligado = o contato nasce órfão, como sempre);
 *   - só contato SEM dono vigente — quem já tem dono não muda (a ingestão só
 *     chama para lead novo, e a checagem aqui é a segunda trava);
 *   - a filial sai de `filialDoContato` (origem → DDD → padrão…); sem filial
 *     ou sem vendedor elegível, o contato fica órfão e nada é gravado;
 *   - a carteira passa por `transferir_carteira(..., 'automatica', motivo)` —
 *     a mesma maquinaria sem buraco nem sobreposição da tela —, a filial é
 *     carimbada no contato (se ainda não tiver) e a decisão vai para a
 *     `auditoria` (ator nulo = sistema);
 *   - UMA notificação ao vendedor ("novo cliente na sua carteira", tipo
 *     `carteira.novo_cliente`, desligável nas preferências), na pendência da
 *     conversa — quem chama não avisa a fila de novo (seria o ruído que a regra
 *     existe para evitar).
 *   - ⚠️ O CARIMBO da filial (`contato.filial_id`) fica: transferir depois a
 *     carteira para um vendedor de OUTRA filial não o muda. Efeito: o contato
 *     segue visível ao gestor da filial carimbada (escopo D3, regra (a)) além da
 *     filial do novo dono (regra (b)), e o roteamento de um handoff futuro sem
 *     dono disponível usa a filial carimbada. Para mudar, edite a filial no
 *     cadastro do contato (decisão registrada na skill geracrm-agente-vendas).
 *
 * Roda dentro da transação da ingestão (tenant setado). O ponteiro do rodízio é
 * travado até o commit: dois contatos novos ao mesmo tempo não pegam o mesmo
 * vendedor fora da vez.
 */
export type ResultadoRodizioEntrada =
  | { readonly tipo: 'atribuido'; readonly usuarioId: string; readonly filialId: string; readonly motivo: MotivoFilial }
  | { readonly tipo: 'desligado' | 'ja_tem_dono' | 'sem_telefone' | 'sem_filial' }
  | { readonly tipo: 'sem_vendedor'; readonly filialId: string }

export async function atribuirCarteiraNaEntrada(
  tx: Sql, p: { contatoId: string; conversaId: string; canalId: string },
): Promise<ResultadoRodizioEntrada> {
  const [cfg] = await tx<{ rodizio_na_entrada: boolean }[]>`
    SELECT rodizio_na_entrada FROM canal_configuracao WHERE tenant_id = tenant_atual() AND canal_id = ${p.canalId}`
  if (!cfg?.rodizio_na_entrada) return { tipo: 'desligado' }

  const [dono] = await tx`
    SELECT 1 FROM carteira_atribuicao
     WHERE tenant_id = tenant_atual() AND contato_id = ${p.contatoId} AND ate IS NULL AND usuario_id IS NOT NULL`
  if (dono) return { tipo: 'ja_tem_dono' }

  // ⚠️ Só contato com TELEFONE PRINCIPAL próprio. Dois webhooks paralelos do mesmo
  //    número criam dois contatos e o 2º perde o telefone no ON CONFLICT DO NOTHING
  //    da ingestão: sem esta trava, o fantasma ganharia dono e gastaria a vez.
  const [fone] = await tx`
    SELECT 1 FROM contato_telefone WHERE tenant_id = tenant_atual() AND contato_id = ${p.contatoId} AND principal`
  if (!fone) return { tipo: 'sem_telefone' }

  const filial = await filialDoContato(tx, p.contatoId, p.canalId)
  if (!filial.filialId) return { tipo: 'sem_filial' }

  const { usuarioId } = await escolherVendedorDaFilial(tx, filial.filialId, p.canalId, { finalidade: 'entrada' })
  if (!usuarioId) return { tipo: 'sem_vendedor', filialId: filial.filialId }

  await tx`
    SELECT transferir_carteira(tenant_atual(), ${p.contatoId}, ${usuarioId}, NULL, 'automatica', 'Rodízio na entrada')`
  await tx`
    UPDATE contato SET filial_id = ${filial.filialId}
     WHERE tenant_id = tenant_atual() AND id = ${p.contatoId} AND filial_id IS NULL`
  await auditar(tx, {
    atorId: null, acao: 'carteira.rodizio_entrada', entidade: 'contato', entidadeId: p.contatoId,
    dados: { usuarioId, filialId: filial.filialId, motivo: filial.motivo, regraId: filial.regraId, canalId: p.canalId },
  })
  await notificarPessoasDaConversa(tx, [usuarioId], 'carteira.novo_cliente', 'novo cliente na sua carteira', p.conversaId)
  return { tipo: 'atribuido', usuarioId, filialId: filial.filialId, motivo: filial.motivo }
}
