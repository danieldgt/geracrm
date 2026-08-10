import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import {
  conectorPorCodigo, sondarConexao,
  type Credencial, type ResultadoTeste,
} from '@geracrm/conectores'
import { decifrar } from './cofre.js'

/**
 * O único ponto que sai para a rede na configuração de ERP.
 *
 * ⚠️ COMO cada ERP autentica não mora aqui — mora no pacote de conectores
 * (`sondarConexao`), porque é conhecimento de fornecedor (ADR-008). Aqui fica só
 * o que é responsabilidade da API: decifrar a credencial e impor o timeout.
 */

/** ⚠️ Curto de propósito: alguém está olhando a tela esperando a resposta. */
const TIMEOUT_MS = 8_000

export const pluginTestarConexao = fp(
  async (app: FastifyInstance) => {
    app.decorate('testarConexao', async (codigo: string, cifrada: Buffer): Promise<ResultadoTeste> => {
      const conector = conectorPorCodigo(codigo)
      if (!conector) {
        return { ok: false, motivo: 'resposta_inesperada', detalhe: `conector ${codigo} não existe` }
      }

      let credencial: Credencial
      try {
        credencial = decifrar(cifrada)
      } catch {
        // Credencial que não decifra é rotação de chave ou dado corrompido.
        // ⚠️ Tratada como inválida para a pessoa poder redigitar e seguir —
        //    e não como erro interno, que a deixaria sem ação nenhuma.
        return { ok: false, motivo: 'credencial_invalida', detalhe: 'credencial ilegível — digite de novo' }
      }

      // ⚠️ O timeout é imposto AQUI, envolvendo TODAS as chamadas de rede da
      //    sonda — no GeraCloud são duas (login no Keycloak + chamada à API), e
      //    o orçamento de 8s é do gesto inteiro, não de cada uma.
      const controle = new AbortController()
      const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS)
      const fetchComTimeout: typeof fetch = (entrada, init) =>
        fetch(entrada, { ...init, signal: controle.signal })

      try {
        return await sondarConexao(codigo, credencial, fetchComTimeout)
      } catch (erro) {
        if (erro instanceof Error && erro.name === 'AbortError') {
          return { ok: false, motivo: 'indisponivel', detalhe: `sem resposta em ${TIMEOUT_MS / 1000}s` }
        }
        app.log.warn(
          // ⚠️ Loga o CONECTOR e o erro, NUNCA a credencial. Um log com a senha
          //    do ERP do cliente vaza por um canal que ninguém audita.
          { conector: codigo, erro: erro instanceof Error ? erro.message : String(erro) },
          'teste de conexão falhou',
        )
        return { ok: false, motivo: 'indisponivel', detalhe: 'não foi possível alcançar o ERP' }
      } finally {
        clearTimeout(relogio)
      }
    })
  },
  { name: 'testar-conexao' },
)
