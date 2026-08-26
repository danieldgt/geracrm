import { describe, it, expect } from 'vitest'
import { foraDoExpediente } from './ausencia.js'

/**
 * A régua do expediente.
 *
 * ⚠️ É aqui que mora o erro caro: uma decisão errada manda resposta automática
 * para o cliente DURANTE o atendimento, ou cala o produto a noite inteira. Por
 * isso a regra é pura e a hora entra pronta (calculada no fuso do tenant pelo
 * banco) — data e fuso em JavaScript são a receita conhecida de errar por uma
 * hora e só descobrir no horário de verão.
 */
const COMERCIAL = {
  seg: { de: '09:00', ate: '18:00' },
  ter: { de: '09:00', ate: '18:00' },
  qua: { de: '09:00', ate: '18:00' },
  qui: { de: '09:00', ate: '18:00' },
  sex: { de: '09:00', ate: '18:00' },
  sab: { de: '09:00', ate: '13:00' },
  dom: null,
}

describe('Dentro e fora do expediente', () => {
  it('meio da tarde de terça está DENTRO', () => {
    expect(foraDoExpediente(COMERCIAL, 2, '14:30')).toBe(false)
  })

  it('dez da noite de terça está FORA', () => {
    expect(foraDoExpediente(COMERCIAL, 2, '22:00')).toBe(true)
  })

  it('domingo (dia fechado) está fora o dia inteiro', () => {
    expect(foraDoExpediente(COMERCIAL, 7, '14:30')).toBe(true)
  })

  it('sábado fecha às 13h — 14h já é fora', () => {
    expect(foraDoExpediente(COMERCIAL, 6, '12:59')).toBe(false)
    expect(foraDoExpediente(COMERCIAL, 6, '14:00')).toBe(true)
  })

  /** ⚠️ A borda: abre às 09:00 significa que 09:00 JÁ é expediente. */
  it('o minuto da abertura já conta como aberto; o do fechamento, não', () => {
    expect(foraDoExpediente(COMERCIAL, 2, '09:00')).toBe(false)
    expect(foraDoExpediente(COMERCIAL, 2, '08:59')).toBe(true)
    expect(foraDoExpediente(COMERCIAL, 2, '18:00')).toBe(true)
  })
})

describe('⚠️ Horário não configurado NÃO é "fechado"', () => {
  /**
   * Assumir fechado mandaria resposta automática 24h por dia para todo tenant
   * que nunca abriu essa tela — e o primeiro a descobrir seria o cliente dele.
   * Quem não declarou expediente não declarou ausência.
   */
  it('sem horário, nunca responde', () => {
    expect(foraDoExpediente(null, 2, '03:00')).toBe(false)
    expect(foraDoExpediente(undefined, 2, '03:00')).toBe(false)
    expect(foraDoExpediente({}, 2, '03:00')).toBe(false)
  })
})

describe('⚠️ Faixa que cruza a meia-noite', () => {
  /**
   * Loja que atende das 22h às 2h existe (delivery, plantão). Sem este ramo, ela
   * seria considerada FECHADA durante o próprio expediente — e mandaria "estamos
   * fechados" para quem está sendo atendido naquele instante.
   */
  const NOTURNO = { seg: null, ter: { de: '22:00', ate: '02:00' }, qua: null, qui: null, sex: null, sab: null, dom: null }

  it('23h está dentro', () => {
    expect(foraDoExpediente(NOTURNO, 2, '23:00')).toBe(false)
  })

  it('01h está dentro', () => {
    expect(foraDoExpediente(NOTURNO, 2, '01:00')).toBe(false)
  })

  it('15h está fora', () => {
    expect(foraDoExpediente(NOTURNO, 2, '15:00')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ PRESENÇA DO ATENDENTE — contra o banco, porque a regra vive em SQL.
//
// A versão anterior perguntava só se HAVIA atendimento aberto com atendente,
// sem prazo. Em produção (26/ago) uma conversa assumida em 12/ago e esquecida
// fez o cliente escrever 14 dias depois e não receber nada. O sintoma era
// silêncio: ninguém no CRM descobria que tinha deixado de responder.
//
// ⚠️ O truque para testar sem tocar a REDE: deixar uma resposta de ausência
//    recente na conversa. Assim, quando a presença NÃO barra, o desfecho é
//    `ja_respondida` — que prova que passou pela checagem sem chegar ao envio.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { responderAusencia } from './ausencia.js'
import { encerrarBanco } from '../../db/index.js'

const TA = 'a0525000-0000-4000-8000-000000000001'
const PVA = 'a0525000-1111-4000-8000-000000000001'
const PLANOA = 'a0525000-3333-4000-8000-000000000001'
const MODELOA = 'a0525000-4444-4000-8000-000000000001'
const CANALA = 'a0525000-5555-4000-8000-000000000001'
const CONTATOA = 'a0525000-6666-4000-8000-000000000001'
const CONVERSAA = 'a0525000-7777-4000-8000-000000000001'
const ATENDA = 'a0525000-9999-4000-8000-000000000001'
const UA = 'a0525000-8888-4000-8000-000000000001'

const donoA = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/** ⚠️ Todos os dias FECHADOS: o teste vale a qualquer hora que a suíte rode. */
const SEMPRE_FECHADO = {
  seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null,
}

beforeAll(async () => {
  await donoA`INSERT INTO plano (id, codigo, nome) VALUES (${PLANOA}, 'plano-ausencia', 'Pro') ON CONFLICT DO NOTHING`
  await donoA`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELOA}, 'modelo-ausencia', 'Varejo') ON CONFLICT DO NOTHING`
  await donoA.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${TA}, 'Loja Ausência', ${PLANOA}, ${PVA}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${TA}, ${PVA}, ${MODELOA}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await donoA`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
              VALUES (${TA}, ${CANALA}, 'whatsapp_nao_oficial', 'plugzapi', 'WA', 'conectado') ON CONFLICT DO NOTHING`
  await donoA`INSERT INTO contato (tenant_id, id, nome, origem_carga, ativo)
              VALUES (${TA}, ${CONTATOA}, 'Cliente', 'teste', true) ON CONFLICT DO NOTHING`
  await donoA`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao)
              VALUES (${TA}, ${CONVERSAA}, ${CANALA}, ${CONTATOA}, 0) ON CONFLICT DO NOTHING`
  await donoA`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email)
              VALUES (${TA}, ${UA}, 'sub-ausencia', 'Ana', 'ana@ausencia.local') ON CONFLICT (cognito_sub) DO NOTHING`
  await donoA`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento, mensagem_ausencia)
              VALUES (${TA}, ${CANALA}, ${donoA.json(SEMPRE_FECHADO)}, 'Estamos fechados.')
              ON CONFLICT (tenant_id, canal_id) DO UPDATE
                SET horario_atendimento = EXCLUDED.horario_atendimento,
                    mensagem_ausencia = EXCLUDED.mensagem_ausencia`
})

beforeEach(async () => {
  await donoA`DELETE FROM mensagem    WHERE tenant_id = ${TA}`
  await donoA`DELETE FROM atendimento WHERE tenant_id = ${TA}`
})

afterAll(async () => {
  await donoA`DELETE FROM mensagem            WHERE tenant_id = ${TA}`
  await donoA`DELETE FROM atendimento         WHERE tenant_id = ${TA}`
  await donoA`DELETE FROM canal_configuracao  WHERE tenant_id = ${TA}`
  await donoA`DELETE FROM conversa            WHERE tenant_id = ${TA}`
  await donoA`DELETE FROM contato             WHERE tenant_id = ${TA}`
  await donoA`DELETE FROM usuario             WHERE tenant_id = ${TA}`
  await donoA`DELETE FROM canal_conectado     WHERE tenant_id = ${TA}`
  await donoA`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${TA}`
  await donoA`DELETE FROM perfil_vertical     WHERE tenant_id = ${TA}`
  await donoA`DELETE FROM tenant              WHERE id = ${TA}`
  await donoA`DELETE FROM plano               WHERE id = ${PLANOA}`
  await donoA`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELOA}`
  await donoA.end()
  await encerrarBanco()
})

/** Atendimento aberto, assumido há `diasAtras` dias. */
const assumirHa = (diasAtras: number) => donoA`
  INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, atendente_id, estado, assumido_em)
  VALUES (${TA}, ${ATENDA}, ${CONVERSAA}, ${CANALA}, 1, ${UA}, 'em_atendimento',
          now() - make_interval(days => ${diasAtras}))`

/** Uma resposta de ausência recente — a sentinela que evita o envio de rede. */
const ausenciaRecente = () => donoA`
  INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
  VALUES (${TA}, gen_random_uuid(), ${CONVERSAA}, 'saliente', 'texto',
          '{"texto":"Estamos fechados.","automatica":"ausencia"}'::jsonb, now() - interval '10 minutes')`

/** Mensagem saliente com autor = pessoa digitou. Sem autor = sistema disparou. */
const salienteHaMinutos = (minutos: number, autor: string | null) => donoA`
  INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, enviada_por_id, criado_em)
  VALUES (${TA}, gen_random_uuid(), ${CONVERSAA}, 'saliente', 'texto',
          '{"texto":"oi"}'::jsonb, ${autor},
          now() - make_interval(mins => ${minutos}))`

describe('⚠️ Assunção esquecida NÃO é presença', () => {
  it('assumida há 14 dias e sem ninguém digitando: a ausência responde', async () => {
    await assumirHa(14)
    await ausenciaRecente()
    // `ja_respondida` prova que passou da checagem de presença — o caso do
    // Romulo, que antes devolvia "assumida" e calava para sempre.
    expect(await responderAusencia(TA, CONVERSAA, CANALA)).toBe('ja_respondida')
  })

  it('acabou de assumir e ainda não digitou: está chegando, não responde', async () => {
    await assumirHa(0)
    await ausenciaRecente()
    expect(await responderAusencia(TA, CONVERSAA, CANALA)).toBe('atendente_presente')
  })

  it('assumida há 14 dias, mas a pessoa respondeu há 5 min: está ali', async () => {
    await assumirHa(14)
    await salienteHaMinutos(5, UA)
    await ausenciaRecente()
    expect(await responderAusencia(TA, CONVERSAA, CANALA)).toBe('atendente_presente')
  })

  it('atividade humana velha (3 h) não segura mais a ausência', async () => {
    await assumirHa(14)
    await salienteHaMinutos(180, UA)
    await ausenciaRecente()
    expect(await responderAusencia(TA, CONVERSAA, CANALA)).toBe('ja_respondida')
  })

  /**
   * ⚠️ Disparo de campanha sai SEM autor. Sem este filtro, uma campanha enviada
   * ao contato faria o produto achar que havia atendente na mesa e calar a
   * ausência por uma hora — trocando um robô por outro.
   */
  it('mensagem do SISTEMA (sem autor) não conta como presença', async () => {
    await assumirHa(14)
    await salienteHaMinutos(5, null)
    await ausenciaRecente()
    expect(await responderAusencia(TA, CONVERSAA, CANALA)).toBe('ja_respondida')
  })

  it('sem atendimento nenhum, segue respondendo', async () => {
    await ausenciaRecente()
    expect(await responderAusencia(TA, CONVERSAA, CANALA)).toBe('ja_respondida')
  })
})
