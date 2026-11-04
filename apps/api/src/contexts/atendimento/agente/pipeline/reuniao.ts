import { verificarReuniaoNaResposta, type MarcaGuardrail } from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { avisarUsuario } from '../../../crm/reuniao.js'
import { chaveDoTurno, descartarReuniaoDoTurno, lerReuniaoDoTurno } from '../ferramentas/agenda-turno.js'
import { marca, type ContextoPipeline, type EtapaPosResposta, type EtapaPreLlm } from './tipos.js'

/**
 * REUNIÃO (raia C3, revisão A1/A3/B5) — duas etapas, uma de cada lado do envio.
 *
 *  • `etapaReuniao` (pós-resposta, depois dos números): com a agenda ligada no número, a resposta
 *    só fala de horário de reunião com FONTE no turno (`verificarReuniaoNaResposta`, shared):
 *    hora/data/dia citados = um `quando` devolvido por `agendar_reuniao` no MESMO turno;
 *    "marcado/agendado/confirmado" só com evento criado no turno; oferta só com as linhas
 *    "n) quando com X" montadas pelo código. Senão BARRA — mesmo tratamento do guardrail numérico
 *    (texto substituto e entrega à equipe por incerteza). Não tem chave de desligar.
 *  • `etapaReuniaoPosEnvio` (pré-modelo que só registra um EFEITO pós-envio): depois da tentativa
 *    de envio, (A3) marca a oferta como ENVIADA só se as linhas chegaram ao gateway — turno barrado
 *    ou envio recusado deixa a oferta inválida; (B5) evento criado cuja confirmação não chegou ao
 *    cliente fica marcado na decisão e o vendedor é avisado.
 */
const ETAPA = 'reuniao'
export const AVISO_REUNIAO_BLOQUEADA = 'Vou confirmar os horários com a equipe e já te retorno.'

/** A agenda está ligada neste número? (chave do número; o módulo é conferido no banco) */
async function agendaLigada(ctx: ContextoPipeline): Promise<boolean> {
  if (ctx.cfgExtra?.['agenda_reunioes'] !== true) return false
  const [m] = await comTenantServico(ctx.tenantId, (tx) => tx<{ ativo: boolean }[]>`
    SELECT ativo FROM tenant_modulo WHERE tenant_id = tenant_atual() AND modulo = 'agenda'`)
  return m?.ativo === true
}

export const etapaReuniao: EtapaPosResposta = {
  nome: ETAPA,
  async executar(ctx, entrada) {
    const turno = lerReuniaoDoTurno(chaveDoTurno(ctx.tenantId, ctx.conversaId, ctx.agora))
    if (!turno && !(await agendaLigada(ctx))) return { mensagens: entrada.mensagens, guardrails: [] }
    const violacoes = verificarReuniaoNaResposta(entrada.mensagens, {
      quandos: turno?.quandos ?? [], agendado: !!turno?.agendado, usouFerramenta: turno?.usouFerramenta ?? false,
      linhasOfertadas: turno?.linhasOfertadas ?? [],
    })
    if (violacoes.length === 0) return { mensagens: entrada.mensagens, guardrails: [] }
    const citados = [...new Set(violacoes.map((v) => `"${v.trecho}"`))].join(', ')
    return {
      mensagens: [AVISO_REUNIAO_BLOQUEADA],
      guardrails: violacoes.map((v) => marca(ETAPA, v.codigo, 'CRITICA', 'substituido', v.trecho)),
      bloquear: {
        motivo: 'incerteza',
        resumo: `A IA falou de reunião sem fonte no turno (${citados}); resposta bloqueada pela guarda da agenda.`.slice(0, 600),
        mensagensSubstitutas: [AVISO_REUNIAO_BLOQUEADA],
      },
    }
  },
}

export const etapaReuniaoPosEnvio: EtapaPreLlm = {
  nome: `${ETAPA}-pos-envio`,
  async executar(ctx) {
    if (ctx.cfgExtra?.['agenda_reunioes'] !== true) return { tipo: 'segue' }
    const chave = chaveDoTurno(ctx.tenantId, ctx.conversaId, ctx.agora)
    return {
      tipo: 'segue',
      efeitos: [{
        nome: `${ETAPA}-pos-envio`,
        async executar(tx, r): Promise<readonly MarcaGuardrail[]> {
          const turno = lerReuniaoDoTurno(chave)
          descartarReuniaoDoTurno(chave)
          if (!turno) return []
          const marcas: MarcaGuardrail[] = []
          const enviado = r.enviadas.map((e) => e.texto).join('\n')
          if (turno.ofertaId) {
            const todas = turno.linhasOfertadas.length > 0 && turno.linhasOfertadas.every((l) => enviado.includes(l))
            const msg = r.enviadas.find((e) => e.texto.includes(turno.linhasOfertadas[0] ?? '\u0000'))
            if (todas && msg) {
              await tx`UPDATE reuniao_oferta SET enviada_em = now(), mensagem_id = ${msg.mensagemId}
                        WHERE tenant_id = tenant_atual() AND id = ${turno.ofertaId} AND enviada_em IS NULL`
            } else {
              marcas.push(marca(ETAPA, 'oferta_nao_enviada', 'INFO', 'registrado'))
            }
          }
          if (turno.agendado && !r.enviadas.some((e) => e.texto.includes(turno.agendado!.hora))) {
            marcas.push(marca(ETAPA, 'reuniao_sem_confirmacao_ao_cliente', 'ALTA', 'registrado', turno.agendado.quando))
            await avisarUsuario(tx, turno.agendado.usuarioId, 'agenda.reuniao',
              `Reunião com ${turno.agendado.contato} (${turno.agendado.quando}) marcada pelo agente, mas a confirmação não chegou ao cliente. Confirme com ele.`)
          }
          return marcas
        },
      }],
    }
  },
}
