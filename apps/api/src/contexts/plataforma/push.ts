import webpush from 'web-push'
import type { Sql } from '../../db/index.js'

/**
 * PUSH NATIVO (PLT-07) — a notificação que chega com o navegador FECHADO.
 *
 * O sino do shell já funciona, mas só para quem está com a aba aberta. ⚠️ Quem
 * fechou o console — a maior parte do dia — não sabe da mensagem nova, e o
 * cliente espera do outro lado.
 *
 * ⚠️ **O PAYLOAD NÃO LEVA CONTEÚDO DA CONVERSA**, e aqui a regra do ADR-007 vale
 * DUAS vezes:
 *
 * 1. o payload viaja pelo serviço de push do navegador (Google, Mozilla, Apple)
 *    — cifrado, mas ainda assim fora da nossa RLS;
 * 2. a notificação aparece na TELA DE BLOQUEIO do aparelho, à vista de quem
 *    estiver por perto.
 *
 * Então o push diz "mensagem nova de Fulano" e leva o id da conversa. O conteúdo
 * o console busca por API, autenticado, quando a pessoa abre.
 *
 * ⚠️ **Degrada em vez de quebrar**: sem as chaves VAPID no ambiente, tudo aqui
 * vira no-op silencioso e o produto segue com o sino. Push é conveniência; a
 * notificação em si já está garantida no banco.
 */

export interface Assinatura {
  readonly id: string
  readonly tenant_id: string
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
}

export interface ResultadoPush {
  readonly enviados: number
  readonly removidos: number
  readonly falhas: number
}

/** Resultado de UMA tentativa. `status` é o do serviço de push. */
export type EnviarPush = (a: Assinatura, payload: string) => Promise<{ ok: boolean; status: number }>

export interface ConfigVapid {
  readonly publica: string
  readonly privada: string
  /** `mailto:` de contato — exigido pelo protocolo (RFC 8292). */
  readonly assunto: string
}

export function configVapid(env: NodeJS.ProcessEnv = process.env): ConfigVapid | null {
  const publica = env['VAPID_PUBLIC_KEY']
  const privada = env['VAPID_PRIVATE_KEY']
  if (!publica || !privada) return null
  return { publica, privada, assunto: env['VAPID_SUBJECT'] ?? 'mailto:suporte@drezz.com.br' }
}

/**
 * ⚠️ 404 e 410 são resposta ESPERADA, não erro: a pessoa revogou a permissão,
 * limpou o site ou trocou de aparelho. A assinatura morreu e a linha tem de sair
 * — insistir num endpoint morto é gastar requisição para sempre.
 */
export function assinaturaMorreu(status: number): boolean {
  return status === 404 || status === 410
}

/** Envio real. Isolado para o teste não precisar de rede. */
export function envioReal(cfg: ConfigVapid): EnviarPush {
  webpush.setVapidDetails(cfg.assunto, cfg.publica, cfg.privada)
  return async (a, payload) => {
    try {
      const r = await webpush.sendNotification(
        { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
        payload,
        { TTL: 3600 }, // ⚠️ 1h: mensagem de atendimento velha não vale interrupção.
      )
      return { ok: true, status: r.statusCode }
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 0
      return { ok: false, status }
    }
  }
}

/**
 * O que aparece no aparelho. ⚠️ Nome de quem escreveu, nunca o texto: o título
 * é lido por quem estiver olhando a tela de bloqueio, e a conversa é do cliente.
 */
export function montarPayload(titulo: string, conversaId: string, vezes = 1): string {
  return JSON.stringify({
    titulo: 'Mensagem nova',
    // ⚠️ A contagem existe por causa da `tag` do service worker: o aviso da mesma
    //    conversa SUBSTITUI o anterior na tela. Repetir "Fulano respondeu" faz a
    //    substituição parecer que nada aconteceu — e foi assim que o push passou
    //    por "morto" em 26/08, estando vivo. Ver `0070`.
    corpo: corpoDoAviso(titulo, vezes),
    conversaId,
  })
}

function corpoDoAviso(titulo: string, vezes: number): string {
  if (!titulo) {
    return vezes > 1
      ? `${vezes} mensagens novas no atendimento`
      : 'Você tem uma mensagem no atendimento'
  }
  return vezes > 1 ? `${titulo} · ${vezes} mensagens novas` : `${titulo} respondeu`
}

interface Pendente {
  titulo: string
  vezes: number
  conversa_id: string | null
  assinatura_id: string
  endpoint: string
  p256dh: string
  auth: string
}

/** Teto por passada e por tenant — rajada não vira tempestade de push. */
const LOTE = 200

/**
 * Empurra as notificações novas de UM tenant.
 *
 * ⚠️ Roda como DONO (worker), com `tenant_id` explícito — igual ao despachante
 * de webhooks. E o cursor é por tenant: sem ele, cada passada teria de varrer a
 * tabela inteira procurando "o que ainda não empurrei".
 *
 * ⚠️ **O CURSOR NUNCA PASSA PELO JAVASCRIPT — e essa é a regra dura deste
 * arquivo.** `timestamptz` guarda MICROSSEGUNDOS; `Date` do JS guarda
 * MILISSEGUNDOS. Ler o cursor para uma variável e usá-la no filtro (ou gravá-la
 * de volta) TRUNCA o valor — o cursor anda PARA TRÁS, a notificação que acabou
 * de ser empurrada volta a casar `> cursor`, e o aparelho da pessoa vibra com o
 * mesmo aviso de 20 em 20 segundos, para sempre.
 *
 * ⚠️ E não adianta consertar uma ponta só: o truncamento acontece na leitura E
 * na escrita, inclusive quando o valor viaja como texto (o driver reconverte).
 * Por isso o cursor é lido e gravado por SUBCONSULTA, referenciando a coluna.
 */
export async function despacharPushDoTenant(
  sql: Sql, tenantId: string, enviar: EnviarPush,
): Promise<ResultadoPush> {
  const pendentes = await sql<Pendente[]>`
    SELECT n.titulo, n.vezes, n.conversa_id,
           p.id AS assinatura_id, p.endpoint, p.p256dh, p.auth
      FROM notificacao n
      JOIN push_assinatura p ON p.tenant_id = n.tenant_id AND p.usuario_id = n.usuario_id
     WHERE n.tenant_id = ${tenantId}
       -- Sem linha em push_cursor (ninguém assinou ainda) a subconsulta é NULL e
       -- a comparação não casa nada — que é exatamente o comportamento certo.
       AND n.criado_em > (SELECT c.ate_criado_em FROM push_cursor c WHERE c.tenant_id = ${tenantId})
       -- ⚠️ Já lida não vira push: a pessoa está com o console aberto e já viu.
       AND n.lida_em IS NULL
     ORDER BY n.criado_em ASC
     LIMIT ${LOTE}`

  let enviados = 0, removidos = 0, falhas = 0

  for (const p of pendentes) {
    const r = await enviar(
      { id: p.assinatura_id, tenant_id: tenantId, endpoint: p.endpoint, p256dh: p.p256dh, auth: p.auth },
      montarPayload(p.titulo, p.conversa_id ?? '', p.vezes),
    )
    if (r.ok) {
      enviados++
      await sql`UPDATE push_assinatura SET ultimo_uso_em = now(), ultimo_erro = NULL
                 WHERE tenant_id = ${tenantId} AND id = ${p.assinatura_id}`
    } else if (assinaturaMorreu(r.status)) {
      removidos++
      await sql`DELETE FROM push_assinatura WHERE tenant_id = ${tenantId} AND id = ${p.assinatura_id}`
    } else {
      falhas++
      await sql`UPDATE push_assinatura SET ultimo_erro = ${`status ${r.status}`}
                 WHERE tenant_id = ${tenantId} AND id = ${p.assinatura_id}`
    }
  }

  // ⚠️ O cursor avança MESMO com falha de entrega. Push não é entrega confiável
  //    e não deve virar fila de retry: a notificação já está no banco e no sino.
  //    Vibrar o celular por algo de dez minutos atrás é pior do que não vibrar.
  //
  // ⚠️ O novo valor é calculado DENTRO do banco, sobre a MESMA janela (mesmo
  //    filtro, mesma ordem, mesmo LIMIT). Pegar o `max` de tudo que existe
  //    pularia o que ficou fora do lote.
  if (pendentes.length > 0) {
    await sql`
      UPDATE push_cursor c
         SET ate_criado_em = coalesce((
               SELECT max(lote.criado_em) FROM (
                 SELECT n.criado_em
                   FROM notificacao n
                   JOIN push_assinatura p
                     ON p.tenant_id = n.tenant_id AND p.usuario_id = n.usuario_id
                  WHERE n.tenant_id = ${tenantId}
                    AND n.criado_em > c.ate_criado_em
                    AND n.lida_em IS NULL
                  ORDER BY n.criado_em ASC
                  LIMIT ${LOTE}
               ) lote
             ), c.ate_criado_em),
             atualizado_em = now()
       WHERE c.tenant_id = ${tenantId}`
  }
  return { enviados, removidos, falhas }
}

/** Uma passada por todos os tenants que têm alguém assinado. */
export async function despacharPush(sql: Sql, enviar: EnviarPush): Promise<ResultadoPush> {
  const vazio: ResultadoPush = { enviados: 0, removidos: 0, falhas: 0 }
  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('push_despacho')) AS ok`
  if (!trava?.ok) return vazio

  try {
    const tenants = await sql<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM push_assinatura`
    let enviados = 0, removidos = 0, falhas = 0
    for (const { tenant_id } of tenants) {
      const r = await despacharPushDoTenant(sql, tenant_id, enviar)
      enviados += r.enviados; removidos += r.removidos; falhas += r.falhas
    }
    return { enviados, removidos, falhas }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('push_despacho'))`
  }
}
