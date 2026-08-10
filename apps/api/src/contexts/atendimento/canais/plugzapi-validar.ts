/**
 * Validação ao vivo do envio PlugZapi — contra a instância real.
 *
 * ⚠️ Credenciais SÓ por ambiente, nunca em arquivo (são de um WhatsApp real).
 *
 * Uso:
 *   PLUGZAPI_INSTANCIA=... PLUGZAPI_TOKEN=... PLUGZAPI_CLIENT_TOKEN=... \
 *   DESTINO=5581999999999 [MENSAGEM="Teste GeraCRM"] \
 *   pnpm --filter @geracrm/api plugzapi:validar
 */
import { CanalPlugZapi } from './plugzapi.js'

const instancia = process.env.PLUGZAPI_INSTANCIA ?? ''
const token = process.env.PLUGZAPI_TOKEN ?? ''
const clientToken = process.env.PLUGZAPI_CLIENT_TOKEN ?? ''
const destino = process.env.DESTINO ?? ''
const mensagem = process.env.MENSAGEM ?? 'Teste GeraCRM ✅ (canal não-oficial via PlugZapi)'

if (!instancia || !token) {
  console.error('Faltam PLUGZAPI_INSTANCIA e PLUGZAPI_TOKEN.')
  process.exit(1)
}
// ⚠️ Client-Token é opcional — só as contas com "Account security token" ligado.
if (!clientToken) console.log('(sem PLUGZAPI_CLIENT_TOKEN — ok se a conta não exigir)')

async function run() {
  const canal = new CanalPlugZapi(clientToken ? { instancia, token, clientToken } : { instancia, token })

  console.log('▶ Status da instância…')
  const st = await canal.status()
  console.log(`  conectado: ${st.conectado}${st.detalhe ? ` (${st.detalhe})` : ''}`)

  if (!destino) {
    console.log('\n⚠️ Sem DESTINO — só chequei o status. Passe DESTINO=55DDNXXXXXXXX para enviar.')
    return
  }

  console.log(`\n▶ Enviando para ${destino}…`)
  const r = await canal.enviarTexto(destino, mensagem)
  if (r.ok) {
    console.log(`  ✅ enviado — id: ${r.idExterno}`)
  } else {
    console.log(`  ❌ falhou: ${r.motivo}${r.detalhe ? ` (${r.detalhe})` : ''}`)
  }
}
run().catch((e) => { console.error(`❌ ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
