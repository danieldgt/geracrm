import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  ACOES_PLAYBOOK, BASE_B2B_DESCRITA, LIMITE_TEXTO_DOCUMENTO, LIMITES_PLAYBOOK, MENSAGENS_PLAYBOOK, PLACEHOLDERS_PLAYBOOK,
  ROTULO_ACAO, SEMPRE_LIGADAS_PLAYBOOK, corpoPublicarPlaybook, diffPorSecao, lerComplianceExtra,
  type ErroCampoPlaybook,
} from '@geracrm/shared'
import { exigirTenant } from '../../../plugins/tenant.js'
import { exigirPapel, temPapel } from '../../plataforma/papel.js'
import { auditar } from '../../plataforma/auditoria.js'
import { garantirUsuarioId } from '../rotas-fila.js'
import type { PortaLlmFerramentas } from './porta-llm.js'
import { criarLlmDoCatalogo, llmFerramentasDoAmbiente } from './fabrica-ferramentas.js'
import { resolverModelo } from './modelos.js'
import { extrairTexto, MAX_BYTES_ARQUIVO, TIPOS_ARQUIVO } from './conhecimento/extrair-texto.js'
import {
  ErroConteudoPlaybook, canalExiste, criarRascunho, descartarRascunho, importarPlaybookInicial, lerPublicada, lerRascunho, lerVersao,
  listarVersoes, publicarRascunho, restaurarVersao, salvarRascunho, vigenteDoCanal,
} from './playbook/repositorio.js'
import { sugerirDoDocumento } from './playbook/sugestao.js'

/**
 * PLAYBOOK COMERCIAL VERSIONADO — a superfície HTTP (raia P17; ADR-029, ADR-033).
 *
 *   GET    /v1/agente/playbook?canalId=                 estado do escopo (rascunho, publicada, vigente, diff, base)
 *   POST   /v1/agente/playbook/importar                 {canalId} v1 a partir de agente_config (idempotente)
 *   POST   /v1/agente/playbook/rascunho                 {canalId?} cria o rascunho copiando a publicada
 *   PUT    /v1/agente/playbook/rascunho                 {canalId?, conteudo} grava (validação completa)
 *   DELETE /v1/agente/playbook/rascunho?canalId=        descarta
 *   POST   /v1/agente/playbook/publicar                 {canalId?, observacao ≥ 10} → versão nova imutável + auditoria
 *   GET    /v1/agente/playbook/versoes?canalId=&cursor= histórico (cursor = número), sem conteúdo
 *   GET    /v1/agente/playbook/versoes/:id              versão completa + diff contra a publicada do escopo
 *   POST   /v1/agente/playbook/versoes/:id/restaurar    {observacao ≥ 10} → cópia publicada como versão nova
 *   POST   /v1/agente/playbook/a-partir-de-documento    {canalId?, nome, tipo, conteudoBase64} | {canalId?, nome?, texto}
 *                                                       → SÓ rascunho + resumoMudancas (o LLM nunca publica)
 *
 * `canalId` ausente/null = o playbook DA CONTA (vale para números sem o seu).
 * Escrita exige ADMIN (com `garantirUsuarioId` antes — §4 P14); leitura, só o
 * tenant. O sandbox é `POST /v1/canais/:id/agente/simular` com `{playbook}`.
 *
 * ⚠️ A tela NUNCA desliga guardrail: o conteúdo é validado por schema ESTRITO
 *    (chave fora do contrato = 422) e a base do código não é editável aqui.
 */

const UUID = /^[0-9a-f-]{36}$/i

/** Dependências trocáveis em teste (o LLM do "a partir de documento"). */
export const depsPlaybook: { llm: PortaLlmFerramentas | null } = { llm: null }

async function garantirUsuario(req: FastifyRequest): Promise<void> {
  if (req.tenantId) await req.comTenant((tx) => garantirUsuarioId(tx, req))
}
const soAdmin = { preHandler: [exigirTenant, garantirUsuario, exigirPapel('admin')] }

const canalOpcional = z.string().regex(UUID, 'canalId inválido').nullable().optional()

function campoInvalido(reply: FastifyReply, erros: readonly ErroCampoPlaybook[], erro = 'playbook.invalido'): FastifyReply {
  return reply.code(422).send({
    erro, mensagem: erros[0] ? `${erros[0].campo}: ${erros[0].mensagem}` : 'Conteúdo inválido.',
    campos: erros.map((e) => e.campo), erros,
  })
}

function zodInvalido(reply: FastifyReply, e: z.ZodError): FastifyReply {
  const i = e.issues[0]!
  return reply.code(422).send({ erro: 'playbook.campo_invalido', mensagem: `${i.path.join('.') || 'corpo'}: ${i.message}`, campos: [i.path.join('.')] })
}

/** O escopo pedido existe? (número do tenant, ou a conta) */
async function escopoValido(req: FastifyRequest, canalId: string | null | undefined): Promise<boolean> {
  if (!canalId) return true
  return req.comTenant((tx) => canalExiste(tx, canalId))
}

/** `?canalId=` → o número, null (conta, quando ausente/vazio) ou undefined (inválido: 404, nunca a conta). */
function escopoDaQuery(v: string | undefined): string | null | undefined {
  if (v === undefined || v === '') return null
  return UUID.test(v) ? v : undefined
}

export async function rotasPlaybook(app: FastifyInstance): Promise<void> {
  // Versão gravada fora do contrato: erro NOMEADO, nunca "o padrão" em silêncio.
  app.setErrorHandler((erro, _req, reply) => {
    if (erro instanceof ErroConteudoPlaybook) {
      return reply.code(500).send({ erro: 'playbook.conteudo_invalido', versaoId: erro.versaoId, mensagem: 'Uma versão do playbook está gravada fora do formato esperado. Acione o suporte; nada foi alterado.' })
    }
    throw erro   // o resto segue para o tratador global (app.ts)
  })
  app.get<{ Querystring: { canalId?: string } }>(
    '/v1/agente/playbook', { preHandler: [exigirTenant, garantirUsuario] },
    async (req, reply) => {
      const canalId = escopoDaQuery(req.query.canalId)
      if (canalId === undefined) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const dados = await req.comTenant(async (tx) => {
        if (canalId && !await canalExiste(tx, canalId)) return null
        const [rascunho, publicada, vigente, total, cfg] = [
          await lerRascunho(tx, canalId), await lerPublicada(tx, canalId),
          canalId ? await vigenteDoCanal(tx, canalId) : null,
          (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_playbook_versao
                                      WHERE tenant_id = tenant_atual() AND ${canalId ? tx`canal_id = ${canalId}` : tx`canal_id IS NULL`}`)[0]?.n ?? 0,
          canalId ? (await tx<{ compliance: unknown }[]>`SELECT (to_jsonb(ac.*) -> 'compliance') AS compliance FROM agente_config ac
                                                          WHERE ac.tenant_id = tenant_atual() AND ac.canal_id = ${canalId}`)[0] ?? null : null,
        ] as const
        return { rascunho, publicada, vigente, total, cfg }
      })
      if (!dados) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const referencia = dados.publicada?.conteudo ?? dados.vigente?.versao.conteudo ?? null
      return reply.send({
        escopo: canalId ? 'numero' : 'tenant',
        canalId,
        rascunho: dados.rascunho,
        publicada: dados.publicada,
        vigente: dados.vigente ? { escopo: dados.vigente.escopo, versaoId: dados.vigente.versao.id, numero: dados.vigente.versao.numero, publicadaEm: dados.vigente.versao.publicadaEm } : null,
        diff: dados.rascunho ? diffPorSecao(referencia, dados.rascunho.conteudo) : null,
        /** Sem nenhuma versão neste número E sem playbook da conta cobrindo: a tela oferece importar a v1. Coberto pela conta, "Editar" parte do da conta. */
        importavel: !!canalId && dados.total === 0 && dados.vigente?.escopo !== 'tenant',
        complianceDoNumero: canalId ? lerComplianceExtra(dados.cfg?.compliance) : null,
        base: {
          frasesBase: BASE_B2B_DESCRITA, sempreLigadas: SEMPRE_LIGADAS_PLAYBOOK,
          acoes: ACOES_PLAYBOOK.map((id) => ({ id, ...ROTULO_ACAO[id] })),
          mensagens: MENSAGENS_PLAYBOOK, placeholders: PLACEHOLDERS_PLAYBOOK, limites: LIMITES_PLAYBOOK,
        },
        podeEditar: await temPapel(req, 'admin'),
      })
    },
  )

  app.post<{ Body: unknown }>('/v1/agente/playbook/importar', soAdmin, async (req, reply) => {
    const p = z.object({ canalId: z.string().regex(UUID, 'canalId inválido') }).strict().safeParse(req.body ?? {})
    if (!p.success) return zodInvalido(reply, p.error)
    if (!await escopoValido(req, p.data.canalId)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    const r = await req.comTenant(async (tx) => importarPlaybookInicial(tx, {
      canalId: p.data.canalId, autorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
    }))
    if ('cobertoPelaConta' in r && r.cobertoPelaConta) {
      return reply.code(409).send({
        erro: 'playbook.coberto_pela_conta', vigente: r.cobertoPelaConta,
        mensagem: `Este número já segue o playbook da conta (v${r.cobertoPelaConta.numero}). Clique em Editar para criar um playbook próprio a partir dele.`,
      })
    }
    return reply.code(r.importada ? 201 : 200).send(r)
  })

  app.post<{ Body: unknown }>('/v1/agente/playbook/rascunho', soAdmin, async (req, reply) => {
    const p = z.object({ canalId: canalOpcional }).strict().safeParse(req.body ?? {})
    if (!p.success) return zodInvalido(reply, p.error)
    const canalId = p.data.canalId ?? null
    if (!await escopoValido(req, canalId)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    const r = await req.comTenant(async (tx) => criarRascunho(tx, { canalId, autorId: await garantirUsuarioId(tx, req) }))
    return reply.code(r.criado ? 201 : 200).send(r)
  })

  app.put<{ Body: unknown }>('/v1/agente/playbook/rascunho', soAdmin, async (req, reply) => {
    const p = z.object({ canalId: canalOpcional, conteudo: z.unknown() }).strict().safeParse(req.body ?? {})
    if (!p.success) return zodInvalido(reply, p.error)
    const canalId = p.data.canalId ?? null
    if (!await escopoValido(req, canalId)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    const r = await req.comTenant(async (tx) => salvarRascunho(tx, { canalId, conteudo: p.data.conteudo, autorId: await garantirUsuarioId(tx, req) }))
    if (r.tipo === 'invalido') return campoInvalido(reply, r.erros)
    return reply.send({ ok: true, versao: r.versao })
  })

  app.delete<{ Querystring: { canalId?: string } }>('/v1/agente/playbook/rascunho', soAdmin, async (req, reply) => {
    // ⚠️ canalId inválido ou de outro tenant NUNCA cai no escopo da conta: 404.
    const canalId = escopoDaQuery(req.query.canalId)
    if (canalId === undefined || !await escopoValido(req, canalId)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    const apagou = await req.comTenant((tx) => descartarRascunho(tx, canalId))
    if (!apagou) return reply.code(404).send({ erro: 'playbook.sem_rascunho', mensagem: 'Não há rascunho para descartar.' })
    return reply.send({ ok: true })
  })

  app.post<{ Body: unknown }>('/v1/agente/playbook/publicar', soAdmin, async (req, reply) => {
    const p = corpoPublicarPlaybook.safeParse(req.body ?? {})
    if (!p.success) {
      const i = p.error.issues[0]!
      const curta = i.path[0] === 'observacao'
      return reply.code(422).send({
        erro: curta ? 'playbook.observacao_invalida' : 'playbook.campo_invalido',
        mensagem: curta ? i.message : `${i.path.join('.') || 'corpo'}: ${i.message}`, campos: [i.path.join('.')],
      })
    }
    const canalId = p.data.canalId ?? null
    if (!await escopoValido(req, canalId)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
    const r = await req.comTenant(async (tx) => publicarRascunho(tx, {
      canalId, observacao: p.data.observacao, autorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
      rascunhoAtualizadoEm: p.data.rascunhoAtualizadoEm,
    }))
    if (r.tipo === 'rascunho_mudou') {
      return reply.code(409).send({
        erro: 'playbook.rascunho_mudou', atualizadoEm: r.atualizadoEm,
        mensagem: 'O rascunho foi alterado depois que você o revisou. Reveja as diferenças e publique de novo.',
      })
    }
    if (r.tipo === 'sem_rascunho') return reply.code(404).send({ erro: 'playbook.sem_rascunho', mensagem: 'Não há rascunho para publicar. Edite o playbook primeiro.' })
    if (r.tipo === 'invalido') return campoInvalido(reply, r.erros)
    return reply.send({ ok: true, versao: r.versao, numerosAlcancados: r.numerosAlcancados })
  })

  app.get<{ Querystring: { canalId?: string; cursor?: string } }>(
    '/v1/agente/playbook/versoes', { preHandler: exigirTenant },
    async (req, reply) => {
      const canalId = escopoDaQuery(req.query.canalId)
      if (canalId === undefined || !await escopoValido(req, canalId)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })
      const cursor = req.query.cursor ? Number(req.query.cursor) : null
      if (cursor !== null && (!Number.isInteger(cursor) || cursor < 1)) return reply.code(422).send({ erro: 'cursor.invalido' })
      return reply.send(await req.comTenant((tx) => listarVersoes(tx, canalId, cursor)))
    },
  )

  app.get<{ Params: { id: string } }>('/v1/agente/playbook/versoes/:id', { preHandler: exigirTenant }, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'playbook.versao_inexistente' })
    const r = await req.comTenant(async (tx) => {
      const v = await lerVersao(tx, req.params.id)
      return v ? { v, publicada: await lerPublicada(tx, v.canalId) } : null
    })
    if (!r) return reply.code(404).send({ erro: 'playbook.versao_inexistente' })
    return reply.send({
      versao: r.v,
      /** O que mudaria se esta versão fosse restaurada: publicada atual → esta. */
      diffContraPublicada: r.publicada && r.publicada.id !== r.v.id ? diffPorSecao(r.publicada.conteudo, r.v.conteudo) : null,
    })
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/v1/agente/playbook/versoes/:id/restaurar', soAdmin, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ erro: 'playbook.versao_inexistente' })
    const p = corpoPublicarPlaybook.pick({ observacao: true }).strict().safeParse(req.body ?? {})
    if (!p.success) return reply.code(422).send({ erro: 'playbook.observacao_invalida', mensagem: p.error.issues[0]!.message, campos: ['observacao'] })
    const r = await req.comTenant(async (tx) => restaurarVersao(tx, {
      versaoId: req.params.id, observacao: p.data.observacao, autorId: await garantirUsuarioId(tx, req), atorStaff: req.atorStaff ?? false,
    }))
    switch (r.tipo) {
      case 'versao_inexistente': return reply.code(404).send({ erro: 'playbook.versao_inexistente' })
      case 'versao_rascunho': return reply.code(422).send({ erro: 'playbook.restaurar_rascunho', mensagem: 'Só se restaura versão publicada ou arquivada.' })
      case 'rascunho_existente': return reply.code(409).send({ erro: 'playbook.rascunho_existente', mensagem: 'Há um rascunho em andamento neste playbook. Publique ou descarte antes de restaurar.' })
      case 'sem_rascunho': return reply.code(404).send({ erro: 'playbook.sem_rascunho' })
      case 'rascunho_mudou': return reply.code(409).send({ erro: 'playbook.rascunho_mudou' })
      case 'invalido': return campoInvalido(reply, r.erros, 'playbook.restaurar_invalido')
      case 'ok': return reply.send({ ok: true, versao: r.versao, numerosAlcancados: r.numerosAlcancados })
    }
  })

  /**
   * "Atualizar a partir de documento": texto (ou arquivo txt/md/pdf, extraído
   * como na importação do conhecimento) → LLM → RASCUNHO + resumo. Nunca
   * publica, nunca mexe em ações nem persona. Com rascunho em andamento, recusa
   * (409): a sugestão não pisa no trabalho de ninguém.
   */
  app.post<{ Body: unknown }>(
    '/v1/agente/playbook/a-partir-de-documento',
    { ...soAdmin, bodyLimit: 12 * 1024 * 1024 },
    async (req, reply) => {
      const p = z.object({
        canalId: canalOpcional,
        nome: z.string().trim().min(1).max(200).optional(),
        tipo: z.enum(TIPOS_ARQUIVO).optional(),
        conteudoBase64: z.string().min(1).max(Math.ceil(MAX_BYTES_ARQUIVO * 4 / 3) + 4).optional(),
        texto: z.string().trim().min(20, 'O documento precisa de ao menos 20 caracteres de texto.').optional(),
      }).strict().safeParse(req.body ?? {})
      if (!p.success) return zodInvalido(reply, p.error)
      const c = p.data
      const canalId = c.canalId ?? null
      if (!await escopoValido(req, canalId)) return reply.code(404).send({ erro: 'canal.nao_encontrado' })

      let texto = c.texto ?? ''
      if (c.conteudoBase64) {
        if (!c.tipo) return reply.code(422).send({ erro: 'playbook.campo_invalido', mensagem: 'Informe o tipo do arquivo (txt, md ou pdf).', campos: ['tipo'] })
        const bytes = new Uint8Array(Buffer.from(c.conteudoBase64.replace(/^data:[^,]*,/, ''), 'base64'))
        const ex = await extrairTexto(c.tipo, bytes)
        if (!ex.ok) return reply.code(422).send({ erro: `playbook.${ex.erro}`, mensagem: ex.mensagem, campos: ['conteudoBase64'] })
        texto = ex.texto
      }
      if (!texto.trim()) return reply.code(422).send({ erro: 'playbook.campo_invalido', mensagem: 'Envie o arquivo ou o texto do documento.', campos: ['texto'] })
      if (texto.length > LIMITE_TEXTO_DOCUMENTO) {
        return reply.code(422).send({
          erro: 'playbook.documento_grande',
          mensagem: `O documento tem ${texto.length.toLocaleString('pt-BR')} caracteres; o limite é ${LIMITE_TEXTO_DOCUMENTO.toLocaleString('pt-BR')}. Envie só a parte que muda a conduta.`,
          campos: ['texto'],
        })
      }

      // Contexto numa transação curta; o LLM roda FORA dela.
      const prep = await req.comTenant(async (tx) => {
        if (await lerRascunho(tx, canalId)) return { tipo: 'rascunho_existente' as const }
        const base = (await lerPublicada(tx, canalId)) ?? (canalId ? (await vigenteDoCanal(tx, canalId))?.versao ?? null : null)
        const [cfg] = canalId ? await tx<{ modelo: string | null }[]>`SELECT modelo FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}` : []
        return { tipo: 'ok' as const, base, modelo: await resolverModelo(tx, cfg?.modelo ?? null) }
      })
      if (prep.tipo === 'rascunho_existente') {
        return reply.code(409).send({ erro: 'playbook.rascunho_existente', mensagem: 'Há um rascunho em andamento. Publique ou descarte antes de gerar outro a partir de documento.' })
      }
      const atual = prep.base?.conteudo
      if (!atual) {
        return reply.code(422).send({ erro: 'playbook.sem_base', mensagem: 'Publique (ou importe) a primeira versão do playbook antes de atualizar a partir de documento.' })
      }
      const llm = depsPlaybook.llm ?? (prep.modelo ? criarLlmDoCatalogo(prep.modelo) : llmFerramentasDoAmbiente())
      const s = await sugerirDoDocumento({ tenantId: req.tenantId!, atual, texto, nomeArquivo: c.nome ?? null, llm })
      if (s.tipo === 'llm_indisponivel') return reply.code(502).send({ erro: 'playbook.llm_indisponivel', mensagem: 'Não foi possível gerar a sugestão agora. Tente de novo em instantes.', detalhe: s.detalhe })
      if (s.tipo === 'sugestao_invalida') return campoInvalido(reply, s.erros, 'playbook.sugestao_invalida')

      const r = await req.comTenant(async (tx) => {
        // Alguém abriu um rascunho enquanto o LLM pensava: não sobrescreve.
        if (await lerRascunho(tx, canalId)) return { tipo: 'rascunho_existente' as const }
        const eu = await garantirUsuarioId(tx, req)
        const salvo = await salvarRascunho(tx, {
          canalId, conteudo: s.conteudo, autorId: eu, origem: 'documento', resumoMudancas: s.resumoMudancas,
          documentoNome: c.nome ?? null, custoCentavos: s.custoCentavos,
        })
        if (salvo.tipo === 'ok') {
          await auditar(tx, {
            atorId: eu, atorStaff: req.atorStaff ?? false, acao: 'agente.playbook_sugerido', entidade: 'agente_playbook_versao',
            entidadeId: salvo.versao.id, dados: { canalId, documento: c.nome ?? null, resumoMudancas: s.resumoMudancas, custoCentavos: s.custoCentavos, modelo: s.modelo },
          })
        }
        return salvo
      })
      if (r.tipo === 'rascunho_existente') {
        return reply.code(409).send({ erro: 'playbook.rascunho_existente', mensagem: 'Um rascunho foi aberto enquanto a sugestão era gerada. Publique ou descarte e gere de novo.' })
      }
      if (r.tipo === 'invalido') return campoInvalido(reply, r.erros, 'playbook.sugestao_invalida')
      return reply.code(201).send({
        ok: true, versao: r.versao, resumoMudancas: s.resumoMudancas, custoCentavos: s.custoCentavos,
        diff: diffPorSecao(atual, r.versao.conteudo),
      })
    },
  )
}
