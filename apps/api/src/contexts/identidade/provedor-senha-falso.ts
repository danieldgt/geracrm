import type {
  ProvedorSenha, ResultadoEsqueciSenha, ResultadoRedefinicao, ResultadoTrocaSenha,
} from './provedor-senha.js'

/**
 * Adaptador FALSO da porta `ProvedorSenha` — o dos testes. Guarda senhas e códigos em memória (por
 * e-mail minúsculo) e registra cada chamada. Política de senha: mínimo de 8 caracteres.
 *
 * ⚠️ `esqueciSenha` responde `ok` para e-mail que não existe, e só EXISTENTE ganha código — o teste
 * confere que as duas respostas são idênticas.
 */
export class ProvedorSenhaFalso implements ProvedorSenha {
  readonly senhas = new Map<string, string>()
  readonly codigos = new Map<string, { codigo: string; expirado: boolean }>()
  readonly chamadas: { op: string; email: string }[] = []
  readonly revogados: string[] = []
  readonly sessoesEncerradas: string[] = []
  indisponivel = false
  limite = false
  /** Simula a conta presa num desafio (senha temporária). */
  desafio = false

  semear(email: string, senha: string): void { this.senhas.set(email.trim().toLowerCase(), senha) }

  async trocarSenha(emailBruto: string, senhaAtual: string, novaSenha: string): Promise<ResultadoTrocaSenha> {
    const email = emailBruto.trim().toLowerCase()
    this.chamadas.push({ op: 'trocar', email })
    if (this.indisponivel) return { tipo: 'indisponivel' }
    if (this.limite) return { tipo: 'limite' }
    if (this.desafio) return { tipo: 'desafio' }
    if (this.senhas.get(email) !== senhaAtual) return { tipo: 'senha_atual_errada' }
    if (novaSenha.length < 8) return { tipo: 'senha_invalida', mensagem: 'A senha precisa de pelo menos 8 caracteres.' }
    this.senhas.set(email, novaSenha)
    this.sessoesEncerradas.push(email) // GlobalSignOut depois da troca
    return { tipo: 'ok' }
  }

  async esqueciSenha(emailBruto: string): Promise<ResultadoEsqueciSenha> {
    const email = emailBruto.trim().toLowerCase()
    this.chamadas.push({ op: 'esqueci', email })
    if (this.indisponivel) return { tipo: 'indisponivel' }
    if (this.senhas.has(email)) this.codigos.set(email, { codigo: '123456', expirado: false })
    return { tipo: 'ok' }
  }

  async confirmarEsqueciSenha(emailBruto: string, codigo: string, novaSenha: string): Promise<ResultadoRedefinicao> {
    const email = emailBruto.trim().toLowerCase()
    this.chamadas.push({ op: 'confirmar', email })
    if (this.indisponivel) return { tipo: 'indisponivel' }
    if (this.limite) return { tipo: 'codigo_invalido' } // o limite do provedor não é oráculo
    const c = this.codigos.get(email)
    if (!c || c.codigo !== codigo) return { tipo: 'codigo_invalido' }
    if (c.expirado) return { tipo: 'codigo_expirado' }
    if (novaSenha.length < 8) return { tipo: 'senha_invalida', mensagem: 'A senha precisa de pelo menos 8 caracteres.' }
    this.senhas.set(email, novaSenha)
    this.codigos.delete(email)
    return { tipo: 'ok' }
  }

  async revogarSessao(refreshToken: string): Promise<void> { this.revogados.push(refreshToken) }
}
