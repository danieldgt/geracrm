import type { Sql } from '../../db/index.js'
import { foraDoExpediente, type HorarioAtendimento } from './ausencia.js'

/**
 * TEM ALGUÉM PARA ATENDER ESTE NÚMERO?
 *
 * ⚠️ É a pergunta que decide se o agente entra (regra definida pelo dono do
 * produto em 27/ago). A regra anterior era "fora do expediente", e ela deixava
 * um buraco caro: o consultor entra em reunião às 14h, o cliente escreve, e o
 * produto fica MUDO porque tecnicamente é horário comercial.
 *
 * Um usuário está DISPONÍVEL quando as três coisas valem:
 *   1. não se marcou ausente;
 *   2. está dentro do expediente configurado para o canal;
 *   3. deu sinal de vida na ferramenta recentemente.
 *
 * ⚠️ Por NÚMERO, via `usuario_canal`. Um consultor de outro número estar online
 * não pode calar o agente de um número onde ninguém atende — o cliente que
 * escreveu não faz ideia de que existem duas equipes.
 */

/**
 * Por quanto tempo um batimento do console conta como "está na ferramenta".
 *
 * ⚠️ Fechar o navegador não avisa ninguém: a ausência de sinal É o sinal. Cinco
 * minutos é curto o bastante para o produto perceber que a sala esvaziou, e
 * longo o bastante para sobreviver a uma troca de aba ou a uma reconexão.
 */
export const MINUTOS_DE_SESSAO = 5

export interface QuemAtende {
  /** Quantos podem enviar por este número (independente de estarem ali). */
  readonly vinculados: number
  /** Quantos estão logados agora (batimento recente), ausentes ou não. */
  readonly logados: number
  /** Quantos estão logados E não se marcaram ausentes. */
  readonly ativos: number
  readonly foraDoExpediente: boolean
}

/**
 * Ninguém disponível — o agente pode assumir.
 *
 * ⚠️ Fora do expediente é suficiente por si: não adianta ter gente logada às 23h
 * se a loja está fechada. Dentro do expediente, o que decide é haver ao menos um
 * usuário logado e não-ausente.
 */
export function ninguemDisponivel(q: QuemAtende): boolean {
  if (q.foraDoExpediente) return true
  return q.ativos === 0
}

/**
 * Por que o agente pode (ou não) assumir — texto para log e auditoria.
 *
 * ⚠️ Existe porque "o agente respondeu" e "o agente ficou quieto" precisam ser
 * explicáveis depois. Sem o motivo, a única forma de entender é reproduzir o
 * estado da equipe naquele minuto, que já passou.
 */
export function motivoDisponibilidade(q: QuemAtende): string {
  if (q.foraDoExpediente) return 'fora do expediente'
  if (q.vinculados === 0) return 'nenhum usuário vinculado a este número'
  if (q.logados === 0) return 'ninguém logado na ferramenta'
  if (q.ativos === 0) return `todos os ${q.logados} logados estão marcados como ausentes`
  return `${q.ativos} de ${q.vinculados} disponíveis`
}

/**
 * Lê o estado da equipe daquele número, agora.
 *
 * ⚠️ Uma consulta só: a decisão do agente roda a cada mensagem entrante, e três
 * idas ao banco por mensagem viram carga real num inbox movimentado.
 */
export async function quemAtende(
  tx: Sql, canalId: string, agora: Date,
): Promise<QuemAtende> {
  const [linha] = await tx<{
    vinculados: number; logados: number; ativos: number
    horario: HorarioAtendimento | null; dia_iso: number; hora_local: string
  }[]>`
    SELECT
      count(*)::int AS vinculados,
      count(*) FILTER (
        WHERE u.visto_em > ${agora}::timestamptz - make_interval(mins => ${MINUTOS_DE_SESSAO})
      )::int AS logados,
      count(*) FILTER (
        WHERE NOT u.ausente
          AND u.visto_em > ${agora}::timestamptz - make_interval(mins => ${MINUTOS_DE_SESSAO})
      )::int AS ativos,
      (SELECT cfg.horario_atendimento FROM canal_configuracao cfg
        WHERE cfg.tenant_id = tenant_atual() AND cfg.canal_id = ${canalId}) AS horario,
      EXTRACT(ISODOW FROM (${agora}::timestamptz AT TIME ZONE t.fuso))::int AS dia_iso,
      to_char(${agora}::timestamptz AT TIME ZONE t.fuso, 'HH24:MI')          AS hora_local
      FROM tenant t
      LEFT JOIN usuario_canal uc ON uc.tenant_id = t.id AND uc.canal_id = ${canalId}
      -- ⚠️ Só usuário ATIVO conta: desligado da empresa não segura o agente.
      LEFT JOIN usuario u ON u.tenant_id = t.id AND u.id = uc.usuario_id AND u.ativo
     WHERE t.id = tenant_atual()
     GROUP BY t.fuso`

  return {
    vinculados: linha?.vinculados ?? 0,
    logados: linha?.logados ?? 0,
    ativos: linha?.ativos ?? 0,
    foraDoExpediente: foraDoExpediente(linha?.horario ?? null, linha?.dia_iso ?? 1, linha?.hora_local ?? '12:00'),
  }
}
