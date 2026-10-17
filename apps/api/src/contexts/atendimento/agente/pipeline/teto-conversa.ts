import { comTenantServico } from '../../../../db/index.js'
import { custoDaSessao, tetoSessaoEfetivo, verificarOrcamentoNoTurno } from '../custo.js'
import { marca, type EtapaTetoConversa } from './tipos.js'

/**
 * TETO DE CUSTO POR CONVERSA (ADR-032, raia P6). Pega loop e conversa
 * patológica: o teto diário do número protege o caixa do dia; este protege
 * contra UMA sessão que consome o dia inteiro.
 *
 * Teto: `agente_config.teto_sessao_centavos` do número (`cfgExtra`), senão
 * `IA_TETO_SESSAO_CENTAVOS`, senão R$ 3,00; 0 desliga. O acumulado é a soma das
 * decisões da sessão, inclusive as que falharam (`custoDaSessao`) — está no
 * banco, sobrevive a restart.
 *
 *   antes  — a sessão JÁ está no teto: nem chama o modelo.
 *            autônomo → handoff `limite_de_custo_conversa` COM aviso ao cliente;
 *            sombra/assistido → silêncio (não há cliente a avisar: quem responde
 *            é o humano). Simulação e copiloto não têm sessão: seguem.
 *   depois — este turno levou a sessão ao teto: a resposta já saiu; transfere
 *            EM SILÊNCIO (o próximo turno nem chega a pagar o modelo).
 *
 * Também dispara a verificação do orçamento MENSAL do tenant (só alerta), que
 * nunca derruba o turno. O teto DIÁRIO por número continua no portão de
 * `vendedor.ts`.
 */

/** Aviso ao cliente: sem número, sem prazo, sem promessa (passa pelos filtros de saída). */
export const AVISO_TETO_CONVERSA = 'Vou chamar uma pessoa da nossa equipe para continuar o seu atendimento por aqui.'

export const etapaTetoConversa: EtapaTetoConversa = {
  nome: 'teto-conversa',

  async antes(ctx) {
    await verificarOrcamentoNoTurno(ctx.tenantId, ctx.agora)
    const teto = tetoSessaoEfetivo(ctx.cfgExtra)
    if (teto === null || !ctx.sessaoId || ctx.modo === 'simulacao' || ctx.modo === 'copiloto') return { tipo: 'segue' }
    const acumulado = await comTenantServico(ctx.tenantId, (tx) => custoDaSessao(tx, ctx.sessaoId, ctx.conversaId))
    if (acumulado < teto) return { tipo: 'segue' }
    if (ctx.modo !== 'autonomo') return { tipo: 'silencio', motivo: 'limite_de_custo_conversa' }
    return {
      tipo: 'handoff',
      motivo: 'limite_de_custo_conversa',
      resumo: `Custo da conversa no teto (${acumulado} de ${teto} centavos): o agente parou antes de chamar o modelo.`,
      avisoCliente: AVISO_TETO_CONVERSA,
      guardrails: [marca('teto-conversa', 'limite_de_custo_conversa', 'ALTA', 'handoff')],
    }
  },

  async depois(ctx, turno) {
    // O turno que acabou de gastar entra no mês (ainda não persistido: vai como
    // extra). `forcar`: o `antes` deste mesmo turno, com o mesmo `agora`, já
    // ocupou o intervalo — sem forçar, a verificação pós-turno nunca rodaria.
    // Só turno que GASTOU paga a soma.
    if (turno.custoCentavos > 0) {
      await verificarOrcamentoNoTurno(ctx.tenantId, ctx.agora, { custoExtraCentavos: turno.custoCentavos, forcar: true })
    }
    const teto = tetoSessaoEfetivo(ctx.cfgExtra)
    if (teto === null || ctx.modo === 'simulacao' || ctx.modo === 'copiloto') return { tipo: 'segue' }
    // ⚠️ O custo deste turno ainda NÃO está somado na sessão (contrato de P0).
    const acumulado = (await comTenantServico(ctx.tenantId, (tx) => custoDaSessao(tx, ctx.sessaoId, ctx.conversaId))) + turno.custoCentavos
    if (acumulado < teto) return { tipo: 'segue' }
    return {
      tipo: 'handoff',
      motivo: 'limite_de_custo_conversa',
      resumo: `Custo da conversa chegou ao teto neste turno (${acumulado} de ${teto} centavos): respondeu e transferiu sem aviso.`,
    }
  },
}
