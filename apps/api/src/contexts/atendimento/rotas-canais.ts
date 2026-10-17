import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { validarCredencial, type Credencial } from '@geracrm/conectores'
import { mascararIdentificador, mascararTelefone } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { exigirTenant, subDoUsuario } from '../../plugins/tenant.js'
import { cifrar, decifrar, resumir } from '../integracao/cofre.js'
import { auditar } from '../plataforma/auditoria.js'
import { atendePapel, exigirPapel, papeisDoUsuario, type Papel } from '../plataforma/papel.js'
import { registrarMetrica } from '../plataforma/metricas.js'
import { garantirUsuarioId } from './rotas-fila.js'
import { statusAquecimento } from './aquecimento.js'
import { CANAIS, provedorPorCodigo } from './canais/catalogo.js'
import { criarCanal } from './canais/fabrica.js'

/**
 * Cadastro de celular / canal (ADR-021, canal dual).
 *
 * ⚠️ Reaproveita tudo do padrão de ERP: catálogo declara os campos, o cofre
 * cifra a credencial (ENTRA e nunca SAI), o validador confere por campo. A
 * credencial de um WhatsApp real é tão sensível quanto a de um ERP.
 */

interface CorpoCanal {
  provedor?: string
  nomeAmigavel?: string
  credencial?: Record<string, unknown>
}

function falha(reply: FastifyReply, status: number, erro: string, mensagem: string, detalhe?: unknown) {
  return reply.code(status).send(detalhe === undefined ? { erro, mensagem } : { erro, mensagem, detalhe })
}

/**
 * Quem pode PAREAR um aparelho (gerar o QR): só admin.
 *
 * ⚠️ O QR conecta QUALQUER aparelho ao número — quem lê passa a receber e
 * enviar como a empresa. Gestor acompanha o estado; parear é do admin
 * (playbook AM §2.7). A regra de papel é a ÚNICA de `plataforma/papel.ts`.
 */
const PAPEIS_QUE_PAREIAM: readonly Papel[] = ['admin']

/**
 * ⚠️ `papeisDoUsuario` só reconhece quem tem linha em `usuario` — inclusive no
 * modo fundador (plano P10 §4). A linha nasce em `garantirUsuarioId`, que hoje
 * só o batimento de presença chama: sem garantir aqui, o primeiro acesso de um
 * fundador à tela de números recebia 403 no próprio QR. Staff não ganha linha
 * de usuário no tenant do cliente — `papeisDoUsuario` já o trata como admin.
 */
async function garantirLinhaDeUsuario(tx: Sql, req: FastifyRequest): Promise<void> {
  if (!req.atorStaff) await garantirUsuarioId(tx, req)
}

async function podeParearNoTenant(tx: Sql, req: FastifyRequest): Promise<boolean> {
  await garantirLinhaDeUsuario(tx, req)
  const acesso = await papeisDoUsuario(tx, { sub: subDoUsuario(req), atorStaff: req.atorStaff })
  return atendePapel(acesso, PAPEIS_QUE_PAREIAM)
}

/** preHandler: garante a linha de `usuario` antes do `exigirPapel` (ver acima). */
async function preGarantirUsuario(req: FastifyRequest): Promise<void> {
  if (!req.tenantId) return
  await req.comTenant((tx) => garantirLinhaDeUsuario(tx, req))
}

/**
 * Ativas suspensas do número — coluna da P11 (0101: `ativas_suspensas_em`,
 * `ativas_suspensas_motivo`). ⚠️ Lida pela linha inteira em jsonb, de forma
 * TOLERANTE: antes da 0101 a chave não existe e o resultado é `null`, sem
 * quebrar a listagem nem acoplar o deploy desta tela ao da migration.
 */
export function ativasSuspensasDe(linha: Record<string, unknown> | null | undefined):
  { desde: string; motivo: string | null } | null {
  const desde = linha?.['ativas_suspensas_em']
  if (typeof desde !== 'string' || desde === '') return null
  const motivo = linha?.['ativas_suspensas_motivo']
  return { desde: new Date(desde).toISOString(), motivo: typeof motivo === 'string' ? motivo : null }
}

export async function rotasCanais(app: FastifyInstance): Promise<void> {
  // O catálogo de provedores — a tela desenha o formulário daqui.
  app.get('/v1/canais/provedores', { preHandler: exigirTenant }, async () =>
    CANAIS.map((c) => ({
      codigo: c.codigo, nome: c.nome, tipo: c.tipo, oficial: c.oficial,
      descricao: c.descricao, esquemaCredencial: c.esquemaCredencial,
      capacidades: c.capacidades, aviso: c.aviso ?? null,
    })),
  )

  app.get('/v1/canais', { preHandler: exigirTenant }, async (req) =>
    req.comTenant(async (tx) => {
      // ⚠️ Decidido NO SERVIDOR, uma vez por requisição (papel muda durante a
      //    sessão). A tela só esconde o botão; a garantia é o 403 do QR.
      const podeParear = await podeParearNoTenant(tx, req)
      const linhas = await tx<{
        id: string; tipo: string; provedor: string | null; nome_amigavel: string; estado: string
        credenciais_cifradas: Buffer | null; ultimo_erro: string | null
        verificado_em: Date | null
        disparo_pausado: boolean; pausado_motivo: string | null
        modo_agente: string; telefone_e164: string | null; identificador_externo: string | null
        linha: Record<string, unknown>
      }[]>`
        SELECT c.id, c.tipo, c.provedor, c.nome_amigavel, c.estado, c.credenciais_cifradas,
               c.ultimo_erro, c.verificado_em,
               coalesce(cfg.disparo_pausado, false) AS disparo_pausado,
               cfg.pausado_motivo,
               coalesce(ac.modo, 'desligado') AS modo_agente,
               nw.telefone_e164, c.identificador_externo,
               -- ⚠️ Leitura tolerante das colunas da P11 (ver ativasSuspensasDe).
               jsonb_build_object(
                 'ativas_suspensas_em', to_jsonb(c.*)->>'ativas_suspensas_em',
                 'ativas_suspensas_motivo', to_jsonb(c.*)->>'ativas_suspensas_motivo') AS linha
          FROM canal_conectado c
          LEFT JOIN canal_configuracao cfg
                 ON cfg.tenant_id = c.tenant_id AND cfg.canal_id = c.id
          LEFT JOIN agente_config ac
                 ON ac.tenant_id = c.tenant_id AND ac.canal_id = c.id
          LEFT JOIN numero_whatsapp nw
                 ON nw.tenant_id = c.tenant_id AND nw.canal_id = c.id
         -- ⚠️ Arquivado saiu da frota (0083): não aparece na tela, não é
         --    vigiado e não recebe envio. O histórico dele continua no banco.
         WHERE c.arquivado_em IS NULL
         ORDER BY c.criado_em
      `
      return {
        // ⚠️ A frota é por tenant e pequena (dezenas de números): a lista é
        //    limitada pela própria natureza do recurso, não por página.
        podeParear,
        itens: linhas.map((l) => ({
          id: l.id, tipo: l.tipo, provedor: l.provedor, nomeAmigavel: l.nome_amigavel,
          estado: l.estado, ultimoErro: l.ultimo_erro,
          // ⚠️ O estado vai acompanhado de QUANDO foi observado (0069). Sem o
          //    carimbo, a tela não consegue distinguir "conectado agora" de
          //    "conectado da última vez que alguém olhou" — e foi assim que um
          //    número morto ficou passando por saudável.
          verificadoEm: l.verificado_em?.toISOString() ?? null,
          // ⚠️ A pausa aparece AQUI, na tela da frota, e não só na de config: uma
          //    pausa automática que ninguém vê repete o incidente que a originou
          //    — o produto sabendo de algo que o operador não sabe.
          disparoPausado: l.disparo_pausado, pausadoMotivo: l.pausado_motivo,
          // ⚠️ ADR-021: o não-oficial automatiza um WhatsApp Web e carrega risco
          //    de BANIMENTO — a interface deixa isso VISÍVEL, por caminho.
          riscoBanimento: l.tipo === 'whatsapp_nao_oficial',
          credencial: resumir(l.credenciais_cifradas),
          // ⚠️ Parear por QR só existe no não-oficial (sessão de WhatsApp Web);
          //    no oficial a conexão é gerida no Meta Business.
          podeParear: podeParear && l.tipo === 'whatsapp_nao_oficial',
          modoAgente: l.modo_agente,
          ativasSuspensas: ativasSuspensasDe(l.linha),
          // ⚠️ Mascarados AQUI: o valor completo não sai do servidor.
          telefoneMascarado: mascararTelefone(l.telefone_e164),
          identificadorMascarado: mascararIdentificador(l.identificador_externo),
        })),
      }
    }),
  )

  /**
   * Saúde da frota (EP-03) — o que exige olho AGORA: taxa de entrega recente e
   * alertas abertos. ⚠️ Tier/pagamento/qualidade são do canal OFICIAL (Meta) e
   * entram quando ele existir; aqui, o que dá para medir no não-oficial.
   */
  app.get('/v1/frota/saude', { preHandler: exigirTenant }, async (req) =>
    req.comTenant(async (tx) => {
      const [entrega] = await tx<{ ok: string; falha: string }[]>`
        SELECT
          coalesce(sum(valor) FILTER (WHERE metrica = 'envio_ok'), 0)::text    AS ok,
          coalesce(sum(valor) FILTER (WHERE metrica = 'envio_falha'), 0)::text AS falha
        FROM metrica_janela
        WHERE tenant_id = tenant_atual() AND metrica IN ('envio_ok', 'envio_falha')
          AND bucket >= date_trunc('hour', now()) - make_interval(hours => 24)`
      const ok = Number(entrega?.ok ?? 0)
      const falha = Number(entrega?.falha ?? 0)
      const total = ok + falha
      const [alertas] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM alerta WHERE tenant_id = tenant_atual() AND resolvido_em IS NULL`
      return {
        entrega: { ok, falha, taxa: total === 0 ? null : ok / total, amostras: total },
        alertasAbertos: alertas?.n ?? 0,
      }
    }),
  )

  app.post('/v1/canais', { preHandler: exigirTenant }, async (req, reply) => {
    const corpo = (req.body ?? {}) as CorpoCanal
    const provedor = corpo.provedor ? provedorPorCodigo(corpo.provedor) : undefined
    if (!provedor) {
      return falha(reply, 422, 'canal.provedor_desconhecido', 'Provedor de canal não reconhecido.')
    }
    if (!corpo.nomeAmigavel?.trim()) {
      return falha(reply, 422, 'canal.nome_obrigatorio', 'Dê um nome para este número.', { campo: 'nomeAmigavel' })
    }
    const validacao = validarCredencial(provedor.esquemaCredencial, corpo.credencial ?? {})
    if (!validacao.ok) {
      return falha(reply, 422, 'canal.credencial_invalida', 'Confira os campos destacados.', { campos: validacao.erros })
    }

    // ⚠️ Id de ROTEAMENTO do webhook (em claro), extraído da credencial: o
    //    phone_number_id do WhatsApp / a conta do Instagram. É por ele que o
    //    webhook da Meta acha o canal — a credencial cifrada não é pesquisável.
    const cred = (corpo.credencial ?? {}) as Record<string, unknown>
    const identificadorExterno = provedor.codigo === 'meta_oficial' ? (cred['phoneNumberId'] as string | undefined)
      : provedor.codigo === 'instagram_meta' ? (cred['paginaId'] as string | undefined) : undefined

    const id = randomUUID()
    try {
      await req.comTenant(async (tx) => {
        await tx`
          INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel,
                                       credenciais_cifradas, capacidades, estado, identificador_externo)
          VALUES (tenant_atual(), ${id}, ${provedor.tipo}, ${provedor.codigo}, ${corpo.nomeAmigavel!.trim()},
                  ${cifrar(corpo.credencial as Credencial)},
                  ${JSON.stringify(provedor.capacidades)}::text::jsonb,
                  -- ⚠️ Nasce 'conectando': conectado é o que o TESTE diz.
                  'conectando', ${identificadorExterno ?? null})
        `
      })
    } catch (e) {
      // Único global: outro canal já usa este phone_number_id / conta.
      if ((e as { code?: string }).code === '23505') {
        return falha(reply, 409, 'canal.numero_ja_conectado', 'Este número/conta já está conectado em outro canal.')
      }
      throw e
    }
    return reply.code(201).send({ id })
  })

  /**
   * EDITAR o número: nome e/ou credencial.
   *
   * ⚠️ Nasceu de um caso real: um PlugZapi cadastrado com a URL do endpoint no
   * campo do Client-Token ficava desconectado e não havia como corrigir — só o
   * cadastro existia. Credencial que ENTRA e nunca sai (§5.8) não pode
   * significar credencial que nunca muda.
   *
   * ⚠️ A credencial é MESCLADA com a atual: campo em branco mantém o que está
   * lá. Sem isso, trocar um token exigiria redigitar todos os outros — e quem
   * não tem os outros à mão acaba deixando o canal quebrado do jeito que está.
   *
   * ⚠️ O provedor NÃO muda aqui. Trocar de provedor é outro número: os campos
   * são outros, o webhook aponta para outro lugar e o histórico ficaria dizendo
   * que a conversa aconteceu por um caminho que nunca existiu.
   */
  app.put<{ Params: { id: string }; Body: CorpoCanal }>(
    '/v1/canais/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const corpo = (req.body ?? {}) as CorpoCanal
      const nome = corpo.nomeAmigavel?.trim()
      // Só os campos preenchidos entram na mescla — em branco é "mantém".
      const informados = Object.entries((corpo.credencial ?? {}) as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
      if (nome === undefined && informados.length === 0) {
        return falha(reply, 422, 'canal.nada_para_mudar', 'Mude o nome ou informe pelo menos um campo da credencial.')
      }
      if (nome !== undefined && nome === '') {
        return falha(reply, 422, 'canal.nome_obrigatorio', 'Dê um nome para este número.', { campo: 'nomeAmigavel' })
      }

      const atual = await req.comTenant(async (tx) => {
        const [l] = await tx<{ provedor: string | null; credenciais_cifradas: Buffer | null }[]>`
          SELECT provedor, credenciais_cifradas FROM canal_conectado
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND arquivado_em IS NULL`
        return l ?? null
      })
      if (!atual) return falha(reply, 404, 'canal.nao_encontrado', 'Canal não encontrado.')

      let cifrada: Buffer | null = null
      let identificadorExterno: string | undefined
      if (informados.length > 0) {
        const provedor = atual.provedor ? provedorPorCodigo(atual.provedor) : undefined
        if (!provedor) {
          return falha(reply, 422, 'canal.provedor_desconhecido', 'Provedor de canal não reconhecido.')
        }
        // ⚠️ Mescla sobre a credencial guardada; a validação roda sobre o
        //    RESULTADO, não sobre o que veio no corpo — é o resultado que passa
        //    a valer para o fornecedor.
        const anterior = atual.credenciais_cifradas ? decifrar(atual.credenciais_cifradas) : {}
        const mesclada = { ...anterior, ...Object.fromEntries(informados) } as Credencial
        const validacao = validarCredencial(provedor.esquemaCredencial, mesclada)
        if (!validacao.ok) {
          return falha(reply, 422, 'canal.credencial_invalida', 'Confira os campos destacados.', { campos: validacao.erros })
        }
        cifrada = cifrar(mesclada)
        const cred = mesclada as Record<string, string | undefined>
        identificadorExterno = provedor.codigo === 'meta_oficial' ? cred['phoneNumberId']
          : provedor.codigo === 'instagram_meta' ? cred['paginaId'] : undefined
      }

      try {
        await req.comTenant(async (tx) => {
          if (nome !== undefined) {
            await tx`
              UPDATE canal_conectado SET nome_amigavel = ${nome}
               WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          }
          if (cifrada) {
            // ⚠️ Credencial nova invalida o que sabíamos da conexão: volta para
            //    'conectando' e LIMPA o carimbo. Manter "conectado" com uma
            //    credencial que ninguém testou é a mentira confortável que o
            //    `verificado_em` (0069) existe para desfazer.
            await tx`
              UPDATE canal_conectado
                 SET credenciais_cifradas = ${cifrada},
                     estado = 'conectando', verificado_em = NULL, ultimo_erro = NULL,
                     identificador_externo = coalesce(${identificadorExterno ?? null}, identificador_externo)
               WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          }
          const atorId = await garantirUsuarioId(tx, req)
          // ⚠️ Auditoria SEM valor de credencial — só quais campos mudaram.
          await auditar(tx, {
            atorId, acao: 'canal.editado', entidade: 'canal_conectado', entidadeId: req.params.id,
            dados: { nomeAlterado: nome !== undefined, camposCredencial: informados.map(([k]) => k) },
          })
        })
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          return falha(reply, 409, 'canal.numero_ja_conectado', 'Este número/conta já está conectado em outro canal.')
        }
        throw e
      }
      return reply.send({ ok: true, credencialTrocada: cifrada !== null })
    },
  )

  /**
   * REMOVER o número da frota.
   *
   * ⚠️ Dois desfechos, e a diferença é o histórico: canal que nunca conversou é
   * APAGADO (as tabelas satélites caem por cascade); canal com conversa,
   * atendimento ou campanha é ARQUIVADO. As três FKs não têm `ON DELETE
   * CASCADE` de propósito — apagar um número não pode apagar a conversa que ele
   * atendeu, e o banco recusaria o DELETE de qualquer forma.
   *
   * A tela precisa saber qual dos dois aconteceu: "arquivado" com o histórico
   * preservado é uma promessa diferente de "removido".
   */
  app.delete<{ Params: { id: string } }>(
    '/v1/canais/:id', { preHandler: exigirTenant },
    async (req, reply) => {
      const r = await req.comTenant(async (tx) => {
        const [canal] = await tx<{ nome_amigavel: string }[]>`
          SELECT nome_amigavel FROM canal_conectado
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND arquivado_em IS NULL`
        if (!canal) return { estado: 'nao_encontrado' as const }

        const [uso] = await tx<{ conversas: number; atendimentos: number; campanhas: number }[]>`
          SELECT
            (SELECT count(*) FROM conversa
              WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id})::int    AS conversas,
            (SELECT count(*) FROM atendimento
              WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id})::int    AS atendimentos,
            (SELECT count(*) FROM campanha
              WHERE tenant_id = tenant_atual() AND canal_id = ${req.params.id})::int    AS campanhas`
        const conversas = uso?.conversas ?? 0
        const temHistorico = conversas > 0 || (uso?.atendimentos ?? 0) > 0 || (uso?.campanhas ?? 0) > 0

        const atorId = await garantirUsuarioId(tx, req)
        if (temHistorico) {
          await tx`
            UPDATE canal_conectado SET arquivado_em = now()
             WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
          await auditar(tx, {
            atorId, acao: 'canal.arquivado', entidade: 'canal_conectado', entidadeId: req.params.id,
            dados: { nome: canal.nome_amigavel, conversas },
          })
          return { estado: 'arquivado' as const, conversas }
        }
        await auditar(tx, {
          atorId, acao: 'canal.removido', entidade: 'canal_conectado', entidadeId: req.params.id,
          dados: { nome: canal.nome_amigavel },
        })
        await tx`DELETE FROM canal_conectado WHERE tenant_id = tenant_atual() AND id = ${req.params.id}`
        return { estado: 'removido' as const, conversas: 0 }
      })
      if (r.estado === 'nao_encontrado') return falha(reply, 404, 'canal.nao_encontrado', 'Canal não encontrado.')
      return reply.send({ ok: true, estado: r.estado, conversas: r.conversas })
    },
  )

  /**
   * Testa o canal — status da instância / conexão, via adaptador.
   *
   * ⚠️ Como no ERP: 200 mesmo quando o canal está fora, com o resultado no
   * corpo. Não-oficial "desconectado" é o caso comum (celular desligado).
   */
  /**
   * QR de reconexão.
   *
   * ⚠️ Nasceu do incidente de 24/ago: o número caiu e **não havia como
   * reconectar pelo produto** — só entrando no painel do fornecedor. Detectar
   * sem oferecer o conserto é meio caminho.
   *
   * ⚠️ Não guarda nada: o QR expira em segundos e muda a cada leitura.
   *
   * ⚠️ SÓ ADMIN (P10): o QR pareia qualquer aparelho ao número. Quem não é
   *    admin recebe 403 `acesso.papel_insuficiente` ANTES de qualquer leitura
   *    do canal — e a tela continua mostrando o estado, sem o QR.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/qrcode',
    { preHandler: [exigirTenant, preGarantirUsuario, exigirPapel(...PAPEIS_QUE_PAREIAM)] },
    async (req, reply) => {
      const canalDb = await req.comTenant(async (tx) => {
        const [l] = await tx<{ provedor: string | null; credenciais_cifradas: Buffer | null }[]>`
          SELECT provedor, credenciais_cifradas FROM canal_conectado
           WHERE tenant_id = tenant_atual() AND id = ${req.params.id} AND arquivado_em IS NULL`
        return l ?? null
      })
      if (!canalDb) return falha(reply, 404, 'canal.nao_encontrado', 'Canal não encontrado.')
      if (!canalDb.credenciais_cifradas || !canalDb.provedor) {
        return falha(reply, 422, 'canal.credencial_ausente', 'Preencha as credenciais antes de reconectar.')
      }

      const canal = criarCanal(canalDb.provedor, decifrar(canalDb.credenciais_cifradas))
      const r = await canal.qrCode()
      // ⚠️ 409, não 500: "já conectado" e "provedor sem QR" são respostas
      //    ESPERADAS, com motivo nomeado — falha de negócio é retorno tipificado.
      if (!r.ok) return reply.code(409).send({ erro: 'qr.indisponivel', mensagem: r.motivo })
      return reply.send({ imagem: r.imagemDataUrl })
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/canais/:id/testar',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const canalDb = await req.comTenant(async (tx) => {
        const [l] = await tx<{ provedor: string | null; credenciais_cifradas: Buffer | null }[]>`
          SELECT provedor, credenciais_cifradas FROM canal_conectado
           WHERE id = ${req.params.id} AND arquivado_em IS NULL`
        return l ?? null
      })
      if (!canalDb) return falha(reply, 404, 'canal.nao_encontrado', 'Canal não encontrado.')
      if (!canalDb.credenciais_cifradas || !canalDb.provedor) {
        return falha(reply, 422, 'canal.credencial_ausente', 'Preencha as credenciais antes de testar.')
      }

      let resultado: { conectado: boolean; detalhe?: string | undefined }
      // ⚠️ Latência do conector (Onda 2): mede a ida ao fornecedor FORA da
      //    transação (é rede) e grava soma+contagem depois, no mesmo commit do
      //    estado. Média = soma/n via latenciaMedia.
      const inicio = Date.now()
      try {
        const canal = criarCanal(canalDb.provedor, decifrar(canalDb.credenciais_cifradas))
        // ⚠️ `verificarConexao` entrou no CONTRATO da porta (24/ago). O duck
        //    typing que havia aqui (`'status' in canal`) só existia porque o
        //    contrato não cobria a pergunta — e checagem por sondagem de método
        //    é a que silenciosamente para de funcionar quando alguém renomeia.
        resultado = await canal.verificarConexao()
      } catch (e) {
        resultado = { conectado: false, detalhe: e instanceof Error ? e.message : 'falha ao testar' }
      }
      const latenciaMs = Date.now() - inicio

      await req.comTenant(async (tx) => {
        await registrarMetrica(tx, `lat_soma:${canalDb.provedor}:testar`, latenciaMs, new Date())
        await registrarMetrica(tx, `lat_n:${canalDb.provedor}:testar`, 1, new Date())
        await tx`
          UPDATE canal_conectado
             SET estado = ${resultado.conectado ? 'conectado' : 'desconectado'},
                 ultimo_erro = ${resultado.conectado ? null : (resultado.detalhe ?? null)},
                 -- ⚠️ Teste manual é observação como a do vigia: carimba igual.
                 --    Se só o vigia carimbasse, clicar em "Testar conexão" daria
                 --    uma resposta fresca na tela e um carimbo velho no banco.
                 verificado_em = now()
           WHERE id = ${req.params.id}`
        // ⚠️ Conectou pela tela? O alerta de canal caído fecha AQUI também.
        //    Enquanto só o vigia fechava — e só ao ver a transição — testar pela
        //    tela ressuscitava o número por fora e deixava o alerta crítico
        //    órfão: em produção (25/ago) a faixa vermelha de 24/ago seguia acesa
        //    com o canal de pé. `tenant_atual()` vem do token (ADR-001).
        if (resultado.conectado) {
          await tx`
            UPDATE alerta SET resolvido_em = now()
             WHERE tenant_id = tenant_atual() AND tipo = 'canal_desconectado'
               AND resolvido_em IS NULL`
        }
      })
      return reply.send(resultado)
    },
  )

  /** Status de aquecimento do número (dia, teto de hoje, uso, restante). */
  app.get<{ Params: { id: string } }>(
    '/v1/canais/:id/aquecimento', { preHandler: exigirTenant },
    async (req, reply) => {
      const s = await req.comTenant((tx) => statusAquecimento(tx, req.params.id, new Date()))
      return reply.send({
        emAquecimento: s.emAquecimento, dia: s.dia,
        limiteHoje: s.limiteHoje === Infinity ? null : s.limiteHoje,
        usadoHoje: s.usadoHoje, restante: s.restante === Infinity ? null : s.restante,
      })
    },
  )

  /** Inicia (ou reinicia) o aquecimento do número. */
  app.post<{ Params: { id: string } }>(
    '/v1/canais/:id/aquecimento', { preHandler: exigirTenant },
    async (req, reply) => {
      await req.comTenant((tx) => tx`
        INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em, ativo)
        VALUES (tenant_atual(), ${req.params.id}, now(), true)
        ON CONFLICT (tenant_id, canal_id) DO UPDATE SET iniciado_em = now(), ativo = true`)
      return reply.code(201).send({ ok: true })
    },
  )
}
