import { describe, it, expect } from 'vitest'
import { rodarScript } from './rodar-script.js'

/**
 * ⚠️ Roda processos DE VERDADE (`node -e`), sem rede e sem banco. O que está
 * sendo guardado aqui é justamente o que o `execFile` fazia errado: terminar,
 * falhar e sumir — os três precisam RESOLVER a Promise. Um caminho que não
 * resolve deixa o ciclo do integrador pendurado para sempre, com o worker vivo
 * e ocioso, parecendo saudável.
 */
const opcoes = { cwd: process.cwd(), env: process.env }

describe('Execução de script filho', () => {
  it('sucesso devolve ok e código 0', async () => {
    const r = await rodarScript('node', ['-e', 'console.log("oi")'], opcoes)
    expect(r).toMatchObject({ ok: true, codigo: 0 })
  })

  it('saída diferente de zero NÃO é exceção — é resultado', async () => {
    // A integração degrada, não quebra: o ciclo seguinte tem de acontecer.
    const r = await rodarScript('node', ['-e', 'process.exit(3)'], opcoes)
    expect(r).toMatchObject({ ok: false, codigo: 3 })
  })

  /**
   * ⚠️ `error` (binário inexistente, sem permissão) não dispara `close`. Sem o
   * ramo próprio, a Promise ficaria pendente e o integrador pararia em silêncio.
   */
  it('comando que não existe resolve como falha, em vez de pendurar', async () => {
    const r = await rodarScript('binario-que-nao-existe-mesmo', [], opcoes)
    expect(r.ok).toBe(false)
  })

  it('processo morto por sinal informa o sinal', async () => {
    const r = await rodarScript(
      'node', ['-e', 'process.kill(process.pid, "SIGTERM")'], opcoes)
    expect(r.ok).toBe(false)
    expect(r.sinal).toBe('SIGTERM')
  })
})
