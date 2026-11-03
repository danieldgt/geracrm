import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { partesLocais } from './expediente.js'

/**
 * G1 — devolver ao agente, reatribuir e filtro `conduzidoPor`.
 * Dev (header x-tenant-id): o chamador é `dev-<tenant>`. Fixtures exclusivas
 * deste arquivo (a suíte roda em paralelo).
 */
const T = 'c1d00000-0000-4000-8000-000000000001'
const T2 = 'c1d00000-0000-4000-8000-000000000002'
const PV = 'c1d00000-1111-4000-8000-000000000001'
const PV2 = 'c1d00000-1111-4000-8000-000000000002'
const PLANO = 'c1d00000-3333-4000-8000-000000000001'
const MODELO = 'c1d00000-4444-4000-8000-000000000001'
const CANAL_AUTO = 'c1d00000-5555-4000-8000-000000000001'
const CANAL_OFF = 'c1d00000-5555-4000-8000-000000000002'
const CANAL_T2 = 'c1d00000-5555-4000-8000-000000000003'
const CANAL_RECORTE = 'c1d00000-5555-4000-8000-000000000004'
const CANAL_RESTRITO = 'c1d00000-5555-4000-8000-000000000005'
const EU = 'c1d00000-6666-4000-8000-000000000001'
const OUTRO = 'c1d00000-6666-4000-8000-000000000002'
const ADMIN = 'c1d00000-6666-4000-8000-000000000003'
const INATIVO = 'c1d00000-6666-4000-8000-000000000004'
const DE_T2 = 'c1d00000-6666-4000-8000-000000000005'
const MARCA = 'devolvido_ao_agente'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const post = (url: string, body: unknown, tenant = T) =>
  app.inject({ method: 'POST', url, headers: { 'x-tenant-id': tenant }, payload: body as object })
const get = (url: string, tenant = T) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } })
const papel = (u: string, p: string | null) => p === null
  ? dono`DELETE FROM usuario_filial WHERE tenant_id = ${T} AND usuario_id = ${u}`
  : dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${u}, NULL, ${p})
         ON CONFLICT (tenant_id, usuario_id) WHERE filial_id IS NULL DO UPDATE SET papel = EXCLUDED.papel`

/** Conversa nova; `atendente` = quem conduz (null = sem atendimento). */
async function conversa(canal: string, atendente: string | null, opts: { conduzida?: string; estado?: string; origem?: string } = {}) {
  const contato = randomUUID(); const id = randomUUID(); const at = randomUUID()
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${contato}, 'Cliente G1', ${opts.origem ?? 'teste'}, true)`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, conduzida_por)
             VALUES (${T}, ${id}, ${canal}, ${contato}, 0, ${opts.conduzida ?? 'humano'})`
  if (atendente) {
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
               VALUES (${T}, ${at}, ${id}, ${canal}, proximo_numero(${T}, 'protocolo'), ${atendente}, ${opts.estado ?? 'em_atendimento'}, now())`
  }
  return { id, at }
}

const mensagem = async (conversaId: string, direcao: 'entrante' | 'saliente', criadoEm: Date, tipo = 'texto') => {
  const id = randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${conversaId}, ${direcao}, ${tipo}, ${JSON.stringify({ texto: 'oi' })}::text::jsonb, ${criadoEm})`
  return id
}
const contar = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n
const marcas = (conversaId: string) => contar(dono<{ n: number }[]>`
  SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T} AND conversa_id = ${conversaId} AND conteudo->>'automatica' = ${MARCA}`)
const eventos = (conversaId: string, tipo: string) => contar(dono<{ n: number }[]>`
  SELECT count(*)::int AS n FROM outbox WHERE tenant_id = ${T} AND agregado_id = ${conversaId} AND tipo = ${tipo}`)

/**
 * Segura a linha do atendimento numa transação do dono, dispara `req`, espera ela
 * BLOQUEAR na guarda (pg_blocking_pids), roda `enquanto` (a escrita concorrente
 * que vence) e só então solta. Determinístico: a requisição leu o estado ANTES
 * da escrita concorrente e tenta escrever DEPOIS dela.
 */
async function corridaNaGuarda(
  atendimentoId: string, req: () => Promise<LightMyRequestResponse>, enquanto: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<LightMyRequestResponse> {
  const segurador = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
  let pendente: Promise<LightMyRequestResponse> | null = null
  try {
    await segurador.begin(async (tx) => {
      const pid = (await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid
      await tx`SELECT 1 FROM atendimento WHERE tenant_id = ${T} AND id = ${atendimentoId} FOR UPDATE`
      pendente = req()
      for (let i = 0; ; i++) {
        const [b] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
        if (b!.n > 0) break
        if (i > 200) throw new Error('a requisição não chegou à guarda')
        await new Promise((r) => setTimeout(r, 25))
      }
      await enquanto(tx)
    })
    return await pendente!
  } finally {
    await segurador.end()
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-g1', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-g1', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [tenant, perfil, nome] of [[T, PV, 'Loja G1'], [T2, PV2, 'Loja G1 Vizinha']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${tenant}, ${nome}, ${PLANO}, ${perfil}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${tenant}, ${perfil}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  for (const [canal, nome] of [[CANAL_AUTO, 'Auto'], [CANAL_OFF, 'Off'], [CANAL_RECORTE, 'Recorte'], [CANAL_RESTRITO, 'Restrito']] as const) {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
               VALUES (${T}, ${canal}, 'whatsapp_nao_oficial', 'plugzapi', ${nome}, 'conectado')`
  }
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T2}, ${CANAL_T2}, 'whatsapp_nao_oficial', 'plugzapi', 'Vizinha', 'conectado')`
  await dono`INSERT INTO agente_config (tenant_id, canal_id, modo, politicas) VALUES (${T}, ${CANAL_AUTO}, 'autonomo', 'Atenda com educação.')`
  await dono`INSERT INTO agente_config (tenant_id, canal_id, modo) VALUES (${T}, ${CANAL_OFF}, 'sombra')`
  // Recorte que NÃO inclui hoje (só amanhã, no fuso do tenant): agora está fora → sombra.
  const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'] as const
  const amanha = DIAS[partesLocais(new Date(), 'America/Sao_Paulo').diaIso % 7]!
  await dono`INSERT INTO agente_config (tenant_id, canal_id, modo, politicas, recorte)
             VALUES (${T}, ${CANAL_RECORTE}, 'autonomo', 'Atenda com educação.', ${JSON.stringify({ horario: { [amanha]: { de: '00:00', ate: '23:59' } } })}::text::jsonb)`
  for (const [id, sub, nome, ativo] of [
    [EU, `dev-${T}`, 'Eu', true], [OUTRO, 'sub-outro-g1', 'Outro', true],
    [ADMIN, 'sub-admin-g1', 'Ada', true], [INATIVO, 'sub-inativo-g1', 'Inativo', false],
  ] as const) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email, ativo)
               VALUES (${T}, ${id}, ${sub}, ${nome}, ${`${nome}@g1.test`}, ${ativo})`
  }
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T2}, ${DE_T2}, 'sub-t2-g1', 'Vizinho', 'v@g1.test')`
  // Só a Ada atende o número restrito.
  await dono`INSERT INTO usuario_canal (tenant_id, usuario_id, canal_id) VALUES (${T}, ${ADMIN}, ${CANAL_RESTRITO})`
  await papel(ADMIN, 'admin') // encerra o modo fundador: EU passa a ter só o que lhe derem
  app = await criarApp(); await app.ready()
})

afterAll(async () => {
  for (const t of ['notificacao', 'outbox', 'auditoria', 'agente_tarefa', 'agente_sessao', 'mensagem', 'atendimento', 'conversa_leitura', 'conversa', 'contato',
    'usuario_canal', 'usuario_filial', 'agente_config', 'usuario', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${T}', '${T2}')`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id IN (${T}, ${T2})`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id IN (${T}, ${T2})`
  await dono`DELETE FROM tenant WHERE id IN (${T}, ${T2})`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('POST /v1/conversas/:id/devolver-agente', () => {
  it('caminho feliz (agente autônomo): encerra o atendimento, devolve a condução e deixa o motivo para o agente', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'cliente_quer_continuar_com_agente', observacao: 'pediu o robô' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, jaDevolvida: false, destino: 'agente', modoEfetivo: 'autonomo', turnoAgendado: false })
    const [a] = await dono<{ estado: string; encerrado_em: Date | null }[]>`SELECT estado, encerrado_em FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a!.estado).toBe('encerrado'); expect(a!.encerrado_em).not.toBeNull()
    const [cv] = await dono<{ conduzida_por: string }[]>`SELECT conduzida_por FROM conversa WHERE tenant_id = ${T} AND id = ${c.id}`
    expect(cv!.conduzida_por).toBe('ia')
    const [s] = await dono<{ estado_agente: { devolucao: { motivo: string; observacao: string } } }[]>`
      SELECT estado_agente FROM agente_sessao WHERE tenant_id = ${T} AND conversa_id = ${c.id} AND estado = 'ativa'`
    expect(s!.estado_agente.devolucao).toMatchObject({ motivo: 'cliente_quer_continuar_com_agente', observacao: 'pediu o robô' })
    const [aud] = await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${T} AND entidade_id = ${c.id} AND acao = 'conversa.devolvida_ao_agente'`
    expect(aud).toBeDefined()
  })

  it('os eventos de outbox (atendimento.mudou e conversa.devolvida) não carregam conteúdo: só conversaId e versão', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro', observacao: 'texto secreto do atendente' })
    const ev = await dono<{ tipo: string; payload: Record<string, unknown> }[]>`
      SELECT tipo, payload FROM outbox WHERE tenant_id = ${T} AND agregado_id = ${c.id} ORDER BY tipo`
    expect(ev.map((e) => e.tipo)).toEqual(['atendimento.mudou', 'conversa.devolvida'])
    for (const e of ev) expect(Object.keys(e.payload).sort()).toEqual(['conversaId', 'versao'])
  })

  it('⚠️ não manda NADA ao cliente: nenhuma mensagem de saída, nenhuma chamada de rede (só a nota de sistema)', async () => {
    const rede = vi.spyOn(globalThis, 'fetch')
    try {
      for (const canal of [CANAL_AUTO, CANAL_OFF]) {
        const c = await conversa(canal, EU)
        await mensagem(c.id, 'entrante', new Date(Date.now() - 60_000)) // cliente esperando: o turno é enfileirado, não enviado
        expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'resolvido_pelo_humano' })).statusCode).toBe(200)
        const saidas = await dono<{ tipo: string }[]>`
          SELECT tipo FROM mensagem WHERE tenant_id = ${T} AND conversa_id = ${c.id} AND direcao = 'saliente'`
        expect(saidas.map((m) => m.tipo)).toEqual(['sistema'])
      }
      expect(rede).not.toHaveBeenCalled()
    } finally {
      rede.mockRestore()
    }
  })

  it('idempotente: devolver de novo responde 200 sem repetir efeito', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'fora_do_horario' })
    const r2 = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'fora_do_horario' })
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).toMatchObject({ jaDevolvida: true, destino: 'agente' })
    expect(await eventos(c.id, 'conversa.devolvida')).toBe(1)
  })

  it('409 tipificado quando a conversa não está com humano', async () => {
    const c = await conversa(CANAL_AUTO, null)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'conversa.sem_atendimento_humano' })
  })

  it('valida o motivo e o tamanho da observação (422)', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'qualquer' })).statusCode).toBe(422)
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro', observacao: 'x'.repeat(301) })).statusCode).toBe(422)
  })

  it('papel: atendente SEM papel que não conduz recebe 403; supervisor devolve o atendimento de outra pessoa', async () => {
    const c = await conversa(CANAL_AUTO, OUTRO)
    await papel(EU, null)
    const negado = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })
    expect(negado.statusCode).toBe(403)
    expect(negado.json()).toMatchObject({ erro: 'atendimento.nao_e_seu' })
    await papel(EU, 'atendente')
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })).statusCode).toBe(403)
    await papel(EU, 'supervisor')
    const ok = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })
    expect(ok.statusCode).toBe(200)
    await papel(EU, null)
  })

  it('M1: quem não pode devolver não recebe o "ok" idempotente — 409, não 200 jaDevolvida', async () => {
    const c = await conversa(CANAL_AUTO, OUTRO)
    await papel(EU, 'supervisor')
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })).statusCode).toBe(200)
    // O supervisor (autor) repete: idempotente.
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })).json()).toMatchObject({ jaDevolvida: true })
    // Sem papel e sem ter devolvido: não é dele dizer "já devolvi".
    await dono`UPDATE mensagem SET conteudo = jsonb_set(conteudo, '{atorId}', ${JSON.stringify(ADMIN)}::jsonb)
                WHERE tenant_id = ${T} AND conversa_id = ${c.id} AND conteudo->>'automatica' = ${MARCA}`
    await papel(EU, null)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'conversa.sem_atendimento_humano' })
  })

  it('M2: a gestão só age sobre o que VÊ na listagem — conversa do playground é 404', async () => {
    const c = await conversa(CANAL_AUTO, OUTRO, { origem: 'simulacao' })
    await papel(EU, 'gestor')
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })).statusCode).toBe(404)
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: ADMIN, motivo: 'x' })).statusCode).toBe(404)
    const [a] = await dono<{ estado: string; atendente_id: string }[]>`SELECT estado, atendente_id FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a).toMatchObject({ estado: 'em_atendimento', atendente_id: OUTRO })
    await papel(EU, null)
  })

  it('⚠️ agente em sombra no número: a conversa vai para a FILA, não some — e diz por quê', async () => {
    const c = await conversa(CANAL_OFF, EU)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'resolvido_pelo_humano' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ destino: 'fila', modoEfetivo: 'sombra', motivoFila: 'modo_do_numero' })
    expect((r.json() as { aviso: string }).aviso).toMatch(/modo sombra.*fila/)
    const [a] = await dono<{ estado: string; atendente_id: string | null; sla_vence_em: Date | null }[]>`
      SELECT estado, atendente_id, sla_vence_em FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a).toMatchObject({ estado: 'na_fila', atendente_id: null })
    expect(a!.sla_vence_em).not.toBeNull()
    const [cv] = await dono<{ conduzida_por: string }[]>`SELECT conduzida_por FROM conversa WHERE tenant_id = ${T} AND id = ${c.id}`
    expect(cv!.conduzida_por).toBe('humano')
    // Idempotente também no caminho da fila.
    const r2 = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'resolvido_pelo_humano' })
    expect(r2.json()).toMatchObject({ jaDevolvida: true, destino: 'fila' })
  })

  it('A2: número autônomo com recorte que exclui AGORA (fora do horário) → fila, com o motivo na resposta e na nota', async () => {
    const c = await conversa(CANAL_RECORTE, EU)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'fora_do_horario' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ destino: 'fila', modoEfetivo: 'sombra', motivoFila: 'fora_do_recorte_horario' })
    expect((r.json() as { aviso: string }).aviso).toMatch(/fora do horário/)
    const [a] = await dono<{ estado: string; atendente_id: string | null }[]>`SELECT estado, atendente_id FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a).toMatchObject({ estado: 'na_fila', atendente_id: null })
    const [nota] = await dono<{ texto: string }[]>`
      SELECT conteudo->>'texto' AS texto FROM mensagem WHERE tenant_id = ${T} AND conversa_id = ${c.id} AND conteudo->>'automatica' = ${MARCA}`
    expect(nota!.texto).toMatch(/fora do horário em que o agente atende sozinho/)
    const [s] = await dono`SELECT 1 FROM agente_sessao WHERE tenant_id = ${T} AND conversa_id = ${c.id}`
    expect(s, 'na fila não há recado para o agente').toBeUndefined()
  })

  it('A2: cliente escreveu e ninguém respondeu → o turno do agente é enfileirado (agente_tarefa) com as mensagens pendentes', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    const agora = Date.now()
    await mensagem(c.id, 'entrante', new Date(agora - 300_000))
    await mensagem(c.id, 'saliente', new Date(agora - 200_000)) // o atendente respondeu a essa
    const p1 = await mensagem(c.id, 'entrante', new Date(agora - 100_000))
    const p2 = await mensagem(c.id, 'entrante', new Date(agora - 50_000))
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'cliente_quer_continuar_com_agente' })
    expect(r.json()).toMatchObject({ destino: 'agente', turnoAgendado: true })
    const tarefas = await dono<{ mensagens_ids: string[]; estado: string }[]>`
      SELECT mensagens_ids, estado FROM agente_tarefa WHERE tenant_id = ${T} AND conversa_id = ${c.id}`
    expect(tarefas).toHaveLength(1)
    expect(tarefas[0]!.estado).toBe('pendente')
    expect([...tarefas[0]!.mensagens_ids].sort()).toEqual([p1, p2].sort())
  })

  it('A2: sem mensagem do cliente pendente (a última palavra foi do atendente), nenhum turno é enfileirado', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await mensagem(c.id, 'entrante', new Date(Date.now() - 200_000))
    await mensagem(c.id, 'saliente', new Date(Date.now() - 100_000))
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'resolvido_pelo_humano' })
    expect(r.json()).toMatchObject({ destino: 'agente', turnoAgendado: false })
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_tarefa WHERE tenant_id = ${T} AND conversa_id = ${c.id}`)).toBe(0)
  })

  it('M4: ao encerrar (autônomo) zera os relógios do SLA pendente; SLA já decidido fica para a métrica', async () => {
    const pendente = await conversa(CANAL_AUTO, EU)
    const decidido = await conversa(CANAL_AUTO, EU)
    for (const [c, estourado] of [[pendente, null], [decidido, new Date(Date.now() - 60_000)]] as const) {
      await dono`UPDATE atendimento
                    SET sla_inicio_em = now() - interval '10 minutes', sla_vence_em = now() + interval '20 minutes',
                        reatribuicao_vence_em = now() + interval '50 minutes', aviso_espera_previsto_em = now() + interval '5 minutes',
                        sla_estourado_em = ${estourado}
                  WHERE tenant_id = ${T} AND id = ${c.at}`
      expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'resolvido_pelo_humano' })).statusCode).toBe(200)
    }
    const ler = async (id: string) => (await dono<{ sla_inicio_em: Date | null; sla_vence_em: Date | null; reatribuicao_vence_em: Date | null; aviso_espera_previsto_em: Date | null }[]>`
      SELECT sla_inicio_em, sla_vence_em, reatribuicao_vence_em, aviso_espera_previsto_em FROM atendimento WHERE tenant_id = ${T} AND id = ${id}`)[0]!
    expect(await ler(pendente.at)).toEqual({ sla_inicio_em: null, sla_vence_em: null, reatribuicao_vence_em: null, aviso_espera_previsto_em: null })
    const d = await ler(decidido.at)
    expect(d.sla_vence_em).not.toBeNull(); expect(d.sla_inicio_em).not.toBeNull()
    expect(d.reatribuicao_vence_em).toBeNull(); expect(d.aviso_espera_previsto_em).toBeNull()
  })

  it('dois tenants: o vizinho não enxerga a conversa (404), nem depois de devolvida', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    const r = await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' }, T2)
    expect(r.statusCode).toBe(404)
    const [a] = await dono<{ estado: string }[]>`SELECT estado FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a!.estado).toBe('em_atendimento')
    await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' })
    expect((await post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' }, T2)).statusCode).toBe(404)
  })
})

describe('Concorrência (A3)', () => {
  it('duas devoluções simultâneas: uma vence, a outra recebe 200 jaDevolvida — nunca 500, nunca efeito em dobro', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    const rs = await Promise.all([
      post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro', observacao: 'a' }),
      post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro', observacao: 'b' }),
    ])
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200])
    expect(rs.map((r) => (r.json() as { jaDevolvida: boolean }).jaDevolvida).sort()).toEqual([false, true])
    expect(await marcas(c.id)).toBe(1)
    expect(await eventos(c.id, 'conversa.devolvida')).toBe(1)
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_sessao WHERE tenant_id = ${T} AND conversa_id = ${c.id}`)).toBe(1)
  })

  it('a guarda: outra devolução comita entre a leitura e a escrita → 200 jaDevolvida, sem repetir efeito', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    const r = await corridaNaGuarda(c.at, () => post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' }), async (tx) => {
      await tx`UPDATE atendimento SET estado = 'encerrado', encerrado_em = now() WHERE tenant_id = ${T} AND id = ${c.at}`
      await tx`UPDATE conversa SET conduzida_por = 'ia' WHERE tenant_id = ${T} AND id = ${c.id}`
      await tx`INSERT INTO mensagem (tenant_id, id, conversa_id, atendimento_id, direcao, tipo, conteudo, criado_em)
               VALUES (${T}, ${randomUUID()}, ${c.id}, ${c.at}, 'saliente', 'sistema',
                       ${JSON.stringify({ texto: 'x', automatica: MARCA, atorId: EU })}::text::jsonb, now())`
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ jaDevolvida: true, destino: 'agente' })
    expect(await marcas(c.id)).toBe(1)
    expect(await eventos(c.id, 'conversa.devolvida')).toBe(0)
    expect(await contar(dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_sessao WHERE tenant_id = ${T} AND conversa_id = ${c.id}`)).toBe(0)
  })

  it('a guarda: uma reatribuição comita entre a leitura e a escrita da devolução → 409 atendimento.conflito, nada escrito', async () => {
    const c = await conversa(CANAL_OFF, EU)
    const r = await corridaNaGuarda(c.at, () => post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' }), (tx) =>
      tx`UPDATE atendimento SET atendente_id = ${OUTRO} WHERE tenant_id = ${T} AND id = ${c.at}`)
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'atendimento.conflito' })
    const [a] = await dono<{ estado: string; atendente_id: string }[]>`SELECT estado, atendente_id FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a).toMatchObject({ estado: 'em_atendimento', atendente_id: OUTRO })
    expect(await marcas(c.id)).toBe(0)
    expect(await eventos(c.id, 'atendimento.mudou')).toBe(0)
  })

  it('devolver × reatribuir simultâneos: nunca 500, efeitos no máximo uma vez e estado final coerente com quem venceu', async () => {
    await papel(EU, 'gestor')
    const c = await conversa(CANAL_AUTO, EU)
    const [dev, rea] = await Promise.all([
      post(`/v1/conversas/${c.id}/devolver-agente`, { motivo: 'outro' }),
      post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'passa para o Outro' }),
    ])
    expect([200, 409]).toContain(dev.statusCode)
    expect([200, 409]).toContain(rea.statusCode)
    expect(await marcas(c.id)).toBeLessThanOrEqual(1)
    expect(await contar(dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${T} AND entidade_id = ${c.id} AND acao = 'atendimento.reatribuido'`)).toBeLessThanOrEqual(1)
    const [a] = await dono<{ estado: string; atendente_id: string | null }[]>`SELECT estado, atendente_id FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    if (dev.statusCode === 200) {
      // Devolução valeu por último (sozinha, ou depois da reatribuição): encerrado e com o agente.
      expect(a!.estado).toBe('encerrado')
      expect(await marcas(c.id)).toBe(1)
    } else {
      expect(rea.statusCode).toBe(200)
      expect(a).toMatchObject({ estado: 'em_atendimento', atendente_id: OUTRO })
      expect(await marcas(c.id)).toBe(0)
    }
    await papel(EU, null)
  })

  it('a guarda da reatribuição: uma devolução comita no meio → 409 atendimento.conflito', async () => {
    await papel(EU, 'gestor')
    const c = await conversa(CANAL_AUTO, OUTRO)
    const r = await corridaNaGuarda(c.at, () => post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: ADMIN, motivo: 'x' }), (tx) =>
      tx`UPDATE atendimento SET estado = 'encerrado', encerrado_em = now() WHERE tenant_id = ${T} AND id = ${c.at}`)
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'atendimento.conflito' })
    await papel(EU, null)
  })
})

describe('POST /v1/conversas/:id/reatribuir', () => {
  it('papel: sem gestão, 403; vendedor também 403', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await papel(EU, null)
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'férias' })).statusCode).toBe(403)
    await papel(EU, 'vendedor')
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'férias' })).statusCode).toBe(403)
    await papel(EU, null)
    const [a] = await dono<{ atendente_id: string }[]>`SELECT atendente_id FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a!.atendente_id).toBe(EU)
  })

  it('gestor reatribui: troca o responsável, notifica o destino e audita', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await papel(EU, 'gestor')
    const r = await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'especialista no assunto' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, jaEra: false, para: 'Outro' })
    const [a] = await dono<{ atendente_id: string }[]>`SELECT atendente_id FROM atendimento WHERE tenant_id = ${T} AND id = ${c.at}`
    expect(a!.atendente_id).toBe(OUTRO)
    const [n] = await dono`SELECT 1 FROM notificacao WHERE tenant_id = ${T} AND usuario_id = ${OUTRO} AND conversa_id = ${c.id}`
    expect(n).toBeDefined()
    const [aud] = await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${T} AND entidade_id = ${c.id} AND acao = 'atendimento.reatribuido'`
    expect(aud).toBeDefined()
    const again = await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'de novo' })
    expect(again.json()).toMatchObject({ jaEra: true })
    await papel(EU, null)
  })

  it('M2: o destino precisa atender o número (usuario_canal); número sem ninguém declarado é de todos', async () => {
    const c = await conversa(CANAL_RESTRITO, EU)
    await papel(EU, 'gestor')
    const negado = await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: 'x' })
    expect(negado.statusCode).toBe(422)
    expect(negado.json()).toMatchObject({ erro: 'reatribuicao.sem_acesso_ao_numero' })
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: ADMIN, motivo: 'x' })).statusCode).toBe(200)
    await papel(EU, null)
  })

  it('usuário de outro tenant: 404; inativo: 422; sem motivo: 422', async () => {
    const c = await conversa(CANAL_AUTO, EU)
    await papel(EU, 'gestor')
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: DE_T2, motivo: 'x' })).statusCode).toBe(404)
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: INATIVO, motivo: 'x' })).statusCode).toBe(422)
    expect((await post(`/v1/conversas/${c.id}/reatribuir`, { usuarioId: OUTRO, motivo: '  ' })).statusCode).toBe(422)
    await papel(EU, null)
  })
})

describe('GET /v1/conversas/:id — quem conduz', () => {
  it('atendimento.meu diz se quem conduz é quem pergunta (a tela decide o botão Devolver)', async () => {
    const meu = await conversa(CANAL_AUTO, EU)
    const alheio = await conversa(CANAL_AUTO, OUTRO)
    expect((await get(`/v1/conversas/${meu.id}`)).json()).toMatchObject({ atendimento: { meu: true } })
    expect((await get(`/v1/conversas/${alheio.id}`)).json()).toMatchObject({ atendimento: { meu: false } })
  })
})

describe('GET /v1/conversas?conduzidoPor=', () => {
  it('separa agente, humano e aguardando, e combina com o filtro atual', async () => {
    const ag = await conversa(CANAL_AUTO, null, { conduzida: 'ia' })
    const hu = await conversa(CANAL_AUTO, OUTRO)
    const fi = await conversa(CANAL_AUTO, null)
    // B4: conduzida por humano, sem atendimento e com a última palavra NOSSA — fora de todos os chips.
    const parada = await conversa(CANAL_AUTO, null)
    await dono`UPDATE conversa SET ultima_direcao = 'entrante', ultima_mensagem_em = now() WHERE tenant_id = ${T} AND id = ${fi.id}`
    await dono`UPDATE conversa SET ultima_direcao = 'saliente', ultima_mensagem_em = now() WHERE tenant_id = ${T} AND id = ${parada.id}`
    const ids = async (qs: string) => ((await get(`/v1/conversas?limite=100&${qs}`)).json() as { itens: { id: string }[] }).itens.map((i) => i.id)

    const agente = await ids('conduzidoPor=agente')
    expect(agente).toContain(ag.id); expect(agente).not.toContain(hu.id)
    const humano = await ids('conduzidoPor=humano')
    expect(humano).toContain(hu.id); expect(humano).not.toContain(ag.id)
    const aguardando = await ids('conduzidoPor=aguardando')
    expect(aguardando).toContain(fi.id); expect(aguardando).not.toContain(hu.id)
    for (const lista of [agente, humano, aguardando]) expect(lista).not.toContain(parada.id)
    // Combinado com `fila`: o humano em atendimento nunca está na fila.
    expect(await ids('filtro=fila&conduzidoPor=humano')).not.toContain(hu.id)
    expect((await get('/v1/conversas?conduzidoPor=zzz')).statusCode).toBe(422)
  })
})
