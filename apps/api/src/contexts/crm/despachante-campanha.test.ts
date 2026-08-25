import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import {
  despacharCampanhasDoTenant, type EnviarCampanha,
} from './despachante-campanha.js'
import { enviarTextoParaContato } from '../atendimento/envio-conversa.js'
import type { Sql } from '../../db/index.js'

/**
 * Despachante de campanha.
 *
 * ⚠️ Duas coisas precisam ficar guardadas aqui, e as duas são de negócio, não de
 * mecânica: (1) recusa NOSSA não pode virar "falhou" — senão uma retentativa
 * futura manda para quem pediu para não receber; (2) o teto de aquecimento tem
 * de PARAR a campanha no meio, sem marcá-la como concluída.
 *
 * O envio entra por parâmetro (padrão da casa): o caminho feliz roda sem falar
 * com provedor nenhum.
 */

const T = 'ca9d0000-0000-4000-8000-000000000001'
const PV = 'ca9d0000-1111-4000-8000-000000000001'
const PLANO = 'ca9d0000-3333-4000-8000-000000000001'
const MODELO = 'ca9d0000-4444-4000-8000-000000000001'
const CANAL = 'ca9d0000-7777-4000-8000-000000000001'
const CONTATOS = [1, 2, 3].map((n) => `ca9d0000-6666-4000-8000-00000000000${n}`)

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const sql = dono as unknown as Sql
const AGORA = new Date('2026-08-25T14:00:00Z')

/** Envio falso: registra as chamadas e devolve o resultado combinado. */
function envioFalso(
  resultado: (contatoId: string) => Awaited<ReturnType<EnviarCampanha>>,
): { enviar: EnviarCampanha; chamadas: string[] } {
  const chamadas: string[] = []
  const enviar: EnviarCampanha = async (_t, _canal, contatoId) => {
    chamadas.push(contatoId)
    return resultado(contatoId)
  }
  return { enviar, chamadas }
}

const ok = () => ({ ok: true as const, conversaId: randomUUID(), mensagemId: randomUUID() })

async function novaCampanha(quantos: number): Promise<string> {
  const id = randomUUID()
  await dono`INSERT INTO campanha (tenant_id, id, nome, mensagem, canal_id, estado, disparada_em)
             VALUES (${T}, ${id}, 'Volta!', 'Oi, temos novidade', ${CANAL}, 'disparando', now())`
  for (const c of CONTATOS.slice(0, quantos)) {
    await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id)
               VALUES (${T}, ${randomUUID()}, ${id}, ${c})`
  }
  return id
}

/**
 * Consome `n` do teto de hoje com envios já feitos.
 *
 * ⚠️ Cada linha precisa de um contato DIFERENTE: `campanha_envio_unico` é
 * (tenant, campanha, contato) — a invariante que garante que ninguém recebe a
 * mesma campanha duas vezes. Repetir o contato aqui esbarra nela, e foi
 * exatamente o que a primeira versão deste teste fez.
 */
async function consumirCota(n: number): Promise<void> {
  const gasto = randomUUID()
  await dono`INSERT INTO campanha (tenant_id, id, nome, mensagem, canal_id, estado)
             VALUES (${T}, ${gasto}, 'Anterior', 'x', ${CANAL}, 'concluida')`
  for (let i = 0; i < n; i++) {
    const contato = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${contato}, ${'Cota ' + i})`
    await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id, estado, enviado_em)
               VALUES (${T}, ${randomUUID()}, ${gasto}, ${contato}, 'enviado', ${AGORA})`
  }
}

const estados = (campanhaId: string) => dono<{ estado: string; n: number }[]>`
  SELECT estado, count(*)::int AS n FROM campanha_envio
   WHERE tenant_id = ${T} AND campanha_id = ${campanhaId} GROUP BY estado ORDER BY estado`

const estadoDaCampanha = (id: string) => dono<{ estado: string }[]>`
  SELECT estado FROM campanha WHERE tenant_id = ${T} AND id = ${id}`.then((r) => r[0]!.estado)

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-desp-camp', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-desp-camp', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${T}, 'Loja', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'Vendas', 'conectado')
             ON CONFLICT DO NOTHING`
  for (const [i, c] of CONTATOS.entries()) {
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${c}, ${'Cliente ' + i}) ON CONFLICT DO NOTHING`
  }
  // Só o primeiro tem telefone — é o que exercita o caminho REAL do gateway.
  await dono`INSERT INTO contato_telefone
               (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
             VALUES (${T}, ${CONTATOS[0]!}, 1, '+5581988887777', '558188887777', true, true, 'teste')
             ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  await dono`DELETE FROM campanha_envio    WHERE tenant_id = ${T}`
  await dono`DELETE FROM campanha          WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_aquecimento WHERE tenant_id = ${T}`
})

afterAll(async () => {
  await dono`DELETE FROM campanha_envio    WHERE tenant_id = ${T}`
  await dono`DELETE FROM campanha          WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_aquecimento WHERE tenant_id = ${T}`
  await dono`DELETE FROM mensagem          WHERE tenant_id = ${T}`
  await dono`DELETE FROM conversa          WHERE tenant_id = ${T}`
  await dono`DELETE FROM outbox            WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_conectado   WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato_telefone  WHERE tenant_id = ${T}`
  await dono`DELETE FROM contato           WHERE tenant_id = ${T}`
  await dono.end()
})

describe('A fila deixa de ficar parada', () => {
  it('envia os pendentes e conclui a campanha', async () => {
    const id = await novaCampanha(3)
    const { enviar, chamadas } = envioFalso(() => ok())

    const r = await despacharCampanhasDoTenant(sql, T, AGORA, enviar)

    expect(r.enviados).toBe(3)
    expect(chamadas).toHaveLength(3)
    expect(await estados(id)).toEqual([{ estado: 'enviado', n: 3 }])
    expect(await estadoDaCampanha(id)).toBe('concluida')
  })

  it('guarda o id da mensagem em cada envio — é o elo com a thread', async () => {
    const id = await novaCampanha(1)
    await despacharCampanhasDoTenant(sql, T, AGORA, envioFalso(() => ok()).enviar)

    const [e] = await dono<{ mensagem_id: string | null }[]>`
      SELECT mensagem_id FROM campanha_envio WHERE tenant_id = ${T} AND campanha_id = ${id}`
    expect(e!.mensagem_id).not.toBeNull()
  })

  it('a segunda passada não reenvia o que já saiu', async () => {
    await novaCampanha(2)
    await despacharCampanhasDoTenant(sql, T, AGORA, envioFalso(() => ok()).enviar)

    const segunda = envioFalso(() => ok())
    const r = await despacharCampanhasDoTenant(sql, T, AGORA, segunda.enviar)

    expect(r.enviados).toBe(0)
    expect(segunda.chamadas).toHaveLength(0)
  })
})

describe('⚠️ Recusa nossa NÃO é falha de transporte', () => {
  /**
   * Colapsar as duas faria uma retentativa futura mandar para quem pediu para
   * não receber — e opt-out é invariante, não filtro.
   */
  it('recusa do gateway vira "bloqueado"', async () => {
    const id = await novaCampanha(2)
    const { enviar } = envioFalso(() => ({ ok: false as const, classe: 'recusa' as const, motivo: 'bloqueado' }))

    const r = await despacharCampanhasDoTenant(sql, T, AGORA, enviar)

    expect(r.bloqueados).toBe(2)
    expect(r.falhas).toBe(0)
    expect(await estados(id)).toEqual([{ estado: 'bloqueado', n: 2 }])
  })

  it('falha do provedor vira "falhou"', async () => {
    const id = await novaCampanha(1)
    const { enviar } = envioFalso(() => ({ ok: false as const, classe: 'transporte' as const, motivo: 'timeout' }))

    const r = await despacharCampanhasDoTenant(sql, T, AGORA, enviar)

    expect(r.falhas).toBe(1)
    expect(await estados(id)).toEqual([{ estado: 'falhou', n: 1 }])
  })

  it('contato sem telefone é bloqueado, não derruba o resto da fila', async () => {
    const id = await novaCampanha(3)
    const semTelefone = CONTATOS[1]!
    const { enviar } = envioFalso((c) =>
      c === semTelefone
        ? { ok: false as const, classe: 'alvo' as const, motivo: 'sem_telefone_ou_canal' }
        : ok())

    const r = await despacharCampanhasDoTenant(sql, T, AGORA, enviar)

    expect(r.enviados).toBe(2)
    expect(r.bloqueados).toBe(1)
    expect(await estadoDaCampanha(id)).toBe('concluida')
  })
})

describe('⚠️ O aquecimento manda no volume do dia', () => {
  /**
   * O teto diário do número não-oficial é o que separa "campanha" de "número
   * banido" (ADR-021). Estourado o teto, a campanha PARA — e não pode ser
   * marcada como concluída, senão o resto da audiência nunca recebe.
   */
  it('teto do dia esgotado: não envia, e a campanha continua disparando', async () => {
    const id = await novaCampanha(3)
    // Dia 0 do aquecimento: teto 20. Consome os 20 com envios de hoje.
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em, ativo)
               VALUES (${T}, ${CANAL}, ${AGORA}, true)`
    await consumirCota(20)

    const { enviar, chamadas } = envioFalso(() => ok())
    const r = await despacharCampanhasDoTenant(sql, T, AGORA, enviar)

    expect(chamadas).toHaveLength(0)
    expect(r.aguardandoAquecimento).toBe(3)
    // ⚠️ NÃO conclui: o resto da audiência recebe amanhã.
    expect(await estadoDaCampanha(id)).toBe('disparando')
  })

  it('teto parcial envia só o que cabe e deixa o resto para depois', async () => {
    const id = await novaCampanha(3)
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em, ativo)
               VALUES (${T}, ${CANAL}, ${AGORA}, true)`
    await consumirCota(18)   // sobram 2 do teto de 20

    const r = await despacharCampanhasDoTenant(sql, T, AGORA, envioFalso(() => ok()).enviar)

    expect(r.enviados).toBe(2)
    expect(await estadoDaCampanha(id)).toBe('disparando')
    const porEstado = await estados(id)
    expect(porEstado).toEqual([{ estado: 'enviado', n: 2 }, { estado: 'pendente', n: 1 }])
  })

  it('número sem aquecimento não tem teto', async () => {
    await novaCampanha(3)
    const r = await despacharCampanhasDoTenant(sql, T, AGORA, envioFalso(() => ok()).enviar)
    expect(r.enviados).toBe(3)
  })
})

describe('Cadastro incompleto', () => {
  /**
   * ⚠️ Campanha sem canal não tem por onde sair. Concluir esconderia o problema;
   * o certo é não tentar e deixar a fila intacta — a tela mostra os pendentes.
   */
  it('campanha sem canal não é tentada nem concluída', async () => {
    const id = randomUUID()
    await dono`INSERT INTO campanha (tenant_id, id, nome, mensagem, canal_id, estado)
               VALUES (${T}, ${id}, 'Sem canal', 'oi', NULL, 'disparando')`
    await dono`INSERT INTO campanha_envio (tenant_id, id, campanha_id, contato_id)
               VALUES (${T}, ${randomUUID()}, ${id}, ${CONTATOS[0]!})`

    const { enviar, chamadas } = envioFalso(() => ok())
    await despacharCampanhasDoTenant(sql, T, AGORA, enviar)

    expect(chamadas).toHaveLength(0)
    expect(await estadoDaCampanha(id)).toBe('disparando')
    expect(await estados(id)).toEqual([{ estado: 'pendente', n: 1 }])
  })
})

describe('O envio real passa pelo gateway', () => {
  /**
   * ⚠️ Sem mock: o canal do teste NÃO tem credencial, então o gateway recusa
   * antes de existir qualquer chamada de rede. É a prova de que o caminho
   * padrão do despachante é o gateway — e não o adaptador direto.
   */
  it('sem credencial, o gateway recusa e nada sai', async () => {
    const r = await enviarTextoParaContato(T, CANAL, CONTATOS[0]!, 'oi', AGORA)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.classe).toBe('recusa')
      expect(r.motivo).toBe('canal_sem_credencial')
    }
  })
})
