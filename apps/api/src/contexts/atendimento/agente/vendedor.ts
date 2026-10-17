import { randomUUID } from 'node:crypto'
import {
  ALCADA_PADRAO, PERFIL_PRECO_PADRAO, REGRAS_AGENTE_PADRAO, alcadaAgente, persona as personaSchema,
  perfilDeCotacao, respostaDoAgente, verificarNumerosNaResposta, fatiarMensagem,
  type AlcadaAgente, type ModoAgente, type ModoDoTurno, type PersonaResolvida, type RegrasDoAgente, type RespostaDoAgente,
  type SlotQualificacao, type MotivoHandoff, type MarcaGuardrail,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../db/index.js'
import { enviarTextoNaConversa } from '../envio-conversa.js'
import { quemAtende, ninguemDisponivel, motivoDisponibilidade, type QuemAtende } from '../disponibilidade.js'
import { fragmentoAtendentePresente } from '../presenca-atendente.js'
import { carregarContextoDoLead } from './contexto-lead.js'
import { portaoDoAgente, type MotivoNaoEntra } from './portao.js'
import { recadoDaFalha, type Fala } from './porta.js'
import type { PortaLlmFerramentas, MensagemLlm, RastroDoLaco } from './porta-llm.js'
import { registroDeFerramentas, type ContextoFerramenta } from './ferramentas/porta.js'
import { montarFerramentas } from './ferramentas/montar.js'
import { lerMemoria } from './memoria/memoria.js'
import { resumirSessao } from './memoria/resumo.js'
import type { Ligacoes } from './ferramentas/ligacoes-porta.js'
import { montarSistema, instrucaoDoTurno, esquemaDaResposta } from './instrucao-vendedor.js'
import { entregarParaHumano } from './handoff.js'
import { chegouMensagemNova, type Tarefa } from './fila.js'
import { llmFerramentasDoAmbiente, criarLlmDoCatalogo } from './fabrica-ferramentas.js'
import { resolverModelo } from './modelos.js'
import { custoDoLaco } from './custo.js'
import { lerEstado, patchEstado, juntarPatches } from './estado-agente.js'
import {
  montarPipeline, rodarPreLlm, rodarPosResposta, marca, mascararTexto,
  type ClasseFalha, type ContextoPipeline, type EntranteDoTurno, type PatchEstado, type PipelineDoTurno,
} from './pipeline/index.js'
import { efetivarSeDentroDaAlcada } from '../../pedido/alcada.js'
import { MAX_TENTATIVAS_TRANSCRICAO } from '../../../workers/transcricao.js'

/**
 * UM TURNO DO VENDEDOR (ADR-023) — roda no worker, nunca no webhook.
 *
 * É um PIPELINE de etapas determinísticas em volta do modelo (ADR-029). A
 * ordem é fixa e mora em `pipeline/index.ts`:
 *
 *   contexto → modoEfetivo → portão → alçada do pedido confirmado →
 *   gatilhos → slots → teto(pré) → LLM (laço com ferramentas) → validação →
 *   guardrail R$ → números → filtro → pergunta → qualidade →
 *   verificação de sequência → modo (sombra/assistido/autônomo) → envio →
 *   auditoria (agente_decisao, com as marcas de guardrail) → sessão → teto(pós)
 *
 * Cada etapa do pipeline tem um arquivo e uma raia dona em `pipeline/`;
 * estendê-las não exige tocar aqui. Falha do provedor passa pela política de
 * `pipeline/falha-llm.ts`.
 *
 * ⚠️ Tudo que o modelo diz passa por `respostaDoAgente` (shared) e pelo
 * guardrail numérico: valor que não veio de ferramenta neste turno não sai.
 * ⚠️ Falha do modelo NÃO é silêncio: em autônomo vira handoff
 * `modelo_indisponivel`, com atendimento na fila e notificação (invariante 5).
 */

export type DesfechoTurno = 'respondeu' | 'sugeriu' | 'handoff' | 'silencio' | 'falha' | 'superada'

export interface ResultadoTurnoVendedor {
  readonly desfecho: DesfechoTurno
  readonly motivo?: MotivoNaoEntra | 'humano_assumiu' | 'sem_lead' | 'conversa_inexistente' | 'orcamento_do_dia' | string | undefined
  readonly mensagens?: readonly string[] | undefined
  readonly handoff?: { motivo: string; resumo: string } | undefined
  readonly decisaoId?: string | undefined
  readonly rastro?: RastroDoLaco | undefined
  readonly detalhe?: string | undefined
  /**
   * Devolver a tarefa à fila daqui a N ms em vez de concluí-la (política de
   * falha transitória, P5). O worker respeita; ausente = concluir.
   */
  readonly reagendarEmMs?: number | undefined
}

interface ConfigVendedor {
  readonly modo: ModoAgente
  readonly politicas: string
  readonly regras: RegrasDoAgente
  readonly persona: PersonaResolvida
  readonly objetivo: 'vender' | 'qualificar'
  readonly alcada: AlcadaAgente
  readonly slots: readonly SlotQualificacao[]
  readonly modelo: string | null
  readonly limiarConfianca: number
  readonly maxRodadas: number
  readonly prazoTurnoMs: number
  readonly orcamentoDiaCentavos: number | null
  /**
   * A linha inteira (`to_jsonb(ac.*)`). ⚠️ Leitura TOLERANTE: cada raia lê aqui
   * as suas colunas novas, e coluna ausente vale o padrão — assim uma raia
   * adiciona coluna sem tocar neste SELECT.
   */
  readonly extra: Readonly<Record<string, unknown>>
}

export interface DepsTurno {
  readonly llm?: PortaLlmFerramentas | undefined
  readonly ligacoes: (cfg: { tenantId: string; politicas: string; modo: ModoDoTurno }) => Promise<Ligacoes> | Ligacoes
  readonly enviar?: typeof enviarTextoNaConversa | undefined
  readonly equipe?: QuemAtende | undefined
  readonly agora?: Date | undefined
  /** Simulação (playground): nunca envia, grava decisão com modo 'simulacao'. */
  readonly simulacao?: boolean | undefined
  /**
   * Copiloto (P13): o vendedor humano pede uma sugestão numa conversa real.
   * Só leitura — sem portão, sem envio, sem sessão, sem entrega; grava a
   * decisão com modo 'copiloto'.
   */
  readonly copiloto?: boolean | undefined
  /** Troca etapas do pipeline (testes). Em produção, sempre o padrão. */
  readonly pipeline?: Partial<PipelineDoTurno> | undefined
}

/** Resposta que vai para `agente_decisao.resposta`: a do modelo ou a fixa de uma etapa. */
type RespostaRegistrada = Pick<RespostaDoAgente, 'confianca'> & {
  readonly mensagens: readonly string[]
  readonly handoff?: { readonly motivo: string; readonly resumo: string } | undefined
  readonly fase?: RespostaDoAgente['fase']
  readonly slots?: RespostaDoAgente['slots']
  /** 'fixa' = texto de uma etapa do pipeline, sem modelo. */
  readonly origem?: 'fixa' | undefined
  /** A saída do modelo como veio, quando `mensagens` foi alterado depois dele. */
  readonly original?: RespostaDoAgente | undefined
}

/** O texto que substitui uma resposta com valor sem origem em ferramenta. */
const AVISO_VALOR_BLOQUEADO = 'Vou confirmar os valores certinhos com a equipe e já te retorno.'

export async function conduzirTurnoVendedor(tarefa: Tarefa, deps: DepsTurno): Promise<ResultadoTurnoVendedor> {
  const agora = deps.agora ?? new Date()
  const { tenant_id: tenantId, conversa_id: conversaId, canal_id: canalId } = tarefa
  const inicio = Date.now()
  const pipeline = montarPipeline(deps.pipeline)
  /** Simulação e copiloto: nada chega ao cliente, nada muda na sessão real. */
  const semEfeito = !!(deps.simulacao || deps.copiloto)
  const enviar = deps.enviar ?? enviarTextoNaConversa

  // ── 1. Contexto, numa transação curta ───────────────────────────────────
  const dados = await comTenantServico(tenantId, async (tx) => {
    const cfg = await lerConfig(tx, canalId)
    if (!cfg) return { tipo: 'desligado' as const }
    const [conv] = await tx<{ contato_id: string; conduzida_por: string; humano_assumiu: boolean }[]>`
      SELECT c.contato_id, c.conduzida_por,
             -- ⚠️ Qualquer atendimento ABERTO cala o agente: assumido por alguém OU
             --    na fila depois de um handoff. Falar por cima de uma entrega é
             --    desfazer a entrega; quem reabre é a pessoa, ao encerrar.
             EXISTS (SELECT 1 FROM atendimento a WHERE a.tenant_id = c.tenant_id AND a.conversa_id = c.id
                       AND a.estado <> 'encerrado') AS humano_assumiu
        FROM conversa c WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}`
    if (!conv) return { tipo: 'sem_conversa' as const }
    const [perfilLinha] = await tx<{ perfil_preco: string | null }[]>`
      SELECT (to_jsonb(ct)->>'perfil_preco') AS perfil_preco FROM contato ct
       WHERE ct.tenant_id = tenant_atual() AND ct.id = ${conv.contato_id}`
    const reuniao = await reunirContexto(tx, conversaId, agora, cfg.regras)
    const [ausenciaAgora] = await tx<{ recem: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM mensagem a
         WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId}
           AND a.direcao = 'saliente' AND a.conteudo->>'automatica' = 'ausencia'
           AND a.criado_em >= coalesce((SELECT max(m.criado_em) FROM mensagem m
                                          WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId}
                                            AND m.id = ANY(${[...tarefa.mensagens_ids]}::uuid[])), ${agora}::timestamptz)) AS recem`
    const [fusoLinha] = await tx<{ fuso: string | null }[]>`SELECT fuso FROM tenant WHERE id = tenant_atual()`
    // O modelo escolhido na tela é um código do catálogo; fora do catálogo/permissão, vale o padrão do ambiente.
    const modeloEscolhido = await resolverModelo(tx, cfg.modelo)
    const equipe = deps.equipe ?? await quemAtende(tx, canalId, agora)
    const custoHoje = cfg.orcamentoDiaCentavos === null ? 0 : await custoDoDia(tx, canalId, agora, fusoLinha?.fuso ?? 'America/Sao_Paulo')
    return {
      tipo: 'ok' as const, cfg, conv, reuniao, equipe, custoHoje,
      perfil: perfilDeCotacao(perfilLinha?.perfil_preco ?? PERFIL_PRECO_PADRAO),
      ausenciaRecemEnviada: ausenciaAgora?.recem ?? false, fuso: fusoLinha?.fuso ?? 'America/Sao_Paulo',
      modeloEscolhido,
    }
  })
  if (dados.tipo === 'desligado') return silencio(tenantId, tarefa, 'agente_desligado', 'desligado', agora)
  if (dados.tipo === 'sem_conversa') return { desfecho: 'silencio', motivo: 'conversa_inexistente' }
  const { cfg, conv, reuniao, equipe, custoHoje, perfil, ausenciaRecemEnviada, fuso, modeloEscolhido } = dados

  // ── 1.5 Modo efetivo: o mais restritivo entre tenant, número e recorte (P14) ─
  const efetivo = semEfeito ? { modo: cfg.modo, motivo: null } : await pipeline.modoEfetivo.decidir({
    tenantId, canalId, contatoId: conv.contato_id, modoDoNumero: cfg.modo, cfgExtra: cfg.extra, agora,
  })
  const modoDoNumero: ModoAgente = efetivo.modo
  const modo: ModoDoTurno = deps.simulacao ? 'simulacao' : deps.copiloto ? 'copiloto' : modoDoNumero
  // Rebaixou o modo do número? Fica na auditoria de TODA decisão deste turno.
  const marcasDoModo: readonly MarcaGuardrail[] = efetivo.motivo ? [marca('modo-efetivo', efetivo.motivo, 'INFO', 'registrado')] : []

  // ── 2. Portão ───────────────────────────────────────────────────────────
  if (!semEfeito) {
    if (conv.humano_assumiu) return silencio(tenantId, tarefa, 'humano_assumiu', modo, agora, { guardrails: marcasDoModo })
    // ⚠️ A ausência acabou de responder ESTAS mensagens: com "esperar o cliente
    //    insistir" ligado, o agente fica para a próxima — duas automáticas
    //    seguidas, a primeira dizendo "não há ninguém", é a contradição do §4.3.1.
    if (cfg.regras.exigirAusenciaAntes && ausenciaRecemEnviada) return silencio(tenantId, tarefa, 'ausencia_recem_enviada', modo, agora, { guardrails: marcasDoModo })
    const decisao = portaoDoAgente({
      agenteAtivo: modoDoNumero !== 'desligado',
      ninguemDisponivel: ninguemDisponivel(equipe),
      ausenciaJaEnviada: reuniao.ausencia_ja_enviada,
      atendentePresente: reuniao.atendente_presente,
      sessaoAtiva: reuniao.sessao_id ? { turnos: reuniao.sessao_turnos ?? 0 } : null,
      sessaoEncerrada: reuniao.horas_desde_encerramento === null ? null : {
        horasDesde: Number(reuniao.horas_desde_encerramento), humanoAtendeuDepois: reuniao.humano_atendeu_depois,
      },
      maxTurnos: cfg.regras.maxTurnos,
      regras: cfg.regras,
    })
    if (!decisao.entra) {
      if (decisao.motivo === 'teto_de_turnos' && reuniao.sessao_id) {
        return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'limite_de_turnos',
          reuniao.resumo ?? 'Teto de idas e vindas atingido sem fechar.', modo, agora, undefined, { guardrails: marcasDoModo })
      }
      return silencio(tenantId, tarefa, decisao.motivo, modo, agora, { guardrails: marcasDoModo })
    }
    if (cfg.orcamentoDiaCentavos !== null && custoHoje >= cfg.orcamentoDiaCentavos) {
      return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'limite_de_custo', 'Teto diário de custo do agente atingido.', modo, agora, undefined, { guardrails: marcasDoModo })
    }
  }

  // Copiloto pula o portão (há humano na conversa), mas NÃO o teto diário: é
  // o mesmo orçamento do número, e sugestão sob demanda não pode furá-lo.
  if (deps.copiloto && cfg.orcamentoDiaCentavos !== null && custoHoje >= cfg.orcamentoDiaCentavos) {
    return silencio(tenantId, tarefa, 'orcamento_do_dia', modo, agora, { guardrails: marcasDoModo })
  }

  // ── 2.5 Pedido CONFIRMADO pelo cliente nesta conversa → alçada (ADR-027) ──
  //    O "sim" foi interpretado pelo domínio na ingestão. Aqui o agente só
  //    decide o que acontece depois: dentro da alçada o domínio efetiva; fora,
  //    nasce um atendimento na fila com o resumo. Nunca o modelo.
  let avisoDoPedido: string | null = null
  const centavosDoPedidoConfirmado: number[] = []
  if (!semEfeito) {
    const confirmado = await comTenantServico(tenantId, async (tx) => {
      const [p] = await tx<{ id: string; total_centavos: string }[]>`
        SELECT id, total_centavos::text FROM pedido
         WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND estado = 'confirmado' AND origem = 'agente'
         ORDER BY confirmado_em DESC NULLS LAST LIMIT 1`
      return p ?? null
    })
    if (confirmado) {
      const total = `R$ ${(Number(confirmado.total_centavos) / 100).toFixed(2)}`
      const r = await efetivarSeDentroDaAlcada(tenantId, confirmado.id, cfg.alcada, agora)
      if (r.decisao.acao === 'aguardar_vendedor') {
        if (modo === 'autonomo') {
          await enviar(tenantId, conversaId,
            'Perfeito, pedido confirmado! Nossa equipe vai finalizar e te retorna em breve com os próximos passos.',
            null, agora, { ehDisparo: false, marcador: 'agente' })
        }
        return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'acima_da_alcada',
          `Pedido confirmado pelo cliente (total ${total}) aguarda um vendedor para faturar: ${r.decisao.motivo}.`, modo, agora, undefined, { guardrails: marcasDoModo })
      }
      if (r.decisao.acao === 'efetivar' && r.efetivacao) {
        const e = r.efetivacao
        centavosDoPedidoConfirmado.push(Number(confirmado.total_centavos))
        if (e.tipo === 'efetivado') avisoDoPedido = `O pedido confirmado pelo cliente (total ${total}) foi EFETIVADO com o número ${e.numeroExterno}. Agradeça e diga que a equipe retorna sobre pagamento e entrega.`
        else if (e.tipo === 'degradado') {
          // ⚠️ O ERP não recebe pedido: alguém precisa faturar à mão. Sem dono,
          //    o pedido ficaria `confirmado` para sempre e o agente agradeceria
          //    de novo a cada mensagem. Vira entrega à fila, com o cliente avisado.
          if (modo === 'autonomo') {
            await enviar(tenantId, conversaId,
              'Perfeito, pedido confirmado! Nossa equipe vai finalizar e te retorna em breve com os próximos passos.',
              null, agora, { ehDisparo: false, marcador: 'agente' })
          }
          return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'acima_da_alcada',
            `Pedido confirmado pelo cliente (total ${total}) aguarda faturamento manual: o sistema da loja não recebe pedido automático.`, modo, agora, undefined, { guardrails: marcasDoModo })
        } else {
          return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'acima_da_alcada',
            `Pedido confirmado pelo cliente (total ${total}) não pôde ser efetivado: ${e.tipo}${e.tipo === 'falha' ? ` (${e.falha.tipo})` : ''}.`, modo, agora, undefined, { guardrails: marcasDoModo })
        }
      }
    }
  }

  // ── 3. Lead, histórico, estado, entrantes ───────────────────────────────
  const [lead, historico, memoria, estado, entrantes] = await comTenantServico(tenantId, async (tx) => [
    await carregarContextoDoLead(tx, conversaId),
    await carregarHistorico(tx, conversaId, cfg.regras.falasDeContexto),
    // Memória de longo prazo do cliente (R3): preferências, objeções, restrições — nunca PII.
    await lerMemoria(tx, conv.contato_id).catch(() => [] as string[]),
    await lerEstado(tx, reuniao.sessao_id),
    await carregarEntrantes(tx, conversaId, tarefa.mensagens_ids),
  ] as const)
  if (!lead) return { desfecho: 'silencio', motivo: 'sem_lead' }

  const sessaoId = reuniao.sessao_id ?? randomUUID()
  const ctx: ContextoPipeline = {
    tenantId, conversaId, canalId, contatoId: conv.contato_id, sessaoId: reuniao.sessao_id, modo, agora,
    cfgExtra: cfg.extra, persona: cfg.persona, estado, historico, entrantes,
    primeiraResposta: !historico.some((h) => h.de === 'nos'), foraDoExpediente: equipe.foraDoExpediente,
  }

  // ── 4. Antes do modelo: gatilhos → slots → teto(pré) ────────────────────
  const pre = await rodarPreLlm(pipeline, ctx)
  const guardrailsPre: readonly MarcaGuardrail[] = [...marcasDoModo, ...pre.guardrails]
  /** Se uma etapa devolveu estado e ainda não há sessão, ela nasce aqui (ver `sessaoParaEstado`). */
  const abrirSessao = semEfeito ? undefined : { modo: modoDoNumero, porQue: motivoDisponibilidade(equipe) }
  if (pre.decisao.tipo === 'silencio') {
    return silencio(tenantId, tarefa, pre.decisao.motivo, modo, agora, { guardrails: guardrailsPre, sessaoId: reuniao.sessao_id, estado: pre.estado, abrirSessao })
  }
  if (pre.decisao.tipo === 'handoff') {
    return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, pre.decisao.motivo, pre.decisao.resumo, modo, agora, undefined, {
      avisoCliente: pre.decisao.avisoCliente, enviar, guardrails: guardrailsPre, estado: pre.estado, abrirSessao,
    })
  }

  // Ferramentas e mensagens do laço (também montadas para a resposta fixa:
  // o pedido aberto entra na sessão do mesmo jeito).
  const ctxFerr: ContextoFerramenta = { tenantId, conversaId, contatoId: conv.contato_id, canalId, perfil, sessaoId: reuniao.sessao_id, modo, agora, enviar: deps.enviar }
  const ligacoes: Ligacoes = await deps.ligacoes({ tenantId, politicas: cfg.politicas, modo })
  const { ferramentas, capacidades } = montarFerramentas(ligacoes)
  const registro = registroDeFerramentas(ctxFerr, ferramentas)
  const pedidoAberto = ligacoes.pedido ? await ligacoes.pedido.ver(ctxFerr).catch(() => null) : null
  if (pedidoAberto) for (const c of [pedidoAberto.totalCentavos, ...pedidoAberto.itens.flatMap((i) => [i.valorUnitarioCentavos, i.subtotalCentavos])]) registro.centavosVistos.add(c)
  for (const c of centavosDoPedidoConfirmado) registro.centavosVistos.add(c)

  /**
   * O RABO DO TURNO, comum à resposta do modelo e à resposta fixa:
   * rede final de R$ → sequência → modo → envio → teto(pós) → persistência.
   */
  const concluir = async (p: {
    /** O texto que vai sair, AINDA INTEIRO — a rede verifica antes de fatiar. */
    resposta: RespostaRegistrada; mensagens: readonly string[]; handoff: { motivo: string; resumo: string } | null
    rastro?: RastroDoLaco | undefined; custo: number; bloqueados: number[]; guardrails: readonly MarcaGuardrail[]; estado: PatchEstado
  }): Promise<ResultadoTurnoVendedor> => {
    const { rastro, custo } = p
    let { resposta, mensagens, handoff } = p
    const guardrails = [...p.guardrails]
    const bloqueados = [...p.bloqueados]

    // ── Rede final: R$ sobre o texto que VAI SAIR ─────────────────────────
    // ⚠️ O guardrail R$ do passo 7 olha a saída do modelo; uma etapa do
    //    pipeline (ou uma resposta fixa) pode ter reescrito o texto depois.
    //    Nada sai com valor sem fonte, venha de onde vier.
    // ⚠️ Verifica o texto INTEIRO, antes de `fatiarMensagem`: o corte rígido
    //    de uma frase longa sem pontuação pode partir "1.234,56" em "1." e
    //    "234,56" — dois valores que nenhuma ferramenta citou (falso bloqueio).
    const naRede = mensagens.flatMap((m) => verificarNumerosNaResposta(m, registro.centavosVistos))
    if (naRede.length > 0) {
      guardrails.push(marca('rede-final', 'valor_sem_fonte', 'CRITICA', 'substituido', mensagens.join(' ')))
      bloqueados.push(...naRede.filter((n) => !bloqueados.includes(n)))
      mensagens = [AVISO_VALOR_BLOQUEADO]
      handoff = handoff ?? { motivo: 'incerteza', resumo: 'Valor sem origem em ferramenta no texto final; bloqueado pela rede final.' }
      resposta = { ...resposta, mensagens, handoff, confianca: Math.min(resposta.confianca, 0.4) }
    }
    const mensagensFinais = mensagens.flatMap((m) => fatiarMensagem(m, cfg.regras.maxCaracteres * 4))

    // ── Sequência: chegou mensagem nova enquanto pensávamos? ──────────────
    if (!semEfeito && await comTenantServico(tenantId, (tx) => chegouMensagemNova(tx, conversaId, tarefa.mensagens_ids))) {
      const decisaoId = await comTenantServico(tenantId, (tx) => registrarDecisao(tx, { tarefa, sessaoId: reuniao.sessao_id, modo, desfecho: 'superada', rastro, custo, resposta, bloqueados, guardrails, agora, latenciaMs: Date.now() - inicio }))
      return { desfecho: 'superada', mensagens: mensagensFinais, decisaoId, rastro }
    }

    // ── Modo: envia, sugere ou só registra ────────────────────────────────
    const envia = modo === 'autonomo'
    const idsSaida: string[] = []
    if (envia) {
      for (const texto of mensagensFinais) {
        const e = await enviar(tenantId, conversaId, texto, null, agora, { ehDisparo: false, marcador: 'agente' })
        if (!e.ok) {
          const decisaoId = await comTenantServico(tenantId, (tx) => registrarDecisao(tx, { tarefa, sessaoId: reuniao.sessao_id, modo, desfecho: 'falha', rastro, custo, resposta, guardrails, erro: `envio recusado: ${e.motivo}`, agora, latenciaMs: Date.now() - inicio }))
          return { desfecho: 'falha', motivo: 'envio_recusado', detalhe: e.motivo, decisaoId, rastro }
        }
        idsSaida.push(e.mensagemId)
      }
    }

    // ── Teto(pós): respondeu e estourou o teto da conversa → transfere em silêncio (P6) ─
    //    ANTES da persistência: a decisão, a fase da sessão e a entrega contam
    //    a mesma história. O custo deste turno ainda NÃO está somado na sessão.
    if (!semEfeito && !handoff) {
      const pos = await pipeline.teto.depois({ ...ctx, sessaoId, estado: { ...ctx.estado, ...p.estado } }, { custoCentavos: custo })
      if (pos.tipo === 'handoff') handoff = { motivo: pos.motivo, resumo: pos.resumo }
    }

    // ── Persistência: sessão + decisão + handoff ──────────────────────────
    const desfecho: DesfechoTurno = handoff ? 'handoff' : envia ? 'respondeu' : 'sugeriu'
    const uso = rastro?.uso ?? { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }
    const decisaoId = await comTenantServico(tenantId, async (tx) => {
      if (!semEfeito) {
        await garantirSessao(tx, { sessaoId, existente: !!reuniao.sessao_id, conversaId, canalId, modo: modoDoNumero, agora, porQue: motivoDisponibilidade(equipe) })
        await tx`
          UPDATE agente_sessao
             SET turnos = turnos + 1,
                 fase = ${resposta.fase ?? (handoff ? 'handoff' : registro.efeitos.propostaEnviada ? 'proposta' : 'descoberta')},
                 slots = slots || ${JSON.stringify(resposta.slots ?? {})}::text::jsonb,
                 tokens_entrada = tokens_entrada + ${uso.entrada + uso.cacheLeitura + uso.cacheEscrita},
                 tokens_saida = tokens_saida + ${uso.saida},
                 custo_centavos = custo_centavos + ${custo},
                 pedido_id = coalesce(${pedidoAberto?.pedidoId ?? null}::uuid, pedido_id)
           WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
        await patchEstado(tx, sessaoId, p.estado)
        if (envia) await tx`UPDATE conversa SET conduzida_por = 'ia' WHERE tenant_id = tenant_atual() AND id = ${conversaId} AND conduzida_por <> 'ia'`
        // Resumo extrativo a cada 10 turnos: é o que deixa retomar amanhã sem reler tudo (R3).
        const [sessao] = await tx<{ turnos: number }[]>`SELECT turnos FROM agente_sessao WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
        if (sessao && sessao.turnos % 10 === 0) await resumirSessao(tx, sessaoId).catch(() => undefined)
      }
      const id = await registrarDecisao(tx, { tarefa, sessaoId: semEfeito ? null : sessaoId, modo, desfecho, rastro, custo, resposta, bloqueados, guardrails, enviada: envia, idsSaida, handoff, agora, latenciaMs: Date.now() - inicio })
      if (handoff) {
        if (modo === 'autonomo') await entregarParaHumano(tx, { conversaId, canalId, sessaoId, motivo: handoff.motivo as MotivoHandoff, resumo: handoff.resumo, agora })
        else if (!semEfeito) await encerrarSessaoSemEntrega(tx, sessaoId, `${handoff.motivo}: ${handoff.resumo}`, agora)
      }
      if (desfecho === 'sugeriu' && !semEfeito) {
        await tx`
          INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
          VALUES (tenant_atual(), 'agente.sugestao', 'conversa', ${conversaId}, ${JSON.stringify({ conversaId, decisaoId: id })}::text::jsonb)`
      }
      return id
    })

    return { desfecho, mensagens: mensagensFinais, handoff: handoff ?? undefined, decisaoId, rastro }
  }

  // ── 4b. Resposta fixa de uma etapa: sem modelo, mesmo rabo ───────────────
  if (pre.decisao.tipo === 'resposta_fixa') {
    const d = pre.decisao
    return concluir({
      resposta: { mensagens: d.mensagens, confianca: 1, handoff: d.handoff, origem: 'fixa' },
      mensagens: d.mensagens,
      handoff: d.handoff ?? null, custo: 0, bloqueados: [], guardrails: guardrailsPre, estado: pre.estado,
    })
  }

  // ── 5. O laço ───────────────────────────────────────────────────────────
  const sistema = montarSistema({ persona: cfg.persona, politicas: cfg.politicas, objetivo: cfg.objetivo, slots: cfg.slots, alcada: cfg.alcada, capacidades })
  const mensagens: MensagemLlm[] = [
    ...historico.map((f): MensagemLlm => ({ papel: f.de === 'cliente' ? 'cliente' : 'nos', texto: f.texto })),
    {
      papel: 'operador',
      texto: instrucaoDoTurno({
        lead, slots: reuniao.slots, resumo: reuniao.resumo, memoria,
        pedido: pedidoAberto ? { itens: pedidoAberto.itens.length, totalCentavos: pedidoAberto.totalCentavos, estado: pedidoAberto.estado } : null,
        horaLocal: horaLocalDe(agora, fuso), primeiraResposta: ctx.primeiraResposta,
      }) + (avisoDoPedido ? `\n${avisoDoPedido}` : '') + (pre.instrucoes.length ? `\n${pre.instrucoes.join('\n')}` : ''),
    },
  ]

  const llm = deps.llm ?? (modeloEscolhido ? criarLlmDoCatalogo(modeloEscolhido) : llmFerramentasDoAmbiente())
  const r = await llm.rodar({
    sistema, mensagens, ferramentas: registro.definicoes, executar: registro.executar,
    esquemaSaida: esquemaDaResposta(),
    limites: { maxRodadas: cfg.maxRodadas, maxTokensSaida: 1500, prazoMs: cfg.prazoTurnoMs },
    esforco: 'low',
  })
  const custo = r.rastro ? await custoDoLaco({ provedor: r.rastro.provedor ?? llm.nome, modelo: r.rastro.modelo, uso: r.rastro.uso }) : 0

  if (!r.ok) {
    const recado = recadoDaFalha(r.motivo, r.detalhe)
    const falha = await pipeline.falha.decidir(ctx, { motivo: r.motivo, detalhe: recado, executouFerramentas: (r.rastro?.chamadas.length ?? 0) > 0, estado, tentativas: tarefa.tentativas })
    const rede = avisoPelaRede(falha.avisoCliente, registro.centavosVistos)
    const aviso = await avisarCliente(rede.texto, modo, (texto) => enviar(tenantId, conversaId, texto, null, agora, { ehDisparo: false, marcador: 'agente' }))
    const entrega = falha.acao === 'handoff' && modo === 'autonomo'
    const decisaoId = await comTenantServico(tenantId, async (tx) => {
      const id = await registrarDecisao(tx, { tarefa, sessaoId: reuniao.sessao_id, modo, desfecho: 'falha', rastro: r.rastro, custo, erro: recado, falhaTipo: falha.classe, guardrails: [...guardrailsPre, ...rede.guardrails], bloqueados: rede.bloqueados, idsSaida: aviso, enviada: aviso.length > 0, agora, latenciaMs: Date.now() - inicio })
      if (!semEfeito) {
        await garantirSessao(tx, { sessaoId, existente: !!reuniao.sessao_id, conversaId, canalId, modo: modoDoNumero, agora, porQue: motivoDisponibilidade(equipe) })
        await patchEstado(tx, sessaoId, juntarPatches([pre.estado, falha.estado]))
      }
      // ⚠️ Só em AUTÔNOMO a falha vira entrega real: em sombra/assistido o robô
      //    não estava falando com o cliente, então não há vácuo a cobrir — e
      //    criar atendimento poluiria a fila e calaria a própria coleta.
      if (entrega) await entregarParaHumano(tx, { conversaId, canalId, sessaoId, motivo: 'modelo_indisponivel', resumo: recado, agora })
      else if (!semEfeito && falha.acao !== 'aviso_e_reagendar') await encerrarSessaoSemEntrega(tx, sessaoId, recado, agora)
      return id
    })
    return {
      desfecho: entrega ? 'handoff' : 'falha', motivo: 'modelo_indisponivel', detalhe: recado, decisaoId, rastro: r.rastro,
      ...(falha.acao === 'aviso_e_reagendar' && falha.reagendarEmMs !== undefined ? { reagendarEmMs: falha.reagendarEmMs } : {}),
    }
  }

  // ── 6. Validação ────────────────────────────────────────────────────────
  const parse = respostaDoAgente.safeParse(r.saida)
  if (!parse.success) {
    const amostra = JSON.stringify(mascarar(r.saida) ?? null).slice(0, 220)
    const recado = `a IA respondeu fora do formato: ${parse.error.issues[0]?.path.join('.') ?? ''} ${parse.error.issues[0]?.message ?? ''} — recebido: ${amostra}`
    const falha = await pipeline.falha.decidir(ctx, { motivo: 'formato', detalhe: recado, executouFerramentas: r.rastro.chamadas.length > 0, estado, tentativas: tarefa.tentativas })
    const estadoDaFalha = juntarPatches([pre.estado, falha.estado])
    const rede = avisoPelaRede(falha.avisoCliente, registro.centavosVistos)
    const decisaoId = await comTenantServico(tenantId, (tx) => registrarDecisao(tx, { tarefa, sessaoId: reuniao.sessao_id, modo, desfecho: 'falha', rastro: r.rastro, custo, erro: recado, falhaTipo: falha.classe, guardrails: [...guardrailsPre, ...rede.guardrails], bloqueados: rede.bloqueados, agora, latenciaMs: Date.now() - inicio }))
    if (falha.acao === 'handoff') {
      return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'modelo_indisponivel', recado, modo, agora, decisaoId, { avisoCliente: rede.texto, centavosVistos: registro.centavosVistos, enviar, estado: estadoDaFalha, abrirSessao })
    }
    await avisarCliente(rede.texto, modo, (texto) => enviar(tenantId, conversaId, texto, null, agora, { ehDisparo: false, marcador: 'agente' }))
    if (!semEfeito) {
      await comTenantServico(tenantId, async (tx) => {
        const sid = await sessaoParaEstado(tx, { sessaoId: reuniao.sessao_id, estado: estadoDaFalha, tarefa, abrir: abrirSessao, agora })
        if (falha.acao === 'registrar') await encerrarSessaoSemEntrega(tx, sid, recado, agora)
      })
    }
    return {
      desfecho: 'falha', motivo: 'resposta_inesperada', detalhe: recado, decisaoId, rastro: r.rastro,
      ...(falha.acao === 'aviso_e_reagendar' && falha.reagendarEmMs !== undefined ? { reagendarEmMs: falha.reagendarEmMs } : {}),
    }
  }

  // ── 7. Guardrail R$ (o original, inegociável) ───────────────────────────
  let resposta: RespostaDoAgente = parse.data
  const guardrails: MarcaGuardrail[] = [...guardrailsPre]
  const bloqueados = resposta.mensagens.flatMap((m) => verificarNumerosNaResposta(m, registro.centavosVistos))
  if (bloqueados.length > 0) {
    // ⚠️ Número sem origem em ferramenta: a resposta NÃO sai como está. Remove
    //    os valores e pede confirmação humana — nunca "corrige" o número.
    guardrails.push(marca('guardrail-reais', 'valor_sem_fonte', 'CRITICA', 'substituido', resposta.mensagens.join(' ')))
    resposta = {
      ...resposta,
      mensagens: [AVISO_VALOR_BLOQUEADO],
      confianca: Math.min(resposta.confianca, 0.4),
      handoff: resposta.handoff ?? { motivo: 'incerteza', resumo: 'A IA citou um valor que não veio do catálogo; valores bloqueados pelo guardrail.' },
    }
  }
  if (resposta.confianca < cfg.limiarConfianca && !resposta.handoff) {
    resposta = { ...resposta, handoff: { motivo: 'incerteza', resumo: `Confiança ${resposta.confianca.toFixed(2)} abaixo do limiar ${cfg.limiarConfianca}.` } }
  }
  let handoff: { motivo: string; resumo: string } | null = registro.efeitos.handoff ?? resposta.handoff ?? null

  // ── 8. Depois do modelo: números → filtro → pergunta → qualidade ────────
  const cadeia = await rodarPosResposta(pipeline, ctx, {
    mensagens: resposta.mensagens, handoff, centavosVistos: registro.centavosVistos, numerosVistos: registro.numerosVistos,
    falasAnterioresDoAgente: historico.filter((h) => h.de === 'nos').map((h) => h.texto),
  })
  guardrails.push(...cadeia.guardrails)
  if (cadeia.bloqueio) handoff = { motivo: cadeia.bloqueio.motivo, resumo: cadeia.bloqueio.resumo }

  return concluir({
    // ⚠️ `resposta.mensagens` é o que SAI (depois do guardrail e da cadeia); o
    //    que o modelo escreveu fica em `original` — a auditoria mostra os dois.
    resposta: { ...resposta, mensagens: cadeia.mensagens, handoff: handoff ?? undefined, original: parse.data },
    mensagens: cadeia.mensagens,
    handoff, rastro: r.rastro, custo, bloqueados, guardrails, estado: juntarPatches([pre.estado, cadeia.estado]),
  })
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envia o aviso da política de falha — só em AUTÔNOMO e só se houver texto.
 * `texto` já passou por `avisoPelaRede`. Devolve os ids enviados (vazio quando
 * não enviou ou o gateway recusou).
 */
async function avisarCliente(
  texto: string | null, modo: ModoDoTurno | 'desligado',
  enviarAviso: (texto: string) => ReturnType<typeof enviarTextoNaConversa>,
): Promise<string[]> {
  if (modo !== 'autonomo' || !texto) return []
  const e = await enviarAviso(texto)
  return e.ok ? [e.mensagemId] : []
}

/**
 * REDE FINAL DE R$ PARA O AVISO FIXO (handoff sem modelo, política de falha).
 *
 * ⚠️ Hoje o aviso é texto de código; amanhã vem de configuração (P17) — e o
 *    "nada sai com valor sem fonte" vale para ele também. Aviso com valor sem
 *    origem em ferramenta NÃO sai (vira `null`): é cortesia, o handoff/reagendamento
 *    segue igual, e substituir por outro texto inventaria uma promessa. Antes do
 *    modelo não há ferramenta no turno, então qualquer valor é sem fonte.
 */
function avisoPelaRede(
  aviso: string | null | undefined, centavosVistos: ReadonlySet<number> = new Set(),
): { texto: string | null; guardrails: MarcaGuardrail[]; bloqueados: number[] } {
  if (!aviso) return { texto: null, guardrails: [], bloqueados: [] }
  const bloqueados = verificarNumerosNaResposta(aviso, centavosVistos)
  if (bloqueados.length === 0) return { texto: aviso, guardrails: [], bloqueados: [] }
  return { texto: null, guardrails: [marca('rede-final', 'valor_sem_fonte', 'CRITICA', 'removido', aviso)], bloqueados }
}

/** Como abrir a sessão quando uma etapa devolve estado e ainda não há sessão. */
interface AbrirSessao { readonly modo: string; readonly porQue: string }

/**
 * ESTADO SEM SESSÃO — a escolha (P0): se uma etapa do pipeline devolveu estado
 * e a conversa ainda não tem sessão ativa, a sessão NASCE aqui para guardá-lo.
 * Só acontece DEPOIS do portão (que já decidiu que o agente entra), então abrir
 * a sessão é coerente com o que o turno faria de qualquer jeito; descartar o
 * estado faria a raia perder, por exemplo, o "já avisei" no turno seguinte.
 * Sem `abrir` (simulação, copiloto, portão) o patch vale só para sessão existente.
 * Patch vazio não abre nada. Devolve a sessão que recebeu o estado (ou a de entrada).
 */
async function sessaoParaEstado(tx: Sql, p: {
  sessaoId: string | null; estado?: PatchEstado | undefined; tarefa: Tarefa; abrir?: AbrirSessao | undefined; agora: Date
}): Promise<string | null> {
  if (!p.estado || Object.keys(p.estado).length === 0) return p.sessaoId
  let id = p.sessaoId
  if (!id && p.abrir) {
    id = randomUUID()
    await garantirSessao(tx, { sessaoId: id, existente: false, conversaId: p.tarefa.conversa_id, canalId: p.tarefa.canal_id, modo: p.abrir.modo, agora: p.agora, porQue: p.abrir.porQue })
  }
  await patchEstado(tx, id, p.estado)
  return id
}

async function silencio(
  tenantId: string, tarefa: Tarefa, motivo: string, modo: string, agora: Date,
  extra: { guardrails?: readonly MarcaGuardrail[] | undefined; sessaoId?: string | null | undefined; estado?: PatchEstado | undefined; abrirSessao?: AbrirSessao | undefined } = {},
): Promise<ResultadoTurnoVendedor> {
  const semEfeito = modo === 'simulacao' || modo === 'copiloto'
  const decisaoId = await comTenantServico(tenantId, async (tx) => {
    const comEstado = !semEfeito && !!extra.estado && Object.keys(extra.estado).length > 0
    const sid = comEstado ? await sessaoParaEstado(tx, { sessaoId: extra.sessaoId ?? null, estado: extra.estado, tarefa, abrir: extra.abrirSessao, agora }) : null
    return registrarDecisao(tx, { tarefa, sessaoId: sid, modo, desfecho: 'silencio', portaoMotivo: motivo, guardrails: extra.guardrails, agora, latenciaMs: 0 })
  })
  return { desfecho: 'silencio', motivo, decisaoId }
}

/**
 * Entrega ao humano SEM chamar o modelo (portão, alçada, gatilho, falha).
 *
 * `avisoCliente` sai pelo gateway SÓ em autônomo — nos outros modos o robô não
 * estava falando com o cliente. Simulação e copiloto só registram: nunca
 * encerram sessão real nem abrem atendimento.
 */
async function handoffSemModelo(
  tenantId: string, tarefa: Tarefa, sessaoId: string | null, motivo: MotivoHandoff, resumo: string, modo: ModoDoTurno | 'desligado', agora: Date, decisaoId?: string,
  extra: {
    avisoCliente?: string | null | undefined; enviar?: typeof enviarTextoNaConversa | undefined
    guardrails?: readonly MarcaGuardrail[] | undefined; estado?: PatchEstado | undefined; falhaTipo?: ClasseFalha | undefined
    abrirSessao?: AbrirSessao | undefined
    /** Valores citados por ferramenta neste turno (vazio antes do modelo). */
    centavosVistos?: ReadonlySet<number> | undefined
  } = {},
): Promise<ResultadoTurnoVendedor> {
  const rede = avisoPelaRede(extra.avisoCliente, extra.centavosVistos)
  const idsAviso = await avisarCliente(rede.texto, modo,
    (texto) => (extra.enviar ?? enviarTextoNaConversa)(tenantId, tarefa.conversa_id, texto, null, agora, { ehDisparo: false, marcador: 'agente' }))
  const semEfeito = modo === 'simulacao' || modo === 'copiloto'
  const id = await comTenantServico(tenantId, async (tx) => {
    const sid = semEfeito ? null : await sessaoParaEstado(tx, { sessaoId, estado: extra.estado, tarefa, abrir: extra.abrirSessao, agora })
    const d = decisaoId ?? await registrarDecisao(tx, {
      tarefa, sessaoId: sid, modo, desfecho: 'handoff', handoff: { motivo, resumo }, guardrails: [...(extra.guardrails ?? []), ...rede.guardrails],
      bloqueados: rede.bloqueados, falhaTipo: extra.falhaTipo,
      enviada: idsAviso.length > 0, idsSaida: idsAviso, agora, latenciaMs: 0,
    })
    if (semEfeito) return d
    if (modo === 'autonomo') await entregarParaHumano(tx, { conversaId: tarefa.conversa_id, canalId: tarefa.canal_id, sessaoId: sid, motivo, resumo, agora })
    else await encerrarSessaoSemEntrega(tx, sid, `${motivo}: ${resumo}`, agora)
    return d
  })
  return { desfecho: 'handoff', motivo, handoff: { motivo, resumo }, decisaoId: id }
}

async function lerConfig(tx: Sql, canalId: string): Promise<ConfigVendedor | null> {
  const [l] = await tx<{
    modo: ModoAgente; politicas: string | null; persona: unknown; objetivo: 'vender' | 'qualificar'; alcada: unknown
    qualificacao: unknown; modelo: string | null; limiar_confianca: string; max_rodadas: number; prazo_turno_ms: number
    orcamento_dia_centavos: string | null
    so_quando_ninguem_disponivel: boolean; exigir_ausencia_antes: boolean; horas_desde_ausencia: number
    reabrir_apos_encerrada: boolean; horas_para_reabrir: number; minutos_presenca: number; max_turnos: number
    max_caracteres: number; falas_de_contexto: number; extra: Record<string, unknown> | null
  }[]>`
    SELECT ac.modo, ac.politicas, ac.persona, ac.objetivo, ac.alcada, ac.qualificacao, ac.modelo, ac.limiar_confianca,
           ac.max_rodadas, ac.prazo_turno_ms, ac.orcamento_dia_centavos,
           ac.so_quando_ninguem_disponivel, ac.exigir_ausencia_antes, ac.horas_desde_ausencia, ac.reabrir_apos_encerrada,
           ac.horas_para_reabrir, ac.minutos_presenca, ac.max_turnos, ac.max_caracteres, ac.falas_de_contexto,
           -- Leitura tolerante (plano-port-playbook-am §2.1): colunas novas das raias chegam aqui.
           to_jsonb(ac.*) AS extra
      FROM agente_config ac WHERE ac.tenant_id = tenant_atual() AND ac.canal_id = ${canalId}`
  if (!l) return null
  const p = REGRAS_AGENTE_PADRAO
  const alc = alcadaAgente.safeParse(l.alcada)
  const per = personaSchema.safeParse(l.persona)
  const slots = Array.isArray(l.qualificacao) ? (l.qualificacao as SlotQualificacao[]) : []
  return {
    modo: l.modo,
    politicas: l.politicas ?? '',
    persona: per.success ? per.data : personaSchema.parse({}),
    objetivo: l.objetivo,
    alcada: alc.success ? alc.data : ALCADA_PADRAO,
    slots,
    modelo: l.modelo,
    limiarConfianca: Number(l.limiar_confianca),
    maxRodadas: l.max_rodadas,
    prazoTurnoMs: l.prazo_turno_ms,
    orcamentoDiaCentavos: l.orcamento_dia_centavos === null ? null : Number(l.orcamento_dia_centavos),
    regras: {
      soQuandoNinguemDisponivel: l.so_quando_ninguem_disponivel ?? p.soQuandoNinguemDisponivel,
      exigirAusenciaAntes: l.exigir_ausencia_antes ?? p.exigirAusenciaAntes,
      horasDesdeAusencia: l.horas_desde_ausencia ?? p.horasDesdeAusencia,
      reabrirAposEncerrada: l.reabrir_apos_encerrada ?? p.reabrirAposEncerrada,
      horasParaReabrir: l.horas_para_reabrir ?? p.horasParaReabrir,
      minutosPresenca: l.minutos_presenca ?? p.minutosPresenca,
      maxTurnos: l.max_turnos ?? p.maxTurnos,
      maxCaracteres: l.max_caracteres ?? p.maxCaracteres,
      falasDeContexto: l.falas_de_contexto ?? p.falasDeContexto,
    },
    extra: l.extra ?? {},
  }
}

interface Reuniao {
  readonly ausencia_ja_enviada: boolean
  readonly atendente_presente: boolean
  readonly sessao_id: string | null
  readonly sessao_turnos: number | null
  readonly horas_desde_encerramento: number | null
  readonly humano_atendeu_depois: boolean
  readonly resumo: string | null
  readonly slots: Record<string, string>
}

async function reunirContexto(tx: Sql, conversaId: string, agora: Date, regras: RegrasDoAgente): Promise<Reuniao> {
  const [linha] = await tx<Reuniao[]>`
    SELECT EXISTS (SELECT 1 FROM mensagem m
                    WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId}
                      AND m.direcao = 'saliente' AND m.conteudo->>'automatica' = 'ausencia'
                      AND m.criado_em > ${agora}::timestamptz - make_interval(hours => ${regras.horasDesdeAusencia})) AS ausencia_ja_enviada,
           ${fragmentoAtendentePresente(tx, conversaId, agora, regras.minutosPresenca)} AS atendente_presente,
           s.id AS sessao_id, s.turnos AS sessao_turnos, s.resumo, coalesce(s.slots, '{}'::jsonb) AS slots,
           (SELECT extract(epoch FROM (${agora}::timestamptz - max(e.encerrada_em)))::float8 / 3600
              FROM agente_sessao e WHERE e.tenant_id = tenant_atual() AND e.conversa_id = ${conversaId} AND e.estado <> 'ativa') AS horas_desde_encerramento,
           EXISTS (SELECT 1 FROM atendimento a
                    WHERE a.tenant_id = tenant_atual() AND a.conversa_id = ${conversaId}
                      AND a.estado = 'encerrado' AND a.encerrado_em IS NOT NULL
                      AND a.encerrado_em > (SELECT max(e.encerrada_em) FROM agente_sessao e
                                             WHERE e.tenant_id = tenant_atual() AND e.conversa_id = ${conversaId} AND e.estado <> 'ativa')) AS humano_atendeu_depois
      FROM (SELECT 1) AS um
      LEFT JOIN agente_sessao s ON s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId} AND s.estado = 'ativa'`
  return { ...linha!, slots: (linha!.slots ?? {}) as Record<string, string> }
}

/**
 * As últimas falas, com mídia representada — o modelo precisa saber que houve
 * um áudio mesmo sem transcrição (R5 traz a transcrição para `conteudo`).
 */
async function carregarHistorico(tx: Sql, conversaId: string, falas: number): Promise<readonly Fala[]> {
  const linhas = await tx<{ direcao: string; tipo: string; conteudo: Record<string, unknown> }[]>`
    SELECT direcao, tipo, conteudo FROM mensagem
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND tipo <> 'sistema'
     ORDER BY criado_em DESC LIMIT ${falas}`
  return linhas.reverse().map((l) => ({ de: l.direcao === 'entrante' ? 'cliente' : 'nos', texto: textoDaMensagem(l.tipo, l.conteudo) } as const))
    .filter((f) => f.texto)
}

/**
 * As mensagens entrantes DESTE turno (as da tarefa), com o estado da
 * transcrição — gatilhos de entrada decidem sobre áudio pendente ou perdido.
 */
async function carregarEntrantes(tx: Sql, conversaId: string, ids: readonly string[]): Promise<readonly EntranteDoTurno[]> {
  if (ids.length === 0) return []
  const linhas = await tx<{ id: string; tipo: string; conteudo: Record<string, unknown> }[]>`
    SELECT id, tipo, conteudo FROM mensagem
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId} AND direcao = 'entrante'
       AND id = ANY(${[...ids]}::uuid[])
     ORDER BY criado_em`
  return linhas.map((l) => {
    const audioSemTexto = l.tipo === 'audio' && typeof l.conteudo['transcricao'] !== 'string'
    const desistiu = Number(l.conteudo['transcricao_tentativas'] ?? 0) >= MAX_TENTATIVAS_TRANSCRICAO
    return {
      id: l.id, tipo: l.tipo, texto: textoDaMensagem(l.tipo, l.conteudo),
      transcricaoPendente: audioSemTexto && !desistiu, transcricaoFalhou: audioSemTexto && desistiu,
    }
  })
}

function horaLocalDe(agora: Date, fuso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, weekday: 'long', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(agora)
  } catch {
    return agora.toISOString()
  }
}

export function textoDaMensagem(tipo: string, c: Record<string, unknown>): string {
  const texto = typeof c['texto'] === 'string' ? c['texto'] : ''
  if (tipo === 'texto') return texto
  if (tipo === 'audio') return typeof c['transcricao'] === 'string' ? `[áudio] ${c['transcricao']}` : '[áudio sem transcrição]'
  if (tipo === 'imagem') return `[imagem]${typeof c['legenda'] === 'string' ? ` ${c['legenda']}` : ''}`
  return texto || `[${tipo}]`
}

async function custoDoDia(tx: Sql, canalId: string, agora: Date, fuso: string): Promise<number> {
  // "Hoje" no fuso do TENANT: o teto diário vira à meia-noite da loja, não do servidor.
  const [r] = await tx<{ total: string }[]>`
    SELECT coalesce(sum(custo_centavos), 0)::text AS total FROM agente_decisao
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}
       AND criado_em >= (date_trunc('day', ${agora}::timestamptz AT TIME ZONE ${fuso}) AT TIME ZONE ${fuso})`
  return Number(r?.total ?? 0)
}

/**
 * Em sombra/assistido o handoff é só registro: a sessão fecha com o motivo
 * (como fecharia na entrega real) mas NÃO nasce atendimento nem notificação.
 */
async function encerrarSessaoSemEntrega(tx: Sql, sessaoId: string | null, motivo: string, agora: Date): Promise<void> {
  if (!sessaoId) return
  await tx`
    UPDATE agente_sessao SET estado = 'entregue', fase = 'handoff', motivo_saida = ${motivo.slice(0, 200)}, encerrada_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId} AND estado = 'ativa'`
}

async function garantirSessao(tx: Sql, p: { sessaoId: string; existente: boolean; conversaId: string; canalId: string; modo: string; agora: Date; porQue: string }): Promise<void> {
  if (p.existente) return
  await tx`
    INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, iniciada_em, motivo_entrada, modo)
    VALUES (tenant_atual(), ${p.sessaoId}, ${p.conversaId}, ${p.canalId}, ${p.agora}, ${p.porQue}, ${p.modo})
    ON CONFLICT DO NOTHING`
}

async function registrarDecisao(tx: Sql, p: {
  tarefa: Tarefa; sessaoId: string | null; modo: string; desfecho: DesfechoTurno
  rastro?: RastroDoLaco | undefined; custo?: number; resposta?: RespostaRegistrada; bloqueados?: number[]
  enviada?: boolean; idsSaida?: string[]; handoff?: { motivo: string; resumo: string } | null; erro?: string
  portaoMotivo?: string; agora: Date; latenciaMs: number
  /** Marcas das etapas do pipeline (0096). */
  guardrails?: readonly MarcaGuardrail[] | undefined
  /** Classe da falha do provedor (0096), quando o turno falhou no modelo. */
  falhaTipo?: ClasseFalha | undefined
}): Promise<string> {
  const id = randomUUID()
  const ferramentas = (p.rastro?.chamadas ?? []).map((c) => ({
    nome: c.nome, entrada: mascarar(c.entrada), saida: resumir(mascarar(c.saida)), ms: c.ms, ...(c.erro ? { erro: c.erro } : {}),
  }))
  await tx`
    INSERT INTO agente_decisao (
      tenant_id, id, conversa_id, canal_id, sessao_id, tarefa_id, mensagens_ids, modo, desfecho, portao_motivo,
      modelo, effort, ferramentas, resposta, confianca, handoff_motivo, numeros_bloqueados, uso, custo_centavos,
      latencia_ms, rodadas, enviada, mensagens_saida_ids, erro, guardrails, falha_tipo, criado_em)
    VALUES (
      tenant_atual(), ${id}, ${p.tarefa.conversa_id}, ${p.tarefa.canal_id}, ${p.sessaoId}, ${p.tarefa.id},
      ${[...p.tarefa.mensagens_ids]}::uuid[], ${p.modo}, ${p.desfecho}, ${p.portaoMotivo ?? null},
      ${p.rastro?.modelo ?? null}, ${p.rastro ? 'low' : null}, ${JSON.stringify(ferramentas)}::text::jsonb,
      ${p.resposta ? JSON.stringify(p.resposta) : null}::text::jsonb, ${p.resposta?.confianca ?? null},
      ${p.handoff?.motivo ?? p.resposta?.handoff?.motivo ?? null}, ${JSON.stringify(p.bloqueados ?? [])}::text::jsonb,
      ${JSON.stringify(p.rastro?.uso ?? {})}::text::jsonb, ${p.custo ?? 0}, ${p.latenciaMs}, ${p.rastro?.rodadas ?? 0},
      ${p.enviada ?? false}, ${p.idsSaida ?? []}::uuid[], ${p.erro ?? null},
      ${JSON.stringify(p.guardrails ?? [])}::text::jsonb, ${p.falhaTipo ?? null}, ${p.agora})`
  return id
}

/** Mascara CPF/CNPJ/telefone em qualquer string de um objeto antes de gravar. */
export function mascarar(v: unknown): unknown {
  if (typeof v === 'string') return mascararTexto(v)
  if (Array.isArray(v)) return v.map(mascarar)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, mascarar(x)]))
  return v
}

function resumir(v: unknown): unknown {
  const s = JSON.stringify(v ?? null)
  return s.length > 4000 ? { truncado: true, inicio: s.slice(0, 4000) } : v
}
