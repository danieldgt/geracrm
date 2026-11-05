import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { ACOES_TODAS_LIGADAS, normalizarTelefone } from '@geracrm/shared'
import { encerrarBanco } from '../../../../db/index.js'
import { conduzirTurnoVendedor } from '../vendedor.js'
import type { Tarefa } from '../fila.js'
import type { PortaLlmFerramentas, ResultadoLaco } from '../porta-llm.js'
import type { Ligacoes } from './ligacoes-porta.js'
import type { ContextoFerramenta } from './porta.js'
import { registroDeFerramentas } from './porta.js'
import { montarFerramentas } from './montar.js'
import { ferramentaConsultarProvaSocial, ferramentaRegistrarIndicacoes } from './pos-venda.js'
import { AVISO_NUMERO_BLOQUEADO } from '../pipeline/numeros-ampliados.js'
import { ErroIndicacoes, registrarIndicacoes } from '../../../crm/indicacao.js'
import { comTenantServico } from '../../../../db/index.js'

/**
 * FERRAMENTAS DO PÓS-VENDA (G3): `registrar_indicacoes` (cria com origem
 * "Indicação", dedupe por telefone sem vazar o existente, limite 5),
 * `consultar_prova_social` (só aprovado e vigente; número citado só com a
 * ferramenta no turno — turno de verdade, modelo falso) e as ações do playbook
 * que tiram as três do menu. Banco real; UUIDs exclusivos deste arquivo.
 */
const T = 'c3b00000-0000-4000-8000-000000000001'
const T2 = 'c3b00000-0000-4000-8000-000000000002'
const PV = 'c3b00000-1111-4000-8000-000000000001'
const PV2 = 'c3b00000-1111-4000-8000-000000000002'
const PLANO = 'c3b00000-3333-4000-8000-000000000001'
const MODELO = 'c3b00000-4444-4000-8000-000000000001'
const CANAL = 'c3b00000-5555-4000-8000-000000000001'
const CANAL2 = 'c3b00000-5555-4000-8000-000000000002'
const CONTATO = 'c3b00000-6666-4000-8000-000000000001'
const EXISTENTE = 'c3b00000-6666-4000-8000-000000000002'
const CONTATO2 = 'c3b00000-6666-4000-8000-000000000003'
const CONVERSA = 'c3b00000-7777-4000-8000-000000000001'
const CONVERSA2 = 'c3b00000-7777-4000-8000-000000000002'
const TEL = '5585999970401'
const TEL_EXISTENTE = '5585999970402'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const SEMPRE_FECHADO = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }
const hoje = () => new Date().toISOString().slice(0, 10)
const diasAtras = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

const ctx = (modo: ContextoFerramenta['modo'] = 'autonomo', tenant = T, contato = CONTATO, canal = CANAL): ContextoFerramenta => ({
  tenantId: tenant, conversaId: tenant === T ? CONVERSA : CONVERSA2, contatoId: contato, canalId: canal,
  perfil: 'varejo', sessaoId: null, modo, agora: new Date(),
})

/** Pedido de indicação ENVIADO há 1 h (A2): sessão ativa com `posVenda.indicacao` aberto. */
async function ctxComIndicacao(modo: ContextoFerramenta['modo'] = 'autonomo', tenant = T, contato = CONTATO, canal = CANAL): Promise<ContextoFerramenta> {
  const c = ctx(modo, tenant, contato, canal)
  const estado = { posVenda: { indicacao: { pedidoId: 'p-teste', em: new Date(Date.now() - 3_600_000).toISOString(), registradas: 0 } } }
  const [s] = await dono<{ id: string }[]>`
    INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, iniciada_em, motivo_entrada, modo, estado_agente)
    VALUES (${tenant}, gen_random_uuid(), ${c.conversaId}, ${canal}, now(), 'pos_venda', 'autonomo', ${JSON.stringify(estado)}::text::jsonb)
    ON CONFLICT (tenant_id, conversa_id) WHERE estado = 'ativa'
    DO UPDATE SET estado_agente = EXCLUDED.estado_agente
    RETURNING id`
  return { ...c, sessaoId: s!.id }
}

async function provaSocial(p: { texto: string; aprovado: boolean; apuradoEm?: string; tenant?: string; canal?: string | null; publicado?: boolean }): Promise<void> {
  await dono`INSERT INTO conhecimento_documento (tenant_id, id, canal_id, titulo, tipo, conteudo, versao, publicado,
                                                 fonte, link, apurado_em, prova_tipo, consentimento, aprovado)
             VALUES (${p.tenant ?? T}, gen_random_uuid(), ${p.canal ?? null}, 'Pesquisa', 'prova_social', ${p.texto}, 1, ${p.publicado ?? true},
                     'Pesquisa NPS 2026', 'https://exemplo.test/nps', ${p.apuradoEm ?? hoje()}::date, 'numero', false, ${p.aprovado})`
}

// ── turno de verdade ─────────────────────────────────────────────────────────
const enviados: string[] = []
const enviarFalso = (async (_t: string, _c: string, texto: string) => {
  enviados.push(texto)
  return { ok: true, conversaId: CONVERSA, mensagemId: crypto.randomUUID() }
}) as never
const ligacoes = async (): Promise<Ligacoes> => ({ conhecimento: { async buscar() { return { trechos: [] } } } })
function llm(mensagens: string[], chamadas: { nome: string; entrada: unknown }[] = []): PortaLlmFerramentas {
  return { nome: 'falso', capacidades: { ferramentas: true, saidaEstruturada: true, cacheDePrefixo: false },
    async rodar(p): Promise<ResultadoLaco> {
      for (const c of chamadas) await p.executar(c.nome, c.entrada)
      return { ok: true, saida: { mensagens, confianca: 0.9 }, rastro: { chamadas: [], rodadas: 1, uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 }, modelo: 'falso', latenciaMs: 1, parouPor: 'fim' } }
    } }
}
const mensagemDoCliente = async (texto: string): Promise<string> => {
  const id = crypto.randomUUID()
  await dono`INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, criado_em)
             VALUES (${T}, ${id}, ${CONVERSA}, 'entrante', 'texto', ${JSON.stringify({ texto })}::text::jsonb, now())`
  return id
}
const tarefaPara = (ids: string[]): Tarefa => ({ tenant_id: T, id: crypto.randomUUID(), conversa_id: CONVERSA, canal_id: CANAL, mensagens_ids: ids, tentativas: 1, executar_em: new Date() })
const turno = async (cliente: string, modelo: PortaLlmFerramentas) =>
  conduzirTurnoVendedor(tarefaPara([await mensagemDoCliente(cliente)]), { llm: modelo, ligacoes, enviar: enviarFalso })

beforeAll(async () => {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'plano-g3-ferramentas', 'Pro') ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'modelo-g3-ferramentas', 'Atacado') ON CONFLICT DO NOTHING`
  for (const [t, pv, nome] of [[T, PV, 'G3 Ferramentas'], [T2, PV2, 'G3 Ferramentas 2']] as const) {
    await dono.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`
      await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id) VALUES (${t}, ${nome}, ${PLANO}, ${pv}) ON CONFLICT DO NOTHING`
      await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome) VALUES (${t}, ${pv}, ${MODELO}, 'Atacado') ON CONFLICT DO NOTHING`
    })
  }
  for (const [t, c] of [[T, CANAL], [T2, CANAL2]] as const) {
    await dono`INSERT INTO canal_conectado (tenant_id, id, tipo, nome_amigavel, estado) VALUES (${t}, ${c}, 'whatsapp_nao_oficial', 'Loja', 'conectado') ON CONFLICT DO NOTHING`
    await dono`INSERT INTO canal_configuracao (tenant_id, canal_id, horario_atendimento) VALUES (${t}, ${c}, ${JSON.stringify(SEMPRE_FECHADO)}::jsonb) ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO agente_config (tenant_id, canal_id, ativo, modo, politicas, so_quando_ninguem_disponivel, exigir_ausencia_antes, persona, alcada)
             VALUES (${T}, ${CANAL}, true, 'autonomo', 'Pagamento por PIX.', false, false, '{"nome":"Lia","loja":"Loja G3"}'::jsonb, '{}'::jsonb)
             ON CONFLICT (tenant_id, canal_id) DO UPDATE SET modo = 'autonomo', ativo = true`
  for (const [t, c, nome, tel] of [[T, CONTATO, 'Ana Indicante', TEL], [T, EXISTENTE, 'Bruno Segredo', TEL_EXISTENTE], [T2, CONTATO2, 'Outra Loja', '5585999970409']] as const) {
    await dono`INSERT INTO contato (tenant_id, id, nome, ativo) VALUES (${t}, ${c}, ${nome}, true) ON CONFLICT DO NOTHING`
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${t}, ${c}, 1, ${tel}, ${normalizarTelefone(tel)!.chaveBloqueio}, true, true, 'teste') ON CONFLICT DO NOTHING`
  }
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T}, ${CONVERSA}, ${CANAL}, ${CONTATO}, 1) ON CONFLICT DO NOTHING`
  await dono`INSERT INTO conversa (tenant_id, id, canal_id, contato_id, versao) VALUES (${T2}, ${CONVERSA2}, ${CANAL2}, ${CONTATO2}, 1) ON CONFLICT DO NOTHING`
})

beforeEach(async () => {
  enviados.length = 0
  for (const t of [T, T2]) {
    for (const tab of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'notificacao', 'atendimento', 'mensagem', 'comentario', 'conhecimento_documento', 'aviso_privacidade']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`DELETE FROM contato_telefone WHERE tenant_id = ${t} AND contato_id IN (SELECT id FROM contato WHERE tenant_id = ${t} AND origem_carga = 'indicacao')`
    await dono`DELETE FROM contato WHERE tenant_id = ${t} AND origem_carga = 'indicacao'`
    await dono`DELETE FROM origem WHERE tenant_id = ${t}`
  }
  await dono`UPDATE conversa SET conduzida_por = 'humano' WHERE tenant_id = ${T}`
  await dono`INSERT INTO aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao, origem)
             VALUES (${T}, gen_random_uuid(), ${CONTATO}, ${CONVERSA}, ${CANAL}, gen_random_uuid(), 'Esta conversa fica registrada.', 'padrao', 'agente')`
})

afterAll(async () => {
  for (const t of [T, T2]) {
    for (const tab of ['agente_decisao', 'agente_tarefa', 'agente_sessao', 'agente_config', 'notificacao', 'atendimento', 'mensagem', 'comentario',
      'conhecimento_documento', 'aviso_privacidade', 'conversa', 'contato_telefone']) {
      await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    }
    await dono`UPDATE contato SET indicado_por = NULL WHERE tenant_id = ${t}`
    for (const tab of ['contato', 'origem', 'canal_configuracao', 'canal_conectado', 'outbox']) await dono.unsafe(`DELETE FROM ${tab} WHERE tenant_id = '${t}'`)
    await dono`UPDATE tenant SET perfil_vertical_id = NULL WHERE id = ${t}`
    await dono`DELETE FROM perfil_vertical WHERE tenant_id = ${t}`
    await dono`DELETE FROM tenant WHERE id = ${t}`
  }
  await dono`DELETE FROM plano WHERE id = ${PLANO}`
  await dono`DELETE FROM perfil_vertical_modelo WHERE id = ${MODELO}`
  await encerrarBanco(); await dono.end()
})

describe('registrar_indicacoes', () => {
  it('⚠️ A2: sem pedido de indicação aberto na sessão → indicacoes.nao_pedido, nada criado', async () => {
    const r = await ferramentaRegistrarIndicacoes().executar(ctx(), { indicacoes: [{ nome: 'Zé', telefone: '85999970419', observacao: null }] } as never)
    expect((r as { erro: string }).erro).toMatch(/^indicacoes\.nao_pedido/)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T} AND origem_carga = 'indicacao'`
    expect(n!.n).toBe(0)
  })

  it('cria o indicado com origem "Indicação" (criada no tenant), indicado_por e sem dono', async () => {
    const r = await ferramentaRegistrarIndicacoes().executar(await ctxComIndicacao(), { indicacoes: [{ nome: 'Carla Nova', telefone: '(85) 99997-0410', observacao: 'tem loja no Centro' }] } as never)
    expect(r).toEqual({ ok: true, saida: { itens: [{ nome: 'Carla Nova', situacao: 'registrado' }] } })
    const [c] = await dono<{ id: string; indicado_por: string; origem: string; dono: number; e164: string }[]>`
      SELECT c.id, c.indicado_por, o.nome AS origem, ct.e164,
             (SELECT count(*)::int FROM carteira_atribuicao ca WHERE ca.tenant_id = c.tenant_id AND ca.contato_id = c.id) AS dono
        FROM contato c JOIN origem o ON o.tenant_id = c.tenant_id AND o.id = c.origem_id
        JOIN contato_telefone ct ON ct.tenant_id = c.tenant_id AND ct.contato_id = c.id AND ct.principal
       WHERE c.tenant_id = ${T} AND c.nome = 'Carla Nova'`
    expect(c).toMatchObject({ indicado_por: CONTATO, origem: 'Indicação', dono: 0, e164: '+5585999970410' })
    const [com] = await dono<{ texto: string }[]>`SELECT texto FROM comentario WHERE tenant_id = ${T} AND contato_id = ${c!.id}`
    expect(com!.texto).toContain('Indicado por Ana Indicante')
  })

  it('a origem existente é reaproveitada (sem duplicar), mesmo com outra caixa', async () => {
    await dono`INSERT INTO origem (tenant_id, id, nome) VALUES (${T}, gen_random_uuid(), 'INDICAÇÃO')`
    await ferramentaRegistrarIndicacoes().executar(await ctxComIndicacao(), { indicacoes: [{ nome: 'Dora', telefone: '85999970411', observacao: null }] } as never)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM origem WHERE tenant_id = ${T}`
    expect(n!.n).toBe(1)
  })

  it('⚠️ A1: telefone já cadastrado (com ou sem o nono dígito) sai IGUAL a um novo ("registrado"), não duplica e não vaza nada', async () => {
    const r = await ferramentaRegistrarIndicacoes().executar(await ctxComIndicacao(), { indicacoes: [
      { nome: 'Fulano', telefone: '558599970402', observacao: null }, // sem o nono dígito = mesmo telefone
    ] } as never)
    expect(r).toEqual({ ok: true, saida: { itens: [{ nome: 'Fulano', situacao: 'registrado' }] } })
    expect(JSON.stringify(r)).not.toMatch(/Bruno|Segredo|c3b00000-6666-4000-8000-000000000002|cliente|cadastrad/)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T} AND origem_carga = 'indicacao'`
    expect(n!.n).toBe(0)
    const [com] = await dono<{ texto: string }[]>`SELECT texto FROM comentario WHERE tenant_id = ${T} AND contato_id = ${EXISTENTE}`
    expect(com!.texto).toContain('Indicado por Ana Indicante')
  })

  it('⚠️ B7: o dedupe olha TODOS os telefones do contato, não só o principal', async () => {
    await dono`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
               VALUES (${T}, ${EXISTENTE}, 2, '5585999970488', ${normalizarTelefone('5585999970488')!.chaveBloqueio}, false, true, 'teste')
               ON CONFLICT DO NOTHING`
    try {
      await ferramentaRegistrarIndicacoes().executar(await ctxComIndicacao(), { indicacoes: [{ nome: 'Secundário', telefone: '85999970488', observacao: null }] } as never)
      const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T} AND origem_carga = 'indicacao'`
      expect(n!.n).toBe(0)
    } finally {
      await dono`DELETE FROM contato_telefone WHERE tenant_id = ${T} AND contato_id = ${EXISTENTE} AND seq = 2`
    }
  })

  it('o próprio telefone do indicante, repetido na lista e inválido são nomeados', async () => {
    const r = await ferramentaRegistrarIndicacoes().executar(await ctxComIndicacao(), { indicacoes: [
      { nome: 'Eu mesma', telefone: TEL, observacao: null },
      { nome: 'Gil', telefone: '85999970412', observacao: null },
      { nome: 'Gil de novo', telefone: '5585999970412', observacao: null },
      { nome: 'Sem número', telefone: '12345678', observacao: null },
    ] } as never)
    expect((r as { saida: { itens: { situacao: string }[] } }).saida.itens.map((i) => i.situacao)).toEqual(['proprio_cliente', 'registrado', 'repetido', 'telefone_invalido'])
  })

  it('⚠️ mais de 5: a entrada é recusada pelo esquema (e o módulo do CRM também recusa)', async () => {
    const seis = Array.from({ length: 6 }, (_, i) => ({ nome: `P${i}`, telefone: `8599997042${i}`, observacao: null }))
    const reg = registroDeFerramentas(await ctxComIndicacao(), [ferramentaRegistrarIndicacoes()])
    const r = await reg.executar('registrar_indicacoes', { indicacoes: seis })
    expect(r).toMatchObject({ ok: false })
    expect((r as { erro: string }).erro).toMatch(/entrada inválida/)
    await expect(comTenantServico(T, (tx) => registrarIndicacoes(tx, { indicanteId: CONTATO, indicacoes: seis }))).rejects.toBeInstanceOf(ErroIndicacoes)
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T} AND origem_carga = 'indicacao'`
    expect(n!.n).toBe(0)
  })

  it('modo simulação: modo seco, nada é criado', async () => {
    const r = await ferramentaRegistrarIndicacoes().executar(await ctxComIndicacao('simulacao'), { indicacoes: [{ nome: 'Hugo', telefone: '85999970413', observacao: null }] } as never)
    expect(r).toMatchObject({ ok: true, saida: { modoSeco: true } })
    const [n] = await dono<{ n: number }[]>`SELECT count(*)::int AS n FROM contato WHERE tenant_id = ${T} AND origem_carga = 'indicacao'`
    expect(n!.n).toBe(0)
  })

  it('dois tenants: o telefone cadastrado em A é contato NOVO em B', async () => {
    const r = await ferramentaRegistrarIndicacoes().executar(await ctxComIndicacao('autonomo', T2, CONTATO2, CANAL2), { indicacoes: [{ nome: 'Ivo', telefone: TEL_EXISTENTE, observacao: null }] } as never)
    expect(r).toMatchObject({ ok: true, saida: { itens: [{ situacao: 'registrado' }] } })
    const [c] = await dono<{ tenant_id: string; indicado_por: string }[]>`SELECT tenant_id, indicado_por FROM contato WHERE nome = 'Ivo'`
    expect(c).toEqual({ tenant_id: T2, indicado_por: CONTATO2 })
  })
})

describe('consultar_prova_social', () => {
  it('⚠️ só aprovado, publicado e vigente chega à ferramenta — com fonte e data', async () => {
    await provaSocial({ texto: '98% dos clientes nos recomendam.', aprovado: true })
    await provaSocial({ texto: 'Pendente: 99% de satisfação.', aprovado: false })
    await provaSocial({ texto: 'Velha: 97% recomendam.', aprovado: true, apuradoEm: diasAtras(400) })
    await provaSocial({ texto: 'Despublicada: 96%.', aprovado: true, publicado: false })
    await provaSocial({ texto: 'De outro tenant: 95%.', aprovado: true, tenant: T2 })
    const r = await ferramentaConsultarProvaSocial().executar(ctx(), { tema: null } as never)
    expect(r).toMatchObject({ ok: true, saida: { itens: [{ texto: '98% dos clientes nos recomendam.', fonte: 'Pesquisa NPS 2026', apuradoEm: hoje(), tipo: 'numero' }] } })
    expect((r as { saida: { itens: unknown[] } }).saida.itens).toHaveLength(1)
    expect(r).toMatchObject({ percentuais: [98] })
  })

  it('sem nada aprovado: lista vazia com o aviso de não citar', async () => {
    await provaSocial({ texto: 'Pendente: 99%.', aprovado: false })
    const r = await ferramentaConsultarProvaSocial().executar(ctx(), { tema: null } as never)
    expect(r).toMatchObject({ ok: true, saida: { itens: [], aviso: expect.stringContaining('não cite') } })
  })

  it('o tema filtra pelos termos (sem acento)', async () => {
    await provaSocial({ texto: 'Entrega no prazo em 97% dos pedidos.', aprovado: true })
    await provaSocial({ texto: 'Atendimento nota 9 no Google.', aprovado: true })
    const r = await ferramentaConsultarProvaSocial().executar(ctx(), { tema: 'entregá' } as never)
    expect((r as { saida: { itens: { texto: string }[] } }).saida.itens.map((i) => i.texto)).toEqual(['Entrega no prazo em 97% dos pedidos.'])
  })

  it('⚠️ a busca comum do conhecimento NUNCA devolve prova social', async () => {
    await provaSocial({ texto: 'Recomendação de clientes: 98% recomendam a loja.', aprovado: true })
    const { buscarConhecimento } = await import('../conhecimento/busca.js')
    await dono`INSERT INTO conhecimento_trecho (tenant_id, id, documento_id, ordem, texto, texto_sem_acento, texto_hash)
               SELECT tenant_id, gen_random_uuid(), id, 0, conteudo, lower(conteudo), 'h' FROM conhecimento_documento WHERE tenant_id = ${T}`
    const r = await comTenantServico(T, (tx) => buscarConhecimento(tx, { pergunta: 'clientes recomendam', canalId: CANAL }))
    expect(r.trechos).toEqual([])
  })
})

describe('Número de prova social no turno (guardrail P7)', () => {
  it('⚠️ "98% recomendam" SEM chamar a ferramenta: a resposta não sai (aviso fixo + handoff)', async () => {
    await provaSocial({ texto: '98% dos clientes nos recomendam.', aprovado: true })
    await turno('vocês são confiáveis?', llm(['Somos sim! 98% dos clientes nos recomendam.']))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
  })

  it('com a ferramenta no MESMO turno e o item aprovado, o número sai', async () => {
    await provaSocial({ texto: '98% dos clientes nos recomendam.', aprovado: true })
    await turno('vocês são confiáveis?', llm(['Segundo a Pesquisa NPS 2026, 98% dos clientes nos recomendam.'], [{ nome: 'consultar_prova_social', entrada: { tema: null } }]))
    expect(enviados).toEqual(['Segundo a Pesquisa NPS 2026, 98% dos clientes nos recomendam.'])
  })

  it('⚠️ B1: prova social abona CONTAGEM e %, nunca prazo nem preço', async () => {
    await provaSocial({ texto: 'Mais de 1.200 lojas atendidas, entrega em 48 horas, frete de R$ 19,90.', aprovado: true })
    const r = await ferramentaConsultarProvaSocial().executar(ctx(), { tema: null } as never)
    expect(r).toMatchObject({ ok: true })
    const ok = r as unknown as { numeros: number[]; centavos?: number[] }
    expect(ok.numeros).toContain(1200)
    expect(ok.numeros).not.toContain(48)
    expect(ok.centavos ?? []).toEqual([])
    await turno('entregam rápido?', llm(['Entregamos em 48 horas.'], [{ nome: 'consultar_prova_social', entrada: { tema: null } }]))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
  })

  it('⚠️ com a ferramenta, mas o item NÃO aprovado: o número continua sem fonte e não sai', async () => {
    await provaSocial({ texto: '98% dos clientes nos recomendam.', aprovado: false })
    await turno('vocês são confiáveis?', llm(['98% dos clientes nos recomendam.'], [{ nome: 'consultar_prova_social', entrada: { tema: null } }]))
    expect(enviados).toEqual([AVISO_NUMERO_BLOQUEADO])
  })
})

describe('Ações do playbook', () => {
  const l: Ligacoes = { conhecimento: { async buscar() { return { trechos: [] } } } }
  const nomes = (acoes: typeof ACOES_TODAS_LIGADAS) => montarFerramentas({ ...l, acoes }).ferramentas.map((f) => f.nome)

  it('padrão: NPS e prova social no menu; ⚠️ indicações DESLIGADA até alguém ligar (escrita nova na base)', () => {
    expect(ACOES_TODAS_LIGADAS.indicacoes).toBe(false)
    expect(nomes(ACOES_TODAS_LIGADAS)).toEqual(expect.arrayContaining(['registrar_nps', 'consultar_prova_social']))
    expect(nomes(ACOES_TODAS_LIGADAS)).not.toContain('registrar_indicacoes')
    expect(nomes({ ...ACOES_TODAS_LIGADAS, indicacoes: true })).toContain('registrar_indicacoes')
  })

  it('⚠️ desligadas no playbook: saem do menu (o modelo não as recebe)', () => {
    const n = nomes({ ...ACOES_TODAS_LIGADAS, nps: false, indicacoes: false, provaSocial: false })
    expect(n).not.toContain('registrar_nps')
    expect(n).not.toContain('registrar_indicacoes')
    expect(n).not.toContain('consultar_prova_social')
    expect(n).toContain('atendimento_transferir')
  })

  it('cada uma desliga sozinha', () => {
    expect(nomes({ ...ACOES_TODAS_LIGADAS, indicacoes: true, provaSocial: false })).toEqual(expect.arrayContaining(['registrar_nps', 'registrar_indicacoes']))
    expect(nomes({ ...ACOES_TODAS_LIGADAS, provaSocial: false })).not.toContain('consultar_prova_social')
  })
})
