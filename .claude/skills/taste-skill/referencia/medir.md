# Medir e olhar: o ciclo de captura, medição e correção

O ciclo é ideia da taste-skill (MIT; ver `../SKILL.md`). **O código abaixo não é dela**: foi escrito para a
adaptação Velivo e ajustado para o console do GeraCRM. Só lê o DOM: não muda a página e não chama a rede.

## 1. Montar a tela com dados que pedem ação

Tela vazia não mostra problema. **Nunca produção, nunca cliente real.**

- Pilha local (skill/memória do ambiente): `export PATH="$HOME/.local/bin:$PATH"`, `docker compose up -d postgres`
  (5442), API com `pnpm dev` em `apps/api` (3000), console com `ng serve` em `apps/console` (4200, proxy de `/v1`).
- Dados: o tenant de dogfooding que o console usa em dev, ou o seed demo
  (`SEED_DEMO=on pnpm --filter @geracrm/api seed:demo`). Para extremos (11 mil cards, nome de 120 caracteres), monte
  no banco local, nunca no Railway.

## 2. Capturar

Larguras: **1280×860**, **1440×900 com o chat rail aberto** (o caso que mais quebra) e **390×844** com toque. Quando a
tela muda de forma no meio, 640 e 720 (quebras do console). **Os dois temas**: `document.documentElement.dataset.tema
= 'escuro'` (ou `'claro'`) e sem atributo seguindo o SO. Com `reducedMotion: 'reduce'`, nada fica a meio caminho.

Ferramentas, da mais simples para a mais completa:

- **Chrome headless pela linha de comando**, só para a foto (largura mínima real ~500 px, sem toque):
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
    --virtual-time-budget=6000 --window-size=1280,860 --screenshot=<scratchpad>/tela.png http://localhost:4200/contatos
  ```
- **Claude in Chrome** (skill `claude-in-chrome`): aba nova, `resize_window`, cole a medição no `javascript_tool`.
- **Chrome headless por CDP** em Node, sem dependência, para o celular (`Emulation.setDeviceMetricsOverride`,
  `setTouchEmulationEnabled`, `setEmulatedMedia`, `Runtime.evaluate`, `Page.captureScreenshot`).
- **Nunca use `node_modules` de outro projeto da máquina.** Dependência nova entra pela regra do repositório.

Capturas e scripts ficam na pasta temporária da sessão. No repo entram só as que um estudo cita, em
`docs/layout/<estudo>/`.

## 3. Medir

Cole no console, no `javascript_tool` ou num `Runtime.evaluate` (antes, `window.__LARGURA = <largura da emulação>`).
Devolve `{ largura, achados: [{ regra, nivel, detalhe }] }`. `FALHA` se corrige ou se defende por escrito; `AVISO`
está errado até alguém defendê-lo numa frase. A raiz é `main` ou, no console, `.conteudo` (a casca não tem `<main>`).

| Regra | O que mede | Por quê |
|---|---|---|
| `transbordo` | `scrollWidth` maior que a janela, com os culpados | a página nunca rola na horizontal |
| `sobreposicao` | controle ou título do conteúdo cujo centro está coberto por outro elemento | chat rail, barra fixa ou flutuante cobrindo a tela |
| `main-espremido` | conteúdo com menos de 560 px numa janela de computador | rail ou painel lateral comendo o espaço útil |
| `alvo-44` / `alvo-24` | controle menor que 44 px no toque ou 24 px com mouse | WCAG 2.5.8; token do console 28 px |
| `contraste` | texto contra o primeiro fundo opaco: 4,5:1, ou 3:1 no grande | AA, nos dois temas |
| `texto-minimo`, `texto-pequeno` | bloco abaixo de 11 px; mais de 45 % do texto abaixo de 12 px | `.txt-rotulo` é 11, `.txt-denso` 13 |
| `familias`, `tamanhos`, `fonte-falhou` | mais de 2 famílias, mais de 10 tamanhos, fonte que não carregou | Geist + Geist Mono e mais nada |
| `titulo-3-linhas` | `h1`–`h3` com mais de duas linhas | título que não cabe |
| `icone-tingido` | 3+ ícones em círculo ou quadrado tingido (falha com 2+ matizes) | sinal de painel gerado |
| `borda-e-sombra`, `raios` | painel com borda e sombra; mais de 3 raios | borda antes de sombra; `--raio-controle`, `--raio-painel`, `--raio-completo` |
| `tabular` | menos da metade dos números com `tabular-nums` | `.txt-dados` |
| `borda` | texto a menos de 16 px da borda da janela (12 no celular) | margem |
| `imagem-quebrada` | `img` carregada com largura natural 0 | avatar, foto de produto |
| `acao-dominante` | mais de um controle cheio, em alto contraste, na primeira dobra | uma ação dominante |
| `sem-main` | página sem marco `<main>` | leitor de tela pula direto para o conteúdo |

O que a medição não vê, e a imagem vê: hierarquia, agrupamento, texto que não diz nada, tela duplicada, cor fora de
papel. Por isso a seção 4 existe.

```js
// Medição de tela (skill taste-skill do GeraCRM). Cole no console, no javascript_tool do Claude in Chrome ou passe para
// page.evaluate. Só lê o DOM: não muda nada, não chama rede. Devolve { largura, achados: [{ regra, nivel, detalhe }] }.
// Largura: com emulação de celular, conteúdo mais largo que a tela faz o Chrome AUMENTAR o `innerWidth` (a página
// "encolhe para caber") e o transbordo passaria despercebido. Por isso a largura de referência é a configurada na captura:
// antes de medir, rode `window.__LARGURA = 390` (a largura da emulação); sem isso cai em `innerWidth`.
;(() => {
  const W = window.__LARGURA ?? innerWidth
  const phone = W < 700
  // Alvo: 44 px no toque; com mouse, o piso da WCAG 2.5.8 (24 px). O token do console é 28 px.
  const coarse = matchMedia('(pointer: coarse)').matches
  const minTarget = coarse ? 44 : 24
  const scrolls = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true
    return false
  }
  // Raiz do conteúdo: o console não tem <main> (a casca usa div.conteudo); a medição aceita os dois.
  const M = document.querySelector('main, .conteudo') ?? document.body
  if (!document.querySelector('main')) var semMain = true
  const out = []
  const add = (regra, nivel, detalhe) => out.push({ regra, nivel, detalhe })
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const name = (el) =>
    `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 32)}"`
  // Cor → [r, g, b, a] por um canvas de 1 px (aceita oklch, color-mix, color()).
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const rgba = (c) => {
    if (!c || c === 'transparent') return [0, 0, 0, 0]
    cv.clearRect(0, 0, 1, 1)
    cv.fillStyle = '#000'
    cv.fillStyle = c
    cv.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const x = v / 255
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (l1 + 0.05) / (l2 + 0.05)
  }
  const ground = rgba(getComputedStyle(document.body).backgroundColor)
  const bgOf = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.backgroundImage !== 'none') return null
      const c = rgba(s.backgroundColor)
      if (c[3] >= 0.9) return c
    }
    return ground[3] >= 0.9 ? ground : rgba(getComputedStyle(document.documentElement).backgroundColor)
  }
  const hue = ([r, g, b]) => {
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    if (mx === mn) return -1
    const d = mx - mn
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    return Math.round((h * 60 + 360) % 360)
  }

  // 1. Transbordo horizontal, com os culpados mais fundos.
  // Culpado = folha visível que passa da largura e não está numa faixa que rola de lado de propósito.
  const culprits = [...document.querySelectorAll('body *')]
    .filter((el) => vis(el) && el.getBoundingClientRect().right > W + 2 && el.children.length === 0 && !scrolls(el) && !el.closest('svg, .sr-only'))
    .slice(0, 5)
    .map(name)
  if (document.documentElement.scrollWidth > W + 2 || culprits.length)
    add('transbordo', 'FALHA', `scrollWidth ${document.documentElement.scrollWidth} > ${W}: ${culprits.join(', ')}`)

  // 2. Alvos menores que minTarget (o rótulo conta como alvo de rádio e caixa).
  const small = [
    ...document.querySelectorAll('button, a[href], select, summary, input:not([type=radio]):not([type=checkbox]), [role=button], [role=tab], [role=switch]'),
  ].filter((el) => {
    if (!vis(el)) return false
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.closest('p, li > span')) return false
    // Alvo ampliado por ::after absoluto (o desenho fica pequeno, a área de toque tem o mínimo): conta como alvo.
    const hit = getComputedStyle(el, '::after')
    if (hit.content !== 'none' && hit.position === 'absolute' && Math.min(parseFloat(hit.width), parseFloat(hit.height)) >= minTarget) return false
    const r = el.getBoundingClientRect()
    return Math.round(Math.min(r.height, r.width)) < minTarget
  })
  if (small.length)
    add(`alvo-${minTarget}`, 'FALHA', `${small.length}: ${small.slice(0, 8).map((el) => `${name(el)} ${Math.round(el.getBoundingClientRect().height)}px`).join('; ')}`)

  // 3–5. Texto: contraste, tamanho, famílias e tamanhos por caractere.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const fam = new Map()
  const sizes = new Map()
  const lowContrast = []
  let chars = 0
  let under12 = 0
  let under11 = 0
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const txt = t.textContent.trim()
    const el = t.parentElement
    if (!txt || !el || !vis(el) || el.closest('.sr-only, [aria-hidden=true], svg')) continue
    const s = getComputedStyle(el)
    const px = Number.parseFloat(s.fontSize)
    const n = txt.length
    chars += n
    const f = s.fontFamily.split(',')[0].replace(/["']/g, '').trim()
    fam.set(f, (fam.get(f) ?? 0) + n)
    sizes.set(Math.round(px), (sizes.get(Math.round(px)) ?? 0) + n)
    if (px < 12) under12 += n
    if (px < 11 && n >= 3) under11++
    const bg = bgOf(el)
    if (bg) {
      const big = px >= 24 || (px >= 18.5 && Number(s.fontWeight) >= 700)
      const r = ratio(rgba(s.color), bg)
      if (r < (big ? 3 : 4.5)) lowContrast.push(`${name(el)} ${r.toFixed(2)}:1`)
    }
  }
  if (lowContrast.length) add('contraste', 'FALHA', `${lowContrast.length}: ${lowContrast.slice(0, 6).join('; ')}`)
  if (under11) add('texto-minimo', 'FALHA', `${under11} blocos abaixo de 11 px`)
  if (chars && under12 / chars > 0.45) add('texto-pequeno', 'AVISO', `${Math.round((100 * under12) / chars)}% do texto abaixo de 12 px`)
  const fams = [...fam].filter(([, n]) => n / chars >= 0.02)
  if (fams.length > 2) add('familias', 'AVISO', fams.map(([f, n]) => `${f} ${Math.round((100 * n) / chars)}%`).join(', '))
  if (sizes.size > 10) add('tamanhos', 'AVISO', `${sizes.size} tamanhos: ${[...sizes.keys()].sort((a, b) => a - b).join(' ')}`)
  const declared = [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family)
  if (declared.length) add('fonte-falhou', 'AVISO', declared.join(', '))

  // 6. Título com mais de duas linhas.
  for (const h of document.querySelectorAll('h1, h2, h3')) {
    if (!vis(h)) continue
    const range = document.createRange()
    range.selectNodeContents(h)
    const lh = Number.parseFloat(getComputedStyle(h).fontSize) * 0.55
    const mids = []
    for (const r of range.getClientRects()) {
      const m = r.top + r.height / 2
      if (r.width > 1 && !mids.some((x) => Math.abs(x - m) < lh)) mids.push(m)
    }
    if (mids.length > 2) add('titulo-3-linhas', 'AVISO', `${name(h)}: ${mids.length} linhas`)
  }

  // 7. Ícone em círculo ou quadrado tingido, repetido.
  const chips = [...document.querySelectorAll('body *')].filter((el) => {
    if (!vis(el) || !el.querySelector('svg') || (el.textContent ?? '').trim().length > 2) return false
    const r = el.getBoundingClientRect()
    const c = rgba(getComputedStyle(el).backgroundColor)
    return r.width >= 24 && r.width <= 64 && Math.abs(r.width - r.height) <= 4 && c[3] >= 0.06 && c[3] < 0.9
  })
  if (chips.length >= 3) {
    const hues = new Set(chips.map((el) => Math.round(hue(rgba(getComputedStyle(el).backgroundColor)) / 30)))
    add('icone-tingido', hues.size >= 2 ? 'FALHA' : 'AVISO', `${chips.length} chips, ${hues.size} matizes`)
  }

  // 8–9. Painéis: borda e sombra juntas, e quantos raios diferentes.
  const radii = new Set()
  let ghost = 0
  for (const el of M.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width < 140 || r.height < 72 || !vis(el)) continue
    const s = getComputedStyle(el)
    const filled = rgba(s.backgroundColor)[3] > 0.5
    const border = Number.parseFloat(s.borderTopWidth) > 0 && rgba(s.borderTopColor)[3] > 0.1
    const shadow = s.boxShadow !== 'none'
    if (!filled && !border && !shadow) continue
    radii.add(s.borderTopLeftRadius)
    if (border && shadow && !el.closest('dialog, [role=menu], [popover]')) ghost++
  }
  if (ghost) add('borda-e-sombra', 'AVISO', `${ghost} painéis com borda e sombra ao mesmo tempo`)
  if (radii.size > 3) add('raios', 'AVISO', [...radii].join(' '))

  // 10. Números sem algarismos tabulares.
  const nums = [...M.querySelectorAll('*')].filter(
    (el) => el.children.length === 0 && vis(el) && /\d[\d.,:]*\s*(%|KB|GB|h|min|R\$)?/.test(el.textContent ?? '') && /^[\d\s.,:%R$+−-]+[A-Za-z%]{0,3}$/.test((el.textContent ?? '').trim()),
  )
  const tab = nums.filter((el) => getComputedStyle(el).fontVariantNumeric.includes('tabular-nums')).length
  if (nums.length >= 4 && tab / nums.length < 0.5) add('tabular', 'AVISO', `${tab} de ${nums.length} números com tabular-nums`)

  // 11. Texto colado à borda da janela.
  const edge = phone ? 12 : 16
  const glued = [...M.querySelectorAll('p, h1, h2, h3, li, a, button')].filter((el) => {
    if (!vis(el) || scrolls(el)) return false
    const r = el.getBoundingClientRect()
    return r.left < edge - 0.5 || r.right > W - edge + 0.5
  })
  if (glued.length) add('borda', 'AVISO', glued.slice(0, 5).map(name).join('; '))

  // 12. Imagem quebrada.
  const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && vis(i))
  if (broken.length) add('imagem-quebrada', 'FALHA', broken.map((i) => i.src).join(', '))

  // 13. Quantos controles "de peso máximo" (preenchidos, fora do tom do fundo) disputam a primeira dobra.
  const loud = [...M.querySelectorAll('a, button')].filter((el) => {
    if (!vis(el)) return false
    const r = el.getBoundingClientRect()
    if (r.top > innerHeight || r.height < 32) return false
    const c = rgba(getComputedStyle(el).backgroundColor)
    return c[3] >= 0.9 && ratio(c, ground) >= 3
  })
  if (loud.length > 1) add('acao-dominante', 'AVISO', `${loud.length} controles cheios na dobra: ${loud.map(name).join('; ')}`)

  // 14. Sobreposição: controle de `main` cujo centro está coberto por outro elemento (chat rail, barra fixa, botão
  // flutuante, popover esquecido). É a quebra que o usuário vê como "o chat cobriu a tela".
  const covered = [...M.querySelectorAll('a, button, input, select, textarea, h1, h2')].filter((el) => {
    if (!vis(el)) return false
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + Math.min(r.height / 2, 8)
    if (x < 0 || y < 0 || x > W || y > innerHeight) return false
    const top = document.elementFromPoint(x, y)
    return top && top !== el && !el.contains(top) && !top.contains(el) && !top.closest('dialog, [role=dialog], [role=menu], [popover], .cdk-overlay-container')
  })
  if (covered.length)
    add('sobreposicao', 'FALHA', `${covered.length}: ${covered.slice(0, 6).map((el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 8)); return `${name(el)} sob ${t ? name(t) : '?'}` }).join('; ')}`)

  // 15. Conteúdo principal espremido: `main` mais estreito que o legível ao lado de uma coluna fixa (rail).
  const mainEl = M === document.body ? null : M
  if (mainEl && vis(mainEl) && !phone && mainEl.getBoundingClientRect().width < 560)
    add('main-espremido', 'FALHA', `conteúdo com ${Math.round(mainEl.getBoundingClientRect().width)} px em janela de ${W}`)

  if (typeof semMain !== 'undefined') add('sem-main', 'AVISO', 'sem marco <main>: leitor de tela não pula para o conteúdo')
  return { largura: W, achados: out }
})()
```

## 4. Olhar

Abra **cada** captura com a ferramenta Read: cada largura e cada tema, não só a primeira dobra. Responda por escrito
às sete perguntas de `tela-de-app.md`, seção 9. Se o problema aparece na imagem, ele é real, diga o código o que disser.

## 5. Corrigir e repetir

Corrija os três piores, capture, meça e olhe de novo. **No máximo três rodadas.** Registre cada uma assim:

```
RODADA n (tema, larguras)
Visto em um segundo: …
A pergunta da tela e o bloco que a responde: …
Medição: FALHAs …, AVISOs defendidos …
Três piores (o mais visível primeiro), cada um com a captura e a correção:
1. … 2. … 3. …
```

Se na terceira rodada ainda houver falha, diga sem arredondar. Não esconda nada da medição: nada de `aria-hidden` ou
`display: none` só para passar.
