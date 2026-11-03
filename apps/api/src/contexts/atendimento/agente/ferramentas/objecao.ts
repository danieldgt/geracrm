import { z } from 'zod'
import { LIMITES_OBJECOES, type ObjecaoPlaybook } from '@geracrm/shared'
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
 * ⚠️ NÃO GRAVA no banco: o fato em `agente_objecao` (relatório) é gravado pelo
 *    `concluir` do turno, na transação da decisão, só se o turno se confirma
 *    (`gravarObjecoesDoTurno`, em autônomo/assistido). Turno superado, falho ou
 *    refeito não deixa fato. Sombra, simulação e copiloto respondem em modo seco.
 * ⚠️ UMA vez por código por turno: repetir o mesmo código no turno é ok
 *    idempotente (não empilha de novo no registro do turno).
 * ⚠️ Descrição FIXA (sem os códigos do tenant): a lista de ferramentas é o começo
 *    do prefixo cacheado; os códigos vão no bloco do playbook.
 */
export const NOME_FERRAMENTA_OBJECAO = 'registrar_objecao'

export function ferramentaRegistrarObjecao(objecoes: readonly ObjecaoPlaybook[]): Ferramenta<never> {
  const ativas = objecoes.filter((o) => o.ativo)
  /** A ferramenta é montada por turno: o que já foi registrado neste turno. */
  const jaNoTurno = new Set<string>()
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
      const modoSeco = ctx.modo === 'sombra' || ctx.modo === 'simulacao' || ctx.modo === 'copiloto'
      const saida = { registrada: true, codigo, revertida: e.revertida, ...(modoSeco ? { modoSeco: true } : {}) }
      if (jaNoTurno.has(codigo)) return { ok: true, saida }
      jaNoTurno.add(codigo)
      return { ok: true, saida, objecao: { codigo, revertida: e.revertida, objecao: o.objecao, observacao: e.observacao } }
    },
  }
  return f as Ferramenta<never>
}
