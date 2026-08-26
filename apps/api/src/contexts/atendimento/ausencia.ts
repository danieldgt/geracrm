import { comTenantServico, type Sql } from '../../db/index.js'
import { enviarTextoNaConversa } from './envio-conversa.js'

/**
 * RESPOSTA DE AUSÊNCIA — o campo que existia na tela e não fazia nada.
 *
 * ⚠️ `canal_configuracao.mensagem_ausencia` está na migration `0011` e na tela de
 * Config. do Canal desde então. Nenhuma linha do sistema a enviava. Quem
 * configurasse ficava achando que tinha ligado uma resposta fora do expediente —
 * e o cliente escrevia às 22h para o silêncio. Campo decorativo é pior que campo
 * ausente: ele promete.
 *
 * ⚠️ **Isto NÃO é o agente (AQ-19).** Não interpreta, não decide, não conversa:
 * diz que ninguém está e quando alguém volta. É a diferença entre administrar a
 * expectativa e fingir atendimento. O escopo do agente — e por que ele exige
 * outro nível de rigor — está em `docs/agente-sdr-escopo.md`.
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
 * ⚠️ **Horário não configurado devolve `false`** — ou seja, NÃO responde. Quem
 * não declarou expediente não declarou ausência: assumir "fechado" mandaria
 * resposta automática 24h por dia para todo tenant que nunca abriu essa tela.
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

export type ResultadoAusencia =
  | 'enviada'
  | 'dentro_do_expediente'
  | 'sem_mensagem_configurada'
  | 'ja_respondida'
  | 'atendente_presente'
  | 'envio_recusado'

/** ⚠️ Uma resposta a cada 6h por conversa. Ver `responderAusencia`. */
const HORAS_ENTRE_RESPOSTAS = 6

/**
 * Por quanto tempo uma pessoa continua "na mesa" depois do último sinal de vida.
 *
 * ⚠️ Existe porque a versão anterior perguntava apenas se HAVIA atendimento
 * aberto com atendente — sem prazo. Em produção (26/ago) uma conversa assumida
 * em 12/ago e esquecida fez o cliente escrever 14 dias depois e não receber
 * nada: a assunção esquecida desligava a resposta automática para sempre, e o
 * sintoma era SILÊNCIO — ninguém no CRM descobria.
 */
const MINUTOS_DE_PRESENCA = 60

/**
 * Responde a ausência, se for o caso. **Pós-commit** — é rede.
 *
 * ⚠️ **Uma vez a cada 6 horas por conversa.** Sem isso, cinco mensagens seguidas
 * do cliente às 22h viram cinco respostas automáticas iguais: o robô parece
 * quebrado e a pessoa desiste de escrever. O marcador fica no próprio conteúdo
 * da mensagem (`automatica: 'ausencia'`), então a conta é exata — não depende de
 * comparar o texto, que muda quando alguém edita a configuração.
 *
 * ⚠️ **Não responde se há atendente PRESENTE**: quem responde é ele — receber
 * "estamos fechados" no meio de um atendimento humano é a pior forma de
 * descobrir que existe um robô. Presença tem prazo (`MINUTOS_DE_PRESENCA`):
 * assunção esquecida não é presença, é um registro velho.
 */
export async function responderAusencia(
  tenantId: string, conversaId: string, canalId: string, agora: Date = new Date(),
): Promise<ResultadoAusencia> {
  const contexto = await comTenantServico(tenantId, async (tx: Sql) => {
    const [linha] = await tx<{
      mensagem_ausencia: string | null
      horario_atendimento: HorarioAtendimento | null
      dia_iso: number
      hora_local: string
      atendente_presente: boolean
      ja_respondida: boolean
    }[]>`
      SELECT cfg.mensagem_ausencia, cfg.horario_atendimento,
             EXTRACT(ISODOW FROM (${agora}::timestamptz AT TIME ZONE t.fuso))::int AS dia_iso,
             to_char(${agora}::timestamptz AT TIME ZONE t.fuso, 'HH24:MI')          AS hora_local,
             -- ⚠️ TEM GENTE ALI AGORA? — e não "existe um registro de assunção".
             --    A pergunta antiga não tinha prazo, então um atendimento
             --    assumido e esquecido calava a ausência para sempre naquela
             --    conversa. E o raciocínio que resolve é simples: a ausência só
             --    roda FORA DO EXPEDIENTE, e com a loja fechada não há ninguém
             --    na mesa — a trava existe para quem está digitando NESTE
             --    instante, não para uma linha de banco de 14 dias atrás.
             EXISTS (SELECT 1 FROM atendimento a
                      WHERE a.tenant_id = cfg.tenant_id AND a.conversa_id = ${conversaId}
                        AND a.estado <> 'encerrado' AND a.atendente_id IS NOT NULL
                        AND (
                          -- acabou de assumir e ainda não digitou: está chegando
                          a.assumido_em > ${agora}::timestamptz
                                          - make_interval(mins => ${MINUTOS_DE_PRESENCA})
                          -- ⚠️ ou respondeu com as próprias mãos. A coluna
                          --    enviada_por_id separa pessoa de sistema: disparo
                          --    de campanha vai sem autor, e sem esse filtro uma
                          --    campanha passaria por atendente presente.
                          OR EXISTS (SELECT 1 FROM mensagem m
                                      WHERE m.tenant_id = cfg.tenant_id
                                        AND m.conversa_id = ${conversaId}
                                        AND m.direcao = 'saliente'
                                        AND m.enviada_por_id IS NOT NULL
                                        AND m.criado_em > ${agora}::timestamptz
                                            - make_interval(mins => ${MINUTOS_DE_PRESENCA}))
                        )) AS atendente_presente,
             EXISTS (SELECT 1 FROM mensagem m
                      WHERE m.tenant_id = cfg.tenant_id AND m.conversa_id = ${conversaId}
                        AND m.direcao = 'saliente'
                        AND m.conteudo->>'automatica' = 'ausencia'
                        AND m.criado_em > ${agora}::timestamptz - make_interval(hours => ${HORAS_ENTRE_RESPOSTAS}))
               AS ja_respondida
        FROM canal_configuracao cfg
        JOIN tenant t ON t.id = cfg.tenant_id
       WHERE cfg.tenant_id = tenant_atual() AND cfg.canal_id = ${canalId}`
    return linha ?? null
  })

  // Sem configuração nenhuma para este canal: nada a fazer, e não é erro.
  if (!contexto?.mensagem_ausencia?.trim()) return 'sem_mensagem_configurada'
  if (contexto.atendente_presente) return 'atendente_presente'
  if (!foraDoExpediente(contexto.horario_atendimento, contexto.dia_iso, contexto.hora_local)) {
    return 'dentro_do_expediente'
  }
  if (contexto.ja_respondida) return 'ja_respondida'

  const r = await enviarTextoNaConversa(
    tenantId, conversaId, contexto.mensagem_ausencia.trim(), null, agora,
    // ⚠️ `ehDisparo: false`: isto é RESPOSTA a quem acabou de escrever, dentro da
    //    janela de 24h, 1:1. A pausa de disparo protege o número do tráfego em
    //    massa — bloquear a resposta de ausência seria calar o produto pelo
    //    problema oposto.
    { ehDisparo: false, marcador: 'ausencia' },
  )
  return r.ok ? 'enviada' : 'envio_recusado'
}
