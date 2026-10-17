import { proximaAbertura, situacaoDoExpediente, type Feriados, type HorarioAtendimento } from './expediente.js'

/**
 * MINUTOS ÚTEIS — o relógio do SLA do handoff (raia P18, ADR-034).
 *
 * ⚠️ A régua "a loja está aberta?" é UMA só: `situacaoDoExpediente` e
 *    `proximaAbertura` (P11, `expediente.ts`), com feriado e fuso IANA do
 *    tenant. Aqui não há calendário próprio: o relógio anda minuto a minuto
 *    enquanto aberto e SALTA para a próxima abertura quando fechado. Escrever
 *    um "quando fecha" à parte criaria a segunda cópia da régua — e a faixa que
 *    vira a meia-noite e o feriado são exatamente onde as duas divergiriam.
 *
 * Custo: no máximo `minutos` consultas ao `Intl` mais um salto por fechamento
 * — é chamado UMA vez por handoff, nunca por linha numa listagem.
 */

/** Teto de saltos (fechamentos) antes de desistir — ~2 meses de dias úteis. */
const MAX_SALTOS = 64

/**
 * O instante em que `minutos` minutos ÚTEIS terão passado desde `inicio`.
 *
 * - Fora do expediente, a contagem começa na PRÓXIMA ABERTURA.
 * - Atravessa fechamento (noite, fim de semana, feriado) sem contar.
 * - Horário não configurado = sempre aberto (régua de `foraDoExpediente`): só
 *   o feriado fecha.
 * - `null` quando não há abertura no horizonte de `proximaAbertura` (todos os
 *   dias fechados) — quem chama decide (o handoff cai no relógio de parede).
 */
export function somarMinutosUteis(
  inicio: Date, minutos: number,
  horario: HorarioAtendimento | null | undefined, feriados: Feriados | null | undefined, fuso: string,
): Date | null {
  let cursor = inicio.getTime()
  let restante = Math.max(0, Math.floor(minutos))
  let saltos = 0
  while (true) {
    const agora = new Date(cursor)
    // O último minuto útil terminou no fechamento: vence AGORA (18:00), não na
    // abertura seguinte — o prazo foi cumprido dentro do expediente.
    if (restante === 0 && cursor !== inicio.getTime()) return agora
    if (situacaoDoExpediente(horario, feriados, agora, fuso) !== 'aberto') {
      if (++saltos > MAX_SALTOS) return null
      const abre = proximaAbertura(horario, feriados, agora, fuso)
      if (!abre) return null
      // Garante progresso mesmo se a abertura cair no mesmo instante.
      cursor = Math.max(abre.getTime(), cursor + 1)
      continue
    }
    if (restante === 0) return agora
    cursor += 60_000
    restante--
  }
}
