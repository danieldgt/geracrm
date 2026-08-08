import { randomUUID } from 'node:crypto'
import { normalizarTelefone } from '@geracrm/shared'
import type { ClienteCanonico, ConectorErp } from '@geracrm/conectores'
import type { Sql } from '../../db/index.js'
import { decidirReconciliacao, type Candidato } from './reconciliacao.js'

/**
 * Customer ingestion — where the ERP becomes CRM.
 *
 * ⚠️ Importing is not migrating. This produces a reconciliation report, not
 * just a row count: the Wave 0 exit criterion asks what came in, what was
 * rejected and WHY. A count with no examples fixes nothing.
 */

export interface RelatorioIngestao {
  lidos: number
  criados: number
  vinculados: number
  rejeitados: number
  /** ⚠️ Contacts created because the match was ambiguous. Not errors — they
   *  need human review, and they are the ones that generate duplicates. */
  ambiguos: number
  /** Salespeople the ERP mentioned that match no user here. */
  vendedoresPendentes: number
  /** Sample WITH the reason. */
  rejeicoes: { idExterno: string; motivo: string }[]
}

const LIMITE_AMOSTRA = 50

export async function ingerirClientes(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  conector: ConectorErp,
  opcoes: { maxPaginas?: number } = {},
): Promise<RelatorioIngestao> {
  const r: RelatorioIngestao = {
    lidos: 0, criados: 0, vinculados: 0, rejeitados: 0,
    ambiguos: 0, vendedoresPendentes: 0, rejeicoes: [],
  }

  const sistema = `erp:${conexaoId}`
  let cursor: string | undefined
  let paginas = 0

  do {
    const pagina = await conector.listarClientes(cursor)
    cursor = pagina.cursor
    paginas += 1

    for (const cliente of pagina.itens) {
      r.lidos += 1
      try {
        await ingerirUm(tx, tenantId, conexaoId, sistema, cliente, r)
      } catch (erro) {
        r.rejeitados += 1
        if (r.rejeicoes.length < LIMITE_AMOSTRA) {
          r.rejeicoes.push({
            idExterno: cliente.idExterno,
            motivo: erro instanceof Error ? erro.message : String(erro),
          })
        }
      }
    }
  } while (cursor && (!opcoes.maxPaginas || paginas < opcoes.maxPaginas))

  return r
}

async function ingerirUm(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  sistema: string,
  cliente: ClienteCanonico,
  r: RelatorioIngestao,
): Promise<void> {
  if (!cliente.nome?.trim()) throw new Error('cliente sem nome')

  // ⚠️ Normalise on write. The ERP stores "(81) 99861-7049"; WhatsApp sends
  // "5581998617049". They must land identical or the base duplicates silently.
  const telefones = cliente.telefones
    .map((t) => normalizarTelefone(t))
    .filter((t): t is NonNullable<typeof t> => t !== null)

  const documento = cliente.documento?.replace(/\D/g, '') || undefined

  // Gather every contact that answers to any signal, then decide — instead of
  // stopping at the first hit, which would hide ambiguity.
  const achados = await tx<{
    contato_id: string
    por_identidade: boolean
    por_documento: boolean
    por_telefone_principal: boolean
  }[]>`
    WITH por_id AS (
      SELECT contato_id FROM contato_identidade_externa
       WHERE tenant_id = ${tenantId} AND sistema = ${sistema} AND id_externo = ${cliente.idExterno}
    ),
    por_doc AS (
      SELECT contato_id FROM contato_documento
       WHERE tenant_id = ${tenantId} AND ${documento ?? null}::text IS NOT NULL
         AND numero = ${documento ?? null}
    ),
    por_tel AS (
      SELECT contato_id, principal FROM contato_telefone
       WHERE tenant_id = ${tenantId}
         AND e164 = ANY(${telefones.map((t) => t.e164)}::text[])
    )
    SELECT c.id AS contato_id,
           (c.id IN (SELECT contato_id FROM por_id))  AS por_identidade,
           (c.id IN (SELECT contato_id FROM por_doc)) AS por_documento,
           (c.id IN (SELECT contato_id FROM por_tel WHERE principal)) AS por_telefone_principal
      FROM contato c
     WHERE c.tenant_id = ${tenantId}
       AND (c.id IN (SELECT contato_id FROM por_id)
         OR c.id IN (SELECT contato_id FROM por_doc)
         OR c.id IN (SELECT contato_id FROM por_tel))
  `

  const candidatos: Candidato[] = achados.map((a) => ({
    contatoId: a.contato_id,
    porIdentidadeExterna: a.por_identidade,
    porDocumento: a.por_documento,
    porTelefonePrincipal: a.por_telefone_principal,
  }))

  const decisao = decidirReconciliacao(candidatos)
  if (decisao.ambiguo) r.ambiguos += 1

  let contatoId: string
  if (decisao.acao === 'vincular' && decisao.contatoId) {
    contatoId = decisao.contatoId
    r.vinculados += 1
    // ⚠️ Only the name is refreshed, and only when it was NOT edited by hand.
    // Overwriting a manual correction on every sync teaches the salesperson
    // that fixing anything is pointless.
    await tx`
      UPDATE contato SET nome = ${cliente.nome}
       WHERE tenant_id = ${tenantId} AND id = ${contatoId}
         AND NOT EXISTS (
           SELECT 1 FROM contato_campo_origem
            WHERE tenant_id = ${tenantId} AND contato_id = ${contatoId}
              AND campo = 'nome' AND manual
         )
    `
  } else {
    contatoId = randomUUID()
    r.criados += 1
    await tx`
      INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
      VALUES (${tenantId}, ${contatoId}, ${cliente.nome}, ${'carga:' + conexaoId}, ${cliente.ativo})
    `
  }

  // External identity is idempotent by primary key: re-running the load does
  // not duplicate the link.
  await tx`
    INSERT INTO contato_identidade_externa (tenant_id, contato_id, sistema, id_externo)
    VALUES (${tenantId}, ${contatoId}, ${sistema}, ${cliente.idExterno})
    ON CONFLICT (tenant_id, sistema, id_externo) DO UPDATE SET visto_em = now()
  `

  await tx`
    INSERT INTO contato_nome (tenant_id, contato_id, seq, nome, fonte, preferido)
    VALUES (${tenantId}, ${contatoId},
            (SELECT coalesce(max(seq), 0) + 1 FROM contato_nome
              WHERE tenant_id = ${tenantId} AND contato_id = ${contatoId}),
            ${cliente.nome}, 'erp', false)
    ON CONFLICT DO NOTHING
  `

  for (const tel of telefones) {
    // ⚠️ The first phone of a NEW contact becomes primary; on an existing one it
    // does not — the phone the salesperson chose outranks whatever the ERP has.
    const principal = decisao.acao === 'criar' && tel === telefones[0]
    await tx`
      INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
      SELECT ${tenantId}, ${contatoId},
             (SELECT coalesce(max(seq), 0) + 1 FROM contato_telefone
               WHERE tenant_id = ${tenantId} AND contato_id = ${contatoId}),
             ${tel.e164}, ${tel.chaveBloqueio}, ${principal}, 'erp'
       WHERE NOT EXISTS (
         SELECT 1 FROM contato_telefone
          WHERE tenant_id = ${tenantId} AND contato_id = ${contatoId} AND e164 = ${tel.e164}
       )
    `
  }

  if (documento) {
    const tipo = documento.length === 14 ? 'cnpj' : 'cpf'
    await tx`
      INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte)
      SELECT ${tenantId}, ${contatoId},
             (SELECT coalesce(max(seq), 0) + 1 FROM contato_documento
               WHERE tenant_id = ${tenantId} AND contato_id = ${contatoId}),
             ${tipo}, ${documento}, false, 'erp'
       WHERE NOT EXISTS (
         SELECT 1 FROM contato_documento
          WHERE tenant_id = ${tenantId} AND contato_id = ${contatoId} AND numero = ${documento}
       )
    `
  }

  if (cliente.vendedorExterno) {
    await resolverVendedor(tx, tenantId, conexaoId, contatoId, cliente.vendedorExterno, r)
  }
}

/**
 * The ERP names the salesperson as free text ("EDUARDA"). Turning that into a
 * wallet assignment is what migration 0007 exists for.
 *
 * ⚠️ An unmatched name is NEVER dropped. Silently discarding it means the sale
 * lands, revenue closes, and the salesperson simply does not appear in the
 * ranking — nobody notices until she complains.
 */
async function resolverVendedor(
  tx: Sql,
  tenantId: string,
  conexaoId: string,
  contatoId: string,
  vendedorExterno: string,
  r: RelatorioIngestao,
): Promise<void> {
  const [correspondencia] = await tx<{ usuario_id: string }[]>`
    SELECT usuario_id FROM usuario_identidade_externa
     WHERE tenant_id = ${tenantId} AND conexao_id = ${conexaoId} AND id_externo = ${vendedorExterno}
  `

  if (!correspondencia) {
    r.vendedoresPendentes += 1
    // Counted by occurrences so the "EDUARDA" with 4.000 sales gets resolved
    // before the one with 2.
    await tx`
      INSERT INTO correspondencia_pendente (tenant_id, conexao_id, tipo, id_externo)
      VALUES (${tenantId}, ${conexaoId}, 'usuario', ${vendedorExterno})
      ON CONFLICT (tenant_id, conexao_id, tipo, id_externo)
      DO UPDATE SET ocorrencias = correspondencia_pendente.ocorrencias + 1, ultimo_em = now()
    `
    return
  }

  // ⚠️ Never overwrite an assignment made by a person. The ERP is the source
  // for the initial load, not the authority over who owns the customer here.
  const [atual] = await tx<{ origem: string }[]>`
    SELECT origem FROM carteira_atribuicao
     WHERE tenant_id = ${tenantId} AND contato_id = ${contatoId} AND ate IS NULL
  `
  if (atual && atual.origem === 'manual') return

  await tx`
    SELECT transferir_carteira(${tenantId}, ${contatoId}, ${correspondencia.usuario_id}, NULL, 'carga')
  `
}
