import type { AvisoPrivacidadeExibido, PaginaAvisosPrivacidade } from '@geracrm/shared'
import { mesclarPagina } from '../../compartilhado/ui/cursor.js'

/**
 * OS CINCO ESTADOS da lista "Avisos de privacidade" da ficha do contato —
 * máquina pura (sem Angular), para o componente só apresentar.
 *
 *   carregando    → esqueleto com a forma da lista
 *   vazio         → explica: o aviso aparece aqui quando a abertura do agente sai
 *   erro          → diz o que falhou e oferece "Tentar de novo"
 *   sem_permissao → o bloco NÃO aparece (não é erro)
 *   pronto        → lista + "Carregar mais" por cursor; falha no "mais" é
 *                   PARCIAL: aviso localizado, a lista já carregada fica
 */
export type EstadoAvisos =
  | { readonly tipo: 'carregando' }
  | { readonly tipo: 'vazio' }
  | { readonly tipo: 'erro'; readonly mensagem: string }
  | { readonly tipo: 'sem_permissao' }
  | {
    readonly tipo: 'pronto'
    readonly itens: readonly AvisoPrivacidadeExibido[]
    readonly proximoCursor: string | null
    readonly carregandoMais: boolean
    /** Falha ao carregar a página seguinte (estado parcial). */
    readonly erroMais: string | null
  }

export const CARREGANDO: EstadoAvisos = { tipo: 'carregando' }

/** A primeira página chegou. Vazio é ramo próprio — não `itens.length === 0` no template. */
export function primeiraPagina(p: PaginaAvisosPrivacidade): EstadoAvisos {
  if (p.itens.length === 0) return { tipo: 'vazio' }
  return { tipo: 'pronto', itens: p.itens, proximoCursor: p.proximoCursor, carregandoMais: false, erroMais: null }
}

/** A primeira página falhou: 403 some com o bloco; o resto é erro nomeado. */
export function falhaNaPrimeira(status: number): EstadoAvisos {
  if (status === 403) return { tipo: 'sem_permissao' }
  return {
    tipo: 'erro',
    mensagem: status === 0
      ? 'Sem conexão com o servidor. Confira a rede e tente de novo.'
      : 'Não foi possível carregar os avisos de privacidade deste contato.',
  }
}

/** Pediu a página seguinte. Fora de `pronto` (ou sem cursor), não muda nada. */
export function pedirMais(e: EstadoAvisos): EstadoAvisos {
  if (e.tipo !== 'pronto' || !e.proximoCursor || e.carregandoMais) return e
  return { ...e, carregandoMais: true, erroMais: null }
}

/** A página seguinte chegou: mescla sem duplicar (a lista pode andar entre páginas). */
export function maisChegou(e: EstadoAvisos, p: PaginaAvisosPrivacidade): EstadoAvisos {
  if (e.tipo !== 'pronto') return e
  return {
    ...e, itens: mesclarPagina(e.itens, p.itens, (a) => a.id), proximoCursor: p.proximoCursor, carregandoMais: false, erroMais: null,
  }
}

/** A página seguinte falhou: PARCIAL — o que já está na tela fica, com aviso localizado. */
export function maisFalhou(e: EstadoAvisos): EstadoAvisos {
  if (e.tipo !== 'pronto') return e
  return { ...e, carregandoMais: false, erroMais: 'Não foi possível carregar mais avisos. Tente de novo.' }
}

/** "agente" → "Abertura do agente"; "humano" → "Enviado por pessoa da equipe". */
export function rotuloOrigem(o: AvisoPrivacidadeExibido['origem']): string {
  return o === 'agente' ? 'Abertura do agente' : 'Enviado pela equipe'
}
