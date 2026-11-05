import { TIPOS_NOTIFICACAO, type CanalNotificacao } from '@geracrm/shared'
import { queryDeLista } from '../compartilhado/ui/cursor.js'

// Regras PURAS da página Notificações e das preferências (vitest em node: nada de Angular aqui).

export interface NotificacaoItem {
  readonly id: string
  readonly tipo: string
  readonly titulo: string
  readonly conversaId: string | null
  readonly lida: boolean
  readonly criadoEm: string
}

/** `lida`: '' = todas; 'nao' = só não lidas; 'sim' = só lidas (os mesmos valores da API). */
export interface FiltroNotificacao {
  readonly lida: '' | 'nao' | 'sim'
  readonly tipo: string
}

export const FILTRO_NOTIFICACAO_VAZIO: FiltroNotificacao = { lida: '', tipo: '' }

export const OPCOES_LIDA: readonly { readonly valor: string; readonly rotulo: string }[] = [
  { valor: 'nao', rotulo: 'Não lidas' },
  { valor: 'sim', rotulo: 'Lidas' },
]

export const OPCOES_TIPO: readonly { readonly valor: string; readonly rotulo: string }[] =
  TIPOS_NOTIFICACAO.map((t) => ({ valor: t.codigo, rotulo: t.rotulo }))

export const filtroNotificacaoAtivo = (f: FiltroNotificacao): boolean => f.lida !== '' || f.tipo !== ''

/** Query da lista: filtros vão para o servidor; a tela nunca filtra linha em memória. */
export function queryDeNotificacoes(f: FiltroNotificacao, cursor?: string | null): string {
  return queryDeLista({ lida: f.lida, tipo: f.tipo, cursor })
}

export function rotuloDoTipo(tipo: string): string {
  return TIPOS_NOTIFICACAO.find((t) => t.codigo === tipo)?.rotulo ?? 'Aviso'
}

/** O texto da linha: mensagem nova diz DE QUEM; o resto já vem com a frase pronta do servidor. */
export function tituloDaNotificacao(n: Pick<NotificacaoItem, 'tipo' | 'titulo'>): string {
  return n.tipo === 'mensagem.nova' ? `Nova mensagem de ${n.titulo}` : n.titulo
}

export type AlvoNotificacao =
  | { readonly tipo: 'conversa'; readonly conversaId: string }
  | { readonly tipo: 'rota'; readonly rota: string }
  | { readonly tipo: 'nenhum' }

const ROTA_POR_TIPO: Readonly<Record<string, string>> = {
  'agenda.lembrete': '/agenda-e-tarefas/calendario',
  'canal.qualidade': '/config/numeros',
  'agente.orcamento': '/config/faturamento',
}

/** "Abrir leva ao alvo": a conversa (no chat) quando há; senão a tela do assunto; senão fica onde está. */
export function alvoDaNotificacao(n: Pick<NotificacaoItem, 'tipo' | 'conversaId'>): AlvoNotificacao {
  if (n.conversaId) return { tipo: 'conversa', conversaId: n.conversaId }
  const rota = ROTA_POR_TIPO[n.tipo]
  return rota ? { tipo: 'rota', rota } : { tipo: 'nenhum' }
}

// ── Preferências (matriz tipo × canal) ───────────────────────────────────────

export interface PreferenciaTipo {
  readonly tipo: string
  readonly rotulo: string
  readonly emailDisponivel: boolean
  readonly canais: Readonly<Record<CanalNotificacao, boolean>>
}

export interface ItemPreferencia { readonly tipo: string; readonly canal: CanalNotificacao; readonly ligado: boolean }

/** Liga/desliga UM canal de UM tipo, sem mexer nos outros. */
export function alterarCanal(
  tipos: readonly PreferenciaTipo[], tipo: string, canal: CanalNotificacao, ligado: boolean,
): PreferenciaTipo[] {
  return tipos.map((t) => (t.tipo === tipo ? { ...t, canais: { ...t.canais, [canal]: ligado } } : t))
}

/** O que mudou em relação ao que o servidor tem — é só isso que vai no PUT. */
export function preferenciasAlteradas(
  original: readonly PreferenciaTipo[], atual: readonly PreferenciaTipo[],
): ItemPreferencia[] {
  const saida: ItemPreferencia[] = []
  for (const t of atual) {
    const antes = original.find((o) => o.tipo === t.tipo)
    if (!antes) continue
    for (const canal of ['app', 'push', 'email'] as const) {
      if (canal === 'email' && !t.emailDisponivel) continue
      if (antes.canais[canal] !== t.canais[canal]) saida.push({ tipo: t.tipo, canal, ligado: t.canais[canal] })
    }
  }
  return saida
}
