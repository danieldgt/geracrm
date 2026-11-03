import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { camposVisiveis, normalizarTelefone, validarRespostas, type CampoFormulario } from '@geracrm/shared'
import { sql, comTenantServico, type Sql } from '../../db/index.js'
import { arquivosBucket } from '../crm/arquivos-bucket.js'
import { chaveDoArquivo, nomeSeguro, tipoPermitido } from '../crm/arquivos-regras.js'
import { gravarDocumento } from '../crm/contato-gravacao.js'
import { CAMPO_ARMADILHA } from './pagina-lp.js'
import { criarLimiteTaxa } from './limite-taxa.js'
import { ipDoCliente } from './rotas-lp-publica.js'
import {
  TEXTO_CONSENTIMENTO_PADRAO, camposDoFormulario, type LinhaFormulario,
} from './formulario-dados.js'

/**
 * A SUPERFÍCIE PÚBLICA do formulário (F3).
 *
 * ⚠️ **Sem autenticação, e é o ponto.** O tenant é RESOLVIDO pela chave da URL (`formulario_por_chave()`,
 * SECURITY DEFINER, migration 0127), nunca recebido. A partir daí tudo roda em `comTenantServico`,
 * sob a mesma RLS do resto. Mesmo desenho da LP (`rotas-lp-publica.ts`) e do webhook da Meta.
 *
 * ⚠️ Resposta IGUAL para contato novo e para telefone já cadastrado: dizer "já conhecemos você" faria do
 * formulário um verificador de "este telefone está na base?".
 */

const TAMANHO_MAX_ANEXO = 10 * 1024 * 1024
const MAX_ANEXOS = 10

/** Envios por (chave + IP) por minuto — gente de verdade envia uma vez, no máximo duas. */
const limitePorIp = criarLimiteTaxa({ teto: 8, janelaMs: 60_000 })
/** E um teto por formulário, independente de IP: IP se troca (e `x-forwarded-for` é cabeçalho de cliente). */
const limitePorFormulario = criarLimiteTaxa({ teto: 300, janelaMs: 60_000 })

const nao_encontrado = { erro: 'formulario.nao_encontrado', mensagem: 'Este formulário não está disponível.' }

interface Achado { tenantId: string; f: LinhaFormulario; campos: CampoFormulario[]; consentimento: string }

/** Chave pública → tenant + definição (já sob RLS). Inativo e inexistente são a mesma coisa lá fora. */
async function acharFormulario(chave: string): Promise<Achado | null> {
  if (!/^[a-z0-9]{16,40}$/.test(chave)) return null
  const [rota] = await sql<{ tenant_id: string; formulario_id: string; ativo: boolean }[]>`
    SELECT tenant_id, formulario_id, ativo FROM formulario_por_chave(${chave})`
  if (!rota || !rota.ativo) return null
  return comTenantServico(rota.tenant_id, async (tx) => {
    const [f] = await tx<LinhaFormulario[]>`
      SELECT id, nome, slug, chave_publica, titulo, descricao, tipo, filial_id, etapa_destino_id, responsavel_padrao_id,
             origem_id, cor, texto_botao, mensagem_sucesso, ativo, token_hash, criado_em
        FROM formulario WHERE tenant_id = tenant_atual() AND id = ${rota.formulario_id}`
    if (!f) return null
    const [t] = await tx<{ texto_consentimento: string | null }[]>`
      SELECT texto_consentimento FROM tenant WHERE id = tenant_atual()`
    return {
      tenantId: rota.tenant_id, f, campos: await camposDoFormulario(tx, f.id),
      consentimento: t?.texto_consentimento?.trim() || TEXTO_CONSENTIMENTO_PADRAO,
    }
  })
}

interface Anexo { campoId: string; nome: string; mime: string; bytes: Buffer }
interface Corpo { respostas: Record<string, unknown>; consentimento: boolean; armadilha: string; anexos: Anexo[]; erros: Record<string, string> }

const objeto = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** Lê JSON ou multipart (`dados` = JSON; cada arquivo vem num campo cujo nome é o id do campo `anexo`). */
async function lerCorpo(req: FastifyRequest, campos: CampoFormulario[]): Promise<Corpo> {
  const anexoIds = new Set(campos.filter((c) => c.tipo === 'anexo').map((c) => c.id))
  const saida: Corpo = { respostas: {}, consentimento: false, armadilha: '', anexos: [], erros: {} }
  const aplicar = (dados: Record<string, unknown>) => {
    saida.respostas = objeto(dados['respostas'])
    saida.consentimento = dados['consentimento'] === true
    const a = dados[CAMPO_ARMADILHA]
    saida.armadilha = typeof a === 'string' ? a.trim() : ''
  }

  if (!req.isMultipart()) { aplicar(objeto(req.body)); return saida }

  let ultimoCampo = ''
  try {
  for await (const parte of req.parts()) {
    if (parte.type === 'field') {
      if (parte.fieldname === 'dados' && typeof parte.value === 'string') {
        try { aplicar(objeto(JSON.parse(parte.value))) } catch { saida.erros['dados'] = 'Envio inválido.' }
      }
      continue
    }
    const campoId = parte.fieldname
    ultimoCampo = campoId
    if (!anexoIds.has(campoId)) { parte.file.resume(); saida.erros[campoId] = 'Este campo não aceita arquivo.'; continue }
    const nome = nomeSeguro(parte.filename)
    if (!nome) { parte.file.resume(); saida.erros[campoId] = 'O arquivo precisa de um nome.'; continue }
    if (!tipoPermitido(parte.mimetype, nome)) {
      parte.file.resume()
      saida.erros[campoId] = 'Tipo não permitido. Aceitos: PDF, imagens, planilhas, Word e texto.'
      continue
    }
    try {
      const bytes = await parte.toBuffer()
      if (parte.file.truncated) throw Object.assign(new Error('grande'), { code: 'FST_REQ_FILE_TOO_LARGE' })
      if (bytes.length === 0) { saida.erros[campoId] = 'O arquivo está vazio.'; continue }
      if (saida.anexos.some((x) => x.campoId === campoId)) { saida.erros[campoId] = 'Envie um arquivo por campo.'; continue }
      saida.anexos.push({ campoId, nome, mime: parte.mimetype.toLowerCase(), bytes })
    } catch (e) {
      if ((e as { code?: string }).code !== 'FST_REQ_FILE_TOO_LARGE') throw e
      saida.erros[campoId] = 'O arquivo passa de 10 MB.'
    }
  }
  } catch (e) {
    // O iterador também lança no limite de tamanho/quantidade: vira erro do campo, nunca 413 cru.
    const codigo = (e as { code?: string }).code
    if (codigo === 'FST_REQ_FILE_TOO_LARGE') saida.erros[ultimoCampo || 'dados'] = 'O arquivo passa de 10 MB.'
    else if (codigo === 'FST_FILES_LIMIT' || codigo === 'FST_PARTS_LIMIT') saida.erros['dados'] = 'Arquivos demais.'
    else throw e
  }
  return saida
}

const primeiro = (campos: CampoFormulario[], v: Record<string, unknown>, tipo: string): string | null => {
  const c = campos.find((x) => x.tipo === tipo && v[x.id] !== undefined)
  return c ? String(v[c.id]) : null
}

/**
 * Cria ou MESCLA o contato pelo telefone — a mesma regra do POST /v1/contatos: telefone PRINCIPAL é a identidade.
 * Contato existente só ganha o que faltava (e-mail, origem, filial); o nome e o cadastro do ERP nunca são pisados.
 */
async function criarOuMesclarContato(
  tx: Sql, a: Achado, valores: Record<string, string | number | string[]>, origemId: string,
): Promise<{ contatoId: string; novo: boolean }> {
  const tel = normalizarTelefone(String(primeiro(a.campos, valores, 'telefone')))!
  const email = primeiro(a.campos, valores, 'email')
  const documento = primeiro(a.campos, valores, 'cnpj') ?? primeiro(a.campos, valores, 'cpf')

  const [achado] = await tx<{ contato_id: string }[]>`
    SELECT contato_id FROM contato_telefone
     WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio} AND principal LIMIT 1`
  if (achado) {
    await tx`
      UPDATE contato SET email = COALESCE(email, ${email}), origem_id = COALESCE(origem_id, ${origemId}),
                         filial_id = COALESCE(filial_id, ${a.f.filial_id})
       WHERE tenant_id = tenant_atual() AND id = ${achado.contato_id}`
    if (documento) {
      const [tem] = await tx`SELECT 1 AS x FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${achado.contato_id} LIMIT 1`
      if (!tem) await gravarDocumento(tx, achado.contato_id, { documento })
    }
    return { contatoId: achado.contato_id, novo: false }
  }

  const ref = a.campos.find((c) => c.referencia)
  const nomeRef = ref ? valores[ref.id] : undefined
  const nome = (typeof nomeRef === 'string' && nomeRef ? nomeRef : `Formulário: ${a.f.nome}`).slice(0, 200)
  const contatoId = randomUUID()
  await tx`
    INSERT INTO contato (tenant_id, id, nome, email, origem_id, filial_id, origem_carga, ativo)
    VALUES (tenant_atual(), ${contatoId}, ${nome}, ${email}, ${origemId}, ${a.f.filial_id}, 'formulario', true)`
  await tx`
    INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
    VALUES (tenant_atual(), ${contatoId}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, true, 'formulario')`
  if (documento) await gravarDocumento(tx, contatoId, { documento })
  if (a.f.responsavel_padrao_id) {
    await tx`
      INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, origem, motivo)
      VALUES (tenant_atual(), ${randomUUID()}, ${contatoId}, ${a.f.responsavel_padrao_id}, 'automatica',
              ${`Formulário: ${a.f.nome}`.slice(0, 200)})`
  }
  return { contatoId, novo: true }
}

/** Origem do formulário, ou "Formulário: <nome>" criada sob demanda (o gestor a vê no catálogo de origens). */
async function origemDoFormulario(tx: Sql, f: LinhaFormulario): Promise<string> {
  if (f.origem_id) return f.origem_id
  const nome = `Formulário: ${f.nome}`.slice(0, 60)
  await tx`
    INSERT INTO origem (tenant_id, id, nome) VALUES (tenant_atual(), ${randomUUID()}, ${nome})
    ON CONFLICT (tenant_id, lower(nome)) DO NOTHING`
  const [o] = await tx<{ id: string }[]>`SELECT id FROM origem WHERE tenant_id = tenant_atual() AND lower(nome) = lower(${nome})`
  return o!.id
}

export async function rotasFormularioPublico(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: TAMANHO_MAX_ANEXO, files: MAX_ANEXOS, fields: 6, parts: MAX_ANEXOS + 8 },
  })

  app.get<{ Params: { chave: string } }>('/publico/f/:chave', async (req, reply) => {
    const a = await acharFormulario(req.params.chave)
    if (!a) return reply.code(404).send(nao_encontrado)
    // ⚠️ Só o que a pessoa precisa para preencher. Nada de tenant, filial, etapa, responsável ou origem.
    return reply.header('cache-control', 'public, max-age=60').send({
      titulo: a.f.titulo, descricao: a.f.descricao, cor: a.f.cor, textoBotao: a.f.texto_botao,
      campos: a.campos.map((c) => ({
        id: c.id, tipo: c.tipo, rotulo: c.rotulo, placeholder: c.placeholder ?? null,
        obrigatorio: c.obrigatorio, opcoes: c.opcoes, condicoes: c.condicoes,
      })),
      textoConsentimento: a.consentimento,
      armadilha: CAMPO_ARMADILHA,
    })
  })

  app.post<{ Params: { chave: string } }>('/publico/f/:chave/respostas', async (req, reply) => {
    const chave = req.params.chave
    const a = await acharFormulario(chave)
    if (!a) return reply.code(404).send(nao_encontrado)

    const agora = Date.now()
    const ip = ipDoCliente(req)
    if (!limitePorIp.permitir(`${chave}:${ip}`, agora) || !limitePorFormulario.permitir(chave, agora)) {
      return reply.code(429).send({ erro: 'limite.excedido', mensagem: 'Muitos envios. Tente novamente em instantes.' })
    }

    const corpo = await lerCorpo(req, a.campos)
    const obrigado = { ok: true, mensagem: a.f.mensagem_sucesso }
    // ⚠️ Armadilha preenchida = bot: responde como sucesso e NÃO grava (recusar ensinaria o campo a deixar vazio).
    if (corpo.armadilha) return reply.code(201).send(obrigado)

    const erros: Record<string, string> = { ...corpo.erros }
    if (!corpo.consentimento) erros['consentimento'] = 'É preciso aceitar o aviso de privacidade para enviar.'
    const v = validarRespostas(a.campos, corpo.respostas, new Set(corpo.anexos.map((x) => x.campoId)))
    if (!v.ok) Object.assign(erros, v.campos)
    // Anexo de campo que a condicional escondeu não é gravado.
    const idsVisiveis = new Set(camposVisiveis(a.campos, corpo.respostas).map((c) => c.id))
    const visiveis = corpo.anexos.filter((x) => idsVisiveis.has(x.campoId))
    if (Object.keys(erros).length > 0 || !v.ok) {
      return reply.code(422).send({ erro: 'validacao', mensagem: 'Corrija os campos destacados.', campos: erros })
    }
    const bucket = arquivosBucket()
    if (visiveis.length > 0 && !bucket.disponivel()) {
      return reply.code(503).send({ erro: 'arquivos.bucket_indisponivel', mensagem: 'Não foi possível receber arquivos agora.' })
    }

    const enviados: string[] = []
    try {
      await comTenantServico(a.tenantId, async (tx) => {
        const origemId = await origemDoFormulario(tx, a.f)
        const { contatoId, novo } = await criarOuMesclarContato(tx, a, v.dados.valores, origemId)

        // Consentimento LGPD: o texto EXIBIDO fica congelado na resposta; o histórico do contato ganha o registro.
        await tx`
          INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem)
          VALUES (tenant_atual(), ${contatoId}, 'whatsapp', true, 'cadastro')`

        const respostas: Record<string, unknown> = { ...v.dados.valores }
        for (const x of visiveis) {
          const arquivoId = randomUUID()
          const chaveObj = chaveDoArquivo(a.tenantId, contatoId, arquivoId, x.nome)
          // Bytes primeiro: se o bucket falhar nada fica no banco; se o banco falhar o objeto órfão é removido abaixo.
          await bucket.subir(chaveObj, x.bytes, x.mime)
          enviados.push(chaveObj)
          await tx`
            INSERT INTO contato_arquivo (tenant_id, id, contato_id, nome, tipo_mime, tamanho_bytes, chave_bucket, legenda)
            VALUES (tenant_atual(), ${arquivoId}, ${contatoId}, ${x.nome}, ${x.mime}, ${x.bytes.length}, ${chaveObj},
                    ${`Formulário: ${a.f.nome}`.slice(0, 300)})`
          respostas[x.campoId] = { arquivoId, nome: x.nome }
        }

        if (a.f.etapa_destino_id) {
          // Uma aberta por contato: quem já está no funil não ganha segunda oportunidade.
          const id = randomUUID()
          const [criada] = await tx<{ id: string }[]>`
            INSERT INTO oportunidade (tenant_id, id, contato_id, etapa_id, titulo, responsavel_id, posicao)
            VALUES (tenant_atual(), ${id}, ${contatoId}, ${a.f.etapa_destino_id}, ${a.f.nome.slice(0, 200)},
                    ${a.f.responsavel_padrao_id}, extract(epoch from now()))
            ON CONFLICT (tenant_id, contato_id) WHERE estado = 'aberta' DO NOTHING
            RETURNING id`
          if (criada) {
            await tx`
              INSERT INTO oportunidade_etapa_historico (tenant_id, id, oportunidade_id, etapa_id)
              VALUES (tenant_atual(), ${randomUUID()}, ${id}, ${a.f.etapa_destino_id})`
          }
        }

        await tx`
          INSERT INTO formulario_resposta (tenant_id, id, formulario_id, contato_id, respostas, ip_hash, consentimento_texto, contato_novo)
          VALUES (tenant_atual(), ${randomUUID()}, ${a.f.id}, ${contatoId}, ${tx.json(respostas as never)},
                  ${createHash('sha256').update(`${chave}:${ip}`).digest('hex')}, ${a.consentimento}, ${novo})`
      })
    } catch (e) {
      await Promise.all(enviados.map((k) => bucket.remover(k).catch(() => undefined)))
      throw e
    }
    return reply.code(201).send(obrigado)
  })
}
