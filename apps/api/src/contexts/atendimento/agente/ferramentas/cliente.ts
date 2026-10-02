import { z } from 'zod'
import { comTenantServico } from '../../../../db/index.js'
import { carregarContextoDoLead } from '../contexto-lead.js'
import type { Ferramenta } from './porta.js'
import type { ConhecimentoPorta, PedidoPorta } from './ligacoes-porta.js'
import { centavosDe } from './porta.js'

/** Perfil do cliente (o que já sabemos) + pedidos recentes. Nunca CPF/CNPJ/endereço. */
export function ferramentaClientePerfil(ped: PedidoPorta | undefined): Ferramenta<never> {
  const f: Ferramenta<Record<string, never>> = {
    nome: 'cliente_perfil',
    descricao: 'O que a loja já sabe deste cliente: se já comprou, quantas vezes no último ano, cidade, e os pedidos recentes. Use antes de perguntar o que já sabemos.',
    entrada: z.object({}),
    async executar(ctx) {
      const lead = await comTenantServico(ctx.tenantId, (tx) => carregarContextoDoLead(tx, ctx.conversaId))
      const recentes = ped ? await ped.recentes(ctx) : []
      const saida = { cliente: lead, pedidosRecentes: recentes }
      return { ok: true, saida, centavos: centavosDe(recentes) }
    },
  }
  return f as Ferramenta<never>
}

export function ferramentaConhecimento(kb: ConhecimentoPorta): Ferramenta<never> {
  const f: Ferramenta<{ pergunta: string }> = {
    nome: 'conhecimento_buscar',
    descricao: 'Busca na base de conhecimento da loja (políticas, prazos, pagamento, entrega, troca, FAQ). Devolve trechos com a fonte. Responda só com o que vier daqui; sem trecho, transfira.',
    entrada: z.object({ pergunta: z.string().min(1).max(300) }),
    async executar(ctx, e) {
      const r = await kb.buscar(ctx, e.pergunta)
      return { ok: true, saida: r }
    },
  }
  return f as Ferramenta<never>
}
