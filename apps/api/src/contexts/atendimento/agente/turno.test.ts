import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { conduzirTurno } from './turno.js'
import { encerrarBanco } from '../../../db/index.js'
import type { PortaLlm, PropostaDeTurno, ResultadoLlm } from './porta.js'

/**
 * ⚠️ O orquestrador é onde as peças se encontram — e onde um engano manda a
 * coisa errada para o cliente de alguém, fora do expediente, sem ninguém
 * olhando. O modelo e o WhatsApp são falsos aqui: o que se testa é a COREOGRAFIA.
 */
const T = 'a9710000-0000-4000-8000-000000000001'
const PV = 'a9710000-1111-4000-8000-000000000001'
const PLANO = 'a9710000-3333-4000-8000-000000000001'
const MODELO = 'a9710000-4444-4000-8000-000000000001'
const CANAL = 'a9710000-5555-4000-8000-000000000001'
const CONTATO = 'a9710000-6666-4000-8000-000000000001'
const CONVERSA = 'a9710000-7777-4000-8000-000000000001'
const USUARIO = 'a9710000-8888-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/** ⚠️ Todos os dias fechados: o teste vale a qualquer hora que a suíte rode. */
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }

function llmFalso(proposta: Partial<PropostaDeTurno>, falha?: string): PortaLlm {
  return {
    nome: 'falso',
    capacidades: { saidaEstruturada: true, instrucaoDeSistema: true },
    async conversar(): Promise<ResultadoLlm<PropostaDeTurno>> {
      if (falha) return { ok: false, motivo: falha as never }
      return {
        ok: true,
        dados: {
          texto: 'Oi! Você compra para revenda?', proximoPasso: 'continuar',
          motivo: '', extraidoBruto: {}, ...proposta,
        },
        custo: { tokensEntrada: 100, tokensSaida: 20, modelo: 'falso' },
      }
    },
  }
}

/** WhatsApp falso: aceita tudo e guarda o que sairia. */
const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true }
}) as never

const turno = (llm: PortaLlm) => conduzirTurno(T, CONVERSA, CANAL, new Date(), { llm, enviar: enviarFalso })

const sessao = async () => {
  const [s] = await dono<{ estado: string; turnos: number; motivo_saida: string | null; extraido: unknown; descartados: unknown[] }[]>`
    SELECT estado, turnos, motivo_saida, extraido, descartados FROM agente_sessao
     WHERE tenant_id = ${T} AND conversa_id = ${CONVERSA} ORDER BY iniciada_em DESC LIMIT 1`
  return s ?? null
}

const ausenciaHa = (minutos: number) => dono`
  INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
  VALUES (${T}, gen_random_uuid(), ${CONVERSA}, 'saliente', 'texto',
          '{"texto":"Voltamos às 9h.","automatica":"ausencia"}'::jsonb,
          now() - make_interval(mins => ${minutos}))`

const ligarAgente = (ativo: boolean, maxTurnos = 6) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, politicas, max_turnos)
  VALUES (${T}, ${CANAL}, ${ativo}, 'Entrega em 3 dias. Pagamento por PIX.', ${maxTurnos})
  ON CONFLICT (tenant_id, canal_id) DO UPDATE
    SET ativo = EXCLUDED.ativo, max_turnos = EXCLUDED.max_turnos`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-turno-agente', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-turno-agente', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja Turno', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo, qtd_vendas)
             VALUES (${T}, ${CONTATO}, 'Bruno', 'teste', true, 0) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao)
             VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 0) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento, mensagem_ausencia)
             VALUES (${T}, ${CANAL}, ${dono.json(SEMPRE_FECHADO)}, 'Voltamos às 9h.')
             ON CONFLICT (tenant_id, canal_id) DO UPDATE SET horario_atendimento = EXCLUDED.horario_atendimento`
})

beforeEach(async () => {
  enviados.length = 0
  await dono`DELETE FROM agente_sessao WHERE tenant_id = ${T}`
  await dono`DELETE FROM agente_config WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem      WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento   WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM agente_sessao      WHERE tenant_id = ${T}`
  await dono`DELETE FROM agente_config      WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem           WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento        WHERE tenant_id = ${T}`
  // ⚠️ Depois do atendimento, que aponta para ele.
  await dono`DELETE FROM usuario            WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa           WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato            WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado    WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical    WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant             WHERE id = ${T}`
  await dono`DELETE FROM plano              WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
  await encerrarBanco()
})

describe('⚠️ Quem não devia falar, não fala', () => {
  it('sem configuração nenhuma, o agente está desligado', async () => {
    await ausenciaHa(5)
    expect(await turno(llmFalso({}))).toEqual({ falou: false, motivo: 'agente_desligado' })
    expect(enviados).toEqual([])
  })

  it('ligado mas sem ausência antes: espera a próxima mensagem', async () => {
    await ligarAgente(true)
    expect(await turno(llmFalso({}))).toEqual({ falou: false, motivo: 'sem_ausencia_antes' })
    expect(enviados).toEqual([])
  })

  /** ⚠️ Ausência de ontem não serve de gatilho para hoje. */
  it('ausência velha (13 h) não abre a porta', async () => {
    await ligarAgente(true)
    await ausenciaHa(13 * 60)
    expect((await turno(llmFalso({}))).falou).toBe(false)
  })

  it('desligar cala o agente mesmo com sessão em curso', async () => {
    await ligarAgente(true); await ausenciaHa(5)
    await turno(llmFalso({}))
    await ligarAgente(false)
    expect(await turno(llmFalso({}))).toEqual({ falou: false, motivo: 'agente_desligado' })
    expect(enviados).toHaveLength(1)   // só o primeiro turno saiu
  })
})

describe('Conduzindo a conversa', () => {
  beforeEach(async () => { await ligarAgente(true); await ausenciaHa(5) })

  it('primeiro turno abre sessão e fala', async () => {
    expect(await turno(llmFalso({}))).toEqual({ falou: true, encerrouPor: null })
    expect(enviados).toEqual(['Oi! Você compra para revenda?'])
    expect(await sessao()).toMatchObject({ estado: 'ativa', turnos: 1 })
  })

  it('o segundo turno soma, sem abrir outra sessão', async () => {
    await turno(llmFalso({}))
    await turno(llmFalso({}))
    expect(await sessao()).toMatchObject({ turnos: 2 })
    const [c] = await dono<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agente_sessao WHERE tenant_id = ${T}`
    expect(c!.n).toBe(1)
  })

  it('guarda o que extraiu, validado', async () => {
    await turno(llmFalso({ extraidoBruto: { tipoCompra: 'revenda', cidade: 'Boa Vista' } }))
    expect((await sessao())?.extraido).toMatchObject({ tipoCompra: 'revenda', cidade: 'Boa Vista' })
  })

  /** ⚠️ A medida da alucinação fica registrada, não some. */
  it('o que o modelo inventou entra em descartados, com motivo', async () => {
    await turno(llmFalso({ extraidoBruto: { cnpj: '11.222.333/0001-99' } }))
    const s = await sessao()
    expect(s?.extraido).toMatchObject({ cnpj: null })
    expect(s?.descartados).toEqual([
      { campo: 'cnpj', valor: '11.222.333/0001-99', motivo: 'dígito verificador não confere' },
    ])
  })
})

describe('⚠️ Saídas: sempre com motivo registrado', () => {
  beforeEach(async () => { await ligarAgente(true); await ausenciaHa(5) })

  it('entregar ao humano encerra a sessão com o motivo', async () => {
    const r = await turno(llmFalso({ proximoPasso: 'entregar', motivo: 'pediu falar com alguém' }))
    expect(r).toEqual({ falou: true, encerrouPor: 'pediu falar com alguém' })
    expect(await sessao()).toMatchObject({ estado: 'entregue', motivo_saida: 'pediu falar com alguém' })
  })

  /** ⚠️ Encerrada não recomeça: o robô não ressuscita depois de entregar. */
  it('depois de entregue, não abre outra sessão', async () => {
    await turno(llmFalso({ proximoPasso: 'entregar', motivo: 'x' }))
    expect(await turno(llmFalso({}))).toEqual({ falou: false, motivo: 'sessao_ja_encerrada' })
  })

  it('modelo fora do ar não fala e encerra com o motivo do fornecedor', async () => {
    await turno(llmFalso({}))                        // abre a sessão
    const r = await turno(llmFalso({}, 'indisponivel'))
    expect(r).toEqual({ falou: false, motivo: 'modelo_falhou' })
    expect(await sessao()).toMatchObject({ estado: 'entregue', motivo_saida: 'modelo falhou: indisponivel' })
    expect(enviados).toHaveLength(1)                 // nada saiu no turno que falhou
  })

  /**
   * ⚠️ Sem isto a sessão ficaria aberta para sempre e a conversa nunca chegaria
   * ao humano — o cliente conversando com um robô que já desistiu.
   */
  it('bater no teto encerra com motivo', async () => {
    await ligarAgente(true, 1)
    await turno(llmFalso({}))                        // turno 1, no teto
    const r = await turno(llmFalso({}))
    expect(r).toEqual({ falou: false, motivo: 'teto_de_turnos' })
    expect(await sessao()).toMatchObject({ estado: 'entregue', motivo_saida: 'teto de turnos sem qualificar' })
  })
})

describe('⚠️ Atendente presente cala o agente', () => {
  it('com humano na conversa, o robô não fala', async () => {
    await ligarAgente(true); await ausenciaHa(5)
    await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
               VALUES (${T}, ${USUARIO}, 'sub-turno-agente', 'Ana', 'ana@turno.local') ON CONFLICT (cognito_sub) DO NOTHING`
    await dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
               VALUES (${T}, gen_random_uuid(), ${CONVERSA}, ${CANAL}, 1, ${USUARIO}, 'em_atendimento', now())`
    expect(await turno(llmFalso({}))).toEqual({ falou: false, motivo: 'atendente_presente' })
    expect(enviados).toEqual([])
  })
})
