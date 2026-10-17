import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type MockInstance } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { encerrarBanco } from '../../db/index.js'
import { cifrar } from '../integracao/cofre.js'
import { parseWebhookMeta } from './canais/meta.js'
import { sincronizarRoteamentoMeta } from '../../workers/pos-ingestao.js'

/**
 * Webhooks da Meta POR WABA (raia P11): qualidade do número, restrição de conta
 * e status de template. Fixtures no formato da documentação oficial da Cloud
 * API (Webhooks → phone_number_quality_update, account_update,
 * message_template_status_update).
 *
 * Qualidade RED/FLAGGED suspende as ATIVAS do número + alerta 'qualidade_numero'
 * + notificação; GREEN/UNFLAGGED libera. Conta restrita suspende e não libera
 * sozinha. Status de template é persistido. Tudo só banco, tudo idempotente,
 * e nenhum `fetch` dentro do request.
 */
const A = 'b11b0000-0000-4000-8000-000000000001'
const B = 'b11b0000-0000-4000-8000-000000000002'
const PV_A = 'b11b0000-1111-4000-8000-000000000001'
const PV_B = 'b11b0000-1111-4000-8000-000000000002'
const PLANO = 'b11b0000-3333-4000-8000-000000000001'
const MODELO = 'b11b0000-4444-4000-8000-000000000001'
const CANAL_A = 'b11b0000-5555-4000-8000-000000000001'
const CANAL_A2 = 'b11b0000-5555-4000-8000-000000000002'
const CANAL_B = 'b11b0000-5555-4000-8000-000000000003'
const USUARIO_A = 'b11b0000-6666-4000-8000-000000000001'
const TPL_A = 'b11b0000-8888-4000-8000-000000000001'
const TPL_B = 'b11b0000-8888-4000-8000-000000000002'
const WABA_A = '102290129340398'
const WABA_B = '102290129349999'
const SEGREDO = 'app-secret-p11-qualidade'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
let fetchEspiao: MockInstance<typeof fetch>

const assinar = (c: string) => 'sha256=' + createHmac('sha256', SEGREDO).update(Buffer.from(c)).digest('hex')
const postar = (corpo: object) => {
  const c = JSON.stringify(corpo)
  return app.inject({ method: 'POST', url: '/webhooks/meta', payload: c,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(c) } })
}

// ── Fixtures da documentação da Meta ──────────────────────────────────────
const qualidade = (event: string, display = '15550783881', waba = WABA_A, extra: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: waba, time: 1674864290, changes: [{
    field: 'phone_number_quality_update',
    value: { display_phone_number: display, event, current_limit: 'TIER_10K', ...extra },
  }] }],
})
const conta = (event: string, extra: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA_A, time: 1739321024, changes: [{
    field: 'account_update',
    value: { phone_number: '15550783881', event, ...extra },
  }] }],
})
const templateStatus = (event: string, extra: Record<string, unknown> = {}, waba = WABA_A) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: waba, time: 1674864290, changes: [{
    field: 'message_template_status_update',
    value: { event, message_template_id: 594425479261596, message_template_name: 'retorno_pedido',
      message_template_language: 'pt_BR', reason: 'NONE', ...extra },
  }] }],
})

const canal = (id: string) => dono<{ suspensa: Date | null; motivo: string | null }[]>`
  SELECT ativas_suspensas_em AS suspensa, ativas_suspensas_motivo AS motivo FROM canal_conectado WHERE id = ${id}`
const alertas = (t = A) => dono<{ tipo: string; severidade: string; resolvido_em: Date | null; mensagem: string }[]>`
  SELECT tipo, severidade, resolvido_em, mensagem FROM alerta WHERE tenant_id = ${t} AND tipo = 'qualidade_numero' ORDER BY criado_em`
const notificacoes = () => dono<{ tipo: string; titulo: string; conversa_id: string | null }[]>`
  SELECT tipo, titulo, conversa_id FROM notificacao WHERE tenant_id = ${A}`
const versao = (tpl: string) => dono<{ status_meta: string; motivo_rejeicao: string | null; id_externo: string | null; status_evento_meta: string | null }[]>`
  SELECT status_meta, motivo_rejeicao, id_externo, status_evento_meta FROM template_versao WHERE template_id = ${tpl} ORDER BY versao`

beforeAll(async () => {
  process.env.META_APP_SECRET = SEGREDO
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-p11-qualidade', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-p11-qualidade', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, 'P11 Qualidade', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  const oficial = (t: string, id: string, nome: string, waba: string, tel: string, phoneId: string) => dono`
    INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas, identificador_externo)
    VALUES (${t}, ${id}, 'whatsapp_oficial', 'meta_oficial', ${nome}, 'conectado',
            ${cifrar({ telefone: tel, wabaId: waba, phoneNumberId: phoneId, token: 'tok' })}, ${phoneId})
    ON CONFLICT DO NOTHING`
  await oficial(A, CANAL_A, 'Vendas', WABA_A, '+1 555-078-3881', 'PN-P11-A1')
  await oficial(A, CANAL_A2, 'Pós-venda', WABA_A, '15550009999', 'PN-P11-A2')
  await oficial(B, CANAL_B, 'Outra loja', WABA_B, '15550783881', 'PN-P11-B1')
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${A}, ${USUARIO_A}, 'sub-p11-qualidade', 'Gi', 'gi@p11.test') ON CONFLICT DO NOTHING`
  for (const [t, id] of [[A, TPL_A], [B, TPL_B]] as const) {
    await dono`INSERT INTO template (tenant_id, id, nome, categoria, idioma) VALUES (${t}, ${id}, 'retorno_pedido', 'UTILITY', 'pt_BR') ON CONFLICT DO NOTHING`
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  fetchEspiao?.mockRestore()
  fetchEspiao = vi.spyOn(globalThis, 'fetch')
  for (const t of [A, B]) {
    await dono`DELETE FROM alerta WHERE tenant_id = ${t}`
    await dono`DELETE FROM notificacao WHERE tenant_id = ${t}`
    await dono`DELETE FROM canal_saude_evento WHERE tenant_id = ${t}`
    await dono`DELETE FROM outbox WHERE tenant_id = ${t}`
    await dono`DELETE FROM template_versao WHERE tenant_id = ${t}`
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL, meta_waba_id = NULL, meta_telefone = NULL, meta_roteamento_em = NULL WHERE tenant_id = ${t}`
  }
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta) VALUES
             (${A}, ${TPL_A}, 1, '{"body":{"texto":"Oi"}}'::jsonb, 'PENDING'),
             (${B}, ${TPL_B}, 1, '{"body":{"texto":"Oi"}}'::jsonb, 'PENDING')`
  // O roteamento por WABA sai da credencial cifrada, pelo worker de pós-ingestão.
  for (const t of [A, B]) await sincronizarRoteamentoMeta(dono as never, new Date(), t)
})

afterAll(async () => {
  fetchEspiao?.mockRestore()
  for (const t of [A, B]) {
    for (const tab of ['alerta', 'notificacao', 'canal_saude_evento', 'outbox', 'template_versao', 'template', 'usuario', 'canal_conectado']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

describe('Roteamento por WABA', () => {
  it('o worker copia WABA e telefone (só dígitos) da credencial cifrada para as colunas de roteamento', async () => {
    const [c] = await dono<{ meta_waba_id: string; meta_telefone: string }[]>`SELECT meta_waba_id, meta_telefone FROM canal_conectado WHERE id = ${CANAL_A}`
    expect(c).toEqual({ meta_waba_id: WABA_A, meta_telefone: '15550783881' })
  })

  it('rodízio: conferido há menos de 10 min não é decifrado de novo; depois, é corrigido; credencial sem WABA registra o erro', async () => {
    await dono`UPDATE canal_conectado SET meta_waba_id = 'ERRADO' WHERE id = ${CANAL_A}`
    const agora = new Date()
    expect(await sincronizarRoteamentoMeta(dono as never, agora, A)).toBe(0)
    expect((await dono<{ w: string }[]>`SELECT meta_waba_id AS w FROM canal_conectado WHERE id = ${CANAL_A}`)[0]!.w).toBe('ERRADO')
    expect(await sincronizarRoteamentoMeta(dono as never, new Date(agora.getTime() + 11 * 60_000), A)).toBe(1)
    expect((await dono<{ w: string }[]>`SELECT meta_waba_id AS w FROM canal_conectado WHERE id = ${CANAL_A}`)[0]!.w).toBe(WABA_A)

    await dono`UPDATE canal_conectado SET credenciais_cifradas = ${cifrar({ phoneNumberId: 'PN-P11-A2', token: 't' })}, meta_roteamento_em = NULL
                WHERE id = ${CANAL_A2}`
    try {
      await sincronizarRoteamentoMeta(dono as never, agora, A)
      const [c] = await dono<{ erro: string | null; em: Date | null }[]>`
        SELECT meta_roteamento_erro AS erro, meta_roteamento_em AS em FROM canal_conectado WHERE id = ${CANAL_A2}`
      expect(c).toMatchObject({ erro: 'credencial sem wabaId' })
      expect(c!.em).not.toBeNull()   // carimbado: não volta a cada 2 s
    } finally {
      await dono`UPDATE canal_conectado SET credenciais_cifradas = ${cifrar({ telefone: '15550009999', wabaId: WABA_A, phoneNumberId: 'PN-P11-A2', token: 'tok' })}
                  WHERE id = ${CANAL_A2}`
    }
  })

  it('display_phone_number divergente: com UM canal na WABA aplica a ele; com vários, não aplica', async () => {
    await postar(qualidade('FLAGGED', '19999999999', WABA_B))      // WABA_B tem só CANAL_B
    expect((await canal(CANAL_B))[0]!.suspensa).not.toBeNull()
    await postar(qualidade('FLAGGED', '19999999999', WABA_A))      // WABA_A tem dois
    expect((await canal(CANAL_A))[0]!.suspensa).toBeNull()
    expect((await canal(CANAL_A2))[0]!.suspensa).toBeNull()
  })

  it('WABA desconhecida → 200 e nada muda (falha permanente não trava a fila)', async () => {
    const r = await postar(qualidade('FLAGGED', '15550783881', '999999'))
    expect(r.statusCode).toBe(200)
    expect((await canal(CANAL_A))[0]!.suspensa).toBeNull()
  })
})

describe('Qualidade do número', () => {
  it('⚠️ FLAGGED suspende as ativas SÓ daquele número, abre o alerta crítico e notifica — sem rede no request', async () => {
    const r = await postar(qualidade('FLAGGED'))
    expect(r.statusCode).toBe(200)
    expect(fetchEspiao).not.toHaveBeenCalled()
    expect((await canal(CANAL_A))[0]).toMatchObject({ motivo: 'qualidade:FLAGGED' })
    expect((await canal(CANAL_A))[0]!.suspensa).not.toBeNull()
    expect((await canal(CANAL_A2))[0]!.suspensa).toBeNull()      // outro número da mesma WABA
    expect((await canal(CANAL_B))[0]!.suspensa).toBeNull()       // mesmo telefone, OUTRA WABA/tenant
    const [al] = await alertas()
    expect(al).toMatchObject({ severidade: 'critico', resolvido_em: null })
    expect(al!.mensagem).toContain('Vendas')
    expect(await notificacoes()).toEqual([{ tipo: 'canal.qualidade', titulo: expect.stringContaining('Vendas'), conversa_id: null }])
    const ev = await dono<{ tipo: string; payload: object }[]>`SELECT tipo, payload FROM outbox WHERE tenant_id = ${A} ORDER BY id`
    expect(ev.map((e) => e.tipo).sort()).toEqual(['alerta.novo', 'notificacao.nova'])
    // ⚠️ Payload sem conteúdo (ADR-007): só ids.
    for (const e of ev) expect(JSON.stringify(e.payload)).not.toContain('Vendas')
    expect(await alertas(B)).toEqual([])
  })

  it('⚠️ reentrega do mesmo evento é idempotente: um alerta, uma notificação, um registro de saúde', async () => {
    await postar(qualidade('FLAGGED'))
    await postar(qualidade('FLAGGED'))
    expect(await alertas()).toHaveLength(1)
    expect(await notificacoes()).toHaveLength(1)
    const [s] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM canal_saude_evento WHERE canal_id = ${CANAL_A}`
    expect(s!.n).toBe(1)
  })

  it('nota RED suspende e nota GREEN libera (quando a Meta manda a nota), resolvendo o alerta', async () => {
    await postar(qualidade('DOWNGRADE', '15550783881', WABA_A, { current_quality_rating: 'RED' }))
    expect((await canal(CANAL_A))[0]!.suspensa).not.toBeNull()
    await postar(qualidade('ONBOARDING', '15550783881', WABA_A, { current_quality_rating: 'GREEN' }))
    expect((await canal(CANAL_A))[0]!.suspensa).toBeNull()
    expect((await alertas())[0]!.resolvido_em).not.toBeNull()
  })

  it('UNFLAGGED libera; com outro número ainda suspenso, o alerta continua aberto', async () => {
    await postar(qualidade('FLAGGED'))
    await postar(qualidade('FLAGGED', '15550009999'))
    await postar(qualidade('UNFLAGGED'))
    expect((await canal(CANAL_A))[0]!.suspensa).toBeNull()
    expect((await canal(CANAL_A2))[0]!.suspensa).not.toBeNull()
    expect((await alertas())[0]!.resolvido_em).toBeNull()
    await postar(qualidade('UNFLAGGED', '15550009999'))
    expect((await alertas())[0]!.resolvido_em).not.toBeNull()
  })

  it('evento informativo (YELLOW sem mudança de faixa) só vai para o histórico', async () => {
    await postar(qualidade('ONBOARDING', '15550783881', WABA_A, { current_quality_rating: 'YELLOW' }))
    expect((await canal(CANAL_A))[0]!.suspensa).toBeNull()
    const [s] = await dono<{ para: string }[]>`SELECT para FROM canal_saude_evento WHERE canal_id = ${CANAL_A}`
    expect(s!.para).toBe('ONBOARDING:YELLOW')
  })
})

describe('Restrição da conta (account_update)', () => {
  it('ACCOUNT_VIOLATION suspende o número e NÃO volta sozinha com UNFLAGGED', async () => {
    await postar(conta('ACCOUNT_VIOLATION', { violation_info: { violation_type: 'SCAM' } }))
    expect((await canal(CANAL_A))[0]).toMatchObject({ motivo: 'conta:ACCOUNT_VIOLATION' })
    await postar(qualidade('UNFLAGGED'))
    expect((await canal(CANAL_A))[0]!.suspensa).not.toBeNull()
  })

  it('⚠️ restrição de conta chegando com suspensão de QUALIDADE ativa agrava o motivo; UNFLAGGED/GREEN não libera', async () => {
    await postar(qualidade('FLAGGED'))
    expect((await canal(CANAL_A))[0]).toMatchObject({ motivo: 'qualidade:FLAGGED' })
    await postar(conta('ACCOUNT_RESTRICTION'))
    expect((await canal(CANAL_A))[0]).toMatchObject({ motivo: 'conta:ACCOUNT_RESTRICTION' })
    expect((await alertas())[0]!.mensagem).toContain('restringiu a conta')
    await postar(qualidade('UNFLAGGED'))
    await postar(qualidade('ONBOARDING', '15550783881', WABA_A, { current_quality_rating: 'GREEN' }))
    expect((await canal(CANAL_A))[0]!.suspensa).not.toBeNull()
    expect((await alertas())[0]!.resolvido_em).toBeNull()
  })

  it('DISABLED_UPDATE com ban_info em lista (formato da documentação) é classificado como restrição', () => {
    const [ev] = parseWebhookMeta({ object: 'whatsapp_business_account', entry: [{ id: WABA_A, changes: [{
      field: 'account_update', value: { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: ['DISABLE'], waba_ban_date: 'November 9, 2022' } } }] }] })
    expect(ev).toMatchObject({ tipo: 'qualidade', campo: 'account_update', baixa: true, telefone: null, detalhe: 'DISABLE' })
  })
})

describe('Status de template', () => {
  it('APPROVED persiste status, id na Meta e o evento cru — só no tenant da WABA', async () => {
    const r = await postar(templateStatus('APPROVED'))
    expect(r.statusCode).toBe(200)
    expect((await versao(TPL_A))[0]).toEqual({ status_meta: 'APPROVED', motivo_rejeicao: null, id_externo: '594425479261596', status_evento_meta: 'APPROVED' })
    expect((await versao(TPL_B))[0]!.status_meta).toBe('PENDING')   // mesmo nome, outro tenant
  })

  it('REJECTED guarda o motivo; PAUSED e REINSTATED seguem o ciclo; FLAGGED só registra o evento', async () => {
    await postar(templateStatus('REJECTED', { reason: 'INCORRECT_CATEGORY' }))
    expect((await versao(TPL_A))[0]).toMatchObject({ status_meta: 'REJECTED', motivo_rejeicao: 'INCORRECT_CATEGORY' })
    await postar(templateStatus('APPROVED'))
    await postar(templateStatus('PAUSED', { other_info: { title: 'FIRST_PAUSE', description: 'Qualidade baixa' } }))
    expect((await versao(TPL_A))[0]!.status_meta).toBe('PAUSED')
    await postar(templateStatus('REINSTATED'))
    expect((await versao(TPL_A))[0]).toMatchObject({ status_meta: 'APPROVED', status_evento_meta: 'REINSTATED' })
    await postar(templateStatus('FLAGGED'))
    expect((await versao(TPL_A))[0]).toMatchObject({ status_meta: 'APPROVED', status_evento_meta: 'FLAGGED' })
  })

  it('aprovar a versão nova desativa a aprovada anterior (uma aprovada por template)', async () => {
    await dono`UPDATE template_versao SET status_meta = 'APPROVED', id_externo = 'OLD' WHERE template_id = ${TPL_A}`
    await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta) VALUES (${A}, ${TPL_A}, 2, '{"body":{"texto":"Oi 2"}}'::jsonb, 'PENDING')`
    await postar(templateStatus('APPROVED', { message_template_id: 'NOVO' }))
    expect((await versao(TPL_A)).map((v) => v.status_meta)).toEqual(['DISABLED', 'APPROVED'])
  })

  it('⚠️ fora de ordem: evento GERADO antes do último aplicado (entry.time) não regride o status', async () => {
    const evento = (event: string, t: number) => ({ ...templateStatus(event), entry: [{ ...templateStatus(event).entry[0]!, time: t }] })
    await postar(evento('REINSTATED', 1_700_000_200))
    await postar(evento('PAUSED', 1_700_000_100))   // chegou depois, mas é mais velho
    expect((await versao(TPL_A))[0]).toMatchObject({ status_meta: 'APPROVED', status_evento_meta: 'REINSTATED' })
    await postar(evento('PAUSED', 1_700_000_300))
    expect((await versao(TPL_A))[0]!.status_meta).toBe('PAUSED')
  })

  it('template desconhecido → 200 sem efeito', async () => {
    expect((await postar(templateStatus('APPROVED', { message_template_name: 'nao_existe' }))).statusCode).toBe(200)
    expect((await versao(TPL_A))[0]!.status_meta).toBe('PENDING')
  })
})
