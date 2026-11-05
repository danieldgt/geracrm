/**
 * Onde a sessão mora: "Lembrar-me" ligado = localStorage (sobrevive ao fechar o navegador); desligado =
 * sessionStorage (morre com a aba). Pura e com os storages injetados — o teste roda em node.
 *
 * ⚠️ Leitura procura nos DOIS (o que está em sessionStorage ganha: foi o login mais recente), escrita vai
 * para UM só e limpa o outro — nunca sobra um refresh token esquecido no localStorage de quem pediu para
 * NÃO ser lembrado.
 */
export interface StorageMinimo {
  getItem(chave: string): string | null
  setItem(chave: string, valor: string): void
  removeItem(chave: string): void
}

export interface ArmazenamentoDeSessao {
  ler(chave: string): string | null
  /** Grava no lugar certo e remove do outro. */
  gravar(chave: string, valor: string, lembrar: boolean): void
  remover(chave: string): void
  /** A sessão atual está no localStorage? (o refresh grava onde a sessão já mora) */
  lembrando(chaveReferencia: string): boolean
}

export function criarArmazenamento(local: StorageMinimo, sessao: StorageMinimo): ArmazenamentoDeSessao {
  return {
    ler: (chave) => sessao.getItem(chave) ?? local.getItem(chave),
    gravar(chave, valor, lembrar) {
      const [destino, outro] = lembrar ? [local, sessao] : [sessao, local]
      destino.setItem(chave, valor)
      outro.removeItem(chave)
    },
    remover(chave) { local.removeItem(chave); sessao.removeItem(chave) },
    lembrando: (chaveReferencia) => sessao.getItem(chaveReferencia) === null,
  }
}

export interface SessaoStaffGuardada { readonly token: string; readonly clienteNome: string }

/**
 * Lê a sessão de acesso do staff. ⚠️ Sessão de staff SEM login por baixo é herança de outra pessoa (ficou no
 * navegador de um login anterior): com `exigeLogin` e sem token, é DESCARTADA do storage em vez de lida.
 * Storage corrompido não derruba o boot.
 */
export function lerSessaoStaffGuardada(
  armazem: ArmazenamentoDeSessao, chave: string, temLogin: boolean, exigeLogin: boolean,
): SessaoStaffGuardada | null {
  if (exigeLogin && !temLogin) { armazem.remover(chave); return null }
  try {
    const cru = armazem.ler(chave)
    return cru ? (JSON.parse(cru) as SessaoStaffGuardada) : null
  } catch { return null }
}
