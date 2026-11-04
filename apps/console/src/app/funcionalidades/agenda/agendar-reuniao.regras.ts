import {
  DIAS_MAX_REUNIAO, DURACAO_REUNIAO_PADRAO, DURACOES_REUNIAO_MIN, ERROS_REUNIAO,
  type ModalidadeEvento, type RespostaHorariosLivres, type VendedorParaReuniao,
} from '@geracrm/shared'
import { diaIso, horaLocal } from './agenda.regras.js'

/**
 * Regras puras do botão "Agendar reunião" da conversa (raia C3). Sem DOM — testadas à parte.
 * A regra de negócio (grade, escopo, conflito) é da API; aqui só se apresenta e se monta o corpo.
 */

/** "Ana Lima (responsável)" para o dono da carteira; os demais pelo nome. */
export function rotuloVendedor(v: VendedorParaReuniao): string {
  return v.responsavelDoContato ? `${v.nome} (responsável)` : v.nome
}

export function opcoesVendedores(itens: readonly VendedorParaReuniao[]): { valor: string; rotulo: string }[] {
  return itens.map((v) => ({ valor: v.usuarioId, rotulo: rotuloVendedor(v) }))
}

/** Começa pelo responsável do contato (a API já manda na ordem); lista vazia = ''. */
export const vendedorInicial = (itens: readonly VendedorParaReuniao[]): string => itens[0]?.usuarioId ?? ''

export const OPCOES_DURACAO = DURACOES_REUNIAO_MIN.map((m) => ({
  valor: String(m), rotulo: m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`,
}))
export const DURACAO_INICIAL = String(DURACAO_REUNIAO_PADRAO)

export const OPCOES_MODALIDADE_REUNIAO: { valor: ModalidadeEvento; rotulo: string }[] = [
  { valor: 'online', rotulo: 'Online' }, { valor: 'presencial', rotulo: 'Presencial' },
]

/** Limites do seletor de dia: hoje até `DIAS_MAX_REUNIAO` à frente (o mesmo teto da API). */
export function limitesDoDia(hoje: Date): { min: string; max: string } {
  const max = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + DIAS_MAX_REUNIAO)
  return { min: diaIso(hoje), max: diaIso(max) }
}

export const rotuloHorario = (iso: string): string => horaLocal(new Date(iso))

export type EstadoHorarios = 'ocioso' | 'carregando' | 'erro' | 'fechado' | 'vazio' | 'pronto'

/** O bloco de horários nos estados da tela: sem pessoa escolhida, carregando, erro, dia fechado, sem vaga, pronto. */
export function estadoDosHorarios(p: { carregando: boolean; erro: boolean; resposta: RespostaHorariosLivres | null }): EstadoHorarios {
  if (p.carregando) return 'carregando'
  if (p.erro) return 'erro'
  if (!p.resposta) return 'ocioso'
  if (p.resposta.fechado) return 'fechado'
  return p.resposta.horarios.length === 0 ? 'vazio' : 'pronto'
}

export interface FormReuniao {
  readonly usuarioId: string
  readonly inicio: string | null
  readonly duracao: string
  readonly modalidade: ModalidadeEvento
  readonly link: string
}
export type ErrosReuniao = Partial<Record<'usuarioId' | 'inicio' | 'link', string>>

/** Corpo do `POST /v1/agenda/reunioes` — ou os erros por campo (a API confere de novo). */
export function corpoReuniao(conversaId: string, f: FormReuniao):
  { ok: true; corpo: Record<string, unknown> } | { ok: false; erros: ErrosReuniao } {
  const erros: ErrosReuniao = {}
  if (!f.usuarioId) erros.usuarioId = 'Escolha com quem é a reunião.'
  if (!f.inicio) erros.inicio = 'Escolha um horário livre.'
  const link = f.link.trim()
  if (link && !/^https?:\/\/\S+$/i.test(link)) erros.link = 'O link precisa começar com http:// ou https://.'
  if (Object.keys(erros).length > 0) return { ok: false, erros }
  return {
    ok: true,
    corpo: {
      conversaId, usuarioId: f.usuarioId, inicio: f.inicio, duracaoMin: Number(f.duracao), modalidade: f.modalidade,
      ...(link ? { link } : {}),
    },
  }
}

/** Mensagem da falha do POST — tipificada pelo código da API, nunca o texto cru. */
export function mensagemDaFalha(status: number, codigo: string | null): string {
  if (codigo === ERROS_REUNIAO.horarioOcupado || status === 409) return 'Esse horário acabou de ser ocupado. Escolha outro horário.'
  if (codigo === ERROS_REUNIAO.horarioPassado) return 'Esse horário já passou. Escolha outro.'
  if (codigo === ERROS_REUNIAO.transferenciaProibida) return 'Marcar com outra pessoa passaria o cliente para ela, e só a gestão transfere carteira. Marque com o responsável do cliente.'
  if (codigo === ERROS_REUNIAO.foraDoExpediente) return 'Esse horário está fora do expediente do número. Escolha um horário livre da grade.'
  if (codigo === ERROS_REUNIAO.responsavelProibido || status === 403) return 'Você não pode marcar com essa pessoa. Escolha o responsável do cliente ou você.'
  if (codigo === 'modulo.desligado') return 'A Agenda foi desligada para a sua empresa.'
  if (status === 404) return 'Esta conversa não está mais disponível para você.'
  if (status === 0) return 'Sem conexão. Verifique a internet e tente de novo.'
  return 'Não foi possível marcar a reunião. Tente de novo.'
}

/** Depois destas falhas a grade está velha: recarrega os horários e limpa a escolha. */
export const recarregaHorarios = (status: number, codigo: string | null): boolean =>
  status === 409 || codigo === ERROS_REUNIAO.horarioOcupado || codigo === ERROS_REUNIAO.horarioPassado || codigo === ERROS_REUNIAO.foraDoExpediente

/** Texto do aviso de sucesso — diz quando, com quem e se o responsável mudou. */
export function textoDeSucesso(p: { inicio: string; vendedor: VendedorParaReuniao | undefined; responsavelAlterado: boolean }): string {
  const d = new Date(p.inicio)
  const quando = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} às ${horaLocal(d)}`
  const com = p.vendedor ? ` com ${p.vendedor.nome}` : ''
  const troca = p.responsavelAlterado && p.vendedor ? ` ${p.vendedor.nome} passou a ser o responsável pelo cliente.` : ''
  return `Reunião marcada para ${quando}${com}.${troca}`
}
