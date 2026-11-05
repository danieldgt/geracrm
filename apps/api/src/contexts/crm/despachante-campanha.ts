import {
  JANELA_CAMPANHA_PADRAO, LOTE_DIARIO_PADRAO, classificarErroMeta, limitarJanelaMarketing, motivoPausaAutomatica,
  type MotivoPausa,
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
import { motivoNoEnvio, publicoGravado, type Publico } from './campanha-publico.js'

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
     WHERE tenant_id = ${tenantId} AND estado = 'disparando' AND modelo_versao = 1
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
// V2 — lote diário, janela, aquecimento, tier, intervalo, opt-out no envio, pausa
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Envios por passada e por campanha (o worker roda a cada 30 s). O lote DIÁRIO é da
 * campanha; isto só impede que o dia saia numa rajada. No NÃO oficial, além do teto
 * baixo, o intervalo mínimo aleatório por número (3–10 s, `numero_throttle`) faz sair
 * no máximo um por passada: rajada é o que bane o número.
 */
export const LOTE_PASSADA_OFICIAL = 50
export const LOTE_PASSADA_NAO_OFICIAL = 3
/** Intervalo mínimo aleatório entre dois envios do mesmo número não oficial (segundos). */
export const INTERVALO_NAO_OFICIAL_S = { min: 3, max: 10 } as const
/** Tier da Meta não informado no número: o limite de portfólio não verificado (#117). */
export const TIER_PADRAO = 250
/** Linha presa em `enviando` há mais que isto (worker caiu no meio) é resolvida pela varredura. */
export const ENVIANDO_EXPIRA_MIN = 15

/**
 * Quem entrega um destinatário. Injetável (padrão da casa): o teste exercita o laço
 * inteiro sem provedor. O padrão é o envio real, pelo gateway único.
 */
export type EnviarDestinatario = (tenantId: string, p: PedidoEnvioCampanha, agora: Date) => Promise<ResultadoEnvioCampanha>

export interface ResultadoDespachoV2 {
  readonly enviados: number
  /** Recusados por política NOSSA (opt-out, sem telefone, exclusão reavaliada no envio) → `excluida`. */
  readonly excluidos: number
  /** Falha de transporte do provedor → `falhou`. */
  readonly falhas: number
  /** Campanhas que esperaram a janela de envio abrir. */
  readonly foraDaJanela: number
  /** Campanhas que já cumpriram o lote diário. */
  readonly loteDoDiaCumprido: number
  /** Campanhas seguradas pelo teto de aquecimento do número. */
  readonly aguardandoAquecimento: number
  /** Campanhas seguradas pelo tier do número oficial (contatos distintos em 24 h). */
  readonly aguardandoTier: number
  /** Campanhas esperando o intervalo mínimo do número não oficial. */
  readonly aguardandoIntervalo: number
  /** Campanhas paradas porque o número não pode enviar (arquivado, desconectado, pausado, sem credencial). */
  readonly bloqueadas: number
  readonly pausadas: number
  readonly concluidas: number
  /** `agendada` que chegou ao início e passou a `enviando`. */
  readonly iniciadas: number
  /** Linhas presas em `enviando` resolvidas pela varredura (de volta à fila, enviada ou falhou). */
  readonly interrompidos: number
}

const ZERO_V2: ResultadoDespachoV2 = {
  enviados: 0, excluidos: 0, falhas: 0, foraDaJanela: 0, loteDoDiaCumprido: 0, aguardandoAquecimento: 0,
  aguardandoTier: 0, aguardandoIntervalo: 0, bloqueadas: 0, pausadas: 0, concluidas: 0, iniciadas: 0, interrompidos: 0,
}

interface CampanhaV2 {
  id: string
  canal_id: string | null
  template_id: string | null
  mensagem: string | null
  lote_diario: number | null
  janela: HorarioAtendimento | null
  contagem_desde: Date | null
  publico: unknown
}

interface CanalDoNumero {
  tipo: string; estado: string; arquivado: boolean; suspensa: boolean; pausado: boolean; temCredencial: boolean
  tier: number | null; horario: HorarioAtendimento | null; feriados: Feriados | null; fuso: string | null
}

async function lerCanalDoNumero(tx: Sql, canalId: string): Promise<CanalDoNumero | null> {
  const [c] = await tx<CanalDoNumero[]>`
    SELECT cc.tipo, cc.estado, (cc.arquivado_em IS NOT NULL) AS arquivado, (cc.ativas_suspensas_em IS NOT NULL) AS suspensa,
           coalesce(cfg.disparo_pausado, false) AS pausado, (cc.credenciais_cifradas IS NOT NULL) AS "temCredencial",
           (SELECT nw.tier FROM numero_whatsapp nw WHERE nw.tenant_id = cc.tenant_id AND nw.canal_id = cc.id) AS tier,
           cfg.horario_atendimento AS horario, cfg.feriados,
           (SELECT t.fuso FROM tenant t WHERE t.id = cc.tenant_id) AS fuso
      FROM canal_conectado cc
      LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
     WHERE cc.tenant_id = tenant_atual() AND cc.id = ${canalId}`
  return c ?? null
}

/** O número pode enviar agora? (B5: conferido ANTES de reivindicar — sem `tentativas` em laço.) */
function numeroBloqueado(c: CanalDoNumero | null): boolean {
  return !c || c.arquivado || c.estado === 'suspenso' || c.estado === 'desconectado' || c.pausado || !c.temCredencial
}

type Verificacao =
  | { acao: 'segurar' } | { acao: 'bloqueada' } | { acao: 'pausou' } | { acao: 'fora_da_janela' }
  | { acao: 'enviar'; canal: CanalDoNumero; publico: Publico }

/**
 * Confere UMA campanha antes da passada (transação curta, sob a trava do número):
 * reconcilia opt-outs, número, qualidade, taxas e janela. Não reivindica nada.
 */
async function verificarCampanha(tx: Sql, c: CampanhaV2, agora: Date): Promise<Verificacao> {
  if (!c.canal_id) return { acao: 'bloqueada' }
  await tx`SELECT pg_advisory_xact_lock(hashtext(${'campanha_canal:' + c.canal_id}))`
  await reconciliarOptOuts(tx, c.id, agora)
  const canal = await lerCanalDoNumero(tx, c.canal_id)
  if (numeroBloqueado(canal)) return { acao: 'bloqueada' }
  // ⚠️ Qualidade em queda (P11): a campanha PARA e só uma pessoa retoma.
  if (canal!.suspensa) {
    return (await pausarCampanha(tx, { campanhaId: c.id, motivo: 'qualidade_numero', agora })) ? { acao: 'pausou' } : { acao: 'segurar' }
  }
  if (await verificarTaxas(tx, c, agora)) return { acao: 'pausou' }

  const fuso = fusoSeguro(canal!.fuso)
  // Janela: a da campanha (já validada em 08:00–21:00); senão o expediente do número
  // RECORTADO à faixa de marketing; senão a padrão.
  const horario: HorarioAtendimento = c.janela && Object.keys(c.janela).length > 0 ? c.janela
    : canal!.horario && Object.keys(canal!.horario).length > 0
      ? limitarJanelaMarketing(canal!.horario as Record<string, { de: string; ate: string } | null>).horario
      : JANELA_CAMPANHA_PADRAO
  if (situacaoDoExpediente(horario, canal!.feriados, agora, fuso) !== 'aberto') return { acao: 'fora_da_janela' }
  return { acao: 'enviar', canal: canal!, publico: publicoGravado(c.publico ?? {}) }
}

/** Taxas de opt-out e falha acima do limite → pausa (com alerta). `true` = pausou. */
async function verificarTaxas(tx: Sql, c: CampanhaV2, agora: Date): Promise<boolean> {
  const motivo: MotivoPausa | null = motivoPausaAutomatica(await contagemParaPausa(tx, c.id, c.contagem_desde))
  if (!motivo) return false
  return pausarCampanha(tx, { campanhaId: c.id, motivo, agora })
}

type Reivindicada = { id: string; contato_id: string; telefone_chave: string | null }

type Passo =
  | { tipo: 'enviar'; linha: Reivindicada }
  | { tipo: 'excluiu' }
  | { tipo: 'parar'; motivo: 'estado' | 'bloqueada' | 'lote' | 'aquecimento' | 'tier' | 'intervalo' | 'vazia' }

/**
 * Reivindica UMA linha para envio, numa transação curta sob a trava do número
 * (`campanha_canal`), na ordem:
 *   1. a campanha ainda está `enviando` e o número ainda pode enviar (M1);
 *   2. lote do dia e aquecimento (linhas em `enviando` de hoje contam como gastas);
 *   3. a linha (`FOR UPDATE SKIP LOCKED`: cada linha vai para UM worker só);
 *   4. exclusões reavaliadas no envio e telefone repetido → `excluida`, sem gastar cota;
 *   5. TIER do oficial: vaga por contato distinto em 24 h (`numero_conversa_iniciada`,
 *      INSERT … ON CONFLICT DO NOTHING); contato que já tem vaga na janela não gasta outra;
 *   6. INTERVALO do não oficial (`numero_throttle`, UPDATE … RETURNING atômico);
 *   7. só então `enviando` (+1 tentativa).
 * Faltou vaga (tier, intervalo, lote): nada muda na linha — ela continua na fila.
 */
async function reivindicarUm(tx: Sql, c: CampanhaV2, publico: Publico, agora: Date): Promise<Passo> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${'campanha_canal:' + c.canal_id}))`
  const [k] = await tx<{ estado: string }[]>`SELECT estado FROM campanha WHERE tenant_id = tenant_atual() AND id = ${c.id}`
  if (k?.estado !== 'enviando') return { tipo: 'parar', motivo: 'estado' }
  const canal = await lerCanalDoNumero(tx, c.canal_id!)
  if (numeroBloqueado(canal) || canal!.suspensa) return { tipo: 'parar', motivo: 'bloqueada' }

  const desde = await inicioDoDiaDoTenant(tx, agora)
  const [hoje] = await tx<{ n: number }[]>`
    SELECT (SELECT count(*) FROM campanha_destinatario
             WHERE tenant_id = tenant_atual() AND campanha_id = ${c.id} AND enviado_em >= ${desde})
         + (SELECT count(*) FROM campanha_destinatario
             WHERE tenant_id = tenant_atual() AND campanha_id = ${c.id} AND estado = 'enviando' AND enviando_desde >= ${desde}) AS n`
  if (Number(hoje?.n ?? 0) >= (c.lote_diario ?? LOTE_DIARIO_PADRAO)) return { tipo: 'parar', motivo: 'lote' }
  if ((await statusAquecimento(tx, c.canal_id!, agora)).restante <= 0) return { tipo: 'parar', motivo: 'aquecimento' }

  const [linha] = await tx<Reivindicada[]>`
    SELECT id, contato_id, telefone_chave FROM campanha_destinatario
     WHERE tenant_id = tenant_atual() AND campanha_id = ${c.id} AND estado = 'pendente'
     ORDER BY id LIMIT 1
     FOR UPDATE SKIP LOCKED`
  if (!linha) return { tipo: 'parar', motivo: 'vazia' }

  const excluir = async (motivo: string): Promise<Passo> => {
    await tx`UPDATE campanha_destinatario SET estado = 'excluida', motivo_exclusao = ${motivo}, atualizado_em = ${agora}
              WHERE tenant_id = tenant_atual() AND id = ${linha.id}`
    return { tipo: 'excluiu' }
  }
  const motivo = await motivoNoEnvio(tx, { campanhaId: c.id, contatoId: linha.contato_id, publico, agora })
  if (motivo) return excluir(motivo)
  if (linha.telefone_chave) {
    const [dup] = await tx`
      SELECT 1 FROM campanha_destinatario
       WHERE tenant_id = tenant_atual() AND campanha_id = ${c.id} AND telefone_chave = ${linha.telefone_chave}
         AND id <> ${linha.id} AND (enviado_em IS NOT NULL OR estado = 'enviando') LIMIT 1`
    if (dup) return excluir('telefoneDuplicado')
  }

  if (canal!.tipo === 'whatsapp_oficial') {
    const janela24h = tx`${agora}::timestamptz - interval '24 hours'`
    const [vaga] = await tx<{ ja: boolean; usados: number }[]>`
      SELECT EXISTS (SELECT 1 FROM numero_conversa_iniciada
                      WHERE tenant_id = tenant_atual() AND canal_id = ${c.canal_id} AND contato_id = ${linha.contato_id}
                        AND iniciada_em > ${janela24h}) AS ja,
             (SELECT count(DISTINCT contato_id) FROM numero_conversa_iniciada
               WHERE tenant_id = tenant_atual() AND canal_id = ${c.canal_id} AND iniciada_em > ${janela24h})::int AS usados`
    if (!vaga?.ja) {
      if ((vaga?.usados ?? 0) >= (canal!.tier ?? TIER_PADRAO)) return { tipo: 'parar', motivo: 'tier' }
      await tx`INSERT INTO numero_conversa_iniciada (tenant_id, canal_id, contato_id, iniciada_em)
               VALUES (tenant_atual(), ${c.canal_id}, ${linha.contato_id}, ${agora})
               ON CONFLICT DO NOTHING`
    }
  } else {
    const espera = INTERVALO_NAO_OFICIAL_S.min * 1000
      + Math.floor(Math.random() * (INTERVALO_NAO_OFICIAL_S.max - INTERVALO_NAO_OFICIAL_S.min) * 1000)
    await tx`INSERT INTO numero_throttle (tenant_id, canal_id, proximo_envio_permitido_em)
             VALUES (tenant_atual(), ${c.canal_id}, ${agora}) ON CONFLICT DO NOTHING`
    const ok = await tx`
      UPDATE numero_throttle SET proximo_envio_permitido_em = ${agora}::timestamptz + make_interval(secs => ${espera / 1000})
       WHERE tenant_id = tenant_atual() AND canal_id = ${c.canal_id} AND proximo_envio_permitido_em <= ${agora}
      RETURNING 1`
    if (ok.length === 0) return { tipo: 'parar', motivo: 'intervalo' }
  }

  await tx`UPDATE campanha_destinatario
              SET estado = 'enviando', enviando_desde = ${agora}, tentativas = tentativas + 1, atualizado_em = ${agora}
            WHERE tenant_id = tenant_atual() AND id = ${linha.id}`
  return { tipo: 'enviar', linha }
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
 *    Erro da Meta de NÚMERO EM RISCO (131031, 131048, 131056, 130429, 368) pausa NA HORA e
 *    devolve a linha (ela não saiu). Erro do destinatário fica como `falhou` com o código
 *    — e fora da taxa de falha (`contagemParaPausa`).
 */
export function desfechoDoEnvio(r: ResultadoEnvioCampanha): Desfecho {
  if (r.ok) return { tipo: 'enviada', r }
  if (r.classe === 'transporte') {
    if (classificarErroMeta(r.codigo) === 'numero_em_risco') return { tipo: 'pausar', motivo: 'numero_em_risco' }
    return { tipo: 'falhou', codigo: r.codigo ?? r.motivo }
  }
  if (r.motivo === 'bloqueado') return { tipo: 'excluida', motivo: 'optout' }
  if (r.motivo === 'sem_telefone') return { tipo: 'excluida', motivo: 'semTelefone' }
  if (r.motivo === 'contato_nao_encontrado' || r.motivo === 'contato_anonimizado') return { tipo: 'excluida', motivo: 'anonimizado' }
  if (r.motivo === 'variavel_sem_valor') return { tipo: 'excluida', motivo: 'variavelSemValor' }
  if (r.motivo === 'template_indisponivel') return { tipo: 'pausar', motivo: 'template_indisponivel' }
  if (RECUSA_DO_CANAL.has(r.motivo)) return { tipo: 'devolver' }
  return { tipo: 'excluida', motivo: r.motivo }
}

async function devolverParaFila(sql: Sql, tenantId: string, id: string, agora: Date): Promise<void> {
  await comTenantDoWorker(sql, tenantId, (tx) => tx`
    UPDATE campanha_destinatario
       SET estado = 'pendente', enviando_desde = NULL, atualizado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${id} AND estado = 'enviando'`)
}

/**
 * Grava o desfecho. ⚠️ B1: o webhook de entregue/lida pode chegar ANTES de gravarmos o
 * wamid (ele vem rápido, o desfecho grava depois). Por isso o status já avançado da
 * `mensagem` (o tique do inbox, gravado por `registrarStatusMensagem`) é aplicado aqui.
 */
async function gravarDesfecho(sql: Sql, tenantId: string, id: string, d: Desfecho, agora: Date): Promise<void> {
  await comTenantDoWorker(sql, tenantId, async (tx) => {
    if (d.tipo === 'enviada') {
      const [m] = await tx<{ status: string | null }[]>`
        SELECT status FROM mensagem
         WHERE tenant_id = tenant_atual() AND id_externo = ${d.r.idExterno} AND direcao = 'saliente' LIMIT 1`
      const st = m?.status ?? 'enviada'
      const estado = st === 'lida' ? 'lida' : st === 'entregue' ? 'entregue' : st === 'falhou' ? 'falhou' : 'enviada'
      await tx`
        UPDATE campanha_destinatario
           SET estado = ${estado}, wamid = ${d.r.idExterno}, mensagem_id = ${d.r.mensagemId},
               conversa_id = ${d.r.conversaId}, enviado_em = ${agora}, enviando_desde = NULL,
               entregue_em = ${estado === 'entregue' || estado === 'lida' ? agora : null},
               lido_em = ${estado === 'lida' ? agora : null},
               erro_codigo = ${estado === 'falhou' ? 'falha_meta' : null}, atualizado_em = ${agora}
         WHERE tenant_id = tenant_atual() AND id = ${id}`
      return
    }
    if (d.tipo === 'excluida') {
      await tx`
        UPDATE campanha_destinatario
           SET estado = 'excluida', motivo_exclusao = ${d.motivo}, enviando_desde = NULL, atualizado_em = ${agora}
         WHERE tenant_id = tenant_atual() AND id = ${id}`
      return
    }
    await tx`
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
 * VARREDURA de linhas presas em `enviando` (worker caiu ou deploy no meio do envio), em
 * qualquer estado da campanha. A `mensagem` gravada pelo envio diz o que aconteceu:
 *   - nenhuma mensagem da campanha para o contato → nunca saiu: volta a `pendente`;
 *   - mensagem com id externo (enviada/entregue/lida) → saiu: `enviada` com o wamid;
 *   - mensagem ainda `pendente` → AMBÍGUO (pode ter saído): `falhou/envio_interrompido`,
 *     nunca reenvia — mandar duas vezes é pior que não mandar;
 *   - mensagem `falhou` → `falhou`.
 */
async function varrerPresas(tx: Sql, agora: Date): Promise<number> {
  const presas = await tx<{ id: string; campanha_id: string; contato_id: string; canal_id: string | null; enviando_desde: Date }[]>`
    SELECT d.id, d.campanha_id, d.contato_id, k.canal_id, d.enviando_desde
      FROM campanha_destinatario d
      JOIN campanha k ON k.tenant_id = d.tenant_id AND k.id = d.campanha_id
     WHERE d.tenant_id = tenant_atual() AND d.estado = 'enviando'
       AND d.enviando_desde < ${agora}::timestamptz - make_interval(mins => ${ENVIANDO_EXPIRA_MIN})
     ORDER BY d.enviando_desde LIMIT 200
     FOR UPDATE OF d SKIP LOCKED`
  for (const p of presas) {
    // Folga de 5 min: o relógio do worker e o do banco não são o mesmo.
    const [m] = await tx<{ id: string; conversa_id: string; status: string | null; id_externo: string | null }[]>`
      SELECT m.id, m.conversa_id, m.status, m.id_externo
        FROM conversa cv
        JOIN mensagem m ON m.tenant_id = cv.tenant_id AND m.conversa_id = cv.id
       WHERE cv.tenant_id = tenant_atual() AND cv.contato_id = ${p.contato_id} AND cv.canal_id = ${p.canal_id}
         AND m.campanha_id = ${p.campanha_id} AND m.direcao = 'saliente'
         AND m.criado_em >= ${p.enviando_desde}::timestamptz - interval '5 minutes'
       ORDER BY m.criado_em DESC LIMIT 1`
    if (!m) {
      await tx`UPDATE campanha_destinatario SET estado = 'pendente', enviando_desde = NULL, atualizado_em = ${agora}
                WHERE tenant_id = tenant_atual() AND id = ${p.id}`
    } else if (m.id_externo && m.status !== 'falhou' && m.status !== 'pendente') {
      await tx`UPDATE campanha_destinatario
                  SET estado = CASE ${m.status} WHEN 'lida' THEN 'lida' WHEN 'entregue' THEN 'entregue' ELSE 'enviada' END,
                      wamid = ${m.id_externo}, mensagem_id = ${m.id}, conversa_id = ${m.conversa_id},
                      enviado_em = ${p.enviando_desde}, enviando_desde = NULL, atualizado_em = ${agora}
                WHERE tenant_id = tenant_atual() AND id = ${p.id}`
    } else {
      await tx`UPDATE campanha_destinatario
                  SET estado = 'falhou', erro_codigo = ${m.status === 'falhou' ? 'falha_envio' : 'envio_interrompido'},
                      mensagem_id = ${m.id}, conversa_id = ${m.conversa_id}, enviando_desde = NULL, atualizado_em = ${agora}
                WHERE tenant_id = tenant_atual() AND id = ${p.id}`
    }
  }
  return presas.length
}

/**
 * Uma passada nas campanhas v2 de UM tenant.
 *
 * ⚠️ UMA linha por envio: reivindica (commit) → envia (fora de transação: rede nunca com
 *    transação aberta) → grava o desfecho (commit). Uma queda no meio deixa no máximo UMA
 *    linha em `enviando`, que a varredura resolve pela mensagem gravada.
 * ⚠️ O opt-out é conferido NO ENVIO (gateway + `recebe_campanhas`), e as exclusões
 *    "recente" são reavaliadas: o snapshot é do iniciar, e a campanha pode levar dias.
 */
export async function despacharCampanhasV2DoTenant(
  sql: Sql, tenantId: string, agora: Date, enviar: EnviarDestinatario = enviarCampanhaParaContato,
): Promise<ResultadoDespachoV2> {
  const r: Record<keyof ResultadoDespachoV2, number> = { ...ZERO_V2 }

  r.interrompidos = await comTenantDoWorker(sql, tenantId, (tx) => varrerPresas(tx, agora))

  r.iniciadas = (await comTenantDoWorker(sql, tenantId, (tx) => tx`
    UPDATE campanha SET estado = 'enviando', atualizado_em = ${agora}
     WHERE tenant_id = tenant_atual() AND modelo_versao = 2 AND estado = 'agendada'
       AND (inicio_em IS NULL OR inicio_em <= ${agora})
    RETURNING id`)).length

  // B7: quem pediu para sair DEPOIS de uma campanha concluída ainda conta para ela,
  // enquanto durar a janela de atribuição.
  await comTenantDoWorker(sql, tenantId, async (tx) => {
    const concluidas = await tx<{ id: string }[]>`
      SELECT id FROM campanha
       WHERE tenant_id = tenant_atual() AND modelo_versao = 2 AND estado = 'concluida'
         AND concluida_em >= ${agora}::timestamptz - make_interval(days => janela_atribuicao_dias)`
    for (const k of concluidas) await reconciliarOptOuts(tx, k.id, agora)
  })

  const campanhas = await comTenantDoWorker(sql, tenantId, (tx) => tx<CampanhaV2[]>`
    SELECT id, canal_id, template_id, mensagem, lote_diario, janela, contagem_desde, publico
      FROM campanha
     WHERE tenant_id = tenant_atual() AND modelo_versao = 2 AND estado = 'enviando'
     ORDER BY iniciada_em ASC NULLS LAST, id`)

  for (const c of campanhas) {
    const v = await comTenantDoWorker(sql, tenantId, (tx) => verificarCampanha(tx, c, agora))
    if (v.acao === 'pausou') { r.pausadas++; continue }
    if (v.acao === 'fora_da_janela') { r.foraDaJanela++; continue }
    if (v.acao === 'bloqueada') { r.bloqueadas++; continue }
    if (v.acao === 'segurar') continue

    const limite = v.canal.tipo === 'whatsapp_oficial' ? LOTE_PASSADA_OFICIAL : LOTE_PASSADA_NAO_OFICIAL
    for (let i = 0; i < limite; i++) {
      const passo = await comTenantDoWorker(sql, tenantId, (tx) => reivindicarUm(tx, c, v.publico, agora))
      if (passo.tipo === 'excluiu') { r.excluidos++; continue }
      if (passo.tipo === 'parar') {
        if (passo.motivo === 'lote') r.loteDoDiaCumprido++
        else if (passo.motivo === 'aquecimento') r.aguardandoAquecimento++
        else if (passo.motivo === 'tier') r.aguardandoTier++
        else if (passo.motivo === 'intervalo') r.aguardandoIntervalo++
        else if (passo.motivo === 'bloqueada') r.bloqueadas++
        break
      }

      const desfecho = desfechoDoEnvio(await enviar(tenantId, {
        campanhaId: c.id, canalId: c.canal_id!, contatoId: passo.linha.contato_id,
        templateId: c.template_id, texto: c.template_id ? null : c.mensagem,
      }, agora))

      if (desfecho.tipo === 'devolver' || desfecho.tipo === 'pausar') {
        await devolverParaFila(sql, tenantId, passo.linha.id, agora)
        if (desfecho.tipo === 'pausar') {
          const pausou = await comTenantDoWorker(sql, tenantId, (tx) => pausarCampanha(tx, { campanhaId: c.id, motivo: desfecho.motivo, agora }))
          if (pausou) r.pausadas++
        }
        break
      }
      await gravarDesfecho(sql, tenantId, passo.linha.id, desfecho, agora)
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

/**
 * Uma passada por todos os tenants com campanha em curso (legado e v2).
 * ⚠️ Um tenant com problema (dado torto, erro de banco) não pode parar a campanha dos
 *    outros: erro por tenant vira log com o `tenant_id` e a passada segue.
 */
export async function despacharCampanhas(
  sql: Sql, agora: Date, deps: DepsDespacho = {},
): Promise<ResultadoDisparo & { readonly v2: ResultadoDespachoV2; readonly tenantsComErro: number }> {
  const [trava] = await sql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext('campanha_despacho')) AS ok`
  if (!trava?.ok) return { ...VAZIO, v2: ZERO_V2, tenantsComErro: 0 }

  try {
    const tenants = deps.somenteTenant
      ? [{ tenant_id: deps.somenteTenant }]
      : await sql<{ tenant_id: string }[]>`
          SELECT DISTINCT tenant_id FROM campanha WHERE estado IN ('disparando', 'agendada', 'enviando')
          UNION
          SELECT DISTINCT tenant_id FROM campanha_destinatario WHERE estado = 'enviando'`

    let enviados = 0, bloqueados = 0, falhas = 0, aguardando = 0, concluidas = 0, suspensas = 0, comErro = 0
    const v2: Record<keyof ResultadoDespachoV2, number> = { ...ZERO_V2 }
    for (const { tenant_id } of tenants) {
      try {
        const r = await despacharCampanhasDoTenant(sql, tenant_id, agora, deps.enviar ?? enviarTextoParaContato)
        enviados += r.enviados; bloqueados += r.bloqueados; falhas += r.falhas
        aguardando += r.aguardandoAquecimento; concluidas += r.campanhasConcluidas; suspensas += r.suspensasPorQualidade
        const n = await despacharCampanhasV2DoTenant(sql, tenant_id, agora, deps.enviarV2 ?? enviarCampanhaParaContato)
        for (const k of Object.keys(v2) as (keyof ResultadoDespachoV2)[]) v2[k] += n[k]
      } catch (erro) {
        comErro++
        console.warn(JSON.stringify({
          nivel: 'warn', contexto: 'campanha.despacho', evento: 'tenant_falhou', tenant_id,
          erro: String(erro).slice(0, 300),
        }))
      }
    }
    return {
      enviados, bloqueados, falhas,
      aguardandoAquecimento: aguardando, suspensasPorQualidade: suspensas, campanhasConcluidas: concluidas,
      v2, tenantsComErro: comErro,
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('campanha_despacho'))`
  }
}
