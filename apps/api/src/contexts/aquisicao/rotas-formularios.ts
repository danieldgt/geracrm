import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  TIPOS_FORMULARIO, slugDeNome, validarEstruturaCampos, type CampoFormulario, type TipoCampo,
} from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { emSavepoint, type Sql } from '../../db/index.js'
import { exigirPapel } from '../plataforma/papel.js'
import { celulaCsv } from '../atendimento/agente/rotas-qualidade.js'
import {
  COLUNAS_FORMULARIO, UUID, camposDoFormulario, formularioParaApi, lerCursorTempo, montarCursorTempo,
  type LinhaFormulario,
} from './formulario-dados.js'

/**
 * Formulários públicos — a ADMINISTRAÇÃO (F3). Tudo aqui é autenticado e exige gestor+; a superfície
 * pública (sem token) vive em `rotas-formulario-publico.ts`, separada de propósito (como a LP).
 * Listas por cursor; o `tenant_id` sai sempre do token (RLS).
 */

const PAGINA = 30
const LOTE_CSV = 500
const CORES = ['acao', 'sucesso', 'atencao', 'erro', 'ia', 'neutro']
const GESTOR = [exigirTenant, exigirPapel('gestor')]
const ehViolacaoUnica = (e: unknown) => (e as { code?: string })?.code === '23505'

const invalido = (reply: FastifyReply, campos: Record<string, string>) =>
  reply.code(422).send({ erro: 'validacao', mensagem: 'Corrija os campos destacados.', campos })

interface DadosFormulario {
  nome: string; slug: string | null; titulo: string; descricao: string | null; tipo: string
  filialId: string | null; etapaDestinoId: string | null; responsavelPadraoId: string | null; origemId: string | null
  cor: string; textoBotao: string; mensagemSucesso: string; ativo: boolean
}

const texto = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null
const idOuNull = (v: unknown): string | null | 'invalido' =>
  v === null || v === undefined || v === '' ? null : typeof v === 'string' && UUID.test(v) ? v : 'invalido'

/** Valida o corpo. `parcial` (PATCH): só o que veio é validado e devolvido. */
function validarCorpo(
  b: Record<string, unknown>, parcial: boolean,
): { ok: true; dados: Partial<DadosFormulario> } | { ok: false; campos: Record<string, string> } {
  const campos: Record<string, string> = {}
  const d: Partial<DadosFormulario> = {}
  const tem = (k: string) => !parcial || b[k] !== undefined

  if (tem('nome')) { const v = texto(b['nome'], 120); if (v) d.nome = v; else campos['nome'] = 'Informe o nome (até 120 caracteres).' }
  if (tem('titulo')) {
    const v = texto(b['titulo'], 160) ?? (parcial ? null : texto(b['nome'], 120))
    if (v) d.titulo = v; else campos['titulo'] = 'Informe o título (até 160 caracteres).'
  }
  if (b['slug'] !== undefined && b['slug'] !== null && b['slug'] !== '') {
    const s = typeof b['slug'] === 'string' ? b['slug'] : ''
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length <= 80) d.slug = s
    else campos['slug'] = 'Use letras minúsculas, números e hífen (até 80).'
  }
  if (tem('descricao')) {
    if (b['descricao'] === null || b['descricao'] === undefined || b['descricao'] === '') d.descricao = null
    else { const v = texto(b['descricao'], 1000); if (v) d.descricao = v; else campos['descricao'] = 'Descrição de até 1000 caracteres.' }
  }
  if (tem('tipo')) {
    const t = b['tipo'] ?? 'cadastro'
    if ((TIPOS_FORMULARIO as readonly unknown[]).includes(t)) d.tipo = t as string
    else campos['tipo'] = 'Tipo inválido.'
  }
  for (const [k, chave] of [['filialId', 'filialId'], ['etapaDestinoId', 'etapaDestinoId'],
    ['responsavelPadraoId', 'responsavelPadraoId'], ['origemId', 'origemId']] as const) {
    if (!tem(k)) continue
    const v = idOuNull(b[k])
    if (v === 'invalido') campos[k] = 'Identificador inválido.'
    else d[chave] = v
  }
  if (tem('cor')) {
    const c = b['cor'] ?? 'acao'
    if (typeof c === 'string' && CORES.includes(c)) d.cor = c; else campos['cor'] = 'Cor fora da paleta.'
  }
  if (tem('textoBotao')) {
    const v = b['textoBotao'] === undefined && !parcial ? 'Enviar' : texto(b['textoBotao'], 40)
    if (v) d.textoBotao = v; else campos['textoBotao'] = 'Texto do botão de até 40 caracteres.'
  }
  if (tem('mensagemSucesso')) {
    const v = b['mensagemSucesso'] === undefined && !parcial ? 'Recebemos suas informações. Obrigado!' : texto(b['mensagemSucesso'], 500)
    if (v) d.mensagemSucesso = v; else campos['mensagemSucesso'] = 'Mensagem de até 500 caracteres.'
  }
  if (b['ativo'] !== undefined) {
    if (typeof b['ativo'] === 'boolean') d.ativo = b['ativo']; else campos['ativo'] = 'Valor inválido.'
  }
  return Object.keys(campos).length > 0 ? { ok: false, campos } : { ok: true, dados: d }
}

/** Filial, etapa, responsável e origem informados têm de existir NESTE tenant (RLS) — e etapa/origem ativas. */
async function referenciasValidas(tx: Sql, d: Partial<DadosFormulario>): Promise<Record<string, string>> {
  const erros: Record<string, string> = {}
  const existe = async (tabela: 'filial' | 'usuario' | 'origem', id: string): Promise<boolean> => {
    const [r] = await tx`SELECT 1 AS x FROM ${tx(tabela)} WHERE tenant_id = tenant_atual() AND id = ${id}`
    return !!r
  }
  if (d.filialId && !(await existe('filial', d.filialId))) erros['filialId'] = 'Filial inexistente.'
  if (d.etapaDestinoId) {
    // Lead novo entra numa etapa ABERTA e ativa — nunca direto em ganho/perdido.
    const [e] = await tx`SELECT 1 AS x FROM funil_etapa WHERE tenant_id = tenant_atual() AND id = ${d.etapaDestinoId}
                          AND tipo = 'aberto' AND ativo`
    if (!e) erros['etapaDestinoId'] = 'Etapa inexistente, inativa ou de encerramento.'
  }
  if (d.responsavelPadraoId && !(await existe('usuario', d.responsavelPadraoId))) erros['responsavelPadraoId'] = 'Usuário inexistente.'
  if (d.origemId && !(await existe('origem', d.origemId))) erros['origemId'] = 'Origem inexistente.'
  return erros
}

const novaChave = () => randomBytes(12).toString('hex')

export async function rotasFormularios(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { cursor?: string } }>('/v1/formularios', { preHandler: GESTOR }, async (req, reply) => {
    const cur = lerCursorTempo(req.query.cursor)
    if (cur === 'invalido') return reply.code(422).send({ erro: 'cursor.invalido' })
    const linhas = await req.comTenant((tx) => tx<(LinhaFormulario & { total: string; em_txt: string })[]>`
      SELECT ${tx(COLUNAS_FORMULARIO.map((c) => `f.${c}`))},
             (SELECT count(*) FROM formulario_resposta r
               WHERE r.tenant_id = f.tenant_id AND r.formulario_id = f.id)::text AS total,
             to_char(f.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em_txt
        FROM formulario f
       WHERE f.tenant_id = tenant_atual()
         AND ${cur === null ? tx`true` : tx`(f.criado_em, f.id) < (${cur.em}::timestamptz, ${cur.id}::uuid)`}
       ORDER BY f.criado_em DESC, f.id DESC LIMIT ${PAGINA + 1}`)
    const temMais = linhas.length > PAGINA
    const pagina = temMais ? linhas.slice(0, PAGINA) : linhas
    const ultimo = pagina[pagina.length - 1]
    return reply.send({
      itens: pagina.map((l) => formularioParaApi(l, Number(l.total))),
      proximoCursor: temMais && ultimo ? montarCursorTempo(ultimo.em_txt, ultimo.id) : null,
    })
  })

  app.get<{ Params: { id: string } }>('/v1/formularios/:id', { preHandler: GESTOR }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
    const r = await req.comTenant(async (tx) => {
      const [f] = await tx<LinhaFormulario[]>`
        SELECT ${tx(COLUNAS_FORMULARIO)} FROM formulario WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
      if (!f) return null
      return { f, campos: await camposDoFormulario(tx, f.id) }
    })
    if (!r) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
    return reply.send({ ...formularioParaApi(r.f), campos: r.campos })
  })

  app.post<{ Body: Record<string, unknown> }>('/v1/formularios', { preHandler: GESTOR }, async (req, reply) => {
    const v = validarCorpo(req.body ?? {}, false)
    if (!v.ok) return invalido(reply, v.campos)
    const d = v.dados as DadosFormulario
    const slugExplicito = d.slug !== undefined
    const base = d.slug ?? slugDeNome(d.nome)

    const r = await req.comTenant(async (tx) => {
      const refs = await referenciasValidas(tx, d)
      if (Object.keys(refs).length > 0) return { refs }
      for (let n = 0; n < 6; n++) {
        const slug = n === 0 ? base : `${base.slice(0, 74)}-${n + 1}`
        const id = randomUUID()
        try {
          await emSavepoint(tx, async (sp) => {
            await sp`
              INSERT INTO formulario (tenant_id, id, nome, slug, chave_publica, titulo, descricao, tipo, filial_id,
                                      etapa_destino_id, responsavel_padrao_id, origem_id, cor, texto_botao, mensagem_sucesso, ativo)
              VALUES (tenant_atual(), ${id}, ${d.nome}, ${slug}, ${novaChave()}, ${d.titulo}, ${d.descricao ?? null},
                      ${d.tipo ?? 'cadastro'}, ${d.filialId ?? null}, ${d.etapaDestinoId ?? null},
                      ${d.responsavelPadraoId ?? null}, ${d.origemId ?? null}, ${d.cor ?? 'acao'},
                      ${d.textoBotao ?? 'Enviar'}, ${d.mensagemSucesso ?? 'Recebemos suas informações. Obrigado!'},
                      ${d.ativo ?? true})`
          })
          const [f] = await tx<LinhaFormulario[]>`SELECT ${tx(COLUNAS_FORMULARIO)} FROM formulario WHERE tenant_id = tenant_atual() AND id = ${id}`
          return { f: f! }
        } catch (e) {
          if (!ehViolacaoUnica(e)) throw e
          if (slugExplicito) return { duplicado: true as const }
        }
      }
      return { duplicado: true as const }
    })
    if ('refs' in r && r.refs) return invalido(reply, r.refs)
    if ('duplicado' in r) return reply.code(409).send({ erro: 'formulario.slug_duplicado', mensagem: 'Já existe um formulário com este endereço.' })
    return reply.code(201).send({ ...formularioParaApi(r.f!), campos: [] })
  })

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/v1/formularios/:id', { preHandler: GESTOR }, async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
      const v = validarCorpo(req.body ?? {}, true)
      if (!v.ok) return invalido(reply, v.campos)
      const d = v.dados
      const tem = (k: keyof DadosFormulario) => d[k] !== undefined
      try {
        const r = await req.comTenant(async (tx) => {
          const refs = await referenciasValidas(tx, d)
          if (Object.keys(refs).length > 0) return { refs }
          const [atual] = await tx<LinhaFormulario[]>`
            SELECT ${tx(COLUNAS_FORMULARIO)} FROM formulario WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
          if (!atual) return null
          const f = {
            nome: d.nome ?? atual.nome, slug: d.slug ?? atual.slug, titulo: d.titulo ?? atual.titulo,
            descricao: tem('descricao') ? d.descricao ?? null : atual.descricao, tipo: d.tipo ?? atual.tipo,
            filial: tem('filialId') ? d.filialId ?? null : atual.filial_id,
            etapa: tem('etapaDestinoId') ? d.etapaDestinoId ?? null : atual.etapa_destino_id,
            resp: tem('responsavelPadraoId') ? d.responsavelPadraoId ?? null : atual.responsavel_padrao_id,
            origem: tem('origemId') ? d.origemId ?? null : atual.origem_id,
            cor: d.cor ?? atual.cor, botao: d.textoBotao ?? atual.texto_botao,
            sucesso: d.mensagemSucesso ?? atual.mensagem_sucesso, ativo: d.ativo ?? atual.ativo,
          }
          const [novo] = await tx<LinhaFormulario[]>`
            UPDATE formulario SET nome = ${f.nome}, slug = ${f.slug}, titulo = ${f.titulo}, descricao = ${f.descricao},
                   tipo = ${f.tipo}, filial_id = ${f.filial}, etapa_destino_id = ${f.etapa},
                   responsavel_padrao_id = ${f.resp}, origem_id = ${f.origem}, cor = ${f.cor}, texto_botao = ${f.botao},
                   mensagem_sucesso = ${f.sucesso}, ativo = ${f.ativo}, atualizado_em = now()
             WHERE tenant_id = tenant_atual() AND id = ${req.params.id}
            RETURNING ${tx(COLUNAS_FORMULARIO)}`
          return { f: novo! }
        })
        if (r === null) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
        if ('refs' in r && r.refs) return invalido(reply, r.refs)
        return reply.send(formularioParaApi(r.f!))
      } catch (e) {
        if (ehViolacaoUnica(e)) return reply.code(409).send({ erro: 'formulario.slug_duplicado', mensagem: 'Já existe um formulário com este endereço.' })
        throw e
      }
    })

  app.delete<{ Params: { id: string } }>('/v1/formularios/:id', { preHandler: GESTOR }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
    const apagados = await req.comTenant((tx) => tx`
      DELETE FROM formulario WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
    if (apagados.length === 0) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
    return reply.code(204).send()
  })

  /** Substitui a lista inteira de campos. A validação é a mesma regra pura que a tela usa. */
  app.put<{ Params: { id: string }; Body: { campos?: unknown } }>(
    '/v1/formularios/:id/campos', { preHandler: GESTOR }, async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
      const bruto = req.body?.campos
      if (!Array.isArray(bruto)) return invalido(reply, { campos: 'Envie a lista de campos.' })
      if (bruto.length > 200) return invalido(reply, { campos: 'Campos demais.' })

      const campos: CampoFormulario[] = bruto.map((c: Record<string, unknown>) => ({
        id: String(c?.['id'] ?? ''), tipo: String(c?.['tipo'] ?? '') as TipoCampo, rotulo: String(c?.['rotulo'] ?? ''),
        placeholder: typeof c?.['placeholder'] === 'string' && c['placeholder'].trim() ? c['placeholder'].trim().slice(0, 160) : null,
        obrigatorio: c?.['obrigatorio'] === true,
        opcoes: Array.isArray(c?.['opcoes']) ? (c['opcoes'] as unknown[]).map((o) => String(o).trim()) : [],
        condicoes: c?.['condicoes'] && typeof c['condicoes'] === 'object' && !Array.isArray(c['condicoes'])
          ? Object.fromEntries(Object.entries(c['condicoes'] as Record<string, unknown>)
            .map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []])) : {},
        referencia: c?.['referencia'] === true,
      }))
      const erros = validarEstruturaCampos(campos)
      if (Object.keys(erros).length > 0) return invalido(reply, erros)
      // ⚠️ O telefone de identificação é sempre obrigatório: sem ele não há como criar nem mesclar o contato.
      const idTel = campos.find((c) => c.tipo === 'telefone')!.id
      for (const c of campos) if (c.id === idTel) c.obrigatorio = true

      const r = await req.comTenant(async (tx) => {
        const [f] = await tx`SELECT 1 AS x FROM formulario WHERE tenant_id = tenant_atual() AND id = ${req.params.id} FOR UPDATE`
        if (!f) return null
        await tx`DELETE FROM formulario_campo WHERE tenant_id = tenant_atual() AND formulario_id = ${req.params.id}`
        for (const [i, c] of campos.entries()) {
          await tx`
            INSERT INTO formulario_campo (tenant_id, formulario_id, id, ordem, tipo, rotulo, placeholder, obrigatorio,
                                          opcoes, condicoes, referencia)
            VALUES (tenant_atual(), ${req.params.id}, ${c.id}, ${i}, ${c.tipo}, ${c.rotulo.trim()}, ${c.placeholder ?? null},
                    ${c.obrigatorio}, ${tx.json(c.opcoes.map((o) => o.trim()))}, ${tx.json(c.condicoes)}, ${c.referencia})`
        }
        await tx`UPDATE formulario SET atualizado_em = now() WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return camposDoFormulario(tx, req.params.id)
      })
      if (r === null) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
      return reply.send({ campos: r })
    })

  /**
   * Regera o token de integração. ⚠️ O valor em claro só existe nesta resposta: no banco fica o hash.
   * Quem perdeu o token gera outro — o anterior deixa de valer.
   */
  app.post<{ Params: { id: string } }>('/v1/formularios/:id/token', { preHandler: GESTOR }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
    const token = `fmt_${randomBytes(24).toString('hex')}`
    const hash = createHash('sha256').update(token).digest('hex')
    const r = await req.comTenant((tx) => tx`
      UPDATE formulario SET token_hash = ${hash}, atualizado_em = now()
       WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
    if (r.length === 0) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
    return reply.header('cache-control', 'no-store').send({ token })
  })

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/formularios/:id/respostas', { preHandler: GESTOR }, async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
      const cur = lerCursorTempo(req.query.cursor)
      if (cur === 'invalido') return reply.code(422).send({ erro: 'cursor.invalido' })
      const r = await req.comTenant(async (tx) => {
        const [f] = await tx`SELECT 1 AS x FROM formulario WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!f) return null
        return tx<{ id: string; contato_id: string | null; contato_nome: string | null; contato_novo: boolean
          respostas: Record<string, unknown>; criado_em: Date; em_txt: string }[]>`
          SELECT r.id, r.contato_id, c.nome AS contato_nome, r.contato_novo, r.respostas, r.criado_em,
                 to_char(r.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em_txt
            FROM formulario_resposta r
            LEFT JOIN contato c ON c.tenant_id = r.tenant_id AND c.id = r.contato_id
           WHERE r.tenant_id = tenant_atual() AND r.formulario_id = ${req.params.id}
             AND ${cur === null ? tx`true` : tx`(r.criado_em, r.id) < (${cur.em}::timestamptz, ${cur.id}::uuid)`}
           ORDER BY r.criado_em DESC, r.id DESC LIMIT ${PAGINA + 1}`
      })
      if (r === null) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
      const temMais = r.length > PAGINA
      const pagina = temMais ? r.slice(0, PAGINA) : r
      const ultimo = pagina[pagina.length - 1]
      return reply.send({
        itens: pagina.map((l) => ({
          id: l.id, contatoId: l.contato_id, contatoNome: l.contato_nome, contatoNovo: l.contato_novo,
          respostas: l.respostas, criadoEm: l.criado_em,
        })),
        proximoCursor: temMais && ultimo ? montarCursorTempo(ultimo.em_txt, ultimo.id) : null,
      })
    })

  /**
   * CSV em STREAMING: lotes de 500 por cursor (cada um na sua transação curta), nunca a tabela inteira
   * na memória. Colunas = campos atuais do formulário (resposta de campo removido não vira coluna).
   */
  app.get<{ Params: { id: string } }>(
    '/v1/formularios/:id/respostas.csv', { preHandler: GESTOR }, async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })
      const id = req.params.id
      const base = await req.comTenant(async (tx) => {
        const [f] = await tx<{ slug: string }[]>`SELECT slug FROM formulario WHERE tenant_id = tenant_atual() AND id = ${id}`
        return f ? { slug: f.slug, campos: await camposDoFormulario(tx, id) } : null
      })
      if (!base) return reply.code(404).send({ erro: 'formulario.nao_encontrado' })

      const fmt = (c: CampoFormulario, v: unknown): string => {
        if (v === undefined || v === null) return ''
        if (c.tipo === 'multipla' && Array.isArray(v)) return v.join(' | ')
        if (c.tipo === 'moeda' && typeof v === 'number') return (v / 100).toFixed(2).replace('.', ',')
        if (c.tipo === 'anexo' && typeof v === 'object') return String((v as { nome?: unknown }).nome ?? '')
        return String(v)
      }
      async function* linhas() {
        yield `﻿${['Data', 'Contato', 'Contato novo', ...base!.campos.map((c) => c.rotulo)].map(celulaCsv).join(';')}\r\n`
        let cur: { em: string; id: string } | null = null
        for (;;) {
          const lote: { id: string; contato_nome: string | null; contato_novo: boolean; respostas: Record<string, unknown>
            em_txt: string }[] = await req.comTenant((tx) => tx`
            SELECT r.id, c.nome AS contato_nome, r.contato_novo, r.respostas,
                   to_char(r.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em_txt
              FROM formulario_resposta r
              LEFT JOIN contato c ON c.tenant_id = r.tenant_id AND c.id = r.contato_id
             WHERE r.tenant_id = tenant_atual() AND r.formulario_id = ${id}
               AND ${cur === null ? tx`true` : tx`(r.criado_em, r.id) < (${cur.em}::timestamptz, ${cur.id}::uuid)`}
             ORDER BY r.criado_em DESC, r.id DESC LIMIT ${LOTE_CSV}`)
          if (lote.length === 0) return
          yield lote.map((l) => [l.em_txt, l.contato_nome ?? '', l.contato_novo ? 'sim' : 'não',
            ...base!.campos.map((c) => fmt(c, l.respostas[c.id]))].map(celulaCsv).join(';')).join('\r\n') + '\r\n'
          const ultimo = lote[lote.length - 1]!
          cur = { em: ultimo.em_txt, id: ultimo.id }
          if (lote.length < LOTE_CSV) return
        }
      }
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="formulario-${base.slug}-respostas.csv"`)
        .header('cache-control', 'no-store')
        .send(Readable.from(linhas()))
    })
}
