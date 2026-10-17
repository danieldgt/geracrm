import { randomUUID } from 'node:crypto'
import { contemAvisoPrivacidade } from '@geracrm/shared'
import type { Sql } from '../../../db/index.js'

/**
 * AVISO DE PRIVACIDADE — configuração do tenant e PROVA de exibição (raia P4, 0098).
 *
 * Quem exibe o aviso: a ABERTURA do agente (gatilhos de entrada, autônomo) e,
 * pela raia P13, o envio do vendedor no inbox. Os dois registram por aqui.
 *
 * ⚠️ O registro é PROVA de que o contato viu o aviso. Por isso
 *    `registrarAvisoSeExibido` exige o RESULTADO DO ENVIO e não grava nada se o
 *    envio não deu certo (opt-out, janela fechada, canal caído…). Registrar
 *    antes de enviar, ou sem conferir, é fabricar a prova.
 */

export interface PrivacidadeDoTenant {
  readonly url: string | null
  readonly versao: string
  readonly textoPadrao: string | null
  /** false = o tenant nunca configurou; vale o texto padrão do código. */
  readonly configurada: boolean
}

export const VERSAO_PADRAO = 'padrao'

/** A configuração do tenant (sob tenant). Sem linha → padrão do código. */
export async function lerPrivacidade(tx: Sql): Promise<PrivacidadeDoTenant> {
  const [l] = await tx<{ url: string | null; versao: string; texto_padrao: string | null }[]>`
    SELECT url, versao, texto_padrao FROM tenant_privacidade WHERE tenant_id = tenant_atual()`
  return l
    ? { url: l.url, versao: l.versao, textoPadrao: l.texto_padrao, configurada: true }
    : { url: null, versao: VERSAO_PADRAO, textoPadrao: null, configurada: false }
}

/** O resultado do envio, como `enviarTextoNaConversa` devolve. */
export type EnvioParaAviso =
  | { readonly ok: true; readonly mensagemId: string }
  | { readonly ok: false; readonly mensagemId?: string | undefined }

export interface RegistrarAviso {
  readonly envio: EnvioParaAviso
  readonly contatoId: string
  readonly conversaId: string
  readonly canalId: string
  /** O texto EXATAMENTE como saiu. */
  readonly texto: string
  readonly origem: 'agente' | 'humano'
  readonly agora: Date
}

export type ResultadoRegistroAviso =
  | { readonly registrado: true; readonly avisoId: string; readonly versao: string }
  | { readonly registrado: false; readonly motivo: 'envio_nao_ok' | 'sem_aviso_no_texto' | 'ja_registrado' }

/**
 * CONTRATO PARA A P13 (e para a abertura do agente): registra o aviso SE o
 * texto enviado contém o aviso de privacidade do tenant (link configurado, ou
 * o texto padrão) E o envio deu certo. Idempotente por mensagem.
 *
 *   const e = await enviarTextoNaConversa(...)
 *   await comTenantServico(t, (tx) => registrarAvisoSeExibido(tx, { envio: e, ..., origem: 'humano' }))
 *
 * Chamar sob tenant (RLS).
 */
export async function registrarAvisoSeExibido(tx: Sql, p: RegistrarAviso): Promise<ResultadoRegistroAviso> {
  if (!p.envio.ok) return { registrado: false, motivo: 'envio_nao_ok' }
  const cfg = await lerPrivacidade(tx)
  if (!contemAvisoPrivacidade(p.texto, { url: cfg.url, textoPadrao: cfg.textoPadrao })) {
    return { registrado: false, motivo: 'sem_aviso_no_texto' }
  }
  const id = randomUUID()
  const [l] = await tx<{ id: string }[]>`
    INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem, exibido_em)
    VALUES (tenant_atual(), ${id}, ${p.contatoId}, ${p.conversaId}, ${p.canalId}, ${p.envio.mensagemId},
            ${p.texto.slice(0, 2000)}, ${cfg.versao}, ${p.origem}, ${p.agora})
    ON CONFLICT (tenant_id, mensagem_id) DO NOTHING
    RETURNING id`
  return l ? { registrado: true, avisoId: l.id, versao: cfg.versao } : { registrado: false, motivo: 'ja_registrado' }
}
