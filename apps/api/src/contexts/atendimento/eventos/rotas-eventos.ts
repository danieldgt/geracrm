import type { FastifyInstance, FastifyRequest } from 'fastify'
import { exigirTenant, subDoUsuario } from '../../../plugins/tenant.js'
import { comTenantServico } from '../../../db/index.js'
import { conversaNoEscopo, escopoDaRequisicao, escopoDoUsuario, type Escopo } from '../../plataforma/escopo.js'
import { resolverSessaoStaff } from '../../plataforma/staff-sessao.js'
import { assinar, type EventoCliente } from './barramento.js'

/**
 * SSE do tempo real (ADR-007). O cliente abre UMA conexão e recebe avisos
 * (sem conteúdo) de que algo mudou; então busca o dado pela API sob RLS.
 *
 * ⚠️ O tenant vem do token (exigirTenant), NUNCA de parâmetro. A conexão só
 * recebe eventos do próprio tenant — o filtro é no servidor, no `assinar`.
 *
 * ⚠️ ESCOPO (revisão de segurança D3, A4): dentro do tenant, evento que aponta
 *    uma CONVERSA (`conversaId`: conversa, atendimento, mensagem…) só chega a
 *    quem enxerga a conversa (`conversaNoEscopo`, a mesma régua da API). A
 *    decisão fica num cache curto POR CONEXÃO, zerado a cada revalidação
 *    (`REVALIDAR_MS`, 60 s) — papel retirado ou carteira transferida valem no
 *    minuto seguinte. O payload continua sem conteúdo. Eventos sem conversa
 *    (contato, pedido…) seguem como antes: só ids, resolvidos sob RLS + escopo.
 *    A entrega é SERIAL por conexão (uma fila de promessas): a checagem
 *    assíncrona não troca a ordem dos eventos.
 *
 * ⚠️ REVALIDAÇÃO DA CONEXÃO (a cada `REVALIDAR_MS`): o token não venceu (`exp`
 *    do token da conexão; sessão de staff: ainda resolve — nem expirada nem
 *    encerrada) e o usuário segue ATIVO no tenant. Senão a conexão é FECHADA —
 *    uma conexão longa não pode sobreviver à desativação de quem a abriu.
 *
 * ⚠️ Reconexão por CURSOR do cliente (não histórico de broker): o cliente manda
 * o último id visto em `Last-Event-ID` (ou `?desde`) e recebe o delta do outbox
 * — pelo MESMO filtro de escopo e com limite. Assim nada se perde se a conexão
 * cair no instante do NOTIFY.
 */

const LIMITE_REPLAY = 500

/** Intervalo da revalidação (ms). Lido por conexão: o teste encurta pelo ambiente. */
function revalidarMs(): number {
  const v = Number(process.env.SSE_REVALIDAR_MS)
  return Number.isFinite(v) && v > 0 ? v : 60_000
}

function extrairToken(req: FastifyRequest): string | undefined {
  const auth = req.headers['authorization']
  const valor = Array.isArray(auth) ? auth[0] : auth
  return valor?.startsWith('Bearer ') ? valor.slice(7) : undefined
}

export async function rotasEventos(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { desde?: string } }>(
    '/v1/eventos',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const tenantId = req.tenantId!
      const sub = subDoUsuario(req)
      const staff = req.atorStaff === true
      const tokenStaff = staff ? extrairToken(req) : undefined

      // Escopo de quem abriu (garante a linha de `usuario`, como as rotas).
      let escopo: Escopo = await req.comTenant((tx) => escopoDaRequisicao(tx, req))
      if (escopo.tipo !== 'tudo' && escopo.usuarioId === null) {
        // Inativo (ou sem linha): não abre a conexão.
        return reply.code(403).send({ erro: 'acesso.usuario_inativo', mensagem: 'Seu acesso foi desativado.' })
      }

      reply.hijack()
      const res = reply.raw
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // ⚠️ desliga buffering de proxies (nginx) — senão o evento fica preso.
        'x-accel-buffering': 'no',
      })
      // `retry`: se cair, o browser reconecta em 3s (e manda Last-Event-ID).
      res.write('retry: 3000\n\n')

      let encerrada = false
      /** conversaId → visível? Zerado a cada revalidação. */
      const cache = new Map<string, boolean>()

      const visivel = async (conversaId: string): Promise<boolean> => {
        if (escopo.tipo === 'tudo') return true
        const memo = cache.get(conversaId)
        if (memo !== undefined) return memo
        const e = escopo
        const ok = await comTenantServico(tenantId, (tx) => conversaNoEscopo(tx, e, conversaId))
        cache.set(conversaId, ok)
        return ok
      }

      const escrever = (ev: EventoCliente): void => {
        if (encerrada) return
        res.write(`id: ${ev.id}\n`)
        res.write(`event: ${ev.tipo}\n`)
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
      }

      // Fila serial: preserva a ordem mesmo com checagem assíncrona.
      let fila: Promise<void> = Promise.resolve()
      const enviar = (ev: EventoCliente): void => {
        fila = fila.then(async () => {
          if (encerrada) return
          if (ev.conversaId && !(await visivel(ev.conversaId))) return
          escrever(ev)
        }).catch((erro: unknown) => {
          // Na dúvida, NÃO entrega: falha de checagem não pode virar vazamento.
          req.log.warn({ erro, tenantId }, 'filtro de escopo do SSE falhou (evento descartado)')
        })
      }

      // Replay do delta desde o último id visto (cursor no cliente) — MESMO filtro.
      const bruto = req.headers['last-event-id'] ?? req.query.desde ?? '0'
      const desde = Number(Array.isArray(bruto) ? bruto[0] : bruto) || 0
      if (desde > 0) {
        try {
          const linhas = await comTenantServico(tenantId, (tx) =>
            tx<{ id: string; tipo: string; payload: { conversaId?: string; versao?: number } }[]>`
              SELECT id, tipo, payload FROM outbox
               WHERE tenant_id = tenant_atual() AND id > ${desde}
               ORDER BY id ASC LIMIT ${LIMITE_REPLAY}`)
          for (const l of linhas) {
            enviar({
              id: Number(l.id),
              tipo: l.tipo,
              ...(l.payload?.conversaId ? { conversaId: l.payload.conversaId } : {}),
              ...(l.payload?.versao !== undefined ? { versao: l.payload.versao } : {}),
            })
          }
        } catch (erro) {
          req.log.warn({ erro, tenantId }, 'replay de eventos falhou (segue ao vivo)')
        }
      }

      const desassinar = assinar(tenantId, enviar)

      // Heartbeat: mantém a conexão viva por proxies e detecta queda cedo.
      const batimento = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          // conexão morta — o 'close' abaixo limpa.
        }
      }, 25_000)

      const encerrar = (): void => {
        if (encerrada) return
        encerrada = true
        clearInterval(batimento)
        clearInterval(revalidacao)
        desassinar()
      }
      const fechar = (motivo: string): void => {
        req.log.info({ tenantId, motivo }, 'conexao SSE encerrada pelo servidor')
        encerrar()
        try { res.end() } catch { /* já fechada */ }
      }

      // Revalidação: token, usuário ativo e escopo atualizado (zera o cache).
      const revalidacao = setInterval(() => {
        void (async () => {
          try {
            if (staff) {
              if (!tokenStaff || !(await resolverSessaoStaff(tokenStaff))) return fechar('sessao_staff_encerrada')
              return
            }
            if (req.tokenExpiraEm !== undefined && req.tokenExpiraEm * 1000 <= Date.now()) return fechar('token_expirado')
            const novo = await comTenantServico(tenantId, (tx) => escopoDoUsuario(tx, { sub }))
            if (novo.tipo !== 'tudo' && novo.usuarioId === null) return fechar('usuario_inativo')
            escopo = novo
            cache.clear()
          } catch (erro) {
            req.log.warn({ erro, tenantId }, 'revalidacao do SSE falhou (tenta no próximo ciclo)')
          }
        })()
      }, revalidarMs())

      req.raw.on('close', encerrar)
      req.raw.on('error', encerrar)
    },
  )
}
