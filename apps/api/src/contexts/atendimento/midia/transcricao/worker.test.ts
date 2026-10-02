import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { encerrarBanco } from '../../../../db/index.js'
import { processarTranscricoes, MAX_TENTATIVAS_TRANSCRICAO, type DepsTranscricao } from '../../../../workers/transcricao.js'
import type { PortaTranscricao, ResultadoTranscricao } from './porta.js'
import { TranscricaoIndisponivel } from './porta.js'

/**
 * O worker de transcrição (R5): pega áudio entrante sem transcrição, grava o
 * texto, avisa a tela (payload só com ids) e REAGENDA o turno do agente; falha
 * conta tentativa com espera e desiste no teto. Banco real; provedor falso.
 */
const T = 'e9000000-0000-4000-8000-000000000001'
const PV = 'e9000000-1111-4000-8000-000000000001'
const PLANO = 'e9000000-3333-4000-8000-000000000001'
const MODELO = 'e9000000-4444-4000-8000-000000000001'
const CANAL = 'e9000000-5555-4000-8000-000000000001'
const CONTATO = 'e9000000-6666-4000-8000-000000000001'
const CONVERSA = 'e9000000-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/** ⚠️ O worker varre TODOS os tenants; o banco de teste é compartilhado entre
 *  arquivos em paralelo, então a passada aqui é restrita a este tenant. */
const passada = (deps: Omit<DepsTranscricao, 'somenteTenant'>, agora?: Date) =>
  processarTranscricoes(dono as never, { ...deps, somenteTenant: T }, agora)

const portaQue = (r: ResultadoTranscricao, registro?: string[]): PortaTranscricao => ({
  nome: 'falsa', capacidades: { transcreve: true },
  async transcrever(a) { registro?.push(a.mime); return r },
})
const baixarFalso = (async () => ({ bytes: Buffer.from([1, 2, 3]), mime: 'audio/ogg' })) as never
const baixarQueFalha = (async () => null) as never

const audio = async (ref = 'https://provedor.exemplo/voz.ogg', extra: Record<string, unknown> = {}, criadoEm = new Date()): Promise<string> => {
  const id = randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'audio', ${JSON.stringify({ audio: ref, mime: 'audio/ogg', ...extra })}::text::jsonb, ${criadoEm})`
  return id
}
const conteudo = async (id: string) => (await dono<{ conteudo: Record<string, unknown> }[]>`SELECT conteudo FROM mensagem WHERE tenant_id = ${T} AND id = ${id}`)[0]!.conteudo
const configurar = (modo: string) => dono`
  INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
  VALUES (${T}, ${CANAL}, ${modo !== 'desligado'}, ${modo}, 'Entrega em 3 dias.', false, false, '{"nome":"Lia","loja":"Loja"}'::jsonb, '{}'::jsonb)
  ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = EXCLUDED.modo, ativo = EXCLUDED.ativo`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-transcricao', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-transcricao', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${T}, 'Transcrição', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${T}, ${CONTATO}, 'Cliente', true) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
})
beforeEach(async () => {
  await dono`DELETE FROM agente_tarefa WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox WHERE tenant_id = ${T}`
  await configurar('sombra')
})
afterAll(async () => {
  for (const t of ['agente_tarefa', 'agente_config', 'mensagem', 'outbox', 'conversa', 'contato', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  }
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await encerrarBanco(); await dono.end()
})

describe('Worker de transcrição', () => {
  it('dado áudio entrante sem transcrição, quando passa, então grava o texto, avisa a tela só com ids e reagenda o agente', async () => {
    const id = await audio()
    const mimes: string[] = []
    const r = await passada({ porta: portaQue({ ok: true, texto: 'quero duas verdes', idioma: 'pt', duracaoS: 3 }, mimes), baixar: baixarFalso })
    expect(r).toMatchObject({ candidatas: 1, transcritas: 1, falhas: 0, reagendouAgente: 1 })
    expect(mimes).toEqual(['audio/ogg'])

    const c = await conteudo(id)
    expect(c).toMatchObject({ audio: 'https://provedor.exemplo/voz.ogg', transcricao: 'quero duas verdes', transcricao_idioma: 'pt', transcricao_duracao_s: 3 })
    expect(typeof c['transcricao_em']).toBe('string')

    const [conv] = await dono<{ versao: string }[]>`SELECT versao FROM conversa WHERE tenant_id = ${T} AND id = ${CONVERSA}`
    expect(Number(conv!.versao)).toBeGreaterThan(1)
    const [ev] = await dono<{ tipo: string; payload: Record<string, unknown> }[]>`SELECT tipo, payload FROM outbox WHERE tenant_id = ${T} ORDER BY id DESC LIMIT 1`
    expect(ev!.tipo).toBe('mensagem.transcrita')
    expect(ev!.payload).toEqual({ conversaId: CONVERSA, mensagemId: id, versao: expect.any(Number) })
    expect(JSON.stringify(ev!.payload)).not.toContain('quero')

    const [t] = await dono<{ estado: string; mensagens_ids: string[] }[]>`SELECT estado, mensagens_ids FROM agente_tarefa WHERE tenant_id = ${T}`
    expect(t).toMatchObject({ estado: 'pendente', mensagens_ids: [id] })

    // Já transcrita: não é candidata de novo.
    const r2 = await passada({ porta: portaQue({ ok: true, texto: 'x' }), baixar: baixarFalso })
    expect(r2.candidatas).toBe(0)
  })

  it('agente desligado → transcreve, mas não agenda turno', async () => {
    await configurar('desligado')
    const id = await audio()
    const r = await passada({ porta: portaQue({ ok: true, texto: 'oi' }), baixar: baixarFalso })
    expect(r).toMatchObject({ transcritas: 1, reagendouAgente: 0 })
    expect((await conteudo(id))['transcricao']).toBe('oi')
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM agente_tarefa WHERE tenant_id = ${T}`
    expect(n!.n).toBe(0)
  })

  it('provedor fora → conta tentativa, espera antes de tentar de novo e desiste no teto', async () => {
    const id = await audio()
    const agora = new Date()
    const fora = portaQue({ ok: false, motivo: 'indisponivel', detalhe: 'HTTP 503' })

    const r1 = await passada({ porta: fora, baixar: baixarFalso }, agora)
    expect(r1).toMatchObject({ candidatas: 1, falhas: 1 })
    expect(await conteudo(id)).toMatchObject({ transcricao_tentativas: 1, transcricao_erro: 'indisponivel' })

    // Mesmo instante: ainda em espera, não é candidata.
    const r2 = await passada({ porta: fora, baixar: baixarFalso }, agora)
    expect(r2.candidatas).toBe(0)

    // Passou a espera: tenta de novo, até o teto.
    for (let i = 2; i <= MAX_TENTATIVAS_TRANSCRICAO; i++) {
      const depois = new Date(agora.getTime() + i * 10 * 60_000)
      const r = await passada({ porta: fora, baixar: baixarFalso }, depois)
      expect(r.candidatas).toBe(1)
      expect((await conteudo(id))['transcricao_tentativas']).toBe(i)
    }
    const muitoDepois = new Date(agora.getTime() + 24 * 3_600_000)
    const rFim = await passada({ porta: portaQue({ ok: true, texto: 'tarde demais' }), baixar: baixarFalso }, muitoDepois)
    expect(rFim.candidatas).toBe(0)
    expect((await conteudo(id))['transcricao']).toBeUndefined()
  })

  it('formato que o provedor não entende desiste na hora (tentar de novo não conserta)', async () => {
    const id = await audio()
    await passada({ porta: portaQue({ ok: false, motivo: 'formato' }), baixar: baixarFalso })
    expect(await conteudo(id)).toMatchObject({ transcricao_tentativas: MAX_TENTATIVAS_TRANSCRICAO, transcricao_erro: 'formato' })
  })

  it('download que falha conta como tentativa — a mensagem continua tocável', async () => {
    const id = await audio()
    const r = await passada({ porta: portaQue({ ok: true, texto: 'x' }), baixar: baixarQueFalha })
    expect(r).toMatchObject({ falhas: 1, transcritas: 0 })
    expect(await conteudo(id)).toMatchObject({ audio: 'https://provedor.exemplo/voz.ogg', transcricao_tentativas: 1, transcricao_erro: 'download' })
  })

  it('transcrição bem-sucedida depois de uma falha limpa o erro', async () => {
    const id = await audio()
    const agora = new Date()
    await passada({ porta: portaQue({ ok: false, motivo: 'indisponivel' }), baixar: baixarFalso }, agora)
    await passada({ porta: portaQue({ ok: true, texto: 'agora foi' }), baixar: baixarFalso }, new Date(agora.getTime() + 10 * 60_000))
    const c = await conteudo(id)
    expect(c['transcricao']).toBe('agora foi')
    expect(c['transcricao_erro']).toBeUndefined()
    expect(c['transcricao_tentada_em']).toBeUndefined()
  })

  it('o mais recente primeiro, 5 por passada', async () => {
    const base = Date.now()
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push(await audio(undefined, {}, new Date(base - (7 - i) * 1000)))
    const r = await passada({ porta: portaQue({ ok: true, texto: 't' }), baixar: baixarFalso })
    expect(r.candidatas).toBe(5)
    expect((await conteudo(ids[6]!))['transcricao']).toBe('t')
    expect((await conteudo(ids[0]!))['transcricao']).toBeUndefined()
  })

  it('sem provedor configurado a passada não faz nada', async () => {
    await audio()
    const r = await passada({ porta: TranscricaoIndisponivel, baixar: baixarFalso })
    expect(r).toEqual({ candidatas: 0, transcritas: 0, falhas: 0, reagendouAgente: 0 })
  })
})
