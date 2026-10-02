import postgres from 'postgres'
import { normalizarTelefone, type SkuEntrada } from '@geracrm/shared'
import { criarProdutoManual } from '../contexts/catalogo/escrita-manual.js'
import { reindexarTenant } from '../contexts/catalogo/indexador.js'

/**
 * Seed de DEMONSTRAÇÃO — o tenant "Loja Demo" com que se mostra o produto e se
 * exercita o agente vendedor sem ERP (ADR-025): três planos SaaS do GeraCRM,
 * uma dúzia de peças de roupa com grade cor × tamanho, preço de varejo e
 * atacado, saldo, e cinco contatos com telefone válido.
 *
 * ⚠️ Só roda com SEED_DEMO=on. Idempotente: tudo é ON CONFLICT DO NOTHING ou
 * "já existe → pula", então rodar duas vezes não duplica nada.
 *
 * ⚠️ Usa DATABASE_ADMIN_URL (dono). Mesmo como dono, a transação define
 * `geracrm.tenant_id`: as funções de escrita do catálogo gravam com
 * `tenant_atual()`, e é assim que o seed reaproveita o MESMO código da rota em
 * vez de duplicar o INSERT de preço/saldo.
 */
if (process.env.SEED_DEMO !== 'on') {
  console.log('seed-demo: desligado (SEED_DEMO != on) — nada a fazer')
  process.exit(0)
}

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_ADMIN_URL não definida — seed precisa da conexão de dono')

const TENANT_DEMO = '7d3e0000-0000-4000-8000-000000000001'
const PLANO = '7d3e0000-3333-4000-8000-000000000001'
const MODELO = '7d3e0000-4444-4000-8000-000000000001'
const PV = '7d3e0000-1111-4000-8000-000000000001'
const CANAL = '7d3e0000-c0c0-4000-8000-000000000001'

const sql = postgres(url, { max: 1, onnotice: () => {} })

type ProdutoSemente = {
  referencia: string; descricao: string; categoria: string; descricaoLonga: string
  skus: SkuEntrada[]
}

const centavos = (reais: number) => Math.round(reais * 100)

/** Plano SaaS: SKU por ciclo, mesmo preço nos dois perfis, sem controle de estoque. */
const plano = (referencia: string, nome: string, mensal: number, anual: number, texto: string): ProdutoSemente => ({
  referencia, descricao: nome, categoria: 'Plano SaaS', descricaoLonga: texto,
  skus: [
    { atributos: { ciclo: 'mensal' }, precos: { varejo: mensal, atacado: mensal }, saldo: null },
    { atributos: { ciclo: 'anual' }, precos: { varejo: anual, atacado: anual }, saldo: null },
  ],
})

/** Peça de roupa: grade cor × tamanho, varejo e atacado (≈ 60%), saldo por SKU. */
const peca = (
  referencia: string, descricao: string, categoria: string, texto: string,
  varejo: number, cores: string[], tamanhos: string[], saldoBase: number,
): ProdutoSemente => ({
  referencia, descricao, categoria, descricaoLonga: texto,
  skus: cores.flatMap((cor, i) => tamanhos.map((tamanho, j) => ({
    atributos: { cor, tamanho },
    precos: { varejo: centavos(varejo), atacado: centavos(varejo * 0.6) },
    saldo: Math.max(0, saldoBase - i * 3 - j * 2),
  }))),
})

const PRODUTOS: ProdutoSemente[] = [
  plano('PLANO-ESSENCIAL', 'GeraCRM Essencial', 29900, 299000,
    'Atendimento no WhatsApp com 1 número, inbox compartilhado, funil de recompra e pedido assistido. Até 3 usuários.'),
  plano('PLANO-PRO', 'GeraCRM Pro', 59900, 599000,
    'Tudo do Essencial + agente vendedor com IA, campanhas com ROI, 3 números e integração com ERP. Até 10 usuários.'),
  plano('PLANO-ENTERPRISE', 'GeraCRM Enterprise', 129900, 1299000,
    'Tudo do Pro + números ilimitados, white-label, SLA de suporte e onboarding assistido. Usuários ilimitados.'),

  peca('CAM-BASICA', 'Camiseta básica algodão', 'Camisetas',
    'Camiseta 100% algodão penteado, gola careca, modelagem regular. Peça de giro rápido.',
    49.9, ['BRANCO', 'PRETO', 'VERDE'], ['P', 'M', 'G', 'GG'], 40),
  peca('CAM-ESTAMPADA', 'Camiseta estampada', 'Camisetas',
    'Camiseta com estampa frontal em silk, malha 30.1. Estampas sortidas por cor.',
    59.9, ['AZUL', 'VERMELHO'], ['M', 'G', 'GG'], 25),
  peca('CALCA-JEANS', 'Calça jeans skinny', 'Calças',
    'Jeans com elastano, cintura alta, lavagem média. Numeração 36 a 44.',
    159.9, ['AZUL', 'PRETO'], ['38', '40', '42'], 18),
  peca('CALCA-ALFAIATARIA', 'Calça alfaiataria', 'Calças',
    'Calça de alfaiataria em crepe, pantalona, com forro. Ideal para trabalho.',
    189.9, ['BEGE', 'PRETO'], ['P', 'M', 'G'], 12),
  peca('VEST-MIDI', 'Vestido midi floral', 'Vestidos',
    'Vestido midi em viscose estampada, alças finas, fenda lateral.',
    139.9, ['VERDE', 'ROSA'], ['P', 'M', 'G'], 15),
  peca('VEST-LONGO', 'Vestido longo festa', 'Vestidos',
    'Vestido longo em cetim, decote V, para festa e formatura.',
    299.9, ['VINHO', 'AZUL'], ['P', 'M', 'G'], 6),
  peca('JAQ-JEANS', 'Jaqueta jeans', 'Jaquetas',
    'Jaqueta jeans clássica com botões, lavagem clara, modelagem oversized.',
    219.9, ['AZUL'], ['P', 'M', 'G', 'GG'], 10),
  peca('JAQ-COURO', 'Jaqueta couro sintético', 'Jaquetas',
    'Jaqueta estilo biker em couro sintético, forro em cetim, zíperes metálicos.',
    259.9, ['PRETO', 'MARROM'], ['M', 'G', 'GG'], 8),
  peca('MOL-CANGURU', 'Moletom canguru', 'Moletons',
    'Moletom com capuz e bolso canguru, flanelado por dentro. Unissex.',
    129.9, ['CINZA', 'PRETO', 'VERDE'], ['P', 'M', 'G'], 20),
  peca('SAIA-PLISSADA', 'Saia plissada', 'Saias',
    'Saia midi plissada em poliéster, cós elástico, caimento leve.',
    99.9, ['PRETO', 'ROSA'], ['P', 'M', 'G'], 14),
  peca('SHORT-LINHO', 'Short linho', 'Shorts',
    'Short de linho com cordão, bolsos laterais, ideal para o verão.',
    89.9, ['BEGE', 'BRANCO'], ['P', 'M', 'G'], 16),
  peca('BLUSA-CROPPED', 'Blusa cropped canelada', 'Blusas',
    'Cropped em malha canelada com elastano, manga curta.',
    44.9, ['PRETO', 'BRANCO', 'VERDE'], ['P', 'M'], 30),
]

const CONTATOS: { id: string; nome: string; modalidade: string; telefone: string }[] = [
  { id: '7d3e0000-5555-4000-8000-000000000001', nome: 'Ana Beatriz Lima', modalidade: 'varejo', telefone: '85 99901 0001' },
  { id: '7d3e0000-5555-4000-8000-000000000002', nome: 'Boutique da Carla', modalidade: 'atacado', telefone: '11 99902 0002' },
  { id: '7d3e0000-5555-4000-8000-000000000003', nome: 'Diego Nascimento', modalidade: 'varejo', telefone: '21 99903 0003' },
  { id: '7d3e0000-5555-4000-8000-000000000004', nome: 'Loja Elo Moda', modalidade: 'atacado', telefone: '31 99904 0004' },
  { id: '7d3e0000-5555-4000-8000-000000000005', nome: 'Fernanda Souza', modalidade: 'varejo', telefone: '81 99905 0005' },
]

try {
  await sql`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'demo', 'Demo') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'varejo-demo', 'Varejo') ON CONFLICT DO NOTHING`

  // tenant e perfil_vertical se referenciam — constraints DEFERRED na mesma tx.
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${TENANT_DEMO}, 'Loja Demo', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${TENANT_DEMO}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })

  // Canal não-oficial "conectado" SEM credenciais: serve para a tela e para o
  // agente; nada sai de verdade por ele (como em seed-dogfooding.ts).
  await sql`INSERT INTO canal_conectado (tenant_id, id, tipo, provedor, nome_amigavel, estado)
            VALUES (${TENANT_DEMO}, ${CANAL}, 'whatsapp_nao_oficial', 'plugzapi', 'WhatsApp Loja Demo', 'conectado')
            ON CONFLICT DO NOTHING`

  let criados = 0
  let existentes = 0
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('geracrm.tenant_id', ${TENANT_DEMO}, true)`
    for (const p of PRODUTOS) {
      const r = await criarProdutoManual(tx as never, p)
      if (r.ok) criados += 1
      else if (r.falha.erro === 'catalogo.referencia_duplicada') existentes += 1
      else throw new Error(`seed-demo: ${p.referencia}: ${r.falha.erro}`)
    }
    const indice = await reindexarTenant(tx as never, { tenantId: TENANT_DEMO, lote: 100 })
    console.log(`seed-demo: catálogo — ${criados} produto(s) criado(s), ${existentes} já existiam; índice ${JSON.stringify(indice)}`)
  })

  for (const c of CONTATOS) {
    const tel = normalizarTelefone(c.telefone)
    if (!tel) throw new Error(`seed-demo: telefone inválido no seed: ${c.telefone}`)
    await sql`INSERT INTO contato (tenant_id, id, nome, modalidade, origem_carga, ativo)
              VALUES (${TENANT_DEMO}, ${c.id}, ${c.nome}, ${c.modalidade}, 'seed-demo', true)
              ON CONFLICT DO NOTHING`
    await sql`INSERT INTO contato_telefone (tenant_id, contato_id, seq, e164, chave_bloqueio, principal, whatsapp, fonte)
              VALUES (${TENANT_DEMO}, ${c.id}, 1, ${tel.e164}, ${tel.chaveBloqueio}, true, true, 'seed-demo')
              ON CONFLICT DO NOTHING`
  }
  console.log(`seed-demo: ${CONTATOS.length} contato(s) garantido(s)`)

  const [c] = await sql<{ tenant_id: string; estado: string }[]>`
    SELECT tenant_id, estado FROM tenant_do_canal(${CANAL}::uuid)`
  if (!c) throw new Error('seed rodou mas tenant_do_canal() não resolve o canal — algo ficou inconsistente')
  console.log(`seed-demo: tenant ${TENANT_DEMO} ("Loja Demo") pronto, canal ${CANAL} ${c.estado}`)
} catch (erro) {
  console.error('\n✗ seed-demo falhou\n')
  console.error(erro instanceof Error ? erro.message : erro)
  process.exitCode = 1
} finally {
  await sql.end()
}
