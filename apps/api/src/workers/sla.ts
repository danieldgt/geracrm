import { randomUUID } from 'node:crypto'
import {
  COMPLEMENTO_AVISO_FORA, TEXTO_AVISO_ESPERA, TEXTO_AVISO_ESPERA_FORA, ajustarMensagemHandoff, calcularJanela,
  complianceEfetivo, falaDoProximoHorario, filtrarSaida, lerComplianceExtra, lerPlaybookVigente, mensagemProntaSegura, permiteTextoLivre,
  personaDoPlaybook, verificarNumerosNaResposta,
  type ResultadoAvisoEspera,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../db/index.js'
import { enviarTextoNaConversa } from '../contexts/atendimento/envio-conversa.js'
import { situacaoDoExpediente } from '../contexts/atendimento/expediente.js'
import { destinatariosDaFilaDoNumero, notificarPessoasDaConversa } from '../contexts/atendimento/notificacao.js'
import { gestoresDoTenant, lerContextoSla, respostaHumanaDoAtendimento } from '../contexts/atendimento/sla-handoff.js'

/**
 * WORKER DO SLA DO HANDOFF (raia P18, ADR-034) — agendado pela P0 em
 * `server.ts` (a cada 30 s, com batimento).
 *
 * Cada passada, como DONO para achar trabalho e sob o TENANT para gravar, para
 * cada atendimento com SLA armado (`handoff.ts`) e ainda sem resposta humana:
 *
 *   0. alguém da equipe RESPONDEU (mensagem com autor) → `sla_respondido_em`;
 *      o relógio pára e nada mais acontece;
 *   1. venceu o SLA → `sla_estourado_em`, notifica os GESTORES (sem gestor
 *      declarado: o responsável e a fila do número), abre/atualiza o alerta
 *      `sla_handoff_estourado`;
 *   2. venceu o 2º limiar → `reatribuicao_liberada_em` e avisa o pool do número:
 *      qualquer um assume (inclusive de quem assumiu e não respondeu);
 *   3. chegou a hora da espera → UMA mensagem fixa ao cliente, sem prazo, pelo
 *      gateway, depois do filtro P2 e da rede de R$; só se ninguém respondeu e
 *      a conversa segue com humano; nunca com opt-out (lista ou marca P4
 *      `possivel_opt_out` no handoff), janela de 24 h fechada
 *      (oficial) ou `aviso_espera = false`. O que acontecer fica em
 *      `aviso_espera_resultado`.
 *
 * Idempotente: cada marco é um `UPDATE … WHERE <marco> IS NULL RETURNING`, sob
 * `FOR UPDATE SKIP LOCKED` na linha. A mensagem é RESERVADA ('pendente') no
 * mesmo commit da decisão e só então enviada: um processo que cai entre os dois
 * deixa 'pendente' — nunca manda duas.
 */
export const INTERVALO_SLA_MS = 30_000
const LOTE = 200

export interface RelatorioSla {
  readonly processadas: number
  readonly respondidos: number
  readonly estourados: number
  readonly liberados: number
  readonly avisos: Partial<Record<ResultadoAvisoEspera, number>>
}

/**
 * Dependências OPCIONAIS — `server.ts` passa `{}`. `somenteTenant` restringe a
 * passada (testes contra banco compartilhado); `enviar` troca o envio real.
 */
export interface DepsSla {
  readonly somenteTenant?: string | undefined
  readonly enviar?: typeof enviarTextoNaConversa | undefined
}

export async function processarSla(dono: Sql, deps: DepsSla = {}, agora: Date = new Date()): Promise<RelatorioSla> {
  const chave = `sla_handoff:${deps.somenteTenant ?? '*'}`
  const vazio: RelatorioSla = { processadas: 0, respondidos: 0, estourados: 0, liberados: 0, avisos: {} }
  // ⚠️ Trava de SESSÃO numa conexão RESERVADA: no pool, o unlock poderia sair
  //    por outra conexão, a trava vazaria e as passadas seguintes que caíssem
  //    na conexão presa voltariam vazias sem dizer por quê. Toda consulta de DONO
  //    da passada usa ESTA conexão (o `server.ts` dá ao worker um pool de 1).
  const conexao = await dono.reserve()
  let travou = false
  try {
    const [trava] = await conexao<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${chave})) AS ok`
    travou = trava?.ok === true
  } finally {
    if (!travou) conexao.release()
  }
  if (!travou) return vazio

  let respondidos = 0, estourados = 0, liberados = 0, processadas = 0
  const avisos: Partial<Record<ResultadoAvisoEspera, number>> = {}
  const contarAviso = (r: ResultadoAvisoEspera) => { avisos[r] = (avisos[r] ?? 0) + 1 }
  /** Mensagens já RESERVADAS ('pendente') sob a trava — enviadas depois de soltá-la. */
  const aEnviar: { tenantId: string; atendimentoId: string; conversaId: string; texto: string }[] = []
  try {
    // ⚠️ Pré-filtro pelo índice parcial `atendimento_sla_pendente`: só handoffs
    //    armados, abertos e sem resposta. A resposta humana é checada aqui
    //    também — sem isso o atendimento respondido antes do prazo ficaria
    //    "pendente" para sempre e a métrica nunca o contaria como cumprido.
    const candidatos = await conexao<{ tenant_id: string; id: string }[]>`
      SELECT a.tenant_id, a.id
        FROM atendimento a
       WHERE a.sla_vence_em IS NOT NULL AND a.sla_respondido_em IS NULL AND a.estado <> 'encerrado'
         AND ${deps.somenteTenant ? conexao`a.tenant_id = ${deps.somenteTenant}` : conexao`true`}
         AND (   (a.sla_estourado_em IS NULL AND a.sla_vence_em <= ${agora})
              OR (a.reatribuicao_liberada_em IS NULL AND a.reatribuicao_vence_em <= ${agora})
              OR (a.aviso_espera_em IS NULL AND a.aviso_espera_previsto_em <= ${agora})
              OR EXISTS (SELECT 1 FROM mensagem m
                          WHERE m.tenant_id = a.tenant_id AND m.conversa_id = a.conversa_id
                            AND m.direcao = 'saliente' AND m.enviada_por_id IS NOT NULL
                            AND m.criado_em >= a.sla_inicio_em))
       ORDER BY a.sla_vence_em
       LIMIT ${LOTE}`
    processadas = candidatos.length

    for (const c of candidatos) {
      const passo = await comTenantServico(c.tenant_id, (tx) => processarUm(tx, c.id, agora))
      if (!passo) continue
      if (passo.respondido) respondidos++
      if (passo.estourou) estourados++
      if (passo.liberou) liberados++
      if (passo.aviso && passo.aviso.tipo === 'registrado') contarAviso(passo.aviso.resultado)
      if (passo.aviso && passo.aviso.tipo === 'enviar') {
        aEnviar.push({ tenantId: c.tenant_id, atendimentoId: c.id, conversaId: passo.conversaId, texto: passo.aviso.texto })
      }
    }
    // Alerta aberto cujos estourados foram encerrados (ou respondidos) sem passar por aqui.
    const comAlerta = await conexao<{ tenant_id: string }[]>`
      SELECT tenant_id FROM alerta
       WHERE tipo = ${TIPO_ALERTA} AND resolvido_em IS NULL
         AND ${deps.somenteTenant ? conexao`tenant_id = ${deps.somenteTenant}` : conexao`true`}
       LIMIT ${LOTE}`
    for (const t of comAlerta) await comTenantServico(t.tenant_id, (tx) => resolverAlertaSeLimpo(tx))
  } finally {
    try { await conexao`SELECT pg_advisory_unlock(hashtext(${chave}))` } finally { conexao.release() }
  }

  // ── Envio: FORA da trava e sem conexão presa ─────────────────────────────
  // ⚠️ A conexão de dono do `server.ts` é UMA para ~13 workers: segurá-la
  //    durante a rede congelaria a fila do agente, o push e o resto. O
  //    'pendente' gravado sob a trava já garante o "no máximo uma vez"; o
  //    gateway revalida opt-out, janela e canal na hora.
  const enviar = deps.enviar ?? enviarTextoNaConversa
  for (const e of aEnviar) {
    let resultado: ResultadoAvisoEspera = 'falhou'
    try {
      const r = await enviar(e.tenantId, e.conversaId, e.texto, null, agora, { ehDisparo: false, marcador: 'sla_aviso_espera' })
      resultado = r.ok ? 'enviada' : r.motivo === 'bloqueado' ? 'opt_out' : r.motivo === 'janela_fechada' ? 'janela_fechada' : 'falhou'
    } catch {
      // Exceção de um envio vira 'falhou' e o lote segue — nunca derruba os outros.
      resultado = 'falhou'
    }
    try {
      await comTenantServico(e.tenantId, (tx) => tx`
        UPDATE atendimento SET aviso_espera_resultado = ${resultado}
         WHERE tenant_id = tenant_atual() AND id = ${e.atendimentoId} AND aviso_espera_resultado = 'pendente'`)
    } catch { /* fica 'pendente': nunca reenvia */ }
    contarAviso(resultado)
  }
  return { processadas, respondidos, estourados, liberados, avisos }
}

interface Passo {
  readonly conversaId: string
  readonly respondido: boolean
  readonly estourou: boolean
  readonly liberou: boolean
  readonly aviso: { tipo: 'registrado'; resultado: ResultadoAvisoEspera } | { tipo: 'enviar'; texto: string } | null
}

interface Linha {
  id: string; conversa_id: string; canal_id: string; responsavel_id: string | null; estado: string
  sla_vence_em: Date; reatribuicao_vence_em: Date | null; aviso_espera_previsto_em: Date | null
  sla_estourado_em: Date | null; reatribuicao_liberada_em: Date | null; aviso_espera_em: Date | null
  sla_respondido_em: Date | null; respondido_em: Date | null
  conduzida_por: string; ultima_entrante_em: Date | null; contato_nome: string | null
  bloqueado: boolean; agente: Record<string, unknown> | null
}

async function processarUm(tx: Sql, atendimentoId: string, agora: Date): Promise<Passo | null> {
  const [a] = await tx<Linha[]>`
    SELECT a.id, a.conversa_id, a.canal_id, a.responsavel_id, a.estado,
           a.sla_vence_em, a.reatribuicao_vence_em, a.aviso_espera_previsto_em,
           a.sla_estourado_em, a.reatribuicao_liberada_em, a.aviso_espera_em, a.sla_respondido_em,
           ${respostaHumanaDoAtendimento(tx)} AS respondido_em,
           c.conduzida_por, c.ultima_entrante_em, ct.nome AS contato_nome,
           EXISTS (SELECT 1 FROM contato_telefone tel
                     JOIN lista_bloqueio lb ON lb.tenant_id = tel.tenant_id AND lb.chave_bloqueio = tel.chave_bloqueio
                    WHERE tel.tenant_id = c.tenant_id AND tel.contato_id = c.contato_id AND tel.principal)
           -- P4: o handoff veio de um opt-out AMBÍGUO ("para de me mandar…"): a
           --    marca possivel_opt_out está na decisão do turno que transferiu.
           --    Cortesia não sai para quem talvez tenha pedido para parar.
           OR EXISTS (SELECT 1 FROM agente_decisao d
                       WHERE d.tenant_id = a.tenant_id AND d.conversa_id = a.conversa_id
                         AND d.criado_em >= a.sla_inicio_em - interval '10 minutes'
                         AND d.guardrails @> '[{"codigo":"possivel_opt_out"}]'::jsonb) AS bloqueado,
           -- ⚠️ Leitura TOLERANTE: o playbook (P17) e o compliance (P2) vêm de
           --    colunas que podem ainda não existir nesta versão do banco.
           (SELECT to_jsonb(ac.*) FROM agente_config ac
             WHERE ac.tenant_id = a.tenant_id AND ac.canal_id = a.canal_id) AS agente
      FROM atendimento a
      JOIN conversa c ON c.tenant_id = a.tenant_id AND c.id = a.conversa_id
      JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
     WHERE a.tenant_id = tenant_atual() AND a.id = ${atendimentoId}
     FOR UPDATE OF a SKIP LOCKED`
  if (!a || a.estado === 'encerrado' || a.sla_respondido_em) return null

  // 0. Respondido: o relógio pára.
  if (a.respondido_em) {
    await tx`UPDATE atendimento SET sla_respondido_em = ${a.respondido_em}
              WHERE tenant_id = tenant_atual() AND id = ${a.id} AND sla_respondido_em IS NULL`
    await emitirMudou(tx, a.conversa_id)
    await resolverAlertaSeLimpo(tx)
    return { conversaId: a.conversa_id, respondido: true, estourou: false, liberou: false, aviso: null }
  }

  let estourou = false, liberou = false
  const ctx = await lerContextoSla(tx, a.canal_id)

  // 1. SLA estourado.
  if (!a.sla_estourado_em && a.sla_vence_em.getTime() <= agora.getTime()) {
    const [m] = await tx<{ id: string }[]>`
      UPDATE atendimento SET sla_estourado_em = ${agora}
       WHERE tenant_id = tenant_atual() AND id = ${a.id} AND sla_estourado_em IS NULL RETURNING id`
    if (m) {
      estourou = true
      await evento(tx, a.id, 'sla_estourado', `SLA de ${ctx?.config.slaMinutos ?? '?'} min úteis sem resposta`)
      const gestores = (await gestoresDoTenant(tx)).map((g) => g.id)
      const alvos = gestores.length > 0 ? gestores
        : [...(a.responsavel_id ? [a.responsavel_id] : []), ...await destinatariosDaFilaDoNumero(tx, a.canal_id)]
      await notificarPessoasDaConversa(tx, alvos, 'sla.estourado', 'SLA do atendimento estourado: ninguém respondeu ainda', a.conversa_id)
      await abrirAlerta(tx)
    }
  }

  // 2. Reatribuição liberada.
  if (!a.reatribuicao_liberada_em && a.reatribuicao_vence_em && a.reatribuicao_vence_em.getTime() <= agora.getTime()) {
    const [m] = await tx<{ id: string }[]>`
      UPDATE atendimento SET reatribuicao_liberada_em = ${agora}
       WHERE tenant_id = tenant_atual() AND id = ${a.id} AND reatribuicao_liberada_em IS NULL RETURNING id`
    if (m) {
      liberou = true
      await evento(tx, a.id, 'reatribuicao_liberada', `${ctx?.config.reatribuicaoMinutos ?? '?'} min úteis sem resposta`)
      await notificarPessoasDaConversa(tx, await destinatariosDaFilaDoNumero(tx, a.canal_id), 'sla.reatribuicao',
        'atendimento liberado: qualquer pessoa do número pode assumir', a.conversa_id)
    }
  }

  // 3. Mensagem única de espera.
  let aviso: Passo['aviso'] = null
  if (!a.aviso_espera_em && a.aviso_espera_previsto_em && a.aviso_espera_previsto_em.getTime() <= agora.getTime()) {
    const fora = !!ctx && situacaoDoExpediente(ctx.horario, ctx.feriados, agora, ctx.fuso) !== 'aberto'
    const decisao = decidirAviso(a, ctx?.config.avisoEspera ?? true, ctx?.tipoCanal ?? '', fora, agora)
    const resultado: ResultadoAvisoEspera = decisao.tipo === 'enviar' ? 'pendente' : decisao.resultado
    const [m] = await tx<{ id: string }[]>`
      UPDATE atendimento SET aviso_espera_em = ${agora}, aviso_espera_resultado = ${resultado}
       WHERE tenant_id = tenant_atual() AND id = ${a.id} AND aviso_espera_em IS NULL RETURNING id`
    if (m) {
      aviso = decisao
      await evento(tx, a.id, 'aviso_espera', resultado)
    }
  }

  if (estourou || liberou || aviso) await emitirMudou(tx, a.conversa_id)
  return { conversaId: a.conversa_id, respondido: false, estourou, liberou, aviso }
}

/** A mensagem sai? E qual texto? Puro sobre a linha lida. */
function decidirAviso(
  a: Linha, ligado: boolean, tipoCanal: string, fora: boolean, agora: Date,
): { tipo: 'registrado'; resultado: ResultadoAvisoEspera } | { tipo: 'enviar'; texto: string } {
  if (!ligado) return { tipo: 'registrado', resultado: 'desligado' }
  if (a.conduzida_por !== 'humano') return { tipo: 'registrado', resultado: 'conversa_com_agente' }
  if (a.bloqueado) return { tipo: 'registrado', resultado: 'opt_out' }
  if (tipoCanal === 'whatsapp_oficial' && !permiteTextoLivre(calcularJanela(a.ultima_entrante_em, agora))) {
    return { tipo: 'registrado', resultado: 'janela_fechada' }
  }
  const texto = textoDaEspera(a.agente, a.contato_nome, fora)
  return texto ? { tipo: 'enviar', texto } : { tipo: 'registrado', resultado: 'texto_bloqueado' }
}

/**
 * O texto da espera: o do PLAYBOOK vigente do número (P17,
 * `agente_config.playbook.conteudo.mensagens.avisoEspera`) quando existir e
 * passar; senão o FIXO. Os dois passam pelo filtro P2 (com o compliance extra
 * do número), pela trava de prazo do handoff e pela rede de R$ — o que não
 * passa é descartado, nunca "consertado".
 */
export function textoDaEspera(agente: Record<string, unknown> | null, contatoNome: string | null, fora: boolean): string | null {
  // Os helpers da P17: espelho publicado lido de forma tolerante (inválido = sem
  // playbook), compliance do número ∪ do playbook (só acrescenta) e a mensagem
  // pronta revalidada contra o filtro de HOJE.
  const playbook = lerPlaybookVigente(agente?.['playbook'])?.conteudo ?? null
  const extras = complianceEfetivo(lerComplianceExtra(agente?.['compliance']), playbook).frasesProibidas
  const persona = (playbook ? personaDoPlaybook(playbook) : agente?.['persona'] ?? null) as { nome?: unknown; loja?: unknown } | null
  const candidatos: string[] = []
  let t = mensagemProntaSegura(playbook, 'avisoEspera', {
    nome: contatoNome, assistente: typeof persona?.nome === 'string' ? persona.nome : '',
    empresa: typeof persona?.loja === 'string' ? persona.loja : null,
  })
  if (t) {
    if (fora && !falaDoProximoHorario(t)) t = `${t} ${COMPLEMENTO_AVISO_FORA}`
    candidatos.push(t)
  }
  candidatos.push(fora ? TEXTO_AVISO_ESPERA_FORA : TEXTO_AVISO_ESPERA)
  for (const c of candidatos) {
    const f = filtrarSaida(c, { extras })
    if (f.esvaziado || f.ocorrencias.some((o) => o.acao !== 'registrado')) continue
    if (ajustarMensagemHandoff(c, { semNumeros: true, anexarRetomada: false }).ocorrencias.length > 0) continue
    if (verificarNumerosNaResposta(c, new Set()).length > 0) continue
    return c
  }
  return null
}

async function evento(tx: Sql, atendimentoId: string, tipo: string, motivo: string): Promise<void> {
  await tx`INSERT INTO atendimento_evento (tenant_id, id, atendimento_id, tipo, motivo)
           VALUES (tenant_atual(), ${randomUUID()}, ${atendimentoId}, ${tipo}, ${motivo})`
}

/** Evento sem conteúdo: a tela busca o cronômetro por API (ADR-007). */
async function emitirMudou(tx: Sql, conversaId: string): Promise<void> {
  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET versao = versao + 1 WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'atendimento.mudou', 'conversa', ${conversaId},
            ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
}

const TIPO_ALERTA = 'sla_handoff_estourado'

/** Um alerta ABERTO por tenant (índice `alerta_aberto_unico`), com a contagem atual. */
async function abrirAlerta(tx: Sql): Promise<void> {
  const [n] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM atendimento
     WHERE tenant_id = tenant_atual() AND sla_estourado_em IS NOT NULL AND sla_respondido_em IS NULL AND estado <> 'encerrado'`
  const qtd = n?.n ?? 1
  const mensagem = `${qtd} ${qtd === 1 ? 'cliente transferido pelo agente está' : 'clientes transferidos pelo agente estão'} `
    + 'esperando além do SLA sem resposta de ninguém. Abra a fila do atendimento.'
  const [novo] = await tx<{ novo: boolean }[]>`
    INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
    VALUES (tenant_atual(), ${randomUUID()}, ${TIPO_ALERTA}, 'aviso', ${mensagem})
    ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO UPDATE SET mensagem = EXCLUDED.mensagem
    RETURNING (xmax = 0) AS novo`
  if (novo?.novo) {
    await tx`INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
             VALUES (tenant_atual(), 'alerta.novo', 'tenant', tenant_atual(), '{}'::jsonb)`
  }
}

/** Fecha o alerta quando não sobra nenhum estourado esperando. */
async function resolverAlertaSeLimpo(tx: Sql): Promise<void> {
  await tx`
    UPDATE alerta SET resolvido_em = now()
     WHERE tenant_id = tenant_atual() AND tipo = ${TIPO_ALERTA} AND resolvido_em IS NULL
       AND NOT EXISTS (SELECT 1 FROM atendimento
                        WHERE tenant_id = tenant_atual() AND sla_estourado_em IS NOT NULL
                          AND sla_respondido_em IS NULL AND estado <> 'encerrado')`
}
