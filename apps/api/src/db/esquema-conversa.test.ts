import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'

/**
 * Invariantes que a 0012 promete no nível do ESQUEMA.
 *
 * ⚠️ Testados aqui, no banco, e não na aplicação: uma regra que vive só no
 * código é contornada pelo primeiro script de correção rodado à mão numa
 * madrugada. O que o banco recusa, ninguém contorna sem perceber.
 */

// UUIDs exclusivos deste arquivo.
const T = 'e5c0e11a-0000-4000-8000-000000000001'
const PV = 'e5c0e11a-1111-4000-8000-000000000001'
const PLANO = 'e5c0e11a-3333-4000-8000-000000000001'
const MODELO = 'e5c0e11a-4444-4000-8000-000000000001'
const CANAL = 'e5c0e11a-5555-4000-8000-000000000001'
const CONTATO = 'e5c0e11a-6666-4000-8000-000000000001'
const CONVERSA = 'e5c0e11a-7777-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

const uid = (n: number) => `e5c0e11a-8888-4000-8000-${String(n).padStart(12, '0')}`

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-teste-conversa', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-teste-conversa', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja Conversa', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
})

beforeEach(async () => {
  await dono`DELETE FROM midia WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`UPDATE conversa SET atendimento_atual_id = NULL WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`

  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado, capacidades)
             VALUES (${T}, ${CANAL}, 'whatsapp_oficial', 'Loja Centro', 'conectado',
                     '{"janelaHoras":24,"aceitaTemplate":true}'::jsonb)`
  await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${CONTATO}, 'Maria')`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id)
             VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO})`
})

afterAll(async () => {
  await dono`DELETE FROM midia WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem_id_externo WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem WHERE tenant_id = ${T}`
  await dono`UPDATE conversa SET atendimento_atual_id = NULL WHERE tenant_id = ${T}`
  await dono`DELETE FROM atendimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado WHERE tenant_id = ${T}`
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await dono.end()
})

const abrirAtendimento = (id: string, protocolo: number, estado = 'em_atendimento') =>
  dono`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado)
       VALUES (${T}, ${id}, ${CONVERSA}, ${CANAL}, ${protocolo}, ${estado})`

describe('INV-51 — um atendimento aberto por conversa', () => {
  it('⚠️ dado atendimento aberto, quando abrem um segundo, então o banco recusa', async () => {
    await abrirAtendimento(uid(1), 1)
    // Duas vendedoras assumindo o mesmo cliente respondem as duas: o cliente
    // recebe respostas conflitantes e nenhuma delas sabe que a outra está lá.
    await expect(abrirAtendimento(uid(2), 2)).rejects.toThrow(/atendimento_aberto_unico/)
  })

  it('dado o primeiro encerrado, então o segundo abre', async () => {
    await abrirAtendimento(uid(1), 1, 'encerrado')
    await expect(abrirAtendimento(uid(2), 2)).resolves.toBeDefined()
  })

  it('dado protocolo repetido no tenant, então recusa', async () => {
    await abrirAtendimento(uid(1), 7, 'encerrado')
    // O protocolo NUNCA reinicia — é o que o cliente cita no telefone.
    await expect(abrirAtendimento(uid(2), 7)).rejects.toThrow(/protocolo_unico/)
  })
})

describe('INV-38 — dedup de wamid', () => {
  const inserirMensagem = (id: string, criadoEm: Date) =>
    dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, criado_em)
         VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${criadoEm})`

  it('⚠️ dada reentrega cruzando a virada do mês, então ainda recusa o duplicado', async () => {
    const wamid = 'wamid.TESTE123'
    await inserirMensagem(uid(10), new Date('2026-07-20T10:00:00Z'))
    await dono`INSERT INTO mensagem_id_externo (tenant_id, id_externo, mensagem_id, mensagem_criado_em)
               VALUES (${T}, ${wamid}, ${uid(10)}, ${new Date('2026-07-20T10:00:00Z')})`

    // A Meta reentrega semanas depois, já em outro mês — outra partição.
    await inserirMensagem(uid(11), new Date('2026-08-05T10:00:00Z'))
    await expect(
      dono`INSERT INTO mensagem_id_externo (tenant_id, id_externo, mensagem_id, mensagem_criado_em)
           VALUES (${T}, ${wamid}, ${uid(11)}, ${new Date('2026-08-05T10:00:00Z')})`,
    ).rejects.toThrow(/mensagem_id_externo_pkey/)
    // Se a guardiã fosse particionada junto com `mensagem`, a unicidade valeria
    // só dentro do mês e o cliente veria a mesma mensagem duas vezes na thread.
  })
})

describe('Particionamento de mensagem', () => {
  it('dada mensagem com data antiga, então cai na partição de escape', async () => {
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, criado_em)
               VALUES (${T}, ${uid(20)}, ${CONVERSA}, 'entrante', 'texto', '2020-01-05T10:00:00Z')`
    const [m] = await dono<{ p: string }[]>`
      SELECT tableoid::regclass::text AS p FROM mensagem WHERE tenant_id = ${T} AND id = ${uid(20)}`
    // Webhook com data torta não pode derrubar a ingestão inteira.
    expect(m!.p).toBe('mensagem_anterior')
  })

  it('⚠️ garantir_particoes_mensais é idempotente e cria só o mês que falta', async () => {
    // ⚠️ Tabela própria, não `mensagem`: chamar a função sobre o esquema real
    // deixaria partições a mais no banco e o teste passaria ou falharia
    // conforme a ordem de execução.
    await dono`CREATE TABLE p_teste (criado_em timestamptz NOT NULL) PARTITION BY RANGE (criado_em)`
    try {
      const [a] = await dono<{ n: number }[]>`SELECT garantir_particoes_mensais('p_teste', 2, 0) AS n`
      expect(a!.n).toBe(3)   // mês corrente + 2 à frente

      const [b] = await dono<{ n: number }[]>`SELECT garantir_particoes_mensais('p_teste', 2, 0) AS n`
      expect(b!.n).toBe(0)   // idempotente: roda em worker agendado

      // Estender o horizonte cria só o que falta. Sem isso o INSERT falha no
      // dia 1º e o inbox para de receber mensagem.
      const [c] = await dono<{ n: number }[]>`SELECT garantir_particoes_mensais('p_teste', 4, 0) AS n`
      expect(c!.n).toBe(2)
    } finally {
      await dono`DROP TABLE p_teste`
    }
  })
})

describe('FK composta de midia', () => {
  it('dada mídia sem a data da mensagem correta, então recusa', async () => {
    const em = new Date('2026-07-20T10:00:00Z')
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, criado_em)
               VALUES (${T}, ${uid(30)}, ${CONVERSA}, 'entrante', 'audio', ${em})`

    await expect(
      dono`INSERT INTO midia (tenant_id, id, mensagem_id, mensagem_criado_em, chave_objeto, mime)
           VALUES (${T}, ${uid(31)}, ${uid(30)}, ${new Date('2026-07-21T10:00:00Z')}, 'k', 'audio/ogg')`,
    ).rejects.toThrow()

    await expect(
      dono`INSERT INTO midia (tenant_id, id, mensagem_id, mensagem_criado_em, chave_objeto, mime)
           VALUES (${T}, ${uid(32)}, ${uid(30)}, ${em}, 'k', 'audio/ogg')`,
    ).resolves.toBeDefined()
  })
})

describe('FK circular conversa ↔ atendimento', () => {
  it('⚠️ dado conversa e atendimento no MESMO commit, então ambos passam', async () => {
    const conversa2 = uid(40)
    const atendimento2 = uid(41)
    const contato2 = uid(42)

    // Quando a primeira mensagem chega, conversa e atendimento nascem juntos e
    // um referencia o outro. Sem DEFERRABLE não existe ordem de INSERT válida.
    await dono.begin(async (tx) => {
      await tx`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${contato2}, 'Ana')`
      // A conversa aponta para um atendimento que AINDA NÃO EXISTE.
      await tx`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, atendimento_atual_id)
               VALUES (${T}, ${conversa2}, ${CANAL}, ${contato2}, ${atendimento2})`
      await tx`INSERT INTO atendimento (tenant_id, id, conversa_id, canal_id, protocolo, estado)
               VALUES (${T}, ${atendimento2}, ${conversa2}, ${CANAL}, 99, 'em_atendimento')`
    })

    const [c] = await dono<{ atendimento_atual_id: string }[]>`
      SELECT atendimento_atual_id FROM conversa WHERE tenant_id = ${T} AND id = ${conversa2}`
    expect(c!.atendimento_atual_id).toBe(atendimento2)

    await dono`UPDATE conversa SET atendimento_atual_id = NULL WHERE tenant_id = ${T} AND id = ${conversa2}`
    await dono`DELETE FROM atendimento WHERE tenant_id = ${T} AND id = ${atendimento2}`
    await dono`DELETE FROM conversa WHERE tenant_id = ${T} AND id = ${conversa2}`
    await dono`DELETE FROM contato WHERE tenant_id = ${T} AND id = ${contato2}`
  })
})

describe('Coerência de canal e template', () => {
  it('dada pausa de disparo sem motivo, então recusa', async () => {
    // Pausa sem motivo registrado vira mistério na semana seguinte.
    await expect(
      dono`INSERT INTO canal_configuracao (tenant_id, canal_id, disparo_pausado)
           VALUES (${T}, ${CANAL}, true)`,
    ).rejects.toThrow(/canal_pausa_coerente/)
  })

  it('⚠️ dadas duas versões APPROVED do mesmo template, então recusa a segunda', async () => {
    const tpl = uid(50)
    await dono`INSERT INTO template (tenant_id, id, nome, categoria) VALUES (${T}, ${tpl}, 'boas_vindas', 'MARKETING')`
    await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
               VALUES (${T}, ${tpl}, 1, '{}'::jsonb, 'APPROVED')`

    // Duas aprovadas fariam o gateway escolher arbitrariamente qual corpo
    // enviar, e a escolha mudaria entre execuções sem nada aparecer no log.
    await expect(
      dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
           VALUES (${T}, ${tpl}, 2, '{}'::jsonb, 'APPROVED')`,
    ).rejects.toThrow(/template_versao_aprovada/)

    await dono`DELETE FROM template WHERE tenant_id = ${T} AND id = ${tpl}`
  })

  it('dada versão rejeitada sem motivo, então recusa', async () => {
    const tpl = uid(51)
    await dono`INSERT INTO template (tenant_id, id, nome, categoria) VALUES (${T}, ${tpl}, 'promo', 'MARKETING')`
    // "Rejeitado" sem motivo faz a próxima submissão repetir o mesmo erro.
    await expect(
      dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
           VALUES (${T}, ${tpl}, 1, '{}'::jsonb, 'REJECTED')`,
    ).rejects.toThrow(/rejeicao_explicada/)

    await dono`DELETE FROM template WHERE tenant_id = ${T} AND id = ${tpl}`
  })
})
