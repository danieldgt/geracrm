/**
 * O HORÁRIO DE ATENDIMENTO do canal — a pergunta "a loja está aberta agora?".
 *
 * ⚠️ Mora sozinho porque é usado por DOIS lados que não podem se importar entre
 * si: a disponibilidade da equipe (`disponibilidade.ts`) e a resposta de
 * ausência (`ausencia.ts`), que desde 2026-09-01 pergunta à disponibilidade
 * antes de falar. Deixar o expediente dentro de um dos dois criaria um ciclo de
 * import — e o conserto preguiçoso do ciclo é duplicar a função, que é
 * exatamente o erro que produziu o robô falando por cima de atendente.
 */

/** Faixa de atendimento de um dia. `null` = fechado. */
export interface Faixa { readonly de: string; readonly ate: string }
export type HorarioAtendimento = Record<string, Faixa | null>

/** 1 (segunda) … 7 (domingo) — o `ID` do `to_char` do Postgres. */
const DIA_POR_ISO: Record<number, string> = {
  1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab', 7: 'dom',
}

/**
 * Está fora do expediente?
 *
 * ⚠️ **Horário não configurado devolve `false`** — ou seja, a loja conta como
 * ABERTA. Quem não declarou expediente não declarou fechamento: assumir
 * "fechado" faria todo tenant que nunca abriu essa tela responder
 * automaticamente 24h por dia.
 *
 * ⚠️ Isto sozinho NÃO decide mais se o produto responde: desde 2026-09-01 a
 * pergunta é "tem alguém para atender?" (`ninguemDisponivel`), e o expediente é
 * uma das três coisas que ela considera. Dentro do expediente com a equipe toda
 * offline, o cliente também ficava no vácuo — era o buraco.
 *
 * ⚠️ Faixa que vira a meia-noite (22:00–02:00) é tratada: sem isso, uma loja que
 * atende à noite seria considerada fechada durante o próprio expediente.
 */
export function foraDoExpediente(
  horario: HorarioAtendimento | null | undefined, diaIso: number, horaLocal: string,
): boolean {
  if (!horario || Object.keys(horario).length === 0) return false

  const faixa = horario[DIA_POR_ISO[diaIso] ?? '']
  if (!faixa?.de || !faixa?.ate) return true   // dia declarado como fechado

  // Comparação lexicográfica de "HH:MM" — funciona porque o formato é fixo.
  return faixa.de <= faixa.ate
    ? horaLocal < faixa.de || horaLocal >= faixa.ate
    : horaLocal < faixa.de && horaLocal >= faixa.ate   // faixa que cruza a meia-noite
}
