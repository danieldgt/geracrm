import { randomUUID } from 'node:crypto'
import { MAX_INDICACOES, NOME_ORIGEM_INDICACAO, normalizarTelefone } from '@geracrm/shared'
import { emSavepoint, type Sql } from '../../db/index.js'

/**
 * INDICAÇÕES (raia G3; AM `registrar_indicacoes`). Módulo público do CRM que a
 * ferramenta do agente chama — o agente não escreve em `contato` direto.
 *
 *   indicado novo     → contato com origem "Indicação" (criada no tenant se faltar),
 *                       `indicado_por` = o indicante, telefone principal; SEM DONO —
 *                       entra na distribuição normal (não herda a carteira do indicante:
 *                       é a regra mais simples e a que não tira lead de quem distribui).
 *   telefone já existe → NÃO duplica: só registra a indicação no feed do existente
 *                       (comentário do sistema). Para quem chamou: `ja_cliente`, e nada
 *                       mais — nem id, nem nome, nem se é cliente ou lead de verdade.
 *
 * ⚠️ Dedup pela CHAVE DE BLOQUEIO (55 + DDD + 8 últimos): com e sem o nono dígito
 *    é o mesmo telefone (INV-50), como no POST de contatos.
 * ⚠️ Corrida com outro cadastro do mesmo número: o índice único do principal recusa
 *    e o savepoint desfaz só aquele indicado, que vira `ja_cliente`.
 * Chamar sob tenant (RLS).
 */

export type SituacaoIndicacao = 'criado' | 'ja_cliente' | 'telefone_invalido' | 'proprio_cliente' | 'repetido'

export interface IndicacaoEntrada {
  readonly nome: string
  readonly telefone: string
  readonly observacao?: string | null | undefined
}

export interface ResultadoIndicacoes {
  readonly itens: readonly { readonly nome: string; readonly situacao: SituacaoIndicacao }[]
  readonly criados: number
  readonly origemCriada: boolean
}

const MAX_NOME = 120
const MAX_OBSERVACAO = 300

export class ErroIndicacoes extends Error {
  constructor(readonly codigo: 'limite' | 'vazio' | 'indicante_inexistente') { super(codigo) }
}

/** A origem "Indicação" do tenant (criada se faltar). Reaproveita a existente mesmo desativada. */
export async function garantirOrigemIndicacao(tx: Sql): Promise<{ id: string; criada: boolean }> {
  const [existe] = await tx<{ id: string }[]>`
    SELECT id FROM origem WHERE tenant_id = tenant_atual() AND lower(nome) = lower(${NOME_ORIGEM_INDICACAO})`
  if (existe) return { id: existe.id, criada: false }
  const [nova] = await tx<{ id: string }[]>`
    INSERT INTO origem (tenant_id, id, nome, ativa, ordem)
    VALUES (tenant_atual(), ${randomUUID()}, ${NOME_ORIGEM_INDICACAO}, true, 0)
    ON CONFLICT DO NOTHING RETURNING id`
  if (nova) return { id: nova.id, criada: true }
  const [corrida] = await tx<{ id: string }[]>`
    SELECT id FROM origem WHERE tenant_id = tenant_atual() AND lower(nome) = lower(${NOME_ORIGEM_INDICACAO})`
  return { id: corrida!.id, criada: false }
}

const ehTelefonePrincipalDuplicado = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
  && (err as { constraint_name?: string }).constraint_name === 'contato_telefone_principal_unico'

export async function registrarIndicacoes(
  tx: Sql, p: { indicanteId: string; indicacoes: readonly IndicacaoEntrada[] },
): Promise<ResultadoIndicacoes> {
  if (p.indicacoes.length === 0) throw new ErroIndicacoes('vazio')
  if (p.indicacoes.length > MAX_INDICACOES) throw new ErroIndicacoes('limite')
  const [indicante] = await tx<{ nome: string }[]>`
    SELECT nome FROM contato WHERE tenant_id = tenant_atual() AND id = ${p.indicanteId}`
  if (!indicante) throw new ErroIndicacoes('indicante_inexistente')
  const [chavesDoIndicante] = await tx<{ chaves: string[] }[]>`
    SELECT coalesce(array_agg(chave_bloqueio), '{}') AS chaves FROM contato_telefone
     WHERE tenant_id = tenant_atual() AND contato_id = ${p.indicanteId}`
  const proprias = new Set(chavesDoIndicante?.chaves ?? [])

  let origem: { id: string; criada: boolean } | null = null
  const vistas = new Set<string>()
  const itens: { nome: string; situacao: SituacaoIndicacao }[] = []
  let criados = 0

  for (const ind of p.indicacoes) {
    const nome = ind.nome.trim().slice(0, MAX_NOME) || 'Indicação'
    const tel = normalizarTelefone(ind.telefone)
    if (!tel) { itens.push({ nome, situacao: 'telefone_invalido' }); continue }
    if (proprias.has(tel.chaveBloqueio)) { itens.push({ nome, situacao: 'proprio_cliente' }); continue }
    if (vistas.has(tel.chaveBloqueio)) { itens.push({ nome, situacao: 'repetido' }); continue }
    vistas.add(tel.chaveBloqueio)

    const [existe] = await tx<{ contato_id: string }[]>`
      SELECT contato_id FROM contato_telefone
       WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio} AND principal LIMIT 1`
    if (existe) {
      await comentarIndicacao(tx, existe.contato_id, indicante.nome, null)
      itens.push({ nome, situacao: 'ja_cliente' })
      continue
    }

    origem ??= await garantirOrigemIndicacao(tx)
    const observacao = ind.observacao?.trim() ? ind.observacao.trim().slice(0, MAX_OBSERVACAO) : null
    const id = randomUUID()
    try {
      await emSavepoint(tx, async (sp) => {
        await sp`
          INSERT INTO contato (tenant_id, id, nome, origem_id, indicado_por, observacoes, origem_carga, ativo)
          VALUES (tenant_atual(), ${id}, ${nome}, ${origem!.id}, ${p.indicanteId}, ${observacao}, 'indicacao', true)`
        await sp`
          INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
          VALUES (tenant_atual(), ${id}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, true, 'indicacao')`
        await comentarIndicacao(sp, id, indicante.nome, observacao)
      })
      criados += 1
      itens.push({ nome, situacao: 'criado' })
    } catch (err) {
      if (!ehTelefonePrincipalDuplicado(err)) throw err
      itens.push({ nome, situacao: 'ja_cliente' })
    }
  }
  return { itens, criados, origemCriada: origem?.criada ?? false }
}

/** Fato de gestão no feed do contato (comentário do sistema, sem autor). */
async function comentarIndicacao(tx: Sql, contatoId: string, nomeIndicante: string, observacao: string | null): Promise<void> {
  const texto = `Indicado por ${nomeIndicante} (registrado pelo agente no pós-venda).${observacao ? ` Observação: ${observacao}` : ''}`
  await tx`INSERT INTO comentario (tenant_id, id, contato_id, autor_id, texto)
           VALUES (tenant_atual(), ${randomUUID()}, ${contatoId}, NULL, ${texto})`
}
