import { randomUUID } from 'node:crypto'
import { comTenantServico, type Sql } from '../../../db/index.js'
import { enviarTextoNaConversa } from '../envio-conversa.js'

/**
 * O RETORNO DO AGENTE (follow-up, R5) — a cutucada programada quando o cliente
 * some depois de uma proposta ou deixa o carrinho.
 *
 *   proposta enviada ──agendarRetorno(+1h)──▶ agente_retorno (pendente)
 *   workers (60 s, dono, advisory lock) ──▶ processarRetornos
 *     ├─ cliente escreveu? motivo ainda vale? agente em modo autônomo?
 *     ├─ envia UM texto curto pelo GATEWAY (opt-out, pausa, janela de 24h)
 *     └─ enviado → agenda o próximo passo (24h, depois 72h); recusa → recusado
 *
 * ⚠️ Texto FIXO, educado e SEM NÚMEROS: não há ferramenta neste caminho, então
 * não há de onde um número sair com origem (guardrail do agente).
 * ⚠️ No oficial fora da janela o gateway recusa (`janela_fechada`) e a linha
 * vira `recusado` com o motivo — template de reabertura é decisão de quem
 * opera, nunca forçada daqui.
 */

export type MotivoRetorno = 'proposta_sem_resposta' | 'carrinho_abandonado' | 'combinado'
export type EstadoRetorno = 'pendente' | 'enviado' | 'cancelado' | 'recusado'

/** Quando cada passo sai, contado a partir do passo anterior: 1h → 24h → 72h. */
export const CADENCIA_RETORNO_MS: readonly number[] = [3_600_000, 24 * 3_600_000, 72 * 3_600_000]
export const MAX_TENTATIVAS_RETORNO = 3
export const MARCADOR_RETORNO = 'retorno'
export const INTERVALO_RETORNOS_MS = 60_000
/** Falha de TRANSPORTE (provedor com mau dia): tenta de novo daqui a pouco. */
const ATRASO_TRANSPORTE_MS = 15 * 60_000
const LOTE = 20

const TEXTOS: Record<Exclude<MotivoRetorno, 'combinado'>, readonly [string, string, string]> = {
  proposta_sem_resposta: [
    'Oi! Passando para saber se conseguiu ver o resumo do pedido que te mandei. Se quiser ajustar alguma coisa, é só me dizer.',
    'Oi, tudo bem? Seu pedido continua reservado por aqui. Posso confirmar do jeito que está, ou prefere mudar algo?',
    'Oi! Vou deixar o pedido guardado para quando você quiser retomar. Qualquer coisa, é só chamar por aqui.',
  ],
  carrinho_abandonado: [
    'Oi! Vi que você começou a montar um pedido com a gente. Quer que eu te ajude a fechar, ou prefere tirar alguma dúvida antes?',
    'Oi, tudo bem? O que você montou ainda está salvo por aqui. Se quiser, eu fecho para você rapidinho.',
    'Oi! Vou deixar o que você montou guardado para quando precisar. Qualquer coisa, é só chamar.',
  ],
}
const TEXTO_COMBINADO = 'Oi! Como combinamos, estou passando para retomar nossa conversa. Como posso te ajudar?'

/** O texto fixo de um passo. `combinado` usa o texto gravado, se houver. */
export function textoDoRetorno(motivo: MotivoRetorno, tentativa: number, texto: string | null): string {
  if (motivo === 'combinado') return texto?.trim() || TEXTO_COMBINADO
  const passo = Math.min(Math.max(tentativa, 1), MAX_TENTATIVAS_RETORNO) - 1
  return TEXTOS[motivo][passo]!
}

export interface AgendarRetorno {
  readonly conversaId: string
  /** Opcional: resolvido pela conversa quando omitido. */
  readonly canalId?: string | undefined
  readonly motivo: MotivoRetorno
  readonly executarEm: Date
  readonly tentativa?: number | undefined
  readonly texto?: string | null | undefined
}

/**
 * Agenda (ou REAGENDA) o retorno de uma conversa por motivo. Chamar DENTRO da
 * transação de quem decidiu (proposta enviada, ferramenta do agente) — tenant
 * já setado. Uma pendente por (conversa, motivo): propor de novo reinicia a
 * cadência em vez de empilhar.
 */
export async function agendarRetorno(
  tx: Sql, p: AgendarRetorno,
): Promise<{ retornoId: string; reagendado: boolean } | { retornoId: null; motivo: 'conversa_inexistente' }> {
  let canalId = p.canalId
  if (!canalId) {
    const [c] = await tx<{ canal_id: string }[]>`
      SELECT canal_id FROM conversa WHERE tenant_id = tenant_atual() AND id = ${p.conversaId}`
    if (!c) return { retornoId: null, motivo: 'conversa_inexistente' }
    canalId = c.canal_id
  }
  const id = randomUUID()
  const [linha] = await tx<{ id: string; reagendado: boolean }[]>`
    INSERT INTO agente_retorno (tenant_id, id, conversa_id, canal_id, motivo, executar_em, estado, tentativa, texto)
    VALUES (tenant_atual(), ${id}, ${p.conversaId}, ${canalId}, ${p.motivo}, ${p.executarEm}, 'pendente',
            ${p.tentativa ?? 1}, ${p.texto ?? null})
    ON CONFLICT (tenant_id, conversa_id, motivo) WHERE estado = 'pendente'
    DO UPDATE SET executar_em = EXCLUDED.executar_em, tentativa = EXCLUDED.tentativa,
                  texto = coalesce(EXCLUDED.texto, agente_retorno.texto), criado_em = now()
    RETURNING id, (xmax <> 0) AS reagendado`
  return { retornoId: linha!.id, reagendado: linha!.reagendado }
}

/**
 * O cliente escreveu: os pendentes da conversa perdem o motivo. Chamado na
 * MESMA transação da ingestão (savepoint). Devolve quantos cancelou.
 */
export async function cancelarRetornosDaConversa(tx: Sql, conversaId: string, motivo?: MotivoRetorno): Promise<number> {
  const linhas = await tx<{ id: string }[]>`
    UPDATE agente_retorno SET estado = 'cancelado', detalhe = 'cliente_escreveu', concluido_em = now()
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND estado = 'pendente'
       ${motivo ? tx`AND motivo = ${motivo}` : tx``}
     RETURNING id`
  return linhas.length
}

export interface DepsRetorno {
  readonly enviar?: typeof enviarTextoNaConversa | undefined
  /** Restringe a passada a UM tenant (reprocessamento dirigido; testes contra banco compartilhado). */
  readonly somenteTenant?: string | undefined
}

export interface RelatorioRetornos {
  vencidos: number
  enviados: number
  cancelados: number
  recusados: number
  reagendados: number
}

interface RetornoVencido {
  readonly tenant_id: string
  readonly id: string
  readonly conversa_id: string
  readonly canal_id: string
  readonly motivo: MotivoRetorno
  readonly tentativa: number
  readonly texto: string | null
  readonly criado_em: Date
}

/**
 * Uma passada do worker: pega os vencidos (como DONO), decide sob o tenant,
 * envia pelo gateway FORA de transação e grava o desfecho.
 */
export async function processarRetornos(
  dono: Sql, deps: DepsRetorno = {}, agora: Date = new Date(),
): Promise<RelatorioRetornos> {
  const r: RelatorioRetornos = { vencidos: 0, enviados: 0, cancelados: 0, recusados: 0, reagendados: 0 }
  const [trava] = await dono<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('agente_retorno')) AS ok`
  if (!trava?.ok) return r
  try {
    const vencidos = await dono<RetornoVencido[]>`
      SELECT tenant_id, id, conversa_id, canal_id, motivo, tentativa, texto, criado_em
        FROM agente_retorno
       WHERE estado = 'pendente' AND executar_em <= ${agora}
         ${deps.somenteTenant ? dono`AND tenant_id = ${deps.somenteTenant}` : dono``}
       ORDER BY executar_em
       LIMIT ${LOTE}`
    r.vencidos = vencidos.length
    for (const v of vencidos) {
      try {
        const desfecho = await processarUm(v, deps, agora)
        if (desfecho === 'enviado') r.enviados += 1
        else if (desfecho === 'cancelado') r.cancelados += 1
        else if (desfecho === 'recusado') r.recusados += 1
        else r.reagendados += 1
      } catch (erro) {
        // ⚠️ Um retorno quebrado não pode parar os OUTROS (de todos os tenants).
        //    Fica pendente e volta na próxima passada; o erro vai para o log de
        //    quem chamou pelo relatório — aqui só não derruba a passada.
        r.reagendados += 1
        await dono`UPDATE agente_retorno SET executar_em = ${new Date(agora.getTime() + ATRASO_TRANSPORTE_MS)},
                          detalhe = ${`erro: ${erro instanceof Error ? erro.message : String(erro)}`.slice(0, 500)}
                    WHERE tenant_id = ${v.tenant_id} AND id = ${v.id}`
      }
    }
  } finally {
    await dono`SELECT pg_advisory_unlock(hashtext('agente_retorno'))`
  }
  return r
}

type Desfecho = 'enviado' | 'cancelado' | 'recusado' | 'reagendado'

async function processarUm(v: RetornoVencido, deps: DepsRetorno, agora: Date): Promise<Desfecho> {
  // 1. Decidir, sob o tenant: o motivo ainda vale? o agente pode falar sozinho?
  const veredito = await comTenantServico(v.tenant_id, (tx) => avaliar(tx, v))
  if (veredito !== 'envia') {
    await comTenantServico(v.tenant_id, (tx) => encerrar(tx, v, 'cancelado', veredito, agora))
    return 'cancelado'
  }

  // 2. Enviar pelo gateway único — FORA de transação. `ehDisparo: true`: a
  //    pausa de disparo e o opt-out alcançam o retorno, como qualquer envio
  //    programático.
  const enviar = deps.enviar ?? enviarTextoNaConversa
  const envio = await enviar(v.tenant_id, v.conversa_id, textoDoRetorno(v.motivo, v.tentativa, v.texto), null, agora, {
    marcador: MARCADOR_RETORNO, ehDisparo: true,
  })

  // 3. Desfecho + próximo passo, no MESMO commit.
  return comTenantServico(v.tenant_id, async (tx) => {
    if (envio.ok) {
      await encerrar(tx, v, 'enviado', null, agora)
      if (v.tentativa < MAX_TENTATIVAS_RETORNO) {
        await agendarRetorno(tx, {
          conversaId: v.conversa_id, canalId: v.canal_id, motivo: v.motivo, texto: v.texto,
          tentativa: v.tentativa + 1, executarEm: new Date(agora.getTime() + CADENCIA_RETORNO_MS[v.tentativa]!),
        })
      }
      return 'enviado'
    }
    if (envio.classe === 'recusa' || envio.classe === 'alvo') {
      // Recusa NOSSA (janela fechada, opt-out, pausa, canal fora): não retentar.
      await encerrar(tx, v, 'recusado', envio.motivo, agora)
      return 'recusado'
    }
    // Transporte: o provedor teve um mau dia. Mesma linha, mais tarde.
    await tx`
      UPDATE agente_retorno SET executar_em = ${new Date(agora.getTime() + ATRASO_TRANSPORTE_MS)},
             detalhe = ${`transporte: ${envio.motivo}`}
       WHERE tenant_id = tenant_atual() AND id = ${v.id}`
    return 'reagendado'
  })
}

/** Por que NÃO enviar — ou `envia`. Tudo lido sob RLS. */
async function avaliar(tx: Sql, v: RetornoVencido): Promise<'envia' | string> {
  // Cliente escreveu depois de agendado (cinto e suspensório: a ingestão já
  // cancela, mas um webhook pode ter corrido sem o savepoint acessório).
  const [conv] = await tx<{ ultima_entrante_em: Date | null; humano_assumiu: boolean }[]>`
    SELECT c.ultima_entrante_em,
           EXISTS (SELECT 1 FROM atendimento a
                    WHERE a.tenant_id = c.tenant_id AND a.conversa_id = c.id AND a.estado <> 'encerrado') AS humano_assumiu
      FROM conversa c WHERE c.tenant_id = tenant_atual() AND c.id = ${v.conversa_id}`
  if (!conv) return 'conversa_inexistente'
  if (conv.ultima_entrante_em && conv.ultima_entrante_em > v.criado_em) return 'cliente_escreveu'
  // Atendimento humano aberto cala o agente — inclusive a cutucada.
  if (conv.humano_assumiu) return 'humano_atendendo'

  const [cfg] = await tx<{ modo: string }[]>`
    SELECT modo FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${v.canal_id}`
  if (!cfg || cfg.modo !== 'autonomo') return `modo:${cfg?.modo ?? 'desligado'}`

  if (v.motivo === 'proposta_sem_resposta') {
    const [p] = await tx<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pedido WHERE tenant_id = tenant_atual() AND conversa_id = ${v.conversa_id}
                       AND estado = 'aguardando_confirmacao') AS ok`
    return p?.ok ? 'envia' : 'sem_proposta_pendente'
  }
  if (v.motivo === 'carrinho_abandonado') {
    const [p] = await tx<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pedido p
                      WHERE p.tenant_id = tenant_atual() AND p.conversa_id = ${v.conversa_id} AND p.estado = 'rascunho'
                        AND EXISTS (SELECT 1 FROM pedido_item i WHERE i.tenant_id = p.tenant_id AND i.pedido_id = p.id)) AS ok`
    return p?.ok ? 'envia' : 'sem_rascunho_com_itens'
  }
  return 'envia'
}

async function encerrar(tx: Sql, v: RetornoVencido, estado: EstadoRetorno, detalhe: string | null, agora: Date): Promise<void> {
  await tx`
    UPDATE agente_retorno SET estado = ${estado}, detalhe = ${detalhe}, concluido_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${v.id} AND estado = 'pendente'`
}
