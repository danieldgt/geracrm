// Gera `src/app/nucleo/versao.ts` no build.
//
// ⚠️ O arquivo é GERADO e ignorado pelo git: commitá-lo faria todo build local
//    sujar o `git status` com um commit que ninguém escreveu. Por isso todo
//    comando que compila (build, typecheck, test) roda este script antes — o
//    arquivo nunca falta e nunca aparece no diff.
//
// ⚠️ A origem é o commit, não um número de versão à mão: `package.json` diz
//    0.0.0 desde o primeiro dia e ninguém vai lembrar de subir. O que a pessoa
//    precisa responder é "o que está no ar agora?", e a resposta é um SHA.
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = dirname(fileURLToPath(import.meta.url))
const destino = join(aqui, '..', 'src', 'app', 'nucleo', 'versao.ts')

function commit() {
  // No Railway a variável vem do deploy; não há .git dentro do build.
  const doRailway = process.env.RAILWAY_GIT_COMMIT_SHA?.trim()
  if (doRailway) return doRailway.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    // Sem git e sem Railway (tarball, container cru): assume o que é verdade.
    return 'local'
  }
}

// ⚠️ Tipado como `string`, NÃO `as const`: com o literal, o TypeScript sabe o
//    commit desta build e passa a acusar qualquer comparação com outro valor
//    como "sem sobreposição" — o typecheck quebraria a cada build novo.
const conteudo = `// GERADO por scripts/gerar-versao.mjs — não edite, não commite.
export const VERSAO: { readonly commit: string; readonly data: string } = {
  commit: '${commit()}',
  data: '${new Date().toISOString()}',
}
`

mkdirSync(dirname(destino), { recursive: true })
writeFileSync(destino, conteudo)
console.log(`versao: ${commit()}`)
