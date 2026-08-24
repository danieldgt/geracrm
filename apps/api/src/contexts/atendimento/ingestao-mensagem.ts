import { randomUUID } from 'node:crypto'
import { normalizarTelefone } from '@geracrm/shared'
import type { MensagemEntrante } from './canais/porta.js'
import { confirmarPedidoPorResposta } from '../pedido/confirmacao-pedido.js'
import { consumirCodigoOrigem } from '../aquisicao/consumo-codigo.js'
import { emSavepoint, type Sql } from '../../db/index.js'
import { notificarMensagemEntrante } from './notificacao.js'

/**
 * Ingestão de mensagem ENTRANTE — o nosso fluxo (INV-12), não o do ERP.
 *
 * ⚠️ Contato-lead + conversa + mensagem nascem na MESMA transação. Se algo
 * falhar, o rollback não deixa lead fantasma nem conversa órfã — o Inbox nunca
 * mostra uma conversa sem mensagem nem um contato que não existe.
 *
 * ⚠️ Idempotente por id externo da mensagem (INV-38): o PlugZapi reenvia o
 * webhook, e a mesma mensagem não pode aparecer duas vezes na thread.
 */

/** Mídia de ENTRADA que ainda aponta para a URL do provedor (a copiar). */
export interface MidiaExterna {
  readonly mensagemId: string
  readonly mensagemCriadoEm: Date
  readonly tipo: 'imagem' | 'audio'
  readonly url: string
  readonly mime: string | null
}

export type ResultadoIngestaoMensagem =
  | {
      ok: true; conversaId: string; contatoId: string; duplicada: boolean; leadNovo: boolean
      /** Presente só quando é mídia nova apontando para URL externa (E5-14). */
      midiaExterna?: MidiaExterna
    }
  | { ok: false; motivo: string }

/** Ordem numérica dos tiques — para não REGREDIR com webhook fora de ordem. */
const ORDEM_STATUS: Record<string, number> = { enviada: 1, entregue: 2, lida: 3 }

/**
 * Atualiza o status (os dois tiques) de uma mensagem NOSSA pelo id externo.
 *
 * ⚠️ Só avança: os webhooks de status chegam FORA DE ORDEM (lido pode vir antes
 * de entregue). Sem o `status_ordem <` a mensagem regride de lida para entregue
 * na tela. Gera evento de tempo real para o tique atualizar sozinho.
 */
export async function registrarStatusMensagem(
  tx: Sql,
  idExterno: string,
  status: 'enviada' | 'entregue' | 'lida',
): Promise<{ atualizada: boolean }> {
  const ordem = ORDEM_STATUS[status] ?? 0
  const [m] = await tx<{ conversa_id: string }[]>`
    UPDATE mensagem SET status = ${status}, status_ordem = ${ordem}
     WHERE tenant_id = tenant_atual() AND id_externo = ${idExterno} AND direcao = 'saliente'
       AND (status_ordem IS NULL OR status_ordem < ${ordem})
     RETURNING conversa_id
  `
  if (!m) return { atualizada: false }

  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET versao = versao + 1
     WHERE tenant_id = tenant_atual() AND id = ${m.conversa_id} RETURNING versao`
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'mensagem.status', 'conversa', ${m.conversa_id},
            ${JSON.stringify({ conversaId: m.conversa_id, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
  return { atualizada: true }
}

/** Monta o `conteudo` (jsonb) da mensagem entrante conforme o tipo. */
function conteudoEntrante(msg: MensagemEntrante): Record<string, unknown> {
  if (msg.tipo === 'imagem') {
    return { imagem: msg.midiaUrl ?? '', ...(msg.mime ? { mime: msg.mime } : {}), ...(msg.texto ? { legenda: msg.texto } : {}) }
  }
  if (msg.tipo === 'audio') {
    return { audio: msg.midiaUrl ?? '', ...(msg.mime ? { mime: msg.mime } : {}) }
  }
  return { texto: msg.texto ?? '' }
}

export async function ingerirMensagemEntrante(
  tx: Sql,
  canalId: string,
  msg: MensagemEntrante,
): Promise<ResultadoIngestaoMensagem> {
  const tel = normalizarTelefone(msg.deE164)
  if (!tel) return { ok: false, motivo: 'telefone inválido' }

  // 1. Dedup ANTES de tudo: reentrega não recria nada.
  const [jaExiste] = await tx<{ mensagem_id: string; conversa_id: string }[]>`
    SELECT mie.mensagem_id, m.conversa_id
      FROM mensagem_id_externo mie
      JOIN mensagem m ON m.tenant_id = mie.tenant_id
                     AND m.criado_em = mie.mensagem_criado_em AND m.id = mie.mensagem_id
     WHERE mie.tenant_id = tenant_atual() AND mie.id_externo = ${msg.idExterno}
  `
  if (jaExiste) {
    const [c] = await tx<{ contato_id: string }[]>`
      SELECT contato_id FROM conversa WHERE id = ${jaExiste.conversa_id}`
    return { ok: true, conversaId: jaExiste.conversa_id, contatoId: c?.contato_id ?? '', duplicada: true, leadNovo: false }
  }

  // 2. Resolve o contato pelo telefone (chave de bloqueio: 55+DDD+8 dígitos).
  //    ⚠️ Aqui NÃO aplicamos o limiar de documento (é WhatsApp, sem CNPJ): o
  //    telefone é a identidade. Mas só vincula se for principal — número
  //    secundário pode ser outra pessoa na mesma linha.
  const [achado] = await tx<{ contato_id: string }[]>`
    SELECT contato_id FROM contato_telefone
     WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio} AND principal
     LIMIT 1
  `

  let contatoId: string
  let leadNovo = false
  if (achado) {
    contatoId = achado.contato_id
  } else {
    // Lead novo: o WhatsApp trouxe alguém que o ERP não tem. Nasce como contato.
    contatoId = randomUUID()
    leadNovo = true
    await tx`
      INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
      VALUES (tenant_atual(), ${contatoId}, ${msg.nomeRemetente ?? msg.deE164}, 'whatsapp', true)
    `
    await tx`
      INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
      VALUES (tenant_atual(), ${contatoId}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, true, 'whatsapp')
      ON CONFLICT DO NOTHING
    `
  }

  // 3. Conversa (canal, contato) — uma só (chave natural). Cria se não houver.
  const [convExistente] = await tx<{ id: string }[]>`
    SELECT id FROM conversa WHERE tenant_id = tenant_atual() AND canal_id = ${canalId} AND contato_id = ${contatoId}
  `
  let conversaId: string
  if (convExistente) {
    conversaId = convExistente.id
  } else {
    conversaId = randomUUID()
    await tx`
      INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_mensagem_em, ultima_entrante_em, ultima_direcao, versao)
      VALUES (tenant_atual(), ${conversaId}, ${canalId}, ${contatoId}, ${msg.recebidaEm}, ${msg.recebidaEm}, 'entrante', 1)
    `
  }

  // 4. A mensagem + a guardiã do dedup, no mesmo commit.
  const mensagemId = randomUUID()
  await tx`
    INSERT INTO mensagem (tenant_id, id, conversa_id, id_externo, direcao, tipo, conteudo, criado_em)
    VALUES (tenant_atual(), ${mensagemId}, ${conversaId}, ${msg.idExterno}, 'entrante', ${msg.tipo},
            ${JSON.stringify(conteudoEntrante(msg))}::text::jsonb, ${msg.recebidaEm})
  `
  await tx`
    INSERT INTO mensagem_id_externo (tenant_id, id_externo, mensagem_id, mensagem_criado_em)
    VALUES (tenant_atual(), ${msg.idExterno}, ${mensagemId}, ${msg.recebidaEm})
  `

  // 5. Atualiza a conversa: é o que ordena o Inbox e vira o estado da janela.
  const [conv] = await tx<{ versao: string }[]>`
    UPDATE conversa SET
      ultima_mensagem_em = ${msg.recebidaEm},
      ultima_entrante_em = ${msg.recebidaEm},
      ultima_direcao = 'entrante',
      versao = versao + 1
     WHERE tenant_id = tenant_atual() AND id = ${conversaId}
     RETURNING versao
  `
  const versao = Number(conv?.versao ?? 0)

  // 6. ⚠️ Evento no OUTBOX, no MESMO commit do dado (INV-40). Se a transação
  //    reverter, o evento some junto — nunca avisamos de mensagem que não existe.
  //    A TRIGGER do outbox (0026) dispara o NOTIFY no commit; payload só com ids.
  await tx`
    INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
    VALUES (tenant_atual(), 'mensagem.recebida', 'conversa', ${conversaId},
            ${JSON.stringify({ conversaId, canalId, versao })}::text::jsonb)
  `

  // 6.5 ⚠️ Cliente respondeu SIM ao resumo? Confirma o pedido pendente da conversa
  //     (vinculado ao cliente), no MESMO commit. Conservador: só resposta curta e
  //     claramente afirmativa. Falha aqui não derruba a ingestão da mensagem.
  //
  //     ⚠️ E os dois passos acessórios abaixo correm em SAVEPOINT, não só em
  //     try/catch: no Postgres um comando que falha aborta a transação INTEIRA,
  //     então o `catch` engoliria o erro e o COMMIT falharia depois — perdendo a
  //     MENSAGEM DO CLIENTE por causa de um passo secundário. Com o savepoint, o
  //     rollback é só do trecho.
  if (msg.texto) {
    const texto = msg.texto
    try {
      await emSavepoint(tx, (sp) => confirmarPedidoPorResposta(sp, conversaId, texto, msg.recebidaEm))
    } catch { /* não bloqueia a mensagem */ }

    // 6.6 ⚠️ Veio da landing page? A primeira mensagem carrega o código de origem
    //     (AQ-45) e é ele que liga esta conversa ao anúncio que a pagou. Mesmo
    //     commit da mensagem: origem sem conversa seria lead fantasma no relatório.
    try {
      await emSavepoint(tx, (sp) => consumirCodigoOrigem(sp, contatoId, texto))
    } catch { /* atribuição é acessório; a mensagem não pode se perder por ela */ }
  }

  // 7. Notifica o atendente que assumiu esta conversa (PLT-07), no mesmo commit.
  //    Só entrante NOVA chega aqui — a duplicada já retornou lá em cima.
  await notificarMensagemEntrante(tx, { conversaId })

  // 8. Mídia externa a copiar (E5-14): imagem/áudio que ainda aponta para a URL
  //    do provedor. A cópia é PÓS-COMMIT (fetch é rede, não pode segurar a tx).
  const midiaExterna: MidiaExterna | undefined =
    (msg.tipo === 'imagem' || msg.tipo === 'audio') && msg.midiaUrl && /^https?:\/\//i.test(msg.midiaUrl)
      ? { mensagemId, mensagemCriadoEm: msg.recebidaEm, tipo: msg.tipo, url: msg.midiaUrl, mime: msg.mime ?? null }
      : undefined

  return { ok: true, conversaId, contatoId, duplicada: false, leadNovo, ...(midiaExterna ? { midiaExterna } : {}) }
}
