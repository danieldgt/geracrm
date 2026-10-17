import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import postgres from 'postgres'
import { textoAbertura, type MarcaGuardrail } from '@geracrm/shared'
import { comTenantServico } from '../../../../db/index.js'
import { criarProdutoManual } from '../../../catalogo/escrita-manual.js'
import { reindexarTenant } from '../../../catalogo/indexador.js'
import { confirmarPedidoPorResposta } from '../../../pedido/confirmacao-pedido.js'
import { contatoBloqueado } from '../../../crm/opt-out.js'
import { processarTarefasDoAgente } from '../../../../workers/agente.js'
import { conduzirTurnoVendedor, type ResultadoTurnoVendedor } from '../vendedor.js'
import { agendarTurno } from '../fila.js'
import { MAX_TENTATIVAS_TRANSCRICAO } from '../../../../workers/transcricao.js'
import { LlmSimulado } from '../llm-simulado.js'
import { ligacoesPadrao } from '../ferramentas/ligacoes.js'
import { sincronizarPoliticas } from '../conhecimento/indexador.js'
import { faltaParaLlmFerramentas, llmFerramentasDoAmbiente } from '../fabrica-ferramentas.js'
import { VERSAO_PADRAO } from '../privacidade.js'
import type { PortaLlmFerramentas } from '../porta-llm.js'
import type { MotivoFalhaLlm } from '../porta.js'
import { LlmContado, LlmQueFalha, LlmRoteirizado, type CustoRoteiro, type Roteiro } from './roteiro.js'
import { criticasDoCenario, type FalaTranscrita } from './transcricao.js'
import { juizDosEvals, julgarCenario, reprovacoesDoJuiz } from './juiz.js'

/**
 * O EXECUTOR DOS CENÁRIOS — o laço INTEIRO, com banco real, catálogo real
 * (manual, indexado), pedido real e o PIPELINE REAL do vendedor
 * (`conduzirTurnoVendedor` ou a fila + worker). Só o WhatsApp é falso (o envio
 * é capturado) e, fora do `IA_E2E`, o modelo.
 *
 * Cada turno confere FATOS (desfecho, motivo do handoff, ferramentas, texto
 * presente/ausente, quantas mensagens saíram, marcas de guardrail na decisão,
 * estado do pedido) — nunca a frase exata do modelo real. E todo cenário passa,
 * no fim, por duas réguas comuns:
 *   1. 0 CRÍTICA — as regras de qualidade da P12 sobre o que o agente DISSE
 *      (`avaliarTranscricao`, com as ferramentas como fonte) e nenhuma pausa
 *      `regras-qualidade` CRÍTICA no pipeline. Marca de correção (o guardrail
 *      que barrou um "15%") é esperada e não conta: conta o que ESCAPOU.
 *   2. o juiz com a rubrica da P12 (simulado no CI; real com `IA_E2E=1`),
 *      sem a abertura fixa da P4 — julga a resposta, não o texto do sistema.
 */

// ── contrato dos cenários ───────────────────────────────────────────────────

export interface ProdutoDoCatalogo {
  readonly referencia: string
  readonly descricao: string
  readonly categoria?: string
  readonly descricaoLonga?: string
  readonly skus: readonly {
    readonly atributos: Readonly<Record<string, string>>
    readonly precos: Readonly<Record<string, number>>
    readonly saldo: number | null
  }[]
}

export interface Suite {
  readonly nome: string
  /** UUID do tenant de teste (exclusivo da suíte). Os outros ids derivam dele. */
  readonly tenantId: string
  readonly catalogo: readonly ProdutoDoCatalogo[]
  readonly politicas: string
  readonly persona: { readonly nome: string; readonly loja: string }
}

export type ModeloDoTurno =
  /** O `LlmSimulado` no CI; o modelo do ambiente com `IA_E2E`. */
  | { readonly tipo: 'simulado' }
  /**
   * Roteiro no CI; com `IA_E2E`, o modelo real — a não ser que `forcado`: aí o
   * roteiro vale sempre (o cenário testa o PIPELINE sobre uma saída ruim, não o modelo).
   */
  | { readonly tipo: 'roteiro'; readonly roteiro: Roteiro; readonly forcado?: boolean; readonly custo?: CustoRoteiro }
  /** O provedor falha com este motivo (sempre, nos dois modos). */
  | { readonly tipo: 'falha'; readonly motivo: MotivoFalhaLlm }

export interface Esperado {
  readonly desfecho?: ResultadoTurnoVendedor['desfecho']
  /** Motivo do handoff gravado na decisão. */
  readonly handoff?: string
  /** O modelo foi chamado neste turno? (`false` = o pipeline decidiu antes do LLM, custo zero) */
  readonly llm?: boolean
  readonly ferramentas?: readonly string[]
  readonly contem?: readonly string[]
  readonly naoContem?: readonly string[]
  /** Quantas mensagens o gateway aceitou neste turno. */
  readonly enviadas?: number
  /** Marcas que alguma decisão do turno TEM: `etapa/codigo` (ou `etapa/*`). */
  readonly marcas?: readonly string[]
  readonly semMarcas?: readonly string[]
  /** A 1ª mensagem é a abertura fixa da P4 (true) ou não há abertura no turno (false). */
  readonly abertura?: boolean
  readonly pedidoEstado?: string
  /** Modo gravado na decisão (o EFETIVO do turno). */
  readonly modo?: string
  readonly falhaTipo?: string
  /** A tarefa da fila voltou a pendente para daqui a N ms (política de falha transitória). */
  readonly reagendadaEmMs?: number
}

export interface Turno {
  /** Texto do cliente. Sem ele (e sem áudio), o turno só roda a fila (retentativa). */
  readonly cliente?: string
  /** Áudio sem transcrição: ainda transcrevendo, ou a transcrição desistiu. */
  readonly audio?: 'pendente' | 'falhou'
  readonly modelo?: ModeloDoTurno
  /** Pela fila + worker (`workerDoTenant`), em vez de chamar o turno direto. */
  readonly viaFila?: boolean
  /** Avança o relógio deste turno (retentativa da fila). */
  readonly avancarMs?: number
  /** Ajuste antes do turno (ex.: o dono baixa o teto da conversa). */
  readonly antes?: (c: ContextoCenario) => Promise<void>
  readonly esperado: Esperado
  /** Esperado que só vale com o modelo simulado (texto do roteiro/simulado). */
  readonly esperadoSimulado?: Esperado
  /** Verificações extras, no banco, depois do turno. */
  readonly confere?: (c: ContextoCenario, t: ObservadoTurno) => Promise<void>
  /**
   * O turno EXISTE para provar a pausa por CRÍTICA da qualidade (P12): a marca
   * `regras-qualidade` CRÍTICA é o esperado, e o que o agente produziu neste turno
   * (a sugestão marcada "não envie") fica fora da régua 0 CRÍTICA e do juiz. Só com
   * a marca de pausa/`nao_envie` conferida em `esperado.marcas`.
   */
  readonly criticaEsperada?: boolean
}

export interface ConfigCenario {
  readonly modo?: 'autonomo' | 'assistido' | 'sombra'
  readonly perfil?: 'atacado' | 'varejo'
  readonly alcada?: { valorMaxAutonomoCentavos: number; descontoMaxPct: number; efetivaSozinho: boolean }
  readonly recorte?: unknown
  readonly tetoSessaoCentavos?: number
  /** Slots do canal (`agente_config.qualificacao`). */
  readonly qualificacao?: readonly string[]
  /**
   * O contato já tem aviso de privacidade VIGENTE (padrão: sim). Só o cenário
   * cujo objeto é a abertura começa sem — senão todo 1º turno autônomo leva a
   * abertura como prefixo e mistura dois assuntos.
   */
  readonly semAvisoPrivacidade?: boolean
  /** Pedido anterior do contato (recompra). */
  readonly pedidoAnterior?: { readonly totalCentavos: number; readonly estado: string }
}

export interface Cenario {
  readonly id: string
  readonly titulo: string
  /** O comportamento em Gherkin (playbook AM §11.4): dado / quando / então. */
  readonly gherkin: readonly string[]
  readonly config?: ConfigCenario
  readonly turnos: readonly Turno[]
}

export interface ContextoCenario {
  readonly dono: postgres.Sql
  readonly tenantId: string
  readonly canalId: string
  readonly contatoId: string
  readonly conversaId: string
  readonly nomeContato: string
}

export interface ObservadoTurno {
  readonly resultado: ResultadoTurnoVendedor | null
  readonly decisoes: readonly DecisaoLida[]
  /** O que o gateway aceitou neste turno. */
  readonly enviadas: readonly string[]
  /** O que o agente produziu: as mensagens do turno (enviadas, ou a sugestão em sombra/assistido). */
  readonly saida: readonly string[]
  readonly ferramentas: readonly { nome: string; saida: unknown }[]
  readonly llmChamado: boolean
}

interface DecisaoLida {
  readonly id: string
  readonly desfecho: string
  readonly modo: string
  readonly handoff_motivo: string | null
  readonly guardrails: MarcaGuardrail[]
  readonly ferramentas: { nome: string; saida: unknown }[]
  readonly falha_tipo: string | null
  readonly resposta: { mensagens?: string[] } | null
}

export interface ResultadoCenario {
  readonly falas: readonly FalaTranscrita[]
  readonly notaJuiz: number | null
}

// ── ids e semeadura ─────────────────────────────────────────────────────────

/** Troca o 2º grupo do UUID da suíte: `aaaaaaaa-0000-…` → `aaaaaaaa-<grupo>-…`, com o sufixo `n`. */
function idDa(suite: Suite, grupo: string, n = 1): string {
  const [a, , c, d] = suite.tenantId.split('-')
  return `${a}-${grupo}-${c}-${d}-${String(n).padStart(12, '0')}`
}
const ids = (suite: Suite) => ({
  tenant: suite.tenantId, perfilVertical: idDa(suite, '1111'), plano: idDa(suite, '3333'), modelo: idDa(suite, '4444'), canal: idDa(suite, '5555'),
})

const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }
const TABELAS_DO_TENANT = [
  'agente_avaliacao', 'agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_retorno', 'conhecimento_trecho',
  'conhecimento_documento_versao', 'conhecimento_documento', 'cliente_memoria', 'aviso_privacidade', 'agente_config',
  'notificacao', 'atendimento', 'pedido_proposta', 'pedido_item', 'pedido', 'mensagem', 'conversa', 'lista_bloqueio',
  'consentimento_contato', 'contato_telefone', 'contato', 'produto_indice', 'sku_preco', 'sku_saldo', 'sku', 'produto',
  'tabela_preco', 'canal_configuracao', 'canal_conectado', 'alerta', 'outbox',
]

/**
 * `IA_E2E=1` é a rodada REAL: modelo e juiz de verdade. Com `IA_PROVEDOR=simulado` (ou sem
 * provedor) a fábrica devolveria o vendedor de regras e o juiz de regras, e a rodada
 * "real" sairia verde sem ter falado com modelo nenhum — recusada com o motivo.
 */
export function exigirAmbienteReal(env: NodeJS.ProcessEnv): void {
  if (env.IA_PROVEDOR?.trim() === 'simulado') {
    throw new Error('IA_E2E=1 com IA_PROVEDOR=simulado não é rodada real: configure IA_PROVEDOR (claude, openrouter, groq…) e a chave, ou rode sem IA_E2E para o modo simulado.')
  }
  const falta = faltaParaLlmFerramentas(env)
  if (falta.length > 0) throw new Error(`IA_E2E=1 sem modelo real configurado. Falta: ${falta.join('; ')}`)
}

export class ExecutorDeCenarios {
  readonly real: boolean
  private readonly dono: postgres.Sql
  /** ⚠️ O worker dos testes só enxerga o tenant da suíte (RLS): outras suítes rodando não roubam a tarefa. */
  private readonly workerDoTenant: postgres.Sql
  private readonly notas: { id: string; media: number }[] = []

  constructor(readonly suite: Suite, o: { real: boolean }) {
    if (o.real) exigirAmbienteReal(process.env)
    this.real = o.real
    this.dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
    this.workerDoTenant = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {}, connection: { 'geracrm.tenant_id': suite.tenantId } as never })
  }

  /** Tenant, número, catálogo manual indexado e as políticas como base de conhecimento. */
  async preparar(): Promise<void> {
    const i = ids(this.suite)
    await this.limparTenant()
    await this.dono`INSERT INTO plano (id, codigo, nome) VALUES (${i.plano}, ${`plano-evals-${i.plano.slice(0, 8)}`}, 'Pro') ON CONFLICT DO NOTHING`
    await this.dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${i.modelo}, ${`modelo-evals-${i.modelo.slice(0, 8)}`}, 'Atacado') ON CONFLICT DO NOTHING`
    await this.dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${i.tenant}, ${`Evals ${this.suite.nome}`}, ${i.plano}, ${i.perfilVertical}, 'America/Fortaleza') ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${i.tenant}, ${i.perfilVertical}, ${i.modelo}, 'Atacado') ON CONFLICT DO NOTHING`
    })
    await this.dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${i.tenant}, ${i.canal}, 'whatsapp_nao_oficial', 'Loja', 'conectado')`
    // Equipe sempre fora: o agente entra (o portão de disponibilidade tem testes próprios).
    await this.dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${i.tenant}, ${i.canal}, ${JSON.stringify(SEMPRE_FECHADO)}::text::jsonb)`
    await comTenantServico(i.tenant, async (tx) => {
      for (const p of this.suite.catalogo) {
        const r = await criarProdutoManual(tx, p as never)
        if (!r.ok) throw new Error(`semeadura do catálogo: ${r.falha.erro}`)
      }
      await reindexarTenant(tx, { tenantId: i.tenant, lote: 100 })
    })
    await this.configurar({})
    await comTenantServico(i.tenant, (tx) => sincronizarPoliticas(tx, i.canal, this.suite.politicas))
  }

  /** Média das notas do juiz nos cenários já executados (null sem nenhuma). */
  mediaDoJuiz(): { media: number; cenarios: number } | null {
    if (this.notas.length === 0) return null
    return { media: Math.round((this.notas.reduce((a, n) => a + n.media, 0) / this.notas.length) * 100) / 100, cenarios: this.notas.length }
  }

  async encerrar(): Promise<void> {
    await this.limparTenant()
    if (this.notas.length) {
      const media = this.notas.reduce((a, n) => a + n.media, 0) / this.notas.length
      process.stdout.write(`juiz (${this.real ? 'real' : 'simulado'}) ${this.suite.nome}: média ${media.toFixed(2)}/5 em ${this.notas.length} cenário(s) — ${this.notas.map((n) => `${n.id}=${n.media}`).join(' ')}\n`)
    }
    await this.dono.end()
    await this.workerDoTenant.end()
  }

  private async limparTenant(): Promise<void> {
    const t = this.suite.tenantId
    for (const tabela of TABELAS_DO_TENANT) await this.dono.unsafe(`DELETE FROM ${tabela} WHERE tenant_id = $1`, [t])
    await this.dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await this.dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await this.dono`DELETE FROM tenant WHERE id = ${t}`
  }

  private async configurar(c: ConfigCenario): Promise<void> {
    const i = ids(this.suite)
    await this.dono`
      INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona,
                                 alcada, recorte, teto_sessao_centavos, qualificacao)
      VALUES (${i.tenant}, ${i.canal}, true, ${c.modo ?? 'autonomo'}, ${this.suite.politicas}, false, false,
              ${JSON.stringify(this.suite.persona)}::text::jsonb, ${JSON.stringify(c.alcada ?? {})}::text::jsonb,
              ${c.recorte === undefined ? null : JSON.stringify(c.recorte)}::text::jsonb, ${c.tetoSessaoCentavos ?? null},
              ${JSON.stringify(c.qualificacao ?? [])}::text::jsonb)
      ON CONFLICT (tenant_id, canal_id) DO UPDATE SET
        modo = EXCLUDED.modo, ativo = true, alcada = EXCLUDED.alcada, recorte = EXCLUDED.recorte,
        teto_sessao_centavos = EXCLUDED.teto_sessao_centavos, qualificacao = EXCLUDED.qualificacao`
  }

  // ── um cenário ────────────────────────────────────────────────────────────

  async executar(c: Cenario, n: number): Promise<ResultadoCenario> {
    const i = ids(this.suite)
    const cfg = c.config ?? {}
    await this.configurar(cfg)
    const ctx: ContextoCenario = {
      dono: this.dono, tenantId: i.tenant, canalId: i.canal,
      contatoId: idDa(this.suite, '6666', n + 1), conversaId: idDa(this.suite, '7777', n + 1),
      nomeContato: `Marina ${c.id}`,
    }
    const fone = `5585988${String(n + 1).padStart(6, '0')}`
    await this.dono`INSERT INTO contato (tenant_id, id, nome, ativo, perfil_preco) VALUES (${i.tenant}, ${ctx.contatoId}, ${ctx.nomeContato}, true, ${cfg.perfil ?? null})`
    await this.dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
                    VALUES (${i.tenant}, ${ctx.contatoId}, 1, ${fone}, ${fone}, true, true, 'teste')`
    await this.dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${i.tenant}, ${ctx.conversaId}, ${i.canal}, ${ctx.contatoId}, 1)`
    if (!cfg.semAvisoPrivacidade) {
      // Aviso VIGENTE: a abertura não é o objeto deste cenário (ver ConfigCenario).
      await this.dono`INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
                      VALUES (${i.tenant}, gen_random_uuid(), ${ctx.contatoId}, ${ctx.conversaId}, ${i.canal}, gen_random_uuid(),
                              'Esta conversa fica registrada para te atender melhor.', ${VERSAO_PADRAO}, 'agente')`
    }
    if (cfg.pedidoAnterior) {
      await this.dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, total_pecas, criado_em, efetivado_em)
                      VALUES (${i.tenant}, ${randomUUID()}, ${ctx.contatoId}, ${cfg.pedidoAnterior.estado}, ${cfg.pedidoAnterior.totalCentavos}, 20,
                              now() - interval '30 days', now() - interval '30 days')`
    }

    const enviadas: string[] = []
    const enviar = (async (_t: string, _c: string, texto: string) => {
      enviadas.push(texto)
      const id = randomUUID()
      await this.dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em)
                      VALUES (${i.tenant}, ${id}, ${ctx.conversaId}, 'saliente', 'texto', ${JSON.stringify({ texto, automatica: 'agente' })}::text::jsonb, 'enviada', now())`
      return { ok: true, conversaId: ctx.conversaId, mensagemId: id }
    }) as never

    const falas: FalaTranscrita[] = []
    const isentas: string[] = []
    const vistas = new Set<string>()
    let relogioMs = 0

    for (const [k, turno] of c.turnos.entries()) {
      relogioMs += turno.avancarMs ?? 0
      const agora = new Date(Date.now() + relogioMs)
      await turno.antes?.(ctx)
      const mensagemId = await this.mensagemDoCliente(ctx, turno)
      if (turno.cliente) {
        // Como a ingestão faz: o "sim" do cliente confirma a proposta vigente ANTES do turno do agente.
        await comTenantServico(i.tenant, (tx) => confirmarPedidoPorResposta(tx, ctx.conversaId, turno.cliente!, agora))
        falas.push({ autor: 'CLIENTE', texto: turno.cliente })
      } else if (turno.audio) falas.push({ autor: 'CLIENTE', texto: '[áudio sem transcrição]' })

      const llm = new LlmContado(this.modeloDo(turno.modelo))
      const antes = enviadas.length
      let resultado: ResultadoTurnoVendedor | null = null
      if (turno.viaFila) {
        if (mensagemId) await comTenantServico(i.tenant, (tx) => agendarTurno(tx, { conversaId: ctx.conversaId, canalId: i.canal, mensagemId, agora: new Date(agora.getTime() - 60_000), atrasoMs: 0 }))
        await processarTarefasDoAgente(this.workerDoTenant as never, { llm, ligacoes: ligacoesPadrao, enviar, agora }, agora)
      } else {
        resultado = await conduzirTurnoVendedor(
          { tenant_id: i.tenant, id: randomUUID(), conversa_id: ctx.conversaId, canal_id: i.canal, mensagens_ids: mensagemId ? [mensagemId] : [], tentativas: 1, executar_em: agora },
          { llm, ligacoes: ligacoesPadrao, enviar, agora },
        )
      }

      const decisoes = (await this.dono<DecisaoLida[]>`
        SELECT id, desfecho, modo, handoff_motivo, guardrails, ferramentas, falha_tipo, resposta
          FROM agente_decisao WHERE tenant_id = ${i.tenant} AND conversa_id = ${ctx.conversaId} ORDER BY criado_em, id`)
        .filter((d) => !vistas.has(d.id))
      for (const d of decisoes) vistas.add(d.id)
      const doTurno = enviadas.slice(antes)
      const saida = resultado?.mensagens?.length ? resultado.mensagens : doTurno
      const ferramentas = resultado?.rastro
        ? resultado.rastro.chamadas.map((ch) => ({ nome: ch.nome, saida: ch.saida }))
        : decisoes.flatMap((d) => d.ferramentas.map((f) => ({ nome: f.nome, saida: f.saida })))
      const t: ObservadoTurno = { resultado, decisoes, enviadas: doTurno, saida, ferramentas, llmChamado: llm.chamadas > 0 }

      const rotulo = `[${c.id} t${k + 1}] cliente=${JSON.stringify(turno.cliente ?? turno.audio ?? '(fila)')} → desfecho=${resultado?.desfecho ?? decisoes.map((d) => d.desfecho).join('+')}`
        + ` handoff=${decisoes.map((d) => d.handoff_motivo).filter(Boolean).join(',')} ferramentas=${ferramentas.map((f) => f.nome).join(',')}`
        + ` marcas=${decisoes.flatMap((d) => d.guardrails.map((g) => `${g.etapa}/${g.codigo}`)).join(',')} saida=${JSON.stringify(saida).slice(0, 300)}`
      // `EVALS_DETALHE=1`: imprime cada turno (o que entrou, o que o pipeline fez, o que saiu) — para ler a rodada real.
      if (process.env.EVALS_DETALHE) process.stdout.write(`${rotulo}\n`)
      const abertura = textoAbertura({ assistenteNome: this.suite.persona.nome, loja: this.suite.persona.loja, clienteNome: ctx.nomeContato, privacidade: {} })
      await this.conferir(ctx, rotulo, t, turno.esperado, abertura)
      if (!this.real && turno.esperadoSimulado) await this.conferir(ctx, rotulo, t, turno.esperadoSimulado, abertura)
      await turno.confere?.(ctx, t)

      // Transcrição: ferramentas antes da fala do agente (são a fonte dela).
      for (const f of ferramentas) falas.push({ autor: 'TOOL', texto: JSON.stringify({ ferramenta: f.nome, saida: f.saida }) })
      for (const m of doTurno.length ? doTurno : saida) {
        falas.push({ autor: 'AGENTE', texto: m })
        // A abertura fixa e a resposta que EXISTE para provar a pausa (criticaEsperada) ficam fora da régua e do juiz.
        if (m === abertura || turno.criticaEsperada) isentas.push(m)
      }

      // ⚠️ Nenhuma pausa por CRÍTICA da qualidade: o que chega ao fim do pipeline não pode ser crítico
      //    — a não ser no turno que existe para prová-la.
      const pausas = decisoes.flatMap((d) => d.guardrails).filter((g) => g.etapa === 'regras-qualidade' && g.gravidade === 'CRITICA')
      if (turno.criticaEsperada) expect(pausas.length, `${rotulo}: a pausa por CRÍTICA era esperada`).toBeGreaterThan(0)
      else expect(pausas, `${rotulo}: violação CRÍTICA chegou às regras de qualidade`).toEqual([])
    }

    // ── 0 CRÍTICA no que o agente disse (regras da P12; fontes conhecidas: ferramentas + políticas) ─
    expect(criticasDoCenario(falas, { isentas, politicas: this.suite.politicas }), `[${c.id}] CRÍTICA na transcrição`).toEqual([])

    // ── juiz com a rubrica da P12 (sem a abertura fixa) ─────────────────────
    let notaJuiz: number | null = null
    const falasJulgaveis = falas.filter((f) => f.autor === 'AGENTE' && !isentas.includes(f.texto))
    if (falasJulgaveis.length > 0) {
      const juiz = juizDosEvals(this.real)
      const r = await julgarCenario(juiz, { falas, politicas: this.suite.politicas, isentas })
      expect(reprovacoesDoJuiz(r, this.real), `[${c.id}] juiz`).toEqual([])
      if (r.ok) { notaJuiz = r.notaMedia; this.notas.push({ id: c.id, media: r.notaMedia }) }
    }
    return { falas, notaJuiz }
  }

  private async mensagemDoCliente(ctx: ContextoCenario, turno: Turno): Promise<string | null> {
    if (!turno.cliente && !turno.audio) return null
    const id = randomUUID()
    const [tipo, conteudo] = turno.audio
      ? ['audio', { midia: 'eval.ogg', ...(turno.audio === 'falhou' ? { transcricao_tentativas: MAX_TENTATIVAS_TRANSCRICAO } : {}) }]
      : ['texto', { texto: turno.cliente }]
    await this.dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
                    VALUES (${ctx.tenantId}, ${id}, ${ctx.conversaId}, 'entrante', ${tipo}, ${JSON.stringify(conteudo)}::text::jsonb, now())`
    return id
  }

  private modeloDo(m: ModeloDoTurno | undefined): PortaLlmFerramentas {
    const modelo = m ?? { tipo: 'simulado' }
    if (modelo.tipo === 'falha') return new LlmQueFalha(modelo.motivo)
    if (modelo.tipo === 'roteiro' && (!this.real || modelo.forcado)) return new LlmRoteirizado(modelo.roteiro, modelo.custo)
    return this.real ? llmFerramentasDoAmbiente() : new LlmSimulado()
  }

  private async conferir(ctx: ContextoCenario, rotulo: string, t: ObservadoTurno, e: Esperado, abertura: string): Promise<void> {
    const texto = t.saida.join('\n')
    const marcas = t.decisoes.flatMap((d) => d.guardrails.map((g) => `${g.etapa}/${g.codigo}`))
    const temMarca = (m: string) => m.endsWith('/*') ? marcas.some((x) => x.startsWith(m.slice(0, -1))) : marcas.includes(m)
    const desfecho = t.resultado?.desfecho ?? t.decisoes.at(-1)?.desfecho
    if (e.desfecho) expect(desfecho, rotulo).toBe(e.desfecho)
    if (e.handoff) expect(t.decisoes.map((d) => d.handoff_motivo), rotulo).toContain(e.handoff)
    if (e.llm !== undefined) expect(t.llmChamado, `${rotulo}: modelo chamado?`).toBe(e.llm)
    for (const f of e.ferramentas ?? []) expect(t.ferramentas.map((x) => x.nome), rotulo).toContain(f)
    // Sem caixa nos dois modos: o modelo real escreve "Sem estoque" ou "sem estoque" — o fato é o mesmo.
    const minusculo = texto.toLocaleLowerCase('pt-BR')
    for (const s of e.contem ?? []) expect(minusculo, rotulo).toContain(s.toLocaleLowerCase('pt-BR'))
    for (const s of e.naoContem ?? []) expect(minusculo, rotulo).not.toContain(s.toLocaleLowerCase('pt-BR'))
    if (e.enviadas !== undefined) expect(t.enviadas.length, `${rotulo}: enviadas`).toBe(e.enviadas)
    for (const m of e.marcas ?? []) expect(temMarca(m), `${rotulo}: falta a marca ${m}`).toBe(true)
    for (const m of e.semMarcas ?? []) expect(temMarca(m), `${rotulo}: marca indevida ${m}`).toBe(false)
    if (e.modo) expect(t.decisoes.map((d) => d.modo), rotulo).toContain(e.modo)
    if (e.falhaTipo) expect(t.decisoes.map((d) => d.falha_tipo), rotulo).toContain(e.falhaTipo)
    if (e.abertura === true) {
      // A abertura da P4 sai como 1ª mensagem do 1º turno autônomo: identifica a assistente e mostra o aviso.
      expect(t.saida[0], `${rotulo}: abertura`).toBe(abertura)
      expect(temMarca('gatilhos-entrada/abertura'), `${rotulo}: marca da abertura`).toBe(true)
      const [a] = await this.dono<{ n: number }[]>`SELECT count(*)::int AS n FROM aviso_privacidade WHERE tenant_id = ${ctx.tenantId} AND contato_id = ${ctx.contatoId}`
      expect(a!.n, `${rotulo}: aviso de privacidade registrado após o envio`).toBe(1)
    }
    if (e.abertura === false) {
      expect(t.saida.includes(abertura), `${rotulo}: abertura repetida`).toBe(false)
      expect(temMarca('gatilhos-entrada/abertura'), `${rotulo}: marca de abertura repetida`).toBe(false)
    }
    if (e.pedidoEstado) {
      const [p] = await this.dono<{ estado: string }[]>`SELECT estado FROM pedido WHERE tenant_id = ${ctx.tenantId} AND conversa_id = ${ctx.conversaId} ORDER BY criado_em DESC LIMIT 1`
      expect(p?.estado, rotulo).toBe(e.pedidoEstado)
    }
    if (e.reagendadaEmMs !== undefined) {
      const [tf] = await this.dono<{ estado: string; atraso: number }[]>`
        SELECT estado, (extract(epoch FROM executar_em) * 1000 - ${Date.now()})::float8 AS atraso
          FROM agente_tarefa WHERE tenant_id = ${ctx.tenantId} AND conversa_id = ${ctx.conversaId} ORDER BY criado_em DESC LIMIT 1`
      expect(tf?.estado, `${rotulo}: tarefa`).toBe('pendente')
      // Folga de 15 s: o relógio do teste anda entre o turno e esta consulta.
      expect(Math.abs((tf?.atraso ?? 0) - e.reagendadaEmMs), `${rotulo}: reagendamento`).toBeLessThan(15_000)
    }
  }
}

/** O contato está bloqueado (opt-out registrado)? */
export async function bloqueado(c: ContextoCenario): Promise<boolean> {
  return comTenantServico(c.tenantId, (tx) => contatoBloqueado(tx, c.contatoId))
}
