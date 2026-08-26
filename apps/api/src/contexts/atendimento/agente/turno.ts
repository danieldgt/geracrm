import { randomUUID } from 'node:crypto'
import { comTenantServico, type Sql } from '../../../db/index.js'
import { enviarTextoNaConversa } from '../envio-conversa.js'
import { foraDoExpediente, type HorarioAtendimento } from '../ausencia.js'
import { fragmentoAtendentePresente } from '../presenca-atendente.js'
import { carregarContextoDoLead } from './contexto-lead.js'
import { validarExtracao } from './extracao.js'
import { llmDoAmbiente } from './fabrica.js'
import { portaoDoAgente, type MotivoNaoEntra } from './portao.js'
import type { Fala, PortaLlm } from './porta.js'

/**
 * UM TURNO DO AGENTE — a ligação entre a mensagem que chegou e o que sai.
 *
 * ⚠️ **Pós-commit e best-effort**, como a resposta de ausência: a mensagem do
 * cliente JÁ está salva quando isto roda. Nada aqui pode derrubar o 200 do
 * webhook — falhar aqui faria o provedor reenviar a mensagem do cliente em
 * loop por causa de uma cortesia que não saiu.
 *
 * ⚠️ Quando o modelo falha, o cliente NÃO fica sem resposta: a ausência já
 * falou antes (é o gatilho, §4.3.1 do escopo). Essa é a degradação desenhada —
 * agente fora do ar deixa exatamente o comportamento de hoje.
 */

/** Quantas mensagens da conversa vão como histórico. */
const FALAS_DE_CONTEXTO = 10
/** ⚠️ A ausência precisa ter saído nesta noite, não semana passada. */
const HORAS_DESDE_A_AUSENCIA = 12
/** Mensagem de WhatsApp: parágrafo longo não é lido. */
const MAX_CARACTERES = 320

export type ResultadoTurno =
  | { readonly falou: true; readonly encerrouPor: string | null }
  | { readonly falou: false; readonly motivo: MotivoNaoEntra | 'sem_lead' | 'modelo_falhou' | 'envio_recusado' }

interface Reuniao {
  readonly ativo: boolean
  readonly politicas: string | null
  readonly max_turnos: number
  readonly horario: HorarioAtendimento | null
  readonly dia_iso: number
  readonly hora_local: string
  readonly ausencia_ja_enviada: boolean
  readonly atendente_presente: boolean
  readonly sessao_id: string | null
  readonly sessao_turnos: number | null
  readonly sessao_ja_encerrada: boolean
}

export async function conduzirTurno(
  tenantId: string, conversaId: string, canalId: string,
  agora: Date = new Date(),
  // ⚠️ Costuras de teste, no mesmo estilo do `{ buscar }` dos adaptadores: sem
  //    elas, testar o orquestrador chamaria o fornecedor de IA E o WhatsApp de
  //    verdade — dinheiro, lentidão e falha por rede oscilante.
  deps: { readonly llm?: PortaLlm; readonly enviar?: typeof enviarTextoNaConversa } = {},
): Promise<ResultadoTurno> {
  const reuniao = await comTenantServico(tenantId, (tx) => reunirContexto(tx, conversaId, canalId, agora))
  if (!reuniao) return { falou: false, motivo: 'agente_desligado' }

  const decisao = portaoDoAgente({
    agenteAtivo: reuniao.ativo,
    foraDoExpediente: foraDoExpediente(reuniao.horario, reuniao.dia_iso, reuniao.hora_local),
    ausenciaJaEnviada: reuniao.ausencia_ja_enviada,
    atendentePresente: reuniao.atendente_presente,
    sessaoAtiva: reuniao.sessao_id ? { turnos: reuniao.sessao_turnos ?? 0 } : null,
    sessaoJaEncerrada: reuniao.sessao_ja_encerrada,
    maxTurnos: reuniao.max_turnos,
  })

  if (!decisao.entra) {
    // ⚠️ Bater no teto de turnos ENCERRA a sessão com motivo — senão ela ficaria
    //    aberta para sempre, e a conversa nunca chegaria ao humano.
    if (decisao.motivo === 'teto_de_turnos' && reuniao.sessao_id) {
      await comTenantServico(tenantId, (tx) =>
        encerrarSessao(tx, reuniao.sessao_id!, 'teto de turnos sem qualificar', agora))
    }
    return { falou: false, motivo: decisao.motivo }
  }

  const [lead, historico] = await comTenantServico(tenantId, async (tx) => [
    await carregarContextoDoLead(tx, conversaId),
    await carregarHistorico(tx, conversaId),
  ] as const)
  if (!lead) return { falou: false, motivo: 'sem_lead' }

  const llm = deps.llm ?? llmDoAmbiente()
  const r = await llm.conversar({
    historico, lead, politicas: reuniao.politicas ?? '', maxCaracteres: MAX_CARACTERES,
  })

  if (!r.ok) {
    // ⚠️ Encerra com o motivo do fornecedor. A conversa fica para o humano de
    //    manhã, e o cliente já recebeu a ausência — ninguém ficou no vácuo.
    if (reuniao.sessao_id) {
      await comTenantServico(tenantId, (tx) =>
        encerrarSessao(tx, reuniao.sessao_id!, `modelo falhou: ${r.motivo}`, agora))
    }
    return { falou: false, motivo: 'modelo_falhou' }
  }

  const extraido = validarExtracao(r.dados.extraidoBruto)

  // ⚠️ Fala pelo GATEWAY ÚNICO, como todo mundo: opt-out, estado do canal e
  //    credencial são checados lá (INV-50). O agente não tem caminho paralelo.
  const envio = await (deps.enviar ?? enviarTextoNaConversa)(
    tenantId, conversaId, r.dados.texto.slice(0, MAX_CARACTERES), null, agora,
    { ehDisparo: false, marcador: 'agente' },
  )
  if (!envio.ok) return { falou: false, motivo: 'envio_recusado' }

  const encerrouPor = r.dados.proximoPasso === 'continuar' ? null : (r.dados.motivo || r.dados.proximoPasso)

  await comTenantServico(tenantId, async (tx) => {
    const sessaoId = reuniao.sessao_id ?? randomUUID()
    if (!reuniao.sessao_id) {
      await tx`
        INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, iniciada_em)
        VALUES (tenant_atual(), ${sessaoId}, ${conversaId}, ${canalId}, ${agora})`
    }
    await tx`
      UPDATE agente_sessao
         SET turnos = turnos + 1,
             extraido = ${JSON.stringify(semDescartados(extraido))}::text::jsonb,
             descartados = descartados || ${JSON.stringify(extraido.descartados)}::text::jsonb,
             tokens_entrada = tokens_entrada + ${r.custo.tokensEntrada},
             tokens_saida   = tokens_saida   + ${r.custo.tokensSaida}
       WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
    if (encerrouPor) await encerrarSessao(tx, sessaoId, encerrouPor, agora)
  })

  return { falou: true, encerrouPor }
}

/**
 * Tudo que a decisão precisa, numa consulta só.
 *
 * ⚠️ A régua de presença vem do fragmento compartilhado com a resposta de
 * ausência: duas cópias divergiriam, e o sintoma seria o robô falando por cima
 * de um atendente.
 */
async function reunirContexto(
  tx: Sql, conversaId: string, canalId: string, agora: Date,
): Promise<Reuniao | null> {
  const [linha] = await tx<Reuniao[]>`
    SELECT coalesce(ag.ativo, false) AS ativo,
           ag.politicas,
           coalesce(ag.max_turnos, 6) AS max_turnos,
           cfg.horario_atendimento AS horario,
           EXTRACT(ISODOW FROM (${agora}::timestamptz AT TIME ZONE t.fuso))::int AS dia_iso,
           to_char(${agora}::timestamptz AT TIME ZONE t.fuso, 'HH24:MI')         AS hora_local,
           EXISTS (SELECT 1 FROM mensagem m
                    WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId}
                      AND m.direcao = 'saliente'
                      AND m.conteudo->>'automatica' = 'ausencia'
                      AND m.criado_em > ${agora}::timestamptz
                          - make_interval(hours => ${HORAS_DESDE_A_AUSENCIA})) AS ausencia_ja_enviada,
           ${fragmentoAtendentePresente(tx, conversaId, agora)} AS atendente_presente,
           (SELECT s.id     FROM agente_sessao s
             WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
               AND s.estado = 'ativa') AS sessao_id,
           (SELECT s.turnos FROM agente_sessao s
             WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
               AND s.estado = 'ativa') AS sessao_turnos,
           EXISTS (SELECT 1 FROM agente_sessao s
                    WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
                      AND s.estado <> 'ativa') AS sessao_ja_encerrada
      FROM tenant t
      LEFT JOIN canal_configuracao cfg
             ON cfg.tenant_id = t.id AND cfg.canal_id = ${canalId}
      LEFT JOIN agente_config ag
             ON ag.tenant_id = t.id AND ag.canal_id = ${canalId}
     WHERE t.id = tenant_atual()`
  return linha ?? null
}

/**
 * As últimas falas, em ordem cronológica.
 *
 * ⚠️ A resposta de ausência entra como fala nossa, de propósito: sem ela o
 * modelo não sabe que o cliente já foi avisado do horário e repete a informação
 * na primeira frase.
 */
async function carregarHistorico(tx: Sql, conversaId: string): Promise<readonly Fala[]> {
  const linhas = await tx<{ direcao: string; texto: string | null }[]>`
    SELECT direcao, conteudo->>'texto' AS texto
      FROM mensagem
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId}
       AND conteudo->>'texto' IS NOT NULL
     ORDER BY criado_em DESC
     LIMIT ${FALAS_DE_CONTEXTO}`
  return linhas
    .reverse()
    .map((l) => ({ de: l.direcao === 'entrante' ? 'cliente' : 'nos', texto: l.texto! } as const))
}

async function encerrarSessao(tx: Sql, sessaoId: string, motivo: string, agora: Date): Promise<void> {
  await tx`
    UPDATE agente_sessao
       SET estado = 'entregue', motivo_saida = ${motivo.slice(0, 200)}, encerrada_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId} AND estado = 'ativa'`
}

/** O que foi aceito, sem a lista de recusas (que vai em coluna própria). */
function semDescartados(e: ReturnType<typeof validarExtracao>) {
  const { descartados: _, ...aceito } = e
  return aceito
}
