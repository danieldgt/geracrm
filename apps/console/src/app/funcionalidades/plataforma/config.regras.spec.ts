import { describe, it, expect } from 'vitest'
import { mensagemFalhaAoSalvar, TEXTO_SO_ADMIN } from './config.regras.js'

/** A forma de um HttpErrorResponse (status + error) — sem carregar o Angular no teste. */
const http = (status: number, error?: unknown) => ({ status, error })

describe('Falha ao salvar na tela de empresa', () => {
  it('403 nomeia o papel; 422 mostra a mensagem do servidor; o resto convida a tentar de novo', () => {
    expect(mensagemFalhaAoSalvar(http(403, { erro: 'acesso.papel_insuficiente' }))).toBe(TEXTO_SO_ADMIN)
    expect(mensagemFalhaAoSalvar(http(422, { erro: 'config.fuso_invalido', mensagem: 'Fuso horário inválido.' }))).toBe('Fuso horário inválido.')
    expect(mensagemFalhaAoSalvar(http(422, {}))).toBe('Não foi possível salvar. Tente de novo.')
    expect(mensagemFalhaAoSalvar(http(500))).toBe('Não foi possível salvar. Tente de novo.')
    expect(mensagemFalhaAoSalvar(http(0))).toContain('Sem conexão')
    expect(mensagemFalhaAoSalvar(new Error('x'))).toBe('Não foi possível salvar. Tente de novo.')
  })
})
