/** Regras puras da tela de Usuários (D3.4). A API é a regra; aqui é conveniência e tradução de erro. */

export const PAPEIS = ['admin', 'gestor', 'supervisor', 'vendedor', 'atendente'] as const
export type Papel = (typeof PAPEIS)[number]

export const ROTULO_PAPEL: Record<Papel, string> = {
  admin: 'Admin', gestor: 'Gestor', supervisor: 'Supervisor', vendedor: 'Vendedor', atendente: 'Atendente',
}

/** Atribuição de papel: `filialId` nulo = todas as filiais. */
export interface PapelAtribuido { readonly papel: Papel; readonly filialId: string | null }
/** Como a lista devolve (com o nome da filial para exibir). */
export interface PapelDoUsuario extends PapelAtribuido { readonly filial: string | null }
/** Linha editável do modal: papel e filial como texto de select ('' = nada / todas). */
export interface LinhaPapel { papel: string; filialId: string }

export interface UsuarioLista {
  readonly id: string
  readonly nome: string
  readonly email: string
  readonly telefone: string | null
  readonly cargo: string | null
  readonly ativo: boolean
  readonly ultimoLoginEm: string | null
  readonly papeis: readonly PapelDoUsuario[]
}

export function ehPapel(v: string): v is Papel { return (PAPEIS as readonly string[]).includes(v) }

export function rotuloDoPapel(papel: string): string {
  return ehPapel(papel) ? ROTULO_PAPEL[papel] : papel
}

/** "Gestor · Fortaleza" ou, sem filial, "Gestor · Todas as filiais". */
export function rotuloDaAtribuicao(p: { papel: string; filial: string | null }): string {
  return `${rotuloDoPapel(p.papel)} · ${p.filial ?? 'Todas as filiais'}`
}

const chaveDoPar = (l: LinhaPapel): string => `${l.papel}|${l.filialId}`

/** Pares papel/filial repetidos (a segunda ocorrência em diante). Linhas sem papel são ignoradas. */
export function indicesDuplicados(linhas: readonly LinhaPapel[]): number[] {
  const vistos = new Set<string>()
  const dup: number[] = []
  linhas.forEach((l, i) => {
    if (!l.papel) return
    const k = chaveDoPar(l)
    if (vistos.has(k)) dup.push(i)
    else vistos.add(k)
  })
  return dup
}

export function temDuplicata(linhas: readonly LinhaPapel[]): boolean { return indicesDuplicados(linhas).length > 0 }

/** Linhas do modal a partir do que a lista devolveu. */
export function linhasDosPapeis(papeis: readonly PapelAtribuido[]): LinhaPapel[] {
  return papeis.map((p) => ({ papel: p.papel, filialId: p.filialId ?? '' }))
}

/** Payload de papéis: descarta linhas sem papel e repetidas; '' vira `null` (todas as filiais). */
export function montarPapeis(linhas: readonly LinhaPapel[]): PapelAtribuido[] {
  const saida: PapelAtribuido[] = []
  const vistos = new Set<string>()
  for (const l of linhas) {
    if (!ehPapel(l.papel)) continue
    const k = chaveDoPar(l)
    if (vistos.has(k)) continue
    vistos.add(k)
    saida.push({ papel: l.papel, filialId: l.filialId === '' ? null : l.filialId })
  }
  return saida
}

/** Estado de uma lista de cadastro (usuários e filiais) quando a API recusa a leitura. */
export type EstadoFalhaLista = 'sem_admin' | 'sem_permissao' | 'erro'

/** Texto da tela de empresa sem admin atribuído (igual em usuários e filiais). */
export const TEXTO_SEM_ADMIN = {
  titulo: 'Sua empresa ainda não tem um administrador',
  descricao: 'Peça à equipe Drezz para nomear o primeiro administrador da sua empresa. Depois disso, ele poderá cadastrar usuários e filiais.',
} as const

/**
 * Decide o estado da lista a partir da falha de leitura. `acesso.admin_atribuido` (403) é a
 * empresa sem admin atribuído; outro 403 é falta de papel; o resto é erro de carga.
 * Puro: `status` é o HTTP (0 quando não há resposta) e `codigo` o `erro` do corpo.
 */
export function estadoDaFalhaDeLista(status: number, codigo: string | null): EstadoFalhaLista {
  if (status !== 403) return 'erro'
  return codigo === 'acesso.admin_atribuido' ? 'sem_admin' : 'sem_permissao'
}

export type CampoUsuario = 'nome' | 'email' | 'telefone' | 'cargo' | 'papeis' | 'senha' | 'ativo'
export interface ErroMapeado { readonly campo: CampoUsuario | null; readonly mensagem: string }

const ERROS_USUARIO: Record<string, ErroMapeado> = {
  'usuario.nome_obrigatorio': { campo: 'nome', mensagem: 'Informe o nome.' },
  'usuario.email_invalido': { campo: 'email', mensagem: 'E-mail inválido.' },
  'usuario.email_duplicado': { campo: 'email', mensagem: 'Já existe um usuário com este e-mail.' },
  // ⚠️ A API não diz DE QUEM é o login existente (outra empresa, suporte): 409 genérico.
  'usuario.email_indisponivel': { campo: 'email', mensagem: 'Não é possível usar este e-mail. Use outro endereço.' },
  'usuario.email_em_uso': { campo: 'email', mensagem: 'Não é possível usar este e-mail. Use outro endereço.' },
  'usuario.papeis_invalidos': { campo: 'papeis', mensagem: 'Papéis inválidos. Revise a lista.' },
  'usuario.papel_invalido': { campo: 'papeis', mensagem: 'Escolha um papel válido em cada linha.' },
  'usuario.papeis_duplicados': { campo: 'papeis', mensagem: 'Há papel repetido para a mesma filial.' },
  'usuario.filial_invalida': { campo: 'papeis', mensagem: 'Uma das filiais escolhidas não existe ou está inativa.' },
  'usuario.senha_invalida': { campo: 'senha', mensagem: 'Senha inválida. Use ao menos 8 caracteres.' },
  'usuario.ultimo_admin': {
    campo: null,
    mensagem: 'Este é o último administrador ativo. Torne outra pessoa admin antes de remover o papel ou desativar.',
  },
  'usuario.nada_a_mudar': { campo: null, mensagem: 'Nada foi alterado.' },
  'usuario.ativo_invalido': { campo: 'ativo', mensagem: 'Situação inválida.' },
  'identidade.login_de_outra_conta': {
    campo: null,
    mensagem: 'O login deste usuário não pertence a esta empresa. Nada foi alterado; fale com o suporte.',
  },
  'identidade.indisponivel': {
    campo: null,
    mensagem: 'O provedor de login está indisponível agora. Nada foi salvo; tente de novo em instantes.',
  },
}

/** Código tipificado da API → campo do modal + frase. `null` quando o código não é conhecido. */
export function mapearErroUsuario(codigo: string | null): ErroMapeado | null {
  return codigo ? (ERROS_USUARIO[codigo] ?? null) : null
}

export function adicionarLinha(linhas: readonly LinhaPapel[]): LinhaPapel[] {
  return [...linhas, { papel: '', filialId: '' }]
}

export function ultimoLoginTexto(iso: string | null): string {
  if (!iso) return 'Nunca'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const SENHA_MIN = 8
export function erroDaSenha(s: string, obrigatoria: boolean): string | null {
  if (!s) return obrigatoria ? 'Informe a senha temporária.' : null
  return s.length < SENHA_MIN ? `Use ao menos ${SENHA_MIN} caracteres.` : null
}

export function erroDoNome(n: string): string | null { return n.trim() ? null : 'Informe o nome.' }
export function erroDoEmail(e: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) ? null : 'Informe um e-mail válido.'
}
