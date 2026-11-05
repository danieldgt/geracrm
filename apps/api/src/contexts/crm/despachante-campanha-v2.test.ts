import { createHmac, randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { criarApp } from '../../app.js'
import { comTenantServico, encerrarBanco, type Sql } from '../../db/index.js'
import { cifrar } from '../integracao/cofre.js'
import { despacharCampanhasV2DoTenant, type EnviarDestinatario } from './despachante-campanha.js'
import { enviarCampanhaParaContato, type ResultadoEnvioCampanha } from '../atendimento/envio-campanha.js'
import { ingerirMensagemEntrante, registrarStatusMensagem } from '../atendimento/ingestao-mensagem.js'
import type { PortaCanal, TemplateParaEnvio } from '../atendimento/canais/porta.js'
import { registrarFalhaDestinatario } from './campanha-destinatario.js'
import { anonimizarContato } from './lgpd-anonimizacao.js'
import { obterOuCriarRascunho } from '../pedido/montagem.js'

/**
 * DESPACHANTE DA CAMPANHA V2 (F1a). O que este arquivo guarda é de NEGÓCIO:
 *   - o lote diário, a janela de envio e o teto de aquecimento SEGURAM a campanha
 *     (ela continua amanhã, nunca é dada por concluída antes da hora);
 *   - o opt-out é conferido NO ENVIO, não só no snapshot;
 *   - dois workers ao mesmo tempo NUNCA mandam duas vezes para o mesmo contato nem
 *     estouram o lote do dia;
 *   - opt-out > 2% ou falha > 10% (mín. 50) PAUSA, com alerta e notificação;
 *   - os status do webhook e a resposta do cliente movem o destinatário.
 *
 * ⚠️ A fila é consumida sob o TENANT (`workerDoTenant`, papel da aplicação), nunca com o
 *    dono — o dono só monta o cenário e confere (skill geracrm-testes).
 * ⚠️ Relógio injetado (AGORA). Nunca a Meta: o adaptador é falso, injetado pela fábrica.
 */

const T = 'f1a30000-0000-4000-8000-000000000001'
const PV = 'f1a30000-1111-4000-8000-000000000001'
const PLANO = 'f1a30000-3333-4000-8000-000000000001'
const MODELO = 'f1a30000-4444-4000-8000-000000000001'
const CANAL = 'f1a30000-5555-4000-8000-000000000001'
const OFICIAL = 'f1a30000-5555-4000-8000-000000000002'
const TEMPLATE = 'f1a30000-7777-4000-8000-000000000001'
const ADMIN = 'f1a30000-8888-4000-8000-000000000001'
const PHONE_ID = 'PHONE-F1A3-OFICIAL'
const SEGREDO = 'segredo-webhook-f1a3'

// Terça, 11:00 em São Paulo.
const AGORA = new Date('2026-08-25T14:00:00Z')
const DIA = 86_400_000

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 4, onnotice: () => {} })
const workerDoTenant = postgres(process.env.DATABASE_URL!, { max: 4, connection: { 'geracrm.tenant_id': T } as never })
const outroWorker = postgres(process.env.DATABASE_URL!, { max: 4, connection: { 'geracrm.tenant_id': T } as never })
const w = workerDoTenant as unknown as Sql
const w2 = outroWorker as unknown as Sql

const pad = (n: number) => String(n).padStart(8, '0')
const tel = (n: number) => ({ e164: `+55819${pad(n)}`, chave: `5581${pad(n)}` })
const contatoId = (n: number) => `f1a30000-6666-4000-8000-${String(n).padStart(12, '0')}`

/** Envio falso: registra o contato e devolve ok com um wamid único. */
function envioFalso(resultado?: (contatoId: string) => ResultadoEnvioCampanha): { enviar: EnviarDestinatario; chamadas: string[] } {
  const chamadas: string[] = []
  const enviar: EnviarDestinatario = async (_t, p) => {
    chamadas.push(p.contatoId)
    // Um respiro: dá tempo do outro worker tentar a mesma linha.
    await new Promise((r) => setTimeout(r, 2))
    return resultado?.(p.contatoId) ?? { ok: true, conversaId: randomUUID(), mensagemId: randomUUID(), idExterno: `wamid.${randomUUID()}` }
  }
  return { enviar, chamadas }
}

/** Adaptador falso de canal (a Meta nunca é chamada): guarda o que recebeu. */
function canalFalso(): { criar: () => PortaCanal; templates: { para: string; t: TemplateParaEnvio }[]; textos: { para: string; texto: string }[] } {
  const templates: { para: string; t: TemplateParaEnvio }[] = []
  const textos: { para: string; texto: string }[] = []
  const nao = async () => ({ ok: false as const, motivo: 'indisponivel' as const })
  const porta = {
    tipo: 'whatsapp_oficial',
    capacidades: { janela24h: true, aceitaTemplate: true, riscoBanimento: false, textoLivreSempre: false, sessaoPodeCair: false, indicaDigitacao: false, mensagensInterativas: false },
    enviarTexto: async (para: string, texto: string) => { textos.push({ para, texto }); return { ok: true as const, idExterno: `wamid.${randomUUID()}` } },
    enviarTemplate: async (para: string, t: TemplateParaEnvio) => { templates.push({ para, t }); return { ok: true as const, idExterno: `wamid.${randomUUID()}` } },
    enviarImagem: nao, enviarAudio: nao, apagarMensagem: nao, editarMensagem: nao,
    verificarConexao: async () => ({ conectado: true }), qrCode: async () => ({ ok: false as const, motivo: 'x' }),
  } as unknown as PortaCanal
  return { criar: () => porta, templates, textos }
}

async function criarContatos(ns: number[]): Promise<void> {
  for (const n of ns) {
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${contatoId(n)}, ${'Cliente ' + n}) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${T}, ${contatoId(n)}, 1, ${tel(n).e164}, ${tel(n).chave}, true, true, 'teste') ON CONFLICT DO NOTHING`
  }
}

/** Campanha v2 já iniciada com `ns` pendentes. */
let seqCampanha = 0
/** Id de destinatário ORDENADO pelo número do contato (o despachante reivindica por id). */
const destinatarioId = (seq: number, n: number) => `f1a3${seq.toString(16).padStart(4, '0')}-dddd-4000-8000-${String(n).padStart(12, '0')}`

/**
 * Campanha v2 já iniciada com `ns` pendentes. Padrão: número OFICIAL (sem intervalo
 * mínimo; tier padrão 250) — o não oficial tem teste próprio do intervalo.
 */
async function novaCampanha(ns: number[], o: { lote?: number; canal?: string; template?: boolean; estado?: string; inicio?: Date | null; janela?: unknown } = {}): Promise<string> {
  const id = randomUUID()
  const seq = ++seqCampanha
  const canal = o.canal ?? OFICIAL
  await dono`
    INSERT INTO campanha (tenant_id, id, nome, canal_id, mensagem, template_id, modelo_versao, estado, publico, lote_diario,
                          inicio_em, janela, iniciada_em, contagem_desde, disparada_em)
    VALUES (${T}, ${id}, 'Volta!', ${canal}, ${o.template ? null : 'Oi, temos novidade'}, ${o.template ? TEMPLATE : null}, 2,
            ${o.estado ?? 'enviando'}, '{}'::jsonb, ${o.lote ?? 500}, ${o.inicio ?? null},
            ${o.janela ? JSON.stringify(o.janela) : null}::text::jsonb, ${AGORA}, ${new Date(AGORA.getTime() - DIA)}, ${AGORA})`
  for (const n of ns) {
    await dono`INSERT INTO campanha_destinatario (tenant_id, id, campanha_id, contato_id, telefone_chave)
               VALUES (${T}, ${destinatarioId(seq, n)}, ${id}, ${contatoId(n)}, ${tel(n).chave})`
  }
  return id
}

const estados = (id: string) => dono<{ estado: string; n: number }[]>`
  SELECT estado, count(*)::int AS n FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}
   GROUP BY estado ORDER BY estado`
const campanha = (id: string) => dono<{ estado: string; pausa_motivo: string | null }[]>`
  SELECT estado, pausa_motivo FROM campanha WHERE tenant_id = ${T} AND id = ${id}`.then((r) => r[0]!)

const TABELAS = ['campanha_destinatario', 'campanha', 'canal_aquecimento', 'lista_bloqueio', 'alerta', 'notificacao', 'auditoria', 'outbox',
  'mensagem_id_externo', 'mensagem', 'conversa', 'numero_conversa_iniciada', 'numero_throttle', 'numero_whatsapp']

beforeAll(async () => {
  process.env.DEV_TENANT_HEADER = 'on'
  process.env.META_APP_SECRET = SEGREDO
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-desp-v2', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-desp-v2', 'Varejo') ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso) VALUES (${T}, 'Loja Sol', ${PLANO}, ${PV}, 'America/Sao_Paulo') ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${T}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  const cred = cifrar({ instancia: 'i', token: 't', clientToken: 'c' })
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas)
             VALUES (${T}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'Vendas', 'conectado', ${cred}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado, credenciais_cifradas, identificador_externo)
             VALUES (${T}, ${OFICIAL}, 'whatsapp_oficial', 'meta_oficial', 'Oficial', 'conectado',
                     ${cifrar({ phoneNumberId: PHONE_ID, token: 't' })}, ${PHONE_ID}) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO template (tenant_id, id, nome, categoria, mapeamento_variaveis)
             VALUES (${T}, ${TEMPLATE}, 'volta_f1a3', 'MARKETING', '{"1":"contato.nome","2":"empresa.nome"}'::jsonb) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO template_versao (tenant_id, template_id, versao, corpo, status_meta)
             VALUES (${T}, ${TEMPLATE}, 1, ${JSON.stringify({ body: { texto: 'Olá {{1}}, novidade na {{2}}!' } })}::text::jsonb, 'APPROVED')
             ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario (tenant_id, id, cognito_sub, nome, email) VALUES (${T}, ${ADMIN}, 'sub-f1a3-admin', 'Gestora', 'g@f1a3.test') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO usuario_filial (tenant_id, usuario_id, filial_id, papel) VALUES (${T}, ${ADMIN}, NULL, 'admin') ON CONFLICT DO NOTHING`
  await criarContatos(Array.from({ length: 70 }, (_, i) => i + 1))
})

beforeEach(async () => {
  for (const t of TABELAS) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
  await dono`UPDATE canal_conectado SET ativas_suspensas_em = NULL, ativas_suspensas_motivo = NULL WHERE tenant_id = ${T}`
  await dono`DELETE FROM canal_configuracao WHERE tenant_id = ${T}`
})

afterAll(async () => {
  for (const t of [...TABELAS, 'canal_configuracao', 'template_versao', 'template', 'usuario_filial', 'usuario', 'contato_telefone', 'contato', 'canal_conectado']) {
    await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`).catch(() => undefined)
  }
  await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${T}`
  await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${T}`
  await dono`DELETE FROM tenant WHERE id = ${T}`
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await workerDoTenant.end(); await outroWorker.end(); await dono.end(); await encerrarBanco()
})

describe('Lote diário, janela e aquecimento seguram a campanha', () => {
  it('lote diário de 3: manda 3 hoje, nada mais hoje, o resto amanhã — e só então conclui', async () => {
    const id = await novaCampanha([1, 2, 3, 4, 5], { lote: 3 })
    const { enviar, chamadas } = envioFalso()

    const r1 = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r1.enviados).toBe(3)
    const r2 = await despacharCampanhasV2DoTenant(w, T, new Date(AGORA.getTime() + 3_600_000), enviar)
    expect(r2.enviados).toBe(0)
    expect(r2.loteDoDiaCumprido).toBe(1)
    expect((await campanha(id)).estado).toBe('enviando')

    const r3 = await despacharCampanhasV2DoTenant(w, T, new Date(AGORA.getTime() + DIA), enviar)
    expect(r3.enviados).toBe(2)
    expect(r3.concluidas).toBe(1)
    expect((await campanha(id)).estado).toBe('concluida')
    expect(new Set(chamadas).size).toBe(5)
    expect(await estados(id)).toEqual([{ estado: 'enviada', n: 5 }])
  })

  it('fora da janela (23h, sem expediente no número = janela padrão 8h–20h) não manda nada', async () => {
    const id = await novaCampanha([1, 2])
    const { enviar, chamadas } = envioFalso()
    const noite = new Date('2026-08-26T02:00:00Z') // 23:00 em São Paulo
    const r = await despacharCampanhasV2DoTenant(w, T, noite, enviar)
    expect(r.foraDaJanela).toBe(1)
    expect(chamadas).toHaveLength(0)
    expect(await estados(id)).toEqual([{ estado: 'pendente', n: 2 }])
  })

  it('a janela da campanha vence o expediente do número; o expediente do número vence o padrão', async () => {
    // Número atende só das 13h às 18h → 11h está fechado.
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento)
               VALUES (${T}, ${OFICIAL}, ${JSON.stringify({ ter: { de: '13:00', ate: '18:00' } })}::text::jsonb)`
    const segueExpediente = await novaCampanha([1])
    const comJanela = await novaCampanha([2], { janela: { ter: { de: '10:00', ate: '12:00' } } })
    const { enviar, chamadas } = envioFalso()
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.foraDaJanela).toBe(1)
    expect(chamadas).toEqual([contatoId(2)])
    expect(await estados(segueExpediente)).toEqual([{ estado: 'pendente', n: 1 }])
    expect(await estados(comJanela)).toEqual([{ estado: 'enviada', n: 1 }])
  })

  it('aquecimento: número no dia 0 (teto 20) com lote 100 manda 20 e segura o resto', async () => {
    await dono`INSERT INTO canal_aquecimento (tenant_id, canal_id, iniciado_em) VALUES (${T}, ${OFICIAL}, ${AGORA})`
    const id = await novaCampanha(Array.from({ length: 25 }, (_, i) => i + 1), { lote: 100 })
    const { enviar } = envioFalso()
    const r1 = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r1.enviados).toBe(20)
    const r2 = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r2.enviados).toBe(0)
    expect(r2.aguardandoAquecimento).toBe(1)
    expect((await estados(id)).find((e) => e.estado === 'pendente')?.n).toBe(5)
    expect((await campanha(id)).estado).toBe('enviando')
  })

  it('agendada só começa quando chega o início', async () => {
    const id = await novaCampanha([1], { estado: 'agendada', inicio: new Date(AGORA.getTime() + 3_600_000) })
    const { enviar, chamadas } = envioFalso()
    expect((await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)).iniciadas).toBe(0)
    expect(chamadas).toHaveLength(0)
    const depois = new Date(AGORA.getTime() + 2 * 3_600_000)
    const r = await despacharCampanhasV2DoTenant(w, T, depois, enviar)
    expect(r.iniciadas).toBe(1)
    expect(r.enviados).toBe(1)
    expect((await campanha(id)).estado).toBe('concluida')
  })
})

describe('Opt-out no envio e envio real pelo gateway', () => {
  it('quem entrou na lista de bloqueio DEPOIS do iniciar não recebe (gateway) e fica excluída/optout', async () => {
    const id = await novaCampanha([1, 2], { canal: OFICIAL, template: true })
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem) VALUES (${T}, ${tel(2).chave}, 'opt_out', 'teste')`
    const falso = canalFalso()
    const enviar: EnviarDestinatario = (t, p, a) => enviarCampanhaParaContato(t, p, a, { criar: falso.criar })

    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)

    expect(r.enviados).toBe(1)
    expect(r.excluidos).toBe(1)
    // A Meta (falsa) só viu o contato 1 — e com as variáveis do mapeamento preenchidas.
    expect(falso.templates).toHaveLength(1)
    expect(falso.templates[0]!.t).toEqual({ nome: 'volta_f1a3', idioma: 'pt_BR', variaveis: ['Cliente 1', 'Loja Sol'] })
    const linhas = await dono<{ contato_id: string; estado: string; motivo_exclusao: string | null; wamid: string | null }[]>`
      SELECT contato_id, estado, motivo_exclusao, wamid FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id} ORDER BY contato_id`
    expect(linhas[0]).toMatchObject({ estado: 'enviada', motivo_exclusao: null })
    expect(linhas[0]!.wamid).toMatch(/^wamid\./)
    expect(linhas[1]).toMatchObject({ estado: 'excluida', motivo_exclusao: 'optout', wamid: null })
    // O bloqueado não ganhou conversa nem mensagem fantasma.
    expect(await dono`SELECT 1 FROM conversa WHERE tenant_id = ${T} AND contato_id = ${contatoId(2)}`).toHaveLength(0)
    // A mensagem enviada nasce com campanha e template (custo por campanha no Consumo, F2) e o corpo renderizado.
    const [m] = await dono<{ campanha_id: string; template_id: string; texto: string }[]>`
      SELECT campanha_id, template_id, conteudo->>'texto' AS texto FROM mensagem WHERE tenant_id = ${T}`
    expect(m).toEqual({ campanha_id: id, template_id: TEMPLATE, texto: 'Olá Cliente 1, novidade na Loja Sol!' })
  })

  it('template pausado pela Meta entre o iniciar e o envio: a campanha pausa e a fila volta intacta', async () => {
    const id = await novaCampanha([1, 2], { canal: OFICIAL, template: true })
    await dono`UPDATE template_versao SET status_meta = 'PAUSED' WHERE tenant_id = ${T} AND template_id = ${TEMPLATE}`
    try {
      const falso = canalFalso()
      const r = await despacharCampanhasV2DoTenant(w, T, AGORA, (t, p, a) => enviarCampanhaParaContato(t, p, a, { criar: falso.criar }))
      expect(r.pausadas).toBe(1)
      expect(falso.templates).toHaveLength(0)
      expect(await campanha(id)).toEqual({ estado: 'pausada', pausa_motivo: 'template_indisponivel' })
      expect(await estados(id)).toEqual([{ estado: 'pendente', n: 2 }])
    } finally {
      await dono`UPDATE template_versao SET status_meta = 'APPROVED' WHERE tenant_id = ${T} AND template_id = ${TEMPLATE}`
    }
  })

  it('falha de transporte vira falhou (com o código); recusa nossa vira excluída — nunca as duas misturadas', async () => {
    const id = await novaCampanha([1, 2])
    const { enviar } = envioFalso((c) => c === contatoId(1)
      ? { ok: false, classe: 'transporte', motivo: 'indisponivel' }
      : { ok: false, classe: 'alvo', motivo: 'sem_telefone' })
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.falhas).toBe(1)
    expect(r.excluidos).toBe(1)
    const l = await dono<{ estado: string; erro_codigo: string | null; motivo_exclusao: string | null }[]>`
      SELECT estado, erro_codigo, motivo_exclusao FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id} ORDER BY contato_id`
    expect(l).toEqual([
      { estado: 'falhou', erro_codigo: 'indisponivel', motivo_exclusao: null },
      { estado: 'excluida', erro_codigo: null, motivo_exclusao: 'semTelefone' },
    ])
  })

  it('disparo pausado no número: a linha volta para a fila (não é culpa do destinatário)', async () => {
    const id = await novaCampanha([1, 2])
    const { enviar } = envioFalso(() => ({ ok: false, classe: 'recusa', motivo: 'disparo_pausado' }))
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.enviados + r.excluidos + r.falhas).toBe(0)
    expect(await estados(id)).toEqual([{ estado: 'pendente', n: 2 }])
  })
})

describe('Nunca envia duas vezes', () => {
  it('dois workers ao mesmo tempo: cada contato no máximo uma vez, e o lote do dia não estoura', async () => {
    const id = await novaCampanha(Array.from({ length: 30 }, (_, i) => i + 1), { lote: 10 })
    const { enviar, chamadas } = envioFalso()
    const [a, b] = await Promise.all([
      despacharCampanhasV2DoTenant(w, T, AGORA, enviar),
      despacharCampanhasV2DoTenant(w2, T, AGORA, enviar),
    ])
    expect(a.enviados + b.enviados).toBe(10)
    expect(chamadas).toHaveLength(10)
    expect(new Set(chamadas).size).toBe(10)
    expect((await estados(id)).find((e) => e.estado === 'enviada')?.n).toBe(10)
  })

  it('varredura de linha presa em "enviando": sem mensagem volta à fila; mensagem pendente falha; mensagem enviada é recuperada', async () => {
    const id = await novaCampanha([1, 2, 3])
    const presa = new Date(AGORA.getTime() - 20 * 60_000)
    await dono`UPDATE campanha_destinatario SET estado = 'enviando', enviando_desde = ${presa}
                WHERE tenant_id = ${T} AND campanha_id = ${id}`
    // 2: a mensagem chegou a ser gravada e ficou pendente (pode ter saído) → ambíguo.
    // 3: a mensagem saiu (id externo gravado) → o envio é recuperado, não repetido.
    for (const [n, status, wamid] of [[2, 'pendente', null], [3, 'entregue', 'wamid.recuperado.3']] as const) {
      const conv = randomUUID()
      await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${conv}, ${OFICIAL}, ${contatoId(n)}, 1)`
      await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem, campanha_id, id_externo)
                 VALUES (${T}, ${randomUUID()}, ${conv}, 'saliente', 'texto', '{}'::jsonb, ${status}, 1, ${id}, ${wamid})`
    }
    const { enviar, chamadas } = envioFalso()
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.interrompidos).toBe(3)
    // Só o 1 (nunca saiu) volta à fila e é enviado — uma vez.
    expect(chamadas).toEqual([contatoId(1)])
    const l = await dono<{ contato_id: string; estado: string; erro_codigo: string | null; wamid: string | null }[]>`
      SELECT contato_id, estado, erro_codigo, wamid FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id} ORDER BY contato_id`
    expect(l[0]).toMatchObject({ estado: 'enviada' })
    expect(l[1]).toMatchObject({ estado: 'falhou', erro_codigo: 'envio_interrompido' })
    expect(l[2]).toMatchObject({ estado: 'entregue', wamid: 'wamid.recuperado.3' })
  })

  it('mesma chave de telefone (com e sem o nono dígito) de quem já recebeu: excluída, não manda de novo', async () => {
    const id = await novaCampanha([1])
    const dup = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${dup}, 'Mesma linha')`
    await dono`INSERT INTO campanha_destinatario (tenant_id, id, campanha_id, contato_id, telefone_chave, estado, enviado_em)
               VALUES (${T}, ${randomUUID()}, ${id}, ${dup}, ${tel(1).chave}, 'enviada', ${AGORA})`
    const { enviar, chamadas } = envioFalso()
    await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(chamadas).toHaveLength(0)
    const [l] = await dono<{ estado: string; motivo_exclusao: string }[]>`
      SELECT estado, motivo_exclusao FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(1)}`
    expect(l).toEqual({ estado: 'excluida', motivo_exclusao: 'telefoneDuplicado' })
    await dono`DELETE FROM campanha_destinatario WHERE tenant_id = ${T} AND contato_id = ${dup}`
    await dono`DELETE FROM contato WHERE tenant_id = ${T} AND id = ${dup}`
  })
})

describe('Pausa automática', () => {
  /** `enviados` já saíram (há 1 h); os `optouts` primeiros entraram na lista DEPOIS do envio. */
  async function campanhaComEnvios(enviados: number, o: { optouts?: number; falhas?: number } = {}): Promise<string> {
    const ns = Array.from({ length: enviados + 1 }, (_, i) => i + 1)
    const id = await novaCampanha(ns)
    const antes = new Date(AGORA.getTime() - 3_600_000)
    await dono`UPDATE campanha_destinatario SET estado = 'enviada', enviado_em = ${antes}, wamid = 'wamid.' || id::text
                WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id <> ${contatoId(enviados + 1)}`
    for (let i = 1; i <= (o.optouts ?? 0); i++) {
      await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem, bloqueado_em)
                 VALUES (${T}, ${tel(i).chave}, 'opt_out', 'opt_out_mensagem', ${new Date(antes.getTime() + 60_000)})`
    }
    for (let i = 1; i <= (o.falhas ?? 0); i++) {
      await dono`UPDATE campanha_destinatario SET estado = 'falhou', enviado_em = NULL, erro_codigo = 'indisponivel', atualizado_em = ${antes}
                  WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(enviados - i + 1)}`
    }
    return id
  }

  it('opt-out acima de 2% dos enviados (mín. 50) pausa, abre alerta e notifica a gestão — e não manda mais', async () => {
    const id = await campanhaComEnvios(60, { optouts: 2 }) // 2/60 = 3,3%
    const { enviar, chamadas } = envioFalso()
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.pausadas).toBe(1)
    expect(chamadas).toHaveLength(0)
    expect(await campanha(id)).toEqual({ estado: 'pausada', pausa_motivo: 'optout_alto' })
    expect((await estados(id)).find((e) => e.estado === 'optout')?.n).toBe(2)
    expect(await dono`SELECT 1 FROM alerta WHERE tenant_id = ${T} AND tipo = 'campanha_pausada' AND resolvido_em IS NULL`).toHaveLength(1)
    expect(await dono`SELECT 1 FROM notificacao WHERE tenant_id = ${T} AND usuario_id = ${ADMIN} AND tipo = 'campanha.pausada'`).toHaveLength(1)
    expect(await dono`SELECT 1 FROM auditoria WHERE tenant_id = ${T} AND acao = 'campanha.pausada_automaticamente' AND entidade_id = ${id}`).toHaveLength(1)
  })

  it('opt-out em 1 de 60 (1,7%) não pausa; 2 de 49 espera a amostra mínima e pausa no 50º envio', async () => {
    const id = await campanhaComEnvios(60, { optouts: 1 })
    const { enviar } = envioFalso()
    expect((await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)).pausadas).toBe(0)
    expect((await campanha(id)).estado).toBe('concluida')

    for (const t of ['campanha_destinatario', 'campanha', 'lista_bloqueio']) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
    const pequena = await campanhaComEnvios(49, { optouts: 2 })
    // 49 enviados: abaixo da amostra, o 50º sai; com ele, 2/50 = 4% → pausa no fim da passada.
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.enviados).toBe(1)
    expect(r.pausadas).toBe(1)
    expect(await campanha(pequena)).toEqual({ estado: 'pausada', pausa_motivo: 'optout_alto' })
  })

  it('falha acima de 10% (mín. 50 processados) pausa', async () => {
    const id = await campanhaComEnvios(60, { falhas: 7 }) // 7/60 = 11,7%
    const { enviar, chamadas } = envioFalso()
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.pausadas).toBe(1)
    expect(chamadas).toHaveLength(0)
    expect(await campanha(id)).toEqual({ estado: 'pausada', pausa_motivo: 'falhas_altas' })
  })

  it('as taxas contam desde a retomada: retomar não pausa de novo pelo que já tinha acontecido', async () => {
    const id = await campanhaComEnvios(60, { falhas: 7 })
    await dono`UPDATE campanha SET contagem_desde = ${AGORA} WHERE tenant_id = ${T} AND id = ${id}`
    const { enviar } = envioFalso()
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.pausadas).toBe(0)
    expect(r.enviados).toBe(1)
  })

  it('qualidade do número caiu (ativas suspensas pela Meta): pausa com o motivo', async () => {
    const id = await novaCampanha([1])
    await dono`UPDATE canal_conectado SET ativas_suspensas_em = ${AGORA}, ativas_suspensas_motivo = 'qualidade:FLAGGED:RED' WHERE tenant_id = ${T} AND id = ${OFICIAL}`
    const { enviar, chamadas } = envioFalso()
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.pausadas).toBe(1)
    expect(chamadas).toHaveLength(0)
    expect(await campanha(id)).toEqual({ estado: 'pausada', pausa_motivo: 'qualidade_numero' })
  })
})

describe('Status do webhook e resposta do cliente', () => {
  async function enviada(n: number): Promise<{ id: string; wamid: string }> {
    const id = await novaCampanha([n], { canal: OFICIAL, template: true })
    const wamid = `wamid.F1A3.${n}.${randomUUID()}`
    await dono`UPDATE campanha_destinatario SET estado = 'enviada', enviado_em = ${AGORA}, wamid = ${wamid}
                WHERE tenant_id = ${T} AND campanha_id = ${id}`
    return { id, wamid }
  }
  const linha = (id: string) => dono<{ estado: string; entregue_em: Date | null; lido_em: Date | null; respondeu_em: Date | null; erro_codigo: string | null }[]>`
    SELECT estado, entregue_em, lido_em, respondeu_em, erro_codigo FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`.then((r) => r[0]!)

  it('entregue → lida avançam; lida antes de entregue não regride; o marco de entrega fica preenchido', async () => {
    const { id, wamid } = await enviada(1)
    await comTenantServico(T, (tx) => registrarStatusMensagem(tx, wamid, 'lida', AGORA))
    expect(await linha(id)).toMatchObject({ estado: 'lida', entregue_em: AGORA, lido_em: AGORA })
    await comTenantServico(T, (tx) => registrarStatusMensagem(tx, wamid, 'entregue', new Date(AGORA.getTime() + 1000)))
    expect((await linha(id)).estado).toBe('lida')
  })

  it('webhook da Meta "failed" com código: destinatário falhou com o código (rota real, assinatura válida)', async () => {
    const { id, wamid } = await enviada(2)
    // A mensagem da thread com o mesmo wamid: o webhook "failed" a marca como falhou (B3).
    const conv = randomUUID()
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${conv}, ${OFICIAL}, ${contatoId(2)}, 1)`
    await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem, id_externo)
               VALUES (${T}, ${randomUUID()}, ${conv}, 'saliente', 'texto', '{}'::jsonb, 'enviada', 1, ${wamid})`
    const corpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA-F1A3', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: PHONE_ID },
        statuses: [{ id: wamid, status: 'failed', timestamp: '1690000100', recipient_id: '5581900000002', errors: [{ code: 131026, title: 'Message undeliverable' }] }],
      } }] }],
    })
    const app: FastifyInstance = await criarApp()
    await app.ready()
    try {
      const r = await app.inject({ method: 'POST', url: '/webhooks/meta', payload: corpo,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SEGREDO).update(Buffer.from(corpo)).digest('hex') } })
      expect(r.statusCode).toBe(200)
    } finally { await app.close() }
    expect(await linha(id)).toMatchObject({ estado: 'falhou', erro_codigo: '131026' })
    const [m] = await dono<{ status: string }[]>`SELECT status FROM mensagem WHERE tenant_id = ${T} AND id_externo = ${wamid}`
    expect(m!.status).toBe('falhou')
    // 131026 é erro do destinatário: a campanha segue (não pausa).
    expect((await campanha(id)).estado).toBe('enviando')
  })

  it('o cliente respondeu no mesmo número em até 7 dias → respondeu; depois de 7 dias, não', async () => {
    const { id } = await enviada(3)
    await comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, OFICIAL, {
      deE164: tel(3).e164.replace('+', ''), idExterno: `wamid.in.${randomUUID()}`, tipo: 'texto', texto: 'quero!',
      recebidaEm: new Date(AGORA.getTime() + 2 * DIA),
    }))
    expect(await linha(id)).toMatchObject({ estado: 'respondeu', respondeu_em: new Date(AGORA.getTime() + 2 * DIA) })

    const tarde = await enviada(4)
    await comTenantServico(T, (tx) => ingerirMensagemEntrante(tx, OFICIAL, {
      deE164: tel(4).e164.replace('+', ''), idExterno: `wamid.in.${randomUUID()}`, tipo: 'texto', texto: 'oi',
      recebidaEm: new Date(AGORA.getTime() + 8 * DIA),
    }))
    expect((await linha(tarde.id)).estado).toBe('enviada')
  })
})

describe('Revisão F1a — limites do número, queda no meio e reavaliação no envio', () => {
  it('A1: tier do oficial = contatos DISTINTOS em 24 h; quem já tem vaga não gasta outra; sem vaga, fica na fila', async () => {
    await dono`INSERT INTO numero_whatsapp (tenant_id, canal_id, telefone_e164, waba_id, phone_number_id, tier)
               VALUES (${T}, ${OFICIAL}, '+5581999990000', 'WABA', ${PHONE_ID}, 2)`
    // O contato 1 já falou com este número há 1 h (vaga ocupada na janela de 24 h).
    await dono`INSERT INTO numero_conversa_iniciada (tenant_id, canal_id, contato_id, iniciada_em)
               VALUES (${T}, ${OFICIAL}, ${contatoId(1)}, ${new Date(AGORA.getTime() - 3_600_000)})`
    const id = await novaCampanha([1, 2, 3])
    const { enviar, chamadas } = envioFalso()
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(chamadas).toEqual([contatoId(1), contatoId(2)])
    expect(r.aguardandoTier).toBe(1)
    expect((await estados(id)).find((e) => e.estado === 'pendente')?.n).toBe(1)
    const [n] = await dono<{ n: number }[]>`
      SELECT count(DISTINCT contato_id)::int AS n FROM numero_conversa_iniciada WHERE tenant_id = ${T} AND canal_id = ${OFICIAL}`
    expect(n!.n).toBe(2)
  })

  it('A1: sem tier informado no número, o teto é 250 contatos em 24 h (#117)', async () => {
    const antes = new Date(AGORA.getTime() - 3_600_000)
    await dono`INSERT INTO numero_conversa_iniciada (tenant_id, canal_id, contato_id, iniciada_em)
               SELECT ${T}, ${OFICIAL}, gen_random_uuid(), ${antes} FROM generate_series(1, 250)`
    const id = await novaCampanha([1])
    const { enviar, chamadas } = envioFalso()
    expect((await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)).aguardandoTier).toBe(1)
    expect(chamadas).toHaveLength(0)
    expect(await estados(id)).toEqual([{ estado: 'pendente', n: 1 }])
  })

  it('A2: não oficial tem intervalo mínimo aleatório (3–10 s) por número — sem rajada', async () => {
    const id = await novaCampanha([1, 2, 3], { canal: CANAL })
    const { enviar, chamadas } = envioFalso()
    const r1 = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r1.enviados).toBe(1)
    expect(r1.aguardandoIntervalo).toBe(1)
    expect((await despacharCampanhasV2DoTenant(w, T, new Date(AGORA.getTime() + 2_000), enviar)).enviados).toBe(0)
    expect((await despacharCampanhasV2DoTenant(w, T, new Date(AGORA.getTime() + 11_000), enviar)).enviados).toBe(1)
    expect(chamadas).toHaveLength(2)
    const [t] = await dono<{ espera: number }[]>`
      SELECT extract(epoch FROM proximo_envio_permitido_em - ${new Date(AGORA.getTime() + 11_000)}::timestamptz)::int AS espera
        FROM numero_throttle WHERE tenant_id = ${T} AND canal_id = ${CANAL}`
    expect(t!.espera).toBeGreaterThanOrEqual(3)
    expect(t!.espera).toBeLessThanOrEqual(10)
    expect((await estados(id)).find((e) => e.estado === 'pendente')?.n).toBe(1)
  })

  it('M1: a campanha pausada NO MEIO da passada não manda o resto', async () => {
    const id = await novaCampanha([1, 2, 3])
    const chamadas: string[] = []
    const enviar: EnviarDestinatario = async (_t, p) => {
      chamadas.push(p.contatoId)
      await dono`UPDATE campanha SET estado = 'pausada', pausa_motivo = 'manual' WHERE tenant_id = ${T} AND id = ${id}`
      return { ok: true, conversaId: randomUUID(), mensagemId: randomUUID(), idExterno: `wamid.${randomUUID()}` }
    }
    await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(chamadas).toHaveLength(1)
    expect((await estados(id)).find((e) => e.estado === 'pendente')?.n).toBe(2)
  })

  it('M3: exclusões reavaliadas no envio — outra campanha em curso alcançou o contato; conversou depois do snapshot', async () => {
    const outra = await novaCampanha([2])
    await dono`UPDATE campanha SET estado = 'concluida' WHERE tenant_id = ${T} AND id = ${outra}`
    await dono`UPDATE campanha_destinatario SET estado = 'enviada', enviado_em = ${new Date(AGORA.getTime() - 5 * DIA)}
                WHERE tenant_id = ${T} AND campanha_id = ${outra}`
    const id = await novaCampanha([1, 2, 3])
    await dono`UPDATE campanha SET publico = '{"exclusoes":{"conversaRecenteDias":7,"campanhaRecenteDias":30,"compraRecenteDias":7}}'::jsonb
                WHERE tenant_id = ${T} AND id = ${id}`
    await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_mensagem_em, versao)
               VALUES (${T}, ${randomUUID()}, ${CANAL}, ${contatoId(3)}, ${new Date(AGORA.getTime() - DIA)}, 1)`
    const { enviar, chamadas } = envioFalso()
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(chamadas).toEqual([contatoId(1)])
    expect(r.excluidos).toBe(2)
    const l = await dono<{ contato_id: string; motivo_exclusao: string | null }[]>`
      SELECT contato_id, motivo_exclusao FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id} ORDER BY contato_id`
    expect(l.map((x) => x.motivo_exclusao)).toEqual([null, 'campanhaRecente', 'conversaRecente'])
  })

  it('M5: contato anonimizado depois do snapshot não recebe; a anonimização apaga a chave do telefone do destinatário', async () => {
    const id = await novaCampanha([1, 2])
    await dono`UPDATE contato SET anonimizado_em = ${AGORA}, anonimizacao_modo = 'canais' WHERE tenant_id = ${T} AND id = ${contatoId(2)}`
    try {
      const { enviar, chamadas } = envioFalso()
      await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
      expect(chamadas).toEqual([contatoId(1)])
      const [l] = await dono<{ estado: string; motivo_exclusao: string }[]>`
        SELECT estado, motivo_exclusao FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(2)}`
      expect(l).toEqual({ estado: 'excluida', motivo_exclusao: 'anonimizado' })
    } finally {
      await dono`UPDATE contato SET anonimizado_em = NULL, anonimizacao_modo = NULL WHERE tenant_id = ${T} AND id = ${contatoId(2)}`
    }
    // H2: anonimizar de verdade um contato que estava numa campanha.
    const alvo = randomUUID()
    await dono`INSERT INTO contato (tenant_id, id, nome) VALUES (${T}, ${alvo}, 'Titular')`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, fonte)
               VALUES (${T}, ${alvo}, 1, '+5581977776655', '558177776655', true, 'teste')`
    await dono`INSERT INTO campanha_destinatario (tenant_id, id, campanha_id, contato_id, telefone_chave, estado, enviado_em)
               VALUES (${T}, ${randomUUID()}, ${id}, ${alvo}, '558177776655', 'enviada', ${AGORA})`
    const r = await comTenantServico(T, (tx) => anonimizarContato(tx, alvo, { motivo: 'titular', agora: AGORA }))
    expect(r.ok).toBe(true)
    const [d] = await dono<{ telefone_chave: string | null }[]>`
      SELECT telefone_chave FROM campanha_destinatario WHERE tenant_id = ${T} AND contato_id = ${alvo}`
    expect(d!.telefone_chave).toBeNull()
  })

  it('M6: erro de número em risco no envio pausa NA HORA e devolve a linha; erro do destinatário não entra na taxa', async () => {
    const risco = await novaCampanha([1, 2])
    const { enviar } = envioFalso(() => ({ ok: false, classe: 'transporte', motivo: 'indisponivel', codigo: '131048' }))
    const r = await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    expect(r.pausadas).toBe(1)
    expect(await campanha(risco)).toEqual({ estado: 'pausada', pausa_motivo: 'numero_em_risco' })
    expect(await estados(risco)).toEqual([{ estado: 'pendente', n: 2 }])

    for (const t of ['campanha_destinatario', 'campanha', 'alerta', 'notificacao', 'auditoria']) await dono.unsafe(`DELETE FROM ${t} WHERE tenant_id = '${T}'`)
    const fixos = await novaCampanha(Array.from({ length: 60 }, (_, i) => i + 1))
    const naoEhWhats = envioFalso(() => ({ ok: false, classe: 'transporte', motivo: 'destino_invalido', codigo: '131026' }))
    const r2 = await despacharCampanhasV2DoTenant(w, T, AGORA, naoEhWhats.enviar)
    expect(r2.falhas).toBe(50)
    expect(r2.pausadas).toBe(0)
    expect((await campanha(fixos)).estado).toBe('enviando')
  })

  it('M6: webhook "failed" com erro de número em risco pausa a campanha na hora', async () => {
    const id = await novaCampanha([1])
    await dono`UPDATE campanha_destinatario SET estado = 'enviada', enviado_em = ${AGORA}, wamid = 'wamid.risco.1'
                WHERE tenant_id = ${T} AND campanha_id = ${id}`
    await comTenantServico(T, (tx) => registrarFalhaDestinatario(tx, 'wamid.risco.1', '131031', AGORA))
    expect(await campanha(id)).toEqual({ estado: 'pausada', pausa_motivo: 'numero_em_risco' })
  })

  it('B1: o status que o webhook gravou ANTES do desfecho (lida) vale para o destinatário', async () => {
    const id = await novaCampanha([1], { template: true })
    const falso = canalFalso()
    const enviar: EnviarDestinatario = async (t, p, a) => {
      const r = await enviarCampanhaParaContato(t, p, a, { criar: falso.criar })
      if (r.ok) await dono`UPDATE mensagem SET status = 'lida', status_ordem = 3 WHERE tenant_id = ${T} AND id_externo = ${r.idExterno}`
      return r
    }
    await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)
    const [l] = await dono<{ estado: string; lido_em: Date | null }[]>`
      SELECT estado, lido_em FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`
    expect(l!.estado).toBe('lida')
    expect(l!.lido_em).not.toBeNull()
  })

  it('B5: número com disparo pausado — a campanha nem reivindica (tentativas não sobem em laço)', async () => {
    const id = await novaCampanha([1])
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, disparo_pausado, pausado_motivo, pausado_em)
               VALUES (${T}, ${OFICIAL}, true, 'manual', ${AGORA})`
    const { enviar, chamadas } = envioFalso()
    for (let i = 0; i < 3; i++) expect((await despacharCampanhasV2DoTenant(w, T, AGORA, enviar)).bloqueadas).toBe(1)
    expect(chamadas).toHaveLength(0)
    const [l] = await dono<{ estado: string; tentativas: number }[]>`
      SELECT estado, tentativas FROM campanha_destinatario WHERE tenant_id = ${T} AND campanha_id = ${id}`
    expect(l).toEqual({ estado: 'pendente', tentativas: 0 })
  })

  it('B7: opt-out depois da campanha concluída ainda conta, dentro da janela de atribuição', async () => {
    const id = await novaCampanha([1])
    await dono`UPDATE campanha SET estado = 'concluida', concluida_em = ${new Date(AGORA.getTime() - DIA)} WHERE tenant_id = ${T} AND id = ${id}`
    await dono`UPDATE campanha_destinatario SET estado = 'enviada', enviado_em = ${new Date(AGORA.getTime() - 2 * DIA)}
                WHERE tenant_id = ${T} AND campanha_id = ${id}`
    await dono`INSERT INTO lista_bloqueio (tenant_id, chave_bloqueio, motivo, origem, bloqueado_em)
               VALUES (${T}, ${tel(1).chave}, 'opt_out', 'opt_out_mensagem', ${new Date(AGORA.getTime() - DIA)})`
    await despacharCampanhasV2DoTenant(w, T, AGORA, envioFalso().enviar)
    expect(await estados(id)).toEqual([{ estado: 'optout', n: 1 }])
  })

  it('M4: o pedido que nasce na conversa herda a campanha que alcançou o contato na janela; fora da janela, não', async () => {
    const id = await novaCampanha([1, 2])
    await dono`UPDATE campanha_destinatario SET estado = 'respondeu', enviado_em = now() - interval '2 days'
                WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(1)}`
    await dono`UPDATE campanha_destinatario SET estado = 'lida', enviado_em = now() - interval '20 days'
                WHERE tenant_id = ${T} AND campanha_id = ${id} AND contato_id = ${contatoId(2)}`
    const pedidoDa = async (n: number) => {
      const conv = randomUUID()
      await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${conv}, ${OFICIAL}, ${contatoId(n)}, 1)`
      const p = await comTenantServico(T, (tx) => obterOuCriarRascunho(tx, { conversaId: conv }))
      const [l] = await dono<{ campanha_id: string | null }[]>`SELECT campanha_id FROM pedido WHERE tenant_id = ${T} AND id = ${p.id}`
      return l!.campanha_id
    }
    try {
      expect(await pedidoDa(1)).toBe(id)
      expect(await pedidoDa(2)).toBeNull() // 20 dias > janela de 7
    } finally {
      await dono`DELETE FROM pedido WHERE tenant_id = ${T}`
    }
  })
})
