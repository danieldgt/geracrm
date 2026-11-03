import { describe, it, expect } from 'vitest'
import { decidirEscopo, type FatosDeAcesso } from './escopo.js'

/**
 * ESCOPO — a decisão PURA (sem banco). As rotas, com o banco e dois tenants,
 * ficam em `escopo-rotas.test.ts`.
 */
const U = '0d300000-0000-4000-8000-000000000001'
const FX = '0d300000-1111-4000-8000-000000000001'
const FY = '0d300000-1111-4000-8000-000000000002'

const base: FatosDeAcesso = { staff: false, usuarioId: U, usuarioAtivo: true, tenantTemAdminAtivo: true, vinculos: [] }
const com = (vinculos: FatosDeAcesso['vinculos'], extra: Partial<FatosDeAcesso> = {}) => decidirEscopo({ ...base, vinculos, ...extra })

describe('decidirEscopo — quem vê o quê', () => {
  it('admin em qualquer filial vê tudo', () => {
    expect(com([{ papel: 'admin', filialId: null }])).toEqual({ tipo: 'tudo' })
    expect(com([{ papel: 'admin', filialId: FX }])).toEqual({ tipo: 'tudo' })
    expect(com([{ papel: 'vendedor', filialId: FY }, { papel: 'admin', filialId: FX }])).toEqual({ tipo: 'tudo' })
  })

  it('gestor/supervisor com filial NULL (todas) vê tudo', () => {
    expect(com([{ papel: 'gestor', filialId: null }])).toEqual({ tipo: 'tudo' })
    expect(com([{ papel: 'supervisor', filialId: null }])).toEqual({ tipo: 'tudo' })
  })

  it('gestor/supervisor com filiais vê a UNIÃO delas (e leva o próprio id)', () => {
    expect(com([{ papel: 'gestor', filialId: FX }])).toEqual({ tipo: 'filial', filialIds: [FX], usuarioId: U })
    expect(com([{ papel: 'supervisor', filialId: FY }, { papel: 'gestor', filialId: FX }]))
      .toEqual({ tipo: 'filial', filialIds: [FX, FY].sort(), usuarioId: U })
  })

  it('gestor numa filial e vendedor noutra → filial só da gestão (vendedor não amplia)', () => {
    expect(com([{ papel: 'gestor', filialId: FX }, { papel: 'vendedor', filialId: FY }]))
      .toEqual({ tipo: 'filial', filialIds: [FX], usuarioId: U })
  })

  it('só vendedor/atendente → carteira do próprio', () => {
    expect(com([{ papel: 'vendedor', filialId: FX }])).toEqual({ tipo: 'carteira', usuarioId: U })
    expect(com([{ papel: 'atendente', filialId: null }])).toEqual({ tipo: 'carteira', usuarioId: U })
    expect(com([{ papel: 'vendedor', filialId: null }])).toEqual({ tipo: 'carteira', usuarioId: U })
  })

  it('sem papel e fora do modo fundador → carteira do próprio, NUNCA tudo', () => {
    expect(com([])).toEqual({ tipo: 'carteira', usuarioId: U })
  })

  it('modo fundador (tenant sem admin ativo) → tudo para quem existe e está ativo', () => {
    expect(com([], { tenantTemAdminAtivo: false })).toEqual({ tipo: 'tudo' })
    expect(com([{ papel: 'vendedor', filialId: FX }], { tenantTemAdminAtivo: false })).toEqual({ tipo: 'tudo' })
  })

  it('usuário inexistente ou inativo → não vê nada (nem no modo fundador)', () => {
    expect(com([{ papel: 'admin', filialId: null }], { usuarioAtivo: false })).toEqual({ tipo: 'carteira', usuarioId: null })
    expect(com([], { usuarioId: null, usuarioAtivo: false, tenantTemAdminAtivo: false })).toEqual({ tipo: 'carteira', usuarioId: null })
  })

  it('sessão de staff → tudo', () => {
    expect(decidirEscopo({ staff: true, usuarioId: null, usuarioAtivo: false, tenantTemAdminAtivo: true, vinculos: [] })).toEqual({ tipo: 'tudo' })
  })

  it('papel desconhecido não concede nada', () => {
    expect(com([{ papel: 'dono-do-mundo', filialId: null }])).toEqual({ tipo: 'carteira', usuarioId: U })
  })
})
