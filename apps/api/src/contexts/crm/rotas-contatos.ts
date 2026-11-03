import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Sql } from 'postgres'
import { classificarRfv, normalizarTelefone, normalizarDocumento, apenasDigitos, ehPerfilPreco, perfilDeCotacao } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { garantirUsuarioId } from '../atendimento/rotas-fila.js'
import { parseCsvContatos } from './importar-csv.js'
import { validarCadastro, type ContatoCadastro } from './contato-cadastro.js'

/** Teto de linhas por importação — evita engolir um arquivo gigante numa tx. */
const MAX_LINHAS_CSV = 5000

/**
 * CRM: a base de clientes com RFV, em duas leituras da MESMA verdade.
 *
 *  · `/v1/contatos`     — ordenada por VALOR (maiores compradores).
 *  · `/v1/fila-do-dia`  — ordenada por URGÊNCIA (quem está saindo do ritmo).
 *
 * ⚠️ Paginação por CURSOR (keyset), nunca OFFSET profundo — grid não paginado
 * derrubou o Postgres do GeraCloud por OOM, e há coluna de 11 mil cards.
 *
 * ⚠️ A classificação RFV vem de `@geracrm/shared` — a mesma regra serve web, app
 * e API. O endpoint monta o dado; o domínio decide o segmento.
 */

const LIMITE_PADRAO = 30
const LIMITE_MAX = 100

/** Linha crua da view; bigint/numeric vêm como STRING do driver. */
interface LinhaMetrica {
  id: string; nome: string; qtd_vendas: string; total_centavos: string
  dias_sem_comprar: number | null; atraso_relativo: string | null
  media_entre_vendas_dias: string | null; ultima_venda_em: Date | null
  confiavel: boolean; ticket_medio_centavos: string | null
}

/** Converte a linha em item de API, já com o segmento RFV do domínio. */
function paraItem(l: LinhaMetrica) {
  const atrasoRelativo = l.atraso_relativo === null ? null : Number(l.atraso_relativo)
  const segmento = classificarRfv({
    qtdVendas: Number(l.qtd_vendas),
    diasSemComprar: l.dias_sem_comprar,
    atrasoRelativo,
  })
  return {
    id: l.id,
    nome: l.nome,
    qtdVendas: Number(l.qtd_vendas),
    totalCentavos: Number(l.total_centavos),
    ticketMedioCentavos: l.ticket_medio_centavos === null ? null : Number(l.ticket_medio_centavos),
    diasSemComprar: l.dias_sem_comprar,
    mediaEntreVendasDias: l.media_entre_vendas_dias === null ? null : Number(l.media_entre_vendas_dias),
    atrasoRelativo,
    ultimaVendaEm: l.ultima_venda_em,
    // ⚠️ Viaja com o dado: false → a tela diz "estimado" em vez de afirmar um
    //    ritmo que o histórico anterior à carga não deixa ver.
    confiavel: l.confiavel,
    segmento,
  }
}

const limiteDe = (bruto: unknown) => Math.min(Number(bruto) || LIMITE_PADRAO, LIMITE_MAX)

/** Cursor opaco de dois campos. Inválido → começa do início, nunca 500. */
function lerCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null
  const [a, b] = Buffer.from(cursor, 'base64url').toString('utf8').split(':')
  return a !== undefined && b ? [a, b] : null
}
const escreverCursor = (a: string | number, id: string) =>
  Buffer.from(`${a}:${id}`, 'utf8').toString('base64url')

/**
 * Documento (CNPJ/CPF) e endereço de uma edição manual.
 *
 * ⚠️ Linha do ERP NUNCA é reescrita. A edição do usuário VENCE para exibição
 *    (ele corrigiu o dado): a linha manual vira a principal/fiscal e a do ERP é
 *    só DEMOVIDA (principal/fiscal = false), intacta, na mesma transação.
 *    A ingestão do ERP (`ingestao-clientes.ts`) só INSERE telefone/documento
 *    quando faltam e não toca em endereço — não re-promove sobre o manual.
 *    Reenviar o mesmo valor que o ERP já mostra (o formulário devolve tudo)
 *    não cria linha manual: seria um override sem mudança.
 *    Vazio remove só a linha manual; se sobrar linha do ERP sem principal, ela
 *    volta a ser a principal.
 */
interface EnderecoLinha {
  seq: number; logradouro: string | null; numero: string | null; complemento: string | null
  bairro: string | null; cidade: string | null; uf: string | null; cep: string | null
  principal: boolean; fonte: string
}

const trimOuNull = (x: string | null | undefined) => (typeof x === 'string' && x.trim() !== '' ? x.trim() : null)

async function gravarDocumento(tx: Sql, id: string, d: ContatoCadastro): Promise<void> {
  const doc = d.documento ? apenasDigitos(d.documento) : null
  const linhas = await tx<{ seq: number; tipo: string; numero: string; fiscal: boolean; fonte: string }[]>`
    SELECT seq, tipo, numero, fiscal, fonte FROM contato_documento
     WHERE tenant_id = tenant_atual() AND contato_id = ${id} ORDER BY seq`
  const manual = linhas.find((l) => l.fonte === 'manual')

  if (!doc) {
    if (!manual) return
    await tx`DELETE FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${manual.seq}`
    const resto = linhas.filter((l) => l.seq !== manual.seq)
    if (resto.length > 0 && !resto.some((l) => l.fiscal)) {
      await tx`UPDATE contato_documento SET fiscal = true WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${resto[0]!.seq}`
    }
    return
  }

  const tipo = doc.length === 14 ? 'cnpj' : 'cpf'
  if (!manual) {
    const fiscalAtual = linhas.find((l) => l.fiscal)
    if (fiscalAtual && fiscalAtual.tipo === tipo && fiscalAtual.numero === doc) return // já é o que a ficha mostra
  }
  let seq: number
  if (manual) {
    seq = manual.seq
    await tx`UPDATE contato_documento SET fiscal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND fiscal AND seq <> ${seq}`
    await tx`UPDATE contato_documento SET tipo = ${tipo}, numero = ${doc}, fiscal = true, visto_em = now()
              WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${seq}`
  } else {
    seq = Math.max(0, ...linhas.map((l) => l.seq)) + 1
    await tx`UPDATE contato_documento SET fiscal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND fiscal`
    await tx`
      INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fiscal, fonte)
      VALUES (tenant_atual(), ${id}, ${seq}, ${tipo}, ${doc}, true, 'manual')`
  }
}

async function gravarEndereco(tx: Sql, id: string, d: ContatoCadastro): Promise<void> {
  const e = d.endereco
  const novo = {
    logradouro: trimOuNull(e?.logradouro), numero: trimOuNull(e?.numero), complemento: trimOuNull(e?.complemento),
    bairro: trimOuNull(e?.bairro), cidade: trimOuNull(e?.cidade), uf: trimOuNull(e?.uf),
    cep: e?.cep ? apenasDigitos(e.cep) : null,
  }
  const preenchido = Object.values(novo).some((x) => x !== null)
  const linhas = await tx<EnderecoLinha[]>`
    SELECT seq, logradouro, numero, complemento, bairro, cidade, uf, cep, principal, fonte FROM contato_endereco
     WHERE tenant_id = tenant_atual() AND contato_id = ${id} ORDER BY seq`
  const manual = linhas.find((l) => l.fonte === 'manual')

  if (!preenchido) {
    if (!manual) return
    await tx`DELETE FROM contato_endereco WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${manual.seq}`
    const resto = linhas.filter((l) => l.seq !== manual.seq)
    if (resto.length > 0 && !resto.some((l) => l.principal)) {
      await tx`UPDATE contato_endereco SET principal = true WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${resto[0]!.seq}`
    }
    return
  }

  if (!manual) {
    const principal = linhas.find((l) => l.principal)
    const igual = principal && (Object.keys(novo) as (keyof typeof novo)[]).every((k) => trimOuNull(principal[k]) === novo[k])
    if (igual) return // já é o que a ficha mostra
  }
  let seq: number
  if (manual) {
    seq = manual.seq
    await tx`UPDATE contato_endereco SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND principal AND seq <> ${seq}`
    await tx`
      UPDATE contato_endereco SET logradouro = ${novo.logradouro}, numero = ${novo.numero}, complemento = ${novo.complemento},
             bairro = ${novo.bairro}, cidade = ${novo.cidade}, uf = ${novo.uf}, cep = ${novo.cep}, principal = true
       WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${seq} AND fonte = 'manual'`
  } else {
    seq = Math.max(0, ...linhas.map((l) => l.seq)) + 1
    await tx`UPDATE contato_endereco SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND principal`
    await tx`
      INSERT INTO contato_endereco (tenant_id, contato_id, seq, logradouro, numero, complemento, bairro, cidade, uf, cep, principal, fonte)
      VALUES (tenant_atual(), ${id}, ${seq}, ${novo.logradouro}, ${novo.numero}, ${novo.complemento},
              ${novo.bairro}, ${novo.cidade}, ${novo.uf}, ${novo.cep}, true, 'manual')`
  }
}

async function gravarDocumentoEEndereco(tx: Sql, id: string, d: ContatoCadastro): Promise<void> {
  await gravarDocumento(tx, id, d)
  await gravarEndereco(tx, id, d)
}

/**
 * Telefone principal de uma edição. A linha do ERP não é reescrita: a antiga é
 * demovida e uma linha 'manual' (nova ou reativada) vira a principal. Linha
 * principal já manual é atualizada no lugar. Mesmo número e mesmo WhatsApp que o
 * ERP já mostra → nada a fazer.
 */
async function gravarTelefonePrincipal(tx: Sql, id: string, tel: { e164: string; chaveBloqueio: string }, whatsapp: boolean | undefined): Promise<void> {
  const linhas = await tx<{ seq: number; e164: string; chave_bloqueio: string; whatsapp: boolean | null; principal: boolean; fonte: string }[]>`
    SELECT seq, e164, chave_bloqueio, whatsapp, principal, fonte FROM contato_telefone
     WHERE tenant_id = tenant_atual() AND contato_id = ${id} ORDER BY seq`
  const atual = linhas.find((l) => l.principal)
  const whats = whatsapp ?? atual?.whatsapp ?? true
  const proximo = Math.max(0, ...linhas.map((l) => l.seq)) + 1

  if (atual && atual.fonte === 'manual') {
    await tx`
      UPDATE contato_telefone SET e164 = ${tel.e164}, chave_bloqueio = ${tel.chaveBloqueio}, whatsapp = ${whats}, visto_em = now()
       WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${atual.seq}`
    return
  }
  if (atual && atual.e164 === tel.e164 && (atual.whatsapp ?? true) === whats) return

  if (atual) {
    await tx`UPDATE contato_telefone SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${atual.seq}`
  }
  const reativar = linhas.find((l) => l.fonte === 'manual' && l.e164 === tel.e164)
  if (reativar) {
    await tx`UPDATE contato_telefone SET principal = true, whatsapp = ${whats}, visto_em = now()
              WHERE tenant_id = tenant_atual() AND contato_id = ${id} AND seq = ${reativar.seq}`
  } else {
    await tx`
      INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
      VALUES (tenant_atual(), ${id}, ${proximo}, ${tel.e164}, ${tel.chaveBloqueio}, true, ${whats}, 'manual')`
  }
}

/** Violação de unicidade do telefone principal (corrida entre dois cadastros do mesmo número). */
const ehTelefonePrincipalDuplicado = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505' &&
  (err as { constraint_name?: string }).constraint_name === 'contato_telefone_principal_unico'

const respostaTelefoneDuplicado = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
  reply.code(422).send({ erro: 'validacao', mensagem: 'Corrija os campos destacados.',
    campos: { telefone: 'Este telefone já é o principal de outro contato.' } })

/**
 * Origem informada tem de existir, ser do tenant (RLS) e estar ativa — ou ser a
 * que o contato já tem gravada (mesmo desativada, para não travar a edição).
 */
async function origemValida(tx: Sql, origemId: string, atualDoContato: string | null): Promise<boolean> {
  if (origemId === atualDoContato) return true
  const [o] = await tx`SELECT 1 FROM origem WHERE tenant_id = tenant_atual() AND id = ${origemId} AND ativa`
  return !!o
}

const respostaOrigemInvalida = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
  reply.code(422).send({ erro: 'validacao', mensagem: 'Corrija os campos destacados.',
    campos: { origemId: 'Origem inexistente ou inativa.' } })

export async function rotasContatos(app: FastifyInstance): Promise<void> {
  /**
   * Cadastra um contato. Corpo completo (`contato-cadastro.ts`) com só nome +
   * telefone obrigatórios — o POST antigo (nome+telefone) segue valendo.
   * ⚠️ Idempotente pelo telefone: se já existe um contato com esse número
   * principal, DEVOLVE o existente (200, `novo:false`) em vez de duplicar —
   * telefone é identidade no WhatsApp. Erro de validação: 422 por campo.
   */
  app.post<{ Body: unknown }>(
    '/v1/contatos',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const v = validarCadastro(req.body)
      if (!v.ok) return reply.code(422).send({ erro: 'validacao', mensagem: 'Corrija os campos destacados.', campos: v.campos })
      const d = v.dados
      const tel = normalizarTelefone(d.telefone)!

      let r: { id: string; novo: boolean } | { erro: 'origem' }
      try {
        r = await req.comTenant(async (tx) => {
        const [existe] = await tx<{ contato_id: string }[]>`
          SELECT contato_id FROM contato_telefone
           WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio} AND principal
           LIMIT 1`
        if (existe) return { id: existe.contato_id, novo: false }
        if (d.origemId && !(await origemValida(tx, d.origemId, null))) return { erro: 'origem' as const }

        const id = randomUUID()
        await tx`
          INSERT INTO contato (tenant_id, id, nome, razao_social, nome_fantasia, email, modalidade, prioridade, temperatura,
                               origem_id, valor_estimado_centavos, observacoes, origem_carga, ativo)
          VALUES (tenant_atual(), ${id}, ${d.nome}, ${d.razaoSocial ?? null}, ${d.nomeFantasia ?? null}, ${d.email ?? null},
                  ${d.modalidade ?? null}, ${d.prioridade ?? null}, ${d.temperatura ?? null}, ${d.origemId ?? null},
                  ${d.valorEstimadoCentavos ?? null}, ${d.observacoes ?? null}, 'manual', true)`
        await tx`
          INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
          VALUES (tenant_atual(), ${id}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, ${d.whatsapp ?? true}, 'manual')`
        await gravarDocumentoEEndereco(tx, id, d)
        return { id, novo: true }
        })
      } catch (err) {
        if (ehTelefonePrincipalDuplicado(err)) return respostaTelefoneDuplicado(reply)
        throw err
      }
      if ('erro' in r) return respostaOrigemInvalida(reply)

      return reply.code(r.novo ? 201 : 200).send({ id: r.id, nome: d.nome, novo: r.novo })
    },
  )

  /**
   * Edição COMPLETA do cadastro (formulário-página). Substitui os campos
   * editáveis: opcional omitido/vazio vira NULL — EXCETO `origemId`, em que omitido
   * preserva e só `null`/'' limpa (o formulário sempre envia tudo; um cliente de
   * API que não conhece a origem não a apaga por esquecimento). Telefone principal trocado
   * vira o novo principal; se já é principal de OUTRO contato → 422 no campo.
   * Telefone/documento/endereço do ERP não são reescritos: a edição manual vira
   * a principal e a do ERP é só demovida (ver `gravarDocumento`).
   */
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/v1/contatos/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const id = req.params.id
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ erro: 'contato.id_invalido', mensagem: 'Id de contato inválido.' })
      const v = validarCadastro(req.body)
      if (!v.ok) return reply.code(422).send({ erro: 'validacao', mensagem: 'Corrija os campos destacados.', campos: v.campos })
      const d = v.dados
      const tel = normalizarTelefone(d.telefone)!

      let r: { ok: true } | { erro: 'contato.nao_encontrado' | 'telefone_duplicado' | 'origem' }
      try {
        r = await req.comTenant(async (tx) => {
        const [c] = await tx<{ origem_id: string | null }[]>`SELECT origem_id FROM contato WHERE tenant_id = tenant_atual() AND id = ${id}`
        if (!c) return { erro: 'contato.nao_encontrado' as const }

        const [outro] = await tx`
          SELECT 1 FROM contato_telefone
           WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio} AND principal AND contato_id <> ${id} LIMIT 1`
        if (outro) return { erro: 'telefone_duplicado' as const }

        // Ausente ≠ null: omitir `origemId` preserva; `null`/'' limpa.
        const origemFinal = d.origemId === undefined ? c.origem_id : d.origemId
        if (origemFinal && !(await origemValida(tx, origemFinal, c.origem_id))) return { erro: 'origem' as const }

        await tx`
          UPDATE contato SET
            nome = ${d.nome}, razao_social = ${d.razaoSocial ?? null}, nome_fantasia = ${d.nomeFantasia ?? null},
            email = ${d.email ?? null}, modalidade = ${d.modalidade ?? null}, prioridade = ${d.prioridade ?? null},
            temperatura = ${d.temperatura ?? null}, origem_id = ${origemFinal},
            valor_estimado_centavos = ${d.valorEstimadoCentavos ?? null}, observacoes = ${d.observacoes ?? null}
           WHERE tenant_id = tenant_atual() AND id = ${id}`

        await gravarTelefonePrincipal(tx, id, tel, d.whatsapp)
        await gravarDocumentoEEndereco(tx, id, d)
        return { ok: true as const }
        })
      } catch (err) {
        if (ehTelefonePrincipalDuplicado(err)) return respostaTelefoneDuplicado(reply)
        throw err
      }
      if ('erro' in r) {
        if (r.erro === 'telefone_duplicado') return respostaTelefoneDuplicado(reply)
        if (r.erro === 'origem') return respostaOrigemInvalida(reply)
        return reply.code(404).send({ erro: 'contato.nao_encontrado', mensagem: 'Contato não encontrado.' })
      }
      return reply.send({ ok: true, id })
    },
  )

  /**
   * Importação de contatos por CSV (EP-02). ⚠️ Validação NO SERVIDOR pelo parser
   * puro. Falha de linha é RETORNO tipificado — a tela mostra quantas entraram e
   * quais linhas caíram e por quê.
   *
   * ⚠️ DEDUP: documento primeiro, telefone só quando não há documento.
   *
   * Era só por telefone, e numa carga B2B isso perde empresa. Medido numa
   * importação real de 709 confecções: 47 telefones eram compartilhados e **67
   * empresas não entraram**. Parte era acerto (a mesma empresa com dois CNPJs),
   * parte era perda — cinco razões sociais distintas dividindo o telefone do
   * grupo, e só a primeira entrava. Para pessoa jurídica a identidade é o CNPJ;
   * o telefone é do escritório, do contador, da recepção.
   *
   * Quem importa sem documento (varejo, lista de telefone) continua exatamente
   * como antes — o telefone segue sendo a chave de reconciliação (INV-50).
   */
  app.post<{ Body: { csv?: string } }>(
    '/v1/contatos/importar',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const csv = req.body?.csv
      if (typeof csv !== 'string' || !csv.trim()) {
        return reply.code(422).send({ erro: 'csv.vazio', mensagem: 'Envie o conteúdo do CSV.' })
      }
      const { linhas, rejeicoes } = parseCsvContatos(csv)
      if (linhas.length > MAX_LINHAS_CSV) {
        return reply.code(422).send({ erro: 'csv.grande_demais', mensagem: `Máximo ${MAX_LINHAS_CSV} linhas por importação.` })
      }

      let criados = 0
      let atualizados = 0
      await req.comTenant(async (tx) => {
        for (const l of linhas) {
          let contatoId: string | null = null

          if (l.documento) {
            // Tem documento: ele MANDA. Mesmo CNPJ = mesma empresa, ainda que o
            // telefone seja outro (mudou de linha, é o celular do dono).
            const [existe] = await tx<{ contato_id: string }[]>`
              SELECT contato_id FROM contato_documento
               WHERE tenant_id = tenant_atual() AND numero = ${l.documento} LIMIT 1`
            if (existe) { contatoId = existe.contato_id; atualizados++ }
          } else if (l.chaveBloqueio) {
            // Sem documento: o telefone volta a ser a chave (INV-50).
            const [existe] = await tx<{ contato_id: string }[]>`
              SELECT contato_id FROM contato_telefone
               WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${l.chaveBloqueio} AND principal LIMIT 1`
            if (existe) { contatoId = existe.contato_id; atualizados++ }
          }

          if (!contatoId) {
            contatoId = randomUUID()
            criados++
            await tx`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
                     VALUES (tenant_atual(), ${contatoId}, ${l.nome}, 'importacao', true)`
          }

          // ⚠️ `principal` só na PRIMEIRA linha de telefone do contato: há índice
          //    único parcial sobre o principal, e duas empresas do mesmo grupo
          //    dividindo o número agora convivem como contatos distintos.
          //    `seq` calculado, nunca fixo em 1 — fixo descartava em silêncio o
          //    segundo telefone de quem já existia.
          if (l.e164 && l.chaveBloqueio) {
            await tx`
              INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
              SELECT tenant_atual(), ${contatoId},
                     coalesce(max(seq), 0) + 1, ${l.e164}, ${l.chaveBloqueio},
                     count(*) = 0, NULL, 'importacao'
                FROM contato_telefone
               WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}
              ON CONFLICT DO NOTHING`
          }
          if (l.documento && l.tipoDocumento) {
            await tx`
              INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fonte)
              SELECT tenant_atual(), ${contatoId}, coalesce(max(seq), 0) + 1,
                     ${l.tipoDocumento}, ${l.documento}, 'importacao'
                FROM contato_documento
               WHERE tenant_id = tenant_atual() AND contato_id = ${contatoId}
              ON CONFLICT DO NOTHING`
          }
        }
      })

      return reply.send({
        total: linhas.length + rejeicoes.length,
        criados, atualizados,
        rejeitados: rejeicoes.length,
        rejeicoes: rejeicoes.slice(0, 50),
      })
    },
  )

  /**
   * Busca de contato por nome OU telefone — varre `contato` DIRETO (não as
   * métricas), então acha também contato manual sem histórico de venda.
   */
  app.get('/v1/contatos/busca', { preHandler: exigirTenant }, async (req, reply) => {
    const q = String((req.query as { q?: string })?.q ?? '').trim()
    if (q.length < 2) return reply.send({ itens: [] })
    const digitos = q.replace(/\D/g, '')
    const linhas = await req.comTenant((tx) => tx<{ id: string; nome: string; e164: string | null }[]>`
      SELECT c.id, c.nome, ct.e164
        FROM contato c
        LEFT JOIN contato_telefone ct
          ON ct.tenant_id = c.tenant_id AND ct.contato_id = c.id AND ct.principal
       WHERE c.tenant_id = tenant_atual() AND c.ativo
         -- ⚠️ O contato de simulação do playground não é cliente: fica fora de toda lista.
         AND coalesce(c.origem_carga, '') <> 'simulacao'
         AND ( c.nome ILIKE ${'%' + q + '%'}
               ${digitos.length >= 4 ? tx`OR ct.e164 LIKE ${'%' + digitos + '%'}` : tx``} )
       ORDER BY c.nome ASC
       LIMIT 20
    `)
    return reply.send({ itens: linhas.map((l) => ({ id: l.id, nome: l.nome, telefone: l.e164 })) })
  })

  // ---------------------------------------------------------------------------
  // Contatos, ordenados por valor de compra.
  // ---------------------------------------------------------------------------
  /**
   * ⚠️ LEFT JOIN em `metricas_contato`, não INNER. Só há linha de métrica para
   * quem já comprou, então o INNER JOIN escondia todo contato SEM venda — e a
   * tela dizia "Nenhum cliente ainda. Conecte seu ERP e faça a primeira carga"
   * com a base cheia.
   *
   * Apareceu com a carga de prospecção da Drezz Fábrica: 709 confecções
   * importadas, a busca as encontrava, o kanban de leads contava as 709, e esta
   * tela — a que se chama "Contatos" no menu — mostrava vazio. Quem prospecta
   * começa por definição sem nenhuma venda; era o caso que mais precisava da
   * lista e o único que não a via.
   *
   * Quem nunca comprou entra com zeros e vai para o fim da ordenação, que
   * continua sendo por valor.
   */
  app.get('/v1/contatos', { preHandler: exigirTenant }, async (req, reply) => {
    const q = (req.query ?? {}) as { cursor?: string; limite?: string }
    const limite = limiteDe(q.limite)
    const c = lerCursor(q.cursor)

    const linhas = await req.comTenant((tx) => tx<LinhaMetrica[]>`
      SELECT c.id, c.nome,
             coalesce(m.qtd_vendas, 0)::text     AS qtd_vendas,
             coalesce(m.total_centavos, 0)::text AS total_centavos,
             m.dias_sem_comprar, m.atraso_relativo::text,
             m.media_entre_vendas_dias::text, m.ultima_venda_em,
             coalesce(m.confiavel, false) AS confiavel,
             m.ticket_medio_centavos::text
        FROM contato c
        LEFT JOIN metricas_contato m
          ON m.tenant_id = c.tenant_id AND m.contato_id = c.id
       WHERE c.tenant_id = tenant_atual() AND c.ativo
         AND coalesce(c.origem_carga, '') <> 'simulacao'
         AND ${c === null ? tx`true`
              : tx`(coalesce(m.total_centavos, 0), c.id) < (${Number(c[0])}, ${c[1]}::uuid)`}
       ORDER BY coalesce(m.total_centavos, 0) DESC, c.id DESC
       LIMIT ${limite + 1}
    `)

    const temMais = linhas.length > limite
    const pagina = temMais ? linhas.slice(0, limite) : linhas
    const ultimo = pagina[pagina.length - 1]
    return reply.send({
      itens: pagina.map(paraItem),
      proximoCursor: temMais && ultimo ? escreverCursor(ultimo.total_centavos, ultimo.id) : null,
    })
  })

  // ---------------------------------------------------------------------------
  // Ficha do Contato — o cliente 360°.
  //
  // ⚠️ Uma leitura por bloco, na MESMA transação (mesmo tenant, RLS). Cada bloco
  //    tem seu estado: métricas ausentes = cliente sem venda; itens ausentes =
  //    detalhe de venda ainda não importado. A tela mostra isso, não finge.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const id = req.params.id
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return reply.code(400).send({ erro: 'contato.id_invalido', mensagem: 'Id de contato inválido.' })
      }

      const dados = await req.comTenant(async (tx) => {
        const [contato] = await tx<{
          id: string; nome: string; modalidade: string | null; qualificado: boolean; descarte_motivo: string | null
          recebe_campanhas: boolean; recebe_automacoes: boolean; criado_em: Date; perfil_preco: string | null
          razao_social: string | null; nome_fantasia: string | null; email: string | null; prioridade: string | null
          temperatura: string | null; origem_id: string | null; valor_estimado_centavos: string | null; observacoes: string | null
        }[]>`
          SELECT id, nome, modalidade, qualificado, descarte_motivo, recebe_campanhas, recebe_automacoes, criado_em, perfil_preco,
                 razao_social, nome_fantasia, email, prioridade, temperatura, origem_id,
                 valor_estimado_centavos::text, observacoes
            FROM contato WHERE id = ${id}
        `
        if (!contato) return null

        const [metrica] = await tx<LinhaMetrica[]>`
          SELECT c.id, c.nome, m.qtd_vendas::text, m.total_centavos::text,
                 m.dias_sem_comprar, m.atraso_relativo::text,
                 m.media_entre_vendas_dias::text, m.ultima_venda_em,
                 m.confiavel, m.ticket_medio_centavos::text
            FROM metricas_contato m JOIN contato c ON c.id = m.contato_id
           WHERE c.id = ${id}
        `

        const telefones = await tx<{ seq: number; e164: string; principal: boolean; whatsapp: boolean }[]>`
          SELECT seq, e164, principal, whatsapp FROM contato_telefone
           WHERE contato_id = ${id} ORDER BY principal DESC, seq`
        // ⚠️ DISTINCT + limite: a dedup por telefone pode ter fundido muitos
        //    cadastros do ERP num contato (na demo, 566 CNPJs no mesmo telefone).
        //    A ficha mostra alguns e a contagem total — o excesso é sinal de
        //    over-merge, não some escondido.
        const documentos = await tx<{ seq: number; tipo: string; numero: string; fiscal: boolean }[]>`
          SELECT seq, tipo, numero, fiscal FROM contato_documento
           WHERE contato_id = ${id} ORDER BY numero LIMIT 6`
        const [{ n: totalDocumentos } = { n: 0 }] = await tx<{ n: number }[]>`
          SELECT count(DISTINCT numero)::int AS n FROM contato_documento WHERE contato_id = ${id}`
        const [endereco] = await tx<{
          logradouro: string | null; numero: string | null; complemento: string | null; bairro: string | null
          cidade: string | null; uf: string | null; cep: string | null
        }[]>`
          SELECT logradouro, numero, complemento, bairro, cidade, uf, cep FROM contato_endereco
           WHERE contato_id = ${id} ORDER BY principal DESC, seq LIMIT 1`

        const ultimasVendas = await tx<{ id: string; ocorrida_em: Date; valor_centavos: string; cancelada: boolean }[]>`
          SELECT id, ocorrida_em, valor_centavos::text,
                 (cancelada_em IS NOT NULL) AS cancelada
            FROM venda WHERE contato_id = ${id}
           ORDER BY ocorrida_em DESC LIMIT 10`

        // ⚠️ Categorias dependem de item_venda, que só existe quando o detalhe
        //    da venda foi importado. Vazio aqui é honesto — não é bug.
        const categorias = await tx<{ categoria: string | null; total: string; qtd: string }[]>`
          SELECT p.categoria,
                 sum(iv.quantidade * iv.valor_unitario_centavos)::text AS total,
                 sum(iv.quantidade)::text AS qtd
            FROM item_venda iv
            JOIN venda v ON v.tenant_id = iv.tenant_id AND v.id = iv.venda_id
            LEFT JOIN sku s ON s.tenant_id = iv.tenant_id AND s.id = iv.sku_id
            LEFT JOIN produto p ON p.tenant_id = s.tenant_id AND p.id = s.produto_id
           WHERE v.contato_id = ${id} AND v.cancelada_em IS NULL
           GROUP BY p.categoria ORDER BY total DESC LIMIT 8`

        const comentarios = await tx<{ id: string; texto: string; criado_em: Date }[]>`
          SELECT id, texto, criado_em FROM comentario
           WHERE contato_id = ${id} ORDER BY criado_em DESC LIMIT 20`

        return { contato, metrica, telefones, documentos, totalDocumentos, endereco, ultimasVendas, categorias, comentarios }
      })

      if (!dados) return reply.code(404).send({ erro: 'contato.nao_encontrado', mensagem: 'Contato não encontrado.' })

      const m = dados.metrica
      return reply.send({
        id: dados.contato.id,
        nome: dados.contato.nome,
        modalidade: dados.contato.modalidade,
        razaoSocial: dados.contato.razao_social,
        nomeFantasia: dados.contato.nome_fantasia,
        email: dados.contato.email,
        prioridade: dados.contato.prioridade,
        temperatura: dados.contato.temperatura,
        origemId: dados.contato.origem_id,
        valorEstimadoCentavos: dados.contato.valor_estimado_centavos === null ? null : Number(dados.contato.valor_estimado_centavos),
        observacoes: dados.contato.observacoes,
        // Perfil de preço DECLARADO (ADR-025). null = cota pelo padrão (atacado).
        perfilPreco: dados.contato.perfil_preco,
        qualificado: dados.contato.qualificado,
        // Por que está Descartado: "sem_resposta" = descarte automático do fim da cadência (G5); null = manual.
        descarteMotivo: dados.contato.descarte_motivo,
        recebeCampanhas: dados.contato.recebe_campanhas,
        recebeAutomacoes: dados.contato.recebe_automacoes,
        telefones: dados.telefones,
        documentos: dados.documentos,
        totalDocumentos: dados.totalDocumentos,
        endereco: dados.endereco ?? null,
        // Métricas + segmento só quando há venda; senão null (cliente sem compra).
        metricas: m ? paraItem(m) : null,
        ultimasVendas: dados.ultimasVendas.map((v) => ({
          id: v.id, ocorridaEm: v.ocorrida_em, valorCentavos: Number(v.valor_centavos), cancelada: v.cancelada,
        })),
        categorias: dados.categorias.map((c) => ({
          categoria: c.categoria ?? 'Sem categoria',
          totalCentavos: Number(c.total), qtd: Number(c.qtd),
        })),
        comentarios: dados.comentarios,
      })
    },
  )

  // ───────── Edição da ficha do contato (CRUD dos satélites) ─────────

  /**
   * Edita nome, ativa/desativa (soft delete) e/ou o perfil de preço do contato.
   *
   * ⚠️ `perfilPreco` (ADR-025): 'varejo' | 'atacado' | null (volta ao padrão).
   *    É por ele que a montagem de pedido e o agente cotam — o corpo da
   *    requisição de item nunca carrega preço.
   */
  app.patch<{ Params: { id: string }; Body: { nome?: string; ativo?: boolean; perfilPreco?: string | null } }>(
    '/v1/contatos/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const nome = req.body?.nome?.trim()
      const ativo = req.body?.ativo
      const perfilPreco = req.body?.perfilPreco
      if (nome === undefined && ativo === undefined && perfilPreco === undefined) return reply.code(422).send({ erro: 'contato.nada_a_mudar' })
      if (nome !== undefined && !nome) return reply.code(422).send({ erro: 'contato.nome_obrigatorio', mensagem: 'Nome não pode ficar vazio.' })
      if (perfilPreco !== undefined && perfilPreco !== null && !ehPerfilPreco(perfilPreco)) {
        return reply.code(422).send({ erro: 'contato.perfil_preco_invalido', mensagem: 'Perfil de preço deve ser varejo ou atacado.' })
      }
      const [r] = await req.comTenant((tx) => tx`
        UPDATE contato SET
          nome  = ${nome ?? tx`nome`},
          ativo = ${ativo === undefined ? tx`ativo` : ativo},
          perfil_preco = ${perfilPreco === undefined ? tx`perfil_preco` : (perfilPreco === null ? null : perfilDeCotacao(perfilPreco))}
         WHERE tenant_id = tenant_atual() AND id = ${req.params.id} RETURNING id`)
      if (!r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /** Adiciona um telefone ao contato (idempotente por chave_bloqueio). */
  app.post<{ Params: { id: string }; Body: { telefone?: string; principal?: boolean } }>(
    '/v1/contatos/:id/telefones', { preHandler: exigirTenant },
    async (req, reply) => {
      const tel = normalizarTelefone(req.body?.telefone ?? '')
      if (!tel) return reply.code(422).send({ erro: 'telefone.invalido', mensagem: 'Telefone inválido.' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 404 as const }
        const [linhaProx] = await tx<{ prox: number }[]>`
          SELECT coalesce(max(seq), 0) + 1 AS prox FROM contato_telefone WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        const prox = linhaProx!.prox
        const principal = req.body?.principal === true || prox === 1 // 1º vira principal
        if (principal) await tx`UPDATE contato_telefone SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        await tx`
          INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
          VALUES (tenant_atual(), ${req.params.id}, ${prox}, ${tel.e164}, ${tel.chaveBloqueio}, ${principal}, true, 'manual')
          ON CONFLICT DO NOTHING`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.code(201).send({ ok: true })
    },
  )

  /** Define qual telefone é o principal. */
  app.post<{ Params: { id: string; seq: string } }>(
    '/v1/contatos/:id/telefones/:seq/principal', { preHandler: exigirTenant },
    async (req, reply) => {
      await req.comTenant(async (tx) => {
        await tx`UPDATE contato_telefone SET principal = false WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        await tx`UPDATE contato_telefone SET principal = true WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id} AND seq = ${Number(req.params.seq)}`
      })
      return reply.send({ ok: true })
    },
  )

  /** Remove um telefone. */
  app.delete<{ Params: { id: string; seq: string } }>(
    '/v1/contatos/:id/telefones/:seq', { preHandler: exigirTenant },
    async (req, reply) => {
      await req.comTenant((tx) => tx`
        DELETE FROM contato_telefone WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id} AND seq = ${Number(req.params.seq)}`)
      return reply.send({ ok: true })
    },
  )

  /** Adiciona um documento (CNPJ/CPF) validando o dígito. */
  app.post<{ Params: { id: string }; Body: { tipo?: 'cnpj' | 'cpf'; numero?: string } }>(
    '/v1/contatos/:id/documentos', { preHandler: exigirTenant },
    async (req, reply) => {
      const tipo = req.body?.tipo
      if (tipo !== 'cnpj' && tipo !== 'cpf') return reply.code(422).send({ erro: 'documento.tipo_invalido' })
      const numero = normalizarDocumento(tipo, req.body?.numero ?? '')
      if (!numero) return reply.code(422).send({ erro: 'documento.invalido', mensagem: `${tipo.toUpperCase()} inválido (dígito verificador).` })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 404 as const }
        const [linhaProx] = await tx<{ prox: number }[]>`
          SELECT coalesce(max(seq), 0) + 1 AS prox FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}`
        const prox = linhaProx!.prox
        await tx`INSERT INTO contato_documento (tenant_id, contato_id, seq, tipo, numero, fonte)
                 VALUES (tenant_atual(), ${req.params.id}, ${prox}, ${tipo}, ${numero}, 'manual')`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.code(201).send({ ok: true, numero })
    },
  )

  /** Remove um documento. */
  app.delete<{ Params: { id: string; seq: string } }>(
    '/v1/contatos/:id/documentos/:seq', { preHandler: exigirTenant },
    async (req, reply) => {
      await req.comTenant((tx) => tx`
        DELETE FROM contato_documento WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id} AND seq = ${Number(req.params.seq)}`)
      return reply.send({ ok: true })
    },
  )

  /** Define/atualiza o endereço principal (um por contato, seq 1). */
  app.put<{ Params: { id: string }; Body: Record<string, string | undefined> }>(
    '/v1/contatos/:id/endereco', { preHandler: exigirTenant },
    async (req, reply) => {
      const b = req.body ?? {}
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 404 as const }
        await tx`
          INSERT INTO contato_endereco (tenant_id, contato_id, seq, logradouro, numero, complemento, bairro, cidade, uf, cep, principal, fonte)
          VALUES (tenant_atual(), ${req.params.id}, 1, ${b['logradouro'] ?? null}, ${b['numero'] ?? null}, ${b['complemento'] ?? null},
                  ${b['bairro'] ?? null}, ${b['cidade'] ?? null}, ${b['uf'] ?? null}, ${b['cep'] ?? null}, true, 'manual')
          ON CONFLICT (tenant_id, contato_id, seq) DO UPDATE SET
            logradouro = EXCLUDED.logradouro, numero = EXCLUDED.numero, complemento = EXCLUDED.complemento,
            bairro = EXCLUDED.bairro, cidade = EXCLUDED.cidade, uf = EXCLUDED.uf, cep = EXCLUDED.cep`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.send({ ok: true })
    },
  )

  /** Comentários/notas do contato — histórico simples. */
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id/comentarios', { preHandler: exigirTenant },
    async (req, reply) => {
      const linhas = await req.comTenant((tx) => tx<{ id: string; texto: string; autor: string | null; criado_em: Date }[]>`
        SELECT c.id, c.texto, u.nome AS autor, c.criado_em
          FROM comentario c LEFT JOIN usuario u ON u.tenant_id = c.tenant_id AND u.id = c.autor_id
         WHERE c.tenant_id = tenant_atual() AND c.contato_id = ${req.params.id}
         ORDER BY c.criado_em DESC LIMIT 50`)
      return reply.send({ itens: linhas.map((l) => ({ id: l.id, texto: l.texto, autor: l.autor, criadoEm: l.criado_em })) })
    },
  )

  /** Trajetória do segmento RFV (transições ao longo do tempo). Skill funil-de-vendas. */
  app.get<{ Params: { id: string } }>(
    '/v1/contatos/:id/segmento/historico', { preHandler: exigirTenant },
    async (req, reply) => {
      const linhas = await req.comTenant((tx) => tx<{ segmento: string; capturado_em: Date }[]>`
        SELECT segmento, capturado_em
          FROM contato_segmento_historico
         WHERE tenant_id = tenant_atual() AND contato_id = ${req.params.id}
         ORDER BY capturado_em DESC LIMIT 50`)
      return reply.send({ itens: linhas.map((l) => ({ segmento: l.segmento, capturadoEm: l.capturado_em })) })
    },
  )

  app.post<{ Params: { id: string }; Body: { texto?: string } }>(
    '/v1/contatos/:id/comentarios', { preHandler: exigirTenant },
    async (req, reply) => {
      const texto = req.body?.texto?.trim()
      if (!texto) return reply.code(422).send({ erro: 'comentario.vazio', mensagem: 'Escreva algo.' })
      const r = await req.comTenant(async (tx) => {
        const [c] = await tx`SELECT 1 FROM contato WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        if (!c) return { erro: 404 as const }
        const autorId = await garantirUsuarioId(tx, req)
        await tx`INSERT INTO comentario (tenant_id, id, contato_id, autor_id, texto)
                 VALUES (tenant_atual(), ${randomUUID()}, ${req.params.id}, ${autorId}, ${texto})`
        return { ok: true }
      })
      if ('erro' in r) return reply.code(404).send({ erro: 'contato.nao_encontrado' })
      return reply.code(201).send({ ok: true })
    },
  )

  // ---------------------------------------------------------------------------
  // Fila do Dia: quem está saindo do ritmo — o coração explicável (RFV-10).
  //
  // ⚠️ A ordenação é por URGÊNCIA, não por valor: um fiel em dia não precisa de
  //    ação hoje; quem passou do próprio ritmo, sim. A urgência = atraso ao
  //    ritmo dele; para quem tem 1 compra (sem ritmo), aproxima por recência.
  // ---------------------------------------------------------------------------
  app.get('/v1/fila-do-dia', { preHandler: exigirTenant }, async (req, reply) => {
    const q = (req.query ?? {}) as { cursor?: string; limite?: string }
    const limite = limiteDe(q.limite)
    const c = lerCursor(q.cursor)

    const linhas = await req.comTenant((tx) => tx<(LinhaMetrica & { urgencia: string })[]>`
      WITH fila AS (
        SELECT c.id, c.nome, m.qtd_vendas::text, m.total_centavos::text,
               m.dias_sem_comprar, m.atraso_relativo::text,
               m.media_entre_vendas_dias::text, m.ultima_venda_em,
               m.confiavel, m.ticket_medio_centavos::text,
               -- ⚠️ Score sempre presente: sem ritmo (atraso NULL) aproxima por
               --    recência (dias/30), para o cliente de 1 compra antiga também
               --    entrar na fila em vez de sumir por não ter média.
               coalesce(m.atraso_relativo, m.dias_sem_comprar::numeric / 30) AS urgencia
          FROM metricas_contato m JOIN contato c ON c.id = m.contato_id
      )
      SELECT * FROM fila
       -- Só quem precisa de ação: quem está dentro do ritmo (<= 0.9) fica fora.
       WHERE urgencia > 0.9
         AND ${c === null ? tx`true` : tx`(urgencia, id) < (${Number(c[0])}, ${c[1]}::uuid)`}
       ORDER BY urgencia DESC, id DESC
       LIMIT ${limite + 1}
    `)

    const temMais = linhas.length > limite
    const pagina = temMais ? linhas.slice(0, limite) : linhas
    const ultimo = pagina[pagina.length - 1]
    return reply.send({
      itens: pagina.map(paraItem),
      proximoCursor: temMais && ultimo ? escreverCursor(ultimo.urgencia, ultimo.id) : null,
    })
  })
}
