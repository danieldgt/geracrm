import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { validarCredencial, type Credencial } from '@geracrm/conectores'
import { exigirTenant } from '../../plugins/tenant.js'
import { cifrar, decifrar, resumir } from '../integracao/cofre.js'
import { registrarMetrica } from '../plataforma/metricas.js'
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
      const linhas = await tx<{
        id: string; tipo: string; provedor: string | null; nome_amigavel: string; estado: string
        credenciais_cifradas: Buffer | null; ultimo_erro: string | null
      }[]>`
        SELECT id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas, ultimo_erro
          FROM canal_conectado ORDER BY criado_em
      `
      return {
        itens: linhas.map((l) => ({
          id: l.id, tipo: l.tipo, provedor: l.provedor, nomeAmigavel: l.nome_amigavel,
          estado: l.estado, ultimoErro: l.ultimo_erro,
          // ⚠️ ADR-021: o não-oficial automatiza um WhatsApp Web e carrega risco
          //    de BANIMENTO — a interface deixa isso VISÍVEL, por caminho.
          riscoBanimento: l.tipo === 'whatsapp_nao_oficial',
          credencial: resumir(l.credenciais_cifradas),
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
   * Testa o canal — status da instância / conexão, via adaptador.
   *
   * ⚠️ Como no ERP: 200 mesmo quando o canal está fora, com o resultado no
   * corpo. Não-oficial "desconectado" é o caso comum (celular desligado).
   */
  app.post<{ Params: { id: string } }>(
    '/v1/canais/:id/testar',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const canalDb = await req.comTenant(async (tx) => {
        const [l] = await tx<{ provedor: string | null; credenciais_cifradas: Buffer | null }[]>`
          SELECT provedor, credenciais_cifradas FROM canal_conectado WHERE id = ${req.params.id}`
        return l ?? null
      })
      if (!canalDb) return falha(reply, 404, 'canal.nao_encontrado', 'Canal não encontrado.')
      if (!canalDb.credenciais_cifradas || !canalDb.provedor) {
        return falha(reply, 422, 'canal.credencial_ausente', 'Preencha as credenciais antes de testar.')
      }

      let resultado: { conectado: boolean; detalhe?: string }
      // ⚠️ Latência do conector (Onda 2): mede a ida ao fornecedor FORA da
      //    transação (é rede) e grava soma+contagem depois, no mesmo commit do
      //    estado. Média = soma/n via latenciaMedia.
      const inicio = Date.now()
      try {
        const canal = criarCanal(canalDb.provedor, decifrar(canalDb.credenciais_cifradas))
        // Só o PlugZapi (e futuros não-oficiais) têm `status`; o oficial ainda não.
        resultado = 'status' in canal && typeof (canal as { status?: unknown }).status === 'function'
          ? await (canal as unknown as { status(): Promise<{ conectado: boolean; detalhe?: string }> }).status()
          : { conectado: false, detalhe: 'teste indisponível para este provedor' }
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
                 ultimo_erro = ${resultado.conectado ? null : (resultado.detalhe ?? null)}
           WHERE id = ${req.params.id}`
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
