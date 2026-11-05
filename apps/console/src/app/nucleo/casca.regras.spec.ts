import { describe, it, expect } from 'vitest'
import {
  acaoVoltar, CAMADA, camadaTrilho, conteudoInerte, ehCelular, focoPreso, LARGURA_CELULAR, MQ_CELULAR,
  proximaGaveta, resumoAlertas, rotuloBotaoConversas, rotuloContador, separarAlertas,
  CONTEUDO_MIN_EMPURRAR, TRILHO_MIN, fecharNoCabecalhoDaLista, limitarLarguraTrilho, modoTrilho,
} from './casca.regras.js'

describe('Corte celular × desktop', () => {
  it('dado 719px, então é celular; dado 720px, então é desktop (desktop não muda)', () => {
    expect(ehCelular(719)).toBe(true)
    expect(ehCelular(LARGURA_CELULAR)).toBe(false)
    expect(ehCelular(1280)).toBe(false)
  })

  it('a media query nasce do mesmo número', () => {
    expect(MQ_CELULAR).toContain(String(LARGURA_CELULAR - 1))
  })
})

describe('Gaveta do menu', () => {
  it('dado fechada no celular, quando toca ☰, então abre; tocar de novo fecha', () => {
    expect(proximaGaveta(false, 'alternar', true)).toBe(true)
    expect(proximaGaveta(true, 'alternar', true)).toBe(false)
  })

  it.each(['esc', 'clique-fora', 'navegou'] as const)('dado aberta, quando %s, então fecha', (ev) => {
    expect(proximaGaveta(true, ev, true)).toBe(false)
  })

  it('⚠️ dado aberta e a janela cresce para desktop, então fecha — não reaparece aberta ao encolher', () => {
    expect(proximaGaveta(true, 'virou-desktop', false)).toBe(false)
  })

  it('dado desktop, então a gaveta nunca abre (o menu está na grade)', () => {
    expect(proximaGaveta(false, 'alternar', false)).toBe(false)
  })
})

describe('Foco preso na gaveta aberta', () => {
  it('dado foco no último, quando Tab, então volta ao primeiro', () => {
    expect(focoPreso(4, 5, false)).toBe(0)
  })

  it('dado foco no primeiro, quando Shift+Tab, então vai ao último', () => {
    expect(focoPreso(0, 5, true)).toBe(4)
  })

  it('dado foco no meio, então o navegador segue sozinho', () => {
    expect(focoPreso(2, 5, false)).toBeNull()
    expect(focoPreso(2, 5, true)).toBeNull()
  })

  it('dado foco fora da gaveta, então volta para dentro', () => {
    expect(focoPreso(-1, 5, false)).toBe(0)
    expect(focoPreso(-1, 5, true)).toBe(4)
  })

  it('dado gaveta sem nada focável, então não força nada', () => {
    expect(focoPreso(-1, 0, false)).toBeNull()
  })
})

describe('Contador de não lidas no botão flutuante', () => {
  it('dado zero, então não mostra contador', () => {
    expect(rotuloContador(0)).toBe('')
    expect(rotuloBotaoConversas(0)).toBe('Abrir conversas')
  })

  it('dado 7, então mostra 7 e o rótulo acessível diz a contagem', () => {
    expect(rotuloContador(7)).toBe('7')
    expect(rotuloBotaoConversas(7)).toBe('Abrir conversas — 7 não lidas')
    expect(rotuloBotaoConversas(1)).toBe('Abrir conversas — 1 não lida')
  })

  it('dado mais de 99, então trava em 99+ (o botão é redondo e pequeno)', () => {
    expect(rotuloContador(100)).toBe('99+')
  })
})

describe('Voltar do trilho no celular', () => {
  it('dado conversa aberta, então volta para a lista', () => {
    expect(acaoVoltar(true)).toBe('voltar-para-lista')
  })

  it('dado lista à vista, então fecha o trilho', () => {
    expect(acaoVoltar(false)).toBe('fechar-trilho')
  })
})

describe('Camadas do trilho × modais das telas', () => {
  it('⚠️ dado trilho recolhido (botão flutuante), então fica ABAIXO de qualquer modal de tela', () => {
    expect(camadaTrilho(false)).toBeLessThan(CAMADA.modal)
  })

  it('dado trilho aberto em tela cheia, então fica acima dos modais e abaixo do véu/gaveta', () => {
    expect(camadaTrilho(true)).toBeGreaterThan(CAMADA.modal)
    expect(camadaTrilho(true)).toBeLessThan(CAMADA.veu)
    expect(CAMADA.veu).toBeLessThan(CAMADA.gaveta)
  })
})

describe('Conteúdo inerte atrás do que se comporta como modal', () => {
  it('dado gaveta aberta, então inerte', () => {
    expect(conteudoInerte(true, true, false)).toBe(true)
  })

  it('⚠️ dado trilho aberto em tela cheia no celular, então inerte — o Tab não vai para trás dele', () => {
    expect(conteudoInerte(true, false, true)).toBe(true)
  })

  it('dado trilho aberto empurrando no desktop, então não (o trilho é coluna, não modal)', () => {
    expect(conteudoInerte(false, false, true)).toBe(false)
  })

  it('dado nada aberto, então não', () => {
    expect(conteudoInerte(true, false, false)).toBe(false)
  })
})

describe('Faixa de alertas', () => {
  const aviso = { id: 'a', severidade: 'aviso' as const }
  const critico = { id: 'c', severidade: 'critico' as const }

  it('dado desktop, então todos ficam visíveis (nada recolhe)', () => {
    const r = separarAlertas([aviso, critico], false)
    expect(r.sempreVisiveis).toHaveLength(2)
    expect(r.recolhiveis).toHaveLength(0)
  })

  it('⚠️ dado celular, então o crítico fica SEMPRE visível e os avisos recolhem', () => {
    const r = separarAlertas([aviso, critico, { id: 'b', severidade: 'aviso' as const }], true)
    expect(r.sempreVisiveis.map((a) => a.id)).toEqual(['c'])
    expect(r.recolhiveis.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('o resumo conta o que está recolhido', () => {
    expect(resumoAlertas(1, false)).toBe('1 alerta')
    expect(resumoAlertas(3, false)).toBe('3 alertas')
    expect(resumoAlertas(2, true)).toBe('2 outros alertas')
  })
})

describe('Trilho de conversas no desktop: empurrar ou gaveta (pela largura, sem botão)', () => {
  it('dado janela larga, quando a tela ao lado fica com 960 px ou mais, então empurra', () => {
    // 1920 − 250 (menu) − 700 (trilho) = 970
    expect(modoTrilho(1920, 250, 700)).toBe('empurrar')
    expect(modoTrilho(250 + 700 + CONTEUDO_MIN_EMPURRAR, 250, 700)).toBe('empurrar')
  })

  it('⚠️ dado 1667 px com trilho de 760, quando sobraria 657 px, então abre como gaveta (não esmaga a tela)', () => {
    expect(modoTrilho(1667, 250, 760)).toBe('gaveta')
  })

  it('dado o menu recolhido (56 px), então sobra mais e pode empurrar', () => {
    expect(modoTrilho(1440, 250, 420)).toBe('gaveta')
    expect(modoTrilho(1440, 56, 420)).toBe('empurrar')
  })

  it('a largura salva nunca passa da janela nem fica abaixo do mínimo', () => {
    expect(limitarLarguraTrilho(1600, 1000)).toBe(936)
    expect(limitarLarguraTrilho(500, 1440)).toBe(500)
    expect(limitarLarguraTrilho(100, 1440)).toBe(TRILHO_MIN)
    expect(limitarLarguraTrilho(900, 300)).toBe(TRILHO_MIN)
  })
})

describe('Fechar o trilho mora no cabeçalho da lista (um título só)', () => {
  it('celular: ‹ que fecha; desktop no trilho: › que recolhe; fora do trilho: nada', () => {
    expect(fecharNoCabecalhoDaLista(true, true)).toBe('voltar-celular')
    expect(fecharNoCabecalhoDaLista(false, true)).toBe('recolher-desktop')
    expect(fecharNoCabecalhoDaLista(false, false)).toBeNull()
    expect(fecharNoCabecalhoDaLista(true, false)).toBeNull()
  })
})

describe('Trilho em gaveta no desktop deixa o conteúdo inerte', () => {
  it('aberto como gaveta → inerte; aberto empurrando → não; fechado → não', () => {
    expect(conteudoInerte(false, false, true, true)).toBe(true)
    expect(conteudoInerte(false, false, true, false)).toBe(false)
    expect(conteudoInerte(false, false, false, true)).toBe(false)
  })
})
