import { spawn } from 'node:child_process'

/**
 * Roda um script filho com a saída em TEMPO REAL.
 *
 * ⚠️ **Por que não `execFile`:** ele acumula todo o `stdout` em memória e só
 * entrega quando o processo TERMINA. Numa amostra de 5 páginas isso é
 * irrelevante — segundos. Na carga histórica completa, que leva horas, significa
 * que o log fica MUDO o tempo todo: nem "▶ Clientes…", nem contagem, nem a linha
 * do modo. De fora, "rodando" e "travado" ficam com exatamente a mesma cara — o
 * mesmo defeito do incidente do número que caiu sem avisar.
 *
 * ⚠️ E havia um segundo problema, pior porque é silencioso: `maxBuffer`. Passou
 * do teto, o Node **MATA o processo filho** com `ENOBUFS`. Ou seja, uma carga
 * longa o bastante seria interrompida no meio pela própria telemetria. Com
 * `stdio` herdado não existe buffer nenhum para estourar.
 */
export interface ResultadoScript {
  readonly ok: boolean
  /** Código de saída do processo. `null` quando morreu por sinal. */
  readonly codigo: number | null
  readonly sinal: NodeJS.Signals | null
}

export function rodarScript(
  comando: string, args: readonly string[], opcoes: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ResultadoScript> {
  return new Promise((resolver) => {
    const filho = spawn(comando, [...args], {
      cwd: opcoes.cwd,
      env: opcoes.env,
      // ⚠️ `inherit`: a saída do filho VAI DIRETO para a nossa — sem buffer, sem
      //    teto, e aparecendo no log no instante em que acontece.
      stdio: ['ignore', 'inherit', 'inherit'],
    })

    // ⚠️ `error` (binário não encontrado, permissão) NÃO dispara `close`.
    //    Sem este ramo, a Promise nunca resolveria e o ciclo travaria para
    //    sempre — o worker ficaria vivo e ocioso, parecendo saudável.
    filho.once('error', () => resolver({ ok: false, codigo: null, sinal: null }))
    filho.once('close', (codigo, sinal) =>
      resolver({ ok: codigo === 0, codigo, sinal }))
  })
}
