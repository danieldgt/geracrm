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

export type ResultadoEnvioTexto =
  | { ok: true }
  | { ok: false; motivo: string }
  | { ok: false; motivo: 'conversa_nao_encontrada' }

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
  if (!preparo) return { ok: false, motivo: 'conversa_nao_encontrada' }

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

  return r.ok ? { ok: true } : { ok: false, motivo: r.motivo }
}
