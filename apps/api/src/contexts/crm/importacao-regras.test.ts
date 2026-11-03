import { describe, it, expect } from 'vitest'
import { parseCsv, sugerirDePara } from '@geracrm/shared'
import { LinhaCsv, lerContato, lerTarefa, lerVenda } from './importacao-regras.js'

const AGORA = new Date('2026-11-03T12:00:00Z')

function linha(tipo: 'contatos' | 'vendas' | 'tarefas', csv: string) {
  const l = parseCsv(csv)
  return new LinhaCsv(l.colunas, sugerirDePara(tipo, l.colunas), l.linhas[0]!.campos)
}

describe('leitura de linha (pura)', () => {
  it('contato: normaliza telefone, documento, uf e qualificação', () => {
    const r = lerContato(linha('contatos', 'Nome;Telefone;CNPJ;UF;Qualificação\nAna;(81) 99861-7049;11.222.333/0001-81;pe;Descartado'), AGORA)
    expect(r).toMatchObject({ ok: true, dado: { nome: 'Ana', documento: '11222333000181', qualificacao: 'descartado', whatsapp: true } })
    if (r.ok) { expect(r.dado.telefone.e164).toBe('+5581998617049'); expect(r.dado.endereco.uf).toBe('PE') }
  })

  it.each([
    ['Nome;Telefone\n;81998617049', 'nome_vazio'],
    ['Nome;Telefone\nAna;', 'telefone_vazio'],
    ['Nome;Telefone\nAna;123', 'telefone_invalido'],
    ['Nome;Telefone;CNPJ\nAna;81998617049;11222333000182', 'documento_invalido'],
    ['Nome;Telefone;E-mail\nAna;81998617049;sem-arroba', 'email_invalido'],
    ['Nome;Telefone;CEP\nAna;81998617049;123', 'cep_invalido'],
    ['Nome;Telefone;Qualificação\nAna;81998617049;talvez', 'qualificacao_invalida'],
    ['Nome;Telefone;Criado em\nAna;81998617049;01/01/2099', 'criado_em_invalido'],
  ])('contato rejeita com motivo-código: %s → %s', (csv, motivo) => {
    expect(lerContato(linha('contatos', csv), AGORA)).toEqual({ ok: false, motivo })
  })

  it('venda: decimal pt-BR vira centavos; data futura, valor zero e falta de contato são rejeitados', () => {
    const ok = lerVenda(linha('vendas', 'Telefone;Data;Valor\n81998617049;20/05/2024;1.234,56'), AGORA)
    expect(ok).toMatchObject({ ok: true, dado: { valorCentavos: 123456 } })
    expect(lerVenda(linha('vendas', 'Telefone;Data;Valor\n81998617049;20/05/2030;10,00'), AGORA)).toEqual({ ok: false, motivo: 'data_futura' })
    expect(lerVenda(linha('vendas', 'Telefone;Data;Valor\n81998617049;20/05/2024;0,00'), AGORA)).toEqual({ ok: false, motivo: 'valor_invalido' })
    expect(lerVenda(linha('vendas', 'Telefone;CNPJ;Data;Valor\n;;20/05/2024;5,00'), AGORA)).toEqual({ ok: false, motivo: 'contato_nao_informado' })
  })

  it('tarefa: aceita sinônimo de tipo e contato opcional', () => {
    const r = lerTarefa(linha('tarefas', 'Título;Tipo;Vence em\nLigar;Reunião;30/11/2026'))
    expect(r).toMatchObject({ ok: true, dado: { tipo: 'reuniao', contato: null } })
    expect(lerTarefa(linha('tarefas', 'Título;Tipo;Vence em\nLigar;viagem;30/11/2026'))).toEqual({ ok: false, motivo: 'tipo_invalido' })
    expect(lerTarefa(linha('tarefas', 'Título;Vence em\nLigar;ontem'))).toEqual({ ok: false, motivo: 'vencimento_invalido' })
  })
})
