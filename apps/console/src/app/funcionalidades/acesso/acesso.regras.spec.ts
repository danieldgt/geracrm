import { describe, it, expect } from 'vitest'
import {
  avisaModoFundador, erroDaSenha, indicesDuplicados, linhasDosPapeis, mapearErroUsuario, modoFundador, montarPapeis,
  rotuloDaAtribuicao, rotuloDoPapel, temDuplicata, ultimoLoginTexto, type UsuarioLista,
} from './usuarios.regras.js'
import { mapearErroFilial, montarPayloadFilial, localDaFilial } from './filiais.regras.js'
import { CORES_FILIAL, chaveDoHex, hexDaCor } from './filiais.cores.js'

const usuario = (ativo: boolean, papel: string | null): UsuarioLista => ({
  id: 'u', nome: 'N', email: 'n@x.com', telefone: null, cargo: null, ativo, ultimoLoginEm: null,
  papeis: papel ? [{ papel: papel as 'admin', filialId: null, filial: null }] : [],
})

describe('papéis', () => {
  it('rótulos', () => {
    expect(rotuloDoPapel('gestor')).toBe('Gestor')
    expect(rotuloDoPapel('x')).toBe('x')
    expect(rotuloDaAtribuicao({ papel: 'gestor', filial: 'Fortaleza' })).toBe('Gestor · Fortaleza')
    expect(rotuloDaAtribuicao({ papel: 'admin', filial: null })).toBe('Admin · Todas as filiais')
  })
  it('detecta duplicata de par papel/filial, ignorando linha vazia', () => {
    const l = [
      { papel: 'gestor', filialId: 'f1' }, { papel: 'gestor', filialId: 'f2' },
      { papel: 'gestor', filialId: 'f1' }, { papel: '', filialId: '' }, { papel: '', filialId: '' },
    ]
    expect(indicesDuplicados(l)).toEqual([2])
    expect(temDuplicata(l.slice(0, 2))).toBe(false)
  })
  it('monta o payload: descarta vazias e repetidas, "" vira null', () => {
    expect(montarPapeis([
      { papel: 'admin', filialId: '' }, { papel: 'admin', filialId: '' }, { papel: '', filialId: 'f1' },
      { papel: 'vendedor', filialId: 'f1' },
    ])).toEqual([{ papel: 'admin', filialId: null }, { papel: 'vendedor', filialId: 'f1' }])
  })
  it('ida e volta entre lista e linhas do modal', () => {
    const p = [{ papel: 'gestor' as const, filialId: null }, { papel: 'vendedor' as const, filialId: 'f1' }]
    expect(montarPapeis(linhasDosPapeis(p))).toEqual(p)
  })
})

describe('modo fundador', () => {
  it('sem admin ativo (lista completa) é fundador', () => {
    expect(modoFundador([usuario(true, null), usuario(true, 'gestor')], true)).toBe(true)
    expect(modoFundador([], true)).toBe(true)
  })
  it('admin inativo não conta', () => { expect(modoFundador([usuario(false, 'admin')], true)).toBe(true) })
  it('com admin ativo não é', () => { expect(modoFundador([usuario(true, 'admin')], true)).toBe(false) })
  it('lista incompleta nunca afirma', () => { expect(modoFundador([usuario(true, null)], false)).toBe(false) })
  it('o aviso só aparece se esta edição atribui admin', () => {
    expect(avisaModoFundador(true, [{ papel: 'admin', filialId: '' }])).toBe(true)
    expect(avisaModoFundador(true, [{ papel: 'gestor', filialId: '' }])).toBe(false)
    expect(avisaModoFundador(false, [{ papel: 'admin', filialId: '' }])).toBe(false)
  })
})

describe('erros da API', () => {
  it('usuário: campo e mensagem', () => {
    expect(mapearErroUsuario('usuario.email_duplicado')?.campo).toBe('email')
    expect(mapearErroUsuario('usuario.papeis_duplicados')?.campo).toBe('papeis')
    expect(mapearErroUsuario('usuario.senha_invalida')?.campo).toBe('senha')
    expect(mapearErroUsuario('usuario.ultimo_admin')).toMatchObject({ campo: null })
    expect(mapearErroUsuario('usuario.ultimo_admin')?.mensagem).toMatch(/último administrador/)
    expect(mapearErroUsuario('identidade.indisponivel')?.campo).toBeNull()
    expect(mapearErroUsuario('desconhecido')).toBeNull()
    expect(mapearErroUsuario(null)).toBeNull()
  })
  it('filial: matriz duplicada vai para o tipo', () => {
    expect(mapearErroFilial('filial.matriz_duplicada')?.campo).toBe('tipo')
    expect(mapearErroFilial('filial.cor_invalida')?.campo).toBe('cor')
    expect(mapearErroFilial('x')).toBeNull()
  })
})

describe('apoios', () => {
  it('senha e último login', () => {
    expect(erroDaSenha('', false)).toBeNull()
    expect(erroDaSenha('', true)).not.toBeNull()
    expect(erroDaSenha('1234567', false)).not.toBeNull()
    expect(erroDaSenha('12345678', true)).toBeNull()
    expect(ultimoLoginTexto(null)).toBe('Nunca')
    expect(ultimoLoginTexto('lixo')).toBe('—')
  })
  it('local da filial', () => {
    expect(localDaFilial({ cidade: 'Fortaleza', uf: 'CE' })).toBe('Fortaleza/CE')
    expect(localDaFilial({ cidade: null, uf: null })).toBe('—')
  })
  it('payload da filial converte a chave da cor em hex e vazio em null', () => {
    const p = montarPayloadFilial(
      { nome: ' Sede ', cidade: ' ', uf: '', tipo: 'matriz', cor: 'azul', ativa: true }, hexDaCor)
    expect(p).toEqual({ nome: 'Sede', cidade: null, uf: null, tipo: 'matriz', cor: hexDaCor('azul'), ativa: true })
    expect(p.cor).toMatch(/^#[0-9A-F]{6}$/)
    expect(montarPayloadFilial({ nome: 'a', cidade: '', uf: 'CE', tipo: 'x', cor: '', ativa: false }, hexDaCor))
      .toMatchObject({ tipo: 'filial', cor: null, uf: 'CE', ativa: false })
  })
  it('paleta: hex <-> chave, todos no formato #RRGGBB e sem repetição', () => {
    for (const c of CORES_FILIAL) { expect(c.hex).toMatch(/^#[0-9A-F]{6}$/); expect(chaveDoHex(c.hex.toLowerCase())).toBe(c.chave) }
    expect(new Set(CORES_FILIAL.map((c) => c.hex)).size).toBe(CORES_FILIAL.length)
    expect(chaveDoHex('#000000')).toBe('')
    expect(chaveDoHex(null)).toBe('')
  })
})
