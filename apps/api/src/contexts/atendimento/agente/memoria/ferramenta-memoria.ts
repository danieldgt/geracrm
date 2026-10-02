import { z } from 'zod'
import { comTenantServico } from '../../../../db/index.js'
import type { Ferramenta } from '../ferramentas/porta.js'
import { anotarMemoria, MAX_FATO, TIPOS_MEMORIA } from './memoria.js'

/**
 * `memoria_anotar` — a única forma de o modelo lembrar algo para a próxima
 * conversa. Entrada estrita (strict exige todos os campos; nada opcional),
 * saída nomeada: anotou ou não, e por quê.
 *
 * ⚠️ Recusa de dado sensível volta como `anotado: false, motivo: 'fato_sensivel'`
 *    — nunca como erro: o modelo continua a venda, só não grava aquilo.
 */
export function ferramentaMemoriaAnotar(): Ferramenta<never> {
  const f: Ferramenta<{ tipo: (typeof TIPOS_MEMORIA)[number]; fato: string }> = {
    nome: 'memoria_anotar',
    descricao: 'Guarda um fato curto sobre o cliente para as próximas conversas: preferência (tamanho, cor, marca), objeção (achou caro, frete), contexto (compra para revender, loja em Fortaleza) ou restrição (não aceita boleto). Nunca documento, telefone, e-mail ou endereço — serão recusados.',
    entrada: z.object({
      tipo: z.enum(TIPOS_MEMORIA),
      fato: z.string().min(3).max(MAX_FATO),
    }),
    async executar(ctx, e) {
      const r = await comTenantServico(ctx.tenantId, (tx) => anotarMemoria(tx, { contatoId: ctx.contatoId, tipo: e.tipo, fato: e.fato }))
      if (r.resultado === 'ok' || r.resultado === 'duplicado') return { ok: true, saida: { anotado: true, motivo: r.resultado === 'duplicado' ? 'ja_sabiamos' : undefined } }
      return { ok: true, saida: { anotado: false, motivo: r.resultado } }
    },
  }
  return f as Ferramenta<never>
}
