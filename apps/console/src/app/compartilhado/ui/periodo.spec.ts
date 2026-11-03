import { describe, it, expect } from 'vitest'
import { periodoDoAtalho, atalhoAtivo, ATALHOS_PERIODO } from './periodo.js'

describe('periodoDoAtalho', () => {
  it('hoje: início e fim iguais', () => {
    expect(periodoDoAtalho('hoje', '2026-11-03')).toEqual({ inicio: '2026-11-03', fim: '2026-11-03' })
  })
  it('7 dias inclui hoje (hoje menos 6)', () => {
    expect(periodoDoAtalho('7dias', '2026-11-03')).toEqual({ inicio: '2026-10-28', fim: '2026-11-03' })
  })
  it('30 dias atravessa a virada do ano', () => {
    expect(periodoDoAtalho('30dias', '2026-01-10')).toEqual({ inicio: '2025-12-12', fim: '2026-01-10' })
  })
  it('7 dias em março de ano bissexto passa por 29 de fevereiro', () => {
    expect(periodoDoAtalho('7dias', '2028-03-03')).toEqual({ inicio: '2028-02-26', fim: '2028-03-03' })
  })
  it('mês atual vai do dia 1 ao último dia do mês (não a hoje)', () => {
    expect(periodoDoAtalho('mesAtual', '2026-11-03')).toEqual({ inicio: '2026-11-01', fim: '2026-11-30' })
  })
  it('mês atual de fevereiro: 28 em ano comum, 29 em bissexto', () => {
    expect(periodoDoAtalho('mesAtual', '2027-02-15').fim).toBe('2027-02-28')
    expect(periodoDoAtalho('mesAtual', '2028-02-15').fim).toBe('2028-02-29')
  })
  it('mês atual de dezembro termina em 31', () => {
    expect(periodoDoAtalho('mesAtual', '2026-12-31')).toEqual({ inicio: '2026-12-01', fim: '2026-12-31' })
  })
  it('mês passado em janeiro volta a dezembro do ano anterior', () => {
    expect(periodoDoAtalho('mesPassado', '2026-01-15')).toEqual({ inicio: '2025-12-01', fim: '2025-12-31' })
  })
  it('mês passado em março depois de fevereiro bissexto', () => {
    expect(periodoDoAtalho('mesPassado', '2028-03-31')).toEqual({ inicio: '2028-02-01', fim: '2028-02-29' })
  })
  it('mês passado de um mês de 31 dias para um de 30', () => {
    expect(periodoDoAtalho('mesPassado', '2026-12-31')).toEqual({ inicio: '2026-11-01', fim: '2026-11-30' })
  })
  it('atalhoAtivo reconhece o intervalo vigente e devolve null para intervalo livre', () => {
    const hoje = '2026-11-03'
    const p = periodoDoAtalho('mesAtual', hoje)
    expect(atalhoAtivo(p.inicio, p.fim, hoje)).toBe('mesAtual')
    expect(atalhoAtivo('2026-11-02', '2026-11-03', hoje)).toBeNull()
  })
  it('expõe os cinco atalhos na ordem da tela', () => {
    expect(ATALHOS_PERIODO.map((a) => a.chave)).toEqual(['hoje', '7dias', '30dias', 'mesAtual', 'mesPassado'])
  })
})
