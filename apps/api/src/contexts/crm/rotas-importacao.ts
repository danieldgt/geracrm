import { randomUUID } from 'node:crypto'
import multipart from '@fastify/multipart'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  CAMPOS_IMPORTACAO, CONTAGENS_ZERADAS, IMPORTACAO_LOTE, IMPORTACAO_MAX_BYTES, IMPORTACAO_MAX_LINHAS, RESULTADOS_ITEM,
  camposObrigatoriosFaltando, ehTipoImportacao, limparDePara, parseCsv, progressoImportacao, sugerirDePara,
  type ContagensImportacao, type DePara, type EstadoImportacao, type ResultadoItem, type TipoImportacao,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { auditar } from '../plataforma/auditoria.js'
import { exigirPapel } from '../plataforma/papel.js'
import { gravarItens, sha256, simularPedaco, somar, type ItemParaGravar } from './importacao-execucao.js'
import type { OpcoesImportacao } from './importacao-dominio.js'

/**
 * IMPORTADOR POR PLANILHA (raia H1, #99) — `/v1/importacoes`. Gestor, supervisor e admin.
 *
 *   modelo.csv → simular (multipart; NÃO grava contato/venda/tarefa) → executar (o MESMO arquivo, reenviado) →
 *   progresso → itens / relatório / conferência.
 *
 * ⚠️ SIMULAÇÃO OBRIGATÓRIA, POR HASH: `executar` recebe o arquivo de novo e só roda se o sha256 for o da
 *    simulação (`409 importacao.nao_simulada` caso contrário). Arquivo editado depois de simulado não executa
 *    sem nova simulação — o que o gestor viu é o que acontece.
 * ⚠️ Tenant do TOKEN (`req.comTenant`); nenhuma rota aceita tenant em corpo, query ou caminho.
 * ⚠️ `motivo` dos itens é código, nunca dado do arquivo; nada de célula em log.
 * ⚠️ Listas por cursor; o relatório e a conferência são agregados/limitados (≤ 50 mil linhas por importação).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURSOR_EM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const PAGINA = 20
const PAGINA_ITENS = 50
const AMOSTRA_REJEICOES = 20
const BOM = '﻿'
const GESTAO = [exigirTenant, exigirPapel('gestor', 'supervisor')]

const erro422 = (reply: FastifyReply, erro: string, mensagem: string, extra: Record<string, unknown> = {}) =>
  reply.code(422).send({ erro, mensagem, ...extra })

interface LinhaImportacao {
  id: string; tipo: TipoImportacao; arquivo_nome: string; arquivo_hash: string; estado: EstadoImportacao
  de_para: DePara; opcoes: OpcoesImportacao; contagens: ContagensImportacao; erro: string | null
  criado_por: string | null; criado_por_nome: string | null; criado_em: Date; atualizado_em: Date; concluido_em: Date | null
  em_txt?: string
}

const paraApi = (l: LinhaImportacao) => ({
  id: l.id, tipo: l.tipo, arquivoNome: l.arquivo_nome, arquivoHash: l.arquivo_hash, estado: l.estado,
  dePara: l.de_para, opcoes: l.opcoes, contagens: l.contagens, progresso: progressoImportacao(l.contagens, l.estado),
  erro: l.erro, criadoPor: l.criado_por_nome, criadoEm: l.criado_em, atualizadoEm: l.atualizado_em, concluidoEm: l.concluido_em,
})

function lerOpcoes(bruto: unknown): OpcoesImportacao {
  const o = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>
  return { criarOrigens: o.criarOrigens === true, criarEtiquetas: o.criarEtiquetas === true }
}

function jsonDoCampo(valor: unknown): unknown {
  if (typeof valor !== 'string' || valor.trim() === '') return undefined
  try { return JSON.parse(valor) as unknown } catch { return 'invalido' }
}

/** Arquivo + campos do multipart, em qualquer ordem. */
async function lerMultipart(req: FastifyRequest): Promise<
  { ok: true; bytes: Buffer; nome: string; campos: Record<string, string> } | { ok: false; status: number; erro: string; mensagem: string }
> {
  if (!req.isMultipart()) return { ok: false, status: 415, erro: 'importacao.multipart', mensagem: 'Envie o arquivo como multipart/form-data.' }
  let bytes: Buffer | null = null
  let nome = ''
  const campos: Record<string, string> = {}
  try {
    for await (const parte of req.parts()) {
      if (parte.type === 'file') {
        bytes = await parte.toBuffer() // lança FST_REQ_FILE_TOO_LARGE acima do limite
        if (parte.file.truncated) throw Object.assign(new Error('grande'), { code: 'FST_REQ_FILE_TOO_LARGE' })
        nome = (parte.filename ?? '').replace(/[\\/]/g, '_').slice(0, 255)
      } else if (typeof parte.value === 'string') campos[parte.fieldname] = parte.value
    }
  } catch (e) {
    if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      return { ok: false, status: 413, erro: 'importacao.arquivo_grande', mensagem: 'O arquivo passa de 20 MB.' }
    }
    throw e
  }
  if (!bytes || bytes.length === 0) return { ok: false, status: 422, erro: 'importacao.sem_arquivo', mensagem: 'Envie o arquivo CSV.' }
  return { ok: true, bytes, nome: nome || 'importacao.csv', campos }
}

/**
 * UTF-8 (com ou sem BOM); se vier lixo (U+FFFD), a planilha foi salva em Windows-1252 e é lida como tal (o decoder
 * certo, não latin1: 0x80-0x9F são aspas e travessão). UTF-16 (BOM FF FE / FE FF) e NUL não são CSV de texto: `null`.
 */
function decodificar(bytes: Buffer): string | null {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return null
  if (bytes.includes(0)) return null
  const t = bytes.toString('utf8')
  return t.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(bytes) : t
}

const ENCODING_INVALIDO = { erro: 'importacao.encoding', mensagem: 'O arquivo não está em UTF-8 nem em Windows-1252. No Excel, salve como CSV UTF-8.' }
/** Teto de tempo da simulação síncrona: acima disso o arquivo é pesado demais para esta tela. */
const SIMULACAO_MAX_MS = 90_000

const csvCelula = (v: string | number | null): string => {
  const s = v === null ? '' : String(v)
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function lerCursorEm(bruto: string | undefined): { em: string; id: string } | null | 'invalido' {
  if (!bruto) return null
  const [em, id, resto] = Buffer.from(bruto, 'base64url').toString('utf8').split('§')
  if (resto !== undefined || !em || !id || !CURSOR_EM.test(em) || !UUID.test(id)) return 'invalido'
  return { em, id }
}

async function carregar(tx: Sql, id: string): Promise<LinhaImportacao | undefined> {
  const [l] = await tx<LinhaImportacao[]>`
    SELECT i.id, i.tipo, i.arquivo_nome, i.arquivo_hash, i.estado, i.de_para, i.opcoes, i.contagens, i.erro, i.criado_por,
           u.nome AS criado_por_nome, i.criado_em, i.atualizado_em, i.concluido_em
      FROM importacao i LEFT JOIN usuario u ON u.tenant_id = i.tenant_id AND u.id = i.criado_por
     WHERE i.tenant_id = tenant_atual() AND i.id = ${id}`
  return l
}

export async function rotasImportacao(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: IMPORTACAO_MAX_BYTES, files: 1, fields: 6, fieldSize: 200_000 } })

  /** Modelo para baixar: cabeçalho e 2 linhas de exemplo (`;` e BOM — abre direto no Excel brasileiro). */
  app.get<{ Params: { tipo: string } }>('/v1/importacoes/:tipo/modelo.csv', { preHandler: GESTAO }, async (req, reply) => {
    if (!ehTipoImportacao(req.params.tipo)) return reply.code(404).send({ erro: 'importacao.tipo_invalido', mensagem: 'Tipo de importação desconhecido.' })
    const campos = CAMPOS_IMPORTACAO[req.params.tipo]
    const linhas = [
      campos.map((c) => csvCelula(c.rotulo)).join(';'),
      campos.map((c) => csvCelula(c.exemplo)).join(';'),
      campos.map((c) => csvCelula(c.exemplo)).join(';'),
    ]
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="modelo-${req.params.tipo}.csv"`)
      .send(BOM + linhas.join('\r\n') + '\r\n')
  })

  app.post<{ Params: { tipo: string } }>('/v1/importacoes/:tipo/simular', { preHandler: GESTAO }, async (req, reply) => {
    if (!ehTipoImportacao(req.params.tipo)) return reply.code(404).send({ erro: 'importacao.tipo_invalido', mensagem: 'Tipo de importação desconhecido.' })
    const tipo: TipoImportacao = req.params.tipo
    const arq = await lerMultipart(req)
    if (!arq.ok) return reply.code(arq.status).send({ erro: arq.erro, mensagem: arq.mensagem })

    const texto = decodificar(arq.bytes)
    if (texto === null) return reply.code(422).send(ENCODING_INVALIDO)
    const csv = parseCsv(texto)
    if (csv.colunas.length === 0 || csv.linhas.length === 0) return erro422(reply, 'importacao.sem_dados', 'O arquivo não tem linhas de dados.')
    if (csv.linhas.length > IMPORTACAO_MAX_LINHAS) {
      return erro422(reply, 'importacao.linhas_demais', `Máximo ${IMPORTACAO_MAX_LINHAS} linhas por importação.`)
    }

    const sugerido = sugerirDePara(tipo, csv.colunas)
    const enviado = jsonDoCampo(arq.campos.dePara)
    if (enviado === 'invalido' || (enviado !== undefined && (typeof enviado !== 'object' || enviado === null || Array.isArray(enviado)))) {
      return erro422(reply, 'importacao.de_para_invalido', 'O de-para não é um objeto JSON.')
    }
    // Enviado vence por inteiro (quem desmapeou um campo opcional não o ganha de volta); sem envio, vale o sugerido.
    const dePara = enviado === undefined ? sugerido : limparDePara(tipo, enviado as Record<string, unknown>, csv.colunas)
    const faltando = camposObrigatoriosFaltando(tipo, dePara)
    if (faltando.length > 0) {
      return erro422(reply, 'importacao.colunas_obrigatorias', 'Faltam colunas obrigatórias: associe-as no de-para.', {
        faltando, colunas: csv.colunas, deParaSugerido: sugerido,
      })
    }
    const opcoesBruto = jsonDoCampo(arq.campos.opcoes)
    const opcoes = lerOpcoes(opcoesBruto === 'invalido' ? undefined : opcoesBruto)

    const hash = sha256(arq.bytes)
    const importacaoId = randomUUID()
    const usuarioId = await req.comTenant((tx) => garantirUsuarioId(tx, req))
    const agora = new Date()
    const base = { tipo, importacaoId, arquivoHash: hash, usuarioId, opcoes, dePara, csv, agora }

    await req.comTenant((tx) => tx`
      INSERT INTO importacao (tenant_id, id, tipo, arquivo_nome, arquivo_hash, estado, de_para, opcoes, contagens, criado_por)
      VALUES (tenant_atual(), ${importacaoId}, ${tipo}, ${arq.nome}, ${hash}, 'simulada', ${JSON.stringify(dePara)}::text::jsonb,
              ${JSON.stringify(opcoes)}::text::jsonb, ${JSON.stringify({ ...CONTAGENS_ZERADAS, linhas: csv.linhas.length })}::text::jsonb,
              ${usuarioId})`)

    // Um pedaço por transação (curta); a simulação só lê o domínio e grava itens.
    let contagens: ContagensImportacao = { ...CONTAGENS_ZERADAS, linhas: csv.linhas.length }
    const vistos = new Set<string>()
    const horizonte = new Map<string, boolean>()
    const prazo = Date.now() + SIMULACAO_MAX_MS
    const amostra: { linha: number; motivo: string }[] = []
    for (let i = 0; i < csv.linhas.length; i += IMPORTACAO_LOTE) {
      if (Date.now() > prazo) {
        // Não deixa simulação pela metade: apaga (os itens vão junto) e pede para dividir o arquivo.
        await req.comTenant((tx) => tx`DELETE FROM importacao WHERE tenant_id = tenant_atual() AND id = ${importacaoId}`)
        return erro422(reply, 'importacao.simulacao_demorada', 'O arquivo é pesado demais para simular de uma vez. Divida-o em partes menores.')
      }
      const pedaco = csv.linhas.slice(i, i + IMPORTACAO_LOTE)
      const itens: ItemParaGravar[] = await req.comTenant(async (tx) => {
        const r = await simularPedaco(tx, base, pedaco, vistos, horizonte)
        await gravarItens(tx, importacaoId, r)
        return r
      })
      for (const it of itens) {
        contagens = somar(contagens, it.resultado)
        if (it.resultado === 'rejeitado' && amostra.length < AMOSTRA_REJEICOES) amostra.push({ linha: it.linha, motivo: it.motivo ?? 'rejeitada' })
      }
    }
    await req.comTenant((tx) => tx`
      UPDATE importacao SET contagens = ${JSON.stringify(contagens)}::text::jsonb, atualizado_em = now(), simulada_em = now()
       WHERE tenant_id = tenant_atual() AND id = ${importacaoId}`)

    return reply.code(201).send({
      importacaoId, arquivoHash: hash, delimitador: csv.delimitador, colunas: csv.colunas,
      deParaSugerido: sugerido, dePara, opcoes, contagens, amostraRejeicoes: amostra,
    })
  })

  app.post<{ Params: { id: string } }>('/v1/importacoes/:id/executar', { preHandler: GESTAO }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
    const arq = await lerMultipart(req)
    if (!arq.ok) return reply.code(arq.status).send({ erro: arq.erro, mensagem: arq.mensagem })
    const hash = sha256(arq.bytes)
    const confirmado = jsonDoCampo(arq.campos.deParaConfirmado)
    const texto = decodificar(arq.bytes)
    if (texto === null) return reply.code(422).send(ENCODING_INVALIDO)

    const r = await req.comTenant(async (tx) => {
      const [imp] = await tx<{ tipo: TipoImportacao; arquivo_hash: string; estado: EstadoImportacao; de_para: DePara; opcoes: OpcoesImportacao; linhas: number; simulada_em: Date | null }[]>`
        SELECT tipo, arquivo_hash, estado, de_para, opcoes, (contagens->>'linhas')::int AS linhas, simulada_em
          FROM importacao WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
      if (!imp) return { erro: 'nao_encontrada' as const }
      // ⚠️ O gate: o arquivo reenviado tem de ser o simulado.
      if (imp.arquivo_hash !== hash) return { erro: 'nao_simulada' as const }
      if (imp.estado !== 'simulada') return { erro: 'estado_invalido' as const, estado: imp.estado }
      if (!imp.simulada_em) return { erro: 'simulacao_incompleta' as const }
      if (confirmado !== undefined) {
        const limpo = confirmado === 'invalido' || typeof confirmado !== 'object' || confirmado === null
          ? null : (confirmado as Record<string, unknown>)
        const mesmo = limpo !== null && JSON.stringify(sortear(limpo)) === JSON.stringify(sortear(imp.de_para))
        if (!mesmo) return { erro: 'de_para_mudou' as const }
      }
      // ⚠️ As opções são as da SIMULAÇÃO — o que a pessoa viu é o que roda; opção enviada agora é ignorada.
      const opcoes = imp.opcoes
      const eu = await garantirUsuarioId(tx, req)
      // Os itens da simulação cedem lugar aos da execução (a retomada do worker lê a maior linha com desfecho).
      await tx`DELETE FROM importacao_item WHERE tenant_id = tenant_atual() AND importacao_id = ${req.params.id}`
      await tx`
        UPDATE importacao
           SET estado = 'executando', conteudo = ${texto}, opcoes = ${JSON.stringify(opcoes)}::text::jsonb,
               contagens = ${JSON.stringify({ ...CONTAGENS_ZERADAS, linhas: imp.linhas })}::text::jsonb,
               arrendado_ate = NULL, tentativas = 0, erro = NULL, atualizado_em = now()
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
      await auditar(tx, {
        atorId: eu, acao: 'importacao.executada', entidade: 'importacao', entidadeId: req.params.id,
        dados: { tipo: imp.tipo, linhas: imp.linhas },
      })
      return { ok: true as const }
    })
    if ('erro' in r) {
      if (r.erro === 'nao_encontrada') return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
      if (r.erro === 'nao_simulada') {
        return reply.code(409).send({ erro: 'importacao.nao_simulada', mensagem: 'Este arquivo não foi simulado. Simule o arquivo antes de executar.' })
      }
      if (r.erro === 'simulacao_incompleta') {
        return reply.code(409).send({ erro: 'importacao.simulacao_incompleta', mensagem: 'A simulação desta importação não terminou. Simule o arquivo de novo.' })
      }
      if (r.erro === 'de_para_mudou') {
        return reply.code(409).send({ erro: 'importacao.de_para_mudou', mensagem: 'O de-para mudou depois da simulação. Simule de novo.' })
      }
      return reply.code(409).send({ erro: 'importacao.estado_invalido', mensagem: 'Esta importação já foi executada ou cancelada.', estado: r.estado })
    }
    return reply.code(202).send({ id: req.params.id, estado: 'executando' })
  })

  app.post<{ Params: { id: string } }>('/v1/importacoes/:id/cancelar', { preHandler: GESTAO }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
    const r = await req.comTenant(async (tx) => {
      const [i] = await tx<{ estado: string }[]>`
        UPDATE importacao SET estado = 'cancelada', conteudo = NULL, arrendado_ate = NULL, concluido_em = now(), atualizado_em = now()
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND estado IN ('simulada', 'executando')
        RETURNING estado`
      if (i) {
        const eu = await garantirUsuarioId(tx, req)
        await auditar(tx, { atorId: eu, acao: 'importacao.cancelada', entidade: 'importacao', entidadeId: req.params.id })
        return 'ok' as const
      }
      const [existe] = await tx`SELECT 1 FROM importacao WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
      return existe ? ('estado' as const) : ('nao_encontrada' as const)
    })
    if (r === 'nao_encontrada') return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
    if (r === 'estado') return reply.code(409).send({ erro: 'importacao.estado_invalido', mensagem: 'Só dá para cancelar uma importação simulada ou em execução.' })
    return reply.send({ id: req.params.id, estado: 'cancelada' })
  })

  app.get<{ Querystring: { cursor?: string; tipo?: string } }>('/v1/importacoes', { preHandler: GESTAO }, async (req, reply) => {
    const c = lerCursorEm(req.query.cursor)
    if (c === 'invalido') return erro422(reply, 'cursor.invalido', 'Cursor inválido.')
    const tipo = req.query.tipo
    if (tipo !== undefined && !ehTipoImportacao(tipo)) return erro422(reply, 'importacao.tipo_invalido', 'Tipo de importação desconhecido.')
    const linhas = await req.comTenant((tx) => tx<LinhaImportacao[]>`
      SELECT i.id, i.tipo, i.arquivo_nome, i.arquivo_hash, i.estado, i.de_para, i.opcoes, i.contagens, i.erro, i.criado_por,
             u.nome AS criado_por_nome, i.criado_em, i.atualizado_em, i.concluido_em,
             to_char(i.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em_txt
        FROM importacao i LEFT JOIN usuario u ON u.tenant_id = i.tenant_id AND u.id = i.criado_por
       WHERE i.tenant_id = tenant_atual()
         ${tipo ? tx`AND i.tipo = ${tipo}` : tx``}
         ${c ? tx`AND (i.criado_em, i.id) < (${c.em}::text::timestamptz, ${c.id}::uuid)` : tx``}
       ORDER BY i.criado_em DESC, i.id DESC
       LIMIT ${PAGINA + 1}`)
    const temMais = linhas.length > PAGINA
    const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
    const ultimo = pagina[pagina.length - 1]
    return reply.send({
      itens: pagina.map(paraApi),
      proximoCursor: temMais && ultimo ? Buffer.from(`${ultimo.em_txt}§${ultimo.id}`).toString('base64url') : null,
    })
  })

  app.get<{ Params: { id: string } }>('/v1/importacoes/:id', { preHandler: GESTAO }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
    const l = await req.comTenant((tx) => carregar(tx, req.params.id))
    if (!l) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
    return reply.send(paraApi(l))
  })

  app.get<{ Params: { id: string }; Querystring: { resultado?: string; cursor?: string } }>(
    '/v1/importacoes/:id/itens', { preHandler: GESTAO },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
      const { resultado, cursor } = req.query
      if (resultado !== undefined && !(RESULTADOS_ITEM as readonly string[]).includes(resultado)) {
        return erro422(reply, 'importacao.resultado_invalido', 'Resultado inválido.')
      }
      let apos = 0
      if (cursor !== undefined) {
        apos = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (!Number.isInteger(apos) || apos < 0) return erro422(reply, 'cursor.invalido', 'Cursor inválido.')
      }
      const r = await req.comTenant(async (tx) => {
        const [existe] = await tx`SELECT 1 FROM importacao WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!existe) return null
        return tx<{ linha: number; resultado: ResultadoItem; motivo: string | null; referencia_id: string | null }[]>`
          SELECT linha, resultado, motivo, referencia_id FROM importacao_item
           WHERE tenant_id = tenant_atual() AND importacao_id = ${req.params.id} AND linha > ${apos}
             ${resultado ? tx`AND resultado = ${resultado}` : tx``}
           ORDER BY linha LIMIT ${PAGINA_ITENS + 1}`
      })
      if (!r) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
      const temMais = r.length > PAGINA_ITENS
      const pagina = temMais ? r.slice(0, PAGINA_ITENS) : r
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((i) => ({ linha: i.linha, resultado: i.resultado, motivo: i.motivo, referenciaId: i.referencia_id })),
        proximoCursor: temMais && ultimo ? Buffer.from(String(ultimo.linha)).toString('base64url') : null,
      })
    },
  )

  /** Relatório por linha: linha;resultado;motivo;referencia — sem nenhuma célula do arquivo. */
  app.get<{ Params: { id: string } }>('/v1/importacoes/:id/relatorio.csv', { preHandler: GESTAO }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
    const partes: string[] = [BOM + 'linha;resultado;motivo;referencia']
    const achou = await req.comTenant(async (tx) => {
      const [existe] = await tx`SELECT 1 FROM importacao WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
      if (!existe) return false
      let apos = 0
      for (;;) { // por cursor de linha, em páginas — nunca a tabela inteira numa leitura só
        const pag = await tx<{ linha: number; resultado: string; motivo: string | null; referencia_id: string | null }[]>`
          SELECT linha, resultado, motivo, referencia_id FROM importacao_item
           WHERE tenant_id = tenant_atual() AND importacao_id = ${req.params.id} AND linha > ${apos}
           ORDER BY linha LIMIT 5000`
        for (const i of pag) partes.push([i.linha, i.resultado, i.motivo, i.referencia_id].map((v) => csvCelula(v)).join(';'))
        if (pag.length < 5000) break
        apos = pag[pag.length - 1]!.linha
      }
      return true
    })
    if (!achou) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="relatorio-importacao-${req.params.id.slice(0, 8)}.csv"`)
      .send(partes.join('\r\n') + '\r\n')
  })

  /**
   * Conferência: o que ficou no BANCO para os contatos que o arquivo tocou, por filial × qualificação × origem —
   * para comparar com o sistema antigo. Agregada (poucas linhas), não é lista de registros.
   */
  app.get<{ Params: { id: string } }>('/v1/importacoes/:id/conferencia', { preHandler: GESTAO }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
    const r = await req.comTenant(async (tx) => {
      const [imp] = await tx<{ tipo: TipoImportacao; estado: EstadoImportacao }[]>`
        SELECT tipo, estado FROM importacao WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
      if (!imp) return { erro: 'nao_encontrada' as const }
      if (imp.tipo !== 'contatos') return { erro: 'so_contatos' as const }
      if (imp.estado !== 'concluida') return { erro: 'nao_concluida' as const }
      const linhas = await tx<{ filial: string | null; qualificacao: 'novo' | 'qualificado' | 'descartado'; origem: string | null; total: number }[]>`
        SELECT f.nome AS filial,
               CASE WHEN c.qualificado IS NULL THEN 'novo' WHEN c.qualificado THEN 'qualificado' ELSE 'descartado' END AS qualificacao,
               o.nome AS origem, count(DISTINCT c.id)::int AS total
          FROM importacao_item ii
          JOIN contato c ON c.tenant_id = ii.tenant_id AND c.id = ii.referencia_id
          LEFT JOIN filial f ON f.tenant_id = c.tenant_id AND f.id = c.filial_id
          LEFT JOIN origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
         WHERE ii.tenant_id = tenant_atual() AND ii.importacao_id = ${req.params.id} AND ii.resultado IN ('criado', 'atualizado')
         GROUP BY 1, 2, 3
         ORDER BY 1 NULLS LAST, 2, 3 NULLS LAST`
      return { estado: imp.estado, linhas }
    })
    if ('erro' in r) {
      if (r.erro === 'nao_encontrada') return reply.code(404).send({ erro: 'importacao.nao_encontrada', mensagem: 'Importação não encontrada.' })
      if (r.erro === 'nao_concluida') return reply.code(409).send({ erro: 'importacao.nao_concluida', mensagem: 'A conferência só vale depois que a importação termina.' })
      return erro422(reply, 'importacao.conferencia_so_contatos', 'A conferência por filial, qualificação e origem existe só para contatos.')
    }
    return reply.send({ estado: r.estado, linhas: r.linhas, total: r.linhas.reduce((s, l) => s + l.total, 0) })
  })
}

/** Ordena as chaves para comparar dois mapas sem depender da ordem de inserção. */
function sortear(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}
