import { z } from 'zod'
import { MOTIVOS_HANDOFF } from '@geracrm/shared'
import type { Ferramenta } from './porta.js'
import type { PedidoPorta } from './ligacoes-porta.js'
import { centavosDe } from './porta.js'

/**
 * Ferramentas de PEDIDO: ver, mexer nos itens, propor. ⚠️ Não existe
 * `pedido_efetivar` nem `pedido_desconto` — e isso é a alçada (ADR-027).
 */
export function ferramentasDePedido(ped: PedidoPorta): Ferramenta<never>[] {
  const ver: Ferramenta<Record<string, never>> = {
    nome: 'pedido_ver',
    descricao: 'Mostra o pedido em aberto desta conversa (itens, quantidades, total). Vazio se não houver.',
    entrada: z.object({}),
    async executar(ctx) {
      const p = await ped.ver(ctx)
      return { ok: true, saida: p ?? { pedido: null, itens: [], totalCentavos: 0 }, centavos: centavosDe(p) }
    },
  }
  const itens: Ferramenta<{ acao: 'adicionar' | 'alterar' | 'remover'; skuId: string | null; seq: number | null; quantidade: number | null }> = {
    nome: 'pedido_itens',
    descricao: 'Adiciona (skuId + quantidade), altera (seq + quantidade) ou remove (seq) um item do rascunho do pedido. O preço é resolvido pela loja na tabela do cliente — você nunca informa preço. Devolve a situação e o pedido atualizado.',
    entrada: z.object({
      acao: z.enum(['adicionar', 'alterar', 'remover']),
      skuId: z.string().uuid().nullable().describe('Obrigatório em adicionar.'),
      seq: z.number().int().positive().nullable().describe('Obrigatório em alterar/remover.'),
      quantidade: z.number().positive().nullable().describe('Obrigatório em adicionar/alterar.'),
    }),
    async executar(ctx, e) {
      let r
      if (e.acao === 'adicionar') {
        if (!e.skuId || !e.quantidade) return { ok: false, erro: 'adicionar exige skuId e quantidade' }
        r = await ped.itens(ctx, { acao: 'adicionar', skuId: e.skuId, quantidade: e.quantidade })
      } else if (e.acao === 'alterar') {
        if (!e.seq || !e.quantidade) return { ok: false, erro: 'alterar exige seq e quantidade' }
        r = await ped.itens(ctx, { acao: 'alterar', seq: e.seq, quantidade: e.quantidade })
      } else {
        if (!e.seq) return { ok: false, erro: 'remover exige seq' }
        r = await ped.itens(ctx, { acao: 'remover', seq: e.seq })
      }
      return {
        ok: true, efeito: 'pedido_alterado',
        saida: { situacao: r.situacao, ...(r.detalhe ? { detalhe: r.detalhe } : {}), ...(r.pedido ? { ...r.pedido } : {}) },
        centavos: centavosDe(r.pedido),
      }
    },
  }
  const propor: Ferramenta<Record<string, never>> = {
    nome: 'pedido_propor',
    descricao: 'Envia ao cliente o resumo do pedido e pede confirmação. Chame só quando o pedido estiver completo e o cliente tiver indicado que quer fechar. Depois disto não repita o resumo.',
    entrada: z.object({}),
    async executar(ctx) {
      const r = await ped.propor(ctx)
      // ⚠️ "faltam R$ 500,00" da regra comercial é número que o modelo PODE repetir (PED-08).
      if (r.situacao !== 'ok') return { ok: true, saida: { situacao: r.situacao, detalhe: r.detalhe ?? null }, centavos: r.centavos ?? [] }
      return { ok: true, efeito: 'proposta_enviada', saida: { situacao: 'ok', resumo: r.resumo, totalCentavos: r.totalCentavos, expiraEm: r.expiraEm }, centavos: [r.totalCentavos] }
    },
  }
  const transferir: Ferramenta<{ motivo: (typeof MOTIVOS_HANDOFF)[number]; resumo: string }> = {
    nome: 'atendimento_transferir',
    descricao: 'Transfere a conversa para uma pessoa da equipe, com o motivo e um resumo do que o cliente quer. Use quando as regras de escalonamento mandarem. Depois de chamar, despeça-se em uma frase.',
    entrada: z.object({
      motivo: z.enum(MOTIVOS_HANDOFF),
      resumo: z.string().min(1).max(600).describe('O que o cliente quer e o que já foi feito, em 1–3 frases.'),
    }),
    async executar(_ctx, e) {
      return { ok: true, efeito: 'handoff', handoff: { motivo: e.motivo, resumo: e.resumo }, saida: { transferido: true } }
    },
  }
  return [ver, itens, propor, transferir] as Ferramenta<never>[]
}

export function ferramentaDeTransferencia(): Ferramenta<never> {
  return ferramentasDePedido({
    ver: async () => null, itens: async () => ({ situacao: 'pedido_imutavel' }), propor: async () => ({ situacao: 'indisponivel' }), recentes: async () => [],
  })[3]!
}
