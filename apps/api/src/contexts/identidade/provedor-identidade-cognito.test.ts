import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import {
  AdminDisableUserCommand, AdminEnableUserCommand, AdminListGroupsForUserCommand, AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient, ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { provedorIdentidadeCognito } from './provedor-identidade-cognito.js'

/**
 * Adaptador Cognito (revisão de segurança D3, C1b) — SEM AWS: o `send` do SDK é
 * substituído por um pool em memória. O que se prova: o login é localizado pelo
 * SUB (nunca pelo e-mail) e, antes de qualquer Admin*, o adaptador confere que
 * o `custom:tenant_id` é o da requisição e que o login NÃO é do grupo staff —
 * senão responde `recusado` sem chamar a operação.
 */
const T = 'c0900000-0000-4000-8000-00000000000a'
const OUTRO = 'c0900000-0000-4000-8000-00000000000b'
const SUB = {
  meu: 'c0900000-1111-4000-8000-000000000001',
  alheio: 'c0900000-1111-4000-8000-000000000002',
  staff: 'c0900000-1111-4000-8000-000000000003',
}
const POOL: Record<string, { username: string; tenant: string; grupos: string[] }> = {
  [SUB.meu]: { username: 'meu@t.test', tenant: T, grupos: [] },
  [SUB.alheio]: { username: 'alheio@o.test', tenant: OUTRO, grupos: [] },
  [SUB.staff]: { username: 'staff@drezz.test', tenant: T, grupos: ['staff'] },
}

const ADMIN_OPS = [AdminSetUserPasswordCommand, AdminDisableUserCommand, AdminEnableUserCommand]
let enviados: unknown[] = []

beforeAll(() => {
  process.env.COGNITO_USER_POOL_ID = 'us-east-1_teste'
  process.env.AWS_ACCESS_KEY_ID = 'AKIA-teste'
  process.env.AWS_SECRET_ACCESS_KEY = 'segredo-teste'
  vi.spyOn(CognitoIdentityProviderClient.prototype, 'send').mockImplementation((async (cmd: unknown) => {
    enviados.push(cmd)
    if (cmd instanceof ListUsersCommand) {
      const sub = /sub = "([^"]+)"/.exec(cmd.input.Filter ?? '')?.[1] ?? ''
      const u = POOL[sub]
      return { Users: u ? [{ Username: u.username, Attributes: [{ Name: 'sub', Value: sub }, { Name: 'custom:tenant_id', Value: u.tenant }] }] : [] }
    }
    if (cmd instanceof AdminListGroupsForUserCommand) {
      const u = Object.values(POOL).find((p) => p.username === cmd.input.Username)
      return { Groups: (u?.grupos ?? []).map((g) => ({ GroupName: g })) }
    }
    return {}
  }) as never)
})

afterEach(() => { enviados = [] })
afterAll(() => {
  vi.restoreAllMocks()
  delete process.env.COGNITO_USER_POOL_ID
  delete process.env.AWS_ACCESS_KEY_ID
  delete process.env.AWS_SECRET_ACCESS_KEY
})

const opsAdmin = () => enviados.filter((c) => ADMIN_OPS.some((k) => c instanceof k)) as { input: { Username?: string } }[]

describe('provedor Cognito: operar só sobre login do MESMO tenant e fora do staff', () => {
  it('login do tenant: localiza pelo sub e opera com o Username do pool (não com e-mail de fora)', async () => {
    const p = provedorIdentidadeCognito()
    expect((await p.redefinirSenha({ sub: SUB.meu, tenantId: T }, 'Temp#2026x')).tipo).toBe('ok')
    expect((await p.desativar({ sub: SUB.meu, tenantId: T })).tipo).toBe('ok')
    expect((await p.reativar({ sub: SUB.meu, tenantId: T })).tipo).toBe('ok')
    expect(opsAdmin().map((c) => c.input.Username)).toEqual(['meu@t.test', 'meu@t.test', 'meu@t.test'])
  })

  it('login de OUTRO tenant → recusado, nenhuma operação administrativa enviada', async () => {
    const p = provedorIdentidadeCognito()
    expect((await p.redefinirSenha({ sub: SUB.alheio, tenantId: T }, 'Temp#2026x')).tipo).toBe('recusado')
    expect((await p.desativar({ sub: SUB.alheio, tenantId: T })).tipo).toBe('recusado')
    expect(opsAdmin()).toEqual([])
  })

  it('login do grupo staff (mesmo com tenant igual) → recusado, nenhuma operação enviada', async () => {
    const p = provedorIdentidadeCognito()
    expect((await p.redefinirSenha({ sub: SUB.staff, tenantId: T }, 'Temp#2026x')).tipo).toBe('recusado')
    expect((await p.reativar({ sub: SUB.staff, tenantId: T })).tipo).toBe('recusado')
    expect(opsAdmin()).toEqual([])
  })

  it('sub inexistente ou malformado → nao_encontrado (o malformado nem consulta)', async () => {
    const p = provedorIdentidadeCognito()
    expect((await p.desativar({ sub: 'c0900000-1111-4000-8000-0000000000ff', tenantId: T })).tipo).toBe('nao_encontrado')
    expect((await p.desativar({ sub: 'x" or sub = "y', tenantId: T })).tipo).toBe('nao_encontrado')
    expect(enviados.filter((c) => c instanceof ListUsersCommand)).toHaveLength(1)
    expect(opsAdmin()).toEqual([])
  })
})
