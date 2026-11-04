// Preferências de notificação por tipo × canal (D4). TypeScript puro: a API decide o envio, o console
// desenha a matriz — as duas leem a MESMA regra daqui.

export const CANAIS_NOTIFICACAO = ['app', 'push', 'email'] as const
export type CanalNotificacao = (typeof CANAIS_NOTIFICACAO)[number]

export const ROTULO_CANAL_NOTIFICACAO: Readonly<Record<CanalNotificacao, string>> = {
  app: 'No sistema', push: 'Push no aparelho', email: 'E-mail',
}

export interface TipoNotificacao {
  readonly codigo: string
  readonly rotulo: string
  /** O e-mail só existe para os tipos em que esperar a próxima visita ao console custa caro. */
  readonly emailDisponivel: boolean
}

export const TIPOS_NOTIFICACAO: readonly TipoNotificacao[] = [
  { codigo: 'mensagem.nova', rotulo: 'Mensagem nova numa conversa sua', emailDisponivel: false },
  { codigo: 'fila.nova', rotulo: 'Conversa nova na fila', emailDisponivel: false },
  { codigo: 'agente.handoff', rotulo: 'O agente transferiu uma conversa', emailDisponivel: false },
  { codigo: 'atendimento.reatribuido', rotulo: 'Conversa reatribuída para você', emailDisponivel: false },
  { codigo: 'pedido.confirmacao_sem_pendente', rotulo: 'Cliente confirmando sem pedido pendente', emailDisponivel: false },
  { codigo: 'sla.estourado', rotulo: 'SLA do atendimento estourado', emailDisponivel: true },
  { codigo: 'sla.reatribuicao', rotulo: 'Conversa devolvida ao grupo por SLA', emailDisponivel: false },
  // ⚠️ `conversa.mencao` entra aqui QUANDO existir produtor (menção ainda não existe no produto): tipo sem
  //    produtor na matriz é botão que não faz nada.
  { codigo: 'nps.detrator', rotulo: 'NPS detrator', emailDisponivel: false },
  { codigo: 'campanha.pausada', rotulo: 'Campanha pausada automaticamente', emailDisponivel: false },
  { codigo: 'agenda.lembrete', rotulo: 'Lembrete de compromisso', emailDisponivel: false },
  { codigo: 'canal.qualidade', rotulo: 'Qualidade do número de WhatsApp', emailDisponivel: false },
  { codigo: 'agente.orcamento', rotulo: 'Orçamento de IA', emailDisponivel: false },
]

export const ehTipoNotificacao = (v: unknown): v is string =>
  typeof v === 'string' && TIPOS_NOTIFICACAO.some((t) => t.codigo === v)

export const ehCanalNotificacao = (v: unknown): v is CanalNotificacao =>
  typeof v === 'string' && (CANAIS_NOTIFICACAO as readonly string[]).includes(v)

export type CanaisLigados = Readonly<Record<CanalNotificacao, boolean>>

/** E-mail desligado por padrão, exceto onde o tipo existe justamente para isso (SLA estourado). */
const EMAIL_LIGADO_POR_PADRAO: readonly string[] = ['sla.estourado']

/** Sem linha gravada vale o padrão: no sistema e push ligados; e-mail só no SLA estourado. */
export function padraoDoTipo(tipo: string): CanaisLigados {
  return { app: true, push: true, email: EMAIL_LIGADO_POR_PADRAO.includes(tipo) }
}

export interface LinhaPreferencia {
  readonly tipo: string
  readonly canal: CanalNotificacao
  readonly ligado: boolean
}

/** Padrão do tipo + as linhas gravadas do usuário. E-mail em tipo sem e-mail fica sempre desligado. */
export function resolverCanais(tipo: string, linhas: readonly LinhaPreferencia[]): CanaisLigados {
  const r: Record<CanalNotificacao, boolean> = { ...padraoDoTipo(tipo) }
  for (const l of linhas) if (l.tipo === tipo) r[l.canal] = l.ligado
  const def = TIPOS_NOTIFICACAO.find((t) => t.codigo === tipo)
  if (def && !def.emailDisponivel) r.email = false
  return r
}

/** Valida o corpo do PUT de preferências. Falha é tipificada, nunca descarte silencioso. */
export type ResultadoPreferencias =
  | { readonly ok: true; readonly itens: readonly LinhaPreferencia[] }
  | { readonly ok: false; readonly erro: string; readonly mensagem: string }

export function validarPreferencias(corpo: unknown): ResultadoPreferencias {
  const itens = (corpo as { itens?: unknown } | null)?.itens
  if (!Array.isArray(itens) || itens.length === 0 || itens.length > 100) {
    return { ok: false, erro: 'preferencia.corpo_invalido', mensagem: 'Envie de 1 a 100 preferências.' }
  }
  const vistos = new Set<string>()
  const out: LinhaPreferencia[] = []
  for (const i of itens as { tipo?: unknown; canal?: unknown; ligado?: unknown }[]) {
    if (!ehTipoNotificacao(i?.tipo)) return { ok: false, erro: 'preferencia.tipo_invalido', mensagem: 'Tipo de notificação desconhecido.' }
    if (!ehCanalNotificacao(i.canal)) return { ok: false, erro: 'preferencia.canal_invalido', mensagem: 'Canal desconhecido.' }
    if (typeof i.ligado !== 'boolean') return { ok: false, erro: 'preferencia.corpo_invalido', mensagem: '"ligado" precisa ser verdadeiro ou falso.' }
    const def = TIPOS_NOTIFICACAO.find((t) => t.codigo === i.tipo)
    if (i.canal === 'email' && !def?.emailDisponivel) {
      return { ok: false, erro: 'preferencia.email_indisponivel', mensagem: 'Este tipo de aviso não tem e-mail.' }
    }
    const chave = `${i.tipo}|${i.canal}`
    if (vistos.has(chave)) return { ok: false, erro: 'preferencia.duplicada', mensagem: 'Preferência repetida.' }
    vistos.add(chave)
    out.push({ tipo: i.tipo, canal: i.canal, ligado: i.ligado })
  }
  return { ok: true, itens: out }
}
