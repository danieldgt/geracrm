#!/usr/bin/env node
/**
 * Gera os artefatos de tema a partir de `tokens.json`.
 *
 * ⚠️ `tokens.json` é a ÚNICA fonte. O CSS e o JS aqui são derivados e entram no
 *    repositório gerados: o console Angular importa o CSS direto, e um artefato
 *    gerado em tempo de build de cada app faria a cor divergir entre console e
 *    app conforme a ordem dos builds.
 *
 * `--check` não escreve nada: falha se o que está no disco difere do que seria
 * gerado agora. É o que impede alguém de editar o CSS derivado à mão — a edição
 * some no build seguinte, e some sem avisar.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const conferir = process.argv.includes('--check')

const tokens = JSON.parse(readFileSync(join(raiz, 'tokens.json'), 'utf8'))

/** Chaves de documentação não viram token. */
const ehComentario = (chave) => chave.startsWith('$')

/**
 * Achata a árvore em pares `caminho-com-hifen` → valor.
 * ⚠️ Preserva a ordem de `tokens.json` para o diff do CSS gerado ficar legível:
 * saída reordenada transforma "mudei uma cor" em "mudei o arquivo inteiro".
 */
function achatar(no, prefixo = [], destino = new Map()) {
  for (const [chave, valor] of Object.entries(no)) {
    if (ehComentario(chave)) continue
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

/**
 * Resolve referências `{azul.500}` contra os primitivos.
 * ⚠️ Referência quebrada é ERRO, não string literal no CSS: `color: {azul.500}`
 *    é ignorado silenciosamente pelo navegador, e o elemento herda a cor do pai.
 *    O resultado parece "quase certo" e ninguém procura.
 */
function resolver(valor, ondeEsta) {
  if (typeof valor !== 'string') return valor
  return valor.replace(/\{([^}]+)\}/g, (_, ref) => {
    const chave = ref.replace(/\./g, '-')
    if (!primitivos.has(chave)) {
      throw new Error(
        `token inexistente: {${ref}} referenciado em "${ondeEsta}". ` +
          `Primitivos disponíveis começam com: ${[...primitivos.keys()].slice(0, 5).join(', ')}…`,
      )
    }
    return primitivos.get(chave)
  })
}

const cssDe = (mapa, indent = '  ') =>
  [...mapa].map(([k, v]) => `${indent}--${k}: ${resolver(v, k)};`).join('\n')

// --- CSS -------------------------------------------------------------------

const compartilhados = new Map()
for (const grupo of ['rfv', 'janela', 'tipografia', 'espacamento', 'raio', 'elevacao', 'movimento', 'densidade']) {
  if (tokens[grupo]) achatar({ [grupo]: tokens[grupo] }, [], compartilhados)
}

const css = `/* GERADO por scripts/build.mjs a partir de tokens.json — NÃO EDITE.
 * Editar aqui funciona até o próximo build, e aí some sem aviso.
 * Direção e justificativa: docs/identidade-visual.md · ADR-012. */

:root {
${cssDe(achatar(tokens.semantico.claro))}

${cssDe(compartilhados)}
}

/* ⚠️ O tema escuro redefine APENAS as cores semânticas. Primitivos, espaçamento
 * e tipografia não mudam com o tema — redefini-los aqui abriria a porta para o
 * escuro divergir do claro em coisas que não são cor. */
:root[data-tema='escuro'] {
${cssDe(achatar(tokens.semantico.escuro))}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-tema='claro']) {
${cssDe(achatar(tokens.semantico.escuro), '    ')}
  }
}
`

// --- JS (Expo / NativeWind, que não lê custom property CSS) ----------------

const js = `// GERADO por scripts/build.mjs a partir de tokens.json — NÃO EDITE.
// ⚠️ Existe porque o app Expo não lê custom property CSS. Mesma fonte, formato
// diferente — nunca uma segunda lista de cores mantida à mão.
export const tokens = ${JSON.stringify(
  {
    claro: Object.fromEntries([...achatar(tokens.semantico.claro)].map(([k, v]) => [k, resolver(v, k)])),
    escuro: Object.fromEntries([...achatar(tokens.semantico.escuro)].map(([k, v]) => [k, resolver(v, k)])),
    ...Object.fromEntries(
      ['rfv', 'janela', 'tipografia', 'espacamento', 'raio', 'elevacao', 'movimento', 'densidade']
        .filter((g) => tokens[g])
        .map((g) => [g, Object.fromEntries([...achatar(tokens[g])].map(([k, v]) => [k, resolver(v, k)]))]),
    ),
  },
  null,
  2,
)}
`

// --- .d.ts (nomes de token tipados) ----------------------------------------

const nomesCss = [...achatar(tokens.semantico.claro).keys(), ...compartilhados.keys()]
const dts = `// GERADO por scripts/build.mjs a partir de tokens.json — NÃO EDITE.
// Nomes de token tipados: um \`var(--cor)\` inventado quebra o typecheck, não a tela.

/** Toda custom property emitida em tokens.css. */
export type NomeTokenCss =
${nomesCss.map((n) => `  | '--${n}'`).join('\n')}

export type GrupoTokens = Record<string, string>
export declare const tokens: {
  readonly claro: GrupoTokens
  readonly escuro: GrupoTokens
  readonly [grupo: string]: GrupoTokens
}
`

// --- Escrita ou conferência ------------------------------------------------

const saidas = [
  ['dist/tokens.css', css],
  ['dist/tokens.js', js],
  ['dist/tokens.d.ts', dts],
]

if (!conferir && !existsSync(join(raiz, 'dist'))) mkdirSync(join(raiz, 'dist'))

let divergencias = 0
for (const [caminhoRelativo, conteudo] of saidas) {
  const caminho = join(raiz, caminhoRelativo)
  if (conferir) {
    const atual = existsSync(caminho) ? readFileSync(caminho, 'utf8') : null
    if (atual !== conteudo) {
      divergencias += 1
      console.error(
        atual === null
          ? `✗ ${caminhoRelativo} não existe — rode: pnpm --filter @geracrm/design-tokens build`
          : `✗ ${caminhoRelativo} está desatualizado em relação a tokens.json`,
      )
    }
  } else {
    writeFileSync(caminho, conteudo)
    console.log(`✓ ${caminhoRelativo}`)
  }
}

if (conferir) {
  if (divergencias > 0) {
    console.error(`\n${divergencias} artefato(s) fora de sincronia com tokens.json.`)
    process.exit(1)
  }
  console.log(`✓ tokens em sincronia (${primitivos.size} primitivos, ${saidas.length} artefatos)`)
}
