import { describe, it, expect } from 'vitest'
import { sondarConexao } from './sonda.js'
import { KEYCLOAK_GERACLOUD, CAMINHO_SONDA_GERACLOUD } from './geracloud/autenticacao.js'

/**
 * Sonda do GeraCloud com fetch falso.
 *
 * ⚠️ Testa o FLUXO real descoberto no servidor: login no Keycloak, depois
 * chamada à API com o token. O que importa é que cada falha vire o motivo
 * certo — porque "senha errada" e "sem permissão" pedem ações opostas de
 * pessoas diferentes.
 */

const cred = { baseUrl: 'https://apresentacao.geracloud.com.br/pdvcore/api/v1', usuario: 'daniel', senha: 'x' }

/** Fábrica de fetch falso: decide a resposta pela URL chamada. */
function fetchFalso(rotas: {
  keycloak: { status: number; corpo?: unknown }
  api?: { status: number; corpo?: unknown }
}): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    const alvo = u === KEYCLOAK_GERACLOUD.tokenUrl ? rotas.keycloak : rotas.api ?? { status: 500 }
    return {
      status: alvo.status,
      ok: alvo.status >= 200 && alvo.status < 300,
      json: async () => alvo.corpo ?? {},
    } as Response
  }) as typeof fetch
}

const loginOk = { status: 200, corpo: { access_token: 'tok-abc', refresh_token: 'ref', expires_in: 300 } }

describe('GeraCloud — login no Keycloak', () => {
  it('dado login e API ok, então conecta e identifica a empresa', async () => {
    const r = await sondarConexao('geracloud', cred, fetchFalso({
      keycloak: loginOk,
      api: { status: 200, corpo: { razaoSocial: 'LOJA CENTRO LTDA', nomeFantasia: 'Loja Centro' } },
    }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.identificacao).toBe('LOJA CENTRO LTDA')
  })

  it('⚠️ dado invalid_grant no Keycloak, então é credencial inválida', async () => {
    const r = await sondarConexao('geracloud', cred, fetchFalso({
      keycloak: { status: 401, corpo: { error: 'invalid_grant' } },
    }))
    // Senha errada: ação da PESSOA — conferir o que digitou.
    expect(r).toMatchObject({ ok: false, motivo: 'credencial_invalida' })
  })

  it('⚠️ dado invalid_client, então NÃO culpa a senha do lojista', async () => {
    const r = await sondarConexao('geracloud', cred, fetchFalso({
      keycloak: { status: 401, corpo: { error: 'invalid_client' } },
    }))
    // Configuração de client do GeraCRM: problema NOSSO. Mandar o lojista
    // redigitar a senha nunca resolveria — e ele não tem como saber disso.
    expect(r).toMatchObject({ ok: false, motivo: 'resposta_inesperada' })
  })

  it('dado Keycloak fora do ar, então é indisponível', async () => {
    const r = await sondarConexao('geracloud', cred, fetchFalso({ keycloak: { status: 503 } }))
    expect(r).toMatchObject({ ok: false, motivo: 'indisponivel' })
  })
})

describe('GeraCloud — chamada à API com o token', () => {
  it('⚠️ dado 403 na API, então é sem_permissao — não credencial inválida', async () => {
    const r = await sondarConexao('geracloud', cred, fetchFalso({
      keycloak: loginOk,
      api: { status: 403 },
    }))
    // Autenticou (a senha está certa), mas falta o papel de leitura. Quem
    // libera acesso no ERP costuma não ser quem está configurando aqui.
    expect(r).toMatchObject({ ok: false, motivo: 'sem_permissao' })
  })

  it('⚠️ dado 401 na API com token fresco, então é endereço errado — não senha', async () => {
    const r = await sondarConexao('geracloud', cred, fetchFalso({
      keycloak: loginOk,
      api: { status: 401 },
    }))
    // O token acabou de ser emitido e é válido; 401 aqui significa que o
    // endereço aponta para outro servidor de auth.
    expect(r).toMatchObject({ ok: false, motivo: 'resposta_inesperada' })
  })

  it('dado 404 na API, então é endereço sem esta API', async () => {
    const r = await sondarConexao('geracloud', cred, fetchFalso({
      keycloak: loginOk,
      api: { status: 404 },
    }))
    expect(r).toMatchObject({ ok: false, motivo: 'resposta_inesperada' })
  })

  it('bate no endpoint certo — empresas/usuario-logado', async () => {
    let urlApi = ''
    const espiao: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u === KEYCLOAK_GERACLOUD.tokenUrl) {
        return { status: 200, ok: true, json: async () => loginOk.corpo } as Response
      }
      urlApi = u
      // ⚠️ Confirma também que o token vai como Bearer, não a senha.
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-abc')
      return { status: 200, ok: true, json: async () => ({ razaoSocial: 'X' }) } as Response
    }) as typeof fetch

    await sondarConexao('geracloud', cred, espiao)
    expect(urlApi).toContain(CAMINHO_SONDA_GERACLOUD)
    // ⚠️ Endpoint confirmado no fonte do pdv-core (RecursoEmpresa).
    expect(urlApi).toBe(`${cred.baseUrl}/empresas/usuario-logado`)
  })
})

describe('Conector por token', () => {
  it('dado token aceito, então conecta', async () => {
    const r = await sondarConexao(
      'generico_token',
      { baseUrl: 'https://erp.x.com.br/api', token: 't' },
      fetchFalso({ keycloak: { status: 0 }, api: { status: 200, corpo: { nome: 'ERP X' } } }),
    )
    expect(r.ok).toBe(true)
  })

  it('dado 401, então credencial inválida', async () => {
    const r = await sondarConexao(
      'generico_token',
      { baseUrl: 'https://erp.x.com.br/api', token: 't' },
      fetchFalso({ keycloak: { status: 0 }, api: { status: 401 } }),
    )
    expect(r).toMatchObject({ ok: false, motivo: 'credencial_invalida' })
  })
})

describe('Endereço', () => {
  it('dado baseUrl vazio, então recusa antes de sair para a rede', async () => {
    let saiu = false
    const espiao: typeof fetch = (async () => { saiu = true; return {} as Response }) as typeof fetch
    const r = await sondarConexao('geracloud', { usuario: 'a', senha: 'b' }, espiao)
    expect(r).toMatchObject({ ok: false, motivo: 'resposta_inesperada' })
    expect(saiu).toBe(false)
  })
})
