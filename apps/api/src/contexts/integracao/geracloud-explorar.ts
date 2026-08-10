/**
 * Sonda de reconhecimento do GeraCloud.
 *
 * ⚠️ NÃO grava nada — nem no banco, nem em disco. Só autentica, puxa uma página
 * de cada recurso e imprime a FORMA da resposta. Existe porque o adaptador foi
 * escrito lendo o Java do pdv-core, e resposta real manda mais que entidade:
 * rodar a carga completa contra parsers adivinhados produz lixo que "parece
 * importado" — e aí a divergência aparece na conciliação, tarde e cara.
 *
 * ⚠️ Mascara telefone, CPF/CNPJ e e-mail na saída. O objetivo é ver NOMES DE
 * CAMPO e TIPOS, não os dados do cliente. Mesmo sendo instância de apresentação,
 * a saída vai para o terminal e não custa nada proteger.
 *
 * Uso (as credenciais entram por ambiente, nunca em arquivo):
 *   GERACLOUD_BASE_URL=https://apresentacao.geracloud.com.br/pdvcore/api/v1 \
 *   GERACLOUD_USUARIO=... GERACLOUD_SENHA=... \
 *   pnpm --filter @geracrm/api geracloud:explorar
 */

import { autenticarGeraCloud } from '@geracrm/conectores'

const base = (process.env.GERACLOUD_BASE_URL ?? '').replace(/\/+$/, '')
const usuario = process.env.GERACLOUD_USUARIO ?? ''
const senha = process.env.GERACLOUD_SENHA ?? ''

if (!base || !usuario || !senha) {
  console.error(
    'Faltam variáveis. Rode com:\n' +
      '  GERACLOUD_BASE_URL=https://apresentacao.geracloud.com.br/pdvcore/api/v1 \\\n' +
      '  GERACLOUD_USUARIO=<login> GERACLOUD_SENHA=<senha> \\\n' +
      '  pnpm --filter @geracrm/api geracloud:explorar',
  )
  process.exit(1)
}

/** Mascara qualquer coisa que se pareça com dado pessoal. */
function mascarar(chave: string, valor: unknown): unknown {
  if (typeof valor !== 'string') return valor
  const k = chave.toLowerCase()
  if (/telefone|celular|fone|cpf|cnpj|email|documento|rg|whatsapp/.test(k)) {
    return valor ? `«${valor.length} chars, mascarado»` : valor
  }
  // Padrões de PII mesmo sem a chave denunciar.
  if (/^[\d.\-/() ]{11,}$/.test(valor)) return '«número mascarado»'
  if (/@/.test(valor)) return '«email mascarado»'
  return valor.length > 60 ? valor.slice(0, 60) + '…' : valor
}

/** Descreve a forma de um objeto: chave → tipo (+ amostra segura). */
function forma(obj: unknown, prof = 0): string {
  if (obj === null) return 'null'
  if (Array.isArray(obj)) {
    return obj.length === 0 ? '[] (vazio)' : `[${obj.length}] de:\n` + forma(obj[0], prof + 1)
  }
  if (typeof obj !== 'object') return `${typeof obj}`
  const ident = '  '.repeat(prof + 1)
  return (
    '{\n' +
    Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => {
        const tipo = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
        if (v !== null && typeof v === 'object' && prof < 3) {
          return `${ident}${k}: ${forma(v, prof + 1)}`
        }
        return `${ident}${k}: ${tipo} = ${JSON.stringify(mascarar(k, v))}`
      })
      .join('\n') +
    `\n${'  '.repeat(prof)}}`
  )
}

async function explorar() {
  console.log(`\n🔐 Autenticando em ${base} como ${usuario}…\n`)
  const auth = await autenticarGeraCloud({ baseUrl: base, usuario, senha }, fetch)
  if (!auth.ok) {
    console.error(`❌ Login falhou: ${auth.motivo}${auth.detalhe ? ` (${auth.detalhe})` : ''}`)
    process.exit(1)
  }
  console.log(`✅ Login ok — token expira em ${auth.sessao.expiraEm}s\n`)
  const token = auth.sessao.accessToken

  // ⚠️ Uma amostra pequena de cada recurso. size baixo de propósito: é sonda,
  //    não carga — e a instância é compartilhada.
  const recursos: { nome: string; caminho: string }[] = [
    { nome: 'empresa (identificação)', caminho: 'empresas/usuario-logado' },
    { nome: 'clientes', caminho: 'clientespdv?page=0&size=2' },
    { nome: 'estoques (SKUs)', caminho: 'estoques?page=0&size=2' },
    { nome: 'vendas', caminho: 'vendas?page=0&size=2' },
  ]

  for (const r of recursos) {
    console.log(`\n${'═'.repeat(70)}\n▶ ${r.nome}  —  GET ${r.caminho}\n${'═'.repeat(70)}`)
    try {
      const resp = await fetch(`${base}/${r.caminho}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
      console.log(`HTTP ${resp.status}`)
      if (!resp.ok) {
        console.log(`  ⚠️ corpo: ${(await resp.text()).slice(0, 200)}`)
        continue
      }
      const corpo = await resp.json()
      // ⚠️ Confirma o formato de paginação: é `content`/`last` (Spring Data),
      //    `page`, ou lista crua? O parser inteiro depende disso.
      if (corpo && typeof corpo === 'object' && !Array.isArray(corpo)) {
        const chaves = Object.keys(corpo as Record<string, unknown>)
        console.log(`chaves de topo: ${chaves.join(', ')}`)
      }
      console.log(forma(corpo))
    } catch (e) {
      console.log(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  console.log(`\n${'═'.repeat(70)}\n✅ Sonda concluída. Nada foi gravado.\n`)
}

void explorar()
