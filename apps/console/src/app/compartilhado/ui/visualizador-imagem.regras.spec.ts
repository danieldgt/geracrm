import { describe, it, expect } from 'vitest'
import { andarImagem, cabeReduzida, contadorImagem, encaixar, indiceDaImagem, nomeParaBaixar } from './visualizador-imagem.regras.js'

describe('Visualizador de imagem — regras', () => {
  it('anda para a próxima e a anterior sem dar a volta nas bordas', () => {
    expect(andarImagem(0, 3, 1)).toBe(1)
    expect(andarImagem(2, 3, 1)).toBe(2)
    expect(andarImagem(0, 3, -1)).toBe(0)
    expect(andarImagem(1, 3, -1)).toBe(0)
    expect(andarImagem(5, 0, 1)).toBe(0)
  })

  it('o contador só aparece com mais de uma imagem', () => {
    expect(contadorImagem(0, 1)).toBe('')
    expect(contadorImagem(2, 7)).toBe('3 de 7')
  })

  it('acha a imagem pelo id da mensagem', () => {
    const lista = [{ id: 'a', src: 'x' }, { id: 'b', src: 'y' }]
    expect(indiceDaImagem(lista, 'b')).toBe(1)
    expect(indiceDaImagem(lista, 'z')).toBe(-1)
  })

  it('dá nome ao arquivo baixado, inclusive de data URL', () => {
    expect(nomeParaBaixar('data:image/jpeg;base64,AAA')).toBe('imagem.jpg')
    expect(nomeParaBaixar('data:image/png;base64,AAA', 'foto')).toBe('foto.png')
    expect(nomeParaBaixar('https://cdn.x/m/abc.webp?sig=1')).toBe('abc.webp')
    expect(nomeParaBaixar('https://cdn.x/m/abc')).toBe('imagem.jpg')
  })
})

describe('Visualizador de imagem — encaixe na tela', () => {
  const tela = { largura: 1200, altura: 800 }

  it('reduz a foto grande até caber inteira, mantendo a proporção', () => {
    expect(encaixar({ largura: 4000, altura: 3000 }, tela)).toEqual({ largura: 1067, altura: 800 })
    expect(encaixar({ largura: 1080, altura: 1920 }, tela)).toEqual({ largura: 450, altura: 800 })
  })

  it('amplia a imagem pequena, mas no máximo 3×', () => {
    expect(encaixar({ largura: 600, altura: 400 }, tela)).toEqual({ largura: 1200, altura: 800 })
    expect(encaixar({ largura: 100, altura: 100 }, tela)).toEqual({ largura: 300, altura: 300 })
  })

  it('sem medida ainda (carregando) não decide nada', () => {
    expect(encaixar({ largura: 0, altura: 0 }, tela)).toBeNull()
    expect(encaixar({ largura: 10, altura: 10 }, { largura: 0, altura: 0 })).toBeNull()
  })

  it('"tamanho real" só faz sentido quando a imagem é maior que a tela', () => {
    expect(cabeReduzida({ largura: 4000, altura: 3000 }, tela)).toBe(true)
    expect(cabeReduzida({ largura: 600, altura: 400 }, tela)).toBe(false)
  })
})
