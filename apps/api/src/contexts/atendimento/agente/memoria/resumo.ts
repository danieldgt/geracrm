import { comTenantServico, type Sql } from '../../../../db/index.js'
import { lerRascunho } from '../../../pedido/montagem.js'

/**
 * RESUMO DA SESSÃO — a memória de curto prazo da venda (`agente_sessao.resumo`).
 *
 * A cada N turnos o turno pede um resumo do que aconteceu desde o último
 * (`resumo_ate_mensagem_id`), para que o prompt não precise reler a conversa
 * inteira e para que amanhã o agente saiba onde parou.
 *
 * Duas formas:
 *   `resumirSessao(tx, …)`            — EXTRATIVA, só banco: últimas intenções do
 *                                       cliente, pedido aberto, slots, fase. Sem
 *                                       modelo, sem rede, sem custo. É o padrão.
 *   `resumirSessaoComModelo(tenant…)` — a mesma leitura, um modelo injetado para
 *                                       escrever o texto, e a gravação depois.
 *
 * ⚠️ O modelo é rede externa, e rede externa com transação aberta esgota o
 *    pool. Por isso a versão com modelo NÃO recebe `tx`: abre uma transação
 *    para ler, chama o modelo fora, abre outra para gravar — e só grava se
 *    ninguém resumiu no meio do caminho.
 */

export const MAX_RESUMO = 400
const MAX_MENSAGENS_POR_RESUMO = 200
const FALAS_DO_CLIENTE_NO_RESUMO = 3
const MAX_POR_FALA = 90

export type ResultadoResumo =
  | { readonly resultado: 'ok'; readonly resumo: string; readonly ateMensagemId: string; readonly mensagensNovas: number }
  | { readonly resultado: 'sem_mensagens_novas' }
  | { readonly resultado: 'sessao_nao_encontrada' }

export interface FalaParaResumo {
  readonly de: 'cliente' | 'nos'
  readonly texto: string
}

export interface MaterialDoResumo {
  readonly resumoAnterior: string | null
  readonly falas: readonly FalaParaResumo[]
  readonly pedido: { readonly itens: number; readonly totalCentavos: number; readonly estado: string } | null
  readonly slots: Readonly<Record<string, string>>
  readonly fase: string
  readonly estado: string
  readonly motivoSaida: string | null
}

function cortar(texto: string, max: number): string {
  const t = texto.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

function textoDaFala(tipo: string, c: Record<string, unknown>): string {
  const texto = typeof c['texto'] === 'string' ? c['texto'] : ''
  if (tipo === 'texto') return texto
  if (tipo === 'audio') return typeof c['transcricao'] === 'string' ? c['transcricao'] : '[áudio]'
  if (tipo === 'imagem') return typeof c['legenda'] === 'string' ? `[imagem] ${c['legenda']}` : '[imagem]'
  return texto || `[${tipo}]`
}

/**
 * O resumo EXTRATIVO: montado de pedaços do que já está no banco, sem modelo.
 * Pura — testável sem banco. Sempre ≤ `max` caracteres.
 */
export function montarResumoExtrativo(m: MaterialDoResumo, max = MAX_RESUMO): string {
  const partes: string[] = []

  const doCliente = m.falas.filter((f) => f.de === 'cliente' && f.texto.trim()).slice(-FALAS_DO_CLIENTE_NO_RESUMO)
  if (doCliente.length > 0) partes.push(`Cliente: ${doCliente.map((f) => cortar(f.texto, MAX_POR_FALA)).join(' / ')}`)
  else if (m.resumoAnterior) partes.push(cortar(m.resumoAnterior, 160))

  if (m.pedido && m.pedido.itens > 0) {
    partes.push(`Pedido: ${m.pedido.itens} item(ns), R$ ${(m.pedido.totalCentavos / 100).toFixed(2)} (${m.pedido.estado})`)
  }
  const slots = Object.entries(m.slots).filter(([, v]) => typeof v === 'string' && v.trim())
  if (slots.length > 0) partes.push(`Sabemos: ${slots.map(([k, v]) => `${k}=${cortar(v, 40)}`).join(', ')}`)

  if (m.estado === 'entregue') partes.push(`Entregue a humano${m.motivoSaida ? ` (${m.motivoSaida})` : ''}`)
  else if (m.estado === 'encerrada') partes.push(`Encerrada${m.motivoSaida ? ` (${m.motivoSaida})` : ''}`)
  else partes.push(`Fase: ${m.fase}`)

  // Antes do novo trecho, um fio do resumo anterior — curto, para não comer o teto.
  if (doCliente.length > 0 && m.resumoAnterior) {
    const antes = cortar(m.resumoAnterior.replace(/^Antes: [^.]*\. /, ''), 100)
    partes.unshift(`Antes: ${antes}`)
  }
  return cortar(partes.join('. '), max)
}

interface SessaoLida {
  id: string; conversa_id: string; resumo: string | null; resumo_ate_mensagem_id: string | null
  pedido_id: string | null; slots: Record<string, string>; fase: string; estado: string; motivo_saida: string | null
}

interface Leitura {
  readonly sessao: SessaoLida
  readonly material: MaterialDoResumo
  readonly ultimaMensagemId: string | null
  readonly mensagensNovas: number
}

async function lerMaterial(tx: Sql, sessaoId: string): Promise<Leitura | null> {
  const [s] = await tx<SessaoLida[]>`
    SELECT id, conversa_id, resumo, resumo_ate_mensagem_id, pedido_id,
           coalesce(slots, '{}'::jsonb) AS slots, fase, estado, motivo_saida
      FROM agente_sessao WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
  if (!s) return null

  // A âncora é (criado_em, id) da última mensagem resumida — a chave da partição.
  const [ancora] = s.resumo_ate_mensagem_id
    ? await tx<{ criado_em: Date }[]>`
        SELECT criado_em FROM mensagem
         WHERE tenant_id = tenant_atual() AND conversa_id = ${s.conversa_id} AND id = ${s.resumo_ate_mensagem_id}`
    : []
  const mensagens = await tx<{ id: string; direcao: string; tipo: string; conteudo: Record<string, unknown> }[]>`
    SELECT id, direcao, tipo, conteudo FROM mensagem
     WHERE tenant_id = tenant_atual() AND conversa_id = ${s.conversa_id} AND tipo <> 'sistema'
       AND ${ancora && s.resumo_ate_mensagem_id
         ? tx`(criado_em, id) > (${ancora.criado_em}::timestamptz, ${s.resumo_ate_mensagem_id}::uuid)`
         : tx`true`}
     ORDER BY criado_em, id
     LIMIT ${MAX_MENSAGENS_POR_RESUMO}`

  const pedidoId = s.pedido_id ?? (await tx<{ id: string }[]>`
    SELECT id FROM pedido
     WHERE tenant_id = tenant_atual() AND conversa_id = ${s.conversa_id}
       AND estado IN ('rascunho', 'aguardando_confirmacao')
     ORDER BY criado_em DESC LIMIT 1`)[0]?.id ?? null
  const rascunho = pedidoId ? await lerRascunho(tx, pedidoId) : null

  return {
    sessao: s,
    material: {
      resumoAnterior: s.resumo,
      falas: mensagens.map((m) => ({ de: m.direcao === 'entrante' ? 'cliente' : 'nos', texto: textoDaFala(m.tipo, m.conteudo) } as const)),
      pedido: rascunho ? { itens: rascunho.itens.length, totalCentavos: rascunho.pedido.totalCentavos, estado: rascunho.pedido.estado } : null,
      slots: s.slots ?? {},
      fase: s.fase,
      estado: s.estado,
      motivoSaida: s.motivo_saida,
    },
    ultimaMensagemId: mensagens.length > 0 ? mensagens[mensagens.length - 1]!.id : null,
    mensagensNovas: mensagens.length,
  }
}

/**
 * Grava só se a âncora ainda é a que lemos — duas rodadas concorrentes não
 * sobrescrevem uma à outra. `false` = alguém resumiu antes.
 */
async function gravarResumo(tx: Sql, p: { sessaoId: string; ancoraLida: string | null; resumo: string; ateMensagemId: string }): Promise<boolean> {
  const r = await tx`
    UPDATE agente_sessao
       SET resumo = ${p.resumo}, resumo_ate_mensagem_id = ${p.ateMensagemId}
     WHERE tenant_id = tenant_atual() AND id = ${p.sessaoId}
       AND resumo_ate_mensagem_id IS NOT DISTINCT FROM ${p.ancoraLida}::uuid`
  return r.count === 1
}

/** Resumo extrativo, dentro da transação de quem chama. */
export async function resumirSessao(tx: Sql, sessaoId: string, opcoes: { max?: number } = {}): Promise<ResultadoResumo> {
  const leitura = await lerMaterial(tx, sessaoId)
  if (!leitura) return { resultado: 'sessao_nao_encontrada' }
  if (!leitura.ultimaMensagemId) return { resultado: 'sem_mensagens_novas' }
  const resumo = montarResumoExtrativo(leitura.material, opcoes.max ?? MAX_RESUMO)
  await gravarResumo(tx, { sessaoId, ancoraLida: leitura.sessao.resumo_ate_mensagem_id, resumo, ateMensagemId: leitura.ultimaMensagemId })
  return { resultado: 'ok', resumo, ateMensagemId: leitura.ultimaMensagemId, mensagensNovas: leitura.mensagensNovas }
}

/** O texto que o modelo recebe para escrever o resumo — o material, legível. */
export function materialParaModelo(m: MaterialDoResumo): string {
  const linhas = [
    m.resumoAnterior ? `Resumo anterior: ${m.resumoAnterior}` : '',
    ...m.falas.map((f) => `${f.de === 'cliente' ? 'Cliente' : 'Vendedor'}: ${cortar(f.texto, 300)}`),
    m.pedido ? `Pedido aberto: ${m.pedido.itens} item(ns), total R$ ${(m.pedido.totalCentavos / 100).toFixed(2)}, estado ${m.pedido.estado}` : 'Sem pedido aberto',
    Object.keys(m.slots).length ? `Slots: ${Object.entries(m.slots).map(([k, v]) => `${k}=${v}`).join(', ')}` : '',
    `Fase: ${m.fase}; estado da sessão: ${m.estado}${m.motivoSaida ? ` (${m.motivoSaida})` : ''}`,
  ]
  return linhas.filter(Boolean).join('\n')
}

/**
 * Resumo escrito por um modelo injetado. Lê numa transação, chama o modelo
 * FORA dela, grava noutra. Se o modelo falhar ou devolver vazio, cai no
 * extrativo — resumo nunca fica em branco por causa de rede.
 */
export async function resumirSessaoComModelo(
  tenantId: string, sessaoId: string,
  llm: (material: string) => Promise<string>,
  opcoes: { max?: number } = {},
): Promise<ResultadoResumo | { readonly resultado: 'conflito' }> {
  const max = opcoes.max ?? MAX_RESUMO
  const leitura = await comTenantServico(tenantId, (tx) => lerMaterial(tx, sessaoId))
  if (!leitura) return { resultado: 'sessao_nao_encontrada' }
  if (!leitura.ultimaMensagemId) return { resultado: 'sem_mensagens_novas' }

  let resumo: string
  try {
    resumo = cortar(await llm(materialParaModelo(leitura.material)), max)
  } catch {
    resumo = ''
  }
  if (!resumo) resumo = montarResumoExtrativo(leitura.material, max)

  const gravou = await comTenantServico(tenantId, (tx) => gravarResumo(tx, {
    sessaoId, ancoraLida: leitura.sessao.resumo_ate_mensagem_id, resumo, ateMensagemId: leitura.ultimaMensagemId!,
  }))
  if (!gravou) return { resultado: 'conflito' }
  return { resultado: 'ok', resumo, ateMensagemId: leitura.ultimaMensagemId, mensagensNovas: leitura.mensagensNovas }
}
