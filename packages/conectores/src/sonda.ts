import type { Credencial, ResultadoTeste } from './credencial.js'
import type { Capacidades } from './porta.js'
import { conectorPorCodigo } from './catalogo.js'
import {
  autenticarGeraCloud, CAMINHO_SONDA_GERACLOUD,
} from './geracloud/autenticacao.js'

/**
 * Testa uma conexão de ERP: valida a credencial e confirma que a API responde.
 *
 * ⚠️ Vive no pacote de conectores, não na API: saber COMO cada ERP autentica é
 * conhecimento de fornecedor, e só este pacote pode ter (ADR-008). A API injeta
 * um `fetch` já com timeout — é ela que decide quanto tempo esperar; aqui mora
 * o que perguntar e como interpretar a resposta.
 */
export async function sondarConexao(
  codigo: string,
  credencial: Credencial,
  fetchFn: typeof fetch,
): Promise<ResultadoTeste> {
  const conector = conectorPorCodigo(codigo)
  if (!conector) {
    return { ok: false, motivo: 'resposta_inesperada', detalhe: `conector ${codigo} não existe` }
  }

  const base = normalizarBase(credencial['baseUrl'])
  if (!base) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'endereço vazio' }

  if (codigo === 'geracloud') return sondarGeraCloud(base, credencial, fetchFn, conector.capacidades)
  return sondarPorToken(base, credencial, fetchFn, conector.capacidades)
}

async function sondarGeraCloud(
  base: string,
  credencial: Credencial,
  fetchFn: typeof fetch,
  capacidades: Capacidades,
): Promise<ResultadoTeste> {
  // 1. Login no Keycloak. Falha aqui é sobre a CREDENCIAL.
  const auth = await autenticarGeraCloud(credencial, fetchFn)
  if (!auth.ok) return { ok: false, motivo: auth.motivo, ...(auth.detalhe ? { detalhe: auth.detalhe } : {}) }

  // 2. Chamada real à API com o token. Falha aqui é sobre PERMISSÃO ou ENDEREÇO.
  let resposta: Response
  try {
    resposta = await fetchFn(`${base}/${CAMINHO_SONDA_GERACLOUD}`, {
      headers: { authorization: `Bearer ${auth.sessao.accessToken}`, accept: 'application/json' },
    })
  } catch {
    return { ok: false, motivo: 'indisponivel', detalhe: 'API não respondeu' }
  }

  // ⚠️ 401 aqui é diferente de 401 no login: o token é fresco e válido, então
  //    401 na API significa endereço apontando para outro servidor de auth —
  //    não senha errada. Por isso vira resposta_inesperada.
  if (resposta.status === 401) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'API rejeitou o token — confira o endereço' }
  // ⚠️ 403 é o caso que importa separar: autenticou, mas o usuário não tem o
  //    papel para ler os dados. A senha está certa; falta liberar acesso no
  //    ERP — e quem libera costuma ser outra pessoa.
  if (resposta.status === 403) return { ok: false, motivo: 'sem_permissao' }
  if (resposta.status === 404) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'o endereço respondeu, mas sem esta API' }
  if (resposta.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `API HTTP ${resposta.status}` }
  if (!resposta.ok) return { ok: false, motivo: 'resposta_inesperada', detalhe: `API HTTP ${resposta.status}` }

  const empresa = (await resposta.json().catch(() => null)) as Record<string, unknown> | null
  return {
    ok: true,
    capacidades: { ...capacidades },
    // ⚠️ razaoSocial || nomeFantasia: é o que prova EM QUAL empresa conectou —
    //    o único jeito de a pessoa perceber que apontou para a loja errada.
    identificacao: identificar(empresa, ['razaoSocial', 'nomeFantasia']),
  }
}

async function sondarPorToken(
  base: string,
  credencial: Credencial,
  fetchFn: typeof fetch,
  capacidades: Capacidades,
): Promise<ResultadoTeste> {
  let resposta: Response
  try {
    resposta = await fetchFn(`${base}/`, {
      headers: { authorization: `Bearer ${credencial['token'] ?? ''}`, accept: 'application/json' },
    })
  } catch {
    return { ok: false, motivo: 'indisponivel', detalhe: 'API não respondeu' }
  }

  if (resposta.status === 401) return { ok: false, motivo: 'credencial_invalida' }
  if (resposta.status === 403) return { ok: false, motivo: 'sem_permissao' }
  if (resposta.status === 404) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'o endereço respondeu, mas sem esta API' }
  if (resposta.status >= 500) return { ok: false, motivo: 'indisponivel', detalhe: `HTTP ${resposta.status}` }
  if (!resposta.ok) return { ok: false, motivo: 'resposta_inesperada', detalhe: `HTTP ${resposta.status}` }

  const corpo = (await resposta.json().catch(() => null)) as Record<string, unknown> | null
  return {
    ok: true,
    capacidades: { ...capacidades },
    identificacao: identificar(corpo, ['razaoSocial', 'nomeFantasia', 'nome', 'empresa', 'name']),
  }
}

function normalizarBase(valor: string | undefined): string | null {
  const base = (valor ?? '').trim().replace(/\/+$/, '')
  return base || null
}

function identificar(corpo: Record<string, unknown> | null, chaves: readonly string[]): string | undefined {
  if (!corpo) return undefined
  for (const chave of chaves) {
    const valor = corpo[chave]
    if (typeof valor === 'string' && valor.trim()) return valor.trim()
  }
  return undefined
}
