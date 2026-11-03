import type { CampoFormulario, TipoCampo } from '@geracrm/shared'
import type { Sql } from '../../db/index.js'

/** Linha de `formulario_campo` → campo do domínio (compartilhado com a tela). */
export interface LinhaCampo {
  id: string; ordem: number; tipo: string; rotulo: string; placeholder: string | null
  obrigatorio: boolean; opcoes: unknown; condicoes: unknown; referencia: boolean
}

export function campoDeLinha(l: LinhaCampo): CampoFormulario {
  return {
    id: l.id, tipo: l.tipo as TipoCampo, rotulo: l.rotulo, placeholder: l.placeholder,
    obrigatorio: l.obrigatorio,
    opcoes: Array.isArray(l.opcoes) ? (l.opcoes as string[]) : [],
    condicoes: (l.condicoes && typeof l.condicoes === 'object' ? l.condicoes : {}) as Record<string, string[]>,
    referencia: l.referencia,
  }
}

export async function camposDoFormulario(tx: Sql, formularioId: string): Promise<CampoFormulario[]> {
  const linhas = await tx<LinhaCampo[]>`
    SELECT id, ordem, tipo, rotulo, placeholder, obrigatorio, opcoes, condicoes, referencia
      FROM formulario_campo
     WHERE tenant_id = tenant_atual() AND formulario_id = ${formularioId}
     ORDER BY ordem`
  return linhas.map(campoDeLinha)
}

export interface LinhaFormulario {
  id: string; nome: string; slug: string; chave_publica: string; titulo: string; descricao: string | null
  tipo: string; filial_id: string | null; etapa_destino_id: string | null; responsavel_padrao_id: string | null
  origem_id: string | null; cor: string; texto_botao: string; mensagem_sucesso: string; ativo: boolean
  consentimento_marketing: boolean; token_hash: string | null; criado_em: Date
}

/** Para `tx(COLUNAS_FORMULARIO)` — identificadores, nunca texto de usuário. */
export const COLUNAS_FORMULARIO = [
  'id', 'nome', 'slug', 'chave_publica', 'titulo', 'descricao', 'tipo', 'filial_id', 'etapa_destino_id',
  'responsavel_padrao_id', 'origem_id', 'cor', 'texto_botao', 'mensagem_sucesso', 'ativo', 'consentimento_marketing',
  'token_hash', 'criado_em',
]

/** Representação de API. ⚠️ Nunca devolve `token_hash`: só diz se há token. */
export function formularioParaApi(l: LinhaFormulario, totalRespostas?: number) {
  return {
    id: l.id, nome: l.nome, slug: l.slug, chavePublica: l.chave_publica, titulo: l.titulo, descricao: l.descricao,
    tipo: l.tipo, filialId: l.filial_id, etapaDestinoId: l.etapa_destino_id, responsavelPadraoId: l.responsavel_padrao_id,
    origemId: l.origem_id, cor: l.cor, textoBotao: l.texto_botao, mensagemSucesso: l.mensagem_sucesso, ativo: l.ativo,
    consentimentoMarketing: l.consentimento_marketing, temToken: l.token_hash !== null, criadoEm: l.criado_em,
    ...(totalRespostas === undefined ? {} : { totalRespostas }),
  }
}

/** Mensagem exibida quando o tenant ainda não escreveu o seu texto de consentimento (D5). */
export const TEXTO_CONSENTIMENTO_PADRAO =
  'Ao enviar este formulário, você autoriza o uso dos seus dados para contato sobre sua solicitação, '
  + 'inclusive por WhatsApp. Você pode pedir a exclusão dos dados a qualquer momento.'

/** Acrescentado ao texto quando o formulário pede consentimento de marketing — o pedido fica EXPLÍCITO. */
export const TEXTO_CONSENTIMENTO_MARKETING =
  'Também autorizo o envio de ofertas e novidades por WhatsApp; posso cancelar quando quiser.'

/**
 * O texto que a pessoa VÊ e aceita (é o que vai congelado na resposta e cujo hash o POST confere).
 * Marketing só entra quando o formulário pede — e então aparece escrito, não presumido.
 */
export function textoConsentimentoExibido(doTenant: string | null, marketing: boolean): string {
  const base = doTenant?.trim() || TEXTO_CONSENTIMENTO_PADRAO
  return marketing ? `${base} ${TEXTO_CONSENTIMENTO_MARKETING}` : base
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Cursor opaco (criado_em com µs, id). */
export function lerCursorTempo(bruto: string | undefined): { em: string; id: string } | null | 'invalido' {
  if (!bruto) return null
  try {
    const [em, id] = Buffer.from(bruto, 'base64url').toString('utf8').split('§')
    if (!em || !id || !UUID.test(id) || Number.isNaN(Date.parse(em))) return 'invalido'
    return { em, id }
  } catch { return 'invalido' }
}
export const montarCursorTempo = (em: string, id: string) => Buffer.from(`${em}§${id}`).toString('base64url')
