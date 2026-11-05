import { describe, it, expect } from 'vitest'
import {
  FILTROS_VAZIOS, abaDaSituacao, errosDoServidor, parametrosDaLista, payloadConcluir, payloadTarefa, rotuloTipoTarefa,
  abasComContador, temFiltroAtivo, validarTarefa, venceEmIso, type FormTarefa,
} from './tarefas.regras.js'

const form: FormTarefa = {
  contatoId: 'c1', tipo: 'ligacao', titulo: '  Ligar  ', data: '2026-11-10', hora: '09:30', responsavelId: '', descricao: '',
}

describe('parametrosDaLista', () => {
  it('traduz filtros e normaliza vazios para null', () => {
    const p = parametrosDaLista({ ...FILTROS_VAZIOS, situacao: 'abertas', busca: ' maria ', tipo: 'email', de: '2026-11-01' }, 'cur')
    expect(p).toEqual({
      situacao: 'abertas', q: 'maria', tipo: 'email', responsavelId: null, de: '2026-11-01', ate: null, contatoId: null, cursor: 'cur',
    })
  })
})

describe('abas', () => {
  it('a contagem vai no rótulo da aba; Abertas usa os pendentes e Concluídas fica sem número', () => {
    const abas = abasComContador({ pendentes: 5, atrasadas: 2, hoje: 1, semana: 3 })
    expect(abas.map((a) => [a.id, a.contador])).toEqual([
      ['hoje', 1], ['atrasadas', 2], ['semana', 3], ['abertas', 5], ['concluidas', undefined],
    ])
  })
  it('sem contadores, as abas ficam sem número', () => {
    expect(abasComContador(null).every((a) => a.contador === undefined)).toBe(true)
  })
  it('Esta semana tem aba; situação desconhecida não marca nenhuma', () => {
    expect(abaDaSituacao('semana')).toBe('semana')
    expect(abaDaSituacao('xyz')).toBe('')
  })
  it('temFiltroAtivo ignora a aba e o contato fixo', () => {
    expect(temFiltroAtivo({ ...FILTROS_VAZIOS, contatoId: 'x' })).toBe(false)
    expect(temFiltroAtivo({ ...FILTROS_VAZIOS, busca: 'a' })).toBe(true)
  })
  it('rótulo do tipo', () => {
    expect(rotuloTipoTarefa('ligacao')).toBe('Ligação')
    expect(rotuloTipoTarefa('xyz')).toBe('xyz')
  })
})

describe('venceEmIso', () => {
  it('preserva a hora local no ida e volta', () => {
    const iso = venceEmIso('2026-11-10', '09:30')!
    const d = new Date(iso)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 11, 10, 9, 30])
  })
  it('rejeita formato inválido', () => {
    expect(venceEmIso('', '09:30')).toBeNull()
    expect(venceEmIso('2026-11-10', '9h')).toBeNull()
  })
})

describe('validarTarefa / payloadTarefa', () => {
  it('exige título, data e hora; contato só quando obrigatório', () => {
    expect(validarTarefa({ ...form, titulo: ' ', data: '', hora: '' })).toEqual({
      titulo: 'Dê um título.', data: 'Informe a data.', hora: 'Informe a hora.',
    })
    expect(validarTarefa({ ...form, contatoId: '' })).toEqual({})
    expect(validarTarefa({ ...form, contatoId: '' }, true)).toEqual({ contatoId: 'Escolha o contato.' })
  })
  it('título acima de 200 caracteres é recusado', () => {
    expect(validarTarefa({ ...form, titulo: 'x'.repeat(201) })).toEqual({ titulo: 'Use até 200 caracteres.' })
  })
  it('leva os campos do 422 da API para o formulário', () => {
    expect(errosDoServidor(['contatoId', 'venceEm', 'outro'])).toEqual({
      contatoId: 'Contato não encontrado.', data: 'Data ou hora inválida.',
    })
    expect(errosDoServidor(undefined)).toEqual({})
  })
  it('monta o payload sem campos vazios', () => {
    const p = payloadTarefa(form)!
    expect(p).toMatchObject({ titulo: 'Ligar', tipo: 'ligacao', contatoId: 'c1' })
    expect(p).not.toHaveProperty('responsavelId')
    expect(p).not.toHaveProperty('descricao')
    expect(typeof p['venceEm']).toBe('string')
  })
  it('inclui responsável e descrição quando preenchidos; null se inválido', () => {
    expect(payloadTarefa({ ...form, responsavelId: 'u1', descricao: ' nota ' })).toMatchObject({ responsavelId: 'u1', descricao: 'nota' })
    expect(payloadTarefa({ ...form, titulo: '' })).toBeNull()
  })
})

describe('payloadConcluir', () => {
  it('resultado vazio não vai no corpo', () => {
    expect(payloadConcluir('  ')).toEqual({})
    expect(payloadConcluir(' fechou ')).toEqual({ resultado: 'fechou' })
  })
})
