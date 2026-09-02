import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'

/**
 * INV-51 — no máximo UM atendimento aberto por conversa. É o que impede duas
 * vendedoras de assumir o mesmo cliente. O vencedor é atômico pelo índice único
 * parcial `atendimento_aberto_unico`, nunca por SELECT-antes-de-INSERT.
 */
const T = 'f11a0000-0000-4000-8000-000000000001'
const PV = 'f11a0000-1111-4000-8000-000000000001'
const PLANO = 'f11a0000-3333-4000-8000-000000000001'
const MODELO = 'f11a0000-4444-4000-8000-000000000001'
const CANAL = 'f11a0000-5555-4000-8000-000000000001'
const CONTATO = 'f11a0000-6666-4000-8000-000000000001'
const CONVERSA = 'f11a0000-7777-4000-8000-000000000001'
const U1 = 'f11a0000-8888-4000-8000-000000000001'
const U2 = 'f11a0000-8888-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const inserirAtendimento = (id: string, protocolo: number, atendente: string, estado = 'em_atendimento') => dono`
  INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
  VALUES (${T}, ${id}, ${CONVERSA}, ${CANAL}, ${protocolo}, ${atendente}, ${estado}, now())
  ON CONFLICT (tenant_id, conversa_id) WHERE estado <> 'encerrado' DO NOTHING
  RETURNING id`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'p-fila', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'm-fila', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Loja Fila', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U1}, 'sub-fila-1', 'Ana', 'ana@t.local') ON CONFLICT (tenant_id, cognito_sub) DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${U2}, 'sub-fila-2', 'Bia', 'bia@t.local') ON CONFLICT (tenant_id, cognito_sub) DO NOTHING`
})

afterAll(async () => {
  await dono`DELETE FROM auditoria WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa_leitura WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM usuario WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

describe('INV-51: um atendimento aberto por conversa', () => {
  it('⚠️ duas assunções da MESMA conversa: exatamente 1 vence', async () => {
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
    const a = await inserirAtendimento('f11a0000-a000-4000-8000-000000000001', 1, U1)
    const b = await inserirAtendimento('f11a0000-b000-4000-8000-000000000001', 2, U2)
    // A vence (linha retornada); B é recusado pelo índice (nada retornado).
    expect([a.length, b.length]).toEqual([1, 0])
    const [n] = await dono<{ c: number }[]>`SELECT count(*)::int AS c FROM atendimento WHERE tenant_id = ${T} AND estado <> 'encerrado'`
    expect(n!.c).toBe(1)
  })

  it('encerrado libera: pode reabrir a conversa depois', async () => {
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
    await inserirAtendimento('f11a0000-c000-4000-8000-000000000001', 3, U1)
    await dono`UPDATE atendimento SET estado='encerrado', encerrado_em=now() WHERE tenant_id=${T}`
    const d = await inserirAtendimento('f11a0000-d000-4000-8000-000000000001', 4, U2)
    expect(d.length, 'com o anterior encerrado, o índice parcial não bloqueia').toBe(1)
  })
})

describe('E5-12: não-lido é POR USUÁRIO (conversa_leitura)', () => {
  const naoLida = (u: string) => dono<{ nl: boolean }[]>`
    SELECT (cv.ultima_direcao = 'entrante' AND cv.versao > coalesce(cl.lida_ate_versao, 0)) AS nl
      FROM conversa cv
      LEFT JOIN conversa_leitura cl
        ON cl.tenant_id = cv.tenant_id AND cl.conversa_id = cv.id AND cl.usuario_id = ${u}
     WHERE cv.tenant_id = ${T} AND cv.id = ${CONVERSA}`

  it('⚠️ mesma conversa: lida para quem leu, NÃO-lida para quem não leu', async () => {
    await dono`DELETE FROM conversa_leitura WHERE tenant_id = ${T}`
    await dono`UPDATE conversa SET versao = 3, ultima_direcao = 'entrante' WHERE tenant_id = ${T} AND id = ${CONVERSA}`
    // U1 leu até a versão 3; U2 não leu.
    await dono`INSERT INTO conversa_leitura (tenant_id, conversa_id, usuario_id, lida_ate_versao)
               VALUES (${T}, ${CONVERSA}, ${U1}, 3) ON CONFLICT DO NOTHING`
    const [a] = await naoLida(U1)
    const [b] = await naoLida(U2)
    expect([a!.nl, b!.nl], 'contador por conversa erraria; por usuário acerta').toEqual([false, true])
  })
})

describe('E5-09: cursor de mensagens para trás', () => {
  it('recentes + anteriores paginam sem overlap', async () => {
    await dono`DELETE FROM mensagem WHERE tenant_id = ${T} AND conversa_id = ${CONVERSA}`
    const base = new Date('2026-08-01T12:00:00Z').getTime()
    for (let i = 0; i < 5; i++) {
      await dono`
        INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
        VALUES (${T}, ${'f11a0000-e000-4000-8000-00000000000' + i}, ${CONVERSA}, 'entrante', 'texto',
                ${JSON.stringify({ texto: 'm' + i })}::text::jsonb, ${new Date(base + i * 60000)})`
    }
    // Página das 3 mais recentes (m2, m3, m4).
    const recentes = await dono<{ id: string; criado_em: Date }[]>`
      SELECT id, criado_em FROM mensagem WHERE conversa_id = ${CONVERSA}
       ORDER BY criado_em DESC, id DESC LIMIT 3`
    const cursor = recentes[recentes.length - 1]! // a mais antiga da página
    // Anteriores ao cursor: as 2 restantes (m0, m1), sem repetir.
    const anteriores = await dono<{ id: string }[]>`
      SELECT id FROM mensagem WHERE conversa_id = ${CONVERSA}
         AND (criado_em, id) < (${cursor.criado_em}, ${cursor.id})
       ORDER BY criado_em DESC, id DESC LIMIT 3`
    expect(recentes.length).toBe(3)
    expect(anteriores.length).toBe(2)
    const idsRecentes = new Set(recentes.map((r) => r.id))
    expect(anteriores.every((a) => !idsRecentes.has(a.id)), 'sem overlap entre páginas').toBe(true)
  })
})

describe('E5-08: busca por protocolo', () => {
  it('acha a conversa pelo número do protocolo', async () => {
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
    await inserirAtendimento('f11a0000-f000-4000-8000-000000000001', 777, U1)
    const [row] = await dono<{ conversa_id: string }[]>`
      SELECT conversa_id FROM atendimento WHERE tenant_id = ${T} AND protocolo = 777 LIMIT 1`
    expect(row!.conversa_id).toBe(CONVERSA)
  })
})

describe('EP-07: auditoria', () => {
  it('registra ação com ator e a leitura traz o nome de quem fez', async () => {
    await dono`DELETE FROM auditoria WHERE tenant_id = ${T}`
    await dono`
      INSERT INTO auditoria (tenant_id, id, ator_id, acao, entidade, entidade_id, dados)
      VALUES (${T}, ${randomUUID()}, ${U1}, 'atendimento.assumido', 'conversa', ${CONVERSA}, ${JSON.stringify({ protocolo: 1 })}::text::jsonb)`
    const [row] = await dono<{ acao: string; ator_nome: string | null }[]>`
      SELECT a.acao, u.nome AS ator_nome
        FROM auditoria a
        LEFT JOIN usuario u ON u.tenant_id = a.tenant_id AND u.id = a.ator_id
       WHERE a.tenant_id = ${T} ORDER BY a.criado_em DESC LIMIT 1`
    expect(row!.acao).toBe('atendimento.assumido')
    expect(row!.ator_nome).toBe('Ana') // U1
  })
})
