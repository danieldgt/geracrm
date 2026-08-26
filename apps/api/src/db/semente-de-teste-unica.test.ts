import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * ⚠️ DOIS ARQUIVOS DE TESTE COM O MESMO `codigo` DE SEMENTE — a corrida que só
 * aparece quando o vento sopra certo.
 *
 * Todo teste de banco semeia o seu tenant assim:
 *
 *     INSERT INTO plano (id, codigo, nome) VALUES (<id proprio>, 'plano-cc', …)
 *     ON CONFLICT DO NOTHING
 *
 * `codigo` é ÚNICO. Se outro arquivo já inseriu 'plano-cc' com OUTRO id, o
 * `ON CONFLICT DO NOTHING` engole silenciosamente — e a linha com o id DESTE
 * arquivo nunca existe. O `INSERT INTO tenant` seguinte então estoura com:
 *
 *     insert or update on table "tenant" violates foreign key constraint
 *     "tenant_plano_id_fkey"
 *
 * ⚠️ Nada nesse erro aponta para o outro arquivo, e quem "ganha" depende da
 * ordem de execução em paralelo — então o teste passa isolado e falha na suíte,
 * de forma intermitente. Aconteceu duas vezes neste repositório: uma vez com um
 * plano e de novo em 26/08 com 'plano-cc' e 'modelo-cc', compartilhados por
 * `canal-config.test.ts` e `contato-crud.test.ts`, onde "cc" queria dizer coisas
 * diferentes nos dois.
 *
 * A regra é simples: **código de semente é global, então tem de ser único.**
 */
const SEMENTE = /'((?:plano|modelo)-[a-z0-9-]+)'/g
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ESTE_ARQUIVO = 'semente-de-teste-unica.test.ts'

function codigosPorArquivo(dir: string, mapa = new Map<string, Set<string>>()): Map<string, Set<string>> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { codigosPorArquivo(resolve(dir, ent.name), mapa); continue }
    // ⚠️ O scanner cita códigos de exemplo no próprio comentário — sem esta
    //    linha ele se acusa e o lint nasce vermelho, o que ensina a ignorá-lo.
    if (!ent.name.endsWith('.test.ts') || ent.name === ESTE_ARQUIVO) continue
    const texto = readFileSync(resolve(dir, ent.name), 'utf8')
    for (const m of texto.matchAll(SEMENTE)) {
      const codigo = m[1]!
      if (!mapa.has(codigo)) mapa.set(codigo, new Set())
      mapa.get(codigo)!.add(ent.name)
    }
  }
  return mapa
}

describe('⚠️ Código de semente de teste é único', () => {
  it('nenhum codigo de plano ou modelo é usado por dois arquivos', () => {
    const repetidos = [...codigosPorArquivo(raiz)]
      .filter(([, arquivos]) => arquivos.size > 1)
      .map(([codigo, arquivos]) => `${codigo}: ${[...arquivos].sort().join(', ')}`)

    expect(
      repetidos,
      'Dois arquivos de teste semeiam o MESMO codigo com ids diferentes.\n'
      + 'O ON CONFLICT DO NOTHING engole o segundo insert, e o tenant daquele\n'
      + 'arquivo estoura na foreign key — de forma intermitente, porque depende\n'
      + 'de quem rodar primeiro. Dê um codigo próprio a cada arquivo:\n'
      + repetidos.join('\n'),
    ).toEqual([])
  })
})
