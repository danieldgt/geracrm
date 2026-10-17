import { randomUUID } from 'node:crypto'
import { contarVariaveis, primeiroNome, templateDeRetornoCompativel } from '@geracrm/shared'
import { comTenantServico, emSavepoint, type Sql } from '../../db/index.js'
import { marcarPrimeiraRespostaHumana } from './primeira-resposta.js'
import { decifrar } from '../integracao/cofre.js'
import { criarCanal } from './canais/fabrica.js'
import { enviarPeloGateway, type ContextoEnvio } from './canais/gateway.js'
import type { ResultadoEnvioTexto } from './envio-conversa.js'
import { registrarAvisoSeExibido } from './agente/privacidade.js'

/**
 * Envio de TEMPLATE (HSM) numa conversa — o irmão de `enviarTextoNaConversa`
 * para o canal OFICIAL fora da janela de 24h (raia P11: retorno do agente).
 *
 * ⚠️ A APROVAÇÃO é relida aqui, na mesma transação que grava a mensagem
 *    pendente: só a versão `APPROVED` do template sai (índice parcial de 0011b
 *    garante no máximo uma). Status pausado/desativado pela Meta entre a
 *    decisão e o envio vira recusa NOSSA (`template_indisponivel`), nunca uma
 *    chamada que a Meta recusaria.
 * ⚠️ Variáveis: só o {{1}} = primeiro nome do contato é preenchível de forma
 *    automática e segura. Template com mais variáveis é `template_incompativel`
 *    — inventar o valor de um {{2}} seria o modelo inventando número de novo.
 * ⚠️ O histórico grava o corpo RENDERIZADO (o que o cliente leu) + nome e
 *    versão do template — é o que responde "o que exatamente ele recebeu?".
 */
export interface OpcoesEnvioTemplate {
  readonly ehDisparo?: boolean
  readonly marcador?: string
  /**
   * Quem está exibindo o aviso de privacidade, se o template o contiver (P4/P13). EXPLÍCITO, não
   * deduzido do marcador. Padrão 'agente': hoje o único chamador é o retorno do agente (P11);
   * um envio de template por pessoa passa 'humano'.
   */
  readonly origemAviso?: 'agente' | 'humano'
  /** Quem enviou, quando é uma pessoa: autor da mensagem (`enviada_por_id`) e 1ª resposta humana. */
  readonly enviadaPorId?: string | null | undefined
}

interface Preparo {
  mensagemId: string; destino: string; provedor: string | null; cred: Uint8Array | null
  tipoCanal: string; estadoCanal: string; ultimaEntranteEm: Date | null; destinoBloqueado: boolean
  disparoPausado: boolean; canalArquivado: boolean; nome: string; idioma: string; variaveis: string[]
  contatoId: string; canalId: string; renderizado: string
}

type Falha = { ok: false; classe: 'recusa' | 'alvo'; motivo: string }

export async function enviarTemplateNaConversa(
  tenantId: string,
  conversaId: string,
  templateId: string,
  agora: Date = new Date(),
  opcoes: OpcoesEnvioTemplate = {},
  deps: { criar?: typeof criarCanal | undefined } = {},
): Promise<ResultadoEnvioTexto> {
  const preparo = await comTenantServico(tenantId, async (tx: Sql): Promise<Preparo | Falha> => {
    const [ctx] = await tx<(Omit<Preparo, 'mensagemId' | 'nome' | 'idioma' | 'variaveis' | 'renderizado'> & { contato: string | null })[]>`
      SELECT c.contato_id AS "contatoId", c.canal_id AS "canalId", cc.provedor, cc.credenciais_cifradas AS cred, cc.tipo AS "tipoCanal", cc.estado AS "estadoCanal",
             (cc.arquivado_em IS NOT NULL) AS "canalArquivado",
             ct.e164 AS destino, c.ultima_entrante_em AS "ultimaEntranteEm", co.nome AS contato,
             coalesce(cfg.disparo_pausado, false) AS "disparoPausado",
             EXISTS (SELECT 1 FROM lista_bloqueio lb
                      WHERE lb.tenant_id = c.tenant_id AND lb.chave_bloqueio = ct.chave_bloqueio) AS "destinoBloqueado"
        FROM conversa c
        JOIN contato co          ON co.tenant_id = c.tenant_id AND co.id = c.contato_id
        JOIN contato_telefone ct ON ct.tenant_id = c.tenant_id AND ct.contato_id = c.contato_id AND ct.principal
        JOIN canal_conectado cc  ON cc.tenant_id = c.tenant_id AND cc.id = c.canal_id
        LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
       WHERE c.tenant_id = tenant_atual() AND c.id = ${conversaId}`
    if (!ctx) return { ok: false, classe: 'alvo', motivo: 'conversa_nao_encontrada' }

    const [tpl] = await tx<{ nome: string; idioma: string; versao: number; corpo: { body?: { texto?: string } } }[]>`
      SELECT t.nome, t.idioma, tv.versao, tv.corpo
        FROM template t
        JOIN template_versao tv ON tv.tenant_id = t.tenant_id AND tv.template_id = t.id AND tv.status_meta = 'APPROVED'
       WHERE t.tenant_id = tenant_atual() AND t.id = ${templateId}`
    if (!tpl) return { ok: false, classe: 'recusa', motivo: 'template_indisponivel' }
    const corpo = tpl.corpo?.body?.texto ?? ''
    if (!templateDeRetornoCompativel(corpo)) return { ok: false, classe: 'recusa', motivo: 'template_incompativel' }
    const variaveis = contarVariaveis(corpo) === 1 ? [primeiroNome(ctx.contato)] : []
    const renderizado = variaveis.length ? corpo.replace(/\{\{\s*1\s*\}\}/g, variaveis[0]!) : corpo

    const mensagemId = randomUUID()
    await tx`
      INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem, enviada_por_id)
      VALUES (tenant_atual(), ${mensagemId}, ${conversaId}, 'saliente', 'texto',
              ${JSON.stringify({
                texto: renderizado,
                template: { id: templateId, nome: tpl.nome, idioma: tpl.idioma, versao: tpl.versao },
                ...(opcoes.marcador ? { automatica: opcoes.marcador } : {}),
              })}::text::jsonb,
              'pendente', 0, ${opcoes.enviadaPorId ?? null})`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET ultima_mensagem_em = now(), ultima_direcao = 'saliente', versao = versao + 1
       WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.enviada', 'conversa', ${conversaId},
              ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
    const { contato: _contato, ...resto } = ctx
    return { ...resto, mensagemId, nome: tpl.nome, idioma: tpl.idioma, variaveis, renderizado }
  })
  if ('ok' in preparo) return preparo

  const ctxEnvio: ContextoEnvio = {
    tipoCanal: preparo.tipoCanal, estadoCanal: preparo.estadoCanal, provedor: preparo.provedor,
    canalArquivado: preparo.canalArquivado,
    temCredencial: !!preparo.cred, destinoBloqueado: preparo.destinoBloqueado,
    // ⚠️ Template APROVADO (relido acima): é o que reabre a janela no oficial.
    ehTemplate: true, ultimaEntranteEm: preparo.ultimaEntranteEm,
    ehDisparo: opcoes.ehDisparo ?? true, disparoPausado: preparo.disparoPausado,
  }
  const r = await enviarPeloGateway(ctxEnvio, agora, async () => {
    const canal = (deps.criar ?? criarCanal)(preparo.provedor!, decifrar(Buffer.from(preparo.cred!)))
    // Canal sem template (não-oficial): degrada com motivo, não finge envio.
    if (!canal.enviarTemplate) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'canal não envia template' }
    return canal.enviarTemplate(preparo.destino, { nome: preparo.nome, idioma: preparo.idioma, variaveis: preparo.variaveis })
  })

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
    // P13/P4: template com o aviso de privacidade também é prova de exibição — só com envio ok.
    // ⚠️ Em savepoint + try/catch: falha do registro (acessório) não pode desfazer o STATUS do
    //    envio (principal) — a mensagem já saiu, e a tela precisa saber.
    if (r.ok && opcoes.enviadaPorId) await marcarPrimeiraRespostaHumana(tx, { conversaId, mensagemId: preparo.mensagemId })
    if (r.ok) {
      try {
        await emSavepoint(tx, (sp) => registrarAvisoSeExibido(sp, {
          envio: { ok: true, mensagemId: preparo.mensagemId }, contatoId: preparo.contatoId, conversaId, canalId: preparo.canalId,
          texto: preparo.renderizado, origem: opcoes.origemAviso ?? 'agente', agora,
        }))
      } catch (erro) {
        console.warn(JSON.stringify({ nivel: 'warn', contexto: 'envio-template', evento: 'aviso_privacidade_falhou', conversaId, erro: String(erro).slice(0, 200) }))
      }
    }
  })

  return r.ok
    ? { ok: true, conversaId, mensagemId: preparo.mensagemId }
    : { ok: false, classe: r.classe, motivo: r.motivo, conversaId, mensagemId: preparo.mensagemId }
}
