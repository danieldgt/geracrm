import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { camposVisiveis, normalizarTelefone, validarRespostas, type CampoFormulario } from '@geracrm/shared'
import { sql, comTenantServico, type Sql } from '../../db/index.js'
import { arquivosBucket, type ArquivosBucket } from '../crm/arquivos-bucket.js'
import { assinaturaConfere, chaveDoAnexoDeResposta, nomeSeguro, tipoPermitido } from '../crm/arquivos-regras.js'
import { gravarDocumento } from '../crm/contato-gravacao.js'
import { CAMPO_ARMADILHA } from './pagina-lp.js'
import { criarLimiteTaxa } from './limite-taxa.js'
import { ipDoCliente } from './rotas-lp-publica.js'
import {
  camposDoFormulario, textoConsentimentoExibido, type LinhaFormulario,
} from './formulario-dados.js'

/**
 * A SUPERFÍCIE PÚBLICA do formulário (F3).
 *
 * ⚠️ **Sem autenticação, e é o ponto.** O tenant é RESOLVIDO pela chave da URL (`formulario_por_chave()`,
 * SECURITY DEFINER, migration 0127), nunca recebido — `x-tenant-id` ou `tenantId` no corpo são ignorados.
 * A partir daí tudo roda em `comTenantServico`, sob a mesma RLS do resto. Mesmo desenho da LP.
 *
 * ⚠️ Resposta IGUAL para contato novo e para telefone já cadastrado: dizer "já conhecemos você" faria do
 * formulário um verificador de "este telefone está na base?".
 *
 * ⚠️ Quem preenche é ANÔNIMO. Telefone já cadastrado NÃO prova que é o dono do cadastro: nesse caso nada
 * do contato muda (nem e-mail, nem documento, nem consentimento, nem funil) — a resposta fica
 * `verificacao='pendente'`, com os anexos presos a ela, até um gestor "Aplicar ao contato".
 *
 * Ordem do POST (cada etapa barra antes da mais cara): formato da chave → limite de taxa (memória, sem
 * banco) → definição (banco, transação curta) → vaga de upload (semáforo) → leitura do corpo (rede, SEM
 * conexão do pool) → validação → bytes no bucket (rede, SEM conexão do pool) → transação só com INSERTs
 * → se ela falhar, os objetos são removidos (compensação).
 */

const TAMANHO_MAX_ANEXO = 10 * 1024 * 1024
const MAX_ANEXOS = 10
/** Teto da requisição inteira: 10 anexos de 10 MB não cabem — a soma é que é limitada. */
const TAMANHO_MAX_REQUISICAO = 20 * 1024 * 1024
/** Folga para os cabeçalhos das partes e o JSON de `dados`, no teto pelo Content-Length. */
const FOLGA_MULTIPART = 256 * 1024

/** Envios por (chave + IP) por minuto — gente de verdade envia uma vez, no máximo duas. */
const limitePorIp = criarLimiteTaxa({ teto: 8, janelaMs: 60_000 })
/** E um teto por formulário, independente de IP: IP se troca (rede móvel, proxy aberto). */
const limitePorFormulario = criarLimiteTaxa({ teto: 300, janelaMs: 60_000 })

/**
 * Semáforo GLOBAL de uploads: cada envio com arquivo segura até 20 MB em memória. 4 simultâneos = 80 MB
 * no pior caso; o quinto recebe 503 `formulario.ocupado` com Retry-After, em vez de derrubar a instância.
 */
let maxUploads = 4
let uploadsAtivos = 0
/** Só para teste: muda o teto do semáforo (sem argumento volta ao padrão). */
export function definirMaxUploadsSimultaneos(n = 4): void { maxUploads = n }

const nao_encontrado = { erro: 'formulario.nao_encontrado', mensagem: 'Este formulário não está disponível.' }
const envioInvalido = { erro: 'formulario.envio_invalido', mensagem: 'Envio inválido. Recarregue a página e tente de novo.' }
const grandeDemais = { erro: 'formulario.grande_demais', mensagem: 'Os arquivos passam de 20 MB no total.' }

/**
 * Segredo do HMAC do IP. ⚠️ sha256 puro de IPv4 se reverte por força bruta em minutos; com segredo do
 * servidor, não. `FORMULARIO_IP_SEGREDO`; na falta, derivado de `CREDENCIAL_CHAVE` (que já é segredo de
 * servidor); na falta dos dois, aleatório por processo (o hash deixa de casar entre reinícios).
 */
const segredoIp: Buffer = (() => {
  const proprio = process.env.FORMULARIO_IP_SEGREDO?.trim()
  if (proprio) return Buffer.from(proprio)
  const base = process.env.CREDENCIAL_CHAVE?.trim()
  if (base) return createHmac('sha256', base).update('geracrm:formulario:ip').digest()
  return randomBytes(32)
})()
export const hashDoIp = (chave: string, ip: string): string =>
  createHmac('sha256', segredoIp).update(`${chave}:${ip}`).digest('hex')

/** Hash do texto de consentimento exibido: o POST prova que a pessoa aceitou ESTE texto. */
export const hashDoTexto = (texto: string): string => createHash('sha256').update(texto).digest('hex')

interface Achado { tenantId: string; f: LinhaFormulario; campos: CampoFormulario[]; consentimento: string }

const CHAVE_VALIDA = /^[a-z0-9]{16,40}$/

/** Chave pública → tenant + definição (já sob RLS). Inativo e inexistente são a mesma coisa lá fora. */
async function acharFormulario(chave: string): Promise<Achado | null> {
  if (!CHAVE_VALIDA.test(chave)) return null
  const [rota] = await sql<{ tenant_id: string; formulario_id: string; ativo: boolean }[]>`
    SELECT tenant_id, formulario_id, ativo FROM formulario_por_chave(${chave})`
  if (!rota || !rota.ativo) return null
  return comTenantServico(rota.tenant_id, async (tx) => {
    // ⚠️ Sem `token_hash`: a superfície pública não carrega o que não usa.
    const [f] = await tx<LinhaFormulario[]>`
      SELECT id, nome, slug, chave_publica, titulo, descricao, tipo, filial_id, etapa_destino_id, responsavel_padrao_id,
             origem_id, cor, texto_botao, mensagem_sucesso, ativo, consentimento_marketing, NULL::text AS token_hash, criado_em
        FROM formulario WHERE tenant_id = tenant_atual() AND id = ${rota.formulario_id}`
    if (!f) return null
    const [t] = await tx<{ texto_consentimento: string | null }[]>`
      SELECT texto_consentimento FROM tenant WHERE id = tenant_atual()`
    return {
      tenantId: rota.tenant_id, f, campos: await camposDoFormulario(tx, f.id),
      consentimento: textoConsentimentoExibido(t?.texto_consentimento ?? null, f.consentimento_marketing),
    }
  })
}

interface Anexo { campoId: string; nome: string; mime: string; bytes: Buffer }
interface Corpo {
  respostas: Record<string, unknown>; consentimento: boolean; hashTexto: string | null; armadilha: string
  anexos: Anexo[]; erros: Record<string, string>
}
/** Falha do corpo inteiro (não de um campo): vira status próprio, tipificado. */
class CorpoRecusado extends Error {
  constructor(readonly status: 413 | 422, readonly corpo: { erro: string; mensagem: string; campos?: Record<string, string> }) {
    super(corpo.erro)
  }
}

const objeto = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const codigoDe = (e: unknown): string => String((e as { code?: unknown })?.code ?? '')

/** Lê JSON ou multipart (`dados` = JSON; cada arquivo vem num campo cujo nome é o id do campo `anexo`). */
async function lerCorpo(req: FastifyRequest, campos: CampoFormulario[]): Promise<Corpo> {
  const anexoIds = new Set(campos.filter((c) => c.tipo === 'anexo').map((c) => c.id))
  const saida: Corpo = { respostas: {}, consentimento: false, hashTexto: null, armadilha: '', anexos: [], erros: {} }
  const aplicar = (dados: Record<string, unknown>) => {
    saida.respostas = objeto(dados['respostas'])
    saida.consentimento = dados['consentimento'] === true
    saida.hashTexto = typeof dados['textoConsentimentoHash'] === 'string' ? dados['textoConsentimentoHash'] : null
    const a = dados[CAMPO_ARMADILHA]
    saida.armadilha = typeof a === 'string' ? a.trim() : ''
  }

  if (!req.isMultipart()) { aplicar(objeto(req.body)); return saida }

  let ultimoCampo = ''
  let total = 0
  let leuDados = false
  const vistos = new Set<string>()
  try {
    for await (const parte of req.parts()) {
      if (parte.type === 'field') {
        if (parte.fieldname !== 'dados') continue
        if (leuDados) throw new CorpoRecusado(422, { ...envioInvalido, campos: { dados: 'Parte repetida.' } })
        leuDados = true
        if (typeof parte.value !== 'string') throw new CorpoRecusado(422, envioInvalido)
        let dados: unknown
        try { dados = JSON.parse(parte.value) } catch { throw new CorpoRecusado(422, envioInvalido) }
        aplicar(objeto(dados))
        continue
      }
      const campoId = parte.fieldname
      ultimoCampo = campoId
      // ⚠️ Repetida é recusada ANTES de ler: senão 10 cópias do mesmo campo enchiam a memória até o fim.
      if (vistos.has(campoId)) { parte.file.resume(); saida.erros[campoId] = 'Envie um arquivo por campo.'; continue }
      vistos.add(campoId)
      if (!anexoIds.has(campoId)) { parte.file.resume(); saida.erros[campoId] = 'Este campo não aceita arquivo.'; continue }
      const nome = nomeSeguro(parte.filename)
      if (!nome) { parte.file.resume(); saida.erros[campoId] = 'O arquivo precisa de um nome.'; continue }
      const mime = parte.mimetype.toLowerCase()
      if (!tipoPermitido(mime, nome)) {
        parte.file.resume()
        saida.erros[campoId] = 'Tipo não permitido. Aceitos: PDF, imagens, planilhas, Word e texto.'
        continue
      }
      let bytes: Buffer
      try {
        bytes = await parte.toBuffer()
      } catch (e) {
        if (codigoDe(e) !== 'FST_REQ_FILE_TOO_LARGE') throw e
        saida.erros[campoId] = 'O arquivo passa de 10 MB.'
        continue
      }
      total += bytes.length
      if (total > TAMANHO_MAX_REQUISICAO) throw new CorpoRecusado(413, grandeDemais)
      if (bytes.length === 0) { saida.erros[campoId] = 'O arquivo está vazio.'; continue }
      // ⚠️ O conteúdo tem de confirmar o tipo declarado: `.exe` renomeado para `.pdf` não passa.
      if (!assinaturaConfere(mime, bytes)) { saida.erros[campoId] = 'O conteúdo do arquivo não corresponde ao tipo.'; continue }
      saida.anexos.push({ campoId, nome, mime, bytes })
    }
  } catch (e) {
    if (e instanceof CorpoRecusado) throw e
    // O iterador também lança no limite de tamanho/quantidade e em multipart malformado: vira erro
    // tipificado (422/413), nunca o 500 genérico.
    const codigo = codigoDe(e)
    if (codigo === 'FST_REQ_FILE_TOO_LARGE') saida.erros[ultimoCampo || 'dados'] = 'O arquivo passa de 10 MB.'
    else if (codigo === 'FST_FILES_LIMIT' || codigo === 'FST_PARTS_LIMIT' || codigo === 'FST_FIELDS_LIMIT') {
      throw new CorpoRecusado(422, { erro: 'validacao', mensagem: 'Arquivos demais.', campos: { dados: 'Arquivos demais.' } })
    } else throw new CorpoRecusado(422, envioInvalido)
  }
  return saida
}

const primeiro = (campos: CampoFormulario[], v: Record<string, unknown>, tipo: string): string | null => {
  const c = campos.find((x) => x.tipo === tipo && v[x.id] !== undefined)
  return c ? String(v[c.id]) : null
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

interface AnexoNoBucket { campoId: string; arquivoId: string; nome: string; mime: string; tamanho: number; chave: string }

interface Envio {
  a: Achado; respostaId: string; valores: Record<string, string | number | string[]>
  anexos: AnexoNoBucket[]; ipHash: string
}

/**
 * Grava a resposta numa transação SÓ de INSERTs (os bytes já estão no bucket).
 * Telefone já cadastrado → resposta pendente, contato INTOCADO. Telefone novo → contato criado.
 */
async function gravarResposta(e: Envio): Promise<void> {
  const { a, respostaId, valores, anexos, ipHash } = e
  const tel = normalizarTelefone(String(primeiro(a.campos, valores, 'telefone')))!
  const respostas: Record<string, unknown> = { ...valores }
  for (const x of anexos) respostas[x.campoId] = { arquivoId: x.arquivoId, nome: x.nome }
  const legenda = `Formulário: ${a.f.nome}`.slice(0, 300)

  await comTenantServico(a.tenantId, async (tx) => {
    const [existente] = await tx<{ contato_id: string }[]>`
      SELECT contato_id FROM contato_telefone
       WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio} AND principal LIMIT 1`

    if (existente) {
      // ⚠️ Nenhum UPDATE em contato, nenhum consentimento, nenhuma oportunidade: só a resposta pendente.
      await tx`
        INSERT INTO formulario_resposta (tenant_id, id, formulario_id, contato_id, respostas, ip_hash, consentimento_texto,
                                         contato_novo, verificacao)
        VALUES (tenant_atual(), ${respostaId}, ${a.f.id}, ${existente.contato_id}, ${tx.json(respostas as never)},
                ${ipHash}, ${a.consentimento}, false, 'pendente')`
      for (const x of anexos) {
        await tx`
          INSERT INTO formulario_resposta_anexo (tenant_id, id, resposta_id, campo_id, nome, tipo_mime, tamanho_bytes, chave_bucket)
          VALUES (tenant_atual(), ${x.arquivoId}, ${respostaId}, ${x.campoId}, ${x.nome}, ${x.mime}, ${x.tamanho}, ${x.chave})`
      }
      return
    }

    const origemId = await origemDoFormulario(tx, a.f)
    const email = primeiro(a.campos, valores, 'email')
    const documento = primeiro(a.campos, valores, 'cnpj') ?? primeiro(a.campos, valores, 'cpf')
    const ref = a.campos.find((c) => c.referencia)
    const nomeRef = ref ? valores[ref.id] : undefined
    const nome = (typeof nomeRef === 'string' && nomeRef ? nomeRef : `Formulário: ${a.f.nome}`).slice(0, 200)
    const contatoId = randomUUID()
    // LGPD: marketing só com pedido EXPLÍCITO no texto exibido (flag do formulário).
    await tx`
      INSERT INTO contato (tenant_id, id, nome, email, origem_id, filial_id, origem_carga, ativo, recebe_campanhas)
      VALUES (tenant_atual(), ${contatoId}, ${nome}, ${email}, ${origemId}, ${a.f.filial_id}, 'formulario', true,
              ${a.f.consentimento_marketing})`
    await tx`
      INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
      VALUES (tenant_atual(), ${contatoId}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, true, 'formulario')`
    if (documento) await gravarDocumento(tx, contatoId, { documento })
    if (a.f.responsavel_padrao_id) {
      await tx`
        INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, origem, motivo)
        VALUES (tenant_atual(), ${randomUUID()}, ${contatoId}, ${a.f.responsavel_padrao_id}, 'automatica', ${legenda.slice(0, 200)})`
    }

    await tx`
      INSERT INTO formulario_resposta (tenant_id, id, formulario_id, contato_id, respostas, ip_hash, consentimento_texto, contato_novo)
      VALUES (tenant_atual(), ${respostaId}, ${a.f.id}, ${contatoId}, ${tx.json(respostas as never)}, ${ipHash},
              ${a.consentimento}, true)`

    // Consentimento LGPD: o texto EXIBIDO fica congelado na resposta, e o histórico aponta para ela.
    await tx`
      INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, formulario_resposta_id)
      VALUES (tenant_atual(), ${contatoId}, 'whatsapp', true, 'formulario', ${respostaId})`
    if (a.f.consentimento_marketing) {
      await tx`
        INSERT INTO consentimento_contato (tenant_id, contato_id, tipo, concedido, origem, formulario_resposta_id)
        VALUES (tenant_atual(), ${contatoId}, 'campanhas', true, 'formulario', ${respostaId})`
    }

    for (const x of anexos) {
      await tx`
        INSERT INTO contato_arquivo (tenant_id, id, contato_id, nome, tipo_mime, tamanho_bytes, chave_bucket, legenda)
        VALUES (tenant_atual(), ${x.arquivoId}, ${contatoId}, ${x.nome}, ${x.mime}, ${x.tamanho}, ${x.chave}, ${legenda})`
    }

    if (a.f.etapa_destino_id) {
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
  })
}

/** Sobe os anexos FORA de qualquer transação. Falhou no meio: remove o que já subiu e relança. */
async function subirAnexos(bucket: ArquivosBucket, tenantId: string, respostaId: string, anexos: Anexo[]): Promise<AnexoNoBucket[]> {
  const subidos: AnexoNoBucket[] = []
  try {
    for (const x of anexos) {
      const arquivoId = randomUUID()
      const chave = chaveDoAnexoDeResposta(tenantId, respostaId, arquivoId, x.nome)
      await bucket.subir(chave, x.bytes, x.mime)
      subidos.push({ campoId: x.campoId, arquivoId, nome: x.nome, mime: x.mime, tamanho: x.bytes.length, chave })
    }
    return subidos
  } catch (e) {
    await removerAnexos(bucket, subidos)
    throw e
  }
}
const removerAnexos = (bucket: ArquivosBucket, anexos: AnexoNoBucket[]) =>
  Promise.all(anexos.map((x) => bucket.remover(x.chave).catch(() => undefined)))

/**
 * Erros desta superfície: tipificados e SEM dado pessoal no log. ⚠️ O `detail` de um 23505 do Postgres
 * traz a chave violada — o telefone — e o handler genérico logava o erro inteiro.
 */
function tratarErro(erro: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const status = erro.statusCode ?? 500
  if (status === 413 || erro.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send(grandeDemais)
  if (status >= 400 && status < 500) return reply.code(422).send(envioInvalido)
  req.log.error({ codigo: erro.code, restricao: (erro as { constraint_name?: string }).constraint_name }, 'falha no formulário público')
  return reply.code(500).send({ erro: 'erro.interno', mensagem: 'Erro interno.' })
}

export async function rotasFormularioPublico(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: TAMANHO_MAX_ANEXO, files: MAX_ANEXOS, fields: 3, parts: MAX_ANEXOS + 3, fieldSize: 256 * 1024 },
  })
  app.setErrorHandler(tratarErro)
  // ⚠️ JSON público: o navegador não "adivinha" outro tipo.
  app.addHook('onSend', async (_req, reply) => { reply.header('x-content-type-options', 'nosniff') })

  app.get<{ Params: { chave: string } }>('/publico/f/:chave', async (req, reply) => {
    const a = await acharFormulario(req.params.chave)
    if (!a) return reply.code(404).send(nao_encontrado)
    // ⚠️ Só o que a pessoa precisa para preencher. Nada de tenant, filial, etapa, responsável ou origem.
    // `no-cache`: depois de um 409 `texto_mudou` a página recarrega e precisa ver o texto novo.
    return reply.header('cache-control', 'no-cache').send({
      titulo: a.f.titulo, descricao: a.f.descricao, cor: a.f.cor, textoBotao: a.f.texto_botao,
      campos: a.campos.map((c) => ({
        id: c.id, tipo: c.tipo, rotulo: c.rotulo, placeholder: c.placeholder ?? null,
        obrigatorio: c.obrigatorio, opcoes: c.opcoes, condicoes: c.condicoes,
      })),
      textoConsentimento: a.consentimento,
      textoConsentimentoHash: hashDoTexto(a.consentimento),
      armadilha: CAMPO_ARMADILHA,
    })
  })

  app.post<{ Params: { chave: string } }>('/publico/f/:chave/respostas', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const chave = req.params.chave
    if (!CHAVE_VALIDA.test(chave)) return reply.code(404).send(nao_encontrado)

    // ⚠️ Limite ANTES de qualquer consulta ao banco; o teto do formulário ANTES da chave por IP (estourado
    //    o teto, nem cria entrada nova no mapa). `req.ip` vem do `trustProxy` — nunca do 1º valor do XFF.
    const agora = Date.now()
    const ip = ipDoCliente(req)
    if (!limitePorFormulario.permitir(chave, agora) || !limitePorIp.permitir(`${chave}:${ip}`, agora)) {
      return reply.code(429).send({ erro: 'limite.excedido', mensagem: 'Muitos envios. Tente novamente em instantes.' })
    }

    const multipartComArquivo = req.isMultipart()
    if (multipartComArquivo && Number(req.headers['content-length'] ?? 0) > TAMANHO_MAX_REQUISICAO + FOLGA_MULTIPART) {
      return reply.code(413).send(grandeDemais)
    }

    const a = await acharFormulario(chave)
    if (!a) return reply.code(404).send(nao_encontrado)

    if (multipartComArquivo) {
      if (uploadsAtivos >= maxUploads) {
        return reply.code(503).header('retry-after', '5')
          .send({ erro: 'formulario.ocupado', mensagem: 'Recebendo muitos arquivos agora. Tente de novo em alguns segundos.' })
      }
      uploadsAtivos++
    }
    try {
      return await processarEnvio(req, reply, a, chave, ip)
    } finally {
      if (multipartComArquivo) uploadsAtivos--
    }
  })
}

async function processarEnvio(req: FastifyRequest, reply: FastifyReply, a: Achado, chave: string, ip: string) {
  let corpo: Corpo
  try {
    corpo = await lerCorpo(req, a.campos)
  } catch (e) {
    if (e instanceof CorpoRecusado) return reply.code(e.status).send(e.corpo)
    throw e
  }
  const obrigado = { ok: true, mensagem: a.f.mensagem_sucesso }
  // ⚠️ Armadilha preenchida = bot: responde como sucesso e NÃO grava (recusar ensinaria o campo a deixar vazio).
  if (corpo.armadilha) return reply.code(201).send(obrigado)

  // LGPD: a pessoa aceitou o texto que VIU. Se o texto mudou desde que a página abriu, ela relê.
  if (corpo.hashTexto !== hashDoTexto(a.consentimento)) {
    return reply.code(409).send({ erro: 'formulario.texto_mudou', mensagem: 'O aviso de privacidade mudou. Recarregue a página para ler o texto atual.' })
  }

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

  // ⚠️ Bytes ANTES da transação (rede sem conexão do pool presa); a chave usa o id da resposta, gerado aqui.
  const respostaId = randomUUID()
  const anexos = await subirAnexos(bucket, a.tenantId, respostaId, visiveis)
  const envio: Envio = { a, respostaId, valores: v.dados.valores, anexos, ipHash: hashDoIp(chave, ip) }
  try {
    try {
      await gravarResposta(envio)
    } catch (e) {
      // Dois envios simultâneos do MESMO telefone novo: o segundo bate no índice único do principal. A
      // transação do outro já confirmou — relê e segue como "já cadastrado" (sem 500, sem telefone no log).
      if (codigoDe(e) !== '23505') throw e
      await gravarResposta(envio)
    }
  } catch (e) {
    await removerAnexos(bucket, anexos)
    throw e
  }
  return reply.code(201).send(obrigado)
}
