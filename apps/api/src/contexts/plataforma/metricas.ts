import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * Série temporal técnica (I-11) + regra de alerta (I-10). Postgres, agregado por
 * hora. A REGRA de entrega é pura (testável sem banco); o resto é upsert/leitura.
 */

/** Incrementa o balde da hora para uma métrica. Idempotente por (métrica, hora). */
export async function registrarMetrica(
  sql: Sql, metrica: string, incremento: number, agora: Date,
): Promise<void> {
  await sql`
    INSERT INTO metrica_janela (tenant_id, metrica, bucket, valor)
    VALUES (tenant_atual(), ${metrica}, date_trunc('hour', ${agora}::timestamptz), ${incremento})
    ON CONFLICT (tenant_id, metrica, bucket)
    DO UPDATE SET valor = metrica_janela.valor + ${incremento}`
}

/** Limiar da regra de entrega. Fora daqui não existe número mágico solto. */
export const REGRA_ENTREGA = {
  /** Abaixo de tantas amostras a taxa é ruído — não alerta. */
  minAmostras: 20,
  /** Taxa de sucesso abaixo disto = queda de entrega. */
  limiteTaxa: 0.7,
} as const

export interface Contagem { ok: number; falha: number }

/**
 * Regra PURA: a entrega caiu? ⚠️ Exige massa mínima (`minAmostras`) — 1 falha em
 * 2 envios não é incidente, é acaso. Só vira alerta com volume que sustente a taxa.
 */
export function avaliarEntrega(
  c: Contagem, regra: { minAmostras: number; limiteTaxa: number } = REGRA_ENTREGA,
): { alerta: boolean; taxa: number; amostras: number } {
  const amostras = c.ok + c.falha
  const taxa = amostras === 0 ? 1 : c.ok / amostras
  const alerta = amostras >= regra.minAmostras && taxa < regra.limiteTaxa
  return { alerta, taxa, amostras }
}

/**
 * Lê os últimos `horas` baldes de envio, aplica a regra e sobe/resolve o alerta.
 *
 * ⚠️ Dedup pelo índice parcial `alerta_aberto_unico`: se já há um aberto do tipo,
 * o INSERT não duplica. E quando a entrega VOLTA, resolve o aberto — senão o
 * alerta fica pendurado eternamente e o operador aprende a ignorá-lo.
 */
export async function avaliarEAlertarEntrega(sql: Sql, agora: Date, horas = 3): Promise<void> {
  const [linha] = await sql<{ ok: string; falha: string }[]>`
    SELECT
      coalesce(sum(valor) FILTER (WHERE metrica = 'envio_ok'), 0)::text    AS ok,
      coalesce(sum(valor) FILTER (WHERE metrica = 'envio_falha'), 0)::text AS falha
    FROM metrica_janela
    WHERE tenant_id = tenant_atual()
      AND metrica IN ('envio_ok', 'envio_falha')
      AND bucket >= date_trunc('hour', ${agora}::timestamptz) - make_interval(hours => ${horas})`

  const c: Contagem = { ok: Number(linha?.ok ?? 0), falha: Number(linha?.falha ?? 0) }
  const r = avaliarEntrega(c)

  if (r.alerta) {
    const pct = Math.round(r.taxa * 100)
    const nova = await sql<{ id: string }[]>`
      INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
      VALUES (tenant_atual(), ${randomUUID()}, 'entrega_baixa', 'critico',
              ${`Entrega em ${pct}% nas últimas ${horas}h (${c.falha} falhas em ${r.amostras} envios).`})
      ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO NOTHING
      RETURNING id`
    // ⚠️ Evento SÓ quando um alerta NOVO nasce (o ON CONFLICT não retorna nada
    //    se já havia um aberto) — senão a tela piscaria a cada avaliação.
    if (nova.length) {
      await sql`
        INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
        VALUES (tenant_atual(), 'alerta.novo', 'tenant', tenant_atual(), '{}'::jsonb)`
      await pausarDisparoPorEntrega(sql, `Entrega em ${pct}% nas últimas ${horas}h — pausa automática.`)
    }
  } else {
    // Entrega saudável de novo: resolve o alerta aberto, se houver.
    // ⚠️ E NÃO retoma o disparo sozinho. Ver `pausarDisparoPorEntrega`.
    await sql`
      UPDATE alerta SET resolvido_em = now()
       WHERE tenant_id = tenant_atual() AND tipo = 'entrega_baixa' AND resolvido_em IS NULL`
  }
}

/**
 * PAUSA AUTOMÁTICA DE DISPARO quando a entrega desaba (CAN-06, EP-03).
 *
 * Entrega em queda no canal não-oficial é o sinal de número sendo limitado ou
 * bloqueado (ADR-021). Continuar disparando em massa é acelerar o banimento —
 * então o produto para o tráfego programático sozinho e avisa.
 *
 * ⚠️ **Não para o atendimento.** A pausa vale só para envio programático
 * (`ehDisparo` no gateway): a pessoa que responde quem acabou de escrever
 * continua respondendo. Travar isso seria parar a operação por causa do
 * problema oposto ao que a pausa protege.
 *
 * ⚠️ **E NÃO existe retomada automática, de propósito.** Com o disparo parado,
 * quase não nascem novas amostras de entrega — o sistema fica sem como observar
 * a recuperação. Uma retomada "quando melhorar" ficaria esperando um sinal que
 * ela mesma impede de existir. Quem retoma é uma pessoa, na tela do canal, com o
 * motivo registrado ali.
 *
 * ⚠️ O alerta de entrega é do TENANT, não do canal (`metrica_janela` não tem
 * dimensão de canal). Por isso a pausa alcança todos os canais: com a frota
 * inteira sob suspeita, parar só um seria escolher no escuro. Quando a métrica
 * ganhar dimensão de canal, a pausa fica cirúrgica.
 */
export async function pausarDisparoPorEntrega(sql: Sql, motivo: string): Promise<number> {
  const pausados = await sql<{ canal_id: string }[]>`
    INSERT INTO canal_configuracao (tenant_id, canal_id, disparo_pausado, pausado_motivo, pausado_em)
    SELECT tenant_atual(), cc.id, true, ${motivo}, now()
      FROM canal_conectado cc
     WHERE cc.tenant_id = tenant_atual()
    ON CONFLICT (tenant_id, canal_id) DO UPDATE
      SET disparo_pausado = true,
          pausado_motivo  = EXCLUDED.pausado_motivo,
          pausado_em      = now()
      -- ⚠️ Não sobrescreve pausa que JÁ existia: se alguém pausou à mão por
      --    outro motivo, o motivo dela vale mais que o nosso.
      WHERE NOT canal_configuracao.disparo_pausado
    RETURNING canal_id`
  return pausados.length
}
