/**
 * Sonda focada: detalhe de venda (itens) e faturamento do ERP (conciliação).
 *
 * ⚠️ NÃO grava nada. Confirma a forma REAL de `/vendas/{id}` (que traz
 * `itemVendas`, ausente na listagem) e de `POST /dashboards/faturamento-geral`
 * — o relatório que o ERP considera verdade, base da conciliação.
 *
 * Uso:
 *   GERACLOUD_BASE_URL=... GERACLOUD_USUARIO=... GERACLOUD_SENHA=... \
 *   pnpm --filter @geracrm/api geracloud:explorar-detalhe
 */
import { autenticarGeraCloud } from '@geracrm/conectores'

const base = (process.env.GERACLOUD_BASE_URL ?? '').replace(/\/+$/, '')
const usuario = process.env.GERACLOUD_USUARIO ?? ''
const senha = process.env.GERACLOUD_SENHA ?? ''
if (!base || !usuario || !senha) { console.error('Faltam variáveis GERACLOUD_*.'); process.exit(1) }

function mascarar(chave: string, valor: unknown): unknown {
  if (typeof valor !== 'string') return valor
  if (/telefone|celular|fone|cpf|cnpj|email|documento/i.test(chave)) return valor ? '«mascarado»' : valor
  if (/@/.test(valor)) return '«email»'
  return valor.length > 50 ? valor.slice(0, 50) + '…' : valor
}
function forma(obj: unknown, prof = 0): string {
  if (obj === null) return 'null'
  if (Array.isArray(obj)) return obj.length === 0 ? '[] (vazio)' : `[${obj.length}] de:\n` + forma(obj[0], prof + 1)
  if (typeof obj !== 'object') return `${typeof obj}`
  const id = '  '.repeat(prof + 1)
  return '{\n' + Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
    if (v !== null && typeof v === 'object' && prof < 4) return `${id}${k}: ${forma(v, prof + 1)}`
    return `${id}${k}: ${t} = ${JSON.stringify(mascarar(k, v))}`
  }).join('\n') + `\n${'  '.repeat(prof)}}`
}

async function run() {
  console.log(`\n🔐 Autenticando…`)
  const auth = await autenticarGeraCloud({ baseUrl: base, usuario, senha }, fetch)
  if (!auth.ok) { console.error(`❌ ${auth.motivo}`); process.exit(1) }
  const token = auth.sessao.accessToken
  const h = { authorization: `Bearer ${token}`, accept: 'application/json' }
  console.log('✅ ok\n')

  // 1. Pega uma venda da listagem para ter um id real.
  const lista = (await (await fetch(`${base}/vendas?page=0&size=5`, { headers: h })).json()) as { id: number }[]
  const ids = Array.isArray(lista) ? lista.map((v) => v.id) : []
  console.log(`ids de venda disponíveis: ${ids.join(', ') || '(nenhum)'}`)

  // 2. Detalhe de venda — aqui devem estar os itemVendas.
  if (ids[0] != null) {
    console.log(`\n${'═'.repeat(70)}\n▶ GET vendas/${ids[0]}  (detalhe — procurando itemVendas)\n${'═'.repeat(70)}`)
    const r = await fetch(`${base}/vendas/${ids[0]}`, { headers: h })
    console.log(`HTTP ${r.status}`)
    if (r.ok) {
      const v = (await r.json()) as Record<string, unknown>
      // Só as chaves de topo + a forma dos itens (o resto do payload é enorme).
      console.log(`chaves de topo: ${Object.keys(v).join(', ')}`)
      const itens = (v.itemVendas ?? v.itens ?? v.produtos) as unknown
      console.log(`\nitemVendas =`)
      console.log(forma(itens))
    } else {
      console.log((await r.text()).slice(0, 200))
    }
  }

  // 3. Faturamento do ERP — a fonte de verdade da conciliação.
  console.log(`\n${'═'.repeat(70)}\n▶ POST dashboards/faturamento-geral  (conciliação)\n${'═'.repeat(70)}`)
  // idLojas: a sonda anterior mostrou loja id 4. Vazio = todas.
  for (const corpo of [[4], []]) {
    const r = await fetch(`${base}/dashboards/faturamento-geral`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    })
    console.log(`\nidLojas=${JSON.stringify(corpo)} → HTTP ${r.status}`)
    if (r.ok) console.log(forma(await r.json()))
    else console.log((await r.text()).slice(0, 200))
  }

  console.log(`\n✅ Sonda concluída. Nada foi gravado.\n`)
}
run().catch((e) => { console.error(`❌ ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
