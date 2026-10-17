import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { persona as personaSchema, ALCADA_PADRAO, playbookPadrao, type PlaybookVigente, type SlotQualificacao } from '@geracrm/shared'
import { BLOCO_GLOBAL, montarSistema } from '../instrucao-vendedor.js'
import type { BlocoSistema, DefinicaoFerramentaLlm } from '../porta-llm.js'
import { SUITE_B2B } from './suite-b2b.js'

/**
 * `pnpm --filter @geracrm/api agente:medir-prefixo [-- --politicas arquivo.txt] [--contar] [--json]`
 *
 * Mede o PREFIXO de cache do prompt do vendedor (playbook AM §8.4): bloco
 * GLOBAL + bloco do TENANT (persona, políticas, alçada, playbook publicado) + definições das
 * ferramentas — o que vai para o cache do fornecedor e se paga a cada turno.
 * E acusa CONTEÚDO VOLÁTIL no system: data, hora, ISO, UUID, telefone ou
 * marcadores do turno ("Agora:", `<dados_cliente>`, pedido aberto). Se entrar
 * algo que muda a cada turno, a leitura de cache zera em produção e o custo
 * por conversa sobe sem ninguém mudar nada (ADR-023: o volátil vai na
 * mensagem de operador, depois do breakpoint).
 *
 *   --politicas arquivo.txt   mede com as políticas de um número real (padrão: as da suíte B2B dos evals)
 *   --contar                  conta os tokens de verdade na API da Anthropic (`count_tokens`, gratuita;
 *                             exige ANTHROPIC_API_KEY; nenhuma geração é feita)
 *   --json                    saída em JSON
 *
 * Sem `--contar`, os tokens são ESTIMADOS (≈ 2,17 caracteres/token — a
 * calibração medida pela AM com Claude em pt-BR: 113.245 caracteres viraram
 * 52.257 tokens de cache).
 *
 * Saída 0 = prefixo estável; 1 = conteúdo volátil no system (ou erro).
 */

export const CARACTERES_POR_TOKEN = 2.17
const estimar = (c: number) => Math.round(c / CARACTERES_POR_TOKEN)

export interface Volatil { readonly bloco: string; readonly tipo: string; readonly trecho: string }

/** Padrões que mudam a cada turno/contato e não podem estar no system. */
function padroesVolateis(agora: Date): { tipo: string; re: RegExp }[] {
  const dd = String(agora.getDate()).padStart(2, '0')
  const mm = String(agora.getMonth() + 1).padStart(2, '0')
  const yyyy = String(agora.getFullYear())
  return [
    { tipo: 'data de hoje', re: new RegExp(`\\b${dd}/${mm}(?:/(?:${yyyy}|${yyyy.slice(2)}))?\\b|\\b${yyyy}-${mm}-${dd}\\b`) },
    { tipo: 'data/hora ISO', re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ },
    { tipo: 'UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
    { tipo: 'telefone', re: /(?<!\d)(?:\+?55\s?)?\(?\d{2}\)?\s?9\d{4}-?\d{4}(?!\d)/ },
    { tipo: 'marcador do turno', re: /Agora:|<dados_cliente>|Pedido em aberto nesta conversa|Sem pedido em aberto|Esta é a sua primeira resposta|Memória de conversas anteriores|Resumo da conversa até aqui/ },
  ]
}

export function detectarVolatil(blocos: readonly { nome: string; texto: string }[], agora: Date = new Date()): Volatil[] {
  const out: Volatil[] = []
  for (const b of blocos) {
    for (const p of padroesVolateis(agora)) {
      // UUID nulo/máximo é constante (aparece no `pattern` do JSON Schema de um campo uuid), não volátil.
      const m = [...b.texto.matchAll(new RegExp(p.re.source, `${p.re.flags}g`))]
        .find((x) => !(p.tipo === 'UUID' && /^[0-]+$|^[f-]+$/i.test(x[0])))
      if (m?.index !== undefined) out.push({ bloco: b.nome, tipo: p.tipo, trecho: b.texto.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ') })
    }
  }
  return out
}

export interface RelatorioPrefixo {
  readonly blocos: readonly { nome: string; caracteres: number; tokensEstimados: number; cacheado: boolean }[]
  readonly ferramentas: { quantidade: number; caracteres: number; tokensEstimados: number }
  readonly totalCaracteres: number
  readonly totalTokensEstimados: number
  /** O system montado duas vezes com a mesma configuração saiu idêntico (byte a byte). */
  readonly deterministico: boolean
  readonly volateis: readonly Volatil[]
}

export interface ConfigPrefixo {
  readonly politicas: string
  readonly persona: { nome: string; loja: string }
  readonly slots?: readonly SlotQualificacao[]
  /** O playbook publicado do número — entra no bloco do tenant (P0d). */
  readonly playbook?: PlaybookVigente | null
}

/**
 * Um playbook publicado de referência, com estilo, conduta, roteiro e mensagem de
 * referência preenchidos: o que mais pesa no bloco do tenant e o que mais arrisca
 * trazer algo volátil para o prefixo.
 */
export function playbookDeReferencia(): PlaybookVigente {
  const c = playbookPadrao()
  c.estilo = { tratamento: 'voce', maxCaracteres: 400, maxPerguntas: 1, orientacoes: 'Confirme a quantidade antes de cotar. Ofereça a linha profissional para revenda.' }
  c.qualificacao = [
    { slot: 'tipoCompra', pergunta: 'É para revenda ou para uso próprio?', obrigatorio: true, ativo: true },
    { slot: 'volume', pergunta: 'Quantas caixas você precisa por mês?', obrigatorio: true, ativo: true },
    { slot: 'cidade', pergunta: 'Para qual cidade é a entrega?', obrigatorio: false, ativo: true },
  ]
  c.mensagens = { ...c.mensagens, despedida: 'Obrigada pela preferência, {nome}! Qualquer coisa, é só chamar.' }
  return { versaoId: 'referencia', numero: 3, escopo: 'numero', publicadaEm: '', conteudo: c }
}

export function medirPrefixo(sistema: () => readonly BlocoSistema[], ferramentas: readonly DefinicaoFerramentaLlm[], agora = new Date()): RelatorioPrefixo {
  const s1 = sistema()
  const s2 = sistema()
  const nomes = ['global', 'tenant']
  const blocos = s1.map((b, i) => ({ nome: nomes[i] ?? `bloco${i + 1}`, caracteres: b.texto.length, tokensEstimados: estimar(b.texto.length), cacheado: !!b.cachear }))
  const jsonFerramentas = JSON.stringify(ferramentas)
  const total = s1.reduce((a, b) => a + b.texto.length, 0) + jsonFerramentas.length
  return {
    blocos,
    ferramentas: { quantidade: ferramentas.length, caracteres: jsonFerramentas.length, tokensEstimados: estimar(jsonFerramentas.length) },
    totalCaracteres: total,
    totalTokensEstimados: estimar(total),
    deterministico: JSON.stringify(s1) === JSON.stringify(s2),
    volateis: detectarVolatil([
      ...s1.filter((b) => b.cachear).map((b, i) => ({ nome: nomes[i] ?? `bloco${i + 1}`, texto: b.texto })),
      { nome: 'ferramentas', texto: jsonFerramentas },
    ], agora),
  }
}

/** O system do vendedor para uma configuração (o mesmo `montarSistema` do turno). */
export function sistemaDoVendedor(c: ConfigPrefixo, capacidades = { catalogo: true, pedido: true, conhecimento: true }): () => readonly BlocoSistema[] {
  return () => montarSistema({
    persona: personaSchema.parse(c.persona), politicas: c.politicas, objetivo: 'vender', slots: c.slots ?? [], alcada: ALCADA_PADRAO, capacidades,
    playbook: c.playbook ?? null,
  })
}

/**
 * As definições de TODAS as ferramentas (catálogo, pedido, cliente, conhecimento, memória).
 * ⚠️ Import dinâmico: a cadeia de `montar.ts` importa `db/index.ts`, que exige DATABASE_URL
 *    no import (o pool é preguiçoso — nada conecta). O prefixo não toca o banco; sem URL no
 *    ambiente, uma fictícia só satisfaz o import.
 */
export async function definicoesDasFerramentas(): Promise<DefinicaoFerramentaLlm[]> {
  process.env.DATABASE_URL ??= 'postgres://medir-prefixo@127.0.0.1:1/sem-banco'
  const { montarFerramentas } = await import('../ferramentas/montar.js')
  const { definicaoParaLlm } = await import('../ferramentas/porta.js')
  const nada = async () => { throw new Error('medir-prefixo não executa ferramentas') }
  const { ferramentas } = montarFerramentas({
    catalogo: { buscar: nada, detalhar: nada, precoEEstoque: nada },
    pedido: { ver: nada, itens: nada, propor: nada, recentes: nada },
    conhecimento: { buscar: nada },
  })
  return ferramentas.map(definicaoParaLlm)
}

async function contarNaAnthropic(sistema: readonly BlocoSistema[], ferramentas: readonly DefinicaoFerramentaLlm[], env: NodeJS.ProcessEnv): Promise<{ soSistema: number; comFerramentas: number; modelo: string }> {
  const modelo = env.MEDIR_MODELO?.trim() || env.IA_MODELO?.split(',')[0]?.trim() || 'claude-opus-5-5'
  const cliente = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY!.trim() })
  const system = sistema.map((b) => ({ type: 'text' as const, text: b.texto }))
  const messages = [{ role: 'user' as const, content: 'oi' }]
  const tools = ferramentas.map((f) => ({ name: f.nome, description: f.descricao, input_schema: f.esquema as Anthropic.Tool.InputSchema }))
  const so = await cliente.messages.countTokens({ model: modelo, system, messages })
  const tudo = await cliente.messages.countTokens({ model: modelo, system, messages, tools })
  return { soSistema: so.input_tokens, comFerramentas: tudo.input_tokens, modelo }
}

export interface IoMedir {
  readonly env: NodeJS.ProcessEnv
  readonly ler: (caminho: string) => Promise<string>
  readonly escrever: (texto: string) => void
  readonly erro: (texto: string) => void
  readonly agora?: Date | undefined
}

export async function executarMedirPrefixo(argv: readonly string[], io: IoMedir): Promise<number> {
  const args = argv.filter((a) => a !== '--')
  const iPol = args.indexOf('--politicas')
  let politicas = SUITE_B2B.politicas
  let origem = 'políticas da suíte B2B dos evals'
  if (iPol >= 0) {
    const arq = args[iPol + 1]
    if (!arq) { io.erro('Uso: agente:medir-prefixo [-- --politicas arquivo.txt] [--contar] [--json]\n'); return 1 }
    try { politicas = await io.ler(resolve(io.env.INIT_CWD ?? process.cwd(), arq)) } catch (e) { io.erro(`não consegui ler ${arq}: ${(e as Error).message}\n`); return 1 }
    origem = arq
  }
  const sistema = sistemaDoVendedor({ politicas, persona: SUITE_B2B.persona, playbook: playbookDeReferencia() })
  const ferramentas = await definicoesDasFerramentas()
  const r = medirPrefixo(sistema, ferramentas, io.agora)

  let contagem: Awaited<ReturnType<typeof contarNaAnthropic>> | { erro: string } | null = null
  if (args.includes('--contar')) {
    if (!io.env.ANTHROPIC_API_KEY?.trim()) contagem = { erro: 'falta ANTHROPIC_API_KEY' }
    else contagem = await contarNaAnthropic(sistema(), ferramentas, io.env).catch((e: unknown) => ({ erro: (e as Error).message.slice(0, 200) }))
  }

  if (args.includes('--json')) {
    io.escrever(`${JSON.stringify({ origem, ...r, ...(contagem ? { contagem } : {}) }, null, 2)}\n`)
  } else {
    const l = [`Prefixo do vendedor (${origem}):`]
    for (const b of r.blocos) l.push(`  ${b.nome.padEnd(12)} ${String(b.caracteres).padStart(6)} caracteres (~${b.tokensEstimados} tokens)${b.cacheado ? ' · ponto de cache' : ''}`)
    l.push(`  ${'ferramentas'.padEnd(12)} ${String(r.ferramentas.caracteres).padStart(6)} caracteres de JSON (~${r.ferramentas.tokensEstimados} tokens, ${r.ferramentas.quantidade} ferramentas)`)
    l.push(`  ${'total'.padEnd(12)} ${String(r.totalCaracteres).padStart(6)} caracteres (~${r.totalTokensEstimados} tokens, estimativa a ${CARACTERES_POR_TOKEN} car./token)`)
    if (contagem && 'erro' in contagem) l.push(`count_tokens indisponível: ${contagem.erro}`)
    else if (contagem) l.push(`count_tokens (${contagem.modelo}): system ${contagem.soSistema} tokens · system + ferramentas ${contagem.comFerramentas} tokens`)
    l.push(r.deterministico ? 'Determinístico: o system sai idêntico para a mesma configuração.' : '⚠️ NÃO determinístico: o system mudou entre duas montagens com a mesma configuração.')
    if (r.volateis.length === 0) l.push('Nada volátil no prefixo.')
    else for (const v of r.volateis) l.push(`⚠️ Volátil no bloco ${v.bloco} (${v.tipo}): …${v.trecho}…`)
    io.escrever(`${l.join('\n')}\n`)
  }
  return r.deterministico && r.volateis.length === 0 ? 0 : 1
}

/** O bloco global é o mesmo para todos os tenants — exportado para o teste conferir que nada volátil entra nele. */
export { BLOCO_GLOBAL }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executarMedirPrefixo(process.argv.slice(2), {
    env: process.env, ler: (c) => readFile(c, 'utf8'),
    escrever: (t) => process.stdout.write(t), erro: (t) => process.stderr.write(t),
  }).then(
    (codigo) => process.exit(codigo),
    (e: unknown) => { process.stderr.write(`agente:medir-prefixo falhou: ${(e as Error).message}\n`); process.exit(1) },
  )
}
