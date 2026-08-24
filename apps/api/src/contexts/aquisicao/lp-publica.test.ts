import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { extrairCodigoOrigem } from '@geracrm/shared'
import { criarApp } from '../../app.js'
import { plataformaDoClique } from './rotas-lp-publica.js'
import { consumirCodigoOrigem } from './consumo-codigo.js'
import { comTenantServico } from '../../db/index.js'

/**
 * A LANDING PAGE ponta a ponta (AQ-44 + AQ-45).
 *
 * ⚠️ A pergunta que estes testes respondem é uma só: **uma rota sem token
 * consegue escrever no tenant certo, e só nele?** É a superfície mais exposta do
 * sistema — tudo o mais aqui é detalhe perto disso.
 */

const T = '10b00000-0000-4000-8000-000000000001'
const T2 = '10b00000-0000-4000-8000-000000000002'
const PV = '10b00000-1111-4000-8000-000000000001'
const PV2 = '10b00000-1111-4000-8000-000000000002'
const PLANO = '10b00000-3333-4000-8000-000000000001'
const MODELO = '10b00000-4444-4000-8000-000000000001'
const CONTATO = '10b00000-6666-4000-8000-000000000001'
const CONTATO2 = '10b00000-6666-4000-8000-000000000002'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
let app: FastifyInstance

const comTenant = (t: string, m: 'GET' | 'POST' | 'PATCH', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, headers: { 'x-tenant-id': t }, ...(corpo ? { payload: corpo } : {}) })

/** ⚠️ SEM cabeçalho de tenant: é assim que o navegador do lead chama. */
const publico = (m: 'GET' | 'POST', url: string, corpo?: Record<string, unknown>) =>
  app.inject({ method: m, url, ...(corpo ? { payload: corpo } : {}) })

async function criarLp(tenant: string, nome = 'Campanha de uniformes'): Promise<{ chave: string; id: string }> {
  const r = await comTenant(tenant, 'POST', '/v1/aquisicao/lps', {
    nome, telefone: '55 81 99999-8888', titulo: 'Uniformes para a sua equipe',
    subtitulo: 'Orçamento no WhatsApp', textoBase: 'Olá! Vi o anúncio',
    avisoConsentimento: 'Ao continuar, você aceita receber contato pelo WhatsApp.',
  })
  expect(r.statusCode).toBe(201)
  return r.json()
}

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-lp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-lp', 'Varejo') ON CONFLICT DO NOTHING`
  for (const [t, pv] of [[T, PV], [T2, PV2]] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
               VALUES (${t}, 'Loja', ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
               VALUES (${t}, ${pv}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
    })
  }
  app = await criarApp(); await app.ready()
})

beforeEach(async () => {
  for (const t of [T, T2]) {
    await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${t}`
    await dono`DELETE FROM midia_sessao_lp   WHERE tenant_id = ${t}`
    await dono`DELETE FROM midia_lp          WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato           WHERE tenant_id = ${t}`
  }
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO}, 'Lead')`
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO2}, 'Outro lead')`
})

afterAll(async () => {
  await app.close()
  for (const t of [T, T2]) {
    await dono`DELETE FROM midia_lead_origem WHERE tenant_id = ${t}`
    await dono`DELETE FROM midia_sessao_lp   WHERE tenant_id = ${t}`
    await dono`DELETE FROM midia_lp          WHERE tenant_id = ${t}`
    await dono`DELETE FROM contato           WHERE tenant_id = ${t}`
  }
  await dono.end()
})

describe('Página pública', () => {
  it('serve a página da LP para quem tem a chave, sem token nenhum', async () => {
    const { chave } = await criarLp(T)

    const r = await publico('GET', `/publico/lp/${chave}`)

    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/html')
    expect(r.body).toContain('Uniformes para a sua equipe')
  })

  it('chave desconhecida devolve PÁGINA de 404 — quem chega aqui é uma pessoa', async () => {
    const r = await publico('GET', '/publico/lp/naoexisteessachave')
    expect(r.statusCode).toBe(404)
    expect(r.headers['content-type']).toContain('text/html')
  })

  it('LP desligada some da rua', async () => {
    const { chave, id } = await criarLp(T)
    await comTenant(T, 'PATCH', `/v1/aquisicao/lps/${id}`, { ativo: false })

    expect((await publico('GET', `/publico/lp/${chave}`)).statusCode).toBe(404)
    expect((await publico('POST', `/publico/lp/${chave}/sessao`, {})).statusCode).toBe(404)
  })

  it('chave fora do formato nem chega ao banco', async () => {
    expect((await publico('GET', '/publico/lp/../../etc/passwd')).statusCode).toBe(404)
    expect((await publico('GET', '/publico/lp/CURTA')).statusCode).toBe(404)
  })
})

describe('Sessão do clique', () => {
  it('devolve o link do wa.me com o código, e o extrator o encontra', async () => {
    const { chave } = await criarLp(T)

    const r = await publico('POST', `/publico/lp/${chave}/sessao`, {
      clickId: 'Cj0KCQ-exemplo', clickIdTipo: 'gclid',
      utmSource: 'google', utmCampaign: 'uniformes-pe',
      anuncioExternoId: '777', pagina: 'https://lp.exemplo/uniformes?gclid=x',
    })

    expect(r.statusCode).toBe(200)
    const d = r.json()
    expect(d.link).toContain('https://wa.me/5581999998888?text=')
    expect(extrairCodigoOrigem(d.textoPronto)).toBe(d.codigo)
  })

  /**
   * ⚠️ O TESTE QUE IMPORTA: a rota não recebe tenant nenhum. Se a resolução pela
   * chave estiver errada, a sessão nasce no tenant errado — e a atribuição de um
   * cliente vira a de outro, sem ninguém perceber.
   */
  it('a sessão nasce no tenant DONO da chave, não em outro', async () => {
    const a = await criarLp(T, 'LP do tenant A')
    const b = await criarLp(T2, 'LP do tenant B')

    await publico('POST', `/publico/lp/${a.chave}/sessao`, { utmSource: 'google' })
    await publico('POST', `/publico/lp/${b.chave}/sessao`, { utmSource: 'facebook' })

    const [naA] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_sessao_lp WHERE tenant_id = ${T}`
    const [naB] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_sessao_lp WHERE tenant_id = ${T2}`
    expect(naA!.n).toBe(1)
    expect(naB!.n).toBe(1)
  })

  it('grava a plataforma decidida pelo TIPO do click id', async () => {
    const { chave } = await criarLp(T)
    await publico('POST', `/publico/lp/${chave}/sessao`, { clickId: 'x', clickIdTipo: 'fbclid' })

    const [s] = await dono<{ plataforma: string | null }[]>`
      SELECT plataforma FROM midia_sessao_lp WHERE tenant_id = ${T}`
    expect(s!.plataforma).toBe('meta')
  })

  /**
   * ⚠️ O texto do consentimento vem da LP, NUNCA do corpo da requisição: tem de
   * ser o que nós exibimos, não o que o cliente diz que leu.
   */
  it('congela o aviso de consentimento da LP, ignorando o que vier no corpo', async () => {
    const { chave } = await criarLp(T)
    await publico('POST', `/publico/lp/${chave}/sessao`, {
      consentimentoTexto: 'Eu concordo com tudo, inclusive com o que não li',
    })

    const [s] = await dono<{ consentimento_texto: string | null }[]>`
      SELECT consentimento_texto FROM midia_sessao_lp WHERE tenant_id = ${T}`
    expect(s!.consentimento_texto).toContain('receber contato pelo WhatsApp')
  })

  it('cada clique gera um código diferente', async () => {
    const { chave } = await criarLp(T)
    const a = await publico('POST', `/publico/lp/${chave}/sessao`, {}).then((r) => r.json())
    const b = await publico('POST', `/publico/lp/${chave}/sessao`, {}).then((r) => r.json())
    expect(a.codigo).not.toBe(b.codigo)
  })

  /** Rota pública sem teto é convite: um laço enche a tabela em minutos. */
  it('acima do teto por IP, recusa com 429 — e a página degrada para o wa.me', async () => {
    const { chave } = await criarLp(T)
    let ultimo = 200
    for (let i = 0; i < 25; i++) {
      ultimo = (await publico('POST', `/publico/lp/${chave}/sessao`, {})).statusCode
    }
    expect(ultimo).toBe(429)
  })
})

describe('Plataforma do clique', () => {
  it('reconhece os parâmetros de cada plataforma', () => {
    expect(plataformaDoClique('gclid', null)).toBe('google')
    expect(plataformaDoClique('wbraid', null)).toBe('google')
    expect(plataformaDoClique('fbclid', null)).toBe('meta')
    expect(plataformaDoClique(null, 'instagram_stories')).toBe('meta')
    expect(plataformaDoClique(null, 'tiktok')).toBe('tiktok')
  })

  /**
   * ⚠️ Lista fechada, nunca o `utm_source` cru: a coluna tem CHECK, e repassar
   * texto livre faria o INSERT falhar por causa de um parâmetro esquisito na URL
   * — derrubando a criação da sessão de um lead real.
   */
  it('parâmetro desconhecido vira NULL, não texto livre', () => {
    expect(plataformaDoClique('qualquer_coisa', 'newsletter-do-joao')).toBeNull()
    expect(plataformaDoClique(null, null)).toBeNull()
  })
})

describe('⚠️ O código chegando na conversa (AQ-45)', () => {
  const consumir = (texto: string, contato = CONTATO) =>
    comTenantServico(T, (tx) => consumirCodigoOrigem(tx, contato, texto))

  async function sessao(): Promise<string> {
    const { chave } = await criarLp(T)
    const d = await publico('POST', `/publico/lp/${chave}/sessao`, {
      clickId: 'Cj0-abc', clickIdTipo: 'gclid', utmSource: 'google',
      utmCampaign: 'uniformes-pe', anuncioExternoId: '777',
    }).then((r) => r.json())
    return d.textoPronto
  }

  it('vira o primeiro toque de mídia do contato, com clique e campanha', async () => {
    const texto = await sessao()

    expect(await consumir(texto)).toBe('registrada')

    const [o] = await dono<{
      plataforma: string; click_id: string; utm_campaign: string
      anuncio_externo_id: string; modo_entrada: string; primeira: boolean
      consentimento_texto: string | null; consentimento_em: Date | null
    }[]>`SELECT plataforma, click_id, utm_campaign, anuncio_externo_id, modo_entrada,
                primeira, consentimento_texto, consentimento_em
           FROM midia_lead_origem WHERE tenant_id = ${T}`
    expect(o).toMatchObject({
      plataforma: 'google', click_id: 'Cj0-abc', utm_campaign: 'uniformes-pe',
      anuncio_externo_id: '777', modo_entrada: 'inbound_wa', primeira: true,
    })
    // ⚠️ Consentimento é PAR (CHECK do 0059): texto e carimbo, ou nenhum dos dois.
    expect(o!.consentimento_texto).toContain('WhatsApp')
    expect(o!.consentimento_em).not.toBeNull()
  })

  it('marca a sessão como consumida — é dela que sai a taxa de código perdido', async () => {
    const texto = await sessao()
    await consumir(texto)

    const [s] = await dono<{ consumida_em: Date | null }[]>`
      SELECT consumida_em FROM midia_sessao_lp WHERE tenant_id = ${T}`
    expect(s!.consumida_em).not.toBeNull()
  })

  /** O lead reenviando a mesma mensagem não pode virar dois toques. */
  it('a segunda mensagem com o mesmo código não cria origem nova', async () => {
    const texto = await sessao()
    expect(await consumir(texto)).toBe('registrada')
    expect(await consumir(texto)).toBe('ja_consumida')

    const [c] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_lead_origem WHERE tenant_id = ${T}`
    expect(c!.n).toBe(1)
  })

  it('mensagem sem código é o caso COMUM, não um erro', async () => {
    expect(await consumir('Oi, bom dia! Vocês fazem uniforme?')).toBe('sem_codigo')
  })

  /**
   * ⚠️ Falso positivo do extrator (uma palavra de 6 letras do alfabeto dele) tem
   * de ser distinguível de "já consumida": um mede extrator ficando burro, o
   * outro mede lead repetindo mensagem.
   */
  it('código que não existe no tenant é sessão desconhecida, não origem', async () => {
    expect(await consumir('quero saber o preço [ref: ZZZ999]')).toBe('sessao_desconhecida')

    const [c] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_lead_origem WHERE tenant_id = ${T}`
    expect(c!.n).toBe(0)
  })

  /**
   * ⚠️ Origem é 1:N com contato de propósito (0059): quem volta por um segundo
   * anúncio ganha um toque novo SEM perder o primeiro. O índice INV-61 garante
   * um único `primeira` — e é por isso que o segundo toque nasce false.
   */
  it('o mesmo contato voltando por outro anúncio ganha um SEGUNDO toque', async () => {
    expect(await consumir(await sessao())).toBe('registrada')
    expect(await consumir(await sessao())).toBe('registrada')

    const toques = await dono<{ primeira: boolean }[]>`
      SELECT primeira FROM midia_lead_origem WHERE tenant_id = ${T} AND contato_id = ${CONTATO}
       ORDER BY primeira DESC`
    expect(toques.map((t) => t.primeira)).toEqual([true, false])
  })

  it('contatos diferentes têm cada um o seu primeiro toque', async () => {
    await consumir(await sessao(), CONTATO)
    await consumir(await sessao(), CONTATO2)

    const [c] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM midia_lead_origem WHERE tenant_id = ${T} AND primeira`
    expect(c!.n).toBe(2)
  })
})

describe('Painel de LPs', () => {
  it('lista com a taxa de código perdido — e "ninguém clicou" não é 0%', async () => {
    const { chave } = await criarLp(T)
    const semClique = await comTenant(T, 'GET', '/v1/aquisicao/lps').then((r) => r.json())
    // ⚠️ null, não 0: "ninguém clicou ainda" e "todo mundo apagou o código"
    //    pedem reações opostas.
    expect(semClique.itens[0]).toMatchObject({ sessoes: 0, taxaPerdida: null })

    const d = await publico('POST', `/publico/lp/${chave}/sessao`, {}).then((r) => r.json())
    await publico('POST', `/publico/lp/${chave}/sessao`, {})
    await comTenantServico(T, (tx) => consumirCodigoOrigem(tx, CONTATO, d.textoPronto))

    const depois = await comTenant(T, 'GET', '/v1/aquisicao/lps').then((r) => r.json())
    expect(depois.itens[0]).toMatchObject({ sessoes: 2, consumidas: 1, taxaPerdida: 0.5 })
    expect(depois.itens[0].url).toBe(`/publico/lp/${chave}`)
  })

  it('recusa cadastro sem título ou com telefone inválido, por campo', async () => {
    const semTitulo = await comTenant(T, 'POST', '/v1/aquisicao/lps', {
      nome: 'X', telefone: '5581999998888',
    })
    expect(semTitulo.statusCode).toBe(422)
    expect(semTitulo.json().campo).toBe('titulo')

    const telRuim = await comTenant(T, 'POST', '/v1/aquisicao/lps', {
      nome: 'X', titulo: 'T', telefone: '123',
    })
    expect(telRuim.statusCode).toBe(422)
    expect(telRuim.json().campo).toBe('telefone')
  })
})
