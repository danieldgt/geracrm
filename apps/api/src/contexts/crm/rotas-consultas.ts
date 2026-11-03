import type { FastifyInstance, FastifyReply } from 'fastify'
import { validarCnpj, apenasDigitos } from '@geracrm/shared'
import { exigirTenant } from '../../plugins/tenant.js'
import { provedorConsulta } from './consulta-externa.js'

/**
 * Consultas cadastrais (CNPJ/CEP) atrás da porta `ProvedorConsulta`.
 *
 * Fornecedor fora do ar → 503 `consulta.indisponivel`; não achou → 404
 * `consulta.nao_encontrado`. A tela libera o preenchimento manual nos dois
 * casos. Nunca 500.
 */
export async function rotasConsultas(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { cnpj: string } }>('/v1/consultas/cnpj/:cnpj', { preHandler: exigirTenant }, async (req, reply) => {
    const cnpj = apenasDigitos(req.params.cnpj)
    if (!validarCnpj(cnpj)) {
      return reply.code(422).send({ erro: 'validacao', mensagem: 'Dados inválidos.', campos: { cnpj: 'CNPJ inválido' } })
    }
    const r = await provedorConsulta().consultarCnpj(cnpj)
    if (!r.ok) return responderFalha(reply, r.erro, 'CNPJ não encontrado na base pública.')
    return reply.send(r.dado)
  })

  app.get<{ Params: { cep: string } }>('/v1/consultas/cep/:cep', { preHandler: exigirTenant }, async (req, reply) => {
    const cep = apenasDigitos(req.params.cep)
    if (cep.length !== 8) {
      return reply.code(422).send({ erro: 'validacao', mensagem: 'Dados inválidos.', campos: { cep: 'CEP inválido' } })
    }
    const r = await provedorConsulta().consultarCep(cep)
    if (!r.ok) return responderFalha(reply, r.erro, 'CEP não encontrado.')
    return reply.send(r.dado)
  })
}

function responderFalha(reply: FastifyReply, erro: 'consulta.indisponivel' | 'consulta.nao_encontrado', naoAchou: string) {
  if (erro === 'consulta.nao_encontrado') return reply.code(404).send({ erro, mensagem: naoAchou })
  return reply.code(503).send({ erro, mensagem: 'Consulta indisponível agora. Preencha manualmente.' })
}
