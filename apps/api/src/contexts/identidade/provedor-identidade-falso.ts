import { randomUUID } from 'node:crypto'
import type { DadosNovoUsuario, ProvedorIdentidade, ResultadoCriacao, ResultadoOperacao } from './provedor-identidade.js'

/**
 * Adaptador FALSO da porta `ProvedorIdentidade` — o dos testes. Guarda os
 * usuários em memória e registra cada chamada, para o teste conferir o que foi
 * pedido ao provedor sem tocar a AWS.
 *
 * `indisponivel = true` simula o provedor sem configuração.
 */
export class ProvedorIdentidadeFalso implements ProvedorIdentidade {
  readonly usuarios = new Map<string, { sub: string; tenantId: string; ativo: boolean; senhaTemporaria: string | null }>()
  readonly chamadas: { op: string; email: string }[] = []
  indisponivel = false

  async criarUsuario(dados: DadosNovoUsuario): Promise<ResultadoCriacao> {
    const email = dados.email.trim().toLowerCase()
    this.chamadas.push({ op: 'criar', email })
    if (this.indisponivel) return { tipo: 'indisponivel' }
    if (this.usuarios.has(email)) return { tipo: 'email_em_uso' }
    const sub = randomUUID()
    this.usuarios.set(email, { sub, tenantId: dados.tenantId, ativo: true, senhaTemporaria: dados.senhaTemporaria ?? null })
    return { tipo: 'ok', sub }
  }

  private mudar(op: string, email: string, f: (u: { ativo: boolean; senhaTemporaria: string | null }) => void): ResultadoOperacao {
    const chave = email.trim().toLowerCase()
    this.chamadas.push({ op, email: chave })
    if (this.indisponivel) return { tipo: 'indisponivel' }
    const u = this.usuarios.get(chave)
    if (!u) return { tipo: 'nao_encontrado' }
    f(u)
    return { tipo: 'ok' }
  }

  async desativar(email: string): Promise<ResultadoOperacao> {
    return this.mudar('desativar', email, (u) => { u.ativo = false })
  }

  async reativar(email: string): Promise<ResultadoOperacao> {
    return this.mudar('reativar', email, (u) => { u.ativo = true })
  }

  async redefinirSenha(email: string, senhaTemporaria: string): Promise<ResultadoOperacao> {
    return this.mudar('redefinir_senha', email, (u) => { u.senhaTemporaria = senhaTemporaria })
  }
}
