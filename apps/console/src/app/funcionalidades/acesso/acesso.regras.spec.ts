import { describe, it, expect } from 'vitest'
import {
  TEXTO_SEM_ADMIN, erroDaSenha, estadoDaFalhaDeLista, indicesDuplicados, linhasDosPapeis, mapearErroUsuario, montarPapeis,
  rotuloDaAtribuicao, rotuloDoPapel, temDuplicata, ultimoLoginTexto,
} from './usuarios.regras.js'
import { mapearErroFilial, montarPayloadFilial, localDaFilial } from './filiais.regras.js'
import { CORES_FILIAL, chaveDoHex, hexDaCor } from './filiais.cores.js'

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

describe('empresa sem admin atribuído (403 acesso.admin_atribuido)', () => {
  it('só o código de admin atribuído vira estado próprio; outro 403 é falta de papel', () => {
    expect(estadoDaFalhaDeLista(403, 'acesso.admin_atribuido')).toBe('sem_admin')
    expect(estadoDaFalhaDeLista(403, 'acesso.papel_insuficiente')).toBe('sem_permissao')
    expect(estadoDaFalhaDeLista(403, null)).toBe('sem_permissao')
  })
  it('fora do 403 é erro de carga, mesmo com o código de admin', () => {
    expect(estadoDaFalhaDeLista(500, 'acesso.admin_atribuido')).toBe('erro')
    expect(estadoDaFalhaDeLista(0, null)).toBe('erro')
    expect(estadoDaFalhaDeLista(401, null)).toBe('erro')
  })
  it('o texto diz quem resolve e o que fica liberado, sem botão de tentar de novo', () => {
    expect(TEXTO_SEM_ADMIN.titulo).toBe('Sua empresa ainda não tem um administrador')
    expect(TEXTO_SEM_ADMIN.descricao).toMatch(/equipe Drezz/)
  })
})

describe('erros da API', () => {
  it('usuário: campo e mensagem', () => {
    expect(mapearErroUsuario('usuario.email_duplicado')?.campo).toBe('email')
    // Mensagem genérica de propósito: não revela se o e-mail existe em outra empresa.
    expect(mapearErroUsuario('usuario.email_indisponivel')).toMatchObject({ campo: 'email' })
    expect(mapearErroUsuario('usuario.email_indisponivel')?.mensagem).not.toMatch(/outra conta/)
    expect(mapearErroUsuario('identidade.login_de_outra_conta')).toMatchObject({ campo: null })
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
