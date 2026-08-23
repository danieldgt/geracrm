#!/usr/bin/env node
/**
 * Gera o REFRESH TOKEN do Google Ads (passo ③ de `agencia-mkt/onboarding-google-ads.md`).
 *
 * Sem dependências: sobe um servidor local só para capturar o redirect do OAuth.
 *
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
 *     node infra/dev/gerar-refresh-token-google.mjs
 *
 * ⚠️ A tela de consentimento precisa estar em "Em produção". Com "Testing" +
 *    "External", o Google REVOGA o refresh token em 7 DIAS — e a integração
 *    quebra toda semana, sem erro claro. É a armadilha nº 1 deste passo.
 *
 * ⚠️ O que sai daqui é SEGREDO. Vai para variável de ambiente no Railway
 *    (GOOGLE_OAUTH_REFRESH_TOKEN), nunca para o repositório nem para mensagem.
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * As credenciais podem vir de duas formas. ⚠️ A do ARQUIVO é preferível: o JSON
 * que o Google Cloud baixa entra direto, sem ninguém copiar e colar segredo — e
 * o que não passa pela área de transferência não vaza em captura de tela.
 *
 *   node ... ~/.config/geracrm/google-ads-oauth.json
 *   GOOGLE_OAUTH_CREDENCIAIS=~/.config/... node ...
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node ...
 *
 * ⚠️ O arquivo mora FORA da árvore do repositório. Dentro dele, um `git add -A`
 *    distraído publica o segredo — e revogar depois do push é sempre mais caro
 *    que guardar fora desde o início.
 */
function credenciaisDoArquivo(caminho) {
  let bruto
  try {
    bruto = JSON.parse(readFileSync(caminho.replace(/^~/, process.env.HOME ?? '~'), 'utf8'))
  } catch (e) {
    console.error(`\n✗ Não consegui ler ${caminho}: ${e.message}\n`)
    process.exit(1)
  }
  // O Google embrulha em `installed` (App para computador) ou `web`.
  const dentro = bruto.installed ?? bruto.web ?? bruto
  if (!dentro.client_id || !dentro.client_secret) {
    console.error('\n✗ O JSON não tem client_id/client_secret. É o arquivo do cliente OAuth?\n')
    process.exit(1)
  }
  return { id: dentro.client_id, secret: dentro.client_secret }
}

const caminhoCred = process.argv[2] ?? process.env.GOOGLE_OAUTH_CREDENCIAIS
const doArquivo = caminhoCred ? credenciaisDoArquivo(caminhoCred) : null

const CLIENT_ID = doArquivo?.id ?? process.env.GOOGLE_OAUTH_CLIENT_ID
const CLIENT_SECRET = doArquivo?.secret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET
const PORTA = Number(process.env.PORTA_OAUTH ?? 8765)
const ESCOPO = 'https://www.googleapis.com/auth/adwords'

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n✗ Faltam as credenciais do cliente OAuth.\n')
  console.error('  Jeito recomendado — passe o JSON que o Cloud baixou:')
  console.error('    node infra/dev/gerar-refresh-token-google.mjs ~/.config/geracrm/google-ads-oauth.json\n')
  console.error('  Ou por variável de ambiente:')
  console.error('    GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node ...\n')
  console.error('  O JSON sai de console.cloud.google.com/auth/clients → o cliente → baixar.\n')
  process.exit(1)
}

const redirect = `http://localhost:${PORTA}`
// ⚠️ `state` defende contra o navegador entregar um código de outra sessão.
const state = randomBytes(16).toString('hex')

const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
url.searchParams.set('client_id', CLIENT_ID)
url.searchParams.set('redirect_uri', redirect)
url.searchParams.set('response_type', 'code')
url.searchParams.set('scope', ESCOPO)
// ⚠️ `offline` é o que faz existir refresh token; `consent` força um NOVO mesmo
//    se você já autorizou antes — sem ele, a segunda execução volta sem token.
url.searchParams.set('access_type', 'offline')
url.searchParams.set('prompt', 'consent')
url.searchParams.set('state', state)

console.log('\n① Abra este endereço no navegador, logado como o dono da MCC:\n')
console.log(`   ${url}\n`)
console.log(`② Autorize. Se aparecer "app não verificado", clique em Avançado →`)
console.log(`   "Acessar ... (não seguro)". É esperado enquanto o app não passou`)
console.log(`   por verificação — e não impede o uso pela sua própria conta.\n`)
console.log(`③ Esperando o redirect em ${redirect} ...\n`)

const servidor = createServer(async (req, res) => {
  const recebida = new URL(req.url ?? '/', redirect)
  const codigo = recebida.searchParams.get('code')
  const erro = recebida.searchParams.get('error')
  const estadoRecebido = recebida.searchParams.get('state')

  const responder = (texto) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(texto)
  }

  if (erro) {
    responder(`Autorização recusada: ${erro}. Pode fechar esta aba.`)
    console.error(`\n✗ O Google recusou: ${erro}\n`)
    servidor.close(); process.exit(1)
  }
  if (!codigo) { responder('Aguardando o retorno do Google...'); return }
  if (estadoRecebido !== state) {
    responder('Estado não confere. Rode o script de novo.')
    console.error('\n✗ `state` não confere — o código veio de outra sessão. Repita.\n')
    servidor.close(); process.exit(1)
  }

  const troca = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: codigo,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  })
  const dados = await troca.json()

  if (!troca.ok || !dados.refresh_token) {
    responder('Falhou. Veja o terminal.')
    console.error('\n✗ Não veio refresh token. Resposta do Google:\n')
    console.error(JSON.stringify(dados, null, 2))
    if (!dados.refresh_token && troca.ok) {
      console.error('\n⚠️ Autorizou, mas sem refresh token. Quase sempre é porque a conta JÁ tinha')
      console.error('   autorizado este app antes. Revogue em myaccount.google.com/permissions')
      console.error('   e rode de novo — ou confirme que `prompt=consent` está na URL.\n')
    }
    servidor.close(); process.exit(1)
  }

  responder('Pronto! O refresh token está no terminal. Pode fechar esta aba.')
  console.log('✓ Refresh token obtido.\n')
  console.log('  Guarde como variável de ambiente — ⚠️ NÃO cole em chat nem commite:\n')
  console.log(`  GOOGLE_OAUTH_REFRESH_TOKEN=${dados.refresh_token}\n`)
  console.log('  ⚠️ Se a tela de consentimento estiver em "Testing", este token morre em 7 dias.')
  console.log('     Confira em console.cloud.google.com → Tela de permissão OAuth → Publicar app.\n')
  servidor.close(); process.exit(0)
})

servidor.listen(PORTA, () => {})
