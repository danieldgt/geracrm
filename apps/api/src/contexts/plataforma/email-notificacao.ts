import type { Sql } from '../../db/index.js'

/**
 * E-mail de notificação (D4) — SLA estourado (a menção entra quando existir produtor).
 *
 * A PORTA é do nosso domínio: quem envia e-mail é um adaptador atrás de `PortaEmail`. O padrão é o de
 * LOG (nada sai da máquina) e o de memória é o dos testes; provedor pago entra depois, como terceiro
 * adaptador, sem tocar nas regras daqui.
 *
 * ⚠️ O e-mail NUNCA sai dentro da transação que gerou o aviso: a notificação grava `email_pendente` e
 * este worker (dono, tenant explícito — igual ao push) despacha depois. Falha de envio não perde o
 * aviso do sino e tenta de novo na próxima passada.
 *
 * ⚠️ O corpo não leva conteúdo de conversa: só o título curto do aviso (o nome do cliente) e o convite
 * a abrir o console, onde a leitura é autenticada e sob RLS.
 */

export interface MensagemEmail {
  readonly para: string
  readonly assunto: string
  readonly texto: string
  /** `notificacao.id`: o provedor de e-mail dedupica por esta chave se a mesma mensagem chegar duas vezes. */
  readonly chaveIdempotencia: string
}

export interface PortaEmail {
  enviar(m: MensagemEmail): Promise<{ readonly ok: boolean }>
}

/** Adaptador padrão: registra e não envia. */
export function emailPorLog(log: { info: (o: object, msg: string) => void }): PortaEmail {
  return {
    async enviar(m) {
      log.info({ para: m.para, assunto: m.assunto, contexto: 'plataforma.email' }, 'e-mail (log, sem envio real)')
      return { ok: true }
    },
  }
}

/** Adaptador dos testes: guarda o que seria enviado. */
export class EmailEmMemoria implements PortaEmail {
  readonly enviados: MensagemEmail[] = []
  falhar = false
  async enviar(m: MensagemEmail): Promise<{ ok: boolean }> {
    if (this.falhar) return { ok: false }
    this.enviados.push(m)
    return { ok: true }
  }
}

const LOTE = 100
/** Tentativas por notificação; depois disso o e-mail é abandonado (o aviso do sino segue). */
export const MAX_TENTATIVAS_EMAIL = 5
const RESERVA_MINUTOS = 5

interface Reservada { id: string; titulo: string; tipo: string; email: string; nome: string; tentativas: number }

const ASSUNTO_POR_TIPO: Readonly<Record<string, string>> = {
  'sla.estourado': 'SLA do atendimento estourado',
}

/**
 * Despacha os e-mails pendentes de UM tenant.
 *
 * ⚠️ RESERVA antes de enviar (`UPDATE … RETURNING` com `FOR UPDATE SKIP LOCKED`): duas instâncias, ou uma
 * passada que cai no meio, não pegam a mesma linha; a reserva expira sozinha e a linha volta à fila. Cada
 * envio carrega `notificacao.id` como chave de idempotência. Teto de tentativas — depois dele o e-mail é
 * abandonado com aviso no log (tenant e notificação, NUNCA o endereço).
 */
export async function despacharEmailsDoTenant(
  sql: Sql, tenantId: string, porta: PortaEmail,
  log?: { warn: (o: object, msg: string) => void },
): Promise<{ enviados: number; falhas: number }> {
  const reservadas = await sql<Reservada[]>`
    WITH pegas AS (
      SELECT id FROM notificacao
       WHERE tenant_id = ${tenantId} AND email_pendente AND email_tentativas < ${MAX_TENTATIVAS_EMAIL}
         AND (email_reservado_ate IS NULL OR email_reservado_ate < now())
       ORDER BY criado_em ASC
       LIMIT ${LOTE}
       FOR UPDATE SKIP LOCKED
    ), marcadas AS (
      UPDATE notificacao n
         SET email_reservado_ate = now() + make_interval(mins => ${RESERVA_MINUTOS}),
             email_tentativas = n.email_tentativas + 1
        FROM pegas
       WHERE n.tenant_id = ${tenantId} AND n.id = pegas.id
      RETURNING n.id, n.titulo, n.tipo, n.usuario_id, n.email_tentativas AS tentativas
    )
    SELECT m.id, m.titulo, m.tipo, m.tentativas, u.email, u.nome
      FROM marcadas m
      JOIN usuario u ON u.tenant_id = ${tenantId} AND u.id = m.usuario_id AND u.ativo`
  let enviados = 0, falhas = 0
  for (const p of reservadas) {
    const r = await porta.enviar({
      para: p.email,
      assunto: ASSUNTO_POR_TIPO[p.tipo] ?? 'Aviso do GeraCRM',
      texto: `Olá, ${p.nome}.\n\n${p.titulo}\n\nAbra o console para ver os detalhes. Você pode ajustar estes avisos em Meu perfil.`,
      chaveIdempotencia: p.id,
    }).catch(() => ({ ok: false }))
    if (r.ok) {
      enviados++
      await sql`UPDATE notificacao SET email_pendente = false, email_enviado_em = now(), email_reservado_ate = NULL
                 WHERE tenant_id = ${tenantId} AND id = ${p.id}`
    } else {
      falhas++
      const desistiu = p.tentativas >= MAX_TENTATIVAS_EMAIL
      log?.warn({ tenantId, notificacaoId: p.id, tentativa: p.tentativas, desistiu, contexto: 'plataforma.email' }, 'envio de e-mail falhou')
      if (desistiu) {
        await sql`UPDATE notificacao SET email_pendente = false, email_reservado_ate = NULL
                   WHERE tenant_id = ${tenantId} AND id = ${p.id}`
      }
    }
  }
  return { enviados, falhas }
}

/** Uma passada por todos os tenants com e-mail pendente (advisory lock: uma instância por vez). */
export async function despacharEmails(
  sql: Sql, porta: PortaEmail, log?: { warn: (o: object, msg: string) => void },
): Promise<{ enviados: number; falhas: number }> {
  const [trava] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('email_notificacao_despacho')) AS ok`
  if (!trava?.ok) return { enviados: 0, falhas: 0 }
  try {
    const tenants = await sql<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM notificacao WHERE email_pendente AND email_tentativas < ${MAX_TENTATIVAS_EMAIL}`
    let enviados = 0, falhas = 0
    for (const { tenant_id } of tenants) {
      const r = await despacharEmailsDoTenant(sql, tenant_id, porta, log)
      enviados += r.enviados; falhas += r.falhas
    }
    return { enviados, falhas }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('email_notificacao_despacho'))`
  }
}
