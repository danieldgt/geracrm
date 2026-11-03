import { randomUUID } from 'node:crypto'
import type {
  AlvoIdentidade, DadosNovoUsuario, ProvedorIdentidade, ResultadoCriacao, ResultadoOperacao,
} from './provedor-identidade.js'

/** Um login no provedor falso — modela o que o Cognito guarda e importa à regra. */
export interface LoginFalso {
  sub: string
  tenantId: string
  grupos: string[]
  ativo: boolean
  senhaTemporaria: string | null
}

/**
 * Adaptador FALSO da porta `ProvedorIdentidade` — o dos testes. Guarda os
 * usuários em memória (por e-mail, como o pool) e registra cada chamada, para o
 * teste conferir o que foi pedido ao provedor sem tocar a AWS.
 *
 * ⚠️ Modela as MESMAS travas do adaptador Cognito: localiza pelo `sub`, recusa
 *    (`recusado`, sem operar) login de outro tenant ou do grupo `staff`.
 *
 * `indisponivel = true` simula o provedor sem configuração.
 */
export class ProvedorIdentidadeFalso implements ProvedorIdentidade {
  readonly usuarios = new Map<string, LoginFalso>()
  /** Cada pedido; `operou` = a operação foi de fato aplicada ao login. */
  readonly chamadas: { op: string; email: string; operou?: boolean }[] = []
  indisponivel = false

  /** Semeia um login existente (outro tenant, staff…) sem passar pela criação. */
  semear(email: string, l: { tenantId: string; grupos?: string[]; sub?: string }): LoginFalso {
    const login: LoginFalso = { sub: l.sub ?? randomUUID(), tenantId: l.tenantId, grupos: l.grupos ?? [], ativo: true, senhaTemporaria: null }
    this.usuarios.set(email.trim().toLowerCase(), login)
    return login
  }

  async criarUsuario(dados: DadosNovoUsuario): Promise<ResultadoCriacao> {
    const email = dados.email.trim().toLowerCase()
    this.chamadas.push({ op: 'criar', email })
    if (this.indisponivel) return { tipo: 'indisponivel' }
    if (this.usuarios.has(email)) return { tipo: 'email_em_uso' }
    const sub = randomUUID()
    this.usuarios.set(email, { sub, tenantId: dados.tenantId, grupos: [], ativo: true, senhaTemporaria: dados.senhaTemporaria ?? null })
    return { tipo: 'ok', sub }
  }

  private mudar(op: string, alvo: AlvoIdentidade, f: (u: LoginFalso) => void): ResultadoOperacao {
    const achado = [...this.usuarios.entries()].find(([, u]) => u.sub === alvo.sub)
    const registro: { op: string; email: string; operou?: boolean } = { op, email: achado?.[0] ?? `sub:${alvo.sub}`, operou: false }
    this.chamadas.push(registro)
    if (this.indisponivel) return { tipo: 'indisponivel' }
    if (!achado) return { tipo: 'nao_encontrado' }
    const [, u] = achado
    if (u.tenantId !== alvo.tenantId || u.grupos.includes('staff')) return { tipo: 'recusado' }
    f(u)
    registro.operou = true
    return { tipo: 'ok' }
  }

  async desativar(alvo: AlvoIdentidade): Promise<ResultadoOperacao> {
    return this.mudar('desativar', alvo, (u) => { u.ativo = false })
  }

  async reativar(alvo: AlvoIdentidade): Promise<ResultadoOperacao> {
    return this.mudar('reativar', alvo, (u) => { u.ativo = true })
  }

  async redefinirSenha(alvo: AlvoIdentidade, senhaTemporaria: string): Promise<ResultadoOperacao> {
    return this.mudar('redefinir_senha', alvo, (u) => { u.senhaTemporaria = senhaTemporaria })
  }
}
