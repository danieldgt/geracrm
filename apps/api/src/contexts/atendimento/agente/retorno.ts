import { randomUUID } from 'node:crypto'
import { comTenantServico, type Sql } from '../../../db/index.js'
import { enviarTextoNaConversa } from '../envio-conversa.js'
import { enviarTemplateNaConversa } from '../envio-template.js'
import { decidirAtiva, lerContextoAtiva, type DecisaoAtiva } from './ativas.js'
import { normalizarFeriados, recorteAgente, type RecorteAgente } from '@geracrm/shared'
import { modoEfetivoDoCanal, lerFatosDoModo } from './pipeline/modo-efetivo.js'
import { proximaAbertura, partesLocais, instanteLocal, ehFeriado, type Feriados, type HorarioAtendimento } from '../expediente.js'
import { fusoSeguro } from '../../plataforma/fuso.js'

/**
 * O RETORNO DO AGENTE (follow-up, R5) — a cutucada programada quando o cliente
 * some depois de uma proposta ou deixa o carrinho.
 *
 *   proposta enviada ──agendarRetorno(+1h)──▶ agente_retorno (pendente)
 *   workers (60 s, dono, advisory lock) ──▶ processarRetornos
 *     ├─ cliente escreveu? motivo ainda vale? agente em modo autônomo?
 *     ├─ política das ATIVAS (P11, `ativas.ts`): suspensão por qualidade →
 *     │  adia; expediente/feriado → adia para a próxima abertura; limite
 *     │  dia/semana → descarta; oficial fora de 24h → template aprovado ou recusa
 *     ├─ envia UM texto curto (ou o template) pelo GATEWAY (opt-out, pausa, janela)
 *     └─ enviado → agenda o próximo passo (24h, depois 72h); recusa → recusado
 *
 * ⚠️ Texto FIXO, educado e SEM NÚMEROS: não há ferramenta neste caminho, então
 * não há de onde um número sair com origem (guardrail do agente). O template
 * também é fixo (aprovado pela Meta) e só leva o primeiro nome.
 * ⚠️ No oficial fora da janela só sai o template ESCOLHIDO na tela
 * (`agente_config.ativas.templateRetorno`) e APROVADO; sem ele a linha vira
 * `recusado` com o motivo nomeado (`sem_template`, `template_indisponivel`).
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
  /** Envio de template (oficial fora de 24h). Padrão: `enviarTemplateNaConversa`. */
  readonly enviarTemplate?: typeof enviarTemplateNaConversa | undefined
  /** Restringe a passada a UM tenant (reprocessamento dirigido; testes contra banco compartilhado). */
  readonly somenteTenant?: string | undefined
}

export interface RelatorioRetornos {
  vencidos: number
  enviados: number
  cancelados: number
  recusados: number
  /** Falha de transporte ou erro: mesma linha, mais tarde. */
  reagendados: number
  /** Política das ativas: suspensão, expediente ou feriado — mesma linha, na próxima abertura. */
  adiados: number
  /** Política das ativas: limite do dia/semana — final (estado `cancelado`, detalhe com o limite). */
  descartados: number
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
  readonly falhas_transporte: number
}

/**
 * Uma passada do worker: pega os vencidos (como DONO), decide sob o tenant,
 * envia pelo gateway FORA de transação e grava o desfecho.
 */
export async function processarRetornos(
  dono: Sql, deps: DepsRetorno = {}, agora: Date = new Date(),
): Promise<RelatorioRetornos> {
  const r: RelatorioRetornos = { vencidos: 0, enviados: 0, cancelados: 0, recusados: 0, reagendados: 0, adiados: 0, descartados: 0 }
  // ⚠️ A passada do worker desiste se outra está rodando; a DIRIGIDA
  //    (`somenteTenant`: reprocessamento, testes em paralelo) espera a vez —
  //    senão volta vazia sem dizer por quê.
  let travou = false
  for (let i = 0; i < (deps.somenteTenant ? 400 : 1) && !travou; i++) {
    if (i > 0) await new Promise((ok) => setTimeout(ok, 25))
    const [t] = await dono<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('agente_retorno')) AS ok`
    travou = !!t?.ok
  }
  if (!travou) return r
  try {
    const vencidos = await dono<RetornoVencido[]>`
      SELECT tenant_id, id, conversa_id, canal_id, motivo, tentativa, texto, criado_em, falhas_transporte
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
        else if (desfecho === 'adiado') r.adiados += 1
        else if (desfecho === 'descartado') r.descartados += 1
        else r.reagendados += 1
      } catch (erro) {
        // ⚠️ Um retorno quebrado não pode parar os OUTROS (de todos os tenants).
        //    Fica pendente e volta mais tarde — mas CONTA como falha de
        //    transporte, com o mesmo teto: um erro que se repete sempre não
        //    pode virar retorno pendente para sempre, tentando a cada 15 min.
        const detalhe = `erro: ${erro instanceof Error ? erro.message : String(erro)}`.slice(0, 480)
        const esgotou = v.falhas_transporte + 1 >= MAX_FALHAS_TRANSPORTE
        process.stderr.write(`${JSON.stringify({
          nivel: 'error', contexto: 'agente.retorno', msg: 'retorno falhou com erro inesperado',
          tenantId: v.tenant_id, retornoId: v.id, motivo: v.motivo, falhas: v.falhas_transporte + 1, esgotou,
          erro: erro instanceof Error ? erro.message : String(erro),
        })}\n`)
        if (esgotou) {
          r.recusados += 1
          await dono`UPDATE agente_retorno SET falhas_transporte = falhas_transporte + 1, estado = 'recusado',
                            detalhe = ${`erro_esgotado: ${detalhe}`}, concluido_em = ${agora}
                      WHERE tenant_id = ${v.tenant_id} AND id = ${v.id} AND estado = 'pendente'`
        } else {
          r.reagendados += 1
          await dono`UPDATE agente_retorno SET executar_em = ${new Date(agora.getTime() + ATRASO_TRANSPORTE_MS)},
                            falhas_transporte = falhas_transporte + 1, detalhe = ${detalhe}
                      WHERE tenant_id = ${v.tenant_id} AND id = ${v.id}`
        }
      }
    }
  } finally {
    await dono`SELECT pg_advisory_unlock(hashtext('agente_retorno'))`
  }
  return r
}

type Desfecho = 'enviado' | 'cancelado' | 'recusado' | 'reagendado' | 'adiado' | 'descartado'

type Veredito =
  | { tipo: 'cancelar'; motivo: string }
  | { tipo: 'adiar'; ate: Date; motivo: string }
  | { tipo: 'politica'; decisao: DecisaoAtiva }

/** Fora do recorte SÓ por horário/feriado: adia até a próxima abertura do recorte (decisão (q), plano-port §4). */
interface AdiarRecorte { readonly adiarAte: Date; readonly motivo: string }

async function processarUm(v: RetornoVencido, deps: DepsRetorno, agora: Date): Promise<Desfecho> {
  // 1. Decidir, sob o tenant: o motivo ainda vale? o agente pode falar sozinho?
  //    E a política das ATIVAS: suspensão, expediente, limites, janela/template.
  const veredito = await comTenantServico(v.tenant_id, async (tx): Promise<Veredito> => {
    const motivo = await avaliar(tx, v, agora)
    if (typeof motivo !== 'string') return { tipo: 'adiar', ate: motivo.adiarAte, motivo: motivo.motivo }
    if (motivo !== 'envia') return { tipo: 'cancelar', motivo }
    const ctx = await lerContextoAtiva(tx, { conversaId: v.conversa_id, agora })
    if (!ctx) return { tipo: 'cancelar', motivo: 'conversa_inexistente' }
    return { tipo: 'politica', decisao: decidirAtiva(ctx, agora) }
  })
  if (veredito.tipo === 'cancelar') {
    await comTenantServico(v.tenant_id, (tx) => encerrar(tx, v, 'cancelado', veredito.motivo, agora))
    return 'cancelado'
  }
  if (veredito.tipo === 'adiar') {
    // ⚠️ Mesma linha, mesma tentativa: o recorte fechado por horário não é falha nem desistência.
    await comTenantServico(v.tenant_id, (tx) => tx`
      UPDATE agente_retorno SET executar_em = ${veredito.ate}, detalhe = ${veredito.motivo}
       WHERE tenant_id = tenant_atual() AND id = ${v.id} AND estado = 'pendente'`)
    return 'adiado'
  }
  const d = veredito.decisao
  if (d.acao === 'adiar') {
    // ⚠️ Mesma linha, mesma tentativa: adiar não é falhar.
    await comTenantServico(v.tenant_id, (tx) => tx`
      UPDATE agente_retorno SET executar_em = ${d.ate}, detalhe = ${d.motivo}
       WHERE tenant_id = tenant_atual() AND id = ${v.id} AND estado = 'pendente'`)
    return 'adiado'
  }
  if (d.acao === 'descartar') {
    await comTenantServico(v.tenant_id, (tx) => encerrar(tx, v, 'cancelado', d.motivo, agora))
    return 'descartado'
  }
  if (d.acao === 'recusar') {
    await comTenantServico(v.tenant_id, (tx) => encerrar(tx, v, 'recusado', d.motivo, agora))
    return 'recusado'
  }

  // 2. Enviar pelo gateway único — FORA de transação. `ehDisparo: true`: a
  //    pausa de disparo e o opt-out alcançam o retorno, como qualquer envio
  //    programático.
  const opcoes = { marcador: MARCADOR_RETORNO, ehDisparo: true }
  const envio = d.acao === 'template'
    ? await (deps.enviarTemplate ?? enviarTemplateNaConversa)(v.tenant_id, v.conversa_id, d.templateId, agora, opcoes)
    : await (deps.enviar ?? enviarTextoNaConversa)(
      v.tenant_id, v.conversa_id, textoDoRetorno(v.motivo, v.tentativa, v.texto), null, agora, opcoes)

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
    // ⚠️ "Transporte" que é PERMANENTE (destino não é WhatsApp, token
    //    recusado, template recusado pela Meta — 132xxx vira resposta_inesperada):
    //    reenviar não conserta, só gasta e insiste com a Meta. Final.
    if (FALHAS_PERMANENTES.has(envio.motivo)) {
      await encerrar(tx, v, 'recusado', `permanente: ${envio.motivo}`, agora)
      return 'recusado'
    }
    // Transporte de verdade (provedor fora): mesma linha, mais tarde — com teto.
    if (v.falhas_transporte + 1 >= MAX_FALHAS_TRANSPORTE) {
      await tx`UPDATE agente_retorno SET falhas_transporte = falhas_transporte + 1
                WHERE tenant_id = tenant_atual() AND id = ${v.id}`
      await encerrar(tx, v, 'recusado', `transporte_esgotado: ${envio.motivo}`, agora)
      return 'recusado'
    }
    await tx`
      UPDATE agente_retorno SET executar_em = ${new Date(agora.getTime() + ATRASO_TRANSPORTE_MS)},
             falhas_transporte = falhas_transporte + 1,
             detalhe = ${`transporte: ${envio.motivo}`}
       WHERE tenant_id = tenant_atual() AND id = ${v.id}`
    return 'reagendado'
  })
}

/** Falhas do provedor que nenhuma repetição resolve. */
const FALHAS_PERMANENTES: ReadonlySet<string> = new Set(['destino_invalido', 'credencial_invalida', 'resposta_inesperada'])
/** Teto de falhas de transporte seguidas por retorno (a 4ª encerra como recusado). */
export const MAX_FALHAS_TRANSPORTE = 4

/** Por que NÃO enviar — ou `envia`. Tudo lido sob RLS. */
async function avaliar(tx: Sql, v: RetornoVencido, agora: Date): Promise<'envia' | string | AdiarRecorte> {
  // Cliente escreveu depois de agendado (cinto e suspensório: a ingestão já
  // cancela, mas um webhook pode ter corrido sem o savepoint acessório).
  const [conv] = await tx<{ ultima_entrante_em: Date | null; humano_assumiu: boolean; contato_id: string }[]>`
    SELECT c.ultima_entrante_em, c.contato_id,
           EXISTS (SELECT 1 FROM atendimento a
                    WHERE a.tenant_id = c.tenant_id AND a.conversa_id = c.id AND a.estado <> 'encerrado') AS humano_assumiu
      FROM conversa c WHERE c.tenant_id = tenant_atual() AND c.id = ${v.conversa_id}`
  if (!conv) return 'conversa_inexistente'
  if (conv.ultima_entrante_em && conv.ultima_entrante_em > v.criado_em) return 'cliente_escreveu'
  // Atendimento humano aberto cala o agente — inclusive a cutucada.
  if (conv.humano_assumiu) return 'humano_atendendo'

  // ⚠️ O modo EFETIVO (P14, ADR-028): teto do tenant (kill switch), recorte de
  //    horário/segmento/feriado — nunca a coluna `agente_config.modo` direto.
  //    A cutucada é o agente falando sozinho: só em autônomo de fato.
  const efetivo = await modoEfetivoDoCanal(tx, { canalId: v.canal_id, contatoId: conv.contato_id, agora })
  if (efetivo.modo !== 'autonomo') {
    const motivoModo = `modo:${efetivo.modo}${efetivo.motivo ? ` (${efetivo.motivo})` : ''}`
    // ⚠️ Decisão (q): fora do recorte SÓ por horário/feriado, com número autônomo e
    //    teto do tenant que permite autônomo → ADIA para a próxima abertura do
    //    recorte. Kill switch, segmento, recorte inválido e modo do número cancelam.
    const soHorario = efetivo.modoDoNumero === 'autonomo' && !efetivo.recorteInvalido
      && efetivo.foraDoRecorte.length === 1 && efetivo.foraDoRecorte[0] === 'horario'
    if (!soHorario) return motivoModo
    const fatos = await lerFatosDoModo(tx, agora, v.canal_id)
    if (fatos.modoTenant !== null && fatos.modoTenant !== 'autonomo') return motivoModo
    const ate = await aberturaDoRecorte(tx, v.canal_id, agora)
    if (ate === undefined) return motivoModo
    if (ate === null) return 'fora_do_recorte_sem_abertura'
    return { adiarAte: ate, motivo: `${motivoModo}: adiado para a abertura do recorte` }
  }

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

/** Quantos dias à frente procurar o próximo feriado (mesmo horizonte de `proximaAbertura`). */
const HORIZONTE_FERIADO_DIAS = 31

/**
 * Próxima abertura do HORÁRIO do recorte (decisão (q)): o horário do recorte tem
 * o formato do horário de atendimento, então vale `proximaAbertura` (fuso do
 * tenant, feriados do número). Com `feriado: 'dentro'` o feriado não fecha — ele
 * ABRE o dia inteiro: a abertura é a mais cedo entre a próxima faixa (sem
 * feriados) e a meia-noite do próximo feriado.
 * `null` = nenhuma abertura no horizonte; `undefined` = recorte sem horário/ilegível.
 */
export function proximaAberturaDoRecorte(
  recorte: RecorteAgente, feriados: Feriados, agora: Date, fuso: string,
): Date | null | undefined {
  if (!recorte.horario) return undefined
  const horario = recorte.horario as unknown as HorarioAtendimento
  if (recorte.feriado === 'fora') return proximaAbertura(horario, feriados, agora, fuso)
  const porFaixa = proximaAbertura(horario, [], agora, fuso)
  let porFeriado: Date | null = null
  if (feriados.length > 0) {
    const hoje = partesLocais(agora, fuso).data
    const [y, m, d] = hoje.split('-').map(Number) as [number, number, number]
    for (let n = 1; n <= HORIZONTE_FERIADO_DIAS; n++) {
      const x = new Date(Date.UTC(y, m - 1, d + n))
      const data = `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`
      if (ehFeriado(feriados, data)) { porFeriado = instanteLocal(data, '00:00', fuso); break }
    }
  }
  if (!porFaixa) return porFeriado
  if (!porFeriado) return porFaixa
  return porFaixa.getTime() <= porFeriado.getTime() ? porFaixa : porFeriado
}

async function aberturaDoRecorte(tx: Sql, canalId: string, agora: Date): Promise<Date | null | undefined> {
  const [l] = await tx<{ recorte: unknown; fuso: string | null; feriados: unknown }[]>`
    SELECT (SELECT recorte FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}) AS recorte,
           (SELECT fuso FROM tenant WHERE id = tenant_atual()) AS fuso,
           (SELECT feriados FROM canal_configuracao WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}) AS feriados`
  const r = recorteAgente.safeParse(l?.recorte ?? null)
  if (!r.success) return undefined
  return proximaAberturaDoRecorte(r.data, normalizarFeriados(l?.feriados), agora, fusoSeguro(l?.fuso))
}
