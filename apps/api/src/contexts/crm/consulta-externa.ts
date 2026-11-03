/**
 * PORTA de consulta cadastral externa (CNPJ e CEP).
 *
 * O formato é o NOSSO — nunca o da BrasilAPI. Falha do fornecedor é resultado
 * tipificado (`consulta.indisponivel`), não exceção: a tela deixa o usuário
 * digitar à mão. Testes injetam o adaptador falso e nunca tocam a rede.
 */

export interface EnderecoConsulta {
  cep: string | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  cidade: string | null
  uf: string | null
}

export interface EmpresaConsulta {
  razaoSocial: string | null
  nomeFantasia: string | null
  endereco: EnderecoConsulta
  situacao: string | null
}

export type ResultadoConsulta<T> =
  | { ok: true; dado: T }
  | { ok: false; erro: 'consulta.indisponivel' | 'consulta.nao_encontrado' }

export interface ProvedorConsulta {
  consultarCnpj(cnpj: string): Promise<ResultadoConsulta<EmpresaConsulta>>
  consultarCep(cep: string): Promise<ResultadoConsulta<EnderecoConsulta>>
}

const TIMEOUT_MS = 3000
const TTL_MS = 24 * 60 * 60 * 1000
const BASE = 'https://brasilapi.com.br/api'

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

async function buscarJson(url: string, fetchImpl: typeof fetch): Promise<ResultadoConsulta<Record<string, unknown>>> {
  try {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
    if (resp.status === 404 || resp.status === 400) return { ok: false, erro: 'consulta.nao_encontrado' }
    if (!resp.ok) return { ok: false, erro: 'consulta.indisponivel' }
    return { ok: true, dado: (await resp.json()) as Record<string, unknown> }
  } catch {
    return { ok: false, erro: 'consulta.indisponivel' }
  }
}

/** Adaptador BrasilAPI. `fetchImpl` injetável para teste do mapeamento. */
export function criarProvedorBrasilApi(fetchImpl: typeof fetch = fetch): ProvedorConsulta {
  return {
    async consultarCnpj(cnpj) {
      const r = await buscarJson(`${BASE}/cnpj/v1/${cnpj}`, fetchImpl)
      if (!r.ok) return r
      const d = r.dado
      return {
        ok: true,
        dado: {
          razaoSocial: texto(d['razao_social']),
          nomeFantasia: texto(d['nome_fantasia']),
          situacao: texto(d['descricao_situacao_cadastral']),
          endereco: {
            cep: texto(d['cep'])?.replace(/\D/g, '') ?? null,
            logradouro: [texto(d['descricao_tipo_de_logradouro']), texto(d['logradouro'])].filter(Boolean).join(' ') || null,
            numero: texto(d['numero']),
            complemento: texto(d['complemento']),
            bairro: texto(d['bairro']),
            cidade: texto(d['municipio']),
            uf: texto(d['uf']),
          },
        },
      }
    },
    async consultarCep(cep) {
      const r = await buscarJson(`${BASE}/cep/v1/${cep}`, fetchImpl)
      if (!r.ok) return r
      const d = r.dado
      return {
        ok: true,
        dado: {
          cep: texto(d['cep'])?.replace(/\D/g, '') ?? cep,
          logradouro: texto(d['street']), numero: null, complemento: null,
          bairro: texto(d['neighborhood']), cidade: texto(d['city']), uf: texto(d['state']),
        },
      }
    },
  }
}

/** Cache em memória de 24 h; só guarda sucesso (indisponibilidade não é cacheada). */
export function comCache(base: ProvedorConsulta, agora: () => number = Date.now): ProvedorConsulta {
  const cache = new Map<string, { ate: number; valor: unknown }>()
  async function via<T>(chave: string, buscar: () => Promise<ResultadoConsulta<T>>): Promise<ResultadoConsulta<T>> {
    const hit = cache.get(chave)
    if (hit && hit.ate > agora()) return hit.valor as ResultadoConsulta<T>
    const r = await buscar()
    if (r.ok) {
      if (cache.size > 5000) cache.clear()
      cache.set(chave, { ate: agora() + TTL_MS, valor: r })
    }
    return r
  }
  return {
    consultarCnpj: (c) => via(`cnpj:${c}`, () => base.consultarCnpj(c)),
    consultarCep: (c) => via(`cep:${c}`, () => base.consultarCep(c)),
  }
}

let provedor: ProvedorConsulta = comCache(criarProvedorBrasilApi())

export const provedorConsulta = (): ProvedorConsulta => provedor
/** Troca o adaptador (testes injetam o falso). */
export function definirProvedorConsulta(p: ProvedorConsulta): void { provedor = p }
