import { comTenantServico, type Sql } from '../../db/index.js'
import { ninguemDisponivel, quemAtende, type QuemAtende } from './disponibilidade.js'
import { enviarTextoNaConversa } from './envio-conversa.js'
import { fragmentoAtendentePresente } from './presenca-atendente.js'

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
 *
 * ⚠️ **A condição deixou de ser "fora do expediente" (2026-09-01).** Agora é a
 * MESMA pergunta que libera o agente: *tem alguém para atender este número?*
 * (`ninguemDisponivel`). O buraco era caro e silencioso: com a equipe toda
 * offline às 14h, a ausência dizia "dentro do expediente" e não saía — e como a
 * ausência é o GATILHO do agente (`exigirAusenciaAntes`, o padrão), o robô
 * também nunca entrava. Resultado: o produto ficava mudo exatamente no caso que
 * a decisão de 27/ago quis cobrir, e o motivo no log era `sem_ausencia_antes`,
 * que aponta para o lugar errado.
 *
 * ⚠️ Consequência para quem escreve o texto: ele pode sair EM horário comercial
 * (equipe offline). "Voltamos amanhã às 9h" vira mentira nesse caso — a dica da
 * tela pede um texto que sirva aos dois, do tipo "ninguém disponível agora".
 */

export type ResultadoAusencia =
  | 'enviada'
  | 'tem_quem_atenda'
  | 'sem_mensagem_configurada'
  | 'ja_respondida'
  | 'atendente_presente'
  | 'envio_recusado'

/** ⚠️ Uma resposta a cada 6h por conversa. Ver `responderAusencia`. */
const HORAS_ENTRE_RESPOSTAS = 6


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
 *
 * ⚠️ `equipe` vem de fora quando quem chama já leu o estado do número — é o caso
 * do fluxo entrante (`responderAutomaticamente`), onde a ausência e o agente
 * decidem sobre a MESMA leitura. Duas leituras no mesmo evento poderiam
 * divergir (um batimento cai entre elas) e produzir a contradição mais cara
 * daqui: a ausência dizendo "não tem ninguém" e o agente calando por
 * `tem_quem_atenda`.
 */
export async function responderAusencia(
  tenantId: string, conversaId: string, canalId: string, agora: Date = new Date(),
  equipe?: QuemAtende,
): Promise<ResultadoAusencia> {
  const contexto = await comTenantServico(tenantId, async (tx: Sql) => {
    const [linha] = await tx<{
      mensagem_ausencia: string | null
      atendente_presente: boolean
      ja_respondida: boolean
    }[]>`
      SELECT cfg.mensagem_ausencia,
             ${fragmentoAtendentePresente(tx, conversaId, agora)} AS atendente_presente,
             EXISTS (SELECT 1 FROM mensagem m
                      WHERE m.tenant_id = cfg.tenant_id AND m.conversa_id = ${conversaId}
                        AND m.direcao = 'saliente'
                        AND m.conteudo->>'automatica' = 'ausencia'
                        AND m.criado_em > ${agora}::timestamptz - make_interval(hours => ${HORAS_ENTRE_RESPOSTAS}))
               AS ja_respondida
        FROM canal_configuracao cfg
       WHERE cfg.tenant_id = tenant_atual() AND cfg.canal_id = ${canalId}`
    // ⚠️ Canal sem mensagem escrita sai daqui sem gastar a segunda consulta: o
    //    desfecho já é `sem_mensagem_configurada`, e isto roda a cada mensagem
    //    entrante — uma consulta a mais por mensagem é carga real num inbox
    //    movimentado.
    if (!linha?.mensagem_ausencia?.trim()) return null
    // ⚠️ Só vai ao banco pela equipe se quem chamou não trouxe a leitura.
    return { ...linha, equipe: equipe ?? await quemAtende(tx, canalId, agora) }
  })

  // Sem configuração nenhuma para este canal: nada a fazer, e não é erro.
  if (!contexto?.mensagem_ausencia?.trim()) return 'sem_mensagem_configurada'
  if (contexto.atendente_presente) return 'atendente_presente'
  // ⚠️ Fora do expediente, ninguém logado ou todos ausentes — a mesma régua do
  //    agente, em `disponibilidade.ts`. Havendo quem atenda, quem responde é
  //    GENTE: mandar "ninguém está aqui" com a equipe na mesa é pior que calar.
  if (!ninguemDisponivel(contexto.equipe)) return 'tem_quem_atenda'
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
