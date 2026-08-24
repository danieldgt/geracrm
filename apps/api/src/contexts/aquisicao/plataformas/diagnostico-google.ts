/**
 * A PRIMEIRA CHAMADA REAL ao Google Ads — o diagnóstico que a documentação não deu.
 *
 * Responde, com fato em vez de leitura de página, o que o nível de acesso
 * **"Acesso às Análises"** permite (`agencia-mkt/onboarding-google-ads.md`).
 *
 *   pnpm --filter @geracrm/api exec tsx \
 *     src/contexts/aquisicao/plataformas/diagnostico-google.ts [caminho-do-json]
 *
 * ⚠️ Lê credencial de ARQUIVO ou de variável de ambiente, e **nunca imprime
 *    segredo** — só o que dá para conferir sem vazar.
 */
import { readFileSync } from 'node:fs'
import { PlataformaGoogleAds } from './google-ads.js'
import { ProvedorTokenGoogle } from './google-oauth.js'

const caminho = (process.argv[2] ?? `${process.env.HOME}/.config/geracrm/google-ads-oauth.json`)
  .replace(/^~/, process.env.HOME ?? '~')

let cfg: Record<string, string>
try {
  const bruto = JSON.parse(readFileSync(caminho, 'utf8')) as Record<string, Record<string, string>>
  cfg = bruto.installed ?? bruto.web ?? (bruto as unknown as Record<string, string>)
} catch {
  cfg = {
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? '',
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '',
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? '',
  }
}

const faltando = ['client_id', 'client_secret', 'refresh_token', 'developer_token', 'login_customer_id']
  .filter((k) => !cfg[k])
if (faltando.length) {
  console.error(`\n✗ Faltam no arquivo/ambiente: ${faltando.join(', ')}\n`)
  process.exit(1)
}

const mcc = cfg.login_customer_id!.replace(/\D/g, '')
const contaAlvo = process.env.CONTA_ALVO?.replace(/\D/g, '') ?? mcc

const provedor = new ProvedorTokenGoogle({
  clientId: cfg.client_id!, clientSecret: cfg.client_secret!, refreshToken: cfg.refresh_token!,
})
const google = new PlataformaGoogleAds({
  developerToken: cfg.developer_token!,
  loginCustomerId: mcc,
  obterAccessToken: () => provedor.obter(),
})

console.log(`\n▸ MCC ${mcc} · conta alvo ${contaAlvo} · API ${process.env.GOOGLE_ADS_API_VERSION ?? 'v25 (padrão)'}\n`)

process.stdout.write('① Trocando refresh token por access token ... ')
const acesso = await provedor.obter()
if (!acesso.ok) {
  console.log('✗')
  console.error(`\n   motivo: ${acesso.motivo}`)
  console.error(`   ${acesso.detalhe ?? ''}\n`)
  process.exit(1)
}
console.log(`✓ (token de ${acesso.dados.length} chars, não impresso)`)

process.stdout.write('② Consultando a MCC (conta de produção) ....... ')
const conexao = await google.testarConexao()
if (!conexao.ok) {
  console.log('✗')
  console.error(`\n   motivo: ${conexao.motivo}`)
  console.error(`   ${(conexao.detalhe ?? '').slice(0, 400)}\n`)
  console.error('   ⚠️ Se o motivo for `sem_permissao`, o nível NÃO alcança produção —')
  console.error('      e aí o Basic (passo ④) vira necessário antes da Fase 0.\n')
  process.exit(1)
}
console.log('✓')
console.log(`   conta: "${conexao.dados.nomeConta}" · moeda: ${conexao.dados.moeda}`)

process.stdout.write('③ Lendo estrutura da conta alvo .............. ')
const estrutura = await google.lerEstrutura(contaAlvo)
if (!estrutura.ok) {
  console.log('✗')
  console.error(`\n   motivo: ${estrutura.motivo}`)
  console.error(`   ${(estrutura.detalhe ?? '').slice(0, 400)}\n`)
} else {
  const { campanhas, conjuntos, anuncios } = estrutura.dados
  console.log('✓')
  console.log(`   ${campanhas.length} campanha(s) · ${conjuntos.length} conjunto(s) · ${anuncios.length} anúncio(s)`)
}

const hoje = new Date().toISOString().slice(0, 10)
const trintaDias = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
process.stdout.write('④ Lendo métricas dos últimos 30 dias ......... ')
const metricas = await google.lerMetricas(contaAlvo, { de: trintaDias, ate: hoje })
if (!metricas.ok) {
  console.log('✗')
  console.error(`\n   motivo: ${metricas.motivo}`)
  console.error(`   ${(metricas.detalhe ?? '').slice(0, 400)}\n`)
} else {
  const custo = metricas.dados.reduce((s, m) => s + m.custoCentavos, 0)
  console.log('✓')
  console.log(`   ${metricas.dados.length} linha(s) · custo total R$ ${(custo / 100).toFixed(2)}`)
}

console.log('\n▸ Conclusão: se ② passou, o nível de acesso ALCANÇA CONTA DE PRODUÇÃO.\n')
