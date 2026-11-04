import { telefoneValido } from '@geracrm/shared'

// Regras PURAS do Meu perfil (vitest em node: nada de Angular aqui). O cliente valida por conveniência;
// quem decide é a API, e o 422 por campo volta para o campo.

export interface PerfilLido {
  readonly id: string
  readonly nome: string
  readonly email: string
  readonly telefone: string | null
  readonly cargo: string | null
  readonly fotoUrl: string | null
  readonly fotoDisponivel: boolean
  readonly ultimoLoginEm: string | null
}

export interface PerfilForm { readonly nome: string; readonly telefone: string; readonly cargo: string }
export type ErrosForm = Readonly<Record<string, string>>

export const formDoPerfil = (p: Pick<PerfilLido, 'nome' | 'telefone' | 'cargo'>): PerfilForm =>
  ({ nome: p.nome, telefone: p.telefone ?? '', cargo: p.cargo ?? '' })

/** A máscara é só da tela: a API recebe (e grava) DÍGITOS. */
export function corpoDoPerfil(f: PerfilForm): { nome: string; telefone: string | null; cargo: string | null } {
  const digitos = f.telefone.replace(/\D/g, '')
  return { nome: f.nome.trim(), telefone: digitos === '' ? null : digitos, cargo: f.cargo.trim() === '' ? null : f.cargo.trim() }
}

export function errosDoPerfil(f: PerfilForm): ErrosForm {
  const e: Record<string, string> = {}
  if (!f.nome.trim()) e['nome'] = 'Informe o seu nome.'
  else if (f.nome.trim().length > 120) e['nome'] = 'O nome tem no máximo 120 caracteres.'
  if (f.telefone.replace(/\D/g, '') !== '' && !telefoneValido(f.telefone)) e['telefone'] = 'Telefone inválido. Use DDD + número.'
  if (f.cargo.trim().length > 80) e['cargo'] = 'O cargo tem no máximo 80 caracteres.'
  return e
}

/**
 * 422 por campo da API → mapa campo → mensagem (ou null se o erro não é por campo). Recebe o CORPO do
 * erro (`corpoDoErro(e)`): esta função fica livre de Angular para o teste rodar em node.
 */
export function camposDoCorpo(corpo: { readonly campos?: unknown } | null | undefined): ErrosForm | null {
  const campos = corpo?.campos
  if (!campos || typeof campos !== 'object' || Array.isArray(campos) || Object.keys(campos).length === 0) return null
  return campos as ErrosForm
}

export const mudouOPerfil = (original: PerfilForm, atual: PerfilForm): boolean =>
  original.nome.trim() !== atual.nome.trim()
  || original.telefone.replace(/\D/g, '') !== atual.telefone.replace(/\D/g, '')
  || original.cargo.trim() !== atual.cargo.trim()

// ── Foto ─────────────────────────────────────────────────────────────────────

export const FOTO_TIPOS = ['image/jpeg', 'image/png', 'image/webp'] as const
export const FOTO_MAX_BYTES = 2 * 1024 * 1024

/** Mensagem de recusa, ou null se a foto pode subir. (A API confere o CONTEÚDO de novo.) */
export function erroDaFoto(arquivo: { readonly type: string; readonly size: number }): string | null {
  if (!(FOTO_TIPOS as readonly string[]).includes(arquivo.type)) return 'Use uma imagem JPG, PNG ou WebP.'
  if (arquivo.size > FOTO_MAX_BYTES) return 'A foto passa de 2 MB.'
  if (arquivo.size === 0) return 'O arquivo está vazio.'
  return null
}

/** Iniciais para o avatar quando não há foto: primeira e última palavra do nome. */
export function iniciaisDe(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return '?'
  const primeira = partes[0]!.charAt(0)
  const ultima = partes.length > 1 ? partes[partes.length - 1]!.charAt(0) : ''
  return (primeira + ultima).toUpperCase()
}

// ── Trocar senha ─────────────────────────────────────────────────────────────

export const SENHA_MIN = 8

export interface SenhaForm { readonly atual: string; readonly nova: string; readonly confirmacao: string }

export function errosDaSenha(f: SenhaForm): ErrosForm {
  const e: Record<string, string> = {}
  if (!f.atual) e['senhaAtual'] = 'Informe a senha atual.'
  if (f.nova.length < SENHA_MIN) e['novaSenha'] = `A nova senha precisa de pelo menos ${SENHA_MIN} caracteres.`
  else if (f.nova === f.atual) e['novaSenha'] = 'A nova senha precisa ser diferente da atual.'
  if (f.confirmacao !== f.nova) e['confirmacao'] = 'A confirmação não é igual à nova senha.'
  return e
}
