import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  CONECTORES, conectorPorCodigo, validarCredencial,
  type Credencial, type ResultadoTeste,
} from '@geracrm/conectores'
import { exigirTenant } from '../../plugins/tenant.js'
import { cifrar, resumir } from './cofre.js'
import { jsonbDe } from '../../db/jsonb.js'

/**
 * Configuração das conexões de ERP.
 *
 * ⚠️ A credencial ENTRA e nunca SAI (contrato §5.8). Nenhuma resposta daqui
 * carrega valor de credencial — nem mascarado, nem parcial.
 */

interface CorpoConexao {
  conector?: string
  nomeAmigavel?: string
  credencial?: Record<string, unknown>
  papelFiscal?: boolean
  fonteDeVenda?: boolean
}

/**
 * Erro tipificado: a tela precisa de um código para ramificar, não de um texto.
 *
 * ⚠️ Devolve um VALOR; quem chama é que responde. Não chama `reply.send()`.
 * O motivo está em `responder()` logo abaixo, e custou uma transação perdida
 * para aparecer.
 */
interface Falha { readonly _falha: true; status: number; erro: string; mensagem: string; detalhe?: unknown }
const ehFalha = (v: unknown): v is Falha =>
  typeof v === 'object' && v !== null && (v as Falha)._falha === true

function falha(status: number, erro: string, mensagem: string, detalhe?: unknown): Falha {
  return { _falha: true, status, erro, mensagem, ...(detalhe === undefined ? {} : { detalhe }) }
}

/**
 * Converte o resultado do caso de uso em resposta HTTP.
 *
 * ⚠️ NUNCA chame `reply.send()` de dentro de `req.comTenant()`.
 *
 *    `FastifyReply` é *thenable* — tem `.then`. O `sql.begin()` do postgres.js
 *    faz `await` no que o callback devolve, então devolver o `reply` faz o
 *    driver esperar por uma resposta que já foi enviada. A transação NÃO
 *    COMMITA e a conexão fica presa no pool.
 *
 *    O sintoma é cruel: o `POST` responde `201` com o id, o `GET` seguinte
 *    ainda enxerga a linha (mesma conexão física, dados não commitados) e o
 *    banco está vazio. Tudo parece funcionar até alguém reiniciar o processo.
 */
function responder(reply: FastifyReply, resultado: unknown, statusOk = 200) {
  if (ehFalha(resultado)) {
    const { status, erro, mensagem, detalhe } = resultado
    return reply.code(status).send(detalhe === undefined ? { erro, mensagem } : { erro, mensagem, detalhe })
  }
  return reply.code(statusOk).send(resultado)
}

export async function rotasIntegracao(app: FastifyInstance): Promise<void> {
  /**
   * O catálogo. ⚠️ É daqui que a tela desenha o formulário de credencial —
   * o console não conhece ERP nenhum, então um ERP novo não custa commit lá.
   */
  app.get('/v1/integracao/conectores', { preHandler: exigirTenant }, async () =>
    CONECTORES.map((c) => ({
      codigo: c.codigo,
      nome: c.nome,
      descricao: c.descricao,
      esquemaCredencial: c.esquemaCredencial,
      capacidades: c.capacidades,
    })),
  )

  app.get('/v1/integracao/conexoes', { preHandler: exigirTenant }, async (req) =>
    req.comTenant(async (tx) => {
      const linhas = await tx<{
        id: string; conector: string; nome_amigavel: string; estado: string
        credenciais_cifradas: Buffer | null; capacidades: Record<string, boolean>
        papel_fiscal: boolean; fonte_de_venda: boolean
        ultima_validacao_em: Date | null; ultima_tentativa_em: Date | null
        identificacao_remota: string | null
        ultimo_erro: string | null; ultimo_erro_motivo: string | null
      }[]>`
        SELECT id, conector, nome_amigavel, estado, credenciais_cifradas, capacidades,
               papel_fiscal, fonte_de_venda, ultima_validacao_em, ultima_tentativa_em,
               identificacao_remota, ultimo_erro, ultimo_erro_motivo
          FROM conexao_erp
         ORDER BY criado_em
      `
      // ⚠️ Sem `WHERE tenant_id`: quem decide o que é visível é a RLS.
      return {
        itens: linhas.map((l) => ({
          id: l.id,
          conector: l.conector,
          nomeAmigavel: l.nome_amigavel,
          estado: l.estado,
          capacidades: l.capacidades,
          papelFiscal: l.papel_fiscal,
          fonteDeVenda: l.fonte_de_venda,
          identificacaoRemota: l.identificacao_remota,
          ultimaValidacaoEm: l.ultima_validacao_em,
          ultimaTentativaEm: l.ultima_tentativa_em,
          ultimoErro: l.ultimo_erro,
          ultimoErroMotivo: l.ultimo_erro_motivo,
          // Só isto sai da credencial: se existe e quais campos tem.
          credencial: resumir(l.credenciais_cifradas),
        })),
      }
    }),
  )

  app.post('/v1/integracao/conexoes', { preHandler: exigirTenant }, async (req, reply) => {
    const corpo = (req.body ?? {}) as CorpoConexao

    const conector = corpo.conector ? conectorPorCodigo(corpo.conector) : undefined
    if (!conector) {
      return responder(reply, falha(422, 'integracao.conector_desconhecido',
        'Este ERP não está na lista de conectores disponíveis.'))
    }
    if (!corpo.nomeAmigavel?.trim()) {
      return responder(reply, falha(422, 'integracao.nome_obrigatorio',
        'Dê um nome para esta conexão.',
        // ⚠️ O nome amigável é o que aparece em TODA mensagem de erro do
        //    produto ("o ERP da matriz não respondeu"). Sem ele, quem tem duas
        //    conexões não sabe qual das duas falhou.
        { campo: 'nomeAmigavel' }))
    }

    const validacao = validarCredencial(conector.esquemaCredencial, corpo.credencial ?? {})
    if (!validacao.ok) {
      return responder(reply, falha(422, 'integracao.credencial_invalida',
        'Confira os campos destacados.', { campos: validacao.erros }))
    }

    const id = randomUUID()
    try {
      await req.comTenant(async (tx) => {
        await tx`
          INSERT INTO conexao_erp (tenant_id, id, conector, nome_amigavel,
                                   credenciais_cifradas, capacidades,
                                   papel_fiscal, fonte_de_venda, estado)
          VALUES (tenant_atual(), ${id}, ${conector.codigo}, ${corpo.nomeAmigavel!.trim()},
                  ${cifrar(corpo.credencial as Credencial)},
                  ${jsonbDe(conector.capacidades)}::text::jsonb,
                  ${corpo.papelFiscal ?? false}, ${corpo.fonteDeVenda ?? false},
                  -- ⚠️ Nasce 'configurando', nunca 'ativa': ativa é o que o
                  --    TESTE diz, não o que o formulário diz. Sem isso, a
                  --    primeira carga sai antes de alguém saber se conecta.
                  'configurando')
        `
      })
      // ⚠️ Fora da transação, sempre. Ver a nota em responder().
      return responder(reply, { id, estado: 'configurando' }, 201)
    } catch (erro) {
      return responder(reply, traduzirConflito(erro))
    }
  })

  app.patch<{ Params: { id: string } }>(
    '/v1/integracao/conexoes/:id',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const corpo = (req.body ?? {}) as CorpoConexao

      const resultado = await req.comTenant(async (tx) => {
        const [atual] = await tx<{ conector: string }[]>`
          SELECT conector FROM conexao_erp WHERE id = ${req.params.id}
        `
        if (!atual) return falha(404, 'integracao.conexao_nao_encontrada', 'Conexão não encontrada.')

        // ⚠️ O conector NÃO muda depois de criado. Trocar de ERP mantendo as
        //    identidades externas já importadas faria o id "1234" do Bling
        //    casar com o cliente que veio do GeraCloud — e a mistura não tem
        //    conserto depois. Para trocar de ERP, cria-se outra conexão.
        if (corpo.conector && corpo.conector !== atual.conector) {
          return falha(422, 'integracao.conector_imutavel',
            'Não dá para trocar o ERP desta conexão. Crie uma nova conexão para o outro ERP.')
        }

        const conector = conectorPorCodigo(atual.conector)!

        if (corpo.credencial !== undefined) {
          const validacao = validarCredencial(conector.esquemaCredencial, corpo.credencial)
          if (!validacao.ok) {
            return falha(422, 'integracao.credencial_invalida',
              'Confira os campos destacados.', { campos: validacao.erros })
          }
          await tx`
            UPDATE conexao_erp
               SET credenciais_cifradas = ${cifrar(corpo.credencial as Credencial)},
                   -- ⚠️ Credencial nova zera a validação: o que valia era a
                   --    anterior. Manter a data antiga faria a tela dizer
                   --    "validada hoje" sobre uma senha nunca testada.
                   ultima_validacao_em = NULL,
                   estado = 'configurando'
             WHERE id = ${req.params.id}
          `
        }

        if (corpo.nomeAmigavel?.trim()) {
          await tx`UPDATE conexao_erp SET nome_amigavel = ${corpo.nomeAmigavel.trim()} WHERE id = ${req.params.id}`
        }
        if (corpo.papelFiscal !== undefined) {
          await tx`UPDATE conexao_erp SET papel_fiscal = ${corpo.papelFiscal} WHERE id = ${req.params.id}`
        }
        if (corpo.fonteDeVenda !== undefined) {
          await tx`UPDATE conexao_erp SET fonte_de_venda = ${corpo.fonteDeVenda} WHERE id = ${req.params.id}`
        }

        return { ok: true }
      }).catch((erro) => traduzirConflito(erro))
      return responder(reply, resultado)
    },
  )

  /**
   * Testa a credencial e REDESCOBRE as capacidades.
   *
   * ⚠️ Redescobre em vez de confiar na declaração do código: a mesma marca de
   * ERP em versão antiga não tem o endpoint de saldo, e o produto precisa
   * degradar de forma visível — não descobrir isso no meio de um pedido.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/integracao/conexoes/:id/testar',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const resultado = await req.comTenant(async (tx) => {
        const [linha] = await tx<{ conector: string; credenciais_cifradas: Buffer | null }[]>`
          SELECT conector, credenciais_cifradas FROM conexao_erp WHERE id = ${req.params.id}
        `
        if (!linha) return null
        if (!linha.credenciais_cifradas) {
          return { semCredencial: true } as const
        }
        return { conector: linha.conector, guardado: linha.credenciais_cifradas }
      })

      if (!resultado) {
        return responder(reply, falha(404, 'integracao.conexao_nao_encontrada', 'Conexão não encontrada.'))
      }
      if ('semCredencial' in resultado) {
        return responder(reply, falha(422, 'integracao.credencial_ausente',
          'Preencha as credenciais antes de testar.'))
      }

      const teste = await app.testarConexao(resultado.conector, resultado.guardado)

      await req.comTenant(async (tx) => {
        if (teste.ok) {
          await tx`
            UPDATE conexao_erp
               SET estado = 'ativa',
                   capacidades = ${jsonbDe(teste.capacidades)}::text::jsonb,
                   identificacao_remota = ${teste.identificacao ?? null},
                   ultima_validacao_em = now(), ultima_tentativa_em = now(),
                   ultimo_erro = NULL, ultimo_erro_motivo = NULL
             WHERE id = ${req.params.id}
          `
        } else {
          await tx`
            UPDATE conexao_erp
               SET estado = 'com_erro',
                   ultima_tentativa_em = now(),
                   ultimo_erro = ${teste.detalhe ?? null},
                   ultimo_erro_motivo = ${teste.motivo}
             WHERE id = ${req.params.id}
          `
        }
      })

      // ⚠️ 200 mesmo quando o teste falha: a REQUISIÇÃO funcionou. O resultado
      //    do teste é o corpo. Devolver 502 aqui faria o cliente HTTP tratar
      //    "sua senha está errada" como "nossa API caiu", e a pessoa veria uma
      //    tela de erro genérica em vez do campo destacado.
      return teste
    },
  )

  app.get<{ Params: { id: string } }>(
    '/v1/integracao/conexoes/:id/capacidades',
    { preHandler: exigirTenant },
    async (req, reply) => {
      const resultado = await req.comTenant(async (tx) => {
        const [linha] = await tx<{ capacidades: Record<string, boolean>; estado: string }[]>`
          SELECT capacidades, estado FROM conexao_erp WHERE id = ${req.params.id}
        `
        if (!linha) return falha(404, 'integracao.conexao_nao_encontrada', 'Conexão não encontrada.')
        return { capacidades: linha.capacidades, estado: linha.estado }
      })
      return responder(reply, resultado)
    },
  )
}

/** Traduz as únicas parciais do banco em erro que a tela sabe explicar. */
function traduzirConflito(erro: unknown): Falha {
  const texto = erro instanceof Error ? erro.message : String(erro)
  if (texto.includes('conexao_erp_fonte_de_venda_unica')) {
    return falha(409, 'integracao.fonte_de_venda_ja_definida',
      'Já existe uma conexão marcada como fonte de venda.',
      // ⚠️ Duas fontes de venda tornam o faturamento ambíguo — e o faturamento
      //    é o denominador de RFV, de atribuição e do ROI.
      { comoResolver: 'Desmarque a outra conexão antes de marcar esta.' })
  }
  if (texto.includes('conexao_erp_papel_fiscal_unico')) {
    return falha(409, 'integracao.papel_fiscal_ja_definido',
      'Já existe uma conexão marcada como sistema fiscal.',
      { comoResolver: 'Desmarque a outra conexão antes de marcar esta.' })
  }
  throw erro
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Executa o teste contra o ERP de verdade.
     *
     * ⚠️ Decorado no app em vez de importado: é o único ponto que sai para a
     * rede, e o teste de rota precisa substituí-lo sem subir um ERP falso.
     */
    testarConexao(conector: string, credencialCifrada: Buffer): Promise<ResultadoTeste>
  }
}
