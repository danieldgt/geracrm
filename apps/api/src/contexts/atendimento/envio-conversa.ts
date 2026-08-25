import { randomUUID } from 'node:crypto'
import { comTenantServico, type Sql } from '../../db/index.js'
import { decifrar } from '../integracao/cofre.js'
import { criarCanal } from './canais/fabrica.js'
import { enviarPeloGateway, type ContextoEnvio } from './canais/gateway.js'

/**
 * Envio de TEXTO numa conversa, reusando o GATEWAY ÚNICO (opt-out, janela de 24h,
 * estado do canal) — mesma defesa da rota de mensagens. Existe para que quem
 * precisa mandar texto de forma programática (ex.: resumo do pedido) NÃO fale com
 * o adaptador direto nem replique os guardrails. Roda como serviço (dono +
 * tenant explícito via comTenantServico).
 *
 * ⚠️ O cabeçalho com o nome do atendente é decoração de TRANSPORTE: entra no
 * despacho, não no histórico gravado.
 */
interface Preparo {
  mensagemId: string; destino: string; provedor: string | null; cred: Uint8Array | null
  tipoCanal: string; estadoCanal: string; ultimaEntranteEm: Date | null; destinoBloqueado: boolean
  disparoPausado: boolean
}

function comCabecalho(nome: string | null, texto: string): string {
  return nome ? `*${nome}*\n${texto}` : texto
}

/**
 * ⚠️ A CLASSE importa para quem chama em lote. Recusa NOSSA (opt-out, janela
 * fechada, disparo pausado) é decisão de política e não deve ser retentada;
 * falha de TRANSPORTE é o provedor tendo um mau dia e pode ser tentada de novo.
 * Colapsar as duas em "falhou" faria a campanha reenviar para quem pediu para
 * não receber.
 */
export type ClasseFalha = 'recusa' | 'transporte' | 'alvo'

export type ResultadoEnvioTexto =
  | { ok: true; conversaId: string; mensagemId: string }
  | { ok: false; classe: ClasseFalha; motivo: string; conversaId?: string; mensagemId?: string }

export async function enviarTextoNaConversa(
  tenantId: string,
  conversaId: string,
  texto: string,
  remetenteNome: string | null,
  agora: Date = new Date(),
): Promise<ResultadoEnvioTexto> {
  // Fase 1: persiste 'pendente' + evento, no mesmo commit, com o contexto que o
  // gateway revalida.
  const preparo = await comTenantServico(tenantId, async (tx: Sql) => {
    const [ctx] = await tx<Preparo[]>`
      SELECT cc.provedor, cc.credenciais_cifradas AS cred, cc.tipo AS "tipoCanal", cc.estado AS "estadoCanal",
             ct.e164 AS destino, c.ultima_entrante_em AS "ultimaEntranteEm",
             coalesce(cfg.disparo_pausado, false) AS "disparoPausado",
             EXISTS (SELECT 1 FROM lista_bloqueio lb
                      WHERE lb.tenant_id = c.tenant_id AND lb.chave_bloqueio = ct.chave_bloqueio) AS "destinoBloqueado"
        FROM conversa c
        JOIN contato_telefone ct ON ct.tenant_id = c.tenant_id AND ct.contato_id = c.contato_id AND ct.principal
        JOIN canal_conectado cc  ON cc.tenant_id = c.tenant_id AND cc.id = c.canal_id
        LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
       WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}`
    if (!ctx) return null
    const mensagemId = randomUUID()
    await tx`
      INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem)
      VALUES (tenant_atual(), ${mensagemId}, ${conversaId}, 'saliente', 'texto',
              ${JSON.stringify({ texto })}::text::jsonb, 'pendente', 0)`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET ultima_mensagem_em = now(), ultima_direcao = 'saliente', versao = versao + 1
       WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.enviada', 'conversa', ${conversaId},
              ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
    return { ...ctx, mensagemId }
  })
  if (!preparo) return { ok: false, classe: 'alvo', motivo: 'conversa_nao_encontrada' }

  // Fase 2: gateway único revalida e só então despacha.
  const ctxEnvio: ContextoEnvio = {
    tipoCanal: preparo.tipoCanal, estadoCanal: preparo.estadoCanal, provedor: preparo.provedor,
    temCredencial: !!preparo.cred, destinoBloqueado: preparo.destinoBloqueado,
    ehTemplate: false, ultimaEntranteEm: preparo.ultimaEntranteEm,
    // ⚠️ Este módulo é o caminho PROGRAMÁTICO (resumo de pedido, automação,
    //    campanha quando existir) — por isso `ehDisparo`. Resposta digitada por
    //    uma pessoa entra por `rotas-mensagens`, que marca false.
    ehDisparo: true, disparoPausado: preparo.disparoPausado,
  }
  const r = await enviarPeloGateway(ctxEnvio, agora, async () => {
    const canal = criarCanal(preparo.provedor!, decifrar(Buffer.from(preparo.cred!)))
    return canal.enviarTexto(preparo.destino, comCabecalho(remetenteNome, texto))
  })

  // Fase 3: status final + evento.
  await comTenantServico(tenantId, async (tx: Sql) => {
    await tx`UPDATE mensagem SET status = ${r.ok ? 'enviada' : 'falhou'}, status_ordem = 1,
                    id_externo = ${r.ok ? r.idExterno : null}
              WHERE tenant_id = tenant_atual() AND id = ${preparo.mensagemId}`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET versao = versao + 1 WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.status', 'conversa', ${conversaId},
              ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
  })

  return r.ok
    ? { ok: true, conversaId, mensagemId: preparo.mensagemId }
    : { ok: false, classe: r.classe, motivo: r.motivo, conversaId, mensagemId: preparo.mensagemId }
}

/**
 * Envio PROATIVO para um contato num canal — o caminho da CAMPANHA.
 *
 * ⚠️ Diferente de `enviarTextoNaConversa` num ponto que não é detalhe: aqui pode
 * NÃO HAVER conversa ainda. A campanha é iniciada por nós, para uma audiência
 * escolhida, então abrir a conversa é legítimo — e é o oposto do caso da
 * automação, que fala com quem já estava conversando e por isso NÃO abre.
 *
 * ⚠️ A conversa nasce sem `ultima_entrante_em`, e é isso que faz o gateway
 * recusar texto livre no canal OFICIAL (janela de 24h nunca aberta). Não é
 * efeito colateral: é a regra da Meta aparecendo onde tem de aparecer. No
 * não-oficial, texto livre passa (ADR-021) — com o risco que o produto já
 * declara na tela.
 */
export async function enviarTextoParaContato(
  tenantId: string,
  canalId: string,
  contatoId: string,
  texto: string,
  agora: Date = new Date(),
): Promise<ResultadoEnvioTexto> {
  const preparo = await comTenantServico(tenantId, async (tx: Sql) => {
    const [ctx] = await tx<(Preparo & { conversaId: string })[]>`
      SELECT cc.provedor, cc.credenciais_cifradas AS cred, cc.tipo AS "tipoCanal",
             cc.estado AS "estadoCanal", ct.e164 AS destino,
             coalesce(cfg.disparo_pausado, false) AS "disparoPausado",
             EXISTS (SELECT 1 FROM lista_bloqueio lb
                      WHERE lb.tenant_id = ct.tenant_id AND lb.chave_bloqueio = ct.chave_bloqueio) AS "destinoBloqueado",
             conv.id AS "conversaId", conv.ultima_entrante_em AS "ultimaEntranteEm"
        FROM canal_conectado cc
        JOIN contato_telefone ct ON ct.tenant_id = cc.tenant_id AND ct.contato_id = ${contatoId} AND ct.principal
        LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
        LEFT JOIN conversa conv ON conv.tenant_id = cc.tenant_id
                               AND conv.canal_id = cc.id AND conv.contato_id = ${contatoId}
       WHERE cc.tenant_id = tenant_atual() AND cc.id = ${canalId}`
    // ⚠️ Sem telefone principal não há para onde mandar — e isso é resultado
    //    esperado numa audiência de RFV (contato de ERP pode não ter WhatsApp).
    if (!ctx) return null

    let conversaId = ctx.conversaId
    if (!conversaId) {
      conversaId = randomUUID()
      await tx`
        INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_mensagem_em, ultima_direcao, versao)
        VALUES (tenant_atual(), ${conversaId}, ${canalId}, ${contatoId}, now(), 'saliente', 1)`
    }

    const mensagemId = randomUUID()
    await tx`
      INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem)
      VALUES (tenant_atual(), ${mensagemId}, ${conversaId}, 'saliente', 'texto',
              ${JSON.stringify({ texto })}::text::jsonb, 'pendente', 0)`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET ultima_mensagem_em = now(), ultima_direcao = 'saliente', versao = versao + 1
       WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.enviada', 'conversa', ${conversaId},
              ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
    return { ...ctx, conversaId, mensagemId }
  })
  if (!preparo) return { ok: false, classe: 'alvo', motivo: 'sem_telefone_ou_canal' }

  const ctxEnvio: ContextoEnvio = {
    tipoCanal: preparo.tipoCanal, estadoCanal: preparo.estadoCanal, provedor: preparo.provedor,
    temCredencial: !!preparo.cred, destinoBloqueado: preparo.destinoBloqueado,
    ehTemplate: false, ultimaEntranteEm: preparo.ultimaEntranteEm,
    ehDisparo: true, disparoPausado: preparo.disparoPausado,
  }
  const r = await enviarPeloGateway(ctxEnvio, agora, async () => {
    const canal = criarCanal(preparo.provedor!, decifrar(Buffer.from(preparo.cred!)))
    // ⚠️ Campanha NÃO leva cabeçalho de atendente: ela é da empresa, e assinar
    //    com o nome de alguém que não escreveu seria mentir na assinatura.
    return canal.enviarTexto(preparo.destino, texto)
  })

  await comTenantServico(tenantId, async (tx: Sql) => {
    await tx`UPDATE mensagem SET status = ${r.ok ? 'enviada' : 'falhou'}, status_ordem = 1,
                    id_externo = ${r.ok ? r.idExterno : null}
              WHERE tenant_id = tenant_atual() AND id = ${preparo.mensagemId}`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET versao = versao + 1
       WHERE tenant_id = tenant_atual() AND id = ${preparo.conversaId} RETURNING versao`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.status', 'conversa', ${preparo.conversaId},
              ${JSON.stringify({ conversaId: preparo.conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
  })

  return r.ok
    ? { ok: true, conversaId: preparo.conversaId, mensagemId: preparo.mensagemId }
    : { ok: false, classe: r.classe, motivo: r.motivo, conversaId: preparo.conversaId, mensagemId: preparo.mensagemId }
}
