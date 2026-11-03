import { filtrarSaida } from './agente-filtro.js'

/**
 * PÓS-VENDA PELO AGENTE, NPS, INDICAÇÕES E PROVA SOCIAL (raia G3; paridade AM #100, #104, #106).
 *
 * Contratos e regras PURAS usados pela API (rotas de automação e de conhecimento,
 * ferramentas do agente) e pelo console (formulários de Automações e de
 * Conhecimento). TypeScript puro — nada de framework.
 *
 * ⚠️ A tela valida por conveniência; a API chama as MESMAS funções e é a regra.
 */

// ── automações ───────────────────────────────────────────────────────────────

export const GATILHOS_AUTOMACAO = [
  'rfv_segmento', 'dias_sem_comprar', 'lead_frio', 'nps_detrator', 'reposicao_ritmo', 'pedido_efetivado',
] as const
export type GatilhoAutomacao = (typeof GATILHOS_AUTOMACAO)[number]

export const ACOES_AUTOMACAO = ['criar_tarefa', 'aplicar_sequencia', 'adicionar_lista', 'enviar_mensagem', 'agente_envia'] as const
export type AcaoAutomacao = (typeof ACOES_AUTOMACAO)[number]

export const ROTULO_GATILHO_AUTOMACAO: Readonly<Record<GatilhoAutomacao, string>> = {
  rfv_segmento: 'Cruzou segmento RFV',
  dias_sem_comprar: 'Dias sem comprar',
  lead_frio: 'Lead frio',
  nps_detrator: 'NPS detrator',
  reposicao_ritmo: 'Régua de recompra (ritmo do cliente)',
  pedido_efetivado: 'Pedido efetivado',
}

export const ROTULO_ACAO_AUTOMACAO: Readonly<Record<AcaoAutomacao, string>> = {
  criar_tarefa: 'Criar tarefa',
  aplicar_sequencia: 'Aplicar sequência',
  adicionar_lista: 'Adicionar à lista',
  enviar_mensagem: 'Enviar mensagem ao cliente',
  agente_envia: 'Agente envia mensagem (pós-venda)',
}

/** Teto do texto que sai para o cliente por automação (mesmo de `enviar_mensagem`). */
export const MAX_TEXTO_AUTOMACAO = 900
/** "Dias depois" da efetivação: 0 (no mesmo dia) a 60. */
export const DIAS_DEPOIS_MAX = 60

/** Roteiros do pós-venda: o que o agente manda depois da efetivação. */
export const ROTEIROS_POS_VENDA = ['agradecimento', 'nps', 'indicacao'] as const
export type RoteiroPosVenda = (typeof ROTEIROS_POS_VENDA)[number]

export const ROTULO_ROTEIRO_POS_VENDA: Readonly<Record<RoteiroPosVenda, string>> = {
  agradecimento: 'Agradecimento e instruções',
  nps: 'Pesquisa NPS (nota de 0 a 10)',
  indicacao: 'Pedido de indicação',
}

export const ehRoteiroPosVenda = (v: unknown): v is RoteiroPosVenda =>
  typeof v === 'string' && (ROTEIROS_POS_VENDA as readonly string[]).includes(v)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ResultadoParam<T> =
  | { readonly ok: true; readonly dados: T }
  | { readonly ok: false; readonly campo: string; readonly mensagem: string }

/** Parâmetro do gatilho `pedido_efetivado`: `{ diasDepois: 0..60 }` (ausente = 0). */
export function validarGatilhoPedidoEfetivado(p: unknown): ResultadoParam<{ diasDepois: number }> {
  const bruto = p && typeof p === 'object' ? (p as Record<string, unknown>)['diasDepois'] : undefined
  const dias = bruto === undefined || bruto === null || bruto === '' ? 0 : Number(bruto)
  if (!Number.isInteger(dias) || dias < 0 || dias > DIAS_DEPOIS_MAX) {
    return { ok: false, campo: 'gatilhoParam.diasDepois', mensagem: `Use de 0 a ${DIAS_DEPOIS_MAX} dias depois da efetivação.` }
  }
  return { ok: true, dados: { diasDepois: dias } }
}

export interface ParamAgenteEnvia {
  readonly roteiro: RoteiroPosVenda
  /** Texto livre (com `{nome}`): o que sai dentro da janela de 24h e no não-oficial. */
  readonly texto: string | null
  /** Template aprovado: o que sai no oficial fora da janela (ou sem texto). */
  readonly templateId: string | null
}

/**
 * Parâmetro da ação `agente_envia`. Exige roteiro e AO MENOS um conteúdo — texto
 * (até 900) ou template. ⚠️ Sem texto, o não-oficial não envia nada (template é
 * do oficial) — a tela avisa; a ativa vira `recusado` com `sem_texto_pos_venda`.
 */
export function validarAcaoAgenteEnvia(p: unknown): ResultadoParam<ParamAgenteEnvia> {
  const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
  if (!ehRoteiroPosVenda(o['roteiro'])) {
    return { ok: false, campo: 'acaoParam.roteiro', mensagem: 'Escolha o roteiro: agradecimento, NPS ou indicação.' }
  }
  const texto = typeof o['texto'] === 'string' && o['texto'].trim() ? o['texto'].trim() : null
  const bruto = o['templateId']
  const templateId = typeof bruto === 'string' && bruto.trim() ? bruto.trim() : null
  if (templateId !== null && !UUID_RE.test(templateId)) {
    return { ok: false, campo: 'acaoParam.templateId', mensagem: 'Template inválido.' }
  }
  if (texto === null && templateId === null) {
    return { ok: false, campo: 'acaoParam.texto', mensagem: 'Escreva a mensagem ou escolha um template aprovado.' }
  }
  if (texto !== null && texto.length > MAX_TEXTO_AUTOMACAO) {
    return { ok: false, campo: 'acaoParam.texto', mensagem: `Use no máximo ${MAX_TEXTO_AUTOMACAO} caracteres.` }
  }
  return { ok: true, dados: { roteiro: o['roteiro'], texto, templateId } }
}

// ── NPS ──────────────────────────────────────────────────────────────────────

/** Detrator no padrão NPS: 0 a 6. */
export const NOTA_MAX_DETRATOR = 6
export const ehDetratorNps = (nota: number): boolean => nota <= NOTA_MAX_DETRATOR
/** Por quantos dias depois do envio da pesquisa o roteiro NPS fica aberto na sessão. */
export const DIAS_ROTEIRO_POS_VENDA = 7

// ── indicações ───────────────────────────────────────────────────────────────

/** Máximo de indicações por chamada da ferramenta. */
export const MAX_INDICACOES = 5
/** Nome da origem de contato criada (se faltar) para os indicados. */
export const NOME_ORIGEM_INDICACAO = 'Indicação'

// ── prova social ─────────────────────────────────────────────────────────────

export const TIPOS_PROVA_SOCIAL = ['numero', 'depoimento'] as const
export type TipoProvaSocial = (typeof TIPOS_PROVA_SOCIAL)[number]
export const ROTULO_TIPO_PROVA_SOCIAL: Readonly<Record<TipoProvaSocial, string>> = {
  numero: 'Número / indicador',
  depoimento: 'Depoimento de cliente',
}

/**
 * Vigência: prova social apurada há mais de um ano não chega ao agente — o
 * número envelhece ("500 clientes atendidos" de 2019) e o depoimento perde o
 * contexto. Para voltar a valer, apure de novo e atualize a data (e reaprove).
 */
export const VALIDADE_PROVA_SOCIAL_DIAS = 365
export const LIMITES_PROVA_SOCIAL = { fonte: 200, link: 500 } as const

const DIA_MS = 86_400_000

/** `apuradoEm` é "AAAA-MM-DD". Vigente = nem no futuro, nem mais velha que a validade. */
export function provaSocialVigente(apuradoEm: string | null, agora: Date): boolean {
  if (!apuradoEm || !/^\d{4}-\d{2}-\d{2}$/.test(apuradoEm)) return false
  const t = Date.parse(`${apuradoEm}T00:00:00Z`)
  if (!Number.isFinite(t)) return false
  const hoje = Date.parse(`${agora.toISOString().slice(0, 10)}T00:00:00Z`)
  return t <= hoje && hoje - t <= VALIDADE_PROVA_SOCIAL_DIAS * DIA_MS
}

/**
 * Vetos próprios da prova social: afirmações ABSOLUTAS ou MUTÁVEIS que nenhuma
 * fonte sustenta por muito tempo (e que o CDC trata como publicidade enganosa).
 * Somam-se ao filtro base de saída do agente (promessa de prazo, preço, desconto…).
 */
const VETOS_PROVA_SOCIAL: readonly { padrao: RegExp; motivo: string }[] = [
  { padrao: /\bsem\s+(nenhuma\s+)?reclama/i, motivo: '"sem reclamações" é vetado (afirmação absoluta e mutável).' },
  { padrao: /\b(100\s?%|todos\s+os)\s+(dos\s+)?clientes\s+(satisfeitos|aprovam|recomendam)/i, motivo: 'Satisfação de "todos"/100% é vetada (afirmação absoluta).' },
  { padrao: /\b(o|a)\s+(melhor|maior)\s+(d[oa]\s+)?(brasil|mundo|mercado|regi[aã]o)/i, motivo: 'Superlativo absoluto ("o melhor do Brasil") é vetado.' },
  { padrao: /\b(n[uú]mero|n[ºo°])\s?1\b/i, motivo: '"Número 1" é vetado sem ranking oficial — cite o ranking como fonte em outra frase.' },
  { padrao: /\bresultado\s+garantid|\bgarantia\s+de\s+resultado/i, motivo: 'Promessa de resultado é vetada.' },
]

/** Motivos de veto do texto (vazio = permitido): vetos próprios + filtro base do agente. */
export function vetosProvaSocial(texto: string): string[] {
  const motivos = VETOS_PROVA_SOCIAL.filter((v) => v.padrao.test(texto)).map((v) => v.motivo)
  for (const o of filtrarSaida(texto).ocorrencias) {
    if (o.acao === 'removido') motivos.push(`O filtro do agente cortaria: "${(o.trecho ?? '').slice(0, 80)}".`)
  }
  return motivos
}

export interface CamposProvaSocial {
  readonly conteudo: string
  readonly fonte: string | null
  readonly link: string | null
  readonly apuradoEm: string | null
  readonly provaTipo: TipoProvaSocial | null
  readonly consentimento: boolean
}

export interface ErroCampoProvaSocial { readonly campo: string; readonly mensagem: string }

const LINK_RE = /^https?:\/\/\S+$/i

/** Erros de FORMATO que impedem salvar (link, tamanho, data, tipo) — rascunho pode estar incompleto. */
export function errosFormatoProvaSocial(c: Partial<CamposProvaSocial>): ErroCampoProvaSocial[] {
  const erros: ErroCampoProvaSocial[] = []
  if (c.fonte && c.fonte.length > LIMITES_PROVA_SOCIAL.fonte) {
    erros.push({ campo: 'fonte', mensagem: `Use no máximo ${LIMITES_PROVA_SOCIAL.fonte} caracteres.` })
  }
  if (c.link && (!LINK_RE.test(c.link) || c.link.length > LIMITES_PROVA_SOCIAL.link)) {
    erros.push({ campo: 'link', mensagem: 'Use um link http(s) válido.' })
  }
  if (c.apuradoEm && (!/^\d{4}-\d{2}-\d{2}$/.test(c.apuradoEm) || !Number.isFinite(Date.parse(`${c.apuradoEm}T00:00:00Z`)))) {
    erros.push({ campo: 'apuradoEm', mensagem: 'Data inválida.' })
  }
  if (c.provaTipo && !(TIPOS_PROVA_SOCIAL as readonly string[]).includes(c.provaTipo)) {
    erros.push({ campo: 'provaTipo', mensagem: 'Tipo inválido.' })
  }
  return erros
}

/**
 * O que falta para APROVAR (admin): fonte, data (não futura), tipo, consentimento
 * do depoimento, e nenhum veto no texto. Lista vazia = pode aprovar.
 */
export function errosParaAprovarProvaSocial(c: CamposProvaSocial, agora: Date): ErroCampoProvaSocial[] {
  const erros = [...errosFormatoProvaSocial(c)]
  if (!c.fonte?.trim()) erros.push({ campo: 'fonte', mensagem: 'Informe a fonte (de onde vem a afirmação).' })
  if (!c.apuradoEm) erros.push({ campo: 'apuradoEm', mensagem: 'Informe a data da apuração.' })
  else if (Date.parse(`${c.apuradoEm}T00:00:00Z`) > Date.parse(`${agora.toISOString().slice(0, 10)}T00:00:00Z`)) {
    erros.push({ campo: 'apuradoEm', mensagem: 'A data da apuração não pode ser no futuro.' })
  }
  if (!c.provaTipo) erros.push({ campo: 'provaTipo', mensagem: 'Diga se é um número ou um depoimento.' })
  if (c.provaTipo === 'depoimento' && !c.consentimento) {
    erros.push({ campo: 'consentimento', mensagem: 'Depoimento de cliente exige o consentimento dele (LGPD).' })
  }
  for (const v of vetosProvaSocial(c.conteudo)) erros.push({ campo: 'conteudo', mensagem: v })
  return erros
}
