import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { encerrarBanco } from '../../../../db/index.js'
import { ExecutorDeCenarios, exigirAmbienteReal, type Cenario, type ProdutoDoCatalogo, type Suite } from './executar-cenario.js'
import { juizDosEvals, MEDIA_MINIMA_SUITE_REAL } from './juiz.js'
import { CENARIOS_B2B, SUITE_B2B } from './cenarios-b2b.js'

/**
 * EVALS DO AGENTE — o laço inteiro, de ponta a ponta, com CATÁLOGO REAL
 * (manual, indexado), PEDIDO REAL e o PIPELINE REAL (fila → portão → gatilhos
 * → ferramentas → guardrails → envio → auditoria). O WhatsApp é falso; o
 * resto é o produto.
 *
 *   - Sem `IA_E2E` (CI): modelo SIMULADO e juiz SIMULADO — determinístico, custo zero.
 *   - `IA_E2E=1`: modelo REAL nos turnos que testam o modelo e juiz REAL com a
 *     rubrica da P12. Manual, custa dinheiro — ver `evals/README.md`.
 *
 * Duas suítes:
 *   1. `cenarios-b2b.ts` — os ≥ 25 cenários B2B da raia P15 (playbook AM §11.4).
 *   2. `conversas-douradas.json` — as douradas da R8 (SaaS e roupas), no mesmo executor.
 *
 * ⚠️ Cada cenário espera FATOS verificáveis (ferramentas chamadas, número
 * presente/ausente, desfecho, marcas de guardrail, estado do pedido), não frases
 * — o modelo real escreve diferente a cada vez; o que não pode mudar é o que ele
 * FEZ. E todo cenário termina com 0 CRÍTICA e passa pelo juiz.
 */
const real = !!process.env.IA_E2E
const TEMPO = real ? 240_000 : 30_000

interface Dourada { id: string; titulo: string; modo?: 'sombra'; perfil?: 'atacado'; turnos: { cliente: string; esperado: Record<string, unknown> }[] }
const aqui = dirname(fileURLToPath(import.meta.url))
const douradas = JSON.parse(readFileSync(resolve(aqui, 'conversas-douradas.json'), 'utf8')) as {
  catalogo: ProdutoDoCatalogo[]; politicas: string; cenarios: Dourada[]
}
const SUITE_DOURADAS: Suite = {
  nome: 'douradas', tenantId: 'b4e40000-0000-4000-8000-000000000001',
  catalogo: douradas.catalogo, politicas: douradas.politicas, persona: { nome: 'Dora', loja: 'Loja Dourada' },
}
const CENARIOS_DOURADOS: readonly Cenario[] = douradas.cenarios.map((d) => ({
  id: d.id, titulo: d.titulo, gherkin: [d.titulo],
  config: { ...(d.modo ? { modo: d.modo } : {}), ...(d.perfil ? { perfil: d.perfil } : {}) },
  turnos: d.turnos.map((t) => ({ cliente: t.cliente, esperado: t.esperado })),
}))

afterAll(async () => { await encerrarBanco() })

describe('Cenários B2B: o catálogo de comportamento não encolhe em silêncio', () => {
  it('há pelo menos 25 cenários, com ids únicos, Gherkin e ao menos um fato verificável por turno', () => {
    expect(CENARIOS_B2B.length).toBeGreaterThanOrEqual(25)
    expect(new Set(CENARIOS_B2B.map((c) => c.id)).size).toBe(CENARIOS_B2B.length)
    for (const c of CENARIOS_B2B) {
      expect(c.gherkin.length, c.id).toBeGreaterThan(0)
      for (const t of c.turnos) expect(Object.keys(t.esperado).length + (t.confere ? 1 : 0), c.id).toBeGreaterThan(0)
    }
  })

  it('cobre a lista da raia P15', () => {
    const exigidos = [
      'abertura-primeiro-turno', 'recompra-ultimo-pedido', 'atacado-preco-da-tabela', 'varejo-preco-da-tabela', 'grade-cor-tamanho',
      'sem-estoque', 'prazo-pela-politica', 'desconto-fora-da-politica', 'cnpj-informado', 'pede-humano', 'procon', 'pare-opt-out',
      'robo-duas-vezes', 'audio-sem-transcricao', 'pergunta-repetida', 'percentual-sem-fonte', 'promessa-filtrada', 'acima-da-alcada',
      'proposta-confirmada', 'sombra-nao-envia', 'assistido-sugere', 'teto-antes-do-modelo', 'teto-depois-do-turno',
      'falha-transitoria', 'falha-fatal', 'fora-do-recorte',
      // Da revisão adversarial: eco do % do cliente e a pausa da qualidade nos dois modos.
      'desconto-eco-do-percentual', 'qualidade-pausa-autonomo', 'qualidade-nao-envie-assistido',
    ]
    expect(CENARIOS_B2B.map((c) => c.id)).toEqual(expect.arrayContaining(exigidos))
  })
})

for (const [suite, cenarios] of [[SUITE_B2B, CENARIOS_B2B], [SUITE_DOURADAS, CENARIOS_DOURADOS]] as const) {
  describe(`Evals ${suite.nome} (${real ? 'modelo REAL + juiz real' : 'modelo simulado + juiz simulado'})`, () => {
    const executor = new ExecutorDeCenarios(suite, { real })
    beforeAll(async () => { await executor.preparar() }, 60_000)
    afterAll(async () => { await executor.encerrar() })

    cenarios.forEach((c, n) => {
      it(`${c.id} — ${c.titulo}`, async () => { await executor.executar(c, n) }, TEMPO)
    })

    // Meta de fase (ADR-031): média do juiz ≥ 4 na suíte. Por cenário o piso é 3 (`MEDIA_MINIMA_REAL`).
    it.skipIf(!real)(`média do juiz real na suíte ≥ ${MEDIA_MINIMA_SUITE_REAL} (meta de fase)`, () => {
      const m = executor.mediaDoJuiz()
      expect(m, 'nenhum cenário foi julgado').not.toBeNull()
      expect(m!.media, `média ${m!.media} em ${m!.cenarios} cenário(s)`).toBeGreaterThanOrEqual(MEDIA_MINIMA_SUITE_REAL)
    })
  })
}

describe('IA_E2E: a rodada real recusa o que não é real', () => {
  it('dado IA_E2E com IA_PROVEDOR=simulado, então recusa com mensagem que diz o porquê', () => {
    expect(() => exigirAmbienteReal({ IA_PROVEDOR: 'simulado' })).toThrow(/IA_PROVEDOR=simulado não é rodada real/)
    expect(() => juizDosEvals(true, { IA_PROVEDOR: 'simulado' })).toThrow(/IA_PROVEDOR=simulado/)
  })

  it('dado IA_E2E sem chave nenhuma, então recusa dizendo a variável que falta', () => {
    expect(() => exigirAmbienteReal({})).toThrow(/ANTHROPIC_API_KEY/)
  })

  it('dado um provedor real configurado, então segue', () => {
    expect(() => exigirAmbienteReal({ IA_PROVEDOR: 'claude', ANTHROPIC_API_KEY: 'chave-de-teste' })).not.toThrow()
  })
})
