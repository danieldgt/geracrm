/**
 * Regras de apresentação das telas de campanhas (lista, wizard e detalhe) — sem Angular, testáveis em
 * Vitest puro. O que a API decide (elegibilidade, preço, ações permitidas) NÃO é refeito aqui: a tela
 * só monta o corpo, formata e mapeia o erro de volta para o campo.
 */
import {
  JANELA_MARKETING_LIMITE, LIMITE_TESTE_NUMERO_HORA, LIMITE_TESTE_USUARIO_HORA, LOTE_DIARIO_MAXIMO, LOTE_DIARIO_PADRAO,
  MAX_TELEFONES_TESTE, ROTULO_ESTADO_CAMPANHA, ROTULO_MOTIVO_PAUSA, confirmacaoDoNomeConfere, ehEstadoCampanha,
  type AcaoCampanha, type MotivoPausa,
} from '@geracrm/shared'

/** O número da campanha teve as ativas suspensas pela Meta (P11): o despachante segura a fila. */
export interface PausaPorQualidade {
  readonly desde: string
  /** `qualidade:…` (volta sozinha) ou `conta:…` (alguém libera na tela do agente). */
  readonly motivo: string | null
}

/**
 * O aviso que a campanha em curso mostra quando o número está suspenso. Diz o
 * que aconteceu e o que acontece depois — nada é perdido, a fila espera.
 */
export function avisoDePausa(p: PausaPorQualidade | null | undefined): { titulo: string; detalhe: string } | null {
  if (!p) return null
  if ((p.motivo ?? '').startsWith('conta:')) {
    return {
      titulo: 'Pausada: a Meta restringiu a conta do número',
      detalhe: 'Os envios pendentes esperam. Confira a conta no Gerenciador do WhatsApp e libere as ativas na tela do agente.',
    }
  }
  return {
    titulo: 'Pausada por qualidade do número',
    detalhe: 'A qualidade do número caiu na Meta. Os envios pendentes esperam e a campanha retoma sozinha quando a qualidade normalizar.',
  }
}

// ── Bloqueio do número e pausa de risco ──────────────────────────────────────

/** Título e ação corretiva de um aviso de campanha (o que aconteceu e o que fazer). */
export interface AvisoAcao { readonly titulo: string; readonly acao: string }

/** Campanha em curso parada porque o NÚMERO não pode enviar (`bloqueio` da API, só enviando/agendada). */
const BLOQUEIOS: Readonly<Record<string, AvisoAcao>> = {
  sem_numero: {
    titulo: 'Envio parado: o número desta campanha não existe mais',
    acao: 'Cancele a campanha e crie outra com um número ativo em Meus Números.',
  },
  numero_arquivado: {
    titulo: 'Envio parado: o número foi arquivado',
    acao: 'Cancele a campanha e crie outra com um número ativo em Meus Números.',
  },
  numero_desconectado: {
    titulo: 'Envio parado: o número está desconectado',
    acao: 'Reconecte o número em Meus Números para o envio voltar.',
  },
  numero_sem_credencial: {
    titulo: 'Envio parado: o número não tem credencial válida',
    acao: 'Conecte o número de novo em Meus Números.',
  },
  disparo_pausado: {
    titulo: 'Envio parado: os disparos deste número estão pausados',
    acao: 'Abra o número em Meus Números e clique em Retomar disparo.',
  },
}

/** Aviso do bloqueio. Motivo que a tela não conhece ganha texto genérico: nunca fica em branco. */
export function avisoDeBloqueio(b: { readonly motivo: string } | null | undefined): AvisoAcao | null {
  if (!b) return null
  return BLOQUEIOS[b.motivo] ?? { titulo: 'Envio parado pelo número', acao: 'Confira o número em Meus Números.' }
}

/** Pausa em que a Meta sinalizou o número: não se retoma no escuro. */
export function ehPausaDeRisco(motivo: string | null | undefined): boolean {
  return motivo === 'numero_em_risco'
}

export const AVISO_PAUSA_DE_RISCO: AvisoAcao = {
  titulo: 'A Meta sinalizou o número',
  acao: 'O número recebeu limite, bloqueio temporário ou alerta de spam. Insistir pode banir o número: confira a conta no Gerenciador do WhatsApp e só retome depois de resolver a causa.',
}

/** Aviso de janela recortada pelo limite de marketing (08:00–21:00). `null` quando não foi ajustada. */
export function avisoJanelaAjustada(ajustada: boolean | null | undefined): string | null {
  if (!ajustada) return null
  const L = JANELA_MARKETING_LIMITE
  return `Janela ajustada para ${L.de}–${L.ate} (limite de marketing): o expediente do número saía desse horário e foi recortado.`
}

// ── Wizard: passos e formulário ──────────────────────────────────────────────

export const PASSOS = ['detalhes', 'publico', 'envio', 'revisao'] as const
export type PassoWizard = (typeof PASSOS)[number]

export const ROTULO_PASSO: Readonly<Record<PassoWizard, string>> = {
  detalhes: 'Detalhes e template', publico: 'Público', envio: 'Envio', revisao: 'Revisão',
}

export const TIPO_OFICIAL = 'whatsapp_oficial'
export const TIPO_NAO_OFICIAL = 'whatsapp_nao_oficial'
export const MAX_MENSAGEM = 4096

/** Uma opção escolhida num seletor múltiplo: o id vai para a API, o rótulo é só da tela. */
export interface OpcaoEscolhida { readonly valor: string; readonly rotulo: string }

export interface PublicoForm {
  readonly segmentos: readonly string[]
  readonly listas: readonly OpcaoEscolhida[]
  readonly etapas: readonly OpcaoEscolhida[]
  readonly origens: readonly OpcaoEscolhida[]
  readonly etiquetas: readonly OpcaoEscolhida[]
  readonly qualificacao: readonly string[]
  /** Texto do campo "sem interação há N dias"; vazio = não restringe. */
  readonly semInteracaoDias: string
  readonly criadoDe: string
  readonly criadoAte: string
  /** Janelas das exclusões configuráveis (texto; vazio = padrão da API; 0 desliga). */
  readonly conversaRecenteDias: string
  readonly campanhaRecenteDias: string
  readonly compraRecenteDias: string
}

export type JanelaDia = { de: string; ate: string } | null

export interface FormCampanha {
  readonly nome: string
  readonly canalId: string
  /** Tipo do número escolhido (decide template × texto livre); '' antes da escolha. */
  readonly canalTipo: string
  readonly templateId: string
  readonly mensagem: string
  readonly confirmaRiscoBanimento: boolean
  readonly publico: PublicoForm
  /** Texto; vazio = padrão da API. */
  readonly loteDiario: string
  /** `datetime-local` ('AAAA-MM-DDTHH:mm'); vazio = começa ao iniciar. */
  readonly inicioEm: string
  readonly janelaPropria: boolean
  readonly janela: Readonly<Record<string, JanelaDia>>
  readonly janelaDias: string
}

export const PUBLICO_VAZIO: PublicoForm = {
  segmentos: [], listas: [], etapas: [], origens: [], etiquetas: [], qualificacao: [],
  semInteracaoDias: '', criadoDe: '', criadoAte: '', conversaRecenteDias: '', campanhaRecenteDias: '', compraRecenteDias: '',
}

export const JANELA_INICIAL: Readonly<Record<string, JanelaDia>> = {
  seg: { de: '08:00', ate: '20:00' }, ter: { de: '08:00', ate: '20:00' }, qua: { de: '08:00', ate: '20:00' },
  qui: { de: '08:00', ate: '20:00' }, sex: { de: '08:00', ate: '20:00' }, sab: { de: '08:00', ate: '20:00' }, dom: null,
}

export const FORM_VAZIO: FormCampanha = {
  nome: '', canalId: '', canalTipo: '', templateId: '', mensagem: '', confirmaRiscoBanimento: false,
  publico: PUBLICO_VAZIO, loteDiario: '', inicioEm: '', janelaPropria: false, janela: JANELA_INICIAL, janelaDias: '7',
}

/** Inteiro não negativo a partir do texto do campo; null se vazio ou inválido (a validação aponta o erro). */
export function inteiroDoTexto(t: string): number | null {
  const s = t.trim()
  return /^\d+$/.test(s) ? Number(s) : null
}

export type ErrosCampo = Readonly<Record<string, string>>

/** Valida UM passo. Devolve campo → mensagem (vazio = passo ok). Cliente é conveniência; a API é a regra. */
export function errosDoPasso(passo: PassoWizard, f: FormCampanha): ErrosCampo {
  const e: Record<string, string> = {}
  if (passo === 'detalhes') {
    if (!f.nome.trim()) e['nome'] = 'Dê um nome à campanha.'
    else if (f.nome.trim().length > 120) e['nome'] = 'No máximo 120 caracteres.'
    if (!f.canalId) e['canalId'] = 'Escolha o número que vai enviar.'
    else if (f.canalTipo === TIPO_OFICIAL) {
      if (!f.templateId) e['templateId'] = 'No número oficial, escolha um template aprovado.'
    } else if (f.canalTipo === TIPO_NAO_OFICIAL) {
      if (!f.mensagem.trim()) e['mensagem'] = 'Escreva o texto da campanha.'
      else if (f.mensagem.trim().length > MAX_MENSAGEM) e['mensagem'] = `No máximo ${MAX_MENSAGEM} caracteres.`
      if (!f.confirmaRiscoBanimento) e['confirmaRiscoBanimento'] = 'Confirme que está ciente do risco de banimento.'
    } else {
      e['canalId'] = 'Este número não faz disparo em massa. Use um número de WhatsApp.'
    }
  }
  if (passo === 'publico') {
    const p = f.publico
    const numericos = [
      ['publico.semInteracaoDias', p.semInteracaoDias, 1, 3650],
      ['publico.exclusoes.conversaRecenteDias', p.conversaRecenteDias, 0, 90],
      ['publico.exclusoes.campanhaRecenteDias', p.campanhaRecenteDias, 0, 180],
      ['publico.exclusoes.compraRecenteDias', p.compraRecenteDias, 0, 365],
    ] as const
    for (const [campo, texto, min, max] of numericos) {
      if (texto.trim() === '') continue
      const n = inteiroDoTexto(texto)
      if (n === null || n < min || n > max) e[campo] = `Informe um número de ${min} a ${max}.`
    }
    if (p.criadoDe && p.criadoAte && p.criadoDe > p.criadoAte) e['publico.criadoAte'] = 'A data final é anterior à inicial.'
  }
  if (passo === 'envio') {
    if (f.loteDiario.trim() !== '') {
      const n = inteiroDoTexto(f.loteDiario)
      if (n === null || n < 1 || n > LOTE_DIARIO_MAXIMO) e['loteDiario'] = `Informe de 1 a ${LOTE_DIARIO_MAXIMO}.`
    }
    if (f.inicioEm && Number.isNaN(Date.parse(f.inicioEm))) e['inicioEm'] = 'Data e hora inválidas.'
    if (f.janelaPropria) {
      const abertos = Object.values(f.janela).filter((d) => d !== null)
      if (abertos.length === 0) e['janela'] = 'Abra pelo menos um dia da semana.'
      else if (abertos.some((d) => !d || !d.de || !d.ate || d.de >= d.ate)) e['janela'] = 'Em cada dia, a hora final precisa ser depois da inicial.'
      else if (abertos.some((d) => !!d && (d.de < JANELA_MARKETING_LIMITE.de || d.ate > JANELA_MARKETING_LIMITE.ate))) {
        e['janela'] = `Campanha de marketing só sai entre ${JANELA_MARKETING_LIMITE.de} e ${JANELA_MARKETING_LIMITE.ate}.`
      }
    }
    const j = inteiroDoTexto(f.janelaDias)
    if (j === null || j < 1 || j > 90) e['janelaDias'] = 'Informe de 1 a 90 dias.'
  }
  return e
}

/** Passos que ainda têm erro (a revisão só deixa salvar com todos limpos). */
export function passosComErro(f: FormCampanha): readonly PassoWizard[] {
  return PASSOS.filter((p) => p !== 'revisao' && Object.keys(errosDoPasso(p, f)).length > 0)
}

export function podeAvancar(passo: PassoWizard, f: FormCampanha): boolean {
  return Object.keys(errosDoPasso(passo, f)).length === 0
}

// ── Wizard: corpo da API ─────────────────────────────────────────────────────

export interface PublicoApi {
  segmentos?: string[]; listas?: string[]; etapas?: string[]; origens?: string[]; etiquetas?: string[]
  qualificacao?: string[]; semInteracaoDias?: number; criadoDe?: string; criadoAte?: string
  exclusoes?: { conversaRecenteDias?: number; campanhaRecenteDias?: number; compraRecenteDias?: number }
}

/** Só o que foi preenchido: tipo vazio não restringe, e mandar vazio só polui o público gravado. */
export function montarPublico(p: PublicoForm): PublicoApi {
  const o: PublicoApi = {}
  if (p.segmentos.length) o.segmentos = [...p.segmentos]
  if (p.listas.length) o.listas = p.listas.map((x) => x.valor)
  if (p.etapas.length) o.etapas = p.etapas.map((x) => x.valor)
  if (p.origens.length) o.origens = p.origens.map((x) => x.valor)
  if (p.etiquetas.length) o.etiquetas = p.etiquetas.map((x) => x.valor)
  if (p.qualificacao.length) o.qualificacao = [...p.qualificacao]
  const sem = inteiroDoTexto(p.semInteracaoDias)
  if (sem !== null) o.semInteracaoDias = sem
  if (p.criadoDe) o.criadoDe = p.criadoDe
  if (p.criadoAte) o.criadoAte = p.criadoAte
  const ex: NonNullable<PublicoApi['exclusoes']> = {}
  const c = inteiroDoTexto(p.conversaRecenteDias); if (c !== null) ex.conversaRecenteDias = c
  const k = inteiroDoTexto(p.campanhaRecenteDias); if (k !== null) ex.campanhaRecenteDias = k
  const b = inteiroDoTexto(p.compraRecenteDias); if (b !== null) ex.compraRecenteDias = b
  if (Object.keys(ex).length) o.exclusoes = ex
  return o
}

export interface CorpoCampanha {
  nome: string
  canalId: string
  templateId?: string
  mensagem?: string
  confirmaRiscoBanimento?: boolean
  publico: PublicoApi
  loteDiario?: number
  inicioEm?: string
  janela?: Record<string, JanelaDia>
  janelaDias: number
}

/** Janela com os sete dias explícitos (dia fechado = null), como a API grava. */
export function janelaParaApi(j: Readonly<Record<string, JanelaDia>>): Record<string, JanelaDia> {
  const s: Record<string, JanelaDia> = {}
  for (const d of ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom']) s[d] = j[d] ?? null
  return s
}

/**
 * O corpo do POST/PUT. ⚠️ Oficial manda SÓ `templateId`; não oficial manda SÓ `mensagem` + a confirmação
 * do risco (a API recusa o outro campo) — e preço nunca viaja: é resolvido no servidor.
 */
export function montarCorpo(f: FormCampanha): CorpoCampanha {
  const c: CorpoCampanha = {
    nome: f.nome.trim(), canalId: f.canalId, publico: montarPublico(f.publico), janelaDias: inteiroDoTexto(f.janelaDias) ?? 7,
  }
  if (f.canalTipo === TIPO_OFICIAL) c.templateId = f.templateId
  if (f.canalTipo === TIPO_NAO_OFICIAL) { c.mensagem = f.mensagem.trim(); c.confirmaRiscoBanimento = f.confirmaRiscoBanimento }
  const lote = inteiroDoTexto(f.loteDiario)
  if (lote !== null) c.loteDiario = lote
  if (f.inicioEm) {
    const t = Date.parse(f.inicioEm)
    if (!Number.isNaN(t)) c.inicioEm = new Date(t).toISOString()
  }
  if (f.janelaPropria) c.janela = janelaParaApi(f.janela)
  return c
}

export interface CorpoPrevia { canalId: string; templateId?: string; publico: PublicoApi; loteDiario?: number }

/** ISO (UTC) → valor do `datetime-local` no horário do navegador; vazio se nulo ou inválido. */
export function isoParaLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface CampanhaParaForm {
  readonly nome: string
  readonly canal: { id: string; tipo: string | null } | null
  readonly template: { id: string } | null
  readonly mensagem: string | null
  readonly publico: PublicoApi | null
  readonly loteDiario: number | null
  readonly inicioEm: string | null
  readonly janela: Readonly<Record<string, JanelaDia>> | null
  readonly janelaDias: number
  readonly confirmaRiscoBanimento: boolean
}

/**
 * Rascunho gravado → formulário do wizard (edição). `rotulo` resolve o nome do id escolhido (o público só
 * guarda ids); sem nome conhecido, o chip mostra o início do id em vez de sumir.
 */
export function formDaCampanha(
  c: CampanhaParaForm, rotulo: (tipo: 'listas' | 'etapas' | 'origens' | 'etiquetas', id: string) => string | null,
): FormCampanha {
  const p = c.publico ?? {}
  const ids = (tipo: 'listas' | 'etapas' | 'origens' | 'etiquetas'): OpcaoEscolhida[] =>
    (p[tipo] ?? []).map((id) => ({ valor: id, rotulo: rotulo(tipo, id) ?? `Item ${id.slice(0, 8)}` }))
  const txt = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n))
  const janelaPropria = !!c.janela && Object.keys(c.janela).length > 0
  return {
    nome: c.nome, canalId: c.canal?.id ?? '', canalTipo: c.canal?.tipo ?? '', templateId: c.template?.id ?? '',
    mensagem: c.mensagem ?? '', confirmaRiscoBanimento: c.confirmaRiscoBanimento,
    publico: {
      segmentos: p.segmentos ?? [], listas: ids('listas'), etapas: ids('etapas'), origens: ids('origens'), etiquetas: ids('etiquetas'),
      qualificacao: p.qualificacao ?? [], semInteracaoDias: txt(p.semInteracaoDias), criadoDe: p.criadoDe ?? '', criadoAte: p.criadoAte ?? '',
      conversaRecenteDias: txt(p.exclusoes?.conversaRecenteDias), campanhaRecenteDias: txt(p.exclusoes?.campanhaRecenteDias),
      compraRecenteDias: txt(p.exclusoes?.compraRecenteDias),
    },
    loteDiario: txt(c.loteDiario), inicioEm: isoParaLocal(c.inicioEm),
    janelaPropria, janela: janelaPropria && c.janela ? janelaParaApi(c.janela) : JANELA_INICIAL, janelaDias: String(c.janelaDias),
  }
}

/** O corpo da prévia: sem nome nem mensagem, só o que muda custo, público e duração. */
export function montarCorpoPrevia(f: FormCampanha): CorpoPrevia | null {
  if (!f.canalId) return null
  const c: CorpoPrevia = { canalId: f.canalId, publico: montarPublico(f.publico) }
  if (f.canalTipo === TIPO_OFICIAL && f.templateId) c.templateId = f.templateId
  const lote = inteiroDoTexto(f.loteDiario)
  if (lote !== null && lote >= 1 && lote <= LOTE_DIARIO_MAXIMO) c.loteDiario = lote
  return c
}

/** O lote que vale quando o campo está vazio (o padrão da API), para a tela dizer o número. */
export function loteEfetivo(f: Pick<FormCampanha, 'loteDiario'>): number {
  return inteiroDoTexto(f.loteDiario) ?? LOTE_DIARIO_PADRAO
}

// ── Erro da API → campo ──────────────────────────────────────────────────────

export interface ErroMapeado {
  /** Campo do formulário → mensagem (chaves iguais às de `errosDoPasso`). */
  readonly campos: ErrosCampo
  /** Mensagem sem campo para mostrar no topo (ou null quando o campo basta). */
  readonly geral: string | null
  /** Primeiro passo com erro: o wizard volta para ele. */
  readonly passo: PassoWizard | null
  /** Variáveis `{{n}}` do template sem mapeamento (`campanha.template_sem_mapeamento`). */
  readonly faltando: readonly number[]
}

export function passoDoCampo(campo: string): PassoWizard {
  if (campo.startsWith('publico')) return 'publico'
  if (campo === 'loteDiario' || campo === 'inicioEm' || campo === 'janela' || campo === 'janelaDias') return 'envio'
  return 'detalhes'
}

export interface CorpoDeErro {
  readonly erro?: string
  readonly mensagem?: string
  readonly campos?: Readonly<Record<string, string>>
  readonly faltando?: readonly number[]
}

/**
 * 422 com `campos` → cada mensagem no seu campo (skill de formulários); sem `campos` a mensagem vai no topo.
 * Chaves aninhadas da janela (`janela.seg.de`) sobem para `janela`, que é o campo que a tela tem.
 */
export function mapearErro(corpo: CorpoDeErro | null | undefined, padrao: string): ErroMapeado {
  if (!corpo) return { campos: {}, geral: padrao, passo: null, faltando: [] }
  const campos: Record<string, string> = {}
  for (const [k, v] of Object.entries(corpo.campos ?? {})) {
    const chave = k.startsWith('janela.') ? 'janela' : k === 'corpo' ? '' : k
    if (chave) campos[chave] = v
  }
  const chaves = Object.keys(campos)
  const passo = chaves.length ? (PASSOS.find((p) => chaves.some((c) => passoDoCampo(c) === p)) ?? null) : null
  const geral = chaves.length ? null : (corpo.mensagem ?? padrao)
  return { campos, geral, passo, faltando: corpo.faltando ?? [] }
}

/** "As variáveis {{1}}, {{2}} não têm campo…" para o aviso do template sem mapeamento. */
export function textoVariaveisFaltando(faltando: readonly number[]): string {
  if (faltando.length === 0) return ''
  const lista = faltando.map((n) => `{{${n}}}`).join(', ')
  const um = faltando.length === 1
  return `${um ? 'A variável' : 'As variáveis'} ${lista} ${um ? 'não tem' : 'não têm'} campo do contato mapeado. Mapeie em Templates antes de usar em campanha.`
}

// ── Prévia ───────────────────────────────────────────────────────────────────

export interface PreviaApi {
  readonly total: number
  readonly elegiveis: number
  readonly excluidos: Readonly<Record<string, number>>
  readonly amostra: readonly { nome: string; cidade: string | null }[]
  readonly custoEstimadoCentavos: number
  readonly precoUnitarioCentavos: number
  readonly duracaoDias: number
  readonly loteDiario: number
  readonly aquecimento: { dia: number; limiteHoje: number; restanteHoje: number } | null
  /** `ajustada`: o expediente do número foi recortado ao limite de marketing (08:00–21:00). */
  readonly janelaDoNumero: { origem: string; horario: Readonly<Record<string, JanelaDia>>; ajustada: boolean }
}

/** Reais a partir de centavos inteiros (a conversão só acontece na borda, ao formatar). */
export function formatarCusto(centavos: number): string {
  return (Math.round(centavos) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function textoPrecoUnitario(centavos: number): string {
  return centavos === 0 ? 'sem tarifa da Meta' : `${formatarCusto(centavos)} por mensagem`
}

export function textoDuracao(dias: number): string {
  if (dias <= 0) return 'Nada a enviar'
  return dias === 1 ? 'Termina em 1 dia' : `Termina em ${dias} dias`
}

export interface LinhaExcluido { readonly motivo: string; readonly n: number }

/** Excluídos por motivo, só os que têm gente, na ordem recebida; motivo novo da API entra no fim. */
export function excluidosOrdenados(ex: Readonly<Record<string, number>>, ordem: readonly string[]): readonly LinhaExcluido[] {
  const conhecidos = ordem.filter((m) => (ex[m] ?? 0) > 0).map((m) => ({ motivo: m, n: ex[m] ?? 0 }))
  const extras = Object.keys(ex).filter((m) => !ordem.includes(m) && (ex[m] ?? 0) > 0).map((m) => ({ motivo: m, n: ex[m] ?? 0 }))
  return [...conhecidos, ...extras]
}

/** O aviso de aquecimento do não oficial: o teto do número segura o ritmo antes do lote. */
export function textoAquecimento(a: PreviaApi['aquecimento']): string | null {
  if (!a) return null
  return `Número em aquecimento (dia ${a.dia}): no máximo ${a.limiteHoje} envios hoje, restam ${a.restanteHoje}. O ritmo da campanha respeita esse teto.`
}

const NOME_DIA: Readonly<Record<string, string>> = {
  seg: 'Seg', ter: 'Ter', qua: 'Qua', qui: 'Qui', sex: 'Sex', sab: 'Sáb', dom: 'Dom',
}

/** "Seg, Ter 08:00–20:00; Sáb 09:00–12:00" — resumo da janela por dia da semana. */
export function resumoJanela(h: Readonly<Record<string, JanelaDia>> | null | undefined): string {
  if (!h) return 'Sem janela definida'
  const grupos = new Map<string, string[]>()
  for (const d of Object.keys(NOME_DIA)) {
    const f = h[d]
    if (!f) continue
    const k = `${f.de}–${f.ate}`
    grupos.set(k, [...(grupos.get(k) ?? []), NOME_DIA[d] ?? d])
  }
  if (grupos.size === 0) return 'Nenhum dia aberto'
  return [...grupos.entries()].map(([faixa, dias]) => `${dias.join(', ')} ${faixa}`).join('; ')
}

export const ROTULO_ORIGEM_JANELA: Readonly<Record<string, string>> = {
  campanha: 'da campanha', canal: 'do expediente do número', padrao: 'padrão de campanha',
}

// ── Estados, ações e selos ───────────────────────────────────────────────────

export type TomSelo = 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info'

export function rotuloEstado(e: string): string {
  return ehEstadoCampanha(e) ? ROTULO_ESTADO_CAMPANHA[e] : e
}

export function tomDoEstado(e: string): TomSelo {
  switch (e) {
    case 'agendada': case 'enviando': case 'disparando': return 'info'
    case 'pausada': return 'atencao'
    case 'concluida': return 'sucesso'
    case 'cancelada': return 'erro'
    default: return 'neutro'
  }
}

/** Motivo da pausa por extenso. Desconhecido (versão nova da API) cai no código, nunca em branco. */
export function rotuloMotivoPausa(motivo: string | null | undefined): string | null {
  if (!motivo) return null
  return (ROTULO_MOTIVO_PAUSA as Readonly<Record<string, string>>)[motivo as MotivoPausa] ?? motivo
}

export function ehPausaAutomatica(motivo: string | null | undefined): boolean {
  return !!motivo && motivo !== 'manual'
}

export type AcoesApi = Readonly<Record<AcaoCampanha, boolean>>

export interface AcaoDaTela { readonly acao: AcaoCampanha; readonly rotulo: string; readonly perigo: boolean }

const ROTULO_ACAO: Readonly<Record<AcaoCampanha, string>> = {
  editar: 'Editar', excluir: 'Excluir', iniciar: 'Iniciar', pausar: 'Pausar', retomar: 'Retomar',
  cancelar: 'Cancelar campanha', testar: 'Enviar teste',
}

/**
 * Ações do detalhe, na ordem da leitura (a principal primeiro). Legada (`modeloVersao` ≠ 2) não tem ação:
 * a API já devolve tudo `false`, e aqui garantimos isso mesmo se vier incompleto.
 */
export function acoesDaTela(modeloVersao: number, acoes: Partial<AcoesApi> | null | undefined): readonly AcaoDaTela[] {
  if (modeloVersao !== 2 || !acoes) return []
  const ordem: AcaoCampanha[] = ['iniciar', 'retomar', 'pausar', 'testar', 'editar', 'cancelar', 'excluir']
  return ordem.filter((a) => acoes[a] === true).map((a) => ({ acao: a, rotulo: ROTULO_ACAO[a], perigo: a === 'cancelar' || a === 'excluir' }))
}

export interface TextoConfirmacao { readonly titulo: string; readonly mensagem: string; readonly acao: string }

export function confirmacaoDaAcao(acao: 'pausar' | 'retomar' | 'cancelar' | 'excluir', nome: string): TextoConfirmacao {
  switch (acao) {
    case 'pausar':
      return { titulo: 'Pausar a campanha?', mensagem: `"${nome}" para de enviar agora. O que já saiu não volta, e os pendentes esperam até você retomar.`, acao: 'Pausar' }
    case 'retomar':
      return { titulo: 'Retomar a campanha?', mensagem: `"${nome}" volta a enviar os pendentes, dentro da janela e do lote diário.`, acao: 'Retomar' }
    case 'cancelar':
      return { titulo: 'Cancelar a campanha?', mensagem: `"${nome}" não envia mais nada. O que já saiu fica no relatório, e não dá para reativar.`, acao: 'Cancelar campanha' }
    case 'excluir':
      return { titulo: 'Excluir o rascunho?', mensagem: `"${nome}" será apagado. Só rascunhos podem ser excluídos.`, acao: 'Excluir' }
  }
}

/** Iniciar só destrava quando o nome digitado confere (mesma regra da API). */
export function podeIniciar(nome: string, digitado: string): boolean {
  return confirmacaoDoNomeConfere(nome, digitado)
}

/** Erros de negócio conhecidos das ações, com a ação corretiva — a API manda a frase, a tela só garante um texto. */
export function mensagemDeAcao(codigo: string | null, mensagemApi: string | null | undefined, padrao: string): string {
  if (codigo === 'campanha.numero_suspenso') return mensagemApi ?? 'O número está com os disparos suspensos pela qualidade na Meta. Libere o número antes de retomar.'
  if (codigo === 'campanha.sem_elegiveis') return mensagemApi ?? 'Nenhum contato elegível neste público depois das exclusões. Ajuste o público e tente de novo.'
  if (codigo === 'campanha.ja_iniciada') return 'A campanha já foi iniciada por outra pessoa. Atualize a tela.'
  if (codigo === 'campanha.estado_invalido') return mensagemApi ?? 'O estado da campanha mudou. Atualize a tela.'
  if (codigo === 'campanha.alterada_durante_inicio') return 'A campanha mudou enquanto iniciava; revise e tente de novo.'
  return mensagemApi ?? padrao
}

// ── Teste ────────────────────────────────────────────────────────────────────

export interface ValidacaoTelefones { readonly telefones: readonly string[]; readonly erro: string | null }

/** Dígitos de cada linha preenchida; 10 a 13 dígitos (DDD, com ou sem 55); sem repetidos; de 1 a 5. */
export function validarTelefonesTeste(linhas: readonly string[]): ValidacaoTelefones {
  const digitos = linhas.map((l) => l.replace(/\D/g, '')).filter((d) => d.length > 0)
  if (digitos.length === 0) return { telefones: [], erro: 'Informe pelo menos um telefone.' }
  if (digitos.length > MAX_TELEFONES_TESTE) return { telefones: [], erro: `No máximo ${MAX_TELEFONES_TESTE} telefones.` }
  if (digitos.some((d) => d.length < 10 || d.length > 13)) return { telefones: [], erro: 'Confira o DDD e o número de cada telefone.' }
  if (new Set(digitos).size !== digitos.length) return { telefones: [], erro: 'Há telefone repetido.' }
  return { telefones: digitos, erro: null }
}

const ROTULO_MOTIVO_TESTE: Readonly<Record<string, string>> = {
  bloqueado: 'Pediu para não receber', telefone_invalido: 'Telefone inválido',
  template_indisponivel: 'Template indisponível na Meta', variavel_sem_valor: 'Variável do template sem valor',
}

export function rotuloResultadoTeste(r: { ok: boolean; motivo?: string }): string {
  if (r.ok) return 'Enviado'
  return (r.motivo && ROTULO_MOTIVO_TESTE[r.motivo]) || `Falhou${r.motivo ? `: ${r.motivo}` : ''}`
}

/** Erro do envio de teste: `campo` só quando a API aponta os telefones; limite e cota dizem os números. */
export interface ErroTeste { readonly campo: 'telefones' | null; readonly mensagem: string }

export function erroDoTeste(
  codigo: string | null,
  corpo: (CorpoDeErro & { readonly limiteUsuarioHora?: number; readonly limiteNumeroHora?: number }) | null | undefined,
  padrao: string,
): ErroTeste {
  if (codigo === 'campanha.teste_limite') {
    const usuario = corpo?.limiteUsuarioHora ?? LIMITE_TESTE_USUARIO_HORA
    const numero = corpo?.limiteNumeroHora ?? LIMITE_TESTE_NUMERO_HORA
    return { campo: null, mensagem: `Limite de testes atingido: até ${usuario} telefones por pessoa e ${numero} por número a cada hora. Tente de novo mais tarde.` }
  }
  if (codigo === 'campanha.teste_sem_cota') {
    return { campo: null, mensagem: 'O número está em aquecimento e o teto de hoje acabou; o teste também conta. Tente amanhã ou use outro número.' }
  }
  const telefones = corpo?.campos?.['telefones']
  if (telefones) return { campo: 'telefones', mensagem: telefones }
  return { campo: null, mensagem: corpo?.mensagem ?? padrao }
}

// ── Detalhe: funil, progresso e falhas ───────────────────────────────────────

export interface RelatorioApi {
  readonly campanhaId: string
  readonly estado: string
  readonly pausaMotivo: string | null
  readonly funil: {
    readonly elegiveis: number; readonly enviadas: number; readonly entregues: number; readonly lidas: number
    readonly responderam: number; readonly pedidos: number; readonly vendasEstimadas: number
  }
  readonly progresso: { readonly pendentes: number; readonly enviando: number; readonly processados: number; readonly percentual: number }
  readonly excluidos: Readonly<Record<string, number>>
  readonly optOuts: number
  readonly falhas: number
  readonly falhasPorCodigo: readonly { codigo: string; n: number }[]
  readonly custo: {
    readonly categoria: string | null; readonly mensagensCobradas: number; readonly precoUnitarioCentavos: number; readonly totalCentavos: number
    readonly porPedidoCentavos: number | null; readonly porVendaEstimadaCentavos: number | null
  }
  readonly roi: {
    readonly janelaDias: number
    readonly exata: { readonly pedidos: number; readonly receitaCentavos: number }
    readonly estimada: { readonly vendas: number; readonly receitaCentavos: number }
    readonly enviados: number
  }
}

export interface DegrauFunil {
  readonly chave: 'enviadas' | 'entregues' | 'lidas' | 'respostas' | 'pedidos'
  readonly rotulo: string
  readonly valor: number
  /** Largura da barra em % do primeiro degrau (com valor, nunca some: mínimo 2%). */
  readonly larguraPct: number
  /** Taxa em relação ao degrau anterior; null no primeiro ou quando o anterior é zero. */
  readonly taxaDoAnterior: number | null
}

/** % inteira de parte sobre total (arredondada), null se total = 0. */
export function percentual(parte: number, total: number): number | null {
  return total > 0 ? Math.round((parte * 100) / total) : null
}

/** O funil até a venda: enviadas → entregues → lidas → respostas → pedidos (EXATA; a estimada fica separada). */
export function degrausDoFunil(f: RelatorioApi['funil']): readonly DegrauFunil[] {
  const base: readonly (readonly [DegrauFunil['chave'], string, number])[] = [
    ['enviadas', 'Enviadas', f.enviadas], ['entregues', 'Entregues', f.entregues], ['lidas', 'Lidas', f.lidas],
    ['respostas', 'Respostas', f.responderam], ['pedidos', 'Pedidos', f.pedidos],
  ]
  const topo = f.enviadas
  return base.map(([chave, rotulo, valor], i) => ({
    chave, rotulo, valor,
    larguraPct: topo > 0 ? Math.min(100, Math.max(valor > 0 ? 2 : 0, Math.round((valor * 100) / topo))) : 0,
    taxaDoAnterior: i === 0 ? null : percentual(valor, base[i - 1]?.[2] ?? 0),
  }))
}

/** Custo por venda: o servidor já calcula; aqui só o texto ("—" sem venda, nunca "R$ 0,00"). */
export function textoCustoPorVenda(centavos: number | null): string {
  return centavos === null ? '—' : formatarCusto(centavos)
}

const ROTULO_FALHA: Readonly<Record<string, string>> = {
  desconhecido: 'Motivo não informado', telefone_invalido: 'Telefone inválido', numero_sem_whatsapp: 'Número sem WhatsApp',
  template_indisponivel: 'Template indisponível', limite_do_numero: 'Limite do número atingido',
}

export function rotuloFalha(codigo: string): string {
  const r = ROTULO_FALHA[codigo]
  return r ? `${r} (${codigo})` : codigo
}

/** Taxa com uma casa decimal em pt-BR, só com inteiros (décimos de ponto). "—" sem base. */
export function textoTaxa(parte: number, total: number): string {
  if (total <= 0) return '—'
  const dec = Math.round((parte * 1000) / total)
  return `${Math.floor(dec / 10)},${dec % 10}%`
}

/**
 * O público em frases para a revisão: uma linha por tipo preenchido ("E" entre linhas, "ou" dentro dela).
 * Sem nenhum filtro, diz que é a base inteira (menos as exclusões) — o susto certo antes de iniciar.
 */
export function resumoPublico(
  p: PublicoForm, rotuloSegmento: (c: string) => string, rotuloQualificacao: (c: string) => string,
): readonly string[] {
  const linhas: string[] = []
  const ou = (xs: readonly string[]): string => xs.join(' ou ')
  if (p.segmentos.length) linhas.push(`Segmento: ${ou(p.segmentos.map(rotuloSegmento))}`)
  if (p.listas.length) linhas.push(`Lista: ${ou(p.listas.map((o) => o.rotulo))}`)
  if (p.etapas.length) linhas.push(`Etapa do funil: ${ou(p.etapas.map((o) => o.rotulo))}`)
  if (p.origens.length) linhas.push(`Origem: ${ou(p.origens.map((o) => o.rotulo))}`)
  if (p.etiquetas.length) linhas.push(`Etiqueta: ${ou(p.etiquetas.map((o) => o.rotulo))}`)
  if (p.qualificacao.length) linhas.push(`Qualificação: ${ou(p.qualificacao.map(rotuloQualificacao))}`)
  const sem = inteiroDoTexto(p.semInteracaoDias)
  if (sem !== null) linhas.push(`Sem interação há ${sem} dia${sem === 1 ? '' : 's'} ou mais`)
  if (p.criadoDe || p.criadoAte) {
    linhas.push(`Criado ${p.criadoDe ? `a partir de ${p.criadoDe}` : ''}${p.criadoDe && p.criadoAte ? ' ' : ''}${p.criadoAte ? `até ${p.criadoAte}` : ''}`)
  }
  return linhas.length ? linhas : ['Toda a base de contatos (menos as exclusões automáticas)']
}

// ── Template do número oficial ───────────────────────────────────────────────

/** Variáveis `{{n}}` do corpo do template, sem repetição, em ordem. */
export function variaveisDoCorpo(texto: string): readonly number[] {
  const achadas = [...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))
  return [...new Set(achadas)].sort((a, b) => a - b)
}

/** Variáveis do corpo sem campo do contato mapeado — o aviso antecipado (a API revalida ao salvar e ao iniciar). */
export function variaveisSemMapeamento(texto: string, mapa: Readonly<Record<string, string>> | null | undefined): readonly number[] {
  return variaveisDoCorpo(texto).filter((n) => !mapa?.[String(n)])
}

/** Só template de MARKETING aprovado serve para campanha (a categoria e a aprovação são conferidas de novo pela API). */
export function templateServeParaCampanha(t: { categoria: string; statusMeta: string }): boolean {
  return t.categoria.toUpperCase() === 'MARKETING' && t.statusMeta.toUpperCase() === 'APPROVED'
}

/** Busca local por termo (as listas por cursor não filtram no servidor; acento e caixa não contam). */
export function casaComTermo(texto: string, termo: string): boolean {
  const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  return norm(texto).includes(norm(termo.trim()))
}

// ── Destinatários ────────────────────────────────────────────────────────────

export interface DestinatarioApi {
  readonly id: string; readonly contatoId: string; readonly contatoNome: string; readonly estado: string
  readonly motivoExclusao: string | null; readonly erroCodigo: string | null; readonly conversaId: string | null
  readonly enviadoEm: string | null; readonly entregueEm: string | null; readonly lidoEm: string | null
  readonly respondeuEm: string | null; readonly optoutEm: string | null
}

/** O marco mais recente do destinatário (para a coluna "Quando"). */
export function marcoDoDestinatario(d: DestinatarioApi): string | null {
  return d.optoutEm ?? d.respondeuEm ?? d.lidoEm ?? d.entregueEm ?? d.enviadoEm
}

export function tomDoDestinatario(estado: string): TomSelo {
  switch (estado) {
    case 'respondeu': return 'sucesso'
    case 'lida': case 'entregue': case 'enviada': case 'enviando': return 'info'
    case 'falhou': case 'optout': return 'erro'
    case 'excluida': return 'atencao'
    default: return 'neutro'
  }
}
