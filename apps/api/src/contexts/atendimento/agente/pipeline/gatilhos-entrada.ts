import { randomUUID } from 'node:crypto'
import {
  detectarOptOut, detectarPedidoHumano, detectarReclamacao, detectarPerguntaRobo, gatilhoExtra,
  textoAbertura, textoRobo, textoOptOut, textoHandoffGatilho, TEXTO_PEDE_TEXTO_AUDIO, INSTRUCAO_ABERTURA_ENVIADA,
  AVISO_CONFIRMAR_OPT_OUT, RESUMO_POSSIVEL_OPT_OUT,
  type MarcaGuardrail, type MotivoHandoff,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../../db/index.js'
import { registrarOptOut, contatoBloqueado } from '../../../crm/opt-out.js'
import { lerPrivacidade, registrarAvisoSeExibido } from '../privacidade.js'
import {
  marca, mascararTexto, type ContextoPipeline, type DecisaoPreLlm, type EfeitoPosEnvio, type EtapaPreLlm,
} from './tipos.js'

/**
 * GATILHOS DE ENTRADA, IDENTIDADE E PRIVACIDADE (raia P4, ADR-029 §2).
 *
 * Antes do modelo, sem gastar token, nesta ordem:
 *
 *   0. contato já bloqueado (opt-out anterior)   → silêncio
 *   1. opt-out CLARO ("pare")                    → confirmação fixa pelo rabo do turno; em AUTÔNOMO o
 *      bloqueio é efeito PÓS-ENVIO (a confirmação sai antes); sombra só registra; assistido sugere a
 *      confirmação com o aviso "confirme" — o bloqueio fica com o humano (ADR-028)
 *      opt-out AMBÍGUO                          → transfere com marca `possivel_opt_out`, NUNCA bloqueia
 *   2. ameaça formal · pedido de humano · gatilho extra do número → transfere com aviso sem prazo
 *   3. áudio ainda transcrevendo                 → silêncio; áudio perdido → 1º pede texto, 2º transfere
 *   4. sessão NOVA e sem aviso de privacidade vigente para o contato (autônomo/simulação) → a
 *      ABERTURA vai como PREFIXO da resposta; o aviso é registrado (efeito) só se o gateway aceitou
 *   5. "é robô?"                                 → 1º resposta fixa honesta, 2º transfere
 *
 * Regras puras em `@geracrm/shared` (`agente-gatilhos.ts`); aqui só a coreografia.
 * ⚠️ A etapa NÃO envia nada: todo texto sai pelo rabo comum do turno (rede de
 *    R$, filtro de saída, sequência, registro na decisão).
 * ⚠️ Silêncio NUNCA devolve estado: estado + silêncio no 1º turno abriria uma
 *    sessão `ativa` com 0 turnos (plano §4).
 */

const ETAPA = 'gatilhos-entrada'
/** O aviso vale por este tempo; depois, a próxima sessão mostra de novo. */
export const VALIDADE_AVISO_DIAS = 180

/** Estado desta raia em `agente_sessao.estado_agente.gatilhos`. */
export interface EstadoGatilhos {
  readonly audiosSemTexto?: number
  readonly perguntouRobo?: boolean
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
const identidade = (ctx: ContextoPipeline) => ({ assistenteNome: ctx.persona.nome, loja: ctx.persona.loja })

/**
 * Transferência por gatilho, COM aviso ao cliente: `resposta_fixa` + `handoff`
 * para seguir o rabo comum — o aviso passa pela rede e pela sequência, a sessão
 * nasce e fecha com a entrega, e em sombra/assistido o aviso vira sugestão.
 */
function handoffComAviso(ctx: ContextoPipeline, motivo: MotivoHandoff, codigo: string, resumo: string, trecho: string, gravidade: 'INFO' | 'ALTA' = 'INFO'): DecisaoPreLlm {
  return {
    tipo: 'resposta_fixa',
    mensagens: [textoHandoffGatilho({ foraDoExpediente: ctx.foraDoExpediente })],
    handoff: { motivo, resumo },
    guardrails: [marca(ETAPA, codigo, gravidade, 'handoff', trecho || undefined)],
  }
}

export const etapaGatilhosEntrada: EtapaPreLlm = {
  nome: ETAPA,
  async executar(ctx) {
    const real = modoReal(ctx)
    const texto = textoDoCliente(ctx)
    const g = lerEstadoGatilhos(ctx)

    // ── 0. Já bloqueado: nada a dizer, nada a gastar ──────────────────────
    if (real && await comTenantServico(ctx.tenantId, (tx) => contatoBloqueado(tx, ctx.contatoId))) {
      return { tipo: 'silencio', motivo: 'contato_bloqueado' }
    }

    // ── 1. Opt-out ────────────────────────────────────────────────────────
    const optOut = texto ? detectarOptOut(texto) : null
    if (optOut === 'possivel_opt_out') {
      return handoffComAviso(ctx, 'incerteza', 'possivel_opt_out', `${RESUMO_POSSIVEL_OPT_OUT} Cliente: "${mascararTexto(texto).slice(0, 300)}"`, texto, 'ALTA')
    }
    if (optOut) return decidirOptOut(ctx, optOut === 'lgpd_exclusao', texto)

    // ── 2. Ameaça formal · humano · extra ─────────────────────────────────
    if (texto) {
      if (detectarReclamacao(texto)) {
        return handoffComAviso(ctx, 'reclamacao', 'reclamacao', `Ameaça formal (Procon/justiça), sem passar pela IA. Cliente: "${mascararTexto(texto).slice(0, 300)}"`, texto)
      }
      if (detectarPedidoHumano(texto)) {
        return handoffComAviso(ctx, 'pedido_de_humano', 'pedido_humano', `O cliente pediu uma pessoa. Cliente: "${mascararTexto(texto).slice(0, 300)}"`, texto)
      }
      const extra = gatilhoExtra(texto, gatilhosExtrasDoNumero(ctx.cfgExtra))
      if (extra) {
        return handoffComAviso(ctx, 'gatilho_playbook', 'gatilho_extra', `Gatilho de transferência do número: "${extra}". Cliente: "${mascararTexto(texto).slice(0, 300)}"`, texto)
      }
    }

    // ── 3. Áudio ──────────────────────────────────────────────────────────
    if (ctx.entrantes.some((e) => e.transcricaoPendente)) {
      // ⚠️ Sem estado: ver o cabeçalho. A transcrição reagenda o turno ao terminar.
      return { tipo: 'silencio', motivo: 'audio_transcrevendo' }
    }
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
    const zerarAudio = texto && g.audiosSemTexto ? { audiosSemTexto: 0 } : {}

    // ── 4. Abertura (prefixo da resposta) ─────────────────────────────────
    const abertura = await aberturaDoTurno(ctx)

    // ── 5. "É robô?" ──────────────────────────────────────────────────────
    if (texto && detectarPerguntaRobo(texto)) {
      if (g.perguntouRobo) {
        return handoffComAviso(ctx, 'pergunta_robo', 'pergunta_robo', 'O cliente insistiu em saber se fala com um robô.', texto)
      }
      // A abertura já responde "sou assistente virtual (IA)" — não repete.
      return {
        tipo: 'resposta_fixa',
        mensagens: abertura ? [abertura.texto] : [textoRobo(identidade(ctx))],
        estado: { gatilhos: { ...g, ...zerarAudio, perguntouRobo: true } },
        guardrails: [...(abertura ? [abertura.marca] : []), marca(ETAPA, 'pergunta_robo', 'INFO', 'substituido', texto)],
        ...(abertura ? { efeitos: [abertura.efeito] } : {}),
      }
    }

    return {
      tipo: 'segue',
      ...(abertura ? { prefixo: [abertura.texto], instrucoes: [INSTRUCAO_ABERTURA_ENVIADA], efeitos: [abertura.efeito], guardrails: [abertura.marca] } : {}),
      ...(Object.keys(zerarAudio).length ? { estado: { gatilhos: { ...g, ...zerarAudio } } } : {}),
    }
  },
}

// ── opt-out ─────────────────────────────────────────────────────────────────

/**
 * Opt-out CLARO, por modo (ADR-028: o modo diz quem age):
 *   - autônomo: confirmação fixa (sai pelo rabo) e, DEPOIS do envio, o bloqueio;
 *   - assistido: a confirmação vira SUGESTÃO com aviso "confirme e bloqueie" —
 *     o bloqueio é do vendedor, pelo fluxo existente (Opt-out / Bloqueios);
 *   - sombra: só registra a marca (o robô observa; quem atende decide);
 *   - simulação/copiloto: mostra a confirmação, sem efeito nenhum.
 */
function decidirOptOut(ctx: ContextoPipeline, exclusao: boolean, texto: string): DecisaoPreLlm {
  const codigo = exclusao ? 'lgpd_exclusao' : 'opt_out'
  const confirmacao = textoOptOut({ exclusao })
  if (ctx.modo === 'autonomo') {
    return {
      tipo: 'resposta_fixa', mensagens: [confirmacao],
      guardrails: [marca(ETAPA, codigo, 'INFO', 'bloqueado', texto)],
      efeitos: [efeitoBloquearOptOut(ctx, exclusao)],
    }
  }
  if (ctx.modo === 'assistido') {
    return {
      tipo: 'resposta_fixa', mensagens: [confirmacao],
      guardrails: [marca(ETAPA, codigo, 'INFO', 'registrado', texto), marca(ETAPA, 'opt_out_confirmar', 'ALTA', 'registrado', AVISO_CONFIRMAR_OPT_OUT)],
    }
  }
  return { tipo: 'resposta_fixa', mensagens: [confirmacao], guardrails: [marca(ETAPA, codigo, 'INFO', 'registrado', texto)] }
}

/**
 * O bloqueio, DEPOIS da tentativa de envio da confirmação (com o bloqueio
 * gravado, o gateway recusaria a própria confirmação). Roda mesmo se a
 * confirmação não saiu: o pedido do cliente vale assim mesmo.
 *
 * Bloqueia, cancela retornos pendentes do contato, ENCERRA a sessão sem criar
 * atendimento na fila, e deixa visível: nota de sistema na conversa + alerta.
 */
function efeitoBloquearOptOut(ctx: ContextoPipeline, exclusao: boolean): EfeitoPosEnvio {
  return {
    nome: 'opt-out',
    async executar(tx: Sql, r) {
      const marcas: MarcaGuardrail[] = []
      if (r.enviadas.length === 0) marcas.push(marca(ETAPA, 'opt_out_confirmacao_nao_enviada', 'ALTA', 'registrado'))
      const b = await registrarOptOut(tx, { contatoId: ctx.contatoId, origem: 'agente', agora: ctx.agora })
      if (!b.temTelefone) marcas.push(marca(ETAPA, 'opt_out_sem_telefone', 'ALTA', 'registrado', 'Contato sem telefone: bloqueio registrado no consentimento do contato.'))
      await tx`
        UPDATE agente_retorno r SET estado = 'cancelado', detalhe = 'opt_out', concluido_em = ${ctx.agora}
          FROM conversa c
         WHERE r.tenant_id = tenant_atual() AND r.estado = 'pendente'
           AND c.tenant_id = r.tenant_id AND c.id = r.conversa_id AND c.contato_id = ${ctx.contatoId}`
      if (r.sessaoId) {
        await tx`
          UPDATE agente_sessao SET estado = 'encerrada', fase = 'encerrada', motivo_saida = 'opt_out: cliente pediu para não receber mensagens',
                 encerrada_em = ${ctx.agora}
           WHERE tenant_id = tenant_atual() AND id = ${r.sessaoId} AND estado = 'ativa'`
      }
      const nota = exclusao
        ? 'O cliente pediu para não receber mensagens e para EXCLUIR os dados (LGPD). Número bloqueado; conclua a exclusão.'
        : 'O cliente pediu para não receber mais mensagens. Número bloqueado (opt-out). Para desfazer, só a pedido dele, em Opt-out / Bloqueios.'
      await tx`
        INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
        VALUES (tenant_atual(), ${randomUUID()}, ${ctx.conversaId}, 'saliente', 'sistema',
                ${JSON.stringify({ texto: nota, automatica: 'opt_out' })}::text::jsonb, ${ctx.agora})`
      const [conv] = await tx<{ versao: string }[]>`
        UPDATE conversa SET versao = versao + 1 WHERE tenant_id = tenant_atual() AND id = ${ctx.conversaId} RETURNING versao`
      await tx`
        INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
        VALUES (tenant_atual(), 'mensagem.enviada', 'conversa', ${ctx.conversaId},
                ${JSON.stringify({ conversaId: ctx.conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
      // ⚠️ Sem PII no alerta; um aberto por tipo (índice parcial da 0031).
      await tx`
        INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
        VALUES (tenant_atual(), ${randomUUID()}, 'opt_out_cliente', 'aviso',
                'Cliente pediu pelo WhatsApp para não receber mensagens; o agente bloqueou o número. Veja Opt-out / Bloqueios.')
        ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO NOTHING`
      return marcas
    },
  }
}

// ── abertura ────────────────────────────────────────────────────────────────

/**
 * A abertura vai quando a sessão é NOVA e o contato não tem aviso de
 * privacidade VIGENTE (mesma versão do tenant, exibido há ≤ 180 dias). A
 * fonte é `aviso_privacidade`, não o histórico: mensagens antigas do agente
 * (antes da P4) não provam que o aviso foi exibido. Só autônomo (fala sozinho)
 * e simulação (mostra o que sairia).
 */
async function aberturaDoTurno(ctx: ContextoPipeline): Promise<{ texto: string; marca: MarcaGuardrail; efeito: EfeitoPosEnvio } | null> {
  if (ctx.modo !== 'autonomo' && ctx.modo !== 'simulacao') return null
  // ⚠️ Simulação não abre sessão (sessaoId é sempre null): lá a abertura vale
  //    só na primeira fala do agente na conversa do playground.
  if (ctx.modo === 'simulacao' ? !ctx.primeiraResposta : ctx.sessaoId !== null) return null
  const prep = await comTenantServico(ctx.tenantId, async (tx) => {
    const privacidade = await lerPrivacidade(tx)
    const [v] = await tx<{ vigente: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM aviso_privacidade
         WHERE tenant_id = tenant_atual() AND contato_id = ${ctx.contatoId}
           AND versao = ${privacidade.versao}
           AND exibido_em > ${ctx.agora}::timestamptz - make_interval(days => ${VALIDADE_AVISO_DIAS})) AS vigente`
    if (v?.vigente) return null
    const [c] = await tx<{ nome: string | null }[]>`SELECT nome FROM contato WHERE tenant_id = tenant_atual() AND id = ${ctx.contatoId}`
    return { privacidade, nome: c?.nome ?? null }
  })
  if (!prep) return null
  const texto = textoAbertura({
    ...identidade(ctx), clienteNome: prep.nome,
    privacidade: { url: prep.privacidade.url, textoPadrao: prep.privacidade.textoPadrao },
  })
  return {
    texto,
    marca: marca(ETAPA, 'abertura', 'INFO', 'anexado'),
    efeito: {
      nome: 'aviso-privacidade',
      async executar(tx, r) {
        // Registra cada mensagem ACEITA pelo gateway que contém o aviso (o fatiamento pode partir a abertura).
        let registrou = false
        for (const e of r.enviadas) {
          const x = await registrarAvisoSeExibido(tx, {
            envio: { ok: true, mensagemId: e.mensagemId }, contatoId: ctx.contatoId, conversaId: ctx.conversaId,
            canalId: ctx.canalId, texto: e.texto, origem: 'agente', agora: ctx.agora,
          })
          if (x.registrado) registrou = true
        }
        return registrou || ctx.modo !== 'autonomo' ? [] : [marca(ETAPA, 'abertura_nao_enviada', 'ALTA', 'registrado')]
      },
    },
  }
}
