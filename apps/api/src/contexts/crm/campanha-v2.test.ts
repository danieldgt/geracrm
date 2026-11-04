import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import { cifrar } from '../integracao/cofre.js'
import type { PortaCanal, TemplateParaEnvio } from '../atendimento/canais/porta.js'
import { lerPublico, materializarFatia } from './campanha-publico.js'

/**
 * CAMPANHAS V2 — API (F1a). Fixa o contrato que a tela (F1b) vai consumir:
 *   - prévia com CADA exclusão contada pelo motivo, custo pelos preços da F2 e duração
 *     pelo lote diário; amostra sem dado além de nome e cidade;
 *   - template OBRIGATÓRIO no oficial (MARKETING, aprovado, variáveis mapeadas);
 *     texto livre só no não oficial e só com o risco de banimento confirmado;
 *   - teste com até 5 números, fora do lote, respeitando o opt-out;
 *   - iniciar só com o NOME digitado; o snapshot é idempotente;
 *   - pausar/retomar/cancelar, destinatários por estado, relatório até a venda;
 *   - papel (admin/gestor escrevem, gestão lê) e dois tenants.
 * ⚠️ Relógio injetado (AGORA) na rota; a Meta nunca é chamada (fábrica de canal falsa).
 */

const T = 'f1a20000-0000-4000-8000-000000000001'
const OUTRO = 'f1a20000-0000-4000-8000-000000000002'
const PV = 'f1a20000-1111-4000-8000-000000000001'
const PV2 = 'f1a20000-1111-4000-8000-000000000002'
const PLANO = 'f1a20000-3333-4000-8000-000000000001'
const MODELO = 'f1a20000-4444-4000-8000-000000000001'
const OFICIAL = 'f1a20000-5555-4000-8000-000000000001'
const NAO_OFICIAL = 'f1a20000-5555-4000-8000-000000000002'
const INSTA = 'f1a20000-5555-4000-8000-000000000003'
const TPL_OK = 'f1a20000-7777-4000-8000-000000000001'
const TPL_SEM_MAP = 'f1a20000-7777-4000-8000-000000000002'
const TPL_UTIL = 'f1a20000-7777-4000-8000-000000000003'
const TPL_PEND = 'f1a20000-7777-4000-8000-000000000004'
const LISTA = 'f1a20000-9999-4000-8000-000000000001'
const ETQ_A = 'f1a20000-aaaa-4000-8000-000000000001'
const ETQ_B = 'f1a20000-aaaa-4000-8000-000000000002'
const ORIGEM = 'f1a20000-bbbb-4000-8000-000000000001'
const F1 = 'f1a20000-cccc-4000-8000-000000000001'
const F2 = 'f1a20000-cccc-4000-8000-000000000002'
const ADMIN = 'f1a20000-8888-4000-8000-000000000001'

const AGORA = new Date('2026-11-03T15:00:00Z') // terça, 12:00 em São Paulo
const DIA = 86_400_000
const antes = (dias: number) => new Date(AGORA.getTime() - dias * DIA)

const pad = (n: number) => String(n).padStart(8, '0')
const contatoId = (n: number) => `f1a20000-6666-4000-8000-${String(n).padStart(12, '0')}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance
/** Gancho do iniciar entre as fatias do snapshot (simula uma edição concorrente). */
let ganchoFatia: (() => Promise<void>) | null = null

/** O que o adaptador falso recebeu (a Meta nunca é chamada). */
const enviados: { para: string; template?: TemplateParaEnvio; texto?: string }[] = []
function criarCanalFalso(): PortaCanal {
  const nao = async () => ({ ok: false as const, motivo: 'indisponivel' as const })
  return {
    tipo: 'whatsapp_oficial',
    capacidades: { janela24h: true, aceitaTemplate: true, riscoBanimento: false, textoLivreSempre: false, sessaoPodeCair: false, indicaDigitacao: false, mensagensInterativas: false },
    enviarTexto: async (para: string, texto: string) => { enviados.push({ para, texto }); return { ok: true as const, idExterno: `wamid.${randomUUID()}` } },
    enviarTemplate: async (para: string, template: TemplateParaEnvio) => { enviados.push({ para, template }); return { ok: true as const, idExterno: `wamid.${randomUUID()}` } },
    enviarImagem: nao, enviarAudio: nao, apagarMensagem: nao, editarMensagem: nao,
    verificarConexao: async () => ({ conectado: true }), qrCode: async () => ({ ok: false as const, motivo: 'x' }),
  } as unknown as PortaCanal
}

const chamar = (t: string, m: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, corpo?: unknown) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo !== undefined ? { payload: corpo as Record<string, unknown> } : {}) })

const PUBLICO = { listas: [LISTA] }
const corpoOficial = (extra: Record<string, unknown> = {}) => ({
  nome: 'Volta às aulas', canalId: OFICIAL, templateId: TPL_OK, publico: PUBLICO, loteDiario: 100, ...extra,
})

async function criar(t = T, corpo: Record<string, unknown> = corpoOficial()): Promise<string> {
  const r = await chamar(t, 'POST', '/v1/campanhas', corpo)
  expect(r.statusCode, r.body).toBe(201)
  return (r.json() as { id: string }).id
}

async function contato(n: number, o: { tel?: { e164: string; chave: string } | null; ativo?: boolean; filial?: string | null; cidade?: string; ultimaVenda?: Date } = {}): Promise<void> {
  const id = contatoId(n)
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo, filial_id, ultima_venda_em, origem_id)
             VALUES (${T}, ${id}, ${'Cliente ' + n}, ${o.ativo ?? true}, ${o.filial ?? null}, ${o.ultimaVenda ?? null}, NULL)`
  const t = o.tel === undefined ? { e164: `+55819${pad(n)}`, chave: `5581${pad(n)}` } : o.tel
  if (t) {
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${T}, ${id}, 1, ${t.e164}, ${t.chave}, true, true, 'teste')`
  }
  if (o.cidade) {
    await dono`INSERT INTO contato_endereco (tenant_id, contato_id, seq, cidade, uf, principal, fonte)
               VALUES (${T}, ${id}, 1, ${o.cidade}, 'PE', true, 'teste')`
  }
  await dono`INSERT INTO lista_membro (tenant_id, lista_id, contato_id) VALUES (${T}, ${LISTA}, ${id})`
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-camp-v2', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-camp-v2', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'Loja Sol'], [OUTRO, PV2, 'Outra']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO filial (tenant_id, id, nome) VALUES (${T}, ${F1}, 'Centro'), (${T}, ${F2}, 'Norte')`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas) VALUES
               (${T}, ${OFICIAL}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado', ${cifrar({ phoneNumberId: 'p', token: 't' })}),
               (${T}, ${NAO_OFICIAL}, 'whatsapp_nao_oficial', 'plugzapi', 'Vendas', 'conectado', ${cifrar({ instancia: 'i', token: 't' })}),
               (${T}, ${INSTA}, 'instagram', 'instagram_meta', 'Insta', 'conectado', NULL)`
  const corpo = (texto: string) => JSON.stringify({ body: { texto } })
  await dono`INSERT INTO template (tenant_id, id, nome, categoria, mapeamento_variaveis) VALUES
               (${T}, ${TPL_OK}, 'volta_aulas', 'MARKETING', '{"1":"contato.nome","2":"empresa.nome"}'::jsonb),
               (${T}, ${TPL_SEM_MAP}, 'sem_mapa', 'MARKETING', '{}'::jsonb),
               (${T}, ${TPL_UTIL}, 'aviso_pedido', 'UTILITY', '{}'::jsonb),
               (${T}, ${TPL_PEND}, 'pendente_meta', 'MARKETING', '{}'::jsonb)`
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta) VALUES
               (${T}, ${TPL_OK}, 1, ${corpo('Olá {{1}}, a {{2}} tem novidade!')}::text::jsonb, 'APPROVED'),
               (${T}, ${TPL_SEM_MAP}, 1, ${corpo('Olá {{1}}!')}::text::jsonb, 'APPROVED'),
               (${T}, ${TPL_UTIL}, 1, ${corpo('Seu pedido saiu.')}::text::jsonb, 'APPROVED'),
               (${T}, ${TPL_PEND}, 1, ${corpo('Promo!')}::text::jsonb, 'PENDING')`
  await dono`INSERT INTO preco_whatsapp (tenant_id, categoria, centavos_por_mensagem) VALUES (${T}, 'marketing', 40)`
  await dono`INSERT INTO lista (tenant_id, id, nome) VALUES (${T}, ${LISTA}, 'Base da prévia')`
  await dono`INSERT INTO etiqueta (tenant_id, id, nome) VALUES (${T}, ${ETQ_A}, 'VIP'), (${T}, ${ETQ_B}, 'Atacado')`
  await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${T}, ${ORIGEM}, 'Feira')`

  // A base da prévia: dois elegíveis, um de cada exclusão, e um da filial Norte.
  await contato(1, { cidade: 'Recife' })
  await contato(2)
  await contato(3)                                   // opt-out
  await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem) VALUES (${T}, ${'5581' + pad(3)}, 'opt_out', 'teste')`
  await contato(4, { ativo: false })                 // anonimizado/inativo
  await contato(5, { tel: null })                    // sem telefone
  await contato(6)                                   // conversa recente
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_mensagem_em, versao)
             VALUES (${T}, ${randomUUID()}, ${NAO_OFICIAL}, ${contatoId(6)}, ${antes(2)}, 1)`
  await contato(7)                                   // campanha recente (legado)
  const velha = randomUUID()
  await dono`INSERT INTO campanha (tenant_id, id, nome, mensagem, estado) VALUES (${T}, ${velha}, 'Antiga', 'x', 'concluida')`
  await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id, estado, enviado_em)
             VALUES (${T}, ${randomUUID()}, ${velha}, ${contatoId(7)}, 'enviado', ${antes(5)})`
  await contato(8, { ultimaVenda: antes(2) })        // compra recente
  await contato(9, { tel: { e164: `+5581${pad(1)}`, chave: `5581${pad(1)}` } }) // mesma chave do 1, sem o nono dígito
  await contato(10, { filial: F2 })                  // de outra filial
  // Etiquetas e origem para o AND/OR.
  await dono`UPDATE contato SET origem_id = ${ORIGEM} WHERE tenant_id = ${T} AND id IN (${contatoId(1)}, ${contatoId(2)})`
  await dono`INSERT INTO contato_etiqueta (tenant_id, contato_id, etiqueta_id) VALUES
               (${T}, ${contatoId(1)}, ${ETQ_A}), (${T}, ${contatoId(2)}, ${ETQ_B}), (${T}, ${contatoId(10)}, ${ETQ_A})`

  app = await criarApp({ campanha: { criarCanal: criarCanalFalso, agora: () => AGORA, aoMaterializarFatia: async () => { await ganchoFatia?.() } } })
  await app.ready()
})

beforeEach(async () => {
  enviados.length = 0
  ganchoFatia = null
  await dono`DELETE FROM auditoria WHERE tenant_id = ${T} AND acao = 'campanha.teste_enviado'`
  await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_aquecimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM campanha_destinatario WHERE tenant_id IN (${T}, ${OUTRO})`
  await dono`DELETE FROM campanha WHERE tenant_id IN (${T}, ${OUTRO}) AND modelo_versao = 2`
  await dono`DELETE FROM usuario_filial WHERE tenant_id = ${T}`
  await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
  await dono`DELETE FROM venda WHERE tenant_id = ${T}`
  await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL WHERE tenant_id = ${T}`
})

afterAll(async () => {
  const tabelas = ['campanha_destinatario', 'campanha_envio', 'campanha', 'auditoria', 'canal_configuracao', 'canal_aquecimento', 'alerta', 'notificacao', 'outbox', 'mensagem', 'conversa',
    'contato_etiqueta', 'etiqueta', 'lista_membro', 'lista', 'lista_bloqueio', 'contato_endereco', 'contato_telefone', 'pedido', 'venda',
    'contato', 'origem', 'preco_whatsapp', 'template_versao', 'template', 'usuario_filial', 'usuario', 'canal_conectado', 'filial']
  for (const t of tabelas) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${T}', '${OUTRO}')`).catch(() => undefined)
  for (const t of [T, OUTRO]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

/** Encerra o modo fundador (outra pessoa é admin) e dá ao usuário do header o papel pedido. */
async function papelDoHeader(papel: string, filial: string | null = null): Promise<void> {
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${ADMIN}, 'sub-f1a2-admin', 'Ada', 'ada@f1a2.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${ADMIN}, NULL, 'admin')`
  await chamar(T, 'GET', '/v1/campanhas') // garante a linha do usuário do header
  const [u] = await dono<{ id: string }[]>`SELECT id FROM usuario WHERE tenant_id = ${T} AND cognito_sub = ${'dev-' + T}`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${u!.id}, ${filial}, ${papel})`
}

describe('Prévia: público, exclusões, custo e duração', () => {
  it('conta cada exclusão pelo motivo; custo = elegíveis × preço de marketing da F2; duração pelo lote', async () => {
    const r = await chamar(T, 'POST', '/v1/campanhas/previa', { canalId: OFICIAL, templateId: TPL_OK, publico: PUBLICO, loteDiario: 2 })
    expect(r.statusCode, r.body).toBe(200)
    const p = r.json() as Record<string, unknown> & { amostra: Record<string, unknown>[] }
    expect(p).toMatchObject({
      total: 10, elegiveis: 3,
      excluidos: { foraDoEscopo: 0, optout: 1, anonimizado: 1, semTelefone: 1, conversaRecente: 1, campanhaRecente: 1, compraRecente: 1, telefoneDuplicado: 1 },
      custoEstimadoCentavos: 120, precoUnitarioCentavos: 40, loteDiario: 2, duracaoDias: 2, aquecimento: null,
      janelaDoNumero: { origem: 'padrao', horario: { seg: { de: '08:00', ate: '20:00' }, dom: null } },
    })
    // Amostra: só nome e cidade — nada de telefone, documento ou valor.
    expect(p.amostra).toHaveLength(3)
    for (const a of p.amostra) expect(Object.keys(a).sort()).toEqual(['cidade', 'nome'])
    expect(p.amostra).toContainEqual({ nome: 'Cliente 1', cidade: 'Recife' })
  })

  it('não oficial não paga a Meta: custo zero', async () => {
    const r = await chamar(T, 'POST', '/v1/campanhas/previa', { canalId: NAO_OFICIAL, publico: PUBLICO })
    expect(r.json()).toMatchObject({ elegiveis: 3, custoEstimadoCentavos: 0, loteDiario: 500, duracaoDias: 1 })
  })

  it('fora do escopo: supervisor da filial Centro não alcança o contato da filial Norte', async () => {
    await papelDoHeader('supervisor', F1)
    const r = await chamar(T, 'POST', '/v1/campanhas/previa', { canalId: OFICIAL, templateId: TPL_OK, publico: PUBLICO })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ total: 10, elegiveis: 2, excluidos: { foraDoEscopo: 1 } })
  })

  it('as janelas "recente" são configuráveis (0 desliga); opt-out, inativo e sem telefone não', async () => {
    const r = await chamar(T, 'POST', '/v1/campanhas/previa', {
      canalId: OFICIAL, templateId: TPL_OK,
      publico: { ...PUBLICO, exclusoes: { conversaRecenteDias: 0, campanhaRecenteDias: 0, compraRecenteDias: 0 } },
    })
    expect(r.json()).toMatchObject({ elegiveis: 6, excluidos: { optout: 1, anonimizado: 1, semTelefone: 1, telefoneDuplicado: 1, conversaRecente: 0 } })
  })

  it('AND entre tipos, OR dentro do tipo: (VIP ou Atacado) E origem Feira', async () => {
    const r = await chamar(T, 'POST', '/v1/campanhas/previa', {
      canalId: OFICIAL, templateId: TPL_OK, publico: { etiquetas: [ETQ_A, ETQ_B], origens: [ORIGEM] },
    })
    expect(r.json()).toMatchObject({ total: 2, elegiveis: 2 })
    const so = await chamar(T, 'POST', '/v1/campanhas/previa', { canalId: OFICIAL, templateId: TPL_OK, publico: { etiquetas: [ETQ_A] } })
    expect(so.json()).toMatchObject({ total: 2 }) // contatos 1 e 10
  })

  it('público inválido → 422 com o campo', async () => {
    const r = await chamar(T, 'POST', '/v1/campanhas/previa', { canalId: OFICIAL, publico: { segmentos: ['nao-existe'] } })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'campanha.publico_invalido', campos: { 'publico.segmentos.0': 'Inválido.' } })
    const extra = await chamar(T, 'POST', '/v1/campanhas/previa', { canalId: OFICIAL, publico: { cidade: 'Recife' } })
    expect(extra.statusCode).toBe(422)
  })
})

describe('Conteúdo: template obrigatório no oficial, risco confirmado no não oficial', () => {
  it('oficial sem template, com UTILITY, pendente, sem mapeamento ou com texto livre → 422 nomeado', async () => {
    const casos: [Record<string, unknown>, string][] = [
      [{ templateId: undefined }, 'campanha.template_obrigatorio'],
      [{ templateId: TPL_UTIL }, 'campanha.template_categoria'],
      [{ templateId: TPL_PEND }, 'campanha.template_nao_aprovado'],
      [{ templateId: TPL_SEM_MAP }, 'campanha.template_sem_mapeamento'],
      [{ mensagem: 'Oi!' }, 'campanha.texto_livre_so_nao_oficial'],
    ]
    for (const [extra, erro] of casos) {
      const r = await chamar(T, 'POST', '/v1/campanhas', corpoOficial(extra))
      expect(r.statusCode, erro).toBe(422)
      expect(r.json(), erro).toMatchObject({ erro })
    }
    const sem = await chamar(T, 'POST', '/v1/campanhas', corpoOficial({ templateId: TPL_SEM_MAP }))
    expect(sem.json()).toMatchObject({ faltando: [1], campos: { templateId: expect.any(String) } })
    expect(await dono`SELECT 1 FROM campanha WHERE tenant_id = ${T} AND modelo_versao = 2`).toHaveLength(0)
  })

  it('oficial com template de marketing aprovado e mapeado → 201', async () => {
    const id = await criar()
    const d = (await chamar(T, 'GET', `/v1/campanhas/${id}`)).json() as Record<string, unknown>
    expect(d).toMatchObject({
      id, estado: 'rascunho', modeloVersao: 2, mensagem: null, loteDiario: 100,
      canal: { id: OFICIAL, tipo: 'whatsapp_oficial' }, template: { id: TPL_OK, nome: 'volta_aulas', categoria: 'MARKETING' },
      acoes: { editar: true, iniciar: true, pausar: false, testar: true },
      janelaEfetiva: { origem: 'padrao' },
    })
  })

  it('não oficial: texto livre só com confirmaRiscoBanimento; template não', async () => {
    const base = { nome: 'Promo', canalId: NAO_OFICIAL, publico: PUBLICO, mensagem: 'Promoção hoje!' }
    const sem = await chamar(T, 'POST', '/v1/campanhas', base)
    expect(sem.statusCode).toBe(422)
    expect(sem.json()).toMatchObject({ erro: 'campanha.confirmacao_risco_necessaria', campos: { confirmaRiscoBanimento: expect.any(String) } })
    const tpl = await chamar(T, 'POST', '/v1/campanhas', { ...base, templateId: TPL_OK, mensagem: undefined, confirmaRiscoBanimento: true })
    expect(tpl.json()).toMatchObject({ erro: 'campanha.template_so_oficial' })
    const id = await criar(T, { ...base, confirmaRiscoBanimento: true })
    const [k] = await dono<{ confirma_risco_banimento: boolean }[]>`SELECT confirma_risco_banimento FROM campanha WHERE tenant_id = ${T} AND id = ${id}`
    expect(k!.confirma_risco_banimento).toBe(true)
  })

  it('Instagram não faz campanha → 422 explicando', async () => {
    const r = await chamar(T, 'POST', '/v1/campanhas', { nome: 'X', canalId: INSTA, publico: PUBLICO, mensagem: 'oi', confirmaRiscoBanimento: true })
    expect(r.json()).toMatchObject({ erro: 'campanha.canal_nao_permite_campanha' })
  })

  it('a criação legada (sem canal e sem público) continua como estava', async () => {
    const r = await chamar(T, 'POST', '/v1/campanhas', { nome: 'Antiga', mensagem: 'oi', segmentoAlvo: 'todos', janelaDias: 7 })
    expect(r.statusCode).toBe(201)
    const id = (r.json() as { id: string }).id
    const [k] = await dono<{ modelo_versao: number }[]>`SELECT modelo_versao FROM campanha WHERE tenant_id = ${T} AND id = ${id}`
    expect(k!.modelo_versao).toBe(1)
    await dono`DELETE FROM campanha WHERE tenant_id = ${T} AND id = ${id}`
  })
})

describe('Envio de teste', () => {
  it('até 5 números, na hora, com as variáveis; opt-out não recebe; nada de destinatário de campanha', async () => {
    const id = await criar()
    const seis = await chamar(T, 'POST', `/v1/campanhas/${id}/teste`, { telefones: ['81900000001', '81900000002', '81900000003', '81900000004', '81900000005', '81900000006'] })
    expect(seis.statusCode).toBe(422)

    const r = await chamar(T, 'POST', `/v1/campanhas/${id}/teste`, {
      telefones: ['81900000001', '8190000000' + '3', '81977776666', 'abc12345678', '81955554444'],
    })
    expect(r.statusCode, r.body).toBe(200)
    const res = (r.json() as { resultados: { telefone: string; ok: boolean; motivo?: string }[] }).resultados
    expect(res).toHaveLength(5)
    expect(res.filter((x) => x.ok)).toHaveLength(3)
    expect(res.find((x) => x.motivo === 'bloqueado')).toBeTruthy()          // o contato 3 está na lista de bloqueio
    expect(res.find((x) => x.motivo === 'telefone_invalido')).toBeTruthy()
    // Variáveis: do contato dono do número (1) e, sem dono, "Cliente" + empresa.
    expect(enviados.map((e) => e.template?.variaveis)).toContainEqual(['Cliente 1', 'Loja Sol'])
    expect(enviados.map((e) => e.template?.variaveis)).toContainEqual(['Cliente', 'Loja Sol'])
    expect(await dono`SELECT 1 FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`).toHaveLength(0)
    expect(await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${T} AND acao = 'campanha.teste_enviado' AND entidade_id = ${id}`).toHaveLength(1)
  })
})

describe('Iniciar', () => {
  it('exige o nome digitado; congela o público com as exclusões; não inicia duas vezes', async () => {
    const id = await criar()
    const errado = await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'volta às aulas' })
    expect(errado.statusCode).toBe(422)
    expect(errado.json()).toMatchObject({ erro: 'campanha.confirmacao_nome', campos: { confirmacaoNome: expect.any(String) } })
    expect(await dono`SELECT 1 FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`).toHaveLength(0)

    const ok = await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: ' Volta às aulas ' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ ok: true, estado: 'enviando', destinatarios: 3, excluidos: 7 })
    const linhas = await dono<{ estado: string; motivo_exclusao: string | null; n: number }[]>`
      SELECT estado, motivo_exclusao, count(*)::int AS n FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}
       GROUP BY 1, 2 ORDER BY 1, 2`
    expect(linhas).toEqual([
      { estado: 'excluida', motivo_exclusao: 'anonimizado', n: 1 },
      { estado: 'excluida', motivo_exclusao: 'campanhaRecente', n: 1 },
      { estado: 'excluida', motivo_exclusao: 'compraRecente', n: 1 },
      { estado: 'excluida', motivo_exclusao: 'conversaRecente', n: 1 },
      { estado: 'excluida', motivo_exclusao: 'optout', n: 1 },
      { estado: 'excluida', motivo_exclusao: 'semTelefone', n: 1 },
      { estado: 'excluida', motivo_exclusao: 'telefoneDuplicado', n: 1 },
      { estado: 'pendente', motivo_exclusao: null, n: 3 },
    ])
    const [k] = await dono<{ iniciada_por: string | null; iniciada_em: Date; contagem_desde: Date }[]>`
      SELECT iniciada_por, iniciada_em, contagem_desde FROM campanha WHERE tenant_id = ${T} AND id = ${id}`
    expect(k!.iniciada_por).not.toBeNull()
    expect(k!.iniciada_em).toEqual(AGORA)

    const deNovo = await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })
    expect(deNovo.statusCode).toBe(409)
  })

  it('materialização idempotente: repetir a fatia (ou fatiar de 1 em 1) não duplica ninguém', async () => {
    const id = await criar()
    const publico = (lerPublico(PUBLICO) as { ok: true; publico: Parameters<typeof materializarFatia>[1]['publico'] }).publico
    const tudo = { tipo: 'tudo' } as const
    const a = await comTenantServico(T, (tx) => materializarFatia(tx, { campanhaId: id, publico, escopo: tudo, agora: AGORA, depoisDe: null }))
    const b = await comTenantServico(T, (tx) => materializarFatia(tx, { campanhaId: id, publico, escopo: tudo, agora: AGORA, depoisDe: null }))
    expect(a.inseridos).toBe(10)
    expect(b.inseridos).toBe(0)
    // De 1 em 1 (grande base em fatias), retomando de onde parou: o mesmo conjunto.
    await dono`DELETE FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`
    let depoisDe: string | null = null, voltas = 0
    for (;;) {
      const f: { ultimo: string | null } = await comTenantServico(T, (tx) => materializarFatia(tx, { campanhaId: id, publico, escopo: tudo, agora: AGORA, depoisDe, limite: 1 }))
      if (f.ultimo === null) break
      depoisDe = f.ultimo; voltas++
    }
    expect(voltas).toBe(10)
    const [n] = await dono<{ pend: number; dup: number }[]>`
      SELECT count(*) FILTER (WHERE estado = 'pendente')::int AS pend,
             count(*) FILTER (WHERE motivo_exclusao = 'telefoneDuplicado')::int AS dup
        FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`
    expect(n).toEqual({ pend: 3, dup: 1 })
  })

  it('início no futuro → agendada', async () => {
    const id = await criar(T, corpoOficial({ inicioEm: new Date(AGORA.getTime() + DIA).toISOString() }))
    const r = await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })
    expect(r.json()).toMatchObject({ estado: 'agendada' })
  })

  it('público sem nenhum elegível → 422 e nada fica gravado', async () => {
    const id = await criar(T, corpoOficial({ publico: { listas: [LISTA], qualificacao: ['descartado'] } }))
    const r = await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ erro: 'campanha.sem_elegiveis' })
    expect(await dono`SELECT 1 FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`).toHaveLength(0)
  })
})

describe('Ciclo de vida', () => {
  it('editar e excluir só em rascunho; pausar/retomar/cancelar nos estados certos', async () => {
    const id = await criar()
    expect((await chamar(T, 'PUT', `/v1/campanhas/${id}`, corpoOficial({ nome: 'Volta às aulas 2' }))).statusCode).toBe(200)
    expect((await chamar(T, 'POST', `/v1/campanhas/${id}/pausar`)).statusCode).toBe(409)
    await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas 2' })

    expect((await chamar(T, 'PUT', `/v1/campanhas/${id}`, corpoOficial())).statusCode).toBe(409)
    expect((await chamar(T, 'DELETE', `/v1/campanhas/${id}`)).statusCode).toBe(409)
    expect((await chamar(T, 'POST', `/v1/campanhas/${id}/disparar`)).json()).toMatchObject({ erro: 'campanha.use_iniciar' })

    const p = await chamar(T, 'POST', `/v1/campanhas/${id}/pausar`)
    expect(p.json()).toMatchObject({ ok: true, estado: 'pausada' })
    const [k] = await dono<{ pausa_motivo: string }[]>`SELECT pausa_motivo FROM campanha WHERE tenant_id = ${T} AND id = ${id}`
    expect(k!.pausa_motivo).toBe('manual')

    // Número com as ativas suspensas pela Meta: retomar é recusado.
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = now(), ativas_suspensas_motivo = 'qualidade:RED' WHERE tenant_id = ${T} AND id = ${OFICIAL}`
    expect((await chamar(T, 'POST', `/v1/campanhas/${id}/retomar`)).json()).toMatchObject({ erro: 'campanha.numero_suspenso' })
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL WHERE tenant_id = ${T} AND id = ${OFICIAL}`

    // Pausa automática aberta + retomar: o alerta se resolve e a contagem das taxas recomeça.
    await dono`UPDATE campanha SET pausa_motivo = 'optout_alto' WHERE tenant_id = ${T} AND id = ${id}`
    await dono`INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem) VALUES (${T}, ${randomUUID()}, 'campanha_pausada', 'critico', 'x')`
    const ret = await chamar(T, 'POST', `/v1/campanhas/${id}/retomar`)
    expect(ret.json()).toMatchObject({ ok: true, estado: 'enviando' })
    expect(await dono`SELECT 1 FROM alerta WHERE tenant_id = ${T} AND tipo = 'campanha_pausada' AND resolvido_em IS NULL`).toHaveLength(0)

    expect((await chamar(T, 'POST', `/v1/campanhas/${id}/cancelar`)).json()).toMatchObject({ estado: 'cancelada' })
    expect((await chamar(T, 'POST', `/v1/campanhas/${id}/cancelar`)).statusCode).toBe(409)
    expect((await chamar(T, 'POST', `/v1/campanhas/${id}/retomar`)).statusCode).toBe(409)

    const rascunho = await criar()
    expect((await chamar(T, 'DELETE', `/v1/campanhas/${rascunho}`)).statusCode).toBe(204)
  })
})

describe('Destinatários e relatório até a venda', () => {
  async function campanhaComFunil(): Promise<string> {
    const id = await criar()
    await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })
    const enviado = antes(3)
    // 1: respondeu e comprou; 2: lida; 10: falhou com código.
    await dono`UPDATE campanha_destinatario SET estado = 'respondeu', enviado_em = ${enviado}, entregue_em = ${enviado}, respondeu_em = ${antes(2)}
                WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(1)}`
    await dono`UPDATE campanha_destinatario SET estado = 'lida', enviado_em = ${enviado}, lido_em = ${antes(2)}
                WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(2)}`
    await dono`UPDATE campanha_destinatario SET estado = 'falhou', erro_codigo = '131026'
                WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(10)}`
    await dono`INSERT INTO pedido (tenant_id, id, contato_id, estado, total_centavos, campanha_id, numero_externo)
               VALUES (${T}, ${randomUUID()}, ${contatoId(1)}, 'efetivado', 30000, ${id}, 'NF-F1A2')`
    await dono`INSERT INTO venda (tenant_id, id, contato_id, ocorrida_em, valor_centavos) VALUES
                 (${T}, ${randomUUID()}, ${contatoId(1)}, ${antes(1)}, 50000),
                 (${T}, ${randomUUID()}, ${contatoId(2)}, ${antes(30)}, 99999)`
    return id
  }

  it('relatório: enviadas → entregues → lidas → responderam → pedido; custo total e por venda; falhas por código', async () => {
    const id = await campanhaComFunil()
    const r = await chamar(T, 'GET', `/v1/campanhas/${id}/relatorio`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({
      estado: 'enviando',
      funil: { elegiveis: 3, enviadas: 2, entregues: 2, lidas: 2, responderam: 1, pedidos: 1, vendasEstimadas: 1 },
      progresso: { pendentes: 0, enviando: 0, processados: 3, percentual: 100 },
      excluidos: { optout: 1, anonimizado: 1, semTelefone: 1, conversaRecente: 1, campanhaRecente: 1, compraRecente: 1, telefoneDuplicado: 1 },
      optOuts: 0, falhas: 1, falhasPorCodigo: [{ codigo: '131026', n: 1 }],
      custo: { categoria: 'marketing', precoUnitarioCentavos: 40, totalCentavos: 80, porPedidoCentavos: 80, porVendaEstimadaCentavos: 80 },
      roi: { exata: { pedidos: 1, receitaCentavos: 30000 }, estimada: { vendas: 1, receitaCentavos: 50000 }, enviados: 2 },
    })
  })

  it('destinatários por estado, sem telefone, no escopo de quem lê', async () => {
    const id = await campanhaComFunil()
    const todos = (await chamar(T, 'GET', `/v1/campanhas/${id}/destinatarios`)).json() as { itens: Record<string, unknown>[]; proximoCursor: string | null }
    expect(todos.itens).toHaveLength(10)
    expect(todos.proximoCursor).toBeNull()
    for (const d of todos.itens) expect(d).not.toHaveProperty('telefone')
    const falhas = (await chamar(T, 'GET', `/v1/campanhas/${id}/destinatarios?estado=falhou`)).json() as { itens: { contatoId: string; erroCodigo: string }[] }
    expect(falhas.itens).toEqual([expect.objectContaining({ contatoId: contatoId(10), erroCodigo: '131026' })])
    expect((await chamar(T, 'GET', `/v1/campanhas/${id}/destinatarios?estado=xyz`)).statusCode).toBe(422)

    await papelDoHeader('supervisor', F1)
    const doCentro = (await chamar(T, 'GET', `/v1/campanhas/${id}/destinatarios?estado=falhou`)).json() as { itens: unknown[] }
    expect(doCentro.itens).toHaveLength(0) // o contato 10 é da filial Norte
  })
})

describe('Papel e isolamento', () => {
  it('vendedor não cria, não lê nem inicia (403); supervisor lê mas não cria', async () => {
    const id = await criar()
    await papelDoHeader('vendedor')
    expect((await chamar(T, 'POST', '/v1/campanhas', corpoOficial())).statusCode).toBe(403)
    expect((await chamar(T, 'GET', '/v1/campanhas')).statusCode).toBe(403)
    expect((await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })).statusCode).toBe(403)

    await dono`DELETE FROM usuario_filial WHERE tenant_id = ${T}`
    await papelDoHeader('supervisor')
    expect((await chamar(T, 'GET', `/v1/campanhas/${id}`)).statusCode).toBe(200)
    expect((await chamar(T, 'POST', '/v1/campanhas', corpoOficial())).statusCode).toBe(403)
  })

  it('dois tenants: a campanha de um não existe para o outro', async () => {
    const id = await criar()
    expect((await chamar(OUTRO, 'GET', `/v1/campanhas/${id}`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'GET', `/v1/campanhas/${id}/destinatarios`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'GET', `/v1/campanhas/${id}/relatorio`)).statusCode).toBe(404)
    expect((await chamar(OUTRO, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })).statusCode).toBe(404)
    expect(((await chamar(OUTRO, 'GET', '/v1/campanhas')).json() as { itens: unknown[] }).itens).toHaveLength(0)
    // O canal do outro tenant não serve para criar campanha aqui.
    const r = await chamar(OUTRO, 'POST', '/v1/campanhas', corpoOficial())
    expect(r.json()).toMatchObject({ erro: 'campanha.canal_invalido' })
  })
})

describe('Revisão F1a — janela, teste, bloqueio, corrida, LGPD e custo', () => {
  it('B6: janela sem dia aberto ou fora de 08:00–21:00 → 422; expediente do número é recortado e a prévia avisa', async () => {
    const vazia = await chamar(T, 'POST', '/v1/campanhas', corpoOficial({ janela: { seg: null, dom: null } }))
    expect(vazia.json()).toMatchObject({ erro: 'campanha.janela_vazia', campos: { janela: expect.any(String) } })
    const cedo = await chamar(T, 'POST', '/v1/campanhas', corpoOficial({ janela: { seg: { de: '07:00', ate: '12:00' } } }))
    expect(cedo.json()).toMatchObject({ erro: 'campanha.janela_fora_do_permitido' })
    expect((await chamar(T, 'POST', '/v1/campanhas', corpoOficial({ janela: { seg: { de: '09:00', ate: '18:00' } } }))).statusCode).toBe(201)

    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento)
               VALUES (${T}, ${OFICIAL}, ${JSON.stringify({ seg: { de: '06:00', ate: '23:00' } })}::text::jsonb)`
    const p = await chamar(T, 'POST', '/v1/campanhas/previa', { canalId: OFICIAL, templateId: TPL_OK, publico: PUBLICO })
    expect(p.json()).toMatchObject({ janelaDoNumero: { origem: 'canal', ajustada: true, horario: { seg: { de: '08:00', ate: '21:00' } } } })
  })

  it('B4: teste tem teto por usuário (20 telefones/hora) e, no não oficial em aquecimento, cabe no teto do dia', async () => {
    const id = await criar()
    const cinco = ['81911110001', '81911110002', '81911110003', '81911110004', '81911110005']
    for (let i = 0; i < 4; i++) expect((await chamar(T, 'POST', `/v1/campanhas/${id}/teste`, { telefones: cinco })).statusCode).toBe(200)
    const quinto = await chamar(T, 'POST', `/v1/campanhas/${id}/teste`, { telefones: ['81911110006'] })
    expect(quinto.statusCode).toBe(429)
    expect(quinto.json()).toMatchObject({ erro: 'campanha.teste_limite', limiteUsuarioHora: 20, limiteNumeroHora: 30 })

    await dono`DELETE FROM auditoria WHERE tenant_id = ${T} AND acao = 'campanha.teste_enviado'`
    const promo = await criar(T, { nome: 'Promo', canalId: NAO_OFICIAL, publico: PUBLICO, mensagem: 'Oi!', confirmaRiscoBanimento: true })
    // Número no dia 0 do aquecimento (teto 20) com 20 envios de hoje: sem cota nem para teste.
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em) VALUES (${T}, ${NAO_OFICIAL}, ${AGORA})`
    const velha = randomUUID()
    await dono`INSERT INTO campanha (tenant_id, id, nome, mensagem, estado, canal_id) VALUES (${T}, ${velha}, 'Gasta cota', 'x', 'concluida', ${NAO_OFICIAL})`
    for (let n = 1; n <= 10; n++) {
      await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id, estado, enviado_em)
                 VALUES (${T}, ${randomUUID()}, ${velha}, ${contatoId(n)}, 'enviado', ${AGORA})`
    }
    const velha2 = randomUUID()
    await dono`INSERT INTO campanha (tenant_id, id, nome, mensagem, estado, canal_id) VALUES (${T}, ${velha2}, 'Gasta cota 2', 'x', 'concluida', ${NAO_OFICIAL})`
    for (let n = 1; n <= 10; n++) {
      await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id, estado, enviado_em)
                 VALUES (${T}, ${randomUUID()}, ${velha2}, ${contatoId(n)}, 'enviado', ${AGORA})`
    }
    try {
      const r = await chamar(T, 'POST', `/v1/campanhas/${promo}/teste`, { telefones: ['81911110001'] })
      expect(r.statusCode).toBe(409)
      expect(r.json()).toMatchObject({ erro: 'campanha.teste_sem_cota' })
    } finally {
      await dono`DELETE FROM campanha_envio WHERE tenant_id = ${T} AND campanha_id IN (${velha}, ${velha2})`
      await dono`DELETE FROM campanha WHERE tenant_id = ${T} AND id IN (${velha}, ${velha2})`
    }
  })

  it('B5: campanha em curso com o número de disparo pausado expõe bloqueio na lista e no detalhe', async () => {
    const id = await criar()
    await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })
    expect(((await chamar(T, 'GET', `/v1/campanhas/${id}`)).json() as { bloqueio: unknown }).bloqueio).toBeNull()
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, disparo_pausado, pausado_motivo, pausado_em)
               VALUES (${T}, ${OFICIAL}, true, 'manual', now())`
    expect((await chamar(T, 'GET', `/v1/campanhas/${id}`)).json()).toMatchObject({ bloqueio: { motivo: 'disparo_pausado' } })
    const lista = (await chamar(T, 'GET', '/v1/campanhas?estado=enviando')).json() as { itens: { id: string; bloqueio: unknown }[] }
    expect(lista.itens.find((c) => c.id === id)?.bloqueio).toEqual({ motivo: 'disparo_pausado' })
  })

  it('M2: editada enquanto o snapshot era montado → 409 e o snapshot é apagado (não inicia com o público antigo)', async () => {
    const id = await criar()
    ganchoFatia = async () => { await dono`UPDATE campanha SET atualizado_em = clock_timestamp() WHERE tenant_id = ${T} AND id = ${id}` }
    const r = await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ erro: 'campanha.alterada_durante_inicio' })
    expect(await dono`SELECT 1 FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`).toHaveLength(0)
    const [k] = await dono<{ estado: string }[]>`SELECT estado FROM campanha WHERE tenant_id = ${T} AND id = ${id}`
    expect(k!.estado).toBe('rascunho')
    ganchoFatia = null
    expect((await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })).statusCode).toBe(200)
  })

  it('M5: anonimizado (LGPD) vem antes do opt-out na prévia', async () => {
    await dono`UPDATE contato SET anonimizado_em = now(), anonimizacao_modo = 'canais' WHERE tenant_id = ${T} AND id = ${contatoId(3)}`
    try {
      const r = await chamar(T, 'POST', '/v1/campanhas/previa', { canalId: OFICIAL, templateId: TPL_OK, publico: PUBLICO })
      expect(r.json()).toMatchObject({ excluidos: { anonimizado: 2, optout: 0 } })
    } finally {
      await dono`UPDATE contato SET anonimizado_em = NULL, anonimizacao_modo = NULL WHERE tenant_id = ${T} AND id = ${contatoId(3)}`
    }
  })

  it('B3: mensagem que a Meta devolveu como falha não entra no custo', async () => {
    const id = await criar()
    await chamar(T, 'POST', `/v1/campanhas/${id}/iniciar`, { confirmacaoNome: 'Volta às aulas' })
    await dono`UPDATE campanha_destinatario SET estado = 'entregue', enviado_em = ${antes(1)}, entregue_em = ${antes(1)}
                WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(1)}`
    await dono`UPDATE campanha_destinatario SET estado = 'falhou', enviado_em = ${antes(1)}, erro_codigo = '131026'
                WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(2)}`
    const r = (await chamar(T, 'GET', `/v1/campanhas/${id}/relatorio`)).json()
    expect(r).toMatchObject({ funil: { enviadas: 2 }, custo: { mensagensCobradas: 1, totalCentavos: 40 } })
  })
})
