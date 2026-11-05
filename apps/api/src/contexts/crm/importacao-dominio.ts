import { createHash, randomUUID } from 'node:crypto'
import type { ResultadoItem, DePara, TipoImportacao } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { emSavepoint } from '../../db/index.js'
import { gravarDocumento, gravarEndereco } from './contato-gravacao.js'
import {
  LinhaCsv, lerContato, lerTarefa, lerVenda,
  type ChaveContato, type ContatoLido, type TarefaLida, type VendaLida,
} from './importacao-regras.js'

/**
 * O que uma linha do arquivo FAZ no domínio (raia H1) — a MESMA decisão serve a simulação (modo `simular`: só lê,
 * devolve o resultado previsto) e à execução (modo `executar`: grava). Uma regra só: o que a simulação promete
 * é o que a execução faz.
 *
 * ⚠️ Contato existente é COMPLETADO, nunca sobrescrito: só entra o que está em branco (e-mail, razão social,
 *    origem, documento, endereço, carteira, etiquetas). Nome, qualificação e data de criação não mudam, e a
 *    linha do ERP (documento/endereço/telefone) nunca é tocada — documento/endereço só são gravados quando o
 *    contato não tem NENHUM. Documento e endereço novos passam por `contato-gravacao.ts`, o caminho único.
 * ⚠️ Tudo roda sob o tenant da transação (`tenant_atual()`); nada recebe tenant por parâmetro.
 * ⚠️ `motivo` é código, nunca o conteúdo da célula.
 */

export interface OpcoesImportacao {
  readonly criarOrigens: boolean
  readonly criarEtiquetas: boolean
}

export interface Desfecho {
  readonly resultado: ResultadoItem
  readonly motivo: string | null
  readonly referenciaId: string | null
}

export interface Catalogos {
  readonly origens: Map<string, string>
  readonly etiquetas: Map<string, string>
  readonly usuarios: Map<string, { id: string; filialId: string | null }>
}

export interface ContextoLinha {
  readonly modo: 'simular' | 'executar'
  readonly importacaoId: string
  readonly arquivoHash: string
  readonly usuarioId: string | null
  readonly opcoes: OpcoesImportacao
  readonly agora: Date
  readonly colunas: readonly string[]
  readonly dePara: DePara
  readonly catalogos: Catalogos
  /** Só na simulação: chaves já vistas no arquivo (duplicada_no_arquivo). Na execução vale o que já está em importacao_item. */
  readonly vistos: Set<string>
  /** Só na simulação: mês (AAAA-MM) → existe partição de venda para ele? (sondado uma vez por mês). */
  readonly horizonte: Map<string, boolean>
}

const rejeitado = (motivo: string): Desfecho => ({ resultado: 'rejeitado', motivo, referenciaId: null })
const ignorado = (motivo: string, referenciaId: string | null = null): Desfecho => ({ resultado: 'ignorado', motivo, referenciaId })

export async function carregarCatalogos(tx: Sql): Promise<Catalogos> {
  const origens = await tx<{ id: string; nome: string }[]>`SELECT id, nome FROM origem WHERE tenant_id = tenant_atual() AND ativa`
  const etiquetas = await tx<{ id: string; nome: string }[]>`SELECT id, nome FROM etiqueta WHERE tenant_id = tenant_atual() AND ativa`
  const usuarios = await tx<{ id: string; email: string; filial_id: string | null }[]>`
    SELECT u.id, lower(u.email) AS email,
           (SELECT CASE WHEN count(*) = count(uf.filial_id) AND count(DISTINCT uf.filial_id) = 1
                        THEN min(uf.filial_id::text)::uuid END
              FROM usuario_filial uf WHERE uf.tenant_id = u.tenant_id AND uf.usuario_id = u.id) AS filial_id
      FROM usuario u WHERE u.tenant_id = tenant_atual() AND u.ativo`
  return {
    origens: new Map(origens.map((o) => [o.nome.toLowerCase(), o.id])),
    etiquetas: new Map(etiquetas.map((e) => [e.nome.toLowerCase(), e.id])),
    usuarios: new Map(usuarios.map((u) => [u.email, { id: u.id, filialId: u.filial_id }])),
  }
}

/** Lê a linha do arquivo conforme o tipo e aplica no domínio (ou só prevê, na simulação). */
export async function processarLinha(
  tx: Sql, tipo: TipoImportacao, campos: readonly string[], numeroLinha: number, c: ContextoLinha,
): Promise<Desfecho> {
  const linha = new LinhaCsv(c.colunas, c.dePara, campos)
  if (tipo === 'contatos') {
    const l = lerContato(linha, c.agora)
    return l.ok ? contato(tx, l.dado, c) : rejeitado(l.motivo)
  }
  if (tipo === 'vendas') {
    const l = lerVenda(linha, c.agora)
    return l.ok ? venda(tx, l.dado, numeroLinha, c) : rejeitado(l.motivo)
  }
  const l = lerTarefa(linha)
  return l.ok ? tarefa(tx, l.dado, c) : rejeitado(l.motivo)
}

// ---------------------------------------------------------------------------
// Localizar o contato
// ---------------------------------------------------------------------------

/**
 * Documento primeiro; o telefone (principal) só vale para quem não traz documento — para pessoa jurídica a identidade
 * é o CNPJ e o telefone é do escritório (mesma regra do import simples). `fallbackTelefone`: vendas e tarefas só
 * IDENTIFICAM, então, se o documento não achou, o telefone ainda serve.
 */
interface ContatoAchado { readonly id: string; readonly anonimizado: boolean }

async function acharContato(tx: Sql, k: ChaveContato, fallbackTelefone: boolean): Promise<ContatoAchado | null> {
  if (k.documento) {
    const [d] = await tx<{ contato_id: string; anonimizado: boolean }[]>`
      SELECT d.contato_id, (c.anonimizado_em IS NOT NULL) AS anonimizado
        FROM contato_documento d JOIN contato c ON c.tenant_id = d.tenant_id AND c.id = d.contato_id
       WHERE d.tenant_id = tenant_atual() AND d.numero = ${k.documento} LIMIT 1`
    if (d) return { id: d.contato_id, anonimizado: d.anonimizado }
    if (!fallbackTelefone) return null
  }
  if (k.chaveBloqueio) {
    const [t] = await tx<{ contato_id: string; anonimizado: boolean }[]>`
      SELECT t.contato_id, (c.anonimizado_em IS NOT NULL) AS anonimizado
        FROM contato_telefone t JOIN contato c ON c.tenant_id = t.tenant_id AND c.id = t.contato_id
       WHERE t.tenant_id = tenant_atual() AND t.chave_bloqueio = ${k.chaveBloqueio} AND t.principal LIMIT 1`
    if (t) return { id: t.contato_id, anonimizado: t.anonimizado }
  }
  return null
}

/** ⚠️ LGPD: a chave do telefone pertence a titular que pediu para ser esquecido — a importação não o traz de volta. */
async function bloqueadoLgpd(tx: Sql, chaveBloqueio: string | null): Promise<boolean> {
  if (!chaveBloqueio) return false
  const [l] = await tx`
    SELECT 1 FROM lista_bloqueio WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${chaveBloqueio} AND lgpd_em IS NOT NULL LIMIT 1`
  return !!l
}

// ---------------------------------------------------------------------------
// Contatos
// ---------------------------------------------------------------------------

interface Referencias {
  origemId: string | null
  etiquetaIds: string[]
  vendedor: { id: string; filialId: string | null } | null
  avisos: string[]
}

async function resolverReferencias(tx: Sql, l: ContatoLido, c: ContextoLinha): Promise<Referencias> {
  const r: Referencias = { origemId: null, etiquetaIds: [], vendedor: null, avisos: [] }
  const cat = c.catalogos
  const executar = c.modo === 'executar'
  if (l.origem) {
    const k = l.origem.toLowerCase()
    let id = cat.origens.get(k) ?? null
    if (!id && c.opcoes.criarOrigens) {
      if (executar) {
        const novo = randomUUID()
        await tx`INSERT INTO origem (tenant_id, id, nome) VALUES (tenant_atual(), ${novo}, ${l.origem})
                 ON CONFLICT (tenant_id, lower(nome)) DO NOTHING`
        const [o] = await tx<{ id: string }[]>`SELECT id FROM origem WHERE tenant_id = tenant_atual() AND lower(nome) = ${k}`
        id = o?.id ?? null
        if (id) cat.origens.set(k, id)
      } else id = 'a-criar'
    }
    if (id) r.origemId = id === 'a-criar' ? null : id
    else r.avisos.push('origem_inexistente')
  }
  for (const nome of l.etiquetas) {
    const k = nome.toLowerCase()
    let id = cat.etiquetas.get(k) ?? null
    if (!id && c.opcoes.criarEtiquetas) {
      if (executar) {
        await tx`INSERT INTO etiqueta (tenant_id, id, nome) VALUES (tenant_atual(), ${randomUUID()}, ${nome})
                 ON CONFLICT (tenant_id, lower(nome)) DO NOTHING`
        const [e] = await tx<{ id: string }[]>`SELECT id FROM etiqueta WHERE tenant_id = tenant_atual() AND lower(nome) = ${k}`
        id = e?.id ?? null
        if (id) cat.etiquetas.set(k, id)
      } else id = 'a-criar'
    }
    if (id) { if (id !== 'a-criar') r.etiquetaIds.push(id) }
    else if (!r.avisos.includes('etiqueta_inexistente')) r.avisos.push('etiqueta_inexistente')
  }
  if (l.vendedorEmail) {
    const u = cat.usuarios.get(l.vendedorEmail)
    if (u) r.vendedor = u
    else r.avisos.push('vendedor_inexistente')
  }
  return r
}

async function contato(tx: Sql, l: ContatoLido, c: ContextoLinha): Promise<Desfecho> {
  if (await bloqueadoLgpd(tx, l.telefone.chaveBloqueio)) return ignorado('bloqueado_lgpd')
  const achado = await acharContato(tx, { documento: l.documento, chaveBloqueio: l.telefone.chaveBloqueio }, false)
  if (achado?.anonimizado) return ignorado('contato_anonimizado', achado.id)
  const chaveNova = l.documento ? `d:${l.documento}` : `t:${l.telefone.chaveBloqueio}`
  if (c.modo === 'simular') {
    // A MESMA decisão da execução, por contato RESOLVIDO: repetir o contato (existente ou criado antes) é duplicada.
    const chave = achado ? `c:${achado.id}` : chaveNova
    if (c.vistos.has(chave)) return ignorado('duplicada_no_arquivo', achado?.id ?? null)
    c.vistos.add(chave)
  }
  const ref = await resolverReferencias(tx, l, c)
  if (achado) {
    if (c.modo === 'executar') {
      const [jaTratado] = await tx`
        SELECT 1 FROM importacao_item
         WHERE tenant_id = tenant_atual() AND importacao_id = ${c.importacaoId} AND resultado <> 'rejeitado' AND referencia_id = ${achado.id}
         LIMIT 1`
      if (jaTratado) return ignorado('duplicada_no_arquivo', achado.id)
    }
    return completarExistente(tx, achado.id, l, ref, c)
  }
  if (c.modo === 'simular') {
    // O telefone da linha criada vira principal (se ninguém o detém): outra linha só com ele cai neste contato.
    if (l.documento) {
      const [dono] = await tx`
        SELECT 1 FROM contato_telefone
         WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${l.telefone.chaveBloqueio} AND principal LIMIT 1`
      if (!dono) c.vistos.add(`t:${l.telefone.chaveBloqueio}`)
    }
    return { resultado: 'criado', motivo: ref.avisos[0] ?? null, referenciaId: null }
  }
  return criarContato(tx, l, ref, c)
}

async function criarContato(tx: Sql, l: ContatoLido, ref: Referencias, c: ContextoLinha): Promise<Desfecho> {
  const id = randomUUID()
  const qualificado = l.qualificacao === 'qualificado' ? true : l.qualificacao === 'descartado' ? false : null
  const qualificadoEm = qualificado === null ? null : c.agora
  const filialId = ref.vendedor?.filialId ?? null
  await tx`
    INSERT INTO contato (tenant_id, id, nome, razao_social, nome_fantasia, email, origem_id, filial_id, observacoes,
                         qualificado, qualificado_em, origem_carga, ativo, criado_em)
    VALUES (tenant_atual(), ${id}, ${l.nome}, ${l.razaoSocial}, ${l.nomeFantasia}, ${l.email}, ${ref.origemId}, ${filialId},
            ${l.observacoes}, ${qualificado}, ${qualificadoEm}, 'importacao', true, ${l.criadoEm ?? c.agora})`
  // ⚠️ `principal` só se ninguém mais o detém (B2B: o telefone do grupo pode ser de outra empresa).
  const [dono] = await tx`
    SELECT 1 FROM contato_telefone
     WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${l.telefone.chaveBloqueio} AND principal LIMIT 1`
  await tx`
    INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
    VALUES (tenant_atual(), ${id}, 1, ${l.telefone.e164}, ${l.telefone.chaveBloqueio}, ${!dono}, ${l.whatsapp}, 'importacao')`
  if (l.documento) await gravarDocumento(tx, id, { documento: l.documento })
  if (temEndereco(l)) await gravarEndereco(tx, id, { endereco: l.endereco })
  for (const etiquetaId of ref.etiquetaIds) {
    await tx`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES (tenant_atual(), ${id}, ${etiquetaId})
             ON CONFLICT DO NOTHING`
  }
  if (ref.vendedor) await atribuirCarteira(tx, id, ref.vendedor.id)
  return { resultado: 'criado', motivo: ref.avisos[0] ?? null, referenciaId: id }
}

const temEndereco = (l: ContatoLido) => Object.values(l.endereco).some((x) => x !== null)

async function atribuirCarteira(tx: Sql, contatoId: string, usuarioId: string): Promise<void> {
  await tx`
    INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, origem, motivo)
    VALUES (tenant_atual(), ${randomUUID()}, ${contatoId}, ${usuarioId}, 'carga', 'importacao')`
}

async function completarExistente(tx: Sql, id: string, l: ContatoLido, ref: Referencias, c: ContextoLinha): Promise<Desfecho> {
  const executar = c.modo === 'executar'
  const [atual] = await tx<{
    email: string | null; razao_social: string | null; nome_fantasia: string | null; origem_id: string | null
    observacoes: string | null; filial_id: string | null
  }[]>`SELECT email, razao_social, nome_fantasia, origem_id, observacoes, filial_id
         FROM contato WHERE tenant_id = tenant_atual() AND id = ${id}`
  if (!atual) return ignorado('ja_existe', id)

  // Só colunas EM BRANCO recebem valor — o que já está lá (do ERP ou digitado) fica como está.
  const preencher: Record<string, string> = {}
  if (!atual.email && l.email) preencher.email = l.email
  if (!atual.razao_social && l.razaoSocial) preencher.razao_social = l.razaoSocial
  if (!atual.nome_fantasia && l.nomeFantasia) preencher.nome_fantasia = l.nomeFantasia
  if (!atual.observacoes && l.observacoes) preencher.observacoes = l.observacoes
  if (!atual.origem_id && ref.origemId) preencher.origem_id = ref.origemId
  if (!atual.filial_id && ref.vendedor?.filialId) preencher.filial_id = ref.vendedor.filialId
  let mudou = Object.keys(preencher).length > 0
  if (executar && mudou) {
    await tx`UPDATE contato SET ${tx(preencher)} WHERE tenant_id = tenant_atual() AND id = ${id}`
  }

  const [docs] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${id}`
  if (l.documento && docs!.n === 0) {
    mudou = true
    if (executar) await gravarDocumento(tx, id, { documento: l.documento })
  }
  const [ends] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM contato_endereco WHERE tenant_id = tenant_atual() AND contato_id = ${id}`
  if (temEndereco(l) && ends!.n === 0) {
    mudou = true
    if (executar) await gravarEndereco(tx, id, { endereco: l.endereco })
  }

  const [tel] = await tx`
    SELECT 1 FROM contato_telefone WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND chave_bloqueio = ${l.telefone.chaveBloqueio}`
  if (!tel) {
    mudou = true
    if (executar) {
      await tx`
        INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
        SELECT tenant_atual(), ${id}, coalesce(max(seq), 0) + 1, ${l.telefone.e164}, ${l.telefone.chaveBloqueio},
               NOT EXISTS (SELECT 1 FROM contato_telefone t2 WHERE t2.tenant_id = tenant_atual() AND t2.contato_id = ${id} AND t2.principal)
               AND NOT EXISTS (SELECT 1 FROM contato_telefone t3 WHERE t3.tenant_id = tenant_atual() AND t3.chave_bloqueio = ${l.telefone.chaveBloqueio} AND t3.principal),
               ${l.whatsapp}, 'importacao'
          FROM contato_telefone WHERE tenant_id = tenant_atual() AND contato_id = ${id}
        ON CONFLICT DO NOTHING`
    }
  }

  if (ref.etiquetaIds.length > 0) {
    const tem = await tx<{ etiqueta_id: string }[]>`
      SELECT etiqueta_id FROM contato_etiqueta WHERE tenant_id = tenant_atual() AND contato_id = ${id}`
    const faltam = ref.etiquetaIds.filter((e) => !tem.some((t) => t.etiqueta_id === e))
    if (faltam.length > 0) {
      mudou = true
      if (executar) {
        for (const e of faltam) {
          await tx`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES (tenant_atual(), ${id}, ${e}) ON CONFLICT DO NOTHING`
        }
      }
    }
  }

  if (ref.vendedor) {
    const [dono] = await tx`SELECT 1 FROM carteira_atribuicao WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND ate IS NULL`
    if (!dono) {
      mudou = true
      if (executar) await atribuirCarteira(tx, id, ref.vendedor.id)
    }
  }

  return mudou ? { resultado: 'atualizado', motivo: ref.avisos[0] ?? null, referenciaId: id } : ignorado('ja_existe', id)
}

// ---------------------------------------------------------------------------
// Vendas históricas
// ---------------------------------------------------------------------------

/** Sistema da venda importada em `venda_identidade_externa` (guardiã da idempotência — sem partição, vale para sempre). */
export const SISTEMA_IMPORTACAO = 'importacao'

/** Descrição comparável: minúsculas, sem acento, espaços colapsados. */
const normalizarTexto = (t: string | null): string => (t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

class SondaRevertida extends Error {}

/** Existe partição de venda para o mês? Sonda por INSERT revertido (savepoint) — a única resposta exata. */
async function mesComParticao(tx: Sql, c: ContextoLinha, quando: Date): Promise<boolean> {
  const mes = quando.toISOString().slice(0, 7)
  const sabido = c.horizonte.get(mes)
  if (sabido !== undefined) return sabido
  let ok = true
  try {
    await emSavepoint(tx, async (sp) => {
      await sp`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos)
               VALUES (tenant_atual(), ${randomUUID()}, NULL, ${quando}, 1)`
      throw new SondaRevertida()
    })
  } catch (e) {
    if (!(e instanceof SondaRevertida)) {
      if ((e as { code?: string }).code === '23514') ok = false
      else throw e
    }
  }
  c.horizonte.set(mes, ok)
  return ok
}

async function venda(tx: Sql, l: VendaLida, _numeroLinha: number, c: ContextoLinha): Promise<Desfecho> {
  if (await bloqueadoLgpd(tx, l.contato.chaveBloqueio)) return ignorado('bloqueado_lgpd')
  const achado = await acharContato(tx, l.contato, true)
  if (!achado) return rejeitado('contato_nao_encontrado')
  if (achado.anonimizado) return ignorado('contato_anonimizado', achado.id)
  const contatoId = achado.id
  // Sem referência, a chave é o CONTEÚDO (contato + instante + valor + descrição): reenviar o arquivo corrigido não duplica.
  const idExterno = l.referencia
    ?? `imp:c:${createHash('sha256').update(`${contatoId}|${l.ocorridaEm.toISOString()}|${l.valorCentavos}|${normalizarTexto(l.descricao)}`).digest('hex').slice(0, 40)}`
  if (c.modo === 'simular') {
    if (c.vistos.has(`v:${idExterno}`)) return ignorado('duplicada_no_arquivo')
    c.vistos.add(`v:${idExterno}`)
  }
  const [existe] = await tx<{ venda_id: string }[]>`
    SELECT venda_id FROM venda_identidade_externa
     WHERE tenant_id = tenant_atual() AND sistema = ${SISTEMA_IMPORTACAO} AND id_externo = ${idExterno}`
  if (existe) return ignorado('ja_existe', existe.venda_id)
  if (c.modo === 'simular') {
    if (!(await mesComParticao(tx, c, l.ocorridaEm))) return rejeitado('data_fora_do_horizonte')
    return { resultado: 'criado', motivo: null, referenciaId: null }
  }

  const id = randomUUID()
  await tx`
    INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos, descricao)
    VALUES (tenant_atual(), ${id}, ${contatoId}, ${l.ocorridaEm}, ${l.valorCentavos}, ${l.descricao})`
  await tx`
    INSERT INTO venda_identidade_externa (tenant_id, sistema, id_externo, venda_id, venda_ocorrida_em)
    VALUES (tenant_atual(), ${SISTEMA_IMPORTACAO}, ${idExterno}, ${id}, ${l.ocorridaEm})`
  // Mesmos contadores da ingestão do ERP: o kanban ordena por eles; o RFV sai da MV (refresh agendado).
  await tx`
    UPDATE contato
       SET qtd_vendas            = qtd_vendas + 1,
           total_vendas_centavos = total_vendas_centavos + ${l.valorCentavos},
           primeira_venda_em     = least(coalesce(primeira_venda_em, ${l.ocorridaEm}), ${l.ocorridaEm}),
           ultima_venda_em       = greatest(coalesce(ultima_venda_em, ${l.ocorridaEm}), ${l.ocorridaEm})
     WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
  return { resultado: 'criado', motivo: null, referenciaId: id }
}

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------

async function tarefa(tx: Sql, l: TarefaLida, c: ContextoLinha): Promise<Desfecho> {
  let contatoId: string | null = null
  if (l.contato) {
    if (await bloqueadoLgpd(tx, l.contato.chaveBloqueio)) return ignorado('bloqueado_lgpd')
    const achado = await acharContato(tx, l.contato, true)
    if (!achado) return rejeitado('contato_nao_encontrado')
    if (achado.anonimizado) return ignorado('contato_anonimizado', achado.id)
    contatoId = achado.id
  }
  let aviso: string | null = null
  let responsavelId: string | null = null
  if (l.responsavelEmail) {
    const u = c.catalogos.usuarios.get(l.responsavelEmail)
    if (u) responsavelId = u.id
    else aviso = 'responsavel_inexistente'
  }
  const chave = `k:${contatoId ?? ''}|${l.titulo.toLowerCase()}|${l.venceEm.toISOString()}`
  if (c.modo === 'simular') {
    if (c.vistos.has(chave)) return ignorado('duplicada_no_arquivo')
    c.vistos.add(chave)
  }
  const [existe] = await tx<{ id: string }[]>`
    SELECT id FROM tarefa
     WHERE tenant_id = tenant_atual() AND contato_id IS NOT DISTINCT FROM ${contatoId}
       AND lower(titulo) = ${l.titulo.toLowerCase()} AND vence_em = ${l.venceEm} LIMIT 1`
  if (existe) return ignorado('ja_existe', existe.id)
  if (c.modo === 'simular') return { resultado: 'criado', motivo: aviso, referenciaId: null }

  const id = randomUUID()
  await tx`
    INSERT INTO tarefa (tenant_id, id, contato_id, responsavel_id, titulo, descricao, vence_em, tipo, criado_por)
    VALUES (tenant_atual(), ${id}, ${contatoId}, ${responsavelId}, ${l.titulo}, ${l.descricao}, ${l.venceEm}, ${l.tipo}, ${c.usuarioId})`
  return { resultado: 'criado', motivo: aviso, referenciaId: id }
}
