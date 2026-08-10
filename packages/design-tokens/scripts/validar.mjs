#!/usr/bin/env node
/**
 * Valida `tokens.json`. É o `test` do pacote.
 *
 * ⚠️ Não confere o `dist/` contra o disco: `dist/` é gerado e está no
 *    .gitignore, então essa comparação só provaria que o build acabou de rodar.
 *    O que precisa ser verificado é a FONTE — e principalmente o contraste, que
 *    é a única promessa da identidade visual que dá para falsificar sozinho.
 *
 * Contraste importa aqui mais que na média: o console é usado 8h por dia, com
 * texto denso, e quem opera não vai reclamar de "está um pouco claro" — vai
 * apenas cansar mais rápido e errar mais.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const tokens = JSON.parse(readFileSync(join(raiz, 'tokens.json'), 'utf8'))

const falhas = []
const avisos = []

// --- Achatar e resolver ----------------------------------------------------

function achatar(no, prefixo = [], destino = new Map()) {
  for (const [chave, valor] of Object.entries(no)) {
    if (chave.startsWith('$')) continue
    const caminho = [...prefixo, chave]
    if (valor !== null && typeof valor === 'object' && !Array.isArray(valor)) {
      achatar(valor, caminho, destino)
    } else {
      destino.set(caminho.join('-'), valor)
    }
  }
  return destino
}

const primitivos = achatar(tokens.primitivos)

function resolver(valor, ondeEsta) {
  if (typeof valor !== 'string') return valor
  return valor.replace(/\{([^}]+)\}/g, (_, ref) => {
    const chave = ref.replace(/\./g, '-')
    if (!primitivos.has(chave)) {
      // ⚠️ Referência quebrada não pode virar string literal no CSS:
      // `color: {azul.500}` o navegador ignora em silêncio e o elemento herda a
      // cor do pai. Fica "quase certo", que é o pior lugar para ficar.
      falhas.push(`token inexistente: {${ref}} referenciado em "${ondeEsta}"`)
      return '#FF00FF'
    }
    return primitivos.get(chave)
  })
}

const temas = {}
for (const nome of Object.keys(tokens.semantico)) {
  temas[nome] = new Map(
    [...achatar(tokens.semantico[nome])].map(([k, v]) => [k, resolver(v, `semantico.${nome}.${k}`)]),
  )
}

// --- 1. Os dois temas têm as MESMAS chaves ---------------------------------
// ⚠️ Chave que existe só no claro vira variável indefinida no escuro, e a regra
//    CSS inteira é descartada — some o texto, não só a cor.
{
  const [a, b] = Object.keys(temas)
  const soEm = (x, y) => [...temas[x].keys()].filter((k) => !temas[y].has(k))
  for (const k of soEm(a, b)) falhas.push(`"${k}" existe em ${a} e falta em ${b}`)
  for (const k of soEm(b, a)) falhas.push(`"${k}" existe em ${b} e falta em ${a}`)
}

// --- 2. Toda cor é hex válido ----------------------------------------------

for (const [tema, mapa] of Object.entries(temas)) {
  for (const [chave, valor] of mapa) {
    if (typeof valor === 'string' && valor.startsWith('#') && !/^#[0-9A-Fa-f]{6}$/.test(valor)) {
      falhas.push(`${tema}.${chave}: "${valor}" não é hex de 6 dígitos`)
    }
  }
}

// --- 3. Contraste WCAG ------------------------------------------------------

const canal = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
function luminancia(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b)
}
function contraste(a, b) {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** [frente, fundo, mínimo, motivo] */
const paresObrigatorios = [
  ['texto', 'fundo', 4.5, 'texto corrido'],
  ['texto', 'superficie', 4.5, 'texto sobre painel'],
  ['texto', 'superficie-elevada', 4.5, 'texto em modal e dropdown'],
  ['texto-secundario', 'fundo', 4.5, 'rótulo e metadado'],
  ['texto-secundario', 'superficie', 4.5, 'rótulo sobre painel'],
  ['acao-texto', 'acao', 4.5, 'texto dentro do botão primário'],
  ['erro', 'fundo', 4.5, 'mensagem de erro'],
  // ⚠️ Elementos gráficos: o mínimo é 3.0, não 4.5 (WCAG 1.4.11).
  ['borda-foco', 'fundo', 3.0, 'anel de foco — é o que guia quem navega por teclado'],
  // ⚠️ A borda que IDENTIFICA o controle (contorno de campo de formulário)
  //    carrega informação: sem ela não dá para saber onde o campo começa. O
  //    separador estrutural (`borda-forte`) não carrega, e por isso NÃO entra
  //    nesta lista — exigir 3:1 dele deixaria toda divisória pesada e mataria a
  //    densidade, que é o ponto da ferramenta.
  ['borda-controle', 'fundo', 3.0, 'contorno de campo — delimita onde clicar e digitar'],
]

for (const [tema, mapa] of Object.entries(temas)) {
  for (const [frente, fundo, minimo, motivo] of paresObrigatorios) {
    const a = mapa.get(frente)
    const b = mapa.get(fundo)
    if (!a || !b) { falhas.push(`${tema}: par de contraste "${frente}/${fundo}" tem token faltando`); continue }
    const razao = contraste(a, b)
    if (razao < minimo) {
      falhas.push(
        `${tema}: ${frente} sobre ${fundo} = ${razao.toFixed(2)}:1, abaixo de ${minimo}:1 (${motivo})`,
      )
    }
  }
}

// Avisos: abaixo do ideal, mas não é falha de acessibilidade.
// `texto-suave` é placeholder e dica — não carrega informação essencial. E
// `borda-forte` é separador: some abaixo de 1.4:1, e aí não separa nada.
for (const [tema, mapa] of Object.entries(temas)) {
  for (const [chave, piso] of [['texto-suave', 3.0], ['borda-forte', 1.4]]) {
    const razao = contraste(mapa.get(chave), mapa.get('fundo'))
    if (razao < piso) avisos.push(`${tema}: ${chave} sobre fundo = ${razao.toFixed(2)}:1 (piso prático ${piso}:1)`)
  }
}

// --- 4. A rampa RFV é contínua e distinguível ------------------------------
// ⚠️ A posição na rampa informa ANTES da leitura. Dois degraus vizinhos
//    indistinguíveis quebram justamente isso — e o rótulo, que sempre existe,
//    mascara o problema em revisão de tela.
{
  const rfv = [...achatar(tokens.rfv)].map(([k, v]) => [k, resolver(v, `rfv.${k}`)])
  for (let i = 1; i < rfv.length; i += 1) {
    const [nomeA, corA] = rfv[i - 1]
    const [nomeB, corB] = rfv[i]
    if (corA === corB) falhas.push(`rfv: "${nomeA}" e "${nomeB}" são a MESMA cor (${corA})`)
  }
  const distintas = new Set(rfv.map(([, v]) => v))
  if (distintas.size !== rfv.length) falhas.push(`rfv: ${rfv.length} degraus para ${distintas.size} cores distintas`)
}

// --- Resultado --------------------------------------------------------------

for (const a of avisos) console.warn(`⚠ ${a}`)

if (falhas.length > 0) {
  for (const f of falhas) console.error(`✗ ${f}`)
  console.error(`\n${falhas.length} problema(s) em tokens.json.`)
  process.exit(1)
}

const nPares = Object.keys(temas).length * paresObrigatorios.length
console.log(
  `✓ tokens válidos — ${primitivos.size} primitivos, ${Object.keys(temas).length} temas, ` +
    `${nPares} pares de contraste conferidos`,
)
