import { describe, it, expect } from 'vitest'
import { renderizarLp, escaparHtml, paraScript, linkDireto, CAMPO_ARMADILHA, type DadosLp } from './pagina-lp.js'
import { extrairCodigoOrigem } from '@geracrm/shared'

const base: DadosLp = {
  chave: 'abc123def456',
  modo: 'inbound_wa',
  titulo: 'Uniformes para a sua equipe',
  subtitulo: 'Orçamento no WhatsApp em minutos',
  chamadaBotao: 'Falar com um vendedor',
  avisoConsentimento: 'Ao continuar, você aceita receber contato pelo WhatsApp.',
  telefoneDestino: '5581999998888',
  textoBase: 'Olá! Vi o anúncio',
}

describe('Página da landing', () => {
  it('mostra título, subtítulo e a chamada do botão', () => {
    const html = renderizarLp(base)
    expect(html).toContain('Uniformes para a sua equipe')
    expect(html).toContain('Orçamento no WhatsApp em minutos')
    expect(html).toContain('Falar com um vendedor')
  })

  /**
   * ⚠️ O `href` do botão já é o wa.me DIRETO, sem código. É o que faz a página
   * funcionar sem JavaScript e com a rede caindo: perde-se a atribuição daquele
   * lead, não o lead. Trocar uma conversa por um dado é a inversão que mata
   * produto de aquisição.
   */
  it('o botão já nasce apontando para o WhatsApp, mesmo sem JavaScript', () => {
    const html = renderizarLp(base)
    expect(html).toContain('https://wa.me/5581999998888?text=')
  })

  /**
   * ⚠️ A sessão nasce no CLIQUE. Se nascesse no carregamento, crawler e preview
   * de link virariam sessão — e cada uma delas afunda a taxa de código perdido,
   * que é o termômetro da atribuição.
   */
  it('não cria sessão no carregamento — só no clique', () => {
    const html = renderizarLp(base)
    expect(html).toContain("addEventListener('click'")
    expect(html).not.toContain("addEventListener('load'")
  })

  it('manda o TIPO do click id, que é o que distingue Google de Meta', () => {
    const html = renderizarLp(base)
    expect(html).toContain('gclid')
    expect(html).toContain('fbclid')
    expect(html).toContain('clickIdTipo')
  })

  it('escapa HTML vindo do banco', () => {
    const html = renderizarLp({ ...base, titulo: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  /**
   * ⚠️ O furo clássico dentro de `<script>`: a sequência `</script>` numa string
   * fecha a tag e o resto do JSON vira markup — `JSON.stringify` sozinho não
   * protege disso.
   *
   * Hoje os dois valores injetados no script são a chave (alfabeto restrito) e o
   * link já `encodeURIComponent`-ado, então o furo não é alcançável pelos dados
   * atuais. O escape existe para o dia em que alguém acrescentar um campo ali —
   * e é por isso que ele é testado direto, em vez de fingir um vetor que a
   * página não tem.
   */
  it('o escape de script neutraliza o fechamento de tag', () => {
    expect(paraScript('oi </script><script>alert(1)')).not.toContain('</script>')
    expect(paraScript('oi </script>')).toContain('\\u003c/script')
  })

  it('o link do wa.me entra no script já codificado para URL', () => {
    const html = renderizarLp({ ...base, textoBase: 'oi </script> tudo bem' })
    expect(html).not.toContain('</script> tudo bem')
    expect(html).toContain('%3C%2Fscript%3E')
  })

  it('sem subtítulo e sem aviso, não deixa parágrafo vazio na página', () => {
    const html = renderizarLp({ ...base, subtitulo: null, avisoConsentimento: null })
    expect(html).not.toContain('class="sub"')
    expect(html).not.toContain('class="aviso"')
  })
})

describe('Link direto', () => {
  it('codifica o texto para a URL', () => {
    expect(linkDireto('5581999998888', 'Olá! Vi o anúncio'))
      .toBe('https://wa.me/5581999998888?text=Ol%C3%A1!%20Vi%20o%20an%C3%BAncio')
  })

  /** O caminho degradado não leva código — e o extrator concorda com isso. */
  it('o link direto não carrega código de origem', () => {
    const texto = decodeURIComponent(linkDireto('5581999998888', 'Olá! Vi o anúncio').split('text=')[1]!)
    expect(extrairCodigoOrigem(texto)).toBeNull()
  })
})

describe('Escape', () => {
  it('cobre os cinco caracteres que quebram markup', () => {
    expect(escaparHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })
})

describe('Página no modo formulário (AQ-12)', () => {
  const form: DadosLp = { ...base, modo: 'outbound_formulario', telefoneDestino: null }

  it('mostra os campos e NÃO manda ninguém para o wa.me', () => {
    const html = renderizarLp(form)
    expect(html).toContain('name="nome"')
    expect(html).toContain('name="telefone"')
    expect(html).not.toContain('https://wa.me/')
  })

  /**
   * ⚠️ Rótulo VISÍVEL, não placeholder: placeholder some quando a pessoa começa
   * a digitar, e quem preenche no celular perde a referência do campo.
   */
  it('cada campo tem rótulo visível', () => {
    const html = renderizarLp(form)
    expect(html).toContain('<label>Seu nome')
    expect(html).toContain('<label>WhatsApp com DDD')
  })

  /** ⚠️ Sai da tela, não do DOM — bot preenche tudo o que encontra. */
  it('tem campo-armadilha fora da tela', () => {
    const html = renderizarLp(form)
    expect(html).toContain('class="armadilha"')
    expect(html).toContain(`name="${CAMPO_ARMADILHA}"`)
  })

  it('envia para /lead, não para /sessao', () => {
    const html = renderizarLp(form)
    expect(html).toContain("'/lead'")
    expect(html).not.toContain("'/sessao'")
  })

  it('troca de tela no sucesso, em vez de alert', () => {
    const html = renderizarLp(form)
    expect(html).toContain('id="obrigado"')
    expect(html).not.toContain('alert(')
  })
})
