/**
 * Carga de preços do GeraCloud para o tenant de dogfooding.
 *
 * Uso:
 *   GERACLOUD_BASE_URL=... GERACLOUD_USUARIO=... GERACLOUD_SENHA=... \
 *   pnpm --filter @geracrm/api geracloud:precos
 */
import postgres from 'postgres'
import { ConectorGeraCloud, autenticarGeraCloud, type Autenticado } from '@geracrm/conectores'
import { ingerirPrecos, ingerirSaldos } from './ingestao-precos.js'

const base = (process.env.GERACLOUD_BASE_URL ?? '').replace(/\/+$/, '')
const usuario = process.env.GERACLOUD_USUARIO ?? ''
const senha = process.env.GERACLOUD_SENHA ?? ''
if (!base || !usuario || !senha) { console.error('Faltam GERACLOUD_*.'); process.exit(1) }

const TENANT = '6e7a0d00-0000-4000-8000-000000000001'
const CONEXAO = '6e7a0d00-2222-4000-8000-000000000001'
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 3, onnotice: () => {} })

function provedorDeToken(): () => Promise<string> {
  let sessao: Autenticado | null = null
  let expiraEmMs = 0
  return async () => {
    if (sessao && Date.now() < expiraEmMs - 30_000) return sessao.accessToken
    const auth = await autenticarGeraCloud({ baseUrl: base, usuario, senha }, fetch)
    if (!auth.ok) throw new Error(`login: ${auth.motivo}`)
    sessao = auth.sessao; expiraEmMs = Date.now() + auth.sessao.expiraEm * 1000
    return sessao.accessToken
  }
}

const maxPaginasSaldo = Number(process.env.MAX_PAGINAS_SALDO ?? 5) || undefined

async function run() {
  console.log('\n🔐 Autenticando…')
  const conector = new ConectorGeraCloud({ baseUrl: base, obterToken: provedorDeToken(), timeoutMs: 30_000 })

  // ⚠️ PULAR_PRECOS=1 quando o preço já foi carregado — evita reprocessar as
  //    tabelas (lento) só para atualizar o saldo.
  if (process.env.PULAR_PRECOS !== '1') {
    console.log('✅ ok\n▶ Preços (tabela padrão + varejo)…')
    const r = await dono.begin((tx) => ingerirPrecos(tx as never, TENANT, CONEXAO, conector))
    console.log(`  tabelas no ERP: ${r.tabelas} | SKUs com preço: ${r.skusComPreco} | preços gravados: ${r.precosGravados}`)
    for (const t of r.tabelasProcessadas) {
      console.log(`   · ${t.descricao}${t.padrao ? ' (padrão)' : ''}: ${t.skus} SKUs precificados`)
    }
  } else {
    console.log('✅ ok (preços pulados)')
  }

  console.log('\n▶ Saldo (soma entre lojas)…')
  const opc = maxPaginasSaldo ? { maxPaginas: maxPaginasSaldo } : {}
  const rs = await dono.begin((tx) => ingerirSaldos(tx as never, TENANT, CONEXAO, conector, opc))
  console.log(`  linhas de estoque: ${rs.lidos} | SKUs com saldo: ${rs.skusComSaldo}`)
  console.log('\n✅ Concluído.')
  await dono.end()
}
run().catch(async (e) => { console.error(`❌ ${e instanceof Error ? e.stack : e}`); await dono.end(); process.exit(1) })
