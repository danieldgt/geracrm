import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type MockInstance } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'

/**
 * WEBHOOK ENXUTO (raia P11): o request só valida, GRAVA e AGENDA — nenhuma
 * chamada de rede antes do 200. Ausência e mídia saem pelo worker de
 * pós-ingestão, com retry.
 *
 * ⚠️ A prova é por ESPIÃO nos três únicos caminhos de rede que existiam no
 *    request: `fetch` global (cópia de mídia do não-oficial, Graph API),
 *    `criarCanal` (todo adaptador de canal nasce dali: envio da ausência,
 *    download da mídia da Meta) e `subirMidia` (S3). Nenhum pode ser tocado
 *    durante o `inject`; depois, o worker usa os mesmos espiões.
 */
const espioes = vi.hoisted(() => ({
  criados: 0,
  enviados: [] as { para: string; texto: string }[],
  baixados: [] as string[],
  subidos: 0,
  enviarOk: true,
}))

vi.mock('./midia/armazenamento.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./midia/armazenamento.js')>()
  return {
    ...real,
    midiaHabilitada: () => true,
    subirMidia: async (tenantId: string) => { espioes.subidos += 1; return `tenant/${tenantId}/midia-p11.bin` },
  }
})

vi.mock('./canais/fabrica.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./canais/fabrica.js')>()
  return {
    ...real,
    criarCanal: (provedor: string) => {
      espioes.criados += 1
      return {
        tipo: provedor === 'meta_oficial' ? 'whatsapp_oficial' : 'whatsapp_nao_oficial',
        capacidades: {},
        async enviarTexto(para: string, texto: string) {
          espioes.enviados.push({ para, texto })
          return espioes.enviarOk ? { ok: true, idExterno: `out-${espioes.enviados.length}` } : { ok: false, motivo: 'indisponivel' }
        },
        async baixarMidia(id: string) {
          espioes.baixados.push(id)
          return { ok: true, bytes: Buffer.from([1, 2, 3]), mime: 'image/jpeg' }
        },
      }
    },
  }
})

const { criarApp } = await import('../../app.js')
const { encerrarBanco, comTenantServico } = await import('../../db/index.js')
const { cifrar } = await import('../integracao/cofre.js')
const { processarPosIngestao, purgarPosIngestao, ATRASOS_POS_INGESTAO_MS, MAX_TENTATIVAS_POS_INGESTAO } = await import('../../workers/pos-ingestao.js')
const { normalizarTelefone } = await import('@geracrm/shared')
const { ingerirMensagemEntrante } = await import('./ingestao-mensagem.js')

const T = 'b11e0000-0000-4000-8000-000000000001'
const PV = 'b11e0000-1111-4000-8000-000000000001'
const PLANO = 'b11e0000-3333-4000-8000-000000000001'
const MODELO = 'b11e0000-4444-4000-8000-000000000001'
const NAO = 'b11e0000-5555-4000-8000-000000000001'
const OF = 'b11e0000-5555-4000-8000-000000000002'
const PHONE = 'PHONE-P11-ENXUTO'
const SEGREDO = 'app-secret-p11-enxuto'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
let fetchEspiao: MockInstance<typeof fetch>

/** ⚠️ Todos os dias FECHADOS: ninguém disponível a qualquer hora que a suíte rode. */
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

// Payload REAL do PlugZapi (Z-API ReceivedCallback) com imagem.
const imagemPlugZapi = (id: string) => ({
  type: 'ReceivedCallback', instanceId: 'inst', messageId: id, phone: '5581998610011', fromMe: false, isGroup: false,
  momment: Date.now(), senderName: 'Cliente P11',
  image: { imageUrl: 'https://provedor.example/midia/abc.jpg', caption: 'essa aqui', mimeType: 'image/jpeg' },
})
// Payload REAL da Cloud API (documentação: messages → image com media id).
const imagemMeta = (id: string) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA-P11', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001111', phone_number_id: PHONE },
    contacts: [{ profile: { name: 'Cliente Meta P11' }, wa_id: '5581998610022' }],
    messages: [{ from: '5581998610022', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image',
      image: { caption: 'tem dessa?', mime_type: 'image/jpeg', sha256: 'abc', id: 'MEDIA-P11-1' } }],
  } }] }],
})
const assinar = (c: string) => 'sha256=' + createHmac('sha256', SEGREDO).update(Buffer.from(c)).digest('hex')

const tarefas = () => dono<{ tipo: string; estado: string; tentativas: number; executar_em: Date; dados: { url?: string }; detalhe: string | null; canal_id: string }[]>`
  SELECT tipo, estado, tentativas, executar_em, dados, detalhe, canal_id FROM tarefa_pos_ingestao
   WHERE tenant_id = ${T} ORDER BY canal_id, tipo`
const salientes = () => dono<{ n: number }[]>`
  SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T} AND direcao = 'saliente'`

beforeAll(async () => {
  process.env.META_APP_SECRET = SEGREDO
  // ⚠️ Não-oficial com credencial nasce 'conectando': o vigia de conexão
  //    (vigia-canal.test, em paralelo) varre 'conectado' de TODOS os tenants e
  //    mudaria o estado deste canal no meio do teste. O gateway envia igual.
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-p11-enxuto', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-p11-enxuto', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'P11 Enxuto', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${NAO}, 'whatsapp_nao_oficial', 'plugzapi', 'Não oficial', 'conectando',
                     ${cifrar({ instanceId: 'i', token: 't', clientToken: 'c' })}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas, identificador_externo)
             VALUES (${T}, ${OF}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado',
                     ${cifrar({ telefone: '5585900001111', wabaId: 'WABA-P11', phoneNumberId: PHONE, token: 'tok' })}, ${PHONE})
             ON CONFLICT DO NOTHING`
  for (const c of [NAO, OF]) {
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento, mensagem_ausencia)
               VALUES (${T}, ${c}, ${dono.json(SEMPRE_FECHADO)}, 'Estamos fechados agora.') ON CONFLICT DO NOTHING`
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  espioes.criados = 0; espioes.enviados = []; espioes.baixados = []; espioes.subidos = 0; espioes.enviarOk = true
  fetchEspiao?.mockRestore()
  fetchEspiao = vi.spyOn(globalThis, 'fetch')
  await dono`DELETE FROM tarefa_pos_ingestao WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
})

afterAll(async () => {
  fetchEspiao?.mockRestore()
  for (const t of ['tarefa_pos_ingestao', 'outbox', 'mensagem_id_externo', 'mensagem', 'conversa', 'contato_telefone', 'contato', 'canal_configuracao', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

const nenhumaRede = () => {
  expect(fetchEspiao).not.toHaveBeenCalled()
  expect(espioes.criados).toBe(0)
  expect(espioes.enviados).toEqual([])
  expect(espioes.baixados).toEqual([])
  expect(espioes.subidos).toBe(0)
}

describe('Webhook enxuto — nenhum adaptador de rede dentro do request', () => {
  it('não-oficial com imagem, fora do expediente: 200, nada de rede, ausência e mídia AGENDADAS', async () => {
    const r = await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-NAO-1') })
    expect(r.statusCode).toBe(200)
    nenhumaRede()
    expect((await salientes())[0]!.n).toBe(0)   // a ausência NÃO saiu no request
    const t = await tarefas()
    expect(t.map((x) => [x.tipo, x.estado])).toEqual([['automatica', 'pendente'], ['midia', 'pendente']])
    expect(t[1]!.dados.url).toBe('https://provedor.example/midia/abc.jpg')
  })

  it('Meta com imagem: 200, nada de rede, mídia agendada com o media id', async () => {
    const corpo = imagemMeta('wamid.P11-OF-1')
    const r = await app.inject({ method: 'POST', url: '/webhooks/meta', payload: corpo,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo) } })
    expect(r.statusCode).toBe(200)
    nenhumaRede()
    const t = await tarefas()
    expect(t.map((x) => [x.tipo, x.dados.url ?? null])).toEqual([['automatica', null], ['midia', 'meta:media:MEDIA-P11-1']])
  })

  it('⚠️ reentrega da mesma mensagem não agenda de novo (idempotente)', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-NAO-DUP') })
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-NAO-DUP') })
    expect(await tarefas()).toHaveLength(2)
    nenhumaRede()
  })
})

describe('Worker de pós-ingestão — a rede sai daqui, com retry', () => {
  it('executa a ausência e a mídia (Meta e não-oficial) e marca feitas', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-NAO-W') })
    const corpo = imagemMeta('wamid.P11-OF-W')
    await app.inject({ method: 'POST', url: '/webhooks/meta', payload: corpo,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo) } })
    nenhumaRede()
    fetchEspiao.mockResolvedValue(new Response(Buffer.from([9, 9, 9]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))

    const r = await processarPosIngestao(dono as never, { somenteTenant: T }, new Date())
    expect(r).toMatchObject({ processadas: 4, feitas: 4, reagendadas: 0, falharam: 0 })
    expect(espioes.enviados.map((e) => e.texto)).toEqual(['Estamos fechados agora.', 'Estamos fechados agora.'])
    expect(espioes.baixados).toEqual(['MEDIA-P11-1'])          // Meta: pelo adaptador, com o token
    expect(fetchEspiao).toHaveBeenCalledWith('https://provedor.example/midia/abc.jpg', expect.anything())
    expect(espioes.subidos).toBe(2)
    expect((await tarefas()).every((t) => t.estado === 'feita')).toBe(true)
    const midias = await dono<{ conteudo: { imagem: string } }[]>`
      SELECT conteudo FROM mensagem WHERE tenant_id = ${T} AND tipo = 'imagem'`
    expect(midias.map((m) => m.conteudo.imagem)).toEqual([`tenant/${T}/midia-p11.bin`, `tenant/${T}/midia-p11.bin`])

    // Passada seguinte não refaz nada.
    expect(await processarPosIngestao(dono as never, { somenteTenant: T }, new Date())).toMatchObject({ processadas: 0 })
  })

  it('falha de rede reagenda com backoff e a tentativa seguinte conclui', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-NAO-R') })
    let falhar = true
    const copiar = vi.fn(async () => !falhar)
    const agora = new Date()
    const r1 = await processarPosIngestao(dono as never, { somenteTenant: T, copiar, responder: async () => respostaFalsa('enviada') }, agora)
    expect(r1).toMatchObject({ feitas: 1, reagendadas: 1 })
    const [, midia] = await tarefas()
    expect(midia).toMatchObject({ estado: 'pendente', tentativas: 1, detalhe: 'download/cópia falhou' })
    expect(midia!.executar_em.getTime()).toBe(agora.getTime() + ATRASOS_POS_INGESTAO_MS[0]!)

    // Antes do atraso, nada; depois, conclui.
    expect(await processarPosIngestao(dono as never, { somenteTenant: T, copiar }, new Date(agora.getTime() + 1000))).toMatchObject({ processadas: 0 })
    falhar = false
    const r2 = await processarPosIngestao(dono as never, { somenteTenant: T, copiar }, new Date(agora.getTime() + ATRASOS_POS_INGESTAO_MS[0]! + 1))
    expect(r2).toMatchObject({ feitas: 1 })
    expect((await tarefas())[1]).toMatchObject({ estado: 'feita', tentativas: 2 })
  })

  it('esgotou as tentativas → falhou com o detalhe (a mensagem segue com a URL do provedor)', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-NAO-F') })
    const copiar = vi.fn(async () => { throw new Error('provedor fora') })
    let agora = new Date()
    for (let i = 0; i < MAX_TENTATIVAS_POS_INGESTAO.midia; i++) {
      await processarPosIngestao(dono as never, { somenteTenant: T, copiar, responder: async () => respostaFalsa('tem_quem_atenda') }, agora)
      agora = new Date(agora.getTime() + 60 * 60_000)
    }
    expect(copiar).toHaveBeenCalledTimes(MAX_TENTATIVAS_POS_INGESTAO.midia)
    expect((await tarefas())[1]).toMatchObject({ estado: 'falhou', detalhe: 'erro: provedor fora' })
    const [m] = await dono<{ conteudo: { imagem: string } }[]>`SELECT conteudo FROM mensagem WHERE tenant_id = ${T} AND tipo = 'imagem'`
    expect(m!.conteudo.imagem).toBe('https://provedor.example/midia/abc.jpg')
  })

  it('ausência com envio recusado/transporte reagenda; a próxima passada envia', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-NAO-A') })
    espioes.enviarOk = false
    const agora = new Date()
    const copiar = async () => true
    expect(await processarPosIngestao(dono as never, { somenteTenant: T, copiar }, agora)).toMatchObject({ reagendadas: 1, feitas: 1 })
    espioes.enviarOk = true
    expect(await processarPosIngestao(dono as never, { somenteTenant: T, copiar }, new Date(agora.getTime() + ATRASOS_POS_INGESTAO_MS[0]! + 1)))
      .toMatchObject({ feitas: 1 })
    const [auto] = await tarefas()
    expect(auto).toMatchObject({ tipo: 'automatica', estado: 'feita', tentativas: 2 })
    expect(auto!.detalhe).toContain('ausencia=enviada')
  })
})

describe('Ausência no worker: só transporte re-tenta; atrasada ou já respondida não sai', () => {
  const textoDe = (id: string) => ({ ...imagemPlugZapi(id), image: undefined, text: { message: 'oi' } })
  const bolhas = () => dono<{ status: string }[]>`
    SELECT status FROM mensagem WHERE tenant_id = ${T} AND direcao = 'saliente' AND conteudo->>'automatica' = 'ausencia'`

  it('⚠️ contato em OPT-OUT escreve duas vezes: no máximo 1 tentativa, 1 bolha, e o throttle de 6 h segura a segunda', async () => {
    const chave = normalizarTelefone('5581998610011')!.chaveBloqueio
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo) VALUES (${T}, ${chave}, 'opt_out') ON CONFLICT DO NOTHING`
    try {
      await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: textoDe('P11-OPT-1') })
      const r1 = await processarPosIngestao(dono as never, { somenteTenant: T }, new Date())
      expect(r1).toMatchObject({ processadas: 1, feitas: 1, reagendadas: 0 })   // recusa é FINAL
      expect(espioes.enviados).toEqual([])                                         // o gateway barrou antes do adaptador
      expect(await bolhas()).toEqual([{ status: 'falhou' }])

      await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: { ...textoDe('P11-OPT-2'), momment: Date.now() + 1000 } })
      await processarPosIngestao(dono as never, { somenteTenant: T }, new Date(Date.now() + 2000))
      expect(await bolhas()).toHaveLength(1)                                       // nenhuma bolha repetida
      const ts = await tarefas()
      expect(ts.map((t) => [t.estado, t.tentativas])).toEqual([['feita', 1], ['feita', 1]])
      expect(ts.some((t) => t.detalhe?.includes('ausencia=ja_respondida'))).toBe(true)
    } finally {
      await dono`DELETE FROM lista_bloqueio WHERE tenant_id = ${T}`
    }
  })

  it('tarefa de ausência com mais de 15 min é descartada (não responde fora de hora)', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: textoDe('P11-VELHA') })
    await dono`UPDATE tarefa_pos_ingestao SET criado_em = now() - interval '16 minutes' WHERE tenant_id = ${T}`
    expect(await processarPosIngestao(dono as never, { somenteTenant: T }, new Date())).toMatchObject({ descartadas: 1, feitas: 0 })
    expect(espioes.enviados).toEqual([])
    expect((await tarefas())[0]!.detalhe).toContain('atrasada')
  })

  it('alguém já respondeu depois da mensagem → a ausência é descartada', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: textoDe('P11-RESPONDIDA') })
    const [c] = await dono<{ id: string }[]>`SELECT id FROM conversa WHERE tenant_id = ${T}`
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, criado_em)
               VALUES (${T}, gen_random_uuid(), ${c!.id}, 'saliente', 'texto', '{"texto":"Oi! Já te ajudo."}'::jsonb, 'enviada', now() + interval '1 second')`
    expect(await processarPosIngestao(dono as never, { somenteTenant: T }, new Date())).toMatchObject({ descartadas: 1 })
    expect(espioes.enviados).toEqual([])
  })
})

describe('Agendar a pós-ingestão falhou', () => {
  it('a mensagem do cliente fica salva, o webhook responde 200 e a ingestão NOMEIA a falha (o webhook loga com a conversa)', async () => {
    // Gatilho só para ESTE tenant: os outros arquivos de teste seguem intactos.
    await dono.unsafe(`CREATE OR REPLACE FUNCTION p11_falha_pos() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id = '${T}' THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END $$`)
    await dono.unsafe(`CREATE TRIGGER p11_falha_pos BEFORE INSERT ON tarefa_pos_ingestao FOR EACH ROW EXECUTE FUNCTION p11_falha_pos()`)
    try {
      const r = await comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, NAO, {
        deE164: '5581998610011', idExterno: 'P11-FALHA-POS', tipo: 'texto', texto: 'oi', recebidaEm: new Date(),
      }))
      expect(r).toMatchObject({ ok: true, duplicada: false, posIngestaoFalhou: expect.stringContaining('falha simulada') })
      const w = await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: { ...imagemPlugZapi('P11-FALHA-POS-2') } })
      expect(w.statusCode).toBe(200)
      const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM mensagem WHERE tenant_id = ${T} AND direcao = 'entrante'`
      expect(n!.n).toBe(2)
      expect(await tarefas()).toEqual([])
    } finally {
      await dono.unsafe('DROP TRIGGER IF EXISTS p11_falha_pos ON tarefa_pos_ingestao')
      await dono.unsafe('DROP FUNCTION IF EXISTS p11_falha_pos()')
    }
  })
})

describe('Retenção da tarefa_pos_ingestao', () => {
  it('purga só as CONCLUÍDAS há mais de 30 dias; pendente nunca sai', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-PURGA') })
    // automatica: feita há 31 dias; midia: pendente velha.
    await dono`UPDATE tarefa_pos_ingestao SET estado = 'feita', concluido_em = now() - interval '31 days'
                WHERE tenant_id = ${T} AND tipo = 'automatica'`
    await dono`UPDATE tarefa_pos_ingestao SET criado_em = now() - interval '60 days' WHERE tenant_id = ${T} AND tipo = 'midia'`
    expect(await purgarPosIngestao(dono as never, new Date(), T)).toBe(1)
    expect((await tarefas()).map((t) => [t.tipo, t.estado])).toEqual([['midia', 'pendente']])
    await dono`UPDATE tarefa_pos_ingestao SET estado = 'falhou', concluido_em = now() - interval '29 days' WHERE tenant_id = ${T}`
    expect(await purgarPosIngestao(dono as never, new Date(), T)).toBe(0)
  })
})

describe('⚠️ Isolamento da tarefa_pos_ingestao (papel da aplicação, RLS)', () => {
  const OUTRO = 'b11e0000-0000-4000-8000-0000000000ff'
  it('outro tenant não lê nem grava tarefa deste', async () => {
    await app.inject({ method: 'POST', url: `/webhooks/plugzapi/${NAO}`, payload: imagemPlugZapi('P11-NAO-RLS') })
    expect(await tarefas()).toHaveLength(2)
    const visto = await comTenantServico(OUTRO, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM tarefa_pos_ingestao`)
    expect(visto[0]!.n).toBe(0)
    const [m] = await dono<{ conversa_id: string; id: string; criado_em: Date }[]>`SELECT conversa_id, id, criado_em FROM mensagem WHERE tenant_id = ${T} LIMIT 1`
    await expect(comTenantServico(OUTRO, (tx) => tx`
      INSERT INTO tarefa_pos_ingestao (tenant_id, id, tipo, conversa_id, canal_id, mensagem_id, mensagem_criado_em)
      VALUES (${T}, gen_random_uuid(), 'automatica', ${m!.conversa_id}, ${NAO}, gen_random_uuid(), now())`)).rejects.toThrow(/row-level security/)
    const [papel] = await comTenantServico(OUTRO, (tx) => tx<{ bypass: boolean }[]>`SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`)
    expect(papel!.bypass).toBe(false)
  })
})

function respostaFalsa(ausencia: string) {
  return { ausencia, agenteFalou: false, agenteEncerrouPor: null, agenteMotivo: 'agente_desligado', agenteDetalhe: null, disponibilidade: 'fora do expediente' }
}
