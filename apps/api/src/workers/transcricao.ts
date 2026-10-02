import { comTenantServico, type Sql } from '../db/index.js'
import { agendarTurno } from '../contexts/atendimento/agente/fila.js'
import { baixarMidiaDeEntrada } from '../contexts/atendimento/midia/baixar-entrada.js'
import type { PortaTranscricao } from '../contexts/atendimento/midia/transcricao/porta.js'

/**
 * O WORKER DE TRANSCRIÇÃO (IA-03, R5) — transcreve os áudios ENTRANTES fora do
 * caminho da requisição. Roda como DONO para achar candidatas; cada gravação
 * roda sob o tenant da mensagem (`comTenantServico`), como todo serviço.
 *
 * O que faz por áudio:
 *   baixa (bucket | Graph API | URL do provedor) → transcreve pela porta →
 *   grava `conteudo.transcricao` → versão da conversa + outbox (tela atualiza)
 *   → REAGENDA O TURNO DO AGENTE: o cliente "falou" e o robô precisa responder
 *   ao que foi dito, não a "[áudio sem transcrição]".
 *
 * ⚠️ Falha conta tentativa (teto 3, com espera entre elas): provedor fora não
 * pode virar laço de 5 s batendo na mesma mensagem. Formato que o provedor não
 * entende desiste na hora — tentar de novo não conserta.
 */
export const INTERVALO_TRANSCRICAO_MS = 5_000
export const MAX_TENTATIVAS_TRANSCRICAO = 3
/** Entre uma tentativa falha e a próxima. */
const ESPERA_ENTRE_TENTATIVAS_MS = 120_000
/** Só áudio recente: o worker não revisita o histórico inteiro ao ligar. */
const JANELA_DIAS = 7
const LOTE = 5

export interface DepsTranscricao {
  readonly porta: PortaTranscricao
  readonly baixar?: typeof baixarMidiaDeEntrada | undefined
  /** Dica de idioma passada ao provedor. */
  readonly idioma?: string | undefined
  /** Restringe a passada a UM tenant (reprocessamento dirigido; testes contra banco compartilhado). */
  readonly somenteTenant?: string | undefined
}

export interface RelatorioTranscricao {
  candidatas: number
  transcritas: number
  falhas: number
  reagendouAgente: number
}

interface Candidata {
  readonly tenant_id: string
  readonly id: string
  readonly criado_em: Date
  readonly conversa_id: string
  readonly canal_id: string
  readonly conteudo: Record<string, unknown>
}

export async function processarTranscricoes(
  dono: Sql, deps: DepsTranscricao, agora: Date = new Date(),
): Promise<RelatorioTranscricao> {
  const r: RelatorioTranscricao = { candidatas: 0, transcritas: 0, falhas: 0, reagendouAgente: 0 }
  if (!deps.porta.capacidades.transcreve) return r

  const [trava] = await dono<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('transcricao_audio')) AS ok`
  if (!trava?.ok) return r
  try {
    const desde = new Date(agora.getTime() - JANELA_DIAS * 86_400_000)
    const limiteTentativa = new Date(agora.getTime() - ESPERA_ENTRE_TENTATIVAS_MS)
    const candidatas = await dono<Candidata[]>`
      SELECT m.tenant_id, m.id, m.criado_em, m.conversa_id, c.canal_id, m.conteudo
        FROM mensagem m
        JOIN conversa c ON c.tenant_id = m.tenant_id AND c.id = m.conversa_id
       WHERE m.direcao = 'entrante' AND m.tipo = 'audio'
         AND m.criado_em > ${desde}
         ${deps.somenteTenant ? dono`AND m.tenant_id = ${deps.somenteTenant}` : dono``}
         AND NOT (m.conteudo ? 'transcricao')
         AND coalesce((m.conteudo->>'transcricao_tentativas')::int, 0) < ${MAX_TENTATIVAS_TRANSCRICAO}
         AND (m.conteudo->>'transcricao_tentada_em' IS NULL
              OR (m.conteudo->>'transcricao_tentada_em')::timestamptz < ${limiteTentativa})
       ORDER BY m.criado_em DESC
       LIMIT ${LOTE}`
    r.candidatas = candidatas.length

    for (const m of candidatas) {
      const desfecho = await transcreverUma(m, deps, agora)
      if (desfecho.ok) {
        r.transcritas += 1
        if (desfecho.reagendouAgente) r.reagendouAgente += 1
      } else {
        r.falhas += 1
      }
    }
  } finally {
    await dono`SELECT pg_advisory_unlock(hashtext('transcricao_audio'))`
  }
  return r
}

async function transcreverUma(
  m: Candidata, deps: DepsTranscricao, agora: Date,
): Promise<{ ok: true; reagendouAgente: boolean } | { ok: false }> {
  const ref = typeof m.conteudo['audio'] === 'string' ? (m.conteudo['audio'] as string) : ''
  const mime = typeof m.conteudo['mime'] === 'string' ? (m.conteudo['mime'] as string) : null
  const tentativas = Number(m.conteudo['transcricao_tentativas'] ?? 0)

  // 1. Bytes — rede, fora de transação.
  const audio = ref ? await (deps.baixar ?? baixarMidiaDeEntrada)(m.tenant_id, m.canal_id, ref, mime) : null
  if (!audio) {
    await registrarFalha(m, 'download', tentativas, false, agora)
    return { ok: false }
  }

  // 2. Transcrição — rede, fora de transação.
  const t = await deps.porta.transcrever({ bytes: audio.bytes, mime: audio.mime, idioma: deps.idioma ?? 'pt' })
  if (!t.ok) {
    // Formato/tamanho não melhoram com retentativa: gasta as tentativas de uma vez.
    await registrarFalha(m, t.motivo, tentativas, t.motivo === 'formato' || t.motivo === 'muito_longo', agora)
    return { ok: false }
  }

  // 3. Grava + avisa a tela + reagenda o agente, no MESMO commit.
  return comTenantServico(m.tenant_id, async (tx) => {
    const novo = {
      transcricao: t.texto, transcricao_em: agora.toISOString(),
      ...(t.idioma ? { transcricao_idioma: t.idioma } : {}),
      ...(typeof t.duracaoS === 'number' ? { transcricao_duracao_s: t.duracaoS } : {}),
    }
    await tx`
      UPDATE mensagem
         SET conteudo = (conteudo - 'transcricao_erro' - 'transcricao_tentada_em') || ${JSON.stringify(novo)}::text::jsonb
       WHERE tenant_id = tenant_atual() AND id = ${m.id} AND criado_em = ${m.criado_em}`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET versao = versao + 1 WHERE tenant_id = tenant_atual() AND id = ${m.conversa_id} RETURNING versao`
    // ⚠️ Payload só com ids (defesa em profundidade): a tela busca o texto por API.
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.transcrita', 'conversa', ${m.conversa_id},
              ${JSON.stringify({ conversaId: m.conversa_id, mensagemId: m.id, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`

    // ⚠️ O cliente "falou": o agente precisa responder ao que foi dito. O turno
    //    agendado na ingestão já pode ter rodado (e respondido "[áudio sem
    //    transcrição]"); este reagenda com o texto na mão. Só com agente ligado.
    const [cfg] = await tx<{ modo: string }[]>`
      SELECT modo FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${m.canal_id}`
    let reagendouAgente = false
    if (cfg && cfg.modo !== 'desligado') {
      await agendarTurno(tx, { conversaId: m.conversa_id, canalId: m.canal_id, mensagemId: m.id, agora })
      reagendouAgente = true
    }
    return { ok: true, reagendouAgente }
  })
}

async function registrarFalha(m: Candidata, motivo: string, tentativas: number, definitiva: boolean, agora: Date): Promise<void> {
  const novo = {
    transcricao_tentativas: definitiva ? MAX_TENTATIVAS_TRANSCRICAO : tentativas + 1,
    transcricao_tentada_em: agora.toISOString(),
    transcricao_erro: motivo,
  }
  await comTenantServico(m.tenant_id, async (tx) => {
    await tx`
      UPDATE mensagem SET conteudo = conteudo || ${JSON.stringify(novo)}::text::jsonb
       WHERE tenant_id = tenant_atual() AND id = ${m.id} AND criado_em = ${m.criado_em}`
  })
}
