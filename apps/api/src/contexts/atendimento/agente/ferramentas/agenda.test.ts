import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import { ligacoesPadrao } from './ligacoes.js'
import type { ChamadaRegistrada, PedidoDeLaco, PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'

/**
 * `agendar_reuniao` (C3) no TURNO DE VERDADE (pipeline, `ligacoesPadrao`, banco real), com
 * modelo falso que registra o menu e chama a ferramenta.
 *
 *   - ⚠️ desligada (chave do número), módulo desligado ou número em sombra → a ferramenta
 *     NÃO entra no menu e não aparece no rastro do laço;
 *   - modo efetivo sombra (kill switch) → entra, mas responde seco: nada gravado;
 *   - autônomo → oferta gravada; confirmação no mesmo turno, "sim" ambíguo e opção divergente
 *     não criam evento; a escolha explícita cria, uma vez só; responsável ocupado → filial.
 *
 * UUIDs exclusivos deste arquivo (prefixo c3d0).
 */
const A = 'c3d00000-0000-4000-8000-00000000000a' // módulo ligado
const M = 'c3d00000-0000-4000-8000-00000000000b' // módulo desligado
const K = 'c3d00000-0000-4000-8000-00000000000c' // módulo ligado, kill switch em sombra
const PLANO = 'c3d00000-0001-4000-8000-000000000001'
const MODELO = 'c3d00000-0002-4000-8000-000000000001'
const PV: Record<string, string> = { [A]: 'c3d00000-0003-4000-8000-00000000000a', [M]: 'c3d00000-0003-4000-8000-00000000000b', [K]: 'c3d00000-0003-4000-8000-00000000000c' }
const CANAL = 'c3d00000-0004-4000-8000-000000000001'      // A: autônomo, chave ligada
const CANAL_OFF = 'c3d00000-0004-4000-8000-000000000002'  // A: autônomo, chave desligada
const CANAL_SOMBRA = 'c3d00000-0004-4000-8000-000000000003' // A: número em sombra, chave ligada
const CANAL_M = 'c3d00000-0004-4000-8000-000000000004'    // M: autônomo, chave ligada
const CANAL_K = 'c3d00000-0004-4000-8000-000000000005'    // K: autônomo, chave ligada
const VA = 'c3d00000-0005-4000-8000-000000000001'
const VB = 'c3d00000-0005-4000-8000-000000000002'
const CONTATO: Record<string, string> = { [A]: 'c3d00000-0006-4000-8000-00000000000a', [M]: 'c3d00000-0006-4000-8000-00000000000b', [K]: 'c3d00000-0006-4000-8000-00000000000c' }
const CV = {
  ok: 'c3d00000-0007-4000-8000-000000000001', off: 'c3d00000-0007-4000-8000-000000000002', sombra: 'c3d00000-0007-4000-8000-000000000003',
  m: 'c3d00000-0007-4000-8000-000000000004', k: 'c3d00000-0007-4000-8000-000000000005',
}

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const enviarFalso = (async () => ({ ok: true as const, mensagemId: crypto.randomUUID() })) as never

type Chamada = { nome: string; entrada: unknown }
/** Modelo falso: guarda o menu, tenta as chamadas pedidas e devolve o que cada uma respondeu. */
function llm(chamadas: Chamada[]) {
  const menus: string[][] = []
  const resultados: ChamadaRegistrada[] = []
  const porta: PortaLlmFerramentas = {
    nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(p: PedidoDeLaco): Promise<ResultadoLaco> {
      menus.push(p.ferramentas.map((f) => f.nome))
      const feitas: ChamadaRegistrada[] = []
      for (const c of chamadas) {
        const s = await p.executar(c.nome, c.entrada)
        const r = { nome: c.nome, entrada: c.entrada, saida: s.ok ? s.saida : null, ms: 1, ...(s.ok ? {} : { erro: s.erro }) }
        feitas.push(r); resultados.push(r)
      }
      return { ok: true, saida: { mensagens: ['Combinado, já te retorno.'], confianca: 0.9 }, rastro: { chamadas: feitas, rodadas: 1, uso: { entrada: 1, saida: 1, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    },
  }
  return { porta, menus, resultados }
}

const ofertar: Chamada = { nome: 'agendar_reuniao', entrada: { acao: 'ofertar', dia: null, opcao: null } }
const confirmar = (opcao: number): Chamada => ({ nome: 'agendar_reuniao', entrada: { acao: 'confirmar', dia: null, opcao } })

/** Relógio do turno: cada turno 1 minuto depois do anterior; a mensagem do cliente chega 1 s antes. */
let relogio = Date.now()
async function turno(t: string, conversa: string, canal: string, texto: string, chamadas: Chamada[]) {
  relogio += 60_000
  const agora = new Date(relogio)
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${t}, ${id}, ${conversa}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, ${new Date(relogio - 1000)})`
  const m = llm(chamadas)
  await conduzirTurnoVendedor(
    { tenant_id: t, id: crypto.randomUUID(), conversa_id: conversa, canal_id: canal, mensagens_ids: [id], tentativas: 1, executar_em: agora },
    { llm: m.porta, ligacoes: ligacoesPadrao, enviar: enviarFalso, agora },
  )
  return m
}
const situacoes = (r: ChamadaRegistrada[]) => r.map((c) => (c.saida as { situacao?: string } | null)?.situacao ?? `erro: ${c.erro}`)
const eventos = async (t: string) => dono<{ responsavel_id: string; origem: string; conversa_id: string; status: string }[]>`
  SELECT responsavel_id, origem, conversa_id, status FROM evento_agenda WHERE tenant_id = ${t} AND titulo LIKE 'Reunião com%'`

beforeAll(async () => {
  process.env.IA_PROVEDOR = 'simulado'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-c3d', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-c3d', 'Varejo') ON CONFLICT DO NOTHING`
  for (const t of [A, M, K]) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${t}, ${'Agenda agente ' + t.slice(-1)}, ${PLANO}, ${PV[t]!}, 'America/Sao_Paulo') ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${PV[t]!}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${CONTATO[t]!}, 'Ana Cliente', true)`
  }
  await dono`INSERT INTO tenant_modulo (tenant_id, modulo, ativo) VALUES (${A}, 'agenda', true), (${K}, 'agenda', true)
             ON CONFLICT (tenant_id, modulo) DO UPDATE SET ativo = true`
  await dono`INSERT INTO agente_tenant (tenant_id, modo_maximo) VALUES (${K}, 'sombra')`
  // Vendedores (filial "todas") no A e no K; VA é o dono do contato.
  for (const t of [A, K]) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES
      (${t}, ${VA}, ${'c3d-va-' + t}, 'Vera Vendas', ${'va-' + t + '@c3d.test'}), (${t}, ${VB}, ${'c3d-vb-' + t}, 'Bruno Balcão', ${'vb-' + t + '@c3d.test'})`
    await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${t}, ${VA}, NULL, 'vendedor'), (${t}, ${VB}, NULL, 'vendedor')`
  }
  const aberto = { de: '08:00', ate: '20:00' }
  const semana = JSON.stringify({ seg: aberto, ter: aberto, qua: aberto, qui: aberto, sex: aberto, sab: aberto, dom: aberto })
  for (const [t, c, modo, chave, conversa] of [
    [A, CANAL, 'autonomo', true, CV.ok], [A, CANAL_OFF, 'autonomo', false, CV.off], [A, CANAL_SOMBRA, 'sombra', true, CV.sombra],
    [M, CANAL_M, 'autonomo', true, CV.m], [K, CANAL_K, 'autonomo', true, CV.k],
  ] as const) {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${c}, 'whatsapp_nao_oficial', 'Loja', 'conectado')`
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${t}, ${c}, ${semana}::text::jsonb)`
    await dono`
      INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, agenda_reunioes)
      VALUES (${t}, ${c}, true, ${modo}, 'Vendemos confecção no atacado.', false, false,
              ${JSON.stringify({ nome: 'Lia', loja: 'Atacado Sol', tom: 'neutro', usaEmojis: false })}::text::jsonb, ${chave})`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${t}, ${conversa}, ${c}, ${CONTATO[t]!}, 1)`
    await dono`INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
               VALUES (${t}, ${crypto.randomUUID()}, ${CONTATO[t]!}, ${conversa}, ${c}, ${crypto.randomUUID()}, 'aviso', 'padrao', 'agente')`
  }
})

beforeEach(async () => {
  for (const t of [A, M, K]) {
    for (const tab of ['reuniao_oferta', 'evento_agenda', 'agente_decisao', 'agente_sessao', 'atendimento', 'carteira_atribuicao', 'auditoria', 'notificacao']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`UPDATE conversa SET conduzida_por = 'agente' WHERE tenant_id = ${t}`.catch(() => undefined)
  }
  await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id) VALUES (${A}, gen_random_uuid(), ${CONTATO[A]!}, ${VA}), (${K}, gen_random_uuid(), ${CONTATO[K]!}, ${VA})`
})

afterAll(async () => {
  for (const t of [A, M, K]) {
    for (const tab of ['reuniao_oferta', 'evento_agenda_aviso', 'evento_agenda', 'agente_decisao', 'agente_sessao', 'agente_tarefa', 'atendimento', 'notificacao',
      'aviso_privacidade', 'cliente_memoria', 'mensagem', 'carteira_atribuicao', 'conversa', 'contato', 'agente_config', 'agente_tenant', 'usuario_filial', 'usuario',
      'canal_configuracao', 'canal_conectado', 'outbox', 'alerta', 'auditoria', 'tenant_modulo']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('agendar_reuniao — quando entra no turno', () => {
  it('chave ligada + módulo ligado + número autônomo → está no menu', async () => {
    const m = await turno(A, CV.ok, CANAL, 'quero marcar uma reunião', [])
    expect(m.menus[0]).toContain('agendar_reuniao')
  })

  it('⚠️ chave do número DESLIGADA → não está no menu e não aparece no rastro do laço', async () => {
    const m = await turno(A, CV.off, CANAL_OFF, 'quero marcar uma reunião', [ofertar])
    expect(m.menus[0]).not.toContain('agendar_reuniao')
    expect(m.resultados[0]?.erro).toMatch(/ferramenta desconhecida/)
    // O rastro gravado do laço (agente_decisao.ferramentas) não tem chamada bem-sucedida da ferramenta.
    const [d] = await dono<{ ferramentas: { nome: string; erro?: string }[] }[]>`
      SELECT ferramentas FROM agente_decisao WHERE tenant_id = ${A} AND conversa_id = ${CV.off} ORDER BY criado_em DESC LIMIT 1`
    expect(d).toBeDefined()
    expect(d!.ferramentas.filter((c) => c.nome === 'agendar_reuniao' && !c.erro)).toEqual([])
    expect(await dono`SELECT 1 FROM reuniao_oferta WHERE tenant_id = ${A}`).toHaveLength(0)
  })

  it('⚠️ módulo Agenda DESLIGADO → não está no menu, mesmo com a chave ligada', async () => {
    const m = await turno(M, CV.m, CANAL_M, 'quero marcar uma reunião', [ofertar])
    expect(m.menus[0]).not.toContain('agendar_reuniao')
    expect(await dono`SELECT 1 FROM reuniao_oferta WHERE tenant_id = ${M}`).toHaveLength(0)
  })

  it('número configurado em sombra → não está no menu', async () => {
    const m = await turno(A, CV.sombra, CANAL_SOMBRA, 'quero marcar uma reunião', [])
    expect(m.menus[0]).not.toContain('agendar_reuniao')
  })
})

describe('agendar_reuniao — modo seco', () => {
  it('⚠️ número autônomo rebaixado a sombra (kill switch): oferta e confirmação respondem seco, nada é gravado', async () => {
    const m = await turno(K, CV.k, CANAL_K, 'pode ser a 1', [ofertar, confirmar(1)])
    expect(m.menus[0]).toContain('agendar_reuniao')
    expect(m.resultados.map((r) => (r.saida as { modoSeco?: boolean }).modoSeco)).toEqual([true, true])
    expect(situacoes(m.resultados)).toEqual(['ok', 'modo_seco'])
    expect(await dono`SELECT 1 FROM reuniao_oferta WHERE tenant_id = ${K}`).toHaveLength(0)
    expect(await eventos(K)).toHaveLength(0)
  })
})

describe('agendar_reuniao — propor e confirmar (autônomo)', () => {
  it('⚠️ nunca cria sem a escolha explícita do cliente; cria uma vez só quando ele escolhe', async () => {
    // Turno 1: oferta + tentativa de confirmar no MESMO turno.
    const t1 = await turno(A, CV.ok, CANAL, 'quero marcar uma reunião', [ofertar, confirmar(1)])
    expect(situacoes(t1.resultados)).toEqual(['ok', 'mesmo_turno'])
    const opcoes = (t1.resultados[0]!.saida as { opcoes: { n: number; com: string }[] }).opcoes
    expect(opcoes.length).toBeGreaterThan(1)
    expect(opcoes.every((o) => o.com === 'Vera')).toBe(true) // o responsável do contato primeiro
    const [oferta] = await dono<{ opcoes: { usuarioId: string }[] }[]>`SELECT opcoes FROM reuniao_oferta WHERE tenant_id = ${A}`
    expect(oferta!.opcoes.every((o) => o.usuarioId === VA)).toBe(true)

    // Turno 2: "sim" com várias opções é ambíguo.
    const t2 = await turno(A, CV.ok, CANAL, 'sim', [confirmar(1)])
    expect(situacoes(t2.resultados)).toEqual(['sem_confirmacao'])
    // Turno 3: o cliente escolheu a 2; o modelo tenta a 1 (divergente) e depois a 2.
    const t3 = await turno(A, CV.ok, CANAL, 'a 2', [confirmar(1), confirmar(2)])
    expect(situacoes(t3.resultados)).toEqual(['confirmacao_divergente', 'agendado'])
    expect(await eventos(A)).toEqual([expect.objectContaining({ responsavel_id: VA, origem: 'agente', conversa_id: CV.ok, status: 'agendado' })])
    const [a] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A} AND acao = 'agenda.reuniao_agendada'`
    expect(a!.n).toBe(1)

    // Turno 4: confirmar de novo não duplica.
    const t4 = await turno(A, CV.ok, CANAL, 'a 2', [confirmar(2)])
    expect(situacoes(t4.resultados)).toEqual(['ja_confirmada'])
    expect(await eventos(A)).toHaveLength(1)
  })

  it('cliente recusa as opções → nada é criado', async () => {
    await turno(A, CV.ok, CANAL, 'quero uma reunião', [ofertar])
    const t2 = await turno(A, CV.ok, CANAL, 'não, nenhum desses', [confirmar(1)])
    expect(situacoes(t2.resultados)).toEqual(['cliente_recusou'])
    expect(await eventos(A)).toHaveLength(0)
  })

  it('responsável sem horário → oferta com outro vendedor da filial, que vira o responsável ao confirmar', async () => {
    await dono`INSERT INTO evento_agenda (tenant_id, id, titulo, responsavel_id, inicio, fim)
               VALUES (${A}, gen_random_uuid(), 'Férias', ${VA}, now() - interval '1 day', now() + interval '20 days')`
    const t1 = await turno(A, CV.ok, CANAL, 'quero uma reunião', [ofertar])
    const opcoes = (t1.resultados[0]!.saida as { opcoes: { n: number; com: string }[] }).opcoes
    expect(opcoes.every((o) => o.com === 'Bruno')).toBe(true)
    const t2 = await turno(A, CV.ok, CANAL, 'opção 1', [confirmar(1)])
    expect(situacoes(t2.resultados)).toEqual(['agendado'])
    const [c] = await dono<{ usuario_id: string; origem: string }[]>`
      SELECT usuario_id, origem FROM carteira_atribuicao WHERE tenant_id = ${A} AND contato_id = ${CONTATO[A]!} AND ate IS NULL`
    expect(c).toEqual({ usuario_id: VB, origem: 'automatica' })
  })
})
