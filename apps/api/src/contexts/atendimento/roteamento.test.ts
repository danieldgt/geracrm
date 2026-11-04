import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { normalizarTelefone } from '@geracrm/shared'
import { comTenantServico, encerrarBanco } from '../../db/index.js'
import { pluginTenant } from '../../plugins/tenant.js'
import { entregarParaHumano } from './agente/handoff.js'
import { ingerirMensagemEntrante } from './ingestao-mensagem.js'
import { escolherVendedorDaFilial, filialDoContato } from './roteamento.js'
import { atribuirCarteiraNaEntrada } from './rodizio-entrada.js'
import { rotasRoteamento } from './rotas-roteamento.js'

/**
 * ROTEAMENTO POR FILIAL E RODÍZIO (raia G4) — banco real, papel da aplicação, DOIS tenants.
 *
 *   - filialDoContato: contato → origem → DDD → padrão do número → filial do número → padrão geral;
 *   - rodízio: justo, sem corrida (duas transações), pula ausente/inativo e quem não atende o número;
 *   - rodízio na ENTRADA (RN-04): só com a chave ligada e só para contato novo sem dono;
 *   - handoff: dono → filial em rodízio → pool → gestor da filial → gestor;
 *   - rotas: CRUD com papel e escopo de filial, simulação sem efeito, chave por número, RLS.
 *
 * Identidade nas rotas: `x-teste-sub` vira `usuarioSub` (como o Cognito faria).
 */
const A = 'a4c00000-0000-4000-8000-00000000000a'
const B = 'a4c00000-0000-4000-8000-00000000000b'
const PLANO = 'a4c00000-0001-4000-8000-000000000001'
const MODELO = 'a4c00000-0002-4000-8000-000000000001'
const PV_A = 'a4c00000-0003-4000-8000-00000000000a'
const PV_B = 'a4c00000-0003-4000-8000-00000000000b'
const FN = 'a4c00000-0004-4000-8000-000000000001' // Norte
const FS = 'a4c00000-0004-4000-8000-000000000002' // Sul
const FI = 'a4c00000-0004-4000-8000-000000000003' // inativa
const FB = 'a4c00000-0004-4000-8000-00000000000b' // do tenant B
const C1 = 'a4c00000-0005-4000-8000-000000000001'
const C2 = 'a4c00000-0005-4000-8000-000000000002'
const CB = 'a4c00000-0005-4000-8000-00000000000b'
const ORIGEM = 'a4c00000-0006-4000-8000-000000000001'
const ORIGEM_B = 'a4c00000-0006-4000-8000-00000000000b'
// Ids em ordem: o rodízio anda por id.
const U = {
  v1: 'a4c00000-0007-4000-8000-000000000011',
  v2: 'a4c00000-0007-4000-8000-000000000012',
  v3: 'a4c00000-0007-4000-8000-000000000013',
  at: 'a4c00000-0007-4000-8000-000000000014', // atendente de FN
  vs: 'a4c00000-0007-4000-8000-000000000021', // vendedor de FS
  gn: 'a4c00000-0007-4000-8000-000000000031', // gestor de FN
  sn: 'a4c00000-0007-4000-8000-000000000032', // supervisor de FN
  gs: 'a4c00000-0007-4000-8000-000000000033', // gestor de FS
  gg: 'a4c00000-0007-4000-8000-000000000041', // gestor de todas
  adm: 'a4c00000-0007-4000-8000-000000000051',
  bx: 'a4c00000-0007-4000-8000-0000000000b1', // admin do tenant B
}
type Quem = keyof typeof U
const sub = (k: Quem) => `g4-sub-${k}`

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 4, onnotice: () => {} })
let app: FastifyInstance

async function pedir(quem: Quem, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const r = await app.inject({
    method, url, headers: { 'x-tenant-id': quem === 'bx' ? B : A, 'x-teste-sub': sub(quem) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown> & { itens?: Record<string, unknown>[] } }
}

let seqFone = 0
/** Telefone válido (celular) com o DDD pedido, único por chamada. */
const fone = (ddd: string) => `55${ddd}9${String(70_000_000 + (++seqFone) * 7919 + Math.floor(Math.random() * 1000)).slice(-8)}`

async function contato(p: { ddd?: string; origem?: string | null; filial?: string | null; dono?: string; t?: string } = {}) {
  const t = p.t ?? A
  const id = randomUUID()
  const tel = normalizarTelefone(fone(p.ddd ?? '85'))!
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo, origem_id, filial_id) VALUES (${t}, ${id}, 'Cliente G4', true, ${p.origem ?? null}, ${p.filial ?? null})`
  await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${t}, ${id}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, true, 'teste')`
  if (p.dono) await dono`INSERT INTO carteira_atribuicao (tenant_id, id, contato_id, usuario_id, origem) VALUES (${t}, ${randomUUID()}, ${id}, ${p.dono}, 'manual')`
  return id
}
async function conversa(contatoId: string, canal = C1) {
  const id = randomUUID()
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao, conduzida_por, ultima_entrante_em, ultima_direcao, ultima_mensagem_em)
             VALUES (${A}, ${id}, ${canal}, ${contatoId}, 1, 'ia', now(), 'entrante', now())`
  return id
}
const regra = (tipo: 'ddd' | 'origem' | 'padrao', valor: string | null, filial: string, canal: string | null = null, prioridade = 100) =>
  dono`INSERT INTO regra_roteamento (tenant_id, id, canal_id, tipo, valor, filial_id, prioridade) VALUES (${A}, ${randomUUID()}, ${canal}, ${tipo}, ${valor}, ${filial}, ${prioridade})`
const atende = (canal: string, ...quem: Quem[]) =>
  dono`INSERT INTO usuario_canal (tenant_id, usuario_id, canal_id) SELECT ${A}, unnest(${quem.map((q) => U[q])}::uuid[]), ${canal}`
const escolher = (filial: string, canal: string | null, finalidade: 'entrada' | 'handoff' = 'entrada', avancar = true) =>
  comTenantServico(A, async (tx) => (await escolherVendedorDaFilial(tx, filial, canal, { finalidade, avancar })).usuarioId)
const ponteiro = async (filial: string, finalidade = 'entrada') =>
  (await dono<{ u: string | null }[]>`SELECT ultimo_usuario_id AS u FROM rodizio_filial WHERE tenant_id = ${A} AND filial_id = ${filial} AND finalidade = ${finalidade}`)[0]?.u ?? null
const donoDe = async (contatoId: string) =>
  (await dono<{ usuario_id: string | null; origem: string }[]>`
    SELECT usuario_id, origem FROM carteira_atribuicao WHERE tenant_id = ${A} AND contato_id = ${contatoId} AND ate IS NULL`)[0] ?? null
const ligarRodizio = (canal = C1, ligar = true) =>
  dono`INSERT INTO canal_configuracao (tenant_id, canal_id, rodizio_na_entrada) VALUES (${A}, ${canal}, ${ligar})
       ON CONFLICT (tenant_id, canal_id) DO UPDATE SET rodizio_na_entrada = EXCLUDED.rodizio_na_entrada`

const TABELAS = ['notificacao', 'auditoria', 'outbox', 'tarefa_pos_ingestao', 'agente_decisao', 'atendimento_evento',
  'atendimento_etapa_historico', 'mensagem_id_externo', 'mensagem', 'atendimento', 'carteira_atribuicao', 'conversa',
  'contato_telefone', 'contato', 'regra_roteamento', 'rodizio_filial', 'canal_configuracao', 'atendimento_sla_config']

async function limparDominio(): Promise<void> {
  for (const t of TABELAS) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  await dono`DELETE FROM usuario_canal WHERE tenant_id IN (${A}, ${B})`
}

async function limparTudo(): Promise<void> {
  await limparDominio()
  for (const t of ['usuario_filial', 'origem', 'atendimento_etapa', 'agente_config', 'canal_conectado', 'usuario', 'filial']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id IN ('${A}', '${B}')`)
  }
  for (const t of [A, B]) {
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
}

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  await limparTudo() // resto de uma rodada interrompida
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-g4-roteamento', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-g4-roteamento', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[A, PV_A], [B, PV_B]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, 'G4', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  await dono`INSERT INTO filial (tenant_id, id, nome, ativa) VALUES
    (${A}, ${FN}, 'Norte', true), (${A}, ${FS}, 'Sul', true), (${A}, ${FI}, 'Fechada', false), (${B}, ${FB}, 'Filial B', true)`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado) VALUES
    (${A}, ${C1}, 'whatsapp_nao_oficial', 'plugzapi', 'Loja 1', 'conectado'),
    (${A}, ${C2}, 'whatsapp_nao_oficial', 'plugzapi', 'Loja 2', 'conectado'),
    (${B}, ${CB}, 'whatsapp_nao_oficial', 'plugzapi', 'Loja B', 'conectado')`
  await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${A}, ${ORIGEM}, 'Feira'), (${B}, ${ORIGEM_B}, 'Feira B')`
  for (const k of Object.keys(U) as Quem[]) {
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
               VALUES (${k === 'bx' ? B : A}, ${U[k]}, ${sub(k)}, ${k.toUpperCase()}, ${sub(k) + '@g4.test'})`
  }
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES
    (${A}, ${U.v1}, ${FN}, 'vendedor'), (${A}, ${U.v2}, ${FN}, 'vendedor'), (${A}, ${U.v3}, ${FN}, 'vendedor'),
    (${A}, ${U.at}, ${FN}, 'atendente'), (${A}, ${U.vs}, ${FS}, 'vendedor'),
    (${A}, ${U.gn}, ${FN}, 'gestor'), (${A}, ${U.sn}, ${FN}, 'supervisor'), (${A}, ${U.gs}, ${FS}, 'gestor'),
    (${A}, ${U.gg}, NULL, 'gestor'), (${A}, ${U.adm}, NULL, 'admin'), (${B}, ${U.bx}, NULL, 'admin')`

  app = Fastify()
  await app.register(pluginTenant)
  app.addHook('onRequest', async (req) => {
    const s = req.headers['x-teste-sub']
    if (typeof s === 'string') { req.usuarioSub = s; req.usuarioEmail = `${s}@g4.test` }
  })
  await app.register(rotasRoteamento)
  await app.ready()
})

beforeEach(async () => {
  await limparDominio()
  await dono`UPDATE usuario SET ativo = true, ausente = false WHERE tenant_id IN (${A}, ${B})`
  await dono`UPDATE canal_conectado SET filial_id = NULL WHERE tenant_id = ${A}`
})

afterAll(async () => {
  await limparTudo()
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await app.close(); await encerrarBanco(); await dono.end()
})

// ─────────────────────────────────────────────────────────────────────────────

describe('filialDoContato — precedência', () => {
  const filialDe = (c: string, canal: string | null = C1) => comTenantServico(A, (tx) => filialDoContato(tx, c, canal))

  it('dado regras de origem, DDD e padrão, então a origem vence o DDD, que vence o padrão do número, que vence o geral', async () => {
    await regra('origem', ORIGEM, FS)
    await regra('ddd', '85', FN)
    await regra('padrao', null, FS, C1)
    await regra('padrao', null, FN)
    expect(await filialDe(await contato({ ddd: '85', origem: ORIGEM }))).toMatchObject({ filialId: FS, motivo: 'origem' })
    expect(await filialDe(await contato({ ddd: '85' }))).toMatchObject({ filialId: FN, motivo: 'ddd', ddd: '85' })
    expect(await filialDe(await contato({ ddd: '11' }))).toMatchObject({ filialId: FS, motivo: 'padrao_numero' })
    expect(await filialDe(await contato({ ddd: '11' }), C2)).toMatchObject({ filialId: FN, motivo: 'padrao_geral' })
  })

  it('dado filial gravada no contato, então ela vence as regras; filial gravada DESATIVADA é ignorada', async () => {
    await regra('ddd', '85', FN)
    expect(await filialDe(await contato({ ddd: '85', filial: FS }))).toMatchObject({ filialId: FS, motivo: 'contato' })
    expect(await filialDe(await contato({ ddd: '85', filial: FI }))).toMatchObject({ filialId: FN, motivo: 'ddd' })
  })

  it('dado número de uma filial, então ela vale antes do padrão geral; regra para filial desativada não roteia', async () => {
    await dono`UPDATE canal_conectado SET filial_id = ${FS} WHERE tenant_id = ${A} AND id = ${C2}`
    await regra('padrao', null, FN)
    await regra('ddd', '11', FI)
    expect(await filialDe(await contato({ ddd: '11' }), C2)).toMatchObject({ filialId: FS, motivo: 'filial_numero' })
    expect(await filialDe(await contato({ ddd: '11' }), C1)).toMatchObject({ filialId: FN, motivo: 'padrao_geral' })
  })

  it('dado regra inativa ou nenhuma regra, então nenhuma', async () => {
    await dono`INSERT INTO regra_roteamento (tenant_id, id, tipo, valor, filial_id, ativa) VALUES (${A}, ${randomUUID()}, 'ddd', '85', ${FN}, false)`
    expect(await filialDe(await contato({ ddd: '85' }))).toEqual({ filialId: null, motivo: 'nenhuma', regraId: null, ddd: '85' })
  })
})

describe('escolherVendedorDaFilial — rodízio', () => {
  it('dado três vendedores, então o rodízio é justo, por id, e volta ao início (o atendente não ganha carteira)', async () => {
    const r: (string | null)[] = []
    for (let i = 0; i < 6; i++) r.push(await escolher(FN, C1))
    expect(r).toEqual([U.v1, U.v2, U.v3, U.v1, U.v2, U.v3])
    expect(await ponteiro(FN)).toBe(U.v3)
  })

  it('dado o handoff, então atendente da filial entra no rodízio dele (ponteiro separado da entrada)', async () => {
    const r: (string | null)[] = []
    for (let i = 0; i < 4; i++) r.push(await escolher(FN, C1, 'handoff'))
    expect(r).toEqual([U.v1, U.v2, U.v3, U.at])
    expect(await ponteiro(FN, 'entrada')).toBeNull()
  })

  it('dado ausente e inativo, então são pulados', async () => {
    await dono`UPDATE usuario SET ausente = true WHERE id = ${U.v1}`
    await dono`UPDATE usuario SET ativo = false WHERE id = ${U.v2}`
    expect([await escolher(FN, C1), await escolher(FN, C1)]).toEqual([U.v3, U.v3])
  })

  it('dado número com gente vinculada, então quem não atende o número é pulado; número sem ninguém = todos', async () => {
    await atende(C1, 'v2', 'vs')
    expect([await escolher(FN, C1), await escolher(FN, C1)]).toEqual([U.v2, U.v2])
    expect(await escolher(FN, C2)).toBe(U.v3) // C2 sem vínculos: todos; o ponteiro estava em v2
  })

  it('dado filial sem ninguém elegível, então null e o ponteiro não é tocado', async () => {
    await dono`UPDATE usuario SET ausente = true WHERE id IN (${U.v1}, ${U.v2}, ${U.v3})`
    expect(await escolher(FN, C1)).toBeNull()
    expect(await dono`SELECT 1 FROM rodizio_filial WHERE tenant_id = ${A}`).toHaveLength(0)
  })

  it('dado duas transações ao mesmo tempo, então o segundo espera o commit do primeiro e pega o PRÓXIMO (sem corrida)', async () => {
    // O ponteiro já existe (a corrida que importa: sem linha nova, a unicidade não serializa ninguém).
    expect(await escolher(FN, C1)).toBe(U.v1)
    let liberar!: () => void
    const segura = new Promise<void>((r) => { liberar = r })
    let primeiroEscolheu!: () => void
    const escolheu = new Promise<void>((r) => { primeiroEscolheu = r })
    const t1 = comTenantServico(A, async (tx) => {
      const v = (await escolherVendedorDaFilial(tx, FN, C1, { finalidade: 'entrada' })).usuarioId
      primeiroEscolheu()
      await segura // segura a trava do ponteiro aberta
      return v
    })
    await escolheu
    const t2 = comTenantServico(A, async (tx) => (await escolherVendedorDaFilial(tx, FN, C1, { finalidade: 'entrada' })).usuarioId)
    await new Promise((r) => setTimeout(r, 150)) // t2 está bloqueado na trava
    liberar()
    expect([await t1, await t2]).toEqual([U.v2, U.v3])
    expect(await ponteiro(FN)).toBe(U.v3)
  })

  it('dado transação que reverte, então a vez volta junto (o ponteiro é do mesmo commit do efeito)', async () => {
    await escolher(FN, C1) // v1
    await comTenantServico(A, async (tx) => {
      await escolherVendedorDaFilial(tx, FN, C1, { finalidade: 'entrada' })
      throw new Error('desfaz')
    }).catch(() => {})
    expect(await escolher(FN, C1)).toBe(U.v2)
  })

  it('dado avancar: false, então só diz quem seria, sem gravar', async () => {
    await escolher(FN, C1) // v1
    expect(await escolher(FN, C1, 'entrada', false)).toBe(U.v2)
    expect(await escolher(FN, C1, 'entrada', false)).toBe(U.v2)
    expect(await ponteiro(FN)).toBe(U.v1)
  })
})

describe('rodízio na entrada (RN-04) — contato novo pela ingestão', () => {
  const chega = (de: string, canal = C1, texto = 'oi') => comTenantServico(A, (tx) => ingerirMensagemEntrante(tx, canal, {
    deE164: de, idExterno: `g4-${randomUUID()}`, tipo: 'texto', texto, nomeRemetente: 'Lead G4', recebidaEm: new Date(),
  }))

  it('dado a chave DESLIGADA (padrão), então o lead nasce órfão e a fila é avisada como antes', async () => {
    await regra('ddd', '85', FN)
    const r = await chega(fone('85'))
    if (!r.ok) throw new Error(r.motivo)
    expect(r.leadNovo).toBe(true)
    expect(await donoDe(r.contatoId)).toBeNull()
    expect((await dono`SELECT 1 FROM notificacao WHERE tenant_id = ${A} AND conversa_id = ${r.conversaId}`).length).toBeGreaterThan(1)
  })

  it('dado a chave LIGADA e regra por DDD, então a carteira vai ao vendedor da vez (automática), a filial é carimbada, auditada e UM aviso', async () => {
    await regra('ddd', '85', FN)
    await ligarRodizio()
    const r = await chega(fone('85'))
    if (!r.ok) throw new Error(r.motivo)
    expect(await donoDe(r.contatoId)).toEqual({ usuario_id: U.v1, origem: 'automatica' })
    expect((await dono<{ filial_id: string }[]>`SELECT filial_id FROM contato WHERE id = ${r.contatoId}`)[0]!.filial_id).toBe(FN)
    const [aud] = await dono<{ ator_id: string | null; dados: { usuarioId: string; filialId: string; motivo: string } }[]>`
      SELECT ator_id, dados FROM auditoria WHERE tenant_id = ${A} AND acao = 'carteira.rodizio_entrada' AND entidade_id = ${r.contatoId}`
    expect(aud).toMatchObject({ ator_id: null, dados: { usuarioId: U.v1, filialId: FN, motivo: 'ddd' } })
    const avisos = await dono<{ usuario_id: string; tipo: string; titulo: string; vezes: number }[]>`
      SELECT usuario_id, tipo, titulo, vezes FROM notificacao WHERE tenant_id = ${A} AND conversa_id = ${r.conversaId}`
    expect(avisos).toEqual([{ usuario_id: U.v1, tipo: 'carteira.novo_cliente', titulo: 'Lead G4 — novo cliente na sua carteira', vezes: 1 }])

    const r2 = await chega(fone('85'))
    if (!r2.ok) throw new Error(r2.motivo)
    expect((await donoDe(r2.contatoId))?.usuario_id).toBe(U.v2)
  })

  it('dado contato que já existe (com ou sem dono), então nada muda', async () => {
    await regra('ddd', '85', FN)
    await ligarRodizio()
    const comDono = await contato({ ddd: '85', dono: U.vs })
    const orfao = await contato({ ddd: '85' })
    for (const c of [comDono, orfao]) {
      const [t] = await dono<{ e164: string }[]>`SELECT e164 FROM contato_telefone WHERE contato_id = ${c}`
      const r = await chega(t!.e164.slice(1))
      if (!r.ok) throw new Error(r.motivo)
      expect(r.leadNovo).toBe(false)
    }
    expect((await donoDe(comDono))?.usuario_id).toBe(U.vs)
    expect(await donoDe(orfao)).toBeNull()
    expect(await ponteiro(FN)).toBeNull()
  })

  it('dado lead sem filial roteada ou filial sem vendedor, então fica órfão (e a fila é avisada)', async () => {
    await ligarRodizio()
    const semFilial = await chega(fone('11'))
    if (!semFilial.ok) throw new Error(semFilial.motivo)
    expect(await donoDe(semFilial.contatoId)).toBeNull()

    await regra('ddd', '21', FS)
    await dono`UPDATE usuario SET ausente = true WHERE id = ${U.vs}`
    const semVendedor = await chega(fone('21'))
    if (!semVendedor.ok) throw new Error(semVendedor.motivo)
    expect(await donoDe(semVendedor.contatoId)).toBeNull()
    expect((await dono`SELECT 1 FROM notificacao WHERE conversa_id = ${semVendedor.conversaId} AND tipo = 'fila.nova'`).length).toBeGreaterThan(0)
  })

  it('dado contato sem telefone principal (fantasma de webhooks paralelos), então o rodízio não lhe dá dono', async () => {
    await regra('ddd', '85', FN)
    await ligarRodizio()
    const fantasma = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${A}, ${fantasma}, 'Fantasma', true)`
    const conv = await conversa(fantasma)
    const r = await comTenantServico(A, (tx) => atribuirCarteiraNaEntrada(tx, { contatoId: fantasma, conversaId: conv, canalId: C1 }))
    expect(r).toEqual({ tipo: 'sem_telefone' })
    expect(await donoDe(fantasma)).toBeNull()
    expect(await ponteiro(FN)).toBeNull()
  })

  it('dado a chave ligada só em OUTRO número, então este não distribui', async () => {
    await regra('ddd', '85', FN)
    await ligarRodizio(C2)
    const r = await chega(fone('85'), C1)
    if (!r.ok) throw new Error(r.motivo)
    expect(await donoDe(r.contatoId)).toBeNull()
  })

  it('dado seis leads novos AO MESMO TEMPO, então cada um dos três vendedores fica com dois (sem corrida)', async () => {
    await regra('padrao', null, FN)
    await ligarRodizio()
    const rs = await Promise.all(Array.from({ length: 6 }, () => chega(fone('31'))))
    const donos: string[] = []
    for (const r of rs) {
      if (!r.ok) throw new Error(r.motivo)
      donos.push((await donoDe(r.contatoId))!.usuario_id!)
    }
    const porVendedor = Object.fromEntries([U.v1, U.v2, U.v3].map((u) => [u, donos.filter((d) => d === u).length]))
    expect(porVendedor).toEqual({ [U.v1]: 2, [U.v2]: 2, [U.v3]: 2 })
  })
})

describe('handoff — dono → filial em rodízio → pool → gestor da filial → gestor', () => {
  const transfere = (conv: string, canal = C1, agora = new Date()) =>
    comTenantServico(A, (tx) => entregarParaHumano(tx, { conversaId: conv, canalId: canal, sessaoId: null, motivo: 'pedido_humano', resumo: 'quer gente', agora }))
  const rotaDe = async (conv: string) => (await dono<{ responsavel_id: string | null; responsavel_origem: string | null; responsavel_filial_id: string | null }[]>`
    SELECT responsavel_id, responsavel_origem, responsavel_filial_id FROM atendimento WHERE conversa_id = ${conv}`)[0]!
  const avisados = async (conv: string) => (await dono<{ usuario_id: string }[]>`
    SELECT usuario_id FROM notificacao WHERE conversa_id = ${conv} AND tipo = 'agente.handoff' ORDER BY usuario_id`).map((n) => n.usuario_id)

  it('dado dono da carteira ativo, então ele leva (a filial não é consultada nem travada)', async () => {
    await regra('ddd', '85', FN)
    const conv = await conversa(await contato({ ddd: '85', dono: U.vs }))
    await transfere(conv)
    expect(await rotaDe(conv)).toEqual({ responsavel_id: U.vs, responsavel_origem: 'dono_carteira', responsavel_filial_id: null })
    expect(await dono`SELECT 1 FROM rodizio_filial WHERE tenant_id = ${A}`).toHaveLength(0)
  })

  it('dado dono ausente, então vendedores da filial que atendem o número em rodízio — antes do pool', async () => {
    await regra('ddd', '85', FN)
    await atende(C1, 'v2', 'v3', 'vs') // v1 não atende C1; pool por id seria v2, v3, vs
    await dono`UPDATE usuario SET ausente = true WHERE id = ${U.vs}`
    const t0 = Date.now()
    const rotas = []
    for (let i = 0; i < 3; i++) {
      const conv = await conversa(await contato({ ddd: '85', dono: U.vs }))
      await transfere(conv, C1, new Date(t0 + i * 1000))
      rotas.push(await rotaDe(conv))
    }
    expect(rotas.map((r) => r.responsavel_id)).toEqual([U.v2, U.v3, U.v2])
    expect(rotas.every((r) => r.responsavel_origem === 'filial' && r.responsavel_filial_id === FN)).toBe(true)
    expect(await ponteiro(FN, 'handoff')).toBe(U.v2)
  })

  it('dado filial sem ninguém disponível, então o pool do número (comportamento de antes)', async () => {
    await regra('ddd', '85', FN)
    await atende(C1, 'vs')
    await dono`UPDATE usuario SET ausente = true WHERE id IN (${U.v1}, ${U.v2}, ${U.v3}, ${U.at})`
    const conv = await conversa(await contato({ ddd: '85' }))
    await transfere(conv)
    expect(await rotaDe(conv)).toEqual({ responsavel_id: U.vs, responsavel_origem: 'pool', responsavel_filial_id: null })
  })

  it('dado nem filial nem pool, então o gestor da filial — e o aviso vai aos gestores DA FILIAL', async () => {
    await regra('ddd', '85', FN)
    await dono`UPDATE usuario SET ausente = true WHERE id IN (${U.v1}, ${U.v2}, ${U.v3}, ${U.at})`
    const conv = await conversa(await contato({ ddd: '85' }))
    await transfere(conv)
    expect(await rotaDe(conv)).toEqual({ responsavel_id: U.gn, responsavel_origem: 'gestor_filial', responsavel_filial_id: FN })
    expect(await avisados(conv)).toEqual([U.gn, U.sn].sort())
  })

  it('dado gestores da filial fora, então o gestor geral (e todos os gestores avisados)', async () => {
    await regra('ddd', '85', FN)
    await dono`UPDATE usuario SET ausente = true WHERE id IN (${U.v1}, ${U.v2}, ${U.v3}, ${U.at})`
    await dono`UPDATE usuario SET ativo = false WHERE id IN (${U.gn}, ${U.sn})`
    const conv = await conversa(await contato({ ddd: '85' }))
    await transfere(conv)
    const r = await rotaDe(conv)
    expect(r.responsavel_origem).toBe('gestor')
    expect(r.responsavel_filial_id).toBeNull()
    expect(await avisados(conv)).toContain(U.gg)
  })

  it('dado contato sem filial roteada, então nada muda em relação ao P18 (pool → gestor)', async () => {
    await atende(C1, 'vs')
    const conv = await conversa(await contato({ ddd: '11' }))
    await transfere(conv)
    expect(await rotaDe(conv)).toMatchObject({ responsavel_id: U.vs, responsavel_origem: 'pool' })
  })

  it('dado número COM filial e contato com filial gravada, mas SEM regras nem rodízio ligado, então o comportamento antigo (opt-in)', async () => {
    await dono`UPDATE canal_conectado SET filial_id = ${FN} WHERE id = ${C1}`
    await atende(C1, 'v2', 'vs') // pool por id: v2, vs
    const conv = await conversa(await contato({ ddd: '85', filial: FN }))
    await transfere(conv)
    // Sem opt-in: P18 puro — o pool do número, origem 'pool', sem filial nem ponteiro de filial.
    expect(await rotaDe(conv)).toEqual({ responsavel_id: U.v2, responsavel_origem: 'pool', responsavel_filial_id: null })
    expect(await dono`SELECT 1 FROM rodizio_filial WHERE tenant_id = ${A}`).toHaveLength(0)

    // Basta ligar o rodízio na entrada em ALGUM número (ou ter uma regra ativa) para a filial passar a valer.
    await ligarRodizio(C2)
    const conv2 = await conversa(await contato({ ddd: '85', filial: FN }))
    await transfere(conv2)
    expect(await rotaDe(conv2)).toEqual({ responsavel_id: U.v2, responsavel_origem: 'filial', responsavel_filial_id: FN })
  })

  it('dado regra INATIVA apenas, então ainda é o comportamento antigo', async () => {
    await dono`INSERT INTO regra_roteamento (tenant_id, id, tipo, valor, filial_id, ativa) VALUES (${A}, ${randomUUID()}, 'ddd', '85', ${FN}, false)`
    await atende(C1, 'vs')
    const conv = await conversa(await contato({ ddd: '85', filial: FN }))
    await transfere(conv)
    expect(await rotaDe(conv)).toMatchObject({ responsavel_id: U.vs, responsavel_origem: 'pool' })
  })

  it('dado handoffs roteados pela filial, então a vez do POOL não os conta', async () => {
    await regra('ddd', '85', FN)
    await atende(C1, 'v1', 'vs') // pool por id: v1, vs
    const t0 = Date.now()
    const c1 = await conversa(await contato({ ddd: '11' })) // sem filial → pool: v1
    await transfere(c1, C1, new Date(t0))
    const c2 = await conversa(await contato({ ddd: '85' })) // FN → filial: v1 (único de FN no número)
    await transfere(c2, C1, new Date(t0 + 1000))
    const c3 = await conversa(await contato({ ddd: '11' })) // o pool segue do v1 (o 2º não conta) → vs
    await transfere(c3, C1, new Date(t0 + 2000))
    expect([(await rotaDe(c1)).responsavel_id, (await rotaDe(c2)).responsavel_origem, (await rotaDe(c3)).responsavel_id])
      .toEqual([U.v1, 'filial', U.vs])
  })

  it('dado handoff repetido (SLA já armado), então a vez da filial não é gasta', async () => {
    await regra('ddd', '85', FN)
    const conv = await conversa(await contato({ ddd: '85' }))
    await transfere(conv)
    await transfere(conv)
    expect(await ponteiro(FN, 'handoff')).toBe(U.v1)
  })
})

describe('rotas /v1/roteamento', () => {
  it('admin cria, lista com nomes, edita e remove; tudo auditado', async () => {
    const c = await pedir('adm', 'POST', '/v1/roteamento/regras', { tipo: 'origem', valor: ORIGEM.toUpperCase(), filialId: FS, canalId: C1, prioridade: 5 })
    expect(c.status).toBe(201)
    const id = c.corpo.id as string
    const l = await pedir('adm', 'GET', '/v1/roteamento/regras')
    expect(l.corpo.itens).toEqual([expect.objectContaining({
      id, tipo: 'origem', valor: ORIGEM, valorRotulo: 'Feira', filialId: FS, filialNome: 'Sul', canalId: C1, canalNome: 'Loja 1', prioridade: 5, ativa: true,
    })])
    // Trocar o tipo sem valor apaga o valor antigo: padrão não tem valor.
    expect((await pedir('adm', 'PATCH', `/v1/roteamento/regras/${id}`, { tipo: 'padrao', ativa: false })).status).toBe(200)
    const [r] = await dono<{ tipo: string; valor: string | null; ativa: boolean }[]>`SELECT tipo, valor, ativa FROM regra_roteamento WHERE id = ${id}`
    expect(r).toEqual({ tipo: 'padrao', valor: null, ativa: false })
    expect((await pedir('adm', 'DELETE', `/v1/roteamento/regras/${id}`)).status).toBe(200)
    expect((await pedir('adm', 'DELETE', `/v1/roteamento/regras/${id}`)).status).toBe(404)
    const acoes = (await dono<{ acao: string }[]>`SELECT acao FROM auditoria WHERE tenant_id = ${A} AND entidade_id = ${id} ORDER BY criado_em`).map((a) => a.acao)
    expect(acoes).toEqual(['roteamento.regra_criada', 'roteamento.regra_alterada', 'roteamento.regra_removida'])
  })

  it('valida: DDD inexistente, origem/filial/número de outro tenant, filial inativa, duplicada', async () => {
    const post = (b: object) => pedir('adm', 'POST', '/v1/roteamento/regras', b)
    expect((await post({ tipo: 'ddd', valor: '20', filialId: FN })).corpo).toMatchObject({ erro: 'roteamento.valor_invalido', campos: ['valor'] })
    expect((await post({ tipo: 'ddd', valor: '8a', filialId: FN })).status).toBe(422)
    expect((await post({ tipo: 'origem', valor: ORIGEM_B, filialId: FN })).corpo).toMatchObject({ erro: 'roteamento.origem_invalida' })
    expect((await post({ tipo: 'ddd', valor: '85', filialId: FB })).corpo).toMatchObject({ erro: 'roteamento.filial_invalida', campos: ['filialId'] })
    expect((await post({ tipo: 'ddd', valor: '85', filialId: FN, canalId: CB })).corpo).toMatchObject({ erro: 'roteamento.numero_invalido' })
    expect((await post({ tipo: 'ddd', valor: '85', filialId: FI })).corpo).toMatchObject({ erro: 'roteamento.filial_inativa' })
    expect((await post({ tipo: 'padrao', valor: '85', filialId: FN })).status).toBe(422)
    expect((await post({ tipo: 'ddd', valor: '85', filialId: FN, tenantId: B })).status).toBe(422)
    expect((await post({ tipo: 'padrao', filialId: FN })).status).toBe(201)
    expect((await post({ tipo: 'padrao', filialId: FS })).corpo).toMatchObject({ erro: 'roteamento.regra_duplicada' }) // um padrão geral só
    expect((await post({ tipo: 'padrao', filialId: FS, canalId: C1 })).status).toBe(201) // o do número é outro
  })

  it('papel: vendedor não vê nem mexe; supervisor vê mas não mexe', async () => {
    expect((await pedir('v1', 'GET', '/v1/roteamento/regras')).status).toBe(403)
    expect((await pedir('v1', 'GET', '/v1/roteamento/simular?telefone=85999990000')).status).toBe(403)
    expect((await pedir('sn', 'GET', '/v1/roteamento/regras')).status).toBe(200)
    expect((await pedir('sn', 'POST', '/v1/roteamento/regras', { tipo: 'ddd', valor: '85', filialId: FN })).status).toBe(403)
    expect((await pedir('sn', 'PUT', `/v1/roteamento/numeros/${C1}`, { rodizioNaEntrada: true })).status).toBe(403)
  })

  it('escopo: gestor de filial só vê e mexe nas regras da filial dele, sempre num número da filial dele', async () => {
    await dono`UPDATE canal_conectado SET filial_id = ${FN} WHERE id = ${C2}`
    await regra('ddd', '21', FS)
    const [fs] = await dono<{ id: string }[]>`SELECT id FROM regra_roteamento WHERE tenant_id = ${A} AND filial_id = ${FS}`
    // Regra para TODOS os números é do escopo `tudo`; número sem filial ou de outra filial, também não.
    expect((await pedir('gn', 'POST', '/v1/roteamento/regras', { tipo: 'ddd', valor: '85', filialId: FN })).corpo)
      .toMatchObject({ erro: 'roteamento.numero_obrigatorio', campos: ['canalId'] })
    expect((await pedir('gn', 'POST', '/v1/roteamento/regras', { tipo: 'ddd', valor: '85', filialId: FN, canalId: C1 })).corpo)
      .toMatchObject({ erro: 'roteamento.numero_invalido', campos: ['canalId'] })
    expect((await pedir('gn', 'POST', '/v1/roteamento/regras', { tipo: 'ddd', valor: '85', filialId: FN, canalId: C2 })).status).toBe(201)
    expect((await pedir('gn', 'POST', '/v1/roteamento/regras', { tipo: 'ddd', valor: '86', filialId: FS, canalId: C2 })).corpo)
      .toMatchObject({ erro: 'roteamento.filial_invalida' })
    const lista = await pedir('gn', 'GET', '/v1/roteamento/regras')
    expect((lista.corpo.itens ?? []).map((i) => i.filialId)).toEqual([FN])
    expect((await pedir('gn', 'PATCH', `/v1/roteamento/regras/${fs!.id}`, { ativa: false })).status).toBe(404)
    expect((await pedir('gn', 'DELETE', `/v1/roteamento/regras/${fs!.id}`)).status).toBe(404)
    // Mover a própria regra para a filial de outro também não.
    const [mn] = await dono<{ id: string }[]>`SELECT id FROM regra_roteamento WHERE tenant_id = ${A} AND filial_id = ${FN}`
    expect((await pedir('gn', 'PATCH', `/v1/roteamento/regras/${mn!.id}`, { filialId: FS })).status).toBe(422)
    // Nem para um número de fora, nem para "todos os números"; o resto edita normalmente.
    expect((await pedir('gn', 'PATCH', `/v1/roteamento/regras/${mn!.id}`, { canalId: C1 })).corpo).toMatchObject({ erro: 'roteamento.numero_invalido' })
    expect((await pedir('gn', 'PATCH', `/v1/roteamento/regras/${mn!.id}`, { canalId: null })).corpo).toMatchObject({ erro: 'roteamento.numero_obrigatorio' })
    expect((await pedir('gn', 'PATCH', `/v1/roteamento/regras/${mn!.id}`, { prioridade: 7 })).status).toBe(200)
    // Números: só os da filial dele.
    expect(((await pedir('gn', 'GET', '/v1/roteamento/numeros')).corpo.itens ?? []).map((n) => n.id)).toEqual([C2])
    // As filiais do select: só as do escopo; admin vê as ativas todas.
    expect(((await pedir('gn', 'GET', '/v1/roteamento/filiais')).corpo.itens ?? []).map((f) => f.id)).toEqual([FN])
    expect(((await pedir('adm', 'GET', '/v1/roteamento/filiais')).corpo.itens ?? []).map((f) => f.id).sort()).toEqual([FN, FS].sort())
  })

  it('duplicada: 409 quando a regra existente é visível; de OUTRA filial, 422 genérico (não revela)', async () => {
    await dono`UPDATE canal_conectado SET filial_id = ${FN} WHERE id = ${C2}`
    await regra('ddd', '85', FS, C2) // criada pelo admin, para outra filial, num número de FN
    await regra('ddd', '86', FN, C2)
    const fora = await pedir('gn', 'POST', '/v1/roteamento/regras', { tipo: 'ddd', valor: '85', filialId: FN, canalId: C2 })
    expect(fora.status).toBe(422)
    expect(fora.corpo).toEqual({ erro: 'roteamento.valor_indisponivel', mensagem: 'Este valor não pode ser usado neste número.', campos: ['valor'] })
    expect((await pedir('gn', 'POST', '/v1/roteamento/regras', { tipo: 'ddd', valor: '86', filialId: FN, canalId: C2 })).status).toBe(409)
    expect((await pedir('adm', 'POST', '/v1/roteamento/regras', { tipo: 'ddd', valor: '85', filialId: FN, canalId: C2 })).status).toBe(409)
  })

  it('ligar a chave avisa quando o número não roteia para ninguém ou a filial está sem vendedor', async () => {
    expect((await pedir('adm', 'PUT', `/v1/roteamento/numeros/${C1}`, { rodizioNaEntrada: true })).corpo.aviso).toMatch(/Nenhuma regra/)
    await regra('ddd', '21', FS)
    await regra('ddd', '85', FN)
    await dono`UPDATE usuario SET ausente = true WHERE id = ${U.vs}`
    expect((await pedir('adm', 'PUT', `/v1/roteamento/numeros/${C1}`, { rodizioNaEntrada: true })).corpo.aviso).toMatch(/Sul/)
    await dono`UPDATE usuario SET ausente = false WHERE id = ${U.vs}`
    expect((await pedir('adm', 'PUT', `/v1/roteamento/numeros/${C1}`, { rodizioNaEntrada: true })).corpo.aviso).toBeNull()
    expect((await pedir('adm', 'PUT', `/v1/roteamento/numeros/${C1}`, { rodizioNaEntrada: false })).corpo.aviso).toBeNull()
  })

  it('a chave por número: admin liga (auditado); gestor de filial só no número da filial dele', async () => {
    expect((await pedir('adm', 'PUT', `/v1/roteamento/numeros/${C1}`, { rodizioNaEntrada: true })).status).toBe(200)
    const nums = await pedir('adm', 'GET', '/v1/roteamento/numeros')
    expect(nums.corpo.itens).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: C1, rodizioNaEntrada: true }), expect.objectContaining({ id: C2, rodizioNaEntrada: false }),
    ]))
    expect((await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${A} AND acao = 'roteamento.rodizio_entrada_alterado'`).length).toBe(1)
    expect((await pedir('adm', 'PUT', `/v1/roteamento/numeros/${C1}`, { rodizioNaEntrada: 'sim' })).status).toBe(422)
    expect((await pedir('gn', 'PUT', `/v1/roteamento/numeros/${C2}`, { rodizioNaEntrada: true })).status).toBe(404)
    await dono`UPDATE canal_conectado SET filial_id = ${FN} WHERE id = ${C2}`
    expect((await pedir('gn', 'PUT', `/v1/roteamento/numeros/${C2}`, { rodizioNaEntrada: true })).status).toBe(200)
    expect((await pedir('adm', 'PUT', `/v1/roteamento/numeros/${CB}`, { rodizioNaEntrada: true })).status).toBe(404)
  })

  it('simular mostra filial e vendedor — e NÃO avança o rodízio nem grava nada', async () => {
    await regra('ddd', '85', FN)
    await regra('origem', ORIGEM, FS)
    await ligarRodizio()
    await escolher(FN, C1) // v1 já levou
    const antes = await dono`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A}`
    const s1 = await pedir('adm', 'GET', `/v1/roteamento/simular?telefone=${encodeURIComponent('(85) 99999-0000')}&canalId=${C1}`)
    expect(s1.status).toBe(200)
    expect(s1.corpo).toMatchObject({ ddd: '85', filial: { id: FN, nome: 'Norte' }, motivo: 'ddd', vendedor: { id: U.v2, nome: 'V2' }, elegiveis: 3, rodizioNaEntrada: true, foraDoEscopo: false })
    const s2 = await pedir('sn', 'GET', '/v1/roteamento/simular?telefone=85999990000')
    expect((s2.corpo.vendedor as { id: string }).id).toBe(U.v2)
    expect(await ponteiro(FN)).toBe(U.v1)
    expect(await dono`SELECT count(*)::int AS n FROM auditoria WHERE tenant_id = ${A}`).toEqual(antes)
    // Origem vence o DDD também na simulação.
    expect((await pedir('adm', 'GET', `/v1/roteamento/simular?telefone=85999990000&origemId=${ORIGEM}`)).corpo)
      .toMatchObject({ filial: { id: FS }, motivo: 'origem', vendedor: { id: U.vs }, rodizioNaEntrada: null })
    // Nenhuma regra: nenhuma filial, ninguém.
    expect((await pedir('adm', 'GET', '/v1/roteamento/simular?telefone=11999990000')).corpo)
      .toMatchObject({ filial: null, motivo: 'nenhuma', vendedor: null, elegiveis: 0 })
    expect((await pedir('adm', 'GET', '/v1/roteamento/simular')).status).toBe(422)
    expect((await pedir('adm', 'GET', `/v1/roteamento/simular?telefone=85999990000&origemId=${ORIGEM_B}`)).status).toBe(422)
    expect((await pedir('adm', 'GET', `/v1/roteamento/simular?telefone=85999990000&canalId=${CB}`)).status).toBe(422)
  })

  it('simular no escopo de filial: só números da filial dele; filial de fora = "outra filial", sem vendedor nem regra', async () => {
    await regra('ddd', '85', FN)
    await dono`UPDATE canal_conectado SET filial_id = ${FS} WHERE id = ${C2}`
    expect((await pedir('gs', 'GET', `/v1/roteamento/simular?telefone=85999990000&canalId=${C1}`)).corpo)
      .toMatchObject({ erro: 'roteamento.numero_invalido' })
    const fora = await pedir('gs', 'GET', `/v1/roteamento/simular?telefone=85999990000&canalId=${C2}`)
    expect(fora.corpo).toEqual({ ddd: '85', filial: null, motivo: 'ddd', regraId: null, vendedor: null, elegiveis: 0, rodizioNaEntrada: false, foraDoEscopo: true })
    // A própria filial (número de FS, DDD sem regra → filial do número) aparece inteira.
    expect((await pedir('gs', 'GET', `/v1/roteamento/simular?telefone=11999990000&canalId=${C2}`)).corpo)
      .toMatchObject({ filial: { id: FS }, motivo: 'filial_numero', vendedor: { id: U.vs }, foraDoEscopo: false })
  })

  it('dois tenants: B não vê nem mexe nas regras de A', async () => {
    await regra('ddd', '85', FN)
    const [r] = await dono<{ id: string }[]>`SELECT id FROM regra_roteamento WHERE tenant_id = ${A}`
    expect((await pedir('bx', 'GET', '/v1/roteamento/regras')).corpo.itens).toEqual([])
    expect((await pedir('bx', 'PATCH', `/v1/roteamento/regras/${r!.id}`, { ativa: false })).status).toBe(404)
    expect((await pedir('bx', 'DELETE', `/v1/roteamento/regras/${r!.id}`)).status).toBe(404)
    expect((await pedir('bx', 'GET', '/v1/roteamento/numeros')).corpo.itens).toEqual([expect.objectContaining({ id: CB })])
  })
})

describe('RLS — papel da aplicação', () => {
  it('a sessão de B não lê regra nem ponteiro de A, não grava com o tenant de A, e sem tenant vê zero', async () => {
    await regra('ddd', '85', FN)
    await escolher(FN, C1)
    const comoB = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { 'geracrm.tenant_id': B } as never })
    const semTenant = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })
    try {
      expect(await comoB`SELECT 1 FROM regra_roteamento`).toHaveLength(0)
      expect(await comoB`SELECT 1 FROM rodizio_filial`).toHaveLength(0)
      await expect(comoB`INSERT INTO regra_roteamento (tenant_id, id, tipo, filial_id) VALUES (${A}, ${randomUUID()}, 'padrao', ${FN})`).rejects.toThrow()
      expect(await semTenant`SELECT 1 FROM regra_roteamento`).toHaveLength(0)
    } finally { await comoB.end(); await semTenant.end() }
  })
})
