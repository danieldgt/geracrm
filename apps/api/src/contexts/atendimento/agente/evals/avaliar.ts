import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CRITERIOS_RUBRICA, ROTULO_REGRA_QUALIDADE } from '@geracrm/shared'
import { julgarTranscricao, juizDoAmbiente, type ResultadoJuiz } from '../qualidade/juiz.js'
import type { PortaLlmFerramentas } from '../porta-llm.js'
import { avaliarTranscricao, formatarParaJuiz, parseTranscricao } from './transcricao.js'
import { segredosDoAmbiente, semSegredos } from './segredos.js'

/**
 * `pnpm --filter @geracrm/api agente:avaliar -- <transcricao.txt> [--juiz] [--json] [--politicas arquivo.txt]`
 *
 * Avalia uma transcrição OFFLINE (playbook AM §7.5) com as MESMAS regras de
 * qualidade do pipeline em produção (P12) e, com `--juiz`, com o juiz da
 * rubrica da P12 pelo provedor do ambiente (`IA_QUALIDADE_MODELO`, ou o modelo
 * do provedor; `IA_PROVEDOR=simulado` usa o juiz de regras).
 *
 * Para quê: revisar a conversa que o cliente reclamou, e regressão de prompt
 * ("esta transcrição não pode voltar a ter CRÍTICA").
 *
 * Formato do arquivo em `transcricao.ts` (CLIENTE:/AGENTE:/VENDEDOR:/TOOL: {json}).
 * Caminho relativo é resolvido a partir de onde o comando foi chamado.
 *
 * Código de saída:
 *   0 — sem violação CRÍTICA
 *   2 — há violação CRÍTICA (útil em CI de regressão)
 *   1 — uso errado, arquivo ilegível, ou `--juiz` pedido sem juiz disponível
 */

export const SAIDA_OK = 0
export const SAIDA_ERRO = 1
export const SAIDA_CRITICA = 2

export interface IoAvaliar {
  readonly ler: (caminho: string) => Promise<string>
  readonly escrever: (texto: string) => void
  readonly erro: (texto: string) => void
  readonly env: NodeJS.ProcessEnv
  /** Troca o juiz do ambiente (testes). */
  readonly juiz?: { porta: PortaLlmFerramentas; modelo?: string | undefined } | undefined
}

const USO = 'Uso: pnpm --filter @geracrm/api agente:avaliar -- <transcricao.txt> [--juiz] [--json] [--politicas arquivo.txt]'

export async function executarAvaliar(argv: readonly string[], ioBruto: IoAvaliar): Promise<number> {
  // ⚠️ Com `--juiz`, o erro do fornecedor pode ecoar a chave: TODA saída passa por `semSegredos`.
  const segredos = segredosDoAmbiente(ioBruto.env)
  const io: IoAvaliar = {
    ...ioBruto,
    escrever: (t) => ioBruto.escrever(semSegredos(t, segredos)),
    erro: (t) => ioBruto.erro(semSegredos(t, segredos)),
  }
  const args = argv.filter((a) => a !== '--')
  const iPol = args.indexOf('--politicas')
  const politicasArq = iPol >= 0 ? args[iPol + 1] : undefined
  if (iPol >= 0 && !politicasArq) { io.erro(`${USO}\n`); return SAIDA_ERRO }
  const posicionais = args.filter((a, i) => !a.startsWith('--') && !(iPol >= 0 && i === iPol + 1))
  const arquivo = posicionais[0]
  if (!arquivo || posicionais.length > 1) { io.erro(`${USO}\n`); return SAIDA_ERRO }

  const base = io.env.INIT_CWD ?? process.cwd()
  let conteudo: string
  let politicas = ''
  try {
    conteudo = await io.ler(resolve(base, arquivo))
    if (politicasArq) politicas = await io.ler(resolve(base, politicasArq))
  } catch (e) {
    io.erro(`agente:avaliar: não consegui ler o arquivo: ${(e as Error).message}\n`)
    return SAIDA_ERRO
  }

  const t = parseTranscricao(conteudo)
  // Com `--politicas`, as fontes são conhecidas (políticas + TOOL): as regras de número rodam
  // mesmo sem nenhuma linha TOOL. Sem ele e sem TOOL, fonte desconhecida não vira acusação.
  const regras = avaliarTranscricao(t, politicas ? { fontesFixas: [politicas], fontesConhecidas: true } : {})

  let juiz: ResultadoJuiz | null = null
  if (args.includes('--juiz')) {
    const j = io.juiz ?? (() => {
      const amb = juizDoAmbiente(io.env)
      return amb.porta ? { porta: amb.porta, modelo: amb.modelo } : null
    })()
    if (!j) {
      io.erro(`agente:avaliar --juiz: juiz indisponível — ${juizDoAmbiente(io.env).motivoIndisponivel ?? 'provedor não configurado'}\n`)
      return regras.totais.CRITICA > 0 ? SAIDA_CRITICA : SAIDA_ERRO
    }
    juiz = await julgarTranscricao(j.porta, { transcricao: formatarParaJuiz(t), roteiro: politicas || null, modelo: j.modelo })
  }

  if (args.includes('--json')) {
    io.escrever(`${JSON.stringify({ regras, ...(juiz ? { juiz } : {}) }, null, 2)}\n`)
  } else {
    const linhas: string[] = [
      `Falas: ${t.falas.length} (agente: ${regras.falasDoAgente}) · ferramentas: ${t.falas.filter((f) => f.autor === 'TOOL').length}`
        + (regras.comFontes ? '' : ' (sem TOOL: as regras de número não rodam)'),
    ]
    for (const f of regras.porFala) {
      if (!f.violacoes.length) continue
      linhas.push('', `#${f.indice + 1} AGENTE: ${f.texto.slice(0, 120)}${f.texto.length > 120 ? '…' : ''}`)
      for (const v of f.violacoes) linhas.push(`  [${v.gravidade}] ${ROTULO_REGRA_QUALIDADE[v.regra]}${v.detalhe ? ` (${v.detalhe})` : ''}: ${v.trecho}`)
    }
    linhas.push('', `Totais: CRITICA ${regras.totais.CRITICA} · ALTA ${regras.totais.ALTA} · MEDIA ${regras.totais.MEDIA}`)
    if (juiz?.ok) {
      linhas.push('', `Juiz (${juiz.provedor}/${juiz.modelo}) — média ${juiz.notaMedia}`)
      for (const c of CRITERIOS_RUBRICA) linhas.push(`  ${c}: ${juiz.notas[c].nota}/5 — ${juiz.notas[c].justificativa}`)
    } else if (juiz) linhas.push('', `Juiz falhou: ${juiz.erro}`)
    io.escrever(`${linhas.join('\n')}\n`)
  }
  if (regras.totais.CRITICA > 0) return SAIDA_CRITICA
  return juiz && !juiz.ok ? SAIDA_ERRO : SAIDA_OK
}

// Só roda como script (o teste importa as funções sem disparar o processo).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executarAvaliar(process.argv.slice(2), {
    ler: (c) => readFile(c, 'utf8'),
    escrever: (t) => process.stdout.write(t),
    erro: (t) => process.stderr.write(t),
    env: process.env,
  }).then(
    (codigo) => process.exit(codigo),
    (e: unknown) => { process.stderr.write(`agente:avaliar falhou: ${(e as Error).message}\n`); process.exit(SAIDA_ERRO) },
  )
}
