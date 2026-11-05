import { describe, it, expect } from 'vitest'
import { GRUPOS_AGENTE, enderecoDaSecao, gruposVisiveis, precisaConfirmarTroca, secaoDoEndereco, secaoDoGrupo } from './agente-abas.regras.js'

const todas = gruposVisiveis({})

describe('tela do agente — 5 grupos pela tarefa', () => {
  it('são cinco grupos, nesta ordem, cobrindo as dez sub-seções sem repetir', () => {
    expect(GRUPOS_AGENTE.map((g) => g.rotulo)).toEqual(['Configurar', 'Ensinar', 'Testar', 'Acompanhar', 'Qualidade'])
    const subs = GRUPOS_AGENTE.flatMap((g) => g.subs.map((s) => s.id))
    expect(subs).toHaveLength(10)
    expect(new Set(subs).size).toBe(10)
  })

  it('sub-seção de raia não pronta some; grupo sem nada pronto some inteiro', () => {
    const g = gruposVisiveis({ protecoes: false, qualidade: false, revisao: false, metricas: false })
    expect(g.find((x) => x.id === 'configurar')!.subs.map((s) => s.id)).toEqual(['configuracao'])
    expect(g.some((x) => x.id === 'medir')).toBe(false)
  })
})

describe('endereço da seção (?aba=&sub=)', () => {
  it('formato novo: grupo + sub', () => {
    expect(secaoDoEndereco('ensinar', 'playbook', todas)).toEqual({ grupo: 'ensinar', sub: 'playbook' })
  })
  it('grupo sem sub (ou com sub de outro grupo) abre a primeira sub do grupo', () => {
    expect(secaoDoEndereco('acompanhar', null, todas)).toEqual({ grupo: 'acompanhar', sub: 'sessoes' })
    expect(secaoDoEndereco('acompanhar', 'playbook', todas)).toEqual({ grupo: 'acompanhar', sub: 'sessoes' })
  })
  it('formato antigo (?aba=playbook, atalho das Configurações) continua abrindo a sub certa', () => {
    expect(secaoDoEndereco('playbook', null, todas)).toEqual({ grupo: 'ensinar', sub: 'playbook' })
    expect(secaoDoEndereco('decisoes', null, todas)).toEqual({ grupo: 'acompanhar', sub: 'decisoes' })
  })
  it('desconhecido, vazio ou não pronto cai na primeira seção', () => {
    expect(secaoDoEndereco(null, null, todas)).toEqual({ grupo: 'configurar', sub: 'configuracao' })
    expect(secaoDoEndereco('xyz', null, todas)).toEqual({ grupo: 'configurar', sub: 'configuracao' })
    expect(secaoDoEndereco('playbook', null, gruposVisiveis({ playbook: false })))
      .toEqual({ grupo: 'configurar', sub: 'configuracao' })
  })
  it('trocar de grupo leva à primeira sub; grupo inexistente devolve null', () => {
    expect(secaoDoGrupo('medir', todas)).toEqual({ grupo: 'medir', sub: 'qualidade' })
    expect(secaoDoGrupo('xyz', todas)).toBeNull()
  })
  it('a primeira sub do grupo não vai no endereço (endereço curto); as outras vão', () => {
    expect(enderecoDaSecao({ grupo: 'configurar', sub: 'configuracao' }, todas)).toEqual({ aba: 'configurar', sub: null })
    expect(enderecoDaSecao({ grupo: 'configurar', sub: 'protecoes' }, todas)).toEqual({ aba: 'configurar', sub: 'protecoes' })
  })
})

describe('troca de número com alterações não salvas', () => {
  it('pergunta só quando há alteração e o número muda', () => {
    expect(precisaConfirmarTroca('a', 'b', true)).toBe(true)
    expect(precisaConfirmarTroca('a', 'b', false)).toBe(false)
    expect(precisaConfirmarTroca('a', 'a', true)).toBe(false)
  })
})
