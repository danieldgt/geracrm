import { randomUUID } from 'node:crypto'
import {
  ALCADA_PADRAO, PERFIL_PRECO_PADRAO, REGRAS_AGENTE_PADRAO, alcadaAgente, persona as personaSchema,
  perfilDeCotacao, respostaDoAgente, verificarNumerosNaResposta, fatiarMensagem,
  type AlcadaAgente, type ModoAgente, type PersonaResolvida, type RegrasDoAgente, type RespostaDoAgente,
  type SlotQualificacao, type MotivoHandoff,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../db/index.js'
import { enviarTextoNaConversa } from '../envio-conversa.js'
import { quemAtende, ninguemDisponivel, motivoDisponibilidade, type QuemAtende } from '../disponibilidade.js'
import { fragmentoAtendentePresente } from '../presenca-atendente.js'
import { carregarContextoDoLead } from './contexto-lead.js'
import { portaoDoAgente, type MotivoNaoEntra } from './portao.js'
import { recadoDaFalha, type Fala } from './porta.js'
import { custoEstimadoCentavos, type PortaLlmFerramentas, type MensagemLlm, type RastroDoLaco } from './porta-llm.js'
import { registroDeFerramentas, type ContextoFerramenta } from './ferramentas/porta.js'
import { montarFerramentas } from './ferramentas/montar.js'
import { conhecimentoDasPoliticas } from './ferramentas/conhecimento-politicas.js'
import type { Ligacoes } from './ferramentas/ligacoes-porta.js'
import { montarSistema, instrucaoDoTurno, esquemaDaResposta } from './instrucao-vendedor.js'
import { entregarParaHumano } from './handoff.js'
import { chegouMensagemNova, type Tarefa } from './fila.js'
import { llmFerramentasDoAmbiente } from './fabrica-ferramentas.js'
import { efetivarSeDentroDaAlcada } from '../../pedido/alcada.js'

/**
 * UM TURNO DO VENDEDOR (ADR-023) — roda no worker, nunca no webhook.
 *
 *   contexto → portão → ferramentas → laço → validação → guardrail →
 *   verificação de sequência → modo (sombra/assistido/autônomo) → envio →
 *   auditoria (agente_decisao) → sessão
 *
 * ⚠️ Tudo que o modelo diz passa por `respostaDoAgente` (shared) e pelo
 * guardrail numérico: valor que não veio de ferramenta neste turno não sai.
 * ⚠️ Falha do modelo NÃO é silêncio: vira handoff `modelo_indisponivel`, com
 * atendimento na fila e notificação (invariante 5 do escopo).
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
}

export interface DepsTurno {
  readonly llm?: PortaLlmFerramentas | undefined
  readonly ligacoes: (cfg: { tenantId: string; politicas: string; modo: ModoAgente | 'simulacao' }) => Promise<Ligacoes> | Ligacoes
  readonly enviar?: typeof enviarTextoNaConversa | undefined
  readonly equipe?: QuemAtende | undefined
  readonly agora?: Date | undefined
  /** Simulação (playground): nunca envia, grava decisão com modo 'simulacao'. */
  readonly simulacao?: boolean | undefined
}

export async function conduzirTurnoVendedor(tarefa: Tarefa, deps: DepsTurno): Promise<ResultadoTurnoVendedor> {
  const agora = deps.agora ?? new Date()
  const { tenant_id: tenantId, conversa_id: conversaId, canal_id: canalId } = tarefa
  const inicio = Date.now()

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
    const equipe = deps.equipe ?? await quemAtende(tx, canalId, agora)
    const custoHoje = cfg.orcamentoDiaCentavos === null ? 0 : await custoDoDia(tx, canalId, agora, fusoLinha?.fuso ?? 'America/Sao_Paulo')
    return {
      tipo: 'ok' as const, cfg, conv, reuniao, equipe, custoHoje,
      perfil: perfilDeCotacao(perfilLinha?.perfil_preco ?? PERFIL_PRECO_PADRAO),
      ausenciaRecemEnviada: ausenciaAgora?.recem ?? false, fuso: fusoLinha?.fuso ?? 'America/Sao_Paulo',
    }
  })
  if (dados.tipo === 'desligado') return silencio(tenantId, tarefa, 'agente_desligado', 'desligado', agora)
  if (dados.tipo === 'sem_conversa') return { desfecho: 'silencio', motivo: 'conversa_inexistente' }
  const { cfg, conv, reuniao, equipe, custoHoje, perfil, ausenciaRecemEnviada, fuso } = dados
  const modo: ModoAgente | 'simulacao' = deps.simulacao ? 'simulacao' : cfg.modo

  // ── 2. Portão ───────────────────────────────────────────────────────────
  if (!deps.simulacao) {
    if (conv.humano_assumiu) return silencio(tenantId, tarefa, 'humano_assumiu', modo, agora)
    // ⚠️ A ausência acabou de responder ESTAS mensagens: com "esperar o cliente
    //    insistir" ligado, o agente fica para a próxima — duas automáticas
    //    seguidas, a primeira dizendo "não há ninguém", é a contradição do §4.3.1.
    if (cfg.regras.exigirAusenciaAntes && ausenciaRecemEnviada) return silencio(tenantId, tarefa, 'ausencia_recem_enviada', modo, agora)
    const decisao = portaoDoAgente({
      agenteAtivo: cfg.modo !== 'desligado',
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
          reuniao.resumo ?? 'Teto de idas e vindas atingido sem fechar.', modo, agora)
      }
      return silencio(tenantId, tarefa, decisao.motivo, modo, agora)
    }
    if (cfg.orcamentoDiaCentavos !== null && custoHoje >= cfg.orcamentoDiaCentavos) {
      return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'limite_de_custo', 'Teto diário de custo do agente atingido.', modo, agora)
    }
  }

  // ── 2.5 Pedido CONFIRMADO pelo cliente nesta conversa → alçada (ADR-027) ──
  //    O "sim" foi interpretado pelo domínio na ingestão. Aqui o agente só
  //    decide o que acontece depois: dentro da alçada o domínio efetiva; fora,
  //    nasce um atendimento na fila com o resumo. Nunca o modelo.
  let avisoDoPedido: string | null = null
  const centavosDoPedidoConfirmado: number[] = []
  if (!deps.simulacao) {
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
          await (deps.enviar ?? enviarTextoNaConversa)(tenantId, conversaId,
            'Perfeito, pedido confirmado! Nossa equipe vai finalizar e te retorna em breve com os próximos passos.',
            null, agora, { ehDisparo: false, marcador: 'agente' })
        }
        return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'acima_da_alcada',
          `Pedido confirmado pelo cliente (total ${total}) aguarda um vendedor para faturar: ${r.decisao.motivo}.`, modo, agora)
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
            await (deps.enviar ?? enviarTextoNaConversa)(tenantId, conversaId,
              'Perfeito, pedido confirmado! Nossa equipe vai finalizar e te retorna em breve com os próximos passos.',
              null, agora, { ehDisparo: false, marcador: 'agente' })
          }
          return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'acima_da_alcada',
            `Pedido confirmado pelo cliente (total ${total}) aguarda faturamento manual: o sistema da loja não recebe pedido automático.`, modo, agora)
        } else {
          return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'acima_da_alcada',
            `Pedido confirmado pelo cliente (total ${total}) não pôde ser efetivado: ${e.tipo}${e.tipo === 'falha' ? ` (${e.falha.tipo})` : ''}.`, modo, agora)
        }
      }
    }
  }

  // ── 3. Lead, histórico, ferramentas ─────────────────────────────────────
  const [lead, historico] = await comTenantServico(tenantId, async (tx) => [
    await carregarContextoDoLead(tx, conversaId),
    await carregarHistorico(tx, conversaId, cfg.regras.falasDeContexto),
  ] as const)
  if (!lead) return { desfecho: 'silencio', motivo: 'sem_lead' }

  const sessaoId = reuniao.sessao_id ?? randomUUID()
  const ctxFerr: ContextoFerramenta = { tenantId, conversaId, contatoId: conv.contato_id, canalId, perfil, sessaoId: reuniao.sessao_id, modo, agora, enviar: deps.enviar }
  const ligacoesBase = await deps.ligacoes({ tenantId, politicas: cfg.politicas, modo })
  const ligacoes: Ligacoes = { ...ligacoesBase, conhecimento: ligacoesBase.conhecimento ?? conhecimentoDasPoliticas(cfg.politicas) }
  const { ferramentas, capacidades } = montarFerramentas(ligacoes)
  const registro = registroDeFerramentas(ctxFerr, ferramentas)
  const pedidoAberto = ligacoes.pedido ? await ligacoes.pedido.ver(ctxFerr).catch(() => null) : null

  const sistema = montarSistema({ persona: cfg.persona, politicas: cfg.politicas, objetivo: cfg.objetivo, slots: cfg.slots, alcada: cfg.alcada, capacidades })
  const mensagens: MensagemLlm[] = [
    ...historico.map((f): MensagemLlm => ({ papel: f.de === 'cliente' ? 'cliente' : 'nos', texto: f.texto })),
    {
      papel: 'operador',
      texto: instrucaoDoTurno({
        lead, slots: reuniao.slots, resumo: reuniao.resumo, memoria: [],
        pedido: pedidoAberto ? { itens: pedidoAberto.itens.length, totalCentavos: pedidoAberto.totalCentavos, estado: pedidoAberto.estado } : null,
        horaLocal: horaLocalDe(agora, fuso), primeiraResposta: !historico.some((h) => h.de === 'nos'),
      }) + (avisoDoPedido ? `\n${avisoDoPedido}` : ''),
    },
  ]
  if (pedidoAberto) for (const c of [pedidoAberto.totalCentavos, ...pedidoAberto.itens.flatMap((i) => [i.valorUnitarioCentavos, i.subtotalCentavos])]) registro.centavosVistos.add(c)
  for (const c of centavosDoPedidoConfirmado) registro.centavosVistos.add(c)

  // ── 4. O laço ───────────────────────────────────────────────────────────
  const llm = deps.llm ?? llmFerramentasDoAmbiente()
  const r = await llm.rodar({
    sistema, mensagens, ferramentas: registro.definicoes, executar: registro.executar,
    esquemaSaida: esquemaDaResposta(),
    limites: { maxRodadas: cfg.maxRodadas, maxTokensSaida: 1500, prazoMs: cfg.prazoTurnoMs },
    modelo: cfg.modelo ?? undefined, esforco: 'low',
  })
  const custo = r.rastro ? custoEstimadoCentavos(r.rastro.modelo, r.rastro.uso) : 0

  if (!r.ok) {
    const recado = recadoDaFalha(r.motivo, r.detalhe)
    const decisaoId = await comTenantServico(tenantId, async (tx) => {
      const id = await registrarDecisao(tx, { tarefa, sessaoId: reuniao.sessao_id, modo, desfecho: 'falha', rastro: r.rastro, custo, erro: recado, agora, latenciaMs: Date.now() - inicio })
      if (!deps.simulacao) await garantirSessao(tx, { sessaoId, existente: !!reuniao.sessao_id, conversaId, canalId, modo: cfg.modo, agora, porQue: motivoDisponibilidade(equipe) })
      // ⚠️ Só em AUTÔNOMO a falha vira entrega real: em sombra/assistido o robô
      //    não estava falando com o cliente, então não há vácuo a cobrir — e
      //    criar atendimento poluiria a fila e calaria a própria coleta.
      if (modo === 'autonomo') await entregarParaHumano(tx, { conversaId, canalId, sessaoId, motivo: 'modelo_indisponivel', resumo: recado, agora })
      else if (!deps.simulacao) await encerrarSessaoSemEntrega(tx, sessaoId, recado, agora)
      return id
    })
    return { desfecho: modo === 'autonomo' ? 'handoff' : 'falha', motivo: 'modelo_indisponivel', detalhe: recado, decisaoId, rastro: r.rastro }
  }

  // ── 5. Validação + guardrail ────────────────────────────────────────────
  const parse = respostaDoAgente.safeParse(r.saida)
  if (!parse.success) {
    const recado = `a IA respondeu fora do formato: ${parse.error.issues[0]?.message ?? ''}`
    const decisaoId = await comTenantServico(tenantId, (tx) => registrarDecisao(tx, { tarefa, sessaoId: reuniao.sessao_id, modo, desfecho: 'falha', rastro: r.rastro, custo, erro: recado, agora, latenciaMs: Date.now() - inicio }))
    if (deps.simulacao) return { desfecho: 'falha', motivo: 'resposta_inesperada', detalhe: recado, decisaoId, rastro: r.rastro }
    return await handoffSemModelo(tenantId, tarefa, reuniao.sessao_id, 'modelo_indisponivel', recado, modo, agora, decisaoId)
  }
  let resposta: RespostaDoAgente = parse.data
  const bloqueados = resposta.mensagens.flatMap((m) => verificarNumerosNaResposta(m, registro.centavosVistos))
  if (bloqueados.length > 0) {
    // ⚠️ Número sem origem em ferramenta: a resposta NÃO sai como está. Remove
    //    os valores e pede confirmação humana — nunca "corrige" o número.
    resposta = {
      ...resposta,
      mensagens: ['Vou confirmar os valores certinhos com a equipe e já te retorno.'],
      confianca: Math.min(resposta.confianca, 0.4),
      handoff: resposta.handoff ?? { motivo: 'incerteza', resumo: 'A IA citou um valor que não veio do catálogo; valores bloqueados pelo guardrail.' },
    }
  }
  if (resposta.confianca < cfg.limiarConfianca && !resposta.handoff) {
    resposta = { ...resposta, handoff: { motivo: 'incerteza', resumo: `Confiança ${resposta.confianca.toFixed(2)} abaixo do limiar ${cfg.limiarConfianca}.` } }
  }
  const handoff = registro.efeitos.handoff ?? resposta.handoff ?? null
  const mensagensFinais = resposta.mensagens.flatMap((m) => fatiarMensagem(m, cfg.regras.maxCaracteres * 4))

  // ── 6. Sequência: chegou mensagem nova enquanto pensávamos? ─────────────
  if (!deps.simulacao && await comTenantServico(tenantId, (tx) => chegouMensagemNova(tx, conversaId, tarefa.mensagens_ids))) {
    const decisaoId = await comTenantServico(tenantId, (tx) => registrarDecisao(tx, { tarefa, sessaoId: reuniao.sessao_id, modo, desfecho: 'superada', rastro: r.rastro, custo, resposta, bloqueados, agora, latenciaMs: Date.now() - inicio }))
    return { desfecho: 'superada', mensagens: mensagensFinais, decisaoId, rastro: r.rastro }
  }

  // ── 7. Modo: envia, sugere ou só registra ───────────────────────────────
  const envia = modo === 'autonomo'
  const idsSaida: string[] = []
  if (envia) {
    const enviar = deps.enviar ?? enviarTextoNaConversa
    for (const texto of mensagensFinais) {
      const e = await enviar(tenantId, conversaId, texto, null, agora, { ehDisparo: false, marcador: 'agente' })
      if (!e.ok) {
        const decisaoId = await comTenantServico(tenantId, (tx) => registrarDecisao(tx, { tarefa, sessaoId: reuniao.sessao_id, modo, desfecho: 'falha', rastro: r.rastro, custo, resposta, erro: `envio recusado: ${e.motivo}`, agora, latenciaMs: Date.now() - inicio }))
        return { desfecho: 'falha', motivo: 'envio_recusado', detalhe: e.motivo, decisaoId, rastro: r.rastro }
      }
      idsSaida.push(e.mensagemId)
    }
  }

  // ── 8. Persistência: sessão + decisão + handoff ─────────────────────────
  const desfecho: DesfechoTurno = handoff ? 'handoff' : envia ? 'respondeu' : 'sugeriu'
  const decisaoId = await comTenantServico(tenantId, async (tx) => {
    if (!deps.simulacao) {
      await garantirSessao(tx, { sessaoId, existente: !!reuniao.sessao_id, conversaId, canalId, modo: cfg.modo, agora, porQue: motivoDisponibilidade(equipe) })
      await tx`
        UPDATE agente_sessao
           SET turnos = turnos + 1,
               fase = ${resposta.fase ?? (handoff ? 'handoff' : registro.efeitos.propostaEnviada ? 'proposta' : 'descoberta')},
               slots = slots || ${JSON.stringify(resposta.slots ?? {})}::text::jsonb,
               tokens_entrada = tokens_entrada + ${r.rastro.uso.entrada + r.rastro.uso.cacheLeitura + r.rastro.uso.cacheEscrita},
               tokens_saida = tokens_saida + ${r.rastro.uso.saida},
               custo_centavos = custo_centavos + ${custo},
               pedido_id = coalesce(${pedidoAberto?.pedidoId ?? null}::uuid, pedido_id)
         WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
      if (envia) await tx`UPDATE conversa SET conduzida_por = 'ia' WHERE tenant_id = tenant_atual() AND id = ${conversaId} AND conduzida_por <> 'ia'`
    }
    const id = await registrarDecisao(tx, { tarefa, sessaoId: deps.simulacao ? null : sessaoId, modo, desfecho, rastro: r.rastro, custo, resposta, bloqueados, enviada: envia, idsSaida, handoff, agora, latenciaMs: Date.now() - inicio })
    if (handoff) {
      if (modo === 'autonomo') await entregarParaHumano(tx, { conversaId, canalId, sessaoId, motivo: handoff.motivo as MotivoHandoff, resumo: handoff.resumo, agora })
      else if (!deps.simulacao) await encerrarSessaoSemEntrega(tx, sessaoId, `${handoff.motivo}: ${handoff.resumo}`, agora)
    }
    if (desfecho === 'sugeriu' && !deps.simulacao) {
      await tx`
        INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
        VALUES (tenant_atual(), 'agente.sugestao', 'conversa', ${conversaId}, ${JSON.stringify({ conversaId, decisaoId: id })}::text::jsonb)`
    }
    return id
  })

  return { desfecho, mensagens: mensagensFinais, handoff: handoff ?? undefined, decisaoId, rastro: r.rastro }
}

// ─────────────────────────────────────────────────────────────────────────────

async function silencio(tenantId: string, tarefa: Tarefa, motivo: string, modo: string, agora: Date): Promise<ResultadoTurnoVendedor> {
  const decisaoId = await comTenantServico(tenantId, (tx) => registrarDecisao(tx, { tarefa, sessaoId: null, modo, desfecho: 'silencio', portaoMotivo: motivo, agora, latenciaMs: 0 }))
  return { desfecho: 'silencio', motivo, decisaoId }
}

async function handoffSemModelo(
  tenantId: string, tarefa: Tarefa, sessaoId: string | null, motivo: MotivoHandoff, resumo: string, modo: string, agora: Date, decisaoId?: string,
): Promise<ResultadoTurnoVendedor> {
  const id = await comTenantServico(tenantId, async (tx) => {
    const d = decisaoId ?? await registrarDecisao(tx, { tarefa, sessaoId, modo, desfecho: 'handoff', handoff: { motivo, resumo }, agora, latenciaMs: 0 })
    if (modo === 'autonomo') await entregarParaHumano(tx, { conversaId: tarefa.conversa_id, canalId: tarefa.canal_id, sessaoId, motivo, resumo, agora })
    else await encerrarSessaoSemEntrega(tx, sessaoId, `${motivo}: ${resumo}`, agora)
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
    max_caracteres: number; falas_de_contexto: number
  }[]>`
    SELECT modo, politicas, persona, objetivo, alcada, qualificacao, modelo, limiar_confianca, max_rodadas, prazo_turno_ms,
           orcamento_dia_centavos,
           so_quando_ninguem_disponivel, exigir_ausencia_antes, horas_desde_ausencia, reabrir_apos_encerrada,
           horas_para_reabrir, minutos_presenca, max_turnos, max_caracteres, falas_de_contexto
      FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
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
  rastro?: RastroDoLaco | undefined; custo?: number; resposta?: RespostaDoAgente; bloqueados?: number[]
  enviada?: boolean; idsSaida?: string[]; handoff?: { motivo: string; resumo: string } | null; erro?: string
  portaoMotivo?: string; agora: Date; latenciaMs: number
}): Promise<string> {
  const id = randomUUID()
  const ferramentas = (p.rastro?.chamadas ?? []).map((c) => ({
    nome: c.nome, entrada: mascarar(c.entrada), saida: resumir(mascarar(c.saida)), ms: c.ms, ...(c.erro ? { erro: c.erro } : {}),
  }))
  await tx`
    INSERT INTO agente_decisao (
      tenant_id, id, conversa_id, canal_id, sessao_id, tarefa_id, mensagens_ids, modo, desfecho, portao_motivo,
      modelo, effort, ferramentas, resposta, confianca, handoff_motivo, numeros_bloqueados, uso, custo_centavos,
      latencia_ms, rodadas, enviada, mensagens_saida_ids, erro, criado_em)
    VALUES (
      tenant_atual(), ${id}, ${p.tarefa.conversa_id}, ${p.tarefa.canal_id}, ${p.sessaoId}, ${p.tarefa.id},
      ${[...p.tarefa.mensagens_ids]}::uuid[], ${p.modo}, ${p.desfecho}, ${p.portaoMotivo ?? null},
      ${p.rastro?.modelo ?? null}, ${p.rastro ? 'low' : null}, ${JSON.stringify(ferramentas)}::text::jsonb,
      ${p.resposta ? JSON.stringify(p.resposta) : null}::text::jsonb, ${p.resposta?.confianca ?? null},
      ${p.handoff?.motivo ?? p.resposta?.handoff?.motivo ?? null}, ${JSON.stringify(p.bloqueados ?? [])}::text::jsonb,
      ${JSON.stringify(p.rastro?.uso ?? {})}::text::jsonb, ${p.custo ?? 0}, ${p.latenciaMs}, ${p.rastro?.rodadas ?? 0},
      ${p.enviada ?? false}, ${p.idsSaida ?? []}::uuid[], ${p.erro ?? null}, ${p.agora})`
  return id
}

/** Mascara CPF/CNPJ/telefone em qualquer string de um objeto antes de gravar. */
export function mascarar(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '***').replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '***').replace(/\b55\d{10,11}\b/g, '55***')
  if (Array.isArray(v)) return v.map(mascarar)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, mascarar(x)]))
  return v
}

function resumir(v: unknown): unknown {
  const s = JSON.stringify(v ?? null)
  return s.length > 4000 ? { truncado: true, inicio: s.slice(0, 4000) } : v
}
