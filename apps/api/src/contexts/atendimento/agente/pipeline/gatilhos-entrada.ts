import {
  detectarOptOut, detectarPedidoHumano, detectarReclamacao, detectarPerguntaRobo, gatilhoExtra,
  textoAbertura, textoRobo, textoOptOut, textoHandoffGatilho, TEXTO_PEDE_TEXTO_AUDIO, INSTRUCAO_ABERTURA_ENVIADA,
  type MarcaGuardrail, type MotivoHandoff,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../../db/index.js'
import { enviarTextoNaConversa } from '../../envio-conversa.js'
import { registrarOptOut, contatoBloqueado } from '../../../crm/opt-out.js'
import { lerPrivacidade, registrarAvisoSeExibido } from '../privacidade.js'
import { marca, mascararTexto, type ContextoPipeline, type DecisaoPreLlm, type EtapaPreLlm } from './tipos.js'

/**
 * GATILHOS DE ENTRADA, IDENTIDADE E PRIVACIDADE (raia P4, ADR-029 §2).
 *
 * Antes do modelo, sem gastar token, nesta ordem:
 *
 *   0. contato já bloqueado (opt-out anterior)   → silêncio
 *   1. opt-out ("pare")                          → confirma (autônomo), BLOQUEIA, cancela retornos, transfere
 *   2. reclamação/Procon · pedido de humano · gatilho extra do número → transfere com aviso
 *   3. áudio ainda transcrevendo                 → silêncio; áudio perdido → 1º pede texto, 2º transfere
 *   4. primeira fala do agente na conversa (autônomo) → ABERTURA fixa (assistente virtual + aviso de
 *      privacidade), registrada como aviso exibido só se o envio deu certo; o turno segue para o modelo
 *   5. "é robô?"                                 → 1º resposta fixa honesta, 2º transfere
 *
 * Regras puras em `@geracrm/shared` (`agente-gatilhos.ts`); aqui só a coreografia.
 *
 * ⚠️ OPT-OUT: a confirmação sai ANTES do bloqueio — depois dele o gateway
 *    recusa tudo, inclusive ela. O bloqueio vale em TODO modo real (sombra e
 *    assistido também): é direito do cliente, não preferência do robô; só a
 *    confirmação é exclusiva do autônomo (nos outros modos o robô não fala).
 *    Depois do bloqueio, NENHUM caminho entrega: o gateway único recusa
 *    agente, retorno, campanha, automação e o humano no inbox.
 * ⚠️ Silêncio NUNCA devolve estado: estado + silêncio no 1º turno abriria uma
 *    sessão `ativa` com 0 turnos, que o portão seguinte conta como sessão
 *    ativa (plano §4).
 * ⚠️ Simulação e copiloto: as mesmas decisões, sem efeito nenhum (não envia,
 *    não bloqueia, não registra aviso).
 */

const ETAPA = 'gatilhos-entrada'

/** Estado desta raia em `agente_sessao.estado_agente.gatilhos`. */
export interface EstadoGatilhos {
  readonly audiosSemTexto?: number
  readonly perguntouRobo?: boolean
}

export interface DepsGatilhos {
  /** Envio pelo gateway único. Testes passam um falso. */
  readonly enviar?: typeof enviarTextoNaConversa | undefined
}

/** O que o cliente ESCREVEU neste turno (texto, legenda, áudio transcrito). */
export function textoDoCliente(ctx: Pick<ContextoPipeline, 'entrantes'>): string {
  return ctx.entrantes
    .filter((e) => !e.transcricaoPendente && !e.transcricaoFalhou)
    .map((e) => e.texto.replace(/^\[(áudio|imagem)\]\s*/u, '').replace(/^\[[a-z_]+\]$/u, '').trim())
    .filter(Boolean)
    .join('\n')
}

function lerEstadoGatilhos(ctx: ContextoPipeline): EstadoGatilhos {
  const g = ctx.estado['gatilhos']
  return g && typeof g === 'object' && !Array.isArray(g) ? (g as EstadoGatilhos) : {}
}

function gatilhosExtrasDoNumero(cfgExtra: Readonly<Record<string, unknown>>): readonly string[] {
  // Leitura tolerante da coluna `compliance` (0097, raia P2): ausente → sem extras.
  const c = cfgExtra['compliance']
  const lista = c && typeof c === 'object' ? (c as Record<string, unknown>)['gatilhosHandoff'] : undefined
  return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === 'string').slice(0, 50) : []
}

const modoReal = (ctx: ContextoPipeline) => ctx.modo !== 'simulacao' && ctx.modo !== 'copiloto'

async function nomeDoContato(tx: Sql, contatoId: string): Promise<string | null> {
  const [c] = await tx<{ nome: string | null }[]>`SELECT nome FROM contato WHERE tenant_id = tenant_atual() AND id = ${contatoId}`
  return c?.nome ?? null
}

/**
 * O agente já falou nesta conversa (abertura, resposta ou retorno)? O histórico
 * do banco é a fonte (sobrevive a restart e a sessões novas). Envio recusado
 * pelo gateway não conta: o cliente não viu — a abertura tenta de novo.
 */
async function agenteJaFalou(tx: Sql, conversaId: string): Promise<boolean> {
  const [l] = await tx<{ falou: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM mensagem
       WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND direcao = 'saliente'
         AND status IS DISTINCT FROM 'falhou'
         AND conteudo->>'automatica' IN ('agente', 'agente_abertura', 'retorno')) AS falou`
  return l?.falou ?? false
}

/**
 * Transferência por gatilho, COM aviso ao cliente: vira `resposta_fixa` com
 * `handoff` (e não `handoff` puro) para seguir o rabo comum do turno — o aviso
 * passa pela rede final de R$ e pela checagem de sequência, a SESSÃO nasce e
 * fecha com a entrega (auditoria completa), e em sombra/assistido o aviso
 * vira sugestão em vez de sair.
 */
function handoffComAviso(ctx: ContextoPipeline, motivo: MotivoHandoff, codigo: string, resumo: string, trecho: string, extras: readonly MarcaGuardrail[] = []): DecisaoPreLlm {
  return {
    tipo: 'resposta_fixa',
    mensagens: [textoHandoffGatilho({ foraDoExpediente: ctx.foraDoExpediente })],
    handoff: { motivo, resumo },
    guardrails: [...extras, marca(ETAPA, codigo, 'INFO', 'handoff', trecho || undefined)],
  }
}

export function criarEtapaGatilhosEntrada(deps: DepsGatilhos = {}): EtapaPreLlm {
  const enviar = deps.enviar ?? enviarTextoNaConversa
  return {
    nome: ETAPA,
    async executar(ctx) {
      const real = modoReal(ctx)
      const texto = textoDoCliente(ctx)
      const g = lerEstadoGatilhos(ctx)

      // ── 0. Já bloqueado: nada a dizer, nada a gastar ────────────────────
      if (real && await comTenantServico(ctx.tenantId, (tx) => contatoBloqueado(tx, ctx.contatoId))) {
        return { tipo: 'silencio', motivo: 'contato_bloqueado' }
      }

      // ── 1. Opt-out ──────────────────────────────────────────────────────
      const optOut = texto ? detectarOptOut(texto) : null
      if (optOut) return executarOptOut(ctx, optOut, texto, enviar)

      // ── 2. Reclamação · humano · extra ──────────────────────────────────
      if (texto) {
        if (detectarReclamacao(texto)) {
          return handoffComAviso(ctx, 'reclamacao', 'reclamacao', `Reclamação/Procon/jurídico, sem passar pela IA. Cliente: "${mascararTexto(texto).slice(0, 300)}"`, texto)
        }
        if (detectarPedidoHumano(texto)) {
          return handoffComAviso(ctx, 'pedido_de_humano', 'pedido_humano', `O cliente pediu uma pessoa. Cliente: "${mascararTexto(texto).slice(0, 300)}"`, texto)
        }
        const extra = gatilhoExtra(texto, gatilhosExtrasDoNumero(ctx.cfgExtra))
        if (extra) {
          return handoffComAviso(ctx, 'gatilho_playbook', 'gatilho_extra', `Gatilho de transferência do número: "${extra}". Cliente: "${mascararTexto(texto).slice(0, 300)}"`, texto)
        }
      }

      // ── 3. Áudio ────────────────────────────────────────────────────────
      if (ctx.entrantes.some((e) => e.transcricaoPendente)) {
        // ⚠️ Sem estado: ver o cabeçalho. A transcrição reagenda o turno ao terminar.
        return { tipo: 'silencio', motivo: 'audio_transcrevendo' }
      }
      const patchAudio = !texto ? null : (g.audiosSemTexto ? { gatilhos: { ...g, audiosSemTexto: 0 } } : null)
      if (!texto && ctx.entrantes.some((e) => e.transcricaoFalhou)) {
        if ((g.audiosSemTexto ?? 0) >= 1) {
          return handoffComAviso(ctx, 'audio_sem_transcricao', 'audio_sem_transcricao', 'O cliente mandou áudios que não deu para transcrever; precisa de alguém que ouça.', '')
        }
        return {
          tipo: 'resposta_fixa', mensagens: [TEXTO_PEDE_TEXTO_AUDIO],
          estado: { gatilhos: { ...g, audiosSemTexto: 1 } },
          guardrails: [marca(ETAPA, 'audio_sem_transcricao', 'INFO', 'substituido')],
        }
      }

      // ── 4. Abertura: a primeira fala do agente identifica a assistente ───
      const instrucoes: string[] = []
      const marcas: MarcaGuardrail[] = []
      let aberturaAgora = false
      if (ctx.modo === 'autonomo') {
        const abertura = await enviarAbertura(ctx, enviar)
        if (abertura) {
          marcas.push(abertura.marca)
          if (abertura.ok) { instrucoes.push(INSTRUCAO_ABERTURA_ENVIADA); aberturaAgora = true }
        }
      }

      // ── 5. "É robô?" ────────────────────────────────────────────────────
      if (texto && detectarPerguntaRobo(texto)) {
        if (g.perguntouRobo) {
          return handoffComAviso(ctx, 'pergunta_robo', 'pergunta_robo', 'O cliente insistiu em saber se fala com um robô.', texto, marcas)
        }
        const estado = { gatilhos: { ...g, ...(patchAudio ? { audiosSemTexto: 0 } : {}), perguntouRobo: true } }
        // A abertura que ACABOU de sair já respondeu "sou assistente virtual" — não repete.
        const mensagens = aberturaAgora ? [] : [textoRobo({ assistenteNome: ctx.persona.nome, loja: ctx.persona.loja })]
        return { tipo: 'resposta_fixa', mensagens, estado, guardrails: [...marcas, marca(ETAPA, 'pergunta_robo', 'INFO', 'substituido', texto)] }
      }

      return {
        tipo: 'segue',
        ...(instrucoes.length ? { instrucoes } : {}),
        ...(patchAudio ? { estado: patchAudio } : {}),
        ...(marcas.length ? { guardrails: marcas } : {}),
      }
    },
  }
}

/**
 * Opt-out: confirma (só autônomo) → bloqueia → cancela retornos → transfere
 * (a sessão fecha; em autônomo uma pessoa vê o pedido na fila).
 */
async function executarOptOut(
  ctx: ContextoPipeline, motivo: 'opt_out' | 'lgpd_exclusao', texto: string, enviar: typeof enviarTextoNaConversa,
): Promise<DecisaoPreLlm> {
  const exclusao = motivo === 'lgpd_exclusao'
  const resumo = exclusao
    ? 'O cliente pediu para não receber mais mensagens e para EXCLUIR os dados (LGPD): número bloqueado; conclua a exclusão.'
    : 'O cliente pediu para não receber mais mensagens: número bloqueado (opt-out). Para desfazer, só a pedido dele, em Opt-out / Bloqueios.'
  if (!modoReal(ctx)) {
    // Simulação/copiloto: mostra o que o cliente receberia, sem bloquear nada.
    return {
      tipo: 'resposta_fixa', mensagens: [textoOptOut({ exclusao })], handoff: { motivo: 'opt_out', resumo },
      guardrails: [marca(ETAPA, motivo, 'INFO', 'handoff', texto)],
    }
  }
  const marcas: MarcaGuardrail[] = []
  if (ctx.modo === 'autonomo') {
    const nome = await comTenantServico(ctx.tenantId, (tx) => nomeDoContato(tx, ctx.contatoId))
    const e = await enviar(ctx.tenantId, ctx.conversaId, textoOptOut({ clienteNome: nome, exclusao }), null, ctx.agora, { ehDisparo: false, marcador: 'agente' })
    if (!e.ok) marcas.push(marca(ETAPA, 'opt_out_confirmacao_nao_enviada', 'ALTA', 'registrado', e.motivo))
  }
  await comTenantServico(ctx.tenantId, async (tx) => {
    await registrarOptOut(tx, { contatoId: ctx.contatoId, origem: 'agente', agora: ctx.agora })
    // ⚠️ Retorno pendente de QUALQUER conversa do contato morre aqui: o gateway
    //    já recusaria, mas cancelar deixa a fila limpa e o motivo legível.
    await tx`
      UPDATE agente_retorno r SET estado = 'cancelado', detalhe = 'opt_out', concluido_em = ${ctx.agora}
        FROM conversa c
       WHERE r.tenant_id = tenant_atual() AND r.estado = 'pendente'
         AND c.tenant_id = r.tenant_id AND c.id = r.conversa_id AND c.contato_id = ${ctx.contatoId}`
  })
  return {
    tipo: 'handoff', motivo: 'opt_out', resumo, avisoCliente: null,
    guardrails: [...marcas, marca(ETAPA, motivo, 'INFO', 'bloqueado', texto)],
  }
}

/**
 * Envia a abertura se o agente nunca falou nesta conversa. Registra o aviso de
 * privacidade SÓ com envio ok. null = não era a primeira fala.
 */
async function enviarAbertura(
  ctx: ContextoPipeline, enviar: typeof enviarTextoNaConversa,
): Promise<{ ok: boolean; marca: MarcaGuardrail } | null> {
  const prep = await comTenantServico(ctx.tenantId, async (tx) => {
    if (await agenteJaFalou(tx, ctx.conversaId)) return null
    return { nome: await nomeDoContato(tx, ctx.contatoId), privacidade: await lerPrivacidade(tx) }
  })
  if (!prep) return null
  const texto = textoAbertura({
    assistenteNome: ctx.persona.nome, loja: ctx.persona.loja, clienteNome: prep.nome,
    privacidade: { url: prep.privacidade.url, textoPadrao: prep.privacidade.textoPadrao },
  })
  const e = await enviar(ctx.tenantId, ctx.conversaId, texto, null, ctx.agora, { ehDisparo: false, marcador: 'agente_abertura' })
  if (!e.ok) return { ok: false, marca: marca(ETAPA, 'abertura_nao_enviada', 'ALTA', 'registrado', e.motivo) }
  await comTenantServico(ctx.tenantId, (tx) => registrarAvisoSeExibido(tx, {
    envio: e, contatoId: ctx.contatoId, conversaId: ctx.conversaId, canalId: ctx.canalId, texto, origem: 'agente', agora: ctx.agora,
  }))
  return { ok: true, marca: marca(ETAPA, 'abertura', 'INFO', 'anexado') }
}

/** A etapa do pipeline padrão: envio pelo gateway único real. */
export const etapaGatilhosEntrada: EtapaPreLlm = criarEtapaGatilhosEntrada()
