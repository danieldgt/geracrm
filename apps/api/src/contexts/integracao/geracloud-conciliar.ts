/**
 * Conciliação da carga do GeraCloud — critério de saída nº 1 da Onda 0.
 *
 * ⚠️ Importar não é migrar. A contagem de linhas não prova nada; linha
 * importada errada também conta. Esta rotina compara o que ENTROU contra o que
 * o ERP DIZ pelo relatório de faturamento (`/dashboards/faturamento-geral`) —
 * fonte DIFERENTE do `/vendas` que alimentou a carga.
 *
 * O faturamento do GeraCloud é do ANO CORRENTE (jan→hoje). Por isso a carga aqui
 * é `DESDE` 1º de janeiro do ano: comparar o total do ano com o faturamento do
 * ano. Só valor — o relatório não dá contagem, e valor é o que mais importa.
 *
 * Uso:
 *   GERACLOUD_BASE_URL=... GERACLOUD_USUARIO=... GERACLOUD_SENHA=... \
 *   [ANO=2026] pnpm --filter @geracrm/api geracloud:conciliar
 */
import postgres from 'postgres'
import { ConectorGeraCloud, autenticarGeraCloud, type Autenticado } from '@geracrm/conectores'
import { ingerirVendas } from './ingestao-vendas.js'
import { conciliarVendas } from './conciliacao.js'

const base = (process.env.GERACLOUD_BASE_URL ?? '').replace(/\/+$/, '')
const usuario = process.env.GERACLOUD_USUARIO ?? ''
const senha = process.env.GERACLOUD_SENHA ?? ''
// ⚠️ O ano é passado explícito (Date.now() não está disponível em alguns
//    contextos e o ano do faturamento é o corrente do SERVIDOR). Default 2026.
const ano = Number(process.env.ANO ?? 2026)

if (!base || !usuario || !senha) {
  console.error('Faltam GERACLOUD_BASE_URL, GERACLOUD_USUARIO e GERACLOUD_SENHA.')
  process.exit(1)
}

const TENANT = '6e7a0d00-0000-4000-8000-000000000001'
const CONEXAO = '6e7a0d00-2222-4000-8000-000000000001'
const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 4, onnotice: () => {} })

function provedorDeToken(): () => Promise<string> {
  let sessao: Autenticado | null = null
  let expiraEmMs = 0
  return async () => {
    if (sessao && Date.now() < expiraEmMs - 30_000) return sessao.accessToken
    const auth = await autenticarGeraCloud({ baseUrl: base, usuario, senha }, fetch)
    if (!auth.ok) throw new Error(`login falhou: ${auth.motivo}`)
    sessao = auth.sessao
    expiraEmMs = Date.now() + auth.sessao.expiraEm * 1000
    return sessao.accessToken
  }
}

async function conciliar() {
  console.log(`\n🔐 Autenticando…`)
  const obterToken = provedorDeToken()
  await obterToken()
  const conector = new ConectorGeraCloud({ baseUrl: base, obterToken, timeoutMs: 30_000 })
  console.log('✅ ok\n')

  const inicioDoAno = new Date(Date.UTC(ano, 0, 1))
  const agora = new Date()

  // 1. Garante que as vendas do ano corrente estão carregadas (aditivo).
  console.log(`▶ Carregando vendas de ${ano} (para bater com o faturamento do ano)…`)
  const rv = await dono.begin((tx) =>
    ingerirVendas(tx as never, TENANT, CONEXAO, conector, inicioDoAno))
  console.log(`  importadas=${rv.importadas} canceladas=${rv.canceladas} ` +
    `jáExistiam=${rv.jaExistiam} total válido=R$ ${(rv.valorTotalCentavos / 100).toFixed(2)}\n`)

  // 2. Pergunta ao ERP o faturamento do ano — a fonte de verdade.
  console.log('▶ Consultando o faturamento que o ERP considera verdade…')
  const faturamentoErpCentavos = await conector.consultarFaturamentoAnualCentavos([])
  console.log(`  ERP diz: R$ ${(faturamentoErpCentavos / 100).toFixed(2)} (todas as lojas, ${ano})\n`)

  // 3. Concilia por VALOR (o relatório não dá contagem).
  console.log('▶ Conciliando…')
  const [resultado] = await dono.begin((tx) => conciliarVendas(tx as never, TENANT, CONEXAO, [
    { periodoDe: inicioDoAno, periodoAte: agora, valorCentavos: faturamentoErpCentavos },
  ]))

  const rez = resultado!
  // GeraCRM = ERP − divergência (divergência = ERP − nosso).
  const nossoCentavos = faturamentoErpCentavos - rez.divergenciaValorCentavos
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ERP:       R$ ${(faturamentoErpCentavos / 100).toFixed(2)}`)
  console.log(`  GeraCRM:   R$ ${(nossoCentavos / 100).toFixed(2)}`)
  console.log(`  Diferença: R$ ${(rez.divergenciaValorCentavos / 100).toFixed(2)}`)
  console.log(`  Estado: ${rez.estado.toUpperCase()}`)
  console.log('═'.repeat(60))

  if (rez.bate) {
    console.log('\n✅ Bateu. ⚠️ Ainda "pendente": conferir é ato de PESSOA — alguém aceita a apuração.')
  } else {
    console.log('\n⚠️ DIVERGENTE. Causas prováveis nesta demo:')
    console.log('  · faturamento conta pagamento/liquidez, venda conta emissão — janelas diferentes;')
    console.log('  · vendas sem cliente entram no nosso total mas o relatório pode agrupar diferente;')
    console.log('  · a divergência é o PRODUTO da conciliação, não um bug — é o que se investiga.')
  }

  const divs = await dono<{ codigo: string; valor_erp: string; valor_geracrm: string }[]>`
    SELECT d.codigo, d.valor_erp, d.valor_geracrm
      FROM conciliacao_divergencia d
      JOIN conciliacao c ON c.tenant_id = d.tenant_id AND c.id = d.conciliacao_id
     WHERE d.tenant_id = ${TENANT} AND c.periodo_de = ${inicioDoAno}`
  if (divs.length) {
    console.log('\nDivergências registradas (consultáveis, com dono possível):')
    for (const d of divs) console.log(`  ${d.codigo}: ERP=${d.valor_erp} GeraCRM=${d.valor_geracrm}`)
  }

  await dono.end()
}

conciliar().catch(async (e) => {
  console.error(`\n❌ ${e instanceof Error ? e.stack : String(e)}`)
  await dono.end()
  process.exit(1)
})
