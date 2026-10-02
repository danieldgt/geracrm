import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import postgres from 'postgres'
import { encerrarBanco, comTenantServico } from '../../../../db/index.js'
import { criarProdutoManual } from '../../../catalogo/escrita-manual.js'
import { reindexarTenant } from '../../../catalogo/indexador.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import { LlmSimulado } from '../llm-simulado.js'
import { ligacoesPadrao } from '../ferramentas/ligacoes.js'
import { llmFerramentasDoAmbiente } from '../fabrica-ferramentas.js'
import type { PortaLlmFerramentas } from '../porta-llm.js'

/**
 * CONVERSAS DOURADAS — o laço inteiro, de ponta a ponta, com CATÁLOGO REAL
 * (manual, indexado) e PEDIDO REAL: fila → portão → ferramentas → guardrail →
 * envio → auditoria. O WhatsApp é falso; tudo o mais é o produto.
 *
 * - Sem `IA_E2E`: roda com o modelo SIMULADO (determinístico, CI).
 * - Com `IA_E2E=1` e chave: roda com o modelo REAL — manual, custa dinheiro,
 *   e é o que diz se o prompt e as ferramentas funcionam de verdade.
 *
 * ⚠️ Cada cenário espera FATOS verificáveis (ferramentas chamadas, número
 * presente/ausente, desfecho, estado do pedido), não frases — o modelo real
 * escreve diferente a cada vez; o que não pode mudar é o que ele FEZ.
 */
interface Esperado {
  ferramentas?: string[]; contem?: string[]; naoContem?: string[]
  desfecho?: string; handoff?: string; pedidoEstado?: string; enviadas?: number
}
interface Cenario { id: string; titulo: string; modo?: string; perfil?: string; turnos: { cliente: string; esperado: Esperado }[] }
const aqui = dirname(fileURLToPath(import.meta.url))
const douradas = JSON.parse(readFileSync(resolve(aqui, 'conversas-douradas.json'), 'utf8')) as {
  catalogo: Parameters<typeof criarProdutoManual>[1][]; politicas: string; cenarios: Cenario[]
}

const T = 'b4e40000-0000-4000-8000-000000000001'
const PV = 'b4e40000-1111-4000-8000-000000000001'
const PLANO = 'b4e40000-3333-4000-8000-000000000001'
const MODELO = 'b4e40000-4444-4000-8000-000000000001'
const CANAL = 'b4e40000-5555-4000-8000-000000000001'
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }
const real = !!process.env.IA_E2E
const llm: PortaLlmFerramentas = real ? llmFerramentasDoAmbiente() : new LlmSimulado()

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-evals-agente', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-evals-agente', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Evals', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${T}, ${CANAL}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  await comTenantServico(T, async (tx) => {
    for (const p of douradas.catalogo) {
      const r = await criarProdutoManual(tx, p)
      if (!r.ok && r.falha.erro !== 'catalogo.referencia_duplicada') throw new Error(`seed: ${r.falha.erro}`)
    }
    await reindexarTenant(tx, { tenantId: T, lote: 100 })
  })
})
afterAll(async () => {
  for (const t of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'pedido_proposta', 'pedido_item', 'pedido', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'produto_indice', 'sku_preco', 'sku_saldo', 'sku', 'produto', 'tabela_preco', 'canal_configuracao', 'canal_conectado', 'outbox']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

async function prepararCenario(c: Cenario, n: number) {
  const contato = `b4e40000-6666-4000-8000-${String(n + 1).padStart(12, '0')}`
  const conversa = `b4e40000-7777-4000-8000-${String(n + 1).padStart(12, '0')}`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo, perfil_preco) VALUES (${T}, ${contato}, ${`Cliente ${c.id}`}, true, ${c.perfil ?? null}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${contato}, 1, ${`55859999${String(n + 1).padStart(5, '0')}`}, ${`55859999${String(n + 1).padStart(5, '0')}`}, true, true, 'teste') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${conversa}, ${CANAL}, ${contato}, 1) ON CONFLICT DO NOTHING`
  await dono`
    INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona)
    VALUES (${T}, ${CANAL}, true, ${c.modo ?? 'autonomo'}, ${douradas.politicas}, false, false, '{"nome":"Dora","loja":"Loja Dourada"}'::jsonb)
    ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`
  return { contato, conversa }
}

describe(`Conversas douradas (${real ? 'modelo REAL' : 'modelo simulado'})`, () => {
  douradas.cenarios.forEach((c, n) => {
    it(`${c.id} — ${c.titulo}`, async () => {
      const { conversa } = await prepararCenario(c, n)
      const enviadas: string[] = []
      const enviar = (async (_t: string, _c: string, texto: string) => {
        enviadas.push(texto)
        const id = crypto.randomUUID()
        await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em)
                   VALUES (${T}, ${id}, ${conversa}, 'saliente', 'texto', ${JSON.stringify({ texto, automatica: 'agente' })}::text::jsonb, 'enviada', now())`
        return { ok: true, conversaId: conversa, mensagemId: id }
      }) as never
      for (const turno of c.turnos) {
        const antes = enviadas.length
        const mensagemId = crypto.randomUUID()
        await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
                   VALUES (${T}, ${mensagemId}, ${conversa}, 'entrante', 'texto', ${JSON.stringify({ texto: turno.cliente })}::text::jsonb, now())`
        const r = await conduzirTurnoVendedor(
          { tenant_id: T, id: crypto.randomUUID(), conversa_id: conversa, canal_id: CANAL, mensagens_ids: [mensagemId], tentativas: 1, executar_em: new Date() },
          { llm, ligacoes: ligacoesPadrao, enviar },
        )
        const e = turno.esperado
        const texto = (r.mensagens ?? []).join('\n')
        const nomes = (r.rastro?.chamadas ?? []).map((ch) => ch.nome)
        const contexto = `[${c.id}] cliente="${turno.cliente}" → desfecho=${r.desfecho} motivo=${r.motivo ?? ''} ferramentas=${nomes.join(',')} texto="${texto.slice(0, 200)}"`
        if (e.desfecho) expect(r.desfecho, contexto).toBe(e.desfecho)
        if (e.handoff) expect(r.handoff?.motivo, contexto).toBe(e.handoff)
        for (const f of e.ferramentas ?? []) expect(nomes, contexto).toContain(f)
        for (const s of e.contem ?? []) expect(texto, contexto).toContain(s)
        for (const s of e.naoContem ?? []) expect(texto, contexto).not.toContain(s)
        if (e.enviadas !== undefined) expect(enviadas.length - antes, contexto).toBe(e.enviadas)
        if (e.pedidoEstado) {
          const [p] = await dono<{ estado: string }[]>`SELECT estado FROM pedido WHERE tenant_id = ${T} AND conversa_id = ${conversa} ORDER BY criado_em DESC LIMIT 1`
          expect(p?.estado, contexto).toBe(e.pedidoEstado)
        }
        // Guardrail: nenhuma decisão deste turno pode ter bloqueado número e ainda assim enviado.
        const [d] = await dono<{ numeros_bloqueados: number[]; enviada: boolean }[]>`
          SELECT numeros_bloqueados, enviada FROM agente_decisao WHERE tenant_id = ${T} AND conversa_id = ${conversa} ORDER BY criado_em DESC LIMIT 1`
        if (d && d.numeros_bloqueados.length > 0) expect(texto, contexto).not.toMatch(/R\$\s?\d/)
      }
    }, real ? 120_000 : 20_000)
  })
})
