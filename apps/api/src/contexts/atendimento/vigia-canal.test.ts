import { describe, it, expect } from 'vitest'
import { CanalPlugZapi } from './canais/plugzapi.js'
import { CanalMetaOficial } from './canais/meta-oficial.js'
import { criarCanal } from './canais/fabrica.js'

/**
 * ⚠️ Testes do CONTRATO que o vigia usa. O incidente de 2026-08-24 aconteceu
 * porque ninguém perguntava se a sessão estava viva — então o que precisa ficar
 * protegido é a pergunta existir e ser feita só onde faz sentido.
 */
function fakeFetch(corpo: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300, status, json: async () => corpo,
  })) as unknown as typeof fetch
}

describe('Quem pode cair, e quem não', () => {
  /**
   * ⚠️ O não-oficial automatiza um WhatsApp Web: o celular desliga e o número
   * para de enviar E de receber, sem erro em lugar nenhum.
   */
  it('PlugZapi declara que a sessão pode cair', () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' })
    expect(c.capacidades.sessaoPodeCair).toBe(true)
  })

  // ⚠️ O oficial é TOKEN, não sessão. Perguntar ali seria inventar verificação.
  it('Meta oficial declara que NÃO cai sozinho', () => {
    const c = new CanalMetaOficial({ phoneNumberId: 'p', token: 't' })
    expect(c.capacidades.sessaoPodeCair).toBe(false)
  })

  it('adaptador não implementado também não é vigiado', () => {
    expect(criarCanal('tiktok_business', {}).capacidades.sessaoPodeCair).toBe(false)
  })
})

describe('verificarConexao do PlugZapi', () => {
  /** A resposta REAL do incidente de 24/ago, como fixture. */
  const respostaDoIncidente = {
    connected: false, session: false, smartphoneConnected: false,
    error: 'You are not connected.',
  }

  it('reconhece a desconexão e devolve o motivo do fornecedor', async () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' }, { buscar: fakeFetch(respostaDoIncidente) })
    const r = await c.verificarConexao()
    expect(r.conectado).toBe(false)
    expect(r.detalhe).toBe('You are not connected.')
  })

  it('reconhece a conexão saudável', async () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' }, { buscar: fakeFetch({ connected: true }) })
    expect((await c.verificarConexao()).conectado).toBe(true)
  })

  /**
   * ⚠️ Fornecedor fora do ar NÃO pode ser lido como "conectado". Na dúvida, o
   * vigia precisa avisar — silêncio parecendo saúde é o modo de falha que este
   * módulo existe para eliminar.
   */
  it('falha de rede conta como NÃO conectado', async () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' }, {
      buscar: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch,
    })
    expect((await c.verificarConexao()).conectado).toBe(false)
  })

  it('resposta sem `connected` também não vira conectado', async () => {
    const c = new CanalPlugZapi({ instancia: 'i', token: 't' }, { buscar: fakeFetch({ algo: 'novo' }) })
    expect((await c.verificarConexao()).conectado).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ Testes CONTRA O BANCO. Os de cima verificam o contrato do adaptador e
//    passaram enquanto a consulta do vigia citava DUAS COLUNAS INEXISTENTES
//    (`credencial` e `telefone`, quando o schema tem `credenciais_cifradas` e
//    `nome_amigavel`). Typecheck não vê SQL em string, e o `.catch` do agendador
//    engoliria a falha como warn a cada 5 minutos — vigilância que não vigia.
//    Teste de contrato não substitui teste de consulta.
import { beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { vigiarConexaoCanais } from './vigia-canal.js'
import { cifrar } from '../integracao/cofre.js'
import type { Sql } from '../../db/index.js'

const TV = '00ca1a00-0000-4000-8000-000000000001'
const PVV = '00ca1a00-1111-4000-8000-000000000001'
const PLANOV = '00ca1a00-3333-4000-8000-000000000001'
const MODELOV = '00ca1a00-4444-4000-8000-000000000001'
const CANAL = '00ca1a00-cccc-4000-8000-000000000001'

const donoV = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const sqlV = donoV as unknown as Sql
const AGORA_V = new Date('2026-08-24T12:00:00Z')

beforeAll(async () => {
  await donoV`INSERT INTO plano (id, codigo, nome) VALUES (${PLANOV}, 'plano-vigia-canal', 'Pro') ON CONFLICT DO NOTHING`
  await donoV`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELOV}, 'modelo-vigia-canal', 'Varejo') ON CONFLICT DO NOTHING`
  await donoV.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${TV}, 'Loja', ${PLANOV}, ${PVV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${TV}, ${PVV}, ${MODELOV}, 'Varejo') ON CONFLICT DO NOTHING`
  })
})

beforeEach(async () => {
  await donoV`DELETE FROM alerta          WHERE tenant_id = ${TV}`
  await donoV`DELETE FROM outbox          WHERE tenant_id = ${TV}`
  await donoV`DELETE FROM canal_conectado WHERE tenant_id = ${TV}`
})

afterAll(async () => {
  await donoV`DELETE FROM alerta          WHERE tenant_id = ${TV}`
  await donoV`DELETE FROM outbox          WHERE tenant_id = ${TV}`
  await donoV`DELETE FROM canal_conectado WHERE tenant_id = ${TV}`
  await donoV.end()
})

async function canalPlugZapi(estado: string): Promise<void> {
  await donoV`
    INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado, provedor, credenciais_cifradas)
    VALUES (${TV}, ${CANAL}, 'whatsapp_nao_oficial', 'Número da loja', ${estado}, 'plugzapi',
            ${cifrar({ instancia: 'i', token: 't', clientToken: 'c' })})`
}

describe('Vigia contra o banco — a consulta existe de verdade', () => {
  it('a consulta roda sem erro de coluna', async () => {
    await canalPlugZapi('conectado')
    // ⚠️ Se qualquer coluna do SELECT não existir, isto lança — que é
    //    exatamente o que os testes de contrato NÃO pegaram.
    await expect(vigiarConexaoCanais(sqlV, AGORA_V)).resolves.toBeDefined()
  })

  it('canal sem provedor ou sem credencial é ignorado, não quebra', async () => {
    await donoV`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado)
                VALUES (${TV}, ${CANAL}, 'whatsapp_nao_oficial', 'Sem credencial', 'conectado')`
    const r = await vigiarConexaoCanais(sqlV, AGORA_V)
    expect(r.verificados).toBe(0)
  })

  it('canal suspenso não é tocado — suspensão é decisão humana', async () => {
    await canalPlugZapi('suspenso')
    await vigiarConexaoCanais(sqlV, AGORA_V)
    const [c] = await donoV<{ estado: string }[]>`
      SELECT estado FROM canal_conectado WHERE tenant_id = ${TV} AND id = ${CANAL}`
    expect(c!.estado).toBe('suspenso')
  })
})

/**
 * ⚠️ O CARIMBO (0069). Encontrado em produção em 2026-08-25: a linha do canal
 * dizia `estado = 'conectado'` com `conectado_em = NULL` e nenhuma coluna de
 * atualização — impossível distinguir "o vigia acabou de confirmar" de "foi
 * escrito no cadastro em 09/ago e ninguém nunca conferiu".
 *
 * O caso que importa é o de NADA MUDAR: é nele que a versão anterior não
 * escrevia coisa alguma, e o estado envelhecia em silêncio parecendo saúde.
 */
describe('Carimbo de verificação', () => {
  it('⚠️ carimba mesmo quando o estado NÃO muda', async () => {
    // Já desconectado; a verificação vai confirmar que segue desconectado.
    await canalPlugZapi('desconectado')
    const [antes] = await donoV<{ verificado_em: Date | null }[]>`
      SELECT verificado_em FROM canal_conectado WHERE tenant_id = ${TV} AND id = ${CANAL}`
    expect(antes!.verificado_em).toBeNull()

    await vigiarConexaoCanais(sqlV, AGORA_V)

    const [depois] = await donoV<{ estado: string; verificado_em: Date | null }[]>`
      SELECT estado, verificado_em FROM canal_conectado WHERE tenant_id = ${TV} AND id = ${CANAL}`
    expect(depois!.estado).toBe('desconectado')          // nada mudou…
    expect(depois!.verificado_em).toEqual(AGORA_V)       // …e mesmo assim carimbou
  })

  it('carimba também na passada que derruba o canal', async () => {
    await canalPlugZapi('conectado')
    await vigiarConexaoCanais(sqlV, AGORA_V)
    const [c] = await donoV<{ estado: string; verificado_em: Date | null }[]>`
      SELECT estado, verificado_em FROM canal_conectado WHERE tenant_id = ${TV} AND id = ${CANAL}`
    expect(c!.estado).toBe('desconectado')
    expect(c!.verificado_em).toEqual(AGORA_V)
  })

  /**
   * ⚠️ Canal suspenso não entra na consulta do vigia — e portanto não recebe
   * carimbo. Isso é correto: ninguém verificou nada. Carimbar aqui registraria
   * uma observação que não houve.
   */
  it('canal suspenso não ganha carimbo', async () => {
    await canalPlugZapi('suspenso')
    await vigiarConexaoCanais(sqlV, AGORA_V)
    const [c] = await donoV<{ verificado_em: Date | null }[]>`
      SELECT verificado_em FROM canal_conectado WHERE tenant_id = ${TV} AND id = ${CANAL}`
    expect(c!.verificado_em).toBeNull()
  })
})

/**
 * ⚠️ O ALERTA ÓRFÃO. Encontrado em produção em 2026-08-25: o número estava de
 * pé (vigia respondendo `caiu: 0`) e a faixa vermelha de 24/ago continuava
 * acesa, com o alerta CRÍTICO preso em `resolvido_em = NULL`.
 *
 * Causa: fechar dependia de o vigia VER a transição `desconectado → conectado`.
 * O "Testar conexão" da tela grava `estado = 'conectado'` por fora — então o
 * estado voltou sem transição, e o alerta perdeu para sempre o único evento que
 * o fecharia. Alerta crítico impossível de fechar é pior que alerta nenhum:
 * ensina o operador a ignorar a faixa vermelha.
 */
const canalDePe = {
  criar: () => ({
    capacidades: { sessaoPodeCair: true },
    verificarConexao: async () => ({ conectado: true }),
  }),
} as unknown as { criar: typeof import('./canais/fabrica.js').criarCanal }

async function alertaAberto(): Promise<number> {
  const [r] = await donoV<{ n: number }[]>`
    SELECT count(*)::int AS n FROM alerta
     WHERE tenant_id = ${TV} AND tipo = 'canal_desconectado' AND resolvido_em IS NULL`
  return r!.n
}

describe('Alerta de canal caído', () => {
  it('⚠️ fecha o alerta com o canal JÁ conectado — sem depender da transição', async () => {
    // O estado do incidente real: canal marcado conectado (voltou pela tela) e
    // alerta de ontem ainda aberto. Nenhuma transição vai acontecer.
    await canalPlugZapi('conectado')
    await donoV`INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
                VALUES (${TV}, gen_random_uuid(), 'canal_desconectado', 'critico', 'caiu ontem')`
    expect(await alertaAberto()).toBe(1)

    const r = await vigiarConexaoCanais(sqlV, AGORA_V, canalDePe)

    expect(r.voltou).toBe(0)          // não houve transição…
    expect(await alertaAberto()).toBe(0)  // …e mesmo assim o alerta fechou
  })

  it('fecha também na volta com transição', async () => {
    await canalPlugZapi('desconectado')
    await donoV`INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
                VALUES (${TV}, gen_random_uuid(), 'canal_desconectado', 'critico', 'caiu')`
    const r = await vigiarConexaoCanais(sqlV, AGORA_V, canalDePe)
    expect(r.voltou).toBe(1)
    expect(await alertaAberto()).toBe(0)
  })

  /** ⚠️ Canal caído NÃO pode ter o alerta fechado — seria apagar a notícia ruim. */
  it('canal ainda caído mantém o alerta aberto', async () => {
    await canalPlugZapi('desconectado')
    await donoV`INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
                VALUES (${TV}, gen_random_uuid(), 'canal_desconectado', 'critico', 'caiu')`
    await vigiarConexaoCanais(sqlV, AGORA_V)   // credencial falsa = segue caído
    expect(await alertaAberto()).toBe(1)
  })
})
