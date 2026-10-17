import { ACOES_TODAS_LIGADAS } from '@geracrm/shared'
import type { Ferramenta } from './porta.js'
import type { Ligacoes } from './ligacoes-porta.js'
import { ferramentasDeCatalogo } from './catalogo.js'
import { ferramentasDePedido, ferramentaDeTransferencia } from './pedido.js'
import { ferramentaClientePerfil, ferramentaConhecimento } from './cliente.js'
import { ferramentaMemoriaAnotar } from '../memoria/ferramenta-memoria.js'
import type { CapacidadesDoTurno } from '../instrucao-vendedor.js'

/**
 * O MENU DE FERRAMENTAS de um turno, montado pelas CAPACIDADES disponíveis e
 * pelas AÇÕES que o playbook do número habilita (P17).
 *
 * ⚠️ Sem catálogo (tenant sem produtos indexados) o modelo não recebe a
 * ferramenta — e o prompt diz que não há catálogo. Degradar é tirar do menu,
 * não deixar a ferramenta falhar (ADR-008). Ação desligada no playbook segue a
 * mesma regra: sai do menu e o prompt diz que não há.
 *
 * ⚠️ `atendimento_transferir` e `cliente_perfil` ficam SEMPRE no menu — não são
 *    ação habilitável (ADR-033 regra 2): sem pedido, a transferência entra
 *    sozinha.
 */
export function montarFerramentas(l: Ligacoes): { ferramentas: Ferramenta<never>[]; capacidades: CapacidadesDoTurno & { proposta: boolean } } {
  const a = l.acoes ?? ACOES_TODAS_LIGADAS
  const catalogo = !!l.catalogo && a.catalogo
  const pedido = !!l.pedido && a.pedido
  const proposta = pedido && a.proposta
  const ferramentas: Ferramenta<never>[] = []
  if (catalogo && l.catalogo) ferramentas.push(...ferramentasDeCatalogo(l.catalogo))
  if (pedido && l.pedido) ferramentas.push(...ferramentasDePedido(l.pedido).filter((f) => proposta || f.nome !== 'pedido_propor'))
  else ferramentas.push(ferramentaDeTransferencia())
  ferramentas.push(ferramentaClientePerfil(l.pedido))
  if (a.conhecimento) ferramentas.push(ferramentaConhecimento(l.conhecimento))
  if (a.memoria) ferramentas.push(ferramentaMemoriaAnotar())
  return { ferramentas, capacidades: { catalogo, pedido, conhecimento: a.conhecimento, proposta } }
}
