/**
 * Carga real do GeraCloud para o tenant de dogfooding (ADR-015).
 *
 * ⚠️ RODAR SÓ DEPOIS de `geracloud:explorar` confirmar a forma das respostas.
 * Uma carga contra parser adivinhado grava lixo que "parece importado" — e a
 * conciliação vai gritar, mas depois de gastar a carga inteira.
 *
 * O que faz, em ordem:
 *   1. autentica no Keycloak (com refresh — carga longa passa dos 5 min do token)
 *   2. garante um tenant e uma conexao_erp de dogfooding
 *   3. ingere clientes → produtos → vendas (cada um em sua transação)
 *   4. concilia vendas do período contra o total que o ERP informa
 *
 * ⚠️ Roda como DONO do banco: ingestão é worker, não requisição de usuário —
 * não tem tenant de sessão. O isolamento vem do tenantId passado explicitamente.
 *
 * Uso (credenciais por ambiente, nunca em arquivo):
 *   GERACLOUD_BASE_URL=https://apresentacao.geracloud.com.br/pdvcore/api/v1 \
 *   GERACLOUD_USUARIO=... GERACLOUD_SENHA=... \
 *   [DESDE=2024-01-01] [MAX_PAGINAS=3] \
 *   pnpm --filter @geracrm/api geracloud:carregar
 */

import postgres from 'postgres'
import {
  ConectorGeraCloud, autenticarGeraCloud, type Autenticado,
} from '@geracrm/conectores'
import { ingerirClientes } from './ingestao-clientes.js'
import { ingerirProdutos } from './ingestao-produtos.js'
import { ingerirVendas } from './ingestao-vendas.js'
import { registrarOperacao } from './operacao.js'

const base = (process.env.GERACLOUD_BASE_URL ?? '').replace(/\/+$/, '')
const usuario = process.env.GERACLOUD_USUARIO ?? ''
const senha = process.env.GERACLOUD_SENHA ?? ''
const desde = new Date(process.env.DESDE ?? '2024-01-01')
// ⚠️ Limite de páginas por padrão: a PRIMEIRA carga é uma amostra para conferir
//    o parsing com volume real, não a base inteira. Tire o teto (MAX_PAGINAS=0)
//    só depois que a amostra reconciliar.
const maxPaginasNum = Number(process.env.MAX_PAGINAS ?? 3) || 0
// ⚠️ Objeto montado condicionalmente: com exactOptionalPropertyTypes, passar
//    `maxPaginas: undefined` é diferente de omitir. Omitir = base inteira.
const opcoesPagina: { maxPaginas?: number } = maxPaginasNum > 0 ? { maxPaginas: maxPaginasNum } : {}

if (!base || !usuario || !senha) {
  console.error('Faltam GERACLOUD_BASE_URL, GERACLOUD_USUARIO e GERACLOUD_SENHA no ambiente.')
  process.exit(1)
}

// Tenant fixo de dogfooding — reusado entre execuções para a carga ser aditiva.
const TENANT = '6e7a0d00-0000-4000-8000-000000000001'
const PLANO = '6e7a0d00-3333-4000-8000-000000000001'
const MODELO = '6e7a0d00-4444-4000-8000-000000000001'
const PV = '6e7a0d00-1111-4000-8000-000000000001'
const CONEXAO = '6e7a0d00-2222-4000-8000-000000000001'

const dono = postgres(process.env.DATABASE_ADMIN_URL!, { max: 4, onnotice: () => {} })

/**
 * Provedor de token com cache e renovação.
 *
 * ⚠️ Renova ANTES de expirar (margem de 30s), não depois de tomar 401 — um 401
 * no meio de uma página perderia a página. O token vale ~5 min; a carga passa
 * disso, então isto não é otimização, é o que impede a carga de morrer no meio.
 */
function provedorDeToken(): () => Promise<string> {
  let sessao: Autenticado | null = null
  let expiraEmMs = 0
  return async () => {
    const agora = Date.now()
    if (sessao && agora < expiraEmMs - 30_000) return sessao.accessToken
    const auth = await autenticarGeraCloud({ baseUrl: base, usuario, senha }, fetch)
    if (!auth.ok) throw new Error(`login falhou: ${auth.motivo}`)
    sessao = auth.sessao
    expiraEmMs = agora + auth.sessao.expiraEm * 1000
    return sessao.accessToken
  }
}

async function garantirTenant() {
  await dono`INSERT INTO plano (id, codigo, nome) VALUES (${PLANO}, 'dogfooding', 'Dogfooding')
             ON CONFLICT DO NOTHING`
  await dono`INSERT INTO perfil_vertical_modelo (id, codigo, nome) VALUES (${MODELO}, 'varejo-dogfooding', 'Varejo')
             ON CONFLICT DO NOTHING`
  await dono.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`
    await tx`INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id)
             VALUES (${TENANT}, 'Gera3 (dogfooding)', ${PLANO}, ${PV}) ON CONFLICT DO NOTHING`
    await tx`INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
             VALUES (${TENANT}, ${PV}, ${MODELO}, 'Varejo') ON CONFLICT DO NOTHING`
  })
  await dono`INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel, fonte_de_venda, estado)
             VALUES (${TENANT}, ${CONEXAO}, 'geracloud', 'GeraCloud (apresentação)', true, 'ativa')
             ON CONFLICT DO NOTHING`
}

async function carregar() {
  console.log(`\n🔐 Autenticando em ${base}…`)
  const obterToken = provedorDeToken()
  await obterToken() // falha cedo se a credencial estiver errada
  console.log('✅ Login ok\n')

  const conector = new ConectorGeraCloud({
    baseUrl: base,
    obterToken,
    // ⚠️ Timeout maior que os 2s do pedido ao vivo: aqui é carga, não tela de
    //    venda — a pessoa não está esperando, e páginas grandes demoram mais.
    timeoutMs: 30_000,
  })

  await garantirTenant()
  console.log(`📦 Tenant de dogfooding pronto. Carga desde ${desde.toISOString().slice(0, 10)}` +
    `${maxPaginasNum ? `, até ${maxPaginasNum} página(s) por recurso (amostra)` : ', base inteira'}\n`)

  // ⚠️ Ordem importa: clientes e produtos ANTES de vendas. A venda referencia o
  //    contato e o SKU por identidade externa — sem eles, toda venda entra como
  //    "sem contato" e o RFV fica vazio.
  console.log('▶ Clientes…')
  const rc = await dono.begin((tx) =>
    ingerirClientes(tx as never, TENANT, CONEXAO, conector, opcoesPagina))
  console.log(`  ${JSON.stringify(rc)}\n`)
  await registrarOperacao(dono as never, { tenantId: TENANT, conexaoId: CONEXAO, fluxo: 'customers',
    total: rc.lidos, aceitos: rc.lidos - rc.rejeitados, rejeitados: rc.rejeitados, rejeicoes: rc.rejeicoes })

  console.log('▶ Produtos…')
  const rp = await dono.begin((tx) =>
    ingerirProdutos(tx as never, TENANT, CONEXAO, conector, opcoesPagina))
  console.log(`  ${JSON.stringify(rp)}\n`)
  await registrarOperacao(dono as never, { tenantId: TENANT, conexaoId: CONEXAO, fluxo: 'products',
    total: rp.lidos, aceitos: rp.lidos - rp.rejeitados, rejeitados: rp.rejeitados, rejeicoes: rp.rejeicoes })

  console.log('▶ Vendas…')
  const rv = await dono.begin((tx) =>
    ingerirVendas(tx as never, TENANT, CONEXAO, conector, desde, opcoesPagina))
  console.log(`  importadas=${rv.importadas} canceladas=${rv.canceladas} ` +
    `semContato=${rv.semContato} rejeitadas=${rv.rejeitadas} ` +
    `total válido=R$ ${(rv.valorTotalCentavos / 100).toFixed(2)}`)
  if (rv.rejeicoes.length) {
    console.log(`  ⚠️ amostra de rejeições: ${JSON.stringify(rv.rejeicoes.slice(0, 5))}`)
  }
  await registrarOperacao(dono as never, { tenantId: TENANT, conexaoId: CONEXAO, fluxo: 'orders',
    total: rv.lidos, aceitos: rv.importadas, rejeitados: rv.rejeitadas, rejeicoes: rv.rejeicoes })
  // ⚠️ semContato alto não é sempre "balcão": pode ser venda referenciando
  //    cliente fora da lista importada. Se quase toda venda é semContato, os
  //    dois conjuntos podem não se cruzar — e aí o RFV nasce vazio por dado,
  //    não por bug.
  if (rv.importadas > 0 && rv.semContato === rv.importadas) {
    console.log('  ⚠️ TODAS as vendas ficaram sem contato: as vendas referenciam ' +
      'clientes que não estão na base de clientes importada. O RFV não terá o que mostrar.')
  }
  console.log()

  // Atualiza a view de métricas para o RFV refletir a carga.
  await dono`SELECT atualizar_metricas_contato()`

  console.log('▶ Métricas por cliente (amostra, maiores compradores):')
  // ⚠️ Leio a MV direto como DONO e filtrando por tenant. A view materializada
  //    não tem RLS (é limitação do Postgres); o acesso da aplicação passa pela
  //    view metricas_contato com security_barrier — mas isto aqui é worker.
  const metricas = await dono<{ qtd: string; total: string; confiavel: boolean }[]>`
    SELECT qtd_vendas::text AS qtd, total_centavos::text AS total, confiavel
      FROM mv_metricas_contato WHERE tenant_id = ${TENANT}
     ORDER BY total_centavos DESC LIMIT 5`
  for (const m of metricas) {
    console.log(`  ${m.qtd} compras · R$ ${(Number(m.total) / 100).toFixed(2)}` +
      `${m.confiavel ? '' : ' (RFV estimado — histórico anterior à carga)'}`)
  }

  console.log('\n✅ Carga concluída.')
  console.log('⚠️ Próximo passo: conciliar contra o relatório que o ERP considera verdade — ' +
    'a contagem de linhas não prova que está certo. Rode a conciliação com os ' +
    'totais do relatório do GeraCloud (não do mesmo endpoint que importamos).')

  await dono.end()
}

carregar().catch(async (e) => {
  console.error(`\n❌ ${e instanceof Error ? e.stack : String(e)}`)
  await dono.end()
  process.exit(1)
})
