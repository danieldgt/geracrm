import {
  JANELA_CAMPANHA_PADRAO, LOTE_DIARIO_PADRAO, motivoPausaAutomatica, type MotivoPausa,
} from '@geracrm/shared'
import type { Sql } from '../../db/index.js'
import { enviarTextoParaContato, type ResultadoEnvioTexto } from '../atendimento/envio-conversa.js'
import {
  enviarCampanhaParaContato, type PedidoEnvioCampanha, type ResultadoEnvioCampanha,
} from '../atendimento/envio-campanha.js'
import { inicioDoDiaDoTenant, statusAquecimento } from '../atendimento/aquecimento.js'
import { situacaoDoExpediente, type Feriados, type HorarioAtendimento } from '../atendimento/expediente.js'
import { fusoSeguro } from '../plataforma/fuso.js'
import { contagemParaPausa, pausarCampanha, reconciliarOptOuts } from './campanha-destinatario.js'

/**
 * DESPACHANTE DE CAMPANHA — o que faltava para "disparar" significar alguma coisa.
 *
 * ⚠️ Até aqui, `POST /v1/campanhas/:id/disparar` ENFILEIRAVA os envios
 * (`campanha_envio`, `0036`) e **ninguém drenava a fila**. A tela mostrava a
 * campanha "disparando", os destinatários apareciam no painel, e nenhuma
 * mensagem saía. É a pior classe de defeito: a funcionalidade PARECE existir, e
 * a descoberta só viria pelo cliente perguntando por que ninguém respondeu.
 *
 * ⚠️ **Nada aqui fala com o adaptador.** Tudo passa por `enviarTextoParaContato`,
 * que é o gateway único: opt-out, estado do canal, credencial, janela de 24h e
 * pausa de disparo. Campanha é justamente o caminho onde furar o guardrail
 * custaria mais caro — mil mensagens de uma vez.
 *
 * ⚠️ E respeita o AQUECIMENTO (`0037`): o teto diário do número não-oficial é o
 * que separa "campanha" de "número banido". Estourado o teto do dia, a campanha
 * fica onde está e continua amanhã — ela NÃO é marcada como concluída.
 *
 * ── DUAS GERAÇÕES (F1) ───────────────────────────────────────────────────────
 *   LEGADO (`modelo_versao = 1`, estado `disparando`, fila `campanha_envio`): este
 *     trecho de cima, intocado — as campanhas antigas terminam como começaram.
 *   V2 (`modelo_versao = 2`, estados `agendada`/`enviando`, `campanha_destinatario`):
 *     `despacharCampanhasV2DoTenant`, mais abaixo.
 */

/** Envios por passada e por campanha. Rajada de mil não vira mil de uma vez. */
const LOTE = 10

/**
 * Quem entrega. Injetável — o teste exercita o caminho FELIZ sem falar com
 * provedor nenhum, como o despachante de push e o de webhooks já fazem.
 * ⚠️ O padrão da casa é injetar a borda, nunca mockar o módulo: mock silencia
 * quando a assinatura muda; parâmetro quebra o typecheck.
 */
export type EnviarCampanha = (
  tenantId: string, canalId: string, contatoId: string, texto: string, agora: Date,
) => Promise<ResultadoEnvioTexto>

export interface ResultadoDisparo {
  readonly enviados: number
  /** Recusados por política NOSSA (opt-out, janela, pausa) — não são erro. */
  readonly bloqueados: number
  /** Falha de transporte do provedor. */
  readonly falhas: number
  /** Ficaram para amanhã porque o teto de aquecimento do dia acabou. */
  readonly aguardandoAquecimento: number
  /** Esperando: o número está com as ativas suspensas pela qualidade (P11). */
  readonly suspensasPorQualidade: number
  readonly campanhasConcluidas: number
}

const VAZIO: ResultadoDisparo = {
  enviados: 0, bloqueados: 0, falhas: 0, aguardandoAquecimento: 0, suspensasPorQualidade: 0, campanhasConcluidas: 0,
}

interface CampanhaEmCurso {
  id: string
  nome: string
  mensagem: string
  canal_id: string | null
}

/**
 * Uma passada nas campanhas de UM tenant.
 *
 * ⚠️ Roda como DONO (worker) com `tenant_id` explícito — mas o envio entra por
 * `comTenantServico`, ou seja, a escrita da mensagem acontece sob RLS.
 */
export async function despacharCampanhasDoTenant(
  sql: Sql, tenantId: string, agora: Date, enviar: EnviarCampanha = enviarTextoParaContato,
): Promise<ResultadoDisparo> {
  const campanhas = await sql<CampanhaEmCurso[]>`
    SELECT id, nome, mensagem, canal_id
      FROM campanha
     WHERE tenant_id = ${tenantId} AND estado = 'disparando'
     ORDER BY disparada_em ASC NULLS LAST`

  let enviados = 0, bloqueados = 0, falhas = 0, aguardando = 0, concluidas = 0, suspensas = 0

  for (const c of campanhas) {
    // ⚠️ Campanha sem canal não tem por onde sair. Marcar como concluída
    //    esconderia o problema; deixar 'disparando' para sempre também. O
    //    caminho honesto é parar de tentar e deixar a fila intacta — a tela
    //    mostra os pendentes e alguém corrige o cadastro.
    if (!c.canal_id) continue

    /**
     * ⚠️ Número com ATIVAS SUSPENSAS pela Meta (qualidade em queda ou conta
     * restrita, raia P11): campanha é o maior volume não transacional e o maior
     * risco de banimento. Fica onde está — fila intacta, nada marcado como
     * bloqueado — e volta sozinha quando a suspensão sai. O aviso visível é o
     * alerta crítico `qualidade_numero`, que diz "retornos e campanhas suspensos".
     */
    const [susp] = await sql<{ suspensa: boolean }[]>`
      SELECT (ativas_suspensas_em IS NOT NULL) AS suspensa FROM canal_conectado
       WHERE tenant_id = ${tenantId} AND id = ${c.canal_id}`
    if (susp?.suspensa) {
      const [p] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM campanha_envio
         WHERE tenant_id = ${tenantId} AND campanha_id = ${c.id} AND estado = 'pendente'`
      suspensas += p?.n ?? 0
      continue
    }

    /**
     * ⚠️ O teto do dia é lido DENTRO do laço, uma vez por campanha: duas
     * campanhas no mesmo número compartilham o mesmo teto, e ler antes do laço
     * deixaria a segunda gastar o que a primeira já gastou.
     */
    const aquecimento = await comTenantDoWorker(sql, tenantId, (tx) =>
      statusAquecimento(tx, c.canal_id!, agora))
    const cabeHoje = Math.min(LOTE, aquecimento.restante)
    if (cabeHoje <= 0) {
      const [p] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM campanha_envio
         WHERE tenant_id = ${tenantId} AND campanha_id = ${c.id} AND estado = 'pendente'`
      aguardando += p?.n ?? 0
      continue
    }

    const pendentes = await sql<{ id: string; contato_id: string }[]>`
      SELECT id, contato_id FROM campanha_envio
       WHERE tenant_id = ${tenantId} AND campanha_id = ${c.id} AND estado = 'pendente'
       ORDER BY criado_em ASC
       LIMIT ${cabeHoje}`

    for (const envio of pendentes) {
      const r = await enviar(tenantId, c.canal_id, envio.contato_id, c.mensagem, agora)

      if (r.ok) {
        enviados++
        await sql`
          UPDATE campanha_envio
             SET estado = 'enviado', enviado_em = now(), mensagem_id = ${r.mensagemId}
           WHERE tenant_id = ${tenantId} AND id = ${envio.id}`
        continue
      }

      // ⚠️ Recusa NOSSA vira 'bloqueado', falha de transporte vira 'falhou'.
      //    Colapsar as duas faria uma tentativa futura reenviar para quem pediu
      //    para não receber — e o opt-out é invariante, não filtro.
      const estado = r.classe === 'transporte' ? 'falhou' : 'bloqueado'
      if (estado === 'falhou') falhas++
      else bloqueados++
      await sql`
        UPDATE campanha_envio SET estado = ${estado}, enviado_em = now(),
               mensagem_id = ${r.mensagemId ?? null}
         WHERE tenant_id = ${tenantId} AND id = ${envio.id}`
    }

    // Acabou a fila desta campanha? Só então ela conclui.
    const [restam] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM campanha_envio
       WHERE tenant_id = ${tenantId} AND campanha_id = ${c.id} AND estado = 'pendente'`
    if ((restam?.n ?? 0) === 0) {
      await sql`
        UPDATE campanha SET estado = 'concluida'
         WHERE tenant_id = ${tenantId} AND id = ${c.id} AND estado = 'disparando'`
      concluidas++
    }
  }

  return {
    enviados, bloqueados, falhas,
    aguardandoAquecimento: aguardando, suspensasPorQualidade: suspensas, campanhasConcluidas: concluidas,
  }
}

/**
 * ⚠️ `statusAquecimento` foi escrito para a API e usa `tenant_atual()`. O
 * despachante roda como DONO, sem tenant de sessão — sem isto ele leria zero e o
 * teto de aquecimento sumiria justamente no caminho que mais precisa dele.
 */
async function comTenantDoWorker<T>(sql: Sql, tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${tenantId}, true)`
    return fn(tx as unknown as Sql)
  }) as Promise<T>
}


// ═════════════════════════════════════════════════════════════════════════════
// V2 — lote diário, janela, aquecimento, opt-out no envio, pausa automática
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Envios por passada e por campanha (o worker roda a cada 30 s). O lote DIÁRIO é o
 * da campanha; isto só impede que o dia inteiro saia numa rajada de um minuto.
 */
export const LOTE_PASSADA_V2 = 50
/** Linha presa em `enviando` há mais que isto (worker caiu no meio) vira falha. */
export const ENVIANDO_EXPIRA_MIN = 15

/**
 * Quem entrega um destinatário. Injetável (padrão da casa): o teste exercita o laço
 * inteiro sem provedor. O padrão é o envio real, pelo gateway único.
 */
export type EnviarDestinatario = (tenantId: string, p: PedidoEnvioCampanha, agora: Date) => Promise<ResultadoEnvioCampanha>

export interface ResultadoDespachoV2 {
  readonly enviados: number
  /** Recusados por política NOSSA no envio (opt-out, sem telefone, variável sem valor) → `excluida`. */
  readonly excluidos: number
  /** Falha de transporte do provedor → `falhou`. */
  readonly falhas: number
  /** Campanhas que esperaram a janela de envio abrir. */
  readonly foraDaJanela: number
  /** Campanhas que já cumpriram o lote diário. */
  readonly loteDoDiaCumprido: number
  /** Campanhas seguradas pelo teto de aquecimento do número. */
  readonly aguardandoAquecimento: number
  readonly pausadas: number
  readonly concluidas: number
  /** `agendada` que chegou ao início e passou a `enviando`. */
  readonly iniciadas: number
  /** Linhas presas em `enviando` que viraram `falhou/envio_interrompido`. */
  readonly interrompidos: number
}

const ZERO_V2: ResultadoDespachoV2 = {
  enviados: 0, excluidos: 0, falhas: 0, foraDaJanela: 0, loteDoDiaCumprido: 0, aguardandoAquecimento: 0,
  pausadas: 0, concluidas: 0, iniciadas: 0, interrompidos: 0,
}

interface CampanhaV2 {
  id: string
  canal_id: string | null
  template_id: string | null
  mensagem: string | null
  lote_diario: number | null
  janela: HorarioAtendimento | null
  contagem_desde: Date | null
}

type Reivindicada = { id: string; contato_id: string; telefone_chave: string | null }

type Preparo =
  | { acao: 'segurar' }
  | { acao: 'pausou' }
  | { acao: 'fora_da_janela' }
  | { acao: 'lote_cumprido' }
  | { acao: 'aquecimento' }
  | { acao: 'enviar'; linhas: Reivindicada[] }

/**
 * Prepara UMA passada de UMA campanha numa transação curta: reconcilia opt-outs,
 * confere número, taxas, janela, lote do dia e aquecimento, e REIVINDICA as linhas.
 *
 * ⚠️ A trava `campanha_canal:<id>` (advisory, da transação) serializa o cálculo do teto
 *    POR NÚMERO entre workers: duas passadas simultâneas não leem o mesmo "resta 10" e
 *    mandam 20. As linhas em `enviando` contam como já gastas (lote e aquecimento).
 * ⚠️ `FOR UPDATE SKIP LOCKED` na reivindicação: cada linha vai para UM worker só. É o
 *    que garante "nunca envia duas vezes" com dois workers no ar.
 */
async function prepararPassada(tx: Sql, c: CampanhaV2, agora: Date): Promise<Preparo> {
  if (!c.canal_id) return { acao: 'segurar' }
  await tx`SELECT pg_advisory_xact_lock(hashtext(${'campanha_canal:' + c.canal_id}))`
  await reconciliarOptOuts(tx, c.id, agora)

  const [canal] = await tx<{
    arquivado: boolean; suspensa: boolean; horario: HorarioAtendimento | null; feriados: Feriados | null; fuso: string | null
  }[]>`
    SELECT (cc.arquivado_em IS NOT NULL) AS arquivado, (cc.ativas_suspensas_em IS NOT NULL) AS suspensa,
           cfg.horario_atendimento AS horario, cfg.feriados,
           (SELECT t.fuso FROM tenant t WHERE t.id = cc.tenant_id) AS fuso
      FROM canal_conectado cc
      LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
     WHERE cc.tenant_id = tenant_atual() AND cc.id = ${c.canal_id}`
  // Número removido: nada sai, a fila fica intacta e a tela mostra os pendentes.
  if (!canal || canal.arquivado) return { acao: 'segurar' }

  // ⚠️ Qualidade em queda (P11): a campanha PARA e só uma pessoa retoma.
  if (canal.suspensa) {
    return (await pausarCampanha(tx, { campanhaId: c.id, motivo: 'qualidade_numero', agora })) ? { acao: 'pausou' } : { acao: 'segurar' }
  }
  if (await verificarTaxas(tx, c, agora)) return { acao: 'pausou' }

  const fuso = fusoSeguro(canal.fuso)
  const horario = c.janela && Object.keys(c.janela).length > 0 ? c.janela
    : canal.horario && Object.keys(canal.horario).length > 0 ? canal.horario
    : JANELA_CAMPANHA_PADRAO
  if (situacaoDoExpediente(horario, canal.feriados, agora, fuso) !== 'aberto') return { acao: 'fora_da_janela' }

  const desde = await inicioDoDiaDoTenant(tx, agora)
  const [hoje] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM campanha_destinatario
     WHERE tenant_id = tenant_atual() AND campanha_id = ${c.id}
       AND (enviado_em >= ${desde} OR estado = 'enviando')`
  const restanteLote = (c.lote_diario ?? LOTE_DIARIO_PADRAO) - (hoje?.n ?? 0)
  if (restanteLote <= 0) return { acao: 'lote_cumprido' }
  const aquecimento = await statusAquecimento(tx, c.canal_id, agora)
  if (aquecimento.restante <= 0) return { acao: 'aquecimento' }

  const n = Math.min(LOTE_PASSADA_V2, restanteLote, aquecimento.restante)
  // ⚠️ CTE MATERIALIZED, não `id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`: nessa forma o
  //    Postgres pode reavaliar a subconsulta por linha e o UPDATE pega MAIS que n (medido
  //    aqui: n = 3 reivindicou 5). Materializada, a lista é calculada uma vez só.
  const linhas = await tx<Reivindicada[]>`
    WITH alvo AS MATERIALIZED (
      SELECT p.id FROM campanha_destinatario p
       WHERE p.tenant_id = tenant_atual() AND p.campanha_id = ${c.id} AND p.estado = 'pendente'
       ORDER BY p.id LIMIT ${n}
       FOR UPDATE SKIP LOCKED)
    UPDATE campanha_destinatario d
       SET estado = 'enviando', enviando_desde = ${agora}, tentativas = d.tentativas + 1, atualizado_em = ${agora}
      FROM alvo
     WHERE d.tenant_id = tenant_atual() AND d.id = alvo.id
    RETURNING d.id, d.contato_id, d.telefone_chave`
  return { acao: 'enviar', linhas }
}

/** Taxas de opt-out e falha acima do limite → pausa (com alerta). `true` = pausou. */
async function verificarTaxas(tx: Sql, c: CampanhaV2, agora: Date): Promise<boolean> {
  const motivo: MotivoPausa | null = motivoPausaAutomatica(await contagemParaPausa(tx, c.id, c.contagem_desde))
  if (!motivo) return false
  return pausarCampanha(tx, { campanhaId: c.id, motivo, agora })
}

/** Recusa que é do CANAL (não do destinatário): a linha volta para a fila e a passada para. */
const RECUSA_DO_CANAL = new Set([
  'disparo_pausado', 'canal_indisponivel', 'canal_arquivado', 'canal_sem_credencial', 'janela_fechada', 'canal_nao_encontrado',
])

/** O que fazer com a linha depois da tentativa. */
type Desfecho =
  | { tipo: 'enviada'; r: Extract<ResultadoEnvioCampanha, { ok: true }> }
  | { tipo: 'excluida'; motivo: string }
  | { tipo: 'falhou'; codigo: string }
  | { tipo: 'devolver' }
  | { tipo: 'pausar'; motivo: MotivoPausa }

/**
 * ⚠️ Recusa NOSSA vira `excluida` (com o motivo) e falha de TRANSPORTE vira `falhou`.
 *    Colapsar as duas faria a taxa de falha pausar a campanha por causa de opt-out — ou,
 *    pior, uma retentativa mandar para quem pediu para não receber.
 */
export function desfechoDoEnvio(r: ResultadoEnvioCampanha): Desfecho {
  if (r.ok) return { tipo: 'enviada', r }
  if (r.classe === 'transporte') return { tipo: 'falhou', codigo: r.motivo }
  if (r.motivo === 'bloqueado') return { tipo: 'excluida', motivo: 'optout' }
  if (r.motivo === 'sem_telefone') return { tipo: 'excluida', motivo: 'semTelefone' }
  if (r.motivo === 'contato_nao_encontrado') return { tipo: 'excluida', motivo: 'anonimizado' }
  if (r.motivo === 'variavel_sem_valor') return { tipo: 'excluida', motivo: 'variavelSemValor' }
  if (r.motivo === 'template_indisponivel') return { tipo: 'pausar', motivo: 'template_indisponivel' }
  if (RECUSA_DO_CANAL.has(r.motivo)) return { tipo: 'devolver' }
  return { tipo: 'excluida', motivo: r.motivo }
}

async function devolverParaFila(sql: Sql, tenantId: string, ids: readonly string[], agora: Date): Promise<void> {
  if (ids.length === 0) return
  await comTenantDoWorker(sql, tenantId, (tx) => tx`
    UPDATE campanha_destinatario
       SET estado = 'pendente', enviando_desde = NULL, atualizado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ANY(${[...ids]}::uuid[]) AND estado = 'enviando'`)
}

async function gravarDesfecho(sql: Sql, tenantId: string, id: string, d: Desfecho, agora: Date): Promise<void> {
  await comTenantDoWorker(sql, tenantId, (tx) => {
    if (d.tipo === 'enviada') {
      return tx`
        UPDATE campanha_destinatario
           SET estado = 'enviada', wamid = ${d.r.idExterno}, mensagem_id = ${d.r.mensagemId},
               conversa_id = ${d.r.conversaId}, enviado_em = ${agora}, enviando_desde = NULL,
               erro_codigo = NULL, atualizado_em = ${agora}
         WHERE tenant_id = tenant_atual() AND id = ${id}`
    }
    if (d.tipo === 'excluida') {
      return tx`
        UPDATE campanha_destinatario
           SET estado = 'excluida', motivo_exclusao = ${d.motivo}, enviando_desde = NULL, atualizado_em = ${agora}
         WHERE tenant_id = tenant_atual() AND id = ${id}`
    }
    return tx`
      UPDATE campanha_destinatario
         SET estado = 'falhou', erro_codigo = ${d.tipo === 'falhou' ? d.codigo : 'desconhecido'}, enviando_desde = NULL, atualizado_em = ${agora}
       WHERE tenant_id = tenant_atual() AND id = ${id}`
  })
}

/** Depois do lote: a taxa pode ter estourado agora; e a fila pode ter acabado. */
async function fecharPassada(tx: Sql, c: CampanhaV2, agora: Date): Promise<'nada' | 'pausou' | 'concluiu'> {
  const [k] = await tx<{ estado: string }[]>`SELECT estado FROM campanha WHERE tenant_id = tenant_atual() AND id = ${c.id}`
  if (k?.estado !== 'enviando') return 'nada'
  if (await verificarTaxas(tx, c, agora)) return 'pausou'
  const [restam] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM campanha_destinatario
     WHERE tenant_id = tenant_atual() AND campanha_id = ${c.id} AND estado IN ('pendente', 'enviando')`
  if ((restam?.n ?? 0) > 0) return 'nada'
  const conc = await tx`
    UPDATE campanha SET estado = 'concluida', concluida_em = ${agora}, atualizado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${c.id} AND estado = 'enviando' RETURNING id`
  return conc.length > 0 ? 'concluiu' : 'nada'
}

/**
 * Uma passada nas campanhas v2 de UM tenant.
 *
 * ⚠️ O envio de cada destinatário acontece FORA de transação (rede nunca com transação
 *    aberta): reivindica (commit) → envia → grava o desfecho (commit). Se o processo cair
 *    entre o envio e o desfecho, a linha fica em `enviando` e, passados 15 min, vira
 *    `falhou/envio_interrompido` — NUNCA volta a `pendente`: não dá para saber se a
 *    primeira saiu, e reenviar é mandar duas vezes.
 * ⚠️ O opt-out é conferido NO ENVIO (gateway + `recebe_campanhas`), não só no snapshot:
 *    quem pediu para sair depois do iniciar não recebe.
 */
export async function despacharCampanhasV2DoTenant(
  sql: Sql, tenantId: string, agora: Date, enviar: EnviarDestinatario = enviarCampanhaParaContato,
): Promise<ResultadoDespachoV2> {
  const r = { ...ZERO_V2 }

  r.interrompidos = (await comTenantDoWorker(sql, tenantId, (tx) => tx`
    UPDATE campanha_destinatario
       SET estado = 'falhou', erro_codigo = 'envio_interrompido', enviando_desde = NULL, atualizado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND estado = 'enviando'
       AND enviando_desde < ${agora}::timestamptz - make_interval(mins => ${ENVIANDO_EXPIRA_MIN})
    RETURNING id`)).length

  r.iniciadas = (await comTenantDoWorker(sql, tenantId, (tx) => tx`
    UPDATE campanha SET estado = 'enviando', atualizado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND modelo_versao = 2 AND estado = 'agendada'
       AND (inicio_em IS NULL OR inicio_em <= ${agora})
    RETURNING id`)).length

  const campanhas = await comTenantDoWorker(sql, tenantId, (tx) => tx<CampanhaV2[]>`
    SELECT id, canal_id, template_id, mensagem, lote_diario, janela, contagem_desde
      FROM campanha
     WHERE tenant_id = tenant_atual() AND modelo_versao = 2 AND estado = 'enviando'
     ORDER BY iniciada_em ASC NULLS LAST, id`)

  for (const c of campanhas) {
    const preparo = await comTenantDoWorker(sql, tenantId, (tx) => prepararPassada(tx, c, agora))
    if (preparo.acao === 'pausou') { r.pausadas++; continue }
    if (preparo.acao === 'fora_da_janela') { r.foraDaJanela++; continue }
    if (preparo.acao === 'lote_cumprido') { r.loteDoDiaCumprido++; continue }
    if (preparo.acao === 'aquecimento') { r.aguardandoAquecimento++; continue }
    if (preparo.acao === 'segurar') continue

    const fila = [...preparo.linhas]
    while (fila.length > 0) {
      const linha = fila.shift()!

      // Mesma chave de telefone de outro destinatário que JÁ recebeu: não manda de novo.
      const dup = linha.telefone_chave
        ? (await comTenantDoWorker(sql, tenantId, (tx) => tx<{ id: string }[]>`
            SELECT id FROM campanha_destinatario
             WHERE tenant_id = tenant_atual() AND campanha_id = ${c.id} AND telefone_chave = ${linha.telefone_chave}
               AND id <> ${linha.id} AND enviado_em IS NOT NULL
             LIMIT 1`)).length > 0
        : false
      const desfecho: Desfecho = dup
        ? { tipo: 'excluida', motivo: 'telefoneDuplicado' }
        : desfechoDoEnvio(await enviar(tenantId, {
            campanhaId: c.id, canalId: c.canal_id!, contatoId: linha.contato_id,
            templateId: c.template_id, texto: c.template_id ? null : c.mensagem,
          }, agora))

      if (desfecho.tipo === 'devolver' || desfecho.tipo === 'pausar') {
        await devolverParaFila(sql, tenantId, [linha.id, ...fila.map((l) => l.id)], agora)
        fila.length = 0
        if (desfecho.tipo === 'pausar') {
          const pausou = await comTenantDoWorker(sql, tenantId, (tx) => pausarCampanha(tx, { campanhaId: c.id, motivo: desfecho.motivo, agora }))
          if (pausou) r.pausadas++
        }
        break
      }
      await gravarDesfecho(sql, tenantId, linha.id, desfecho, agora)
      if (desfecho.tipo === 'enviada') r.enviados++
      else if (desfecho.tipo === 'excluida') r.excluidos++
      else r.falhas++
    }

    const fim = await comTenantDoWorker(sql, tenantId, (tx) => fecharPassada(tx, c, agora))
    if (fim === 'pausou') r.pausadas++
    if (fim === 'concluiu') r.concluidas++
  }
  return r
}

// ═════════════════════════════════════════════════════════════════════════════
// A passada global (worker)
// ═════════════════════════════════════════════════════════════════════════════

export interface DepsDespacho {
  readonly enviar?: EnviarCampanha
  readonly enviarV2?: EnviarDestinatario
  /** Teste: só este tenant (o worker real varre todos, como dono). */
  readonly somenteTenant?: string
}

/** Uma passada por todos os tenants com campanha em curso (legado e v2). */
export async function despacharCampanhas(
  sql: Sql, agora: Date, deps: DepsDespacho = {},
): Promise<ResultadoDisparo & { readonly v2: ResultadoDespachoV2 }> {
  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('campanha_despacho')) AS ok`
  if (!trava?.ok) return { ...VAZIO, v2: ZERO_V2 }

  try {
    const tenants = deps.somenteTenant
      ? [{ tenant_id: deps.somenteTenant }]
      : await sql<{ tenant_id: string }[]>`
          SELECT DISTINCT tenant_id FROM campanha WHERE estado IN ('disparando', 'agendada', 'enviando')`

    let enviados = 0, bloqueados = 0, falhas = 0, aguardando = 0, concluidas = 0, suspensas = 0
    const v2: Record<keyof ResultadoDespachoV2, number> = { ...ZERO_V2 }
    for (const { tenant_id } of tenants) {
      const r = await despacharCampanhasDoTenant(sql, tenant_id, agora, deps.enviar ?? enviarTextoParaContato)
      enviados += r.enviados; bloqueados += r.bloqueados; falhas += r.falhas
      aguardando += r.aguardandoAquecimento; concluidas += r.campanhasConcluidas; suspensas += r.suspensasPorQualidade
      const n = await despacharCampanhasV2DoTenant(sql, tenant_id, agora, deps.enviarV2 ?? enviarCampanhaParaContato)
      for (const k of Object.keys(v2) as (keyof ResultadoDespachoV2)[]) v2[k] += n[k]
    }
    return {
      enviados, bloqueados, falhas,
      aguardandoAquecimento: aguardando, suspensasPorQualidade: suspensas, campanhasConcluidas: concluidas,
      v2,
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('campanha_despacho'))`
  }
}
