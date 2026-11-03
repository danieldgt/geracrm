import { z } from 'zod'
import { LIMITES_OBJECOES, type ObjecaoPlaybook } from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { gravarObjecao } from '../objecoes.js'
import type { Ferramenta } from './porta.js'

/**
 * `registrar_objecao` (raia G2) — o modelo anota a objeção do cliente pelo
 * código do playbook publicado e se ela foi REVERTIDA.
 *
 * ⚠️ SÓ REGISTRA. Não responde ao cliente, não transfere: quem decide a entrega
 *    na 3ª objeção não revertida seguida é a etapa `objecoes-seguidas` (ADR-029:
 *    o que protege fica no código). O registro do turno sai por `objecao` na
 *    saída e chega à etapa pelo registro de ferramentas.
 * ⚠️ Código fora das objeções ATIVAS do playbook → erro tipificado
 *    `codigo_desconhecido` (volta ao modelo como erro de ferramenta).
 * ⚠️ MODOS: autônomo e assistido gravam o fato em `agente_objecao` (relatório).
 *    Sombra, simulação e copiloto respondem em modo seco — o registro fica só no
 *    estado da sessão (sombra) ou da simulação.
 * ⚠️ Descrição FIXA (sem os códigos do tenant): a lista de ferramentas é o começo
 *    do prefixo cacheado; os códigos vão no bloco do playbook.
 */
export const NOME_FERRAMENTA_OBJECAO = 'registrar_objecao'

const MODOS_QUE_GRAVAM: ReadonlySet<string> = new Set(['autonomo', 'assistido'])

export function ferramentaRegistrarObjecao(objecoes: readonly ObjecaoPlaybook[]): Ferramenta<never> {
  const ativas = objecoes.filter((o) => o.ativo)
  const f: Ferramenta<{ codigo: string; revertida: boolean; observacao: string | null }> = {
    nome: NOME_FERRAMENTA_OBJECAO,
    descricao: 'Registra uma objeção do cliente pelo CÓDIGO do playbook (lista em <objecoes> do playbook, ex.: OBJ-01) e se ela foi revertida: revertida=true quando o cliente aceitou o argumento e seguiu na conversa; false quando manteve a objeção. Chame no turno em que tratar a objeção. Só registra — não envia nada ao cliente nem transfere. Código fora da lista volta como erro.',
    entrada: z.object({
      codigo: z.string().trim().min(1).max(12),
      revertida: z.boolean(),
      observacao: z.string().max(LIMITES_OBJECOES.observacaoObjecao).nullable(),
    }),
    async executar(ctx, e) {
      const codigo = e.codigo.trim().toUpperCase()
      const o = ativas.find((x) => x.codigo === codigo)
      if (!o) {
        const validos = ativas.map((x) => x.codigo).join(', ') || 'nenhum'
        return { ok: false, erro: `codigo_desconhecido: ${codigo} não está nas objeções do playbook. Códigos válidos: ${validos}.` }
      }
      const registro = { codigo, revertida: e.revertida }
      if (!MODOS_QUE_GRAVAM.has(ctx.modo)) {
        return { ok: true, saida: { registrada: true, codigo, revertida: e.revertida, modoSeco: true }, objecao: registro }
      }
      await comTenantServico(ctx.tenantId, (tx) => gravarObjecao(tx, {
        canalId: ctx.canalId, conversaId: ctx.conversaId, contatoId: ctx.contatoId, sessaoId: ctx.sessaoId,
        codigo, objecao: o.objecao, revertida: e.revertida, observacao: e.observacao, agora: ctx.agora,
      }))
      return { ok: true, saida: { registrada: true, codigo, revertida: e.revertida }, objecao: registro }
    },
  }
  return f as Ferramenta<never>
}
