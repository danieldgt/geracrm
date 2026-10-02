import type { Ferramenta } from './porta.js'
import type { Ligacoes } from './ligacoes-porta.js'
import { ferramentasDeCatalogo } from './catalogo.js'
import { ferramentasDePedido, ferramentaDeTransferencia } from './pedido.js'
import { ferramentaClientePerfil, ferramentaConhecimento } from './cliente.js'
import { ferramentaMemoriaAnotar } from '../memoria/ferramenta-memoria.js'

/**
 * O MENU DE FERRAMENTAS de um turno, montado pelas CAPACIDADES disponíveis.
 *
 * ⚠️ Sem catálogo (tenant sem produtos indexados) o modelo não recebe a
 * ferramenta — e o prompt diz que não há catálogo. Degradar é tirar do menu,
 * não deixar a ferramenta falhar (ADR-008).
 */
export function montarFerramentas(l: Ligacoes): { ferramentas: Ferramenta<never>[]; capacidades: { catalogo: boolean; pedido: boolean; conhecimento: boolean } } {
  const ferramentas: Ferramenta<never>[] = []
  if (l.catalogo) ferramentas.push(...ferramentasDeCatalogo(l.catalogo))
  if (l.pedido) ferramentas.push(...ferramentasDePedido(l.pedido))
  else ferramentas.push(ferramentaDeTransferencia())
  ferramentas.push(ferramentaClientePerfil(l.pedido))
  ferramentas.push(ferramentaConhecimento(l.conhecimento))
  ferramentas.push(ferramentaMemoriaAnotar())
  return { ferramentas, capacidades: { catalogo: !!l.catalogo, pedido: !!l.pedido, conhecimento: true } }
}
