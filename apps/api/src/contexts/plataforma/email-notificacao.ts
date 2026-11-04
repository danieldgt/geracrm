import type { Sql } from '../../db/index.js'

/**
 * E-mail de notificação (D4) — SLA estourado e menção.
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

interface Pendente { id: string; titulo: string; tipo: string; email: string; nome: string }

const ASSUNTO_POR_TIPO: Readonly<Record<string, string>> = {
  'sla.estourado': 'SLA do atendimento estourado',
  'conversa.mencao': 'Você foi mencionado numa conversa',
}

/** Despacha os e-mails pendentes de UM tenant. Devolve quantos saíram e quantos falharam. */
export async function despacharEmailsDoTenant(
  sql: Sql, tenantId: string, porta: PortaEmail,
): Promise<{ enviados: number; falhas: number }> {
  const pendentes = await sql<Pendente[]>`
    SELECT n.id, n.titulo, n.tipo, u.email, u.nome
      FROM notificacao n
      JOIN usuario u ON u.tenant_id = n.tenant_id AND u.id = n.usuario_id AND u.ativo
     WHERE n.tenant_id = ${tenantId} AND n.email_pendente
     ORDER BY n.criado_em ASC
     LIMIT ${LOTE}`
  let enviados = 0, falhas = 0
  for (const p of pendentes) {
    const r = await porta.enviar({
      para: p.email,
      assunto: ASSUNTO_POR_TIPO[p.tipo] ?? 'Aviso do GeraCRM',
      texto: `Olá, ${p.nome}.\n\n${p.titulo}\n\nAbra o console para ver os detalhes. Você pode ajustar estes avisos em Meu perfil.`,
    }).catch(() => ({ ok: false }))
    if (r.ok) {
      enviados++
      await sql`UPDATE notificacao SET email_pendente = false, email_enviado_em = now()
                 WHERE tenant_id = ${tenantId} AND id = ${p.id}`
    } else {
      falhas++
    }
  }
  return { enviados, falhas }
}

/** Uma passada por todos os tenants com e-mail pendente (advisory lock: uma instância por vez). */
export async function despacharEmails(sql: Sql, porta: PortaEmail): Promise<{ enviados: number; falhas: number }> {
  const [trava] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('email_notificacao_despacho')) AS ok`
  if (!trava?.ok) return { enviados: 0, falhas: 0 }
  try {
    const tenants = await sql<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM notificacao WHERE email_pendente`
    let enviados = 0, falhas = 0
    for (const { tenant_id } of tenants) {
      const r = await despacharEmailsDoTenant(sql, tenant_id, porta)
      enviados += r.enviados; falhas += r.falhas
    }
    return { enviados, falhas }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('email_notificacao_despacho'))`
  }
}
