import type { FastifyInstance } from 'fastify'
import {
  LIMITE_BUSCA_INTELIGENTE, MAX_CONSULTA_BUSCA_INTELIGENTE, ORIGENS_CATALOGO, perfilDeCotacao,
  type OrigemCatalogo, type SituacaoSemantica,
} from '@geracrm/shared'
import { sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { buscarCatalogo, embutirConsulta, type ResultadoEmbutirConsulta } from './busca.js'
import { cacheConsultaPadrao } from './cache-consulta.js'
import { embeddingDoAmbiente, type PortaEmbedding } from './porta-embedding.js'

/**
 * BUSCA INTELIGENTE DO CATÁLOGO — a busca híbrida do agente (ADR-026) exposta à tela.
 *
 *   GET /v1/catalogo/busca-inteligente?q=&perfil=&categoria=&origem=&limite=
 *     → { itens: ItemBusca[], fontes, semantica, truncado }
 *
 * O mesmo `buscarCatalogo` que o agente usa: palavras (FTS sem acento), grafia aproximada
 * (trgm) e significado (embedding, quando há provedor e pgvector), fundidos por RRF.
 *
 * ⚠️ É RANKING, não lista: os N mais próximos, com teto explícito (30) e `truncado` quando
 *    havia mais candidatos — a tela pede para refinar (padrão X7 de top-N com aviso de corte).
 *    Para percorrer o catálogo inteiro há `GET /v1/catalogo/produtos`, por cursor.
 * ⚠️ O vetor da consulta é calculado ANTES de abrir a transação (rede externa fora da tx).
 * ⚠️ Preço cotado no servidor pelo perfil (ADR-025); a requisição nunca carrega preço.
 */
export interface OpcoesRotasBuscaCatalogo {
  /** Provedor de embedding; padrão = o do ambiente. Teste injeta um falso. */
  readonly embedding?: PortaEmbedding
}

type Campo = 'q' | 'limite' | 'origem'

function invalido(campo: Campo, mensagem: string) {
  return { erro: 'catalogo.busca_invalida', mensagem, campos: [campo] }
}

/** Por que a semântica não rodou — a tela mostra (degradação visível, ADR-008). */
function situacaoSemantica(emb: ResultadoEmbutirConsulta, rodou: boolean): SituacaoSemantica {
  if (rodou) return 'ligada'
  if (emb.vetor === null) return emb.motivo === 'capacidade_desligada' ? 'sem_chave' : 'indisponivel'
  return 'sem_indice'
}

export async function rotasBuscaCatalogo(app: FastifyInstance, opcoes: OpcoesRotasBuscaCatalogo = {}): Promise<void> {
  app.get<{ Querystring: { q?: string; perfil?: string; categoria?: string; origem?: string; limite?: string } }>(
    '/v1/catalogo/busca-inteligente', { preHandler: exigirTenant },
    async (req, reply) => {
      const q = req.query
      const consulta = (q.q ?? '').trim()
      if (consulta === '' || consulta.length > MAX_CONSULTA_BUSCA_INTELIGENTE) {
        return reply.code(422).send(invalido('q', `Digite o que procura (até ${MAX_CONSULTA_BUSCA_INTELIGENTE} caracteres).`))
      }
      let limite: number = LIMITE_BUSCA_INTELIGENTE.padrao
      if (q.limite !== undefined) {
        limite = Number(q.limite)
        if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_BUSCA_INTELIGENTE.maximo) {
          return reply.code(422).send(invalido('limite', `O limite vai de 1 a ${LIMITE_BUSCA_INTELIGENTE.maximo}.`))
        }
      }
      let origem: OrigemCatalogo | undefined
      if (q.origem !== undefined && q.origem !== '') {
        if (!(ORIGENS_CATALOGO as readonly string[]).includes(q.origem)) {
          return reply.code(422).send(invalido('origem', 'Origem desconhecida: use erp ou manual.'))
        }
        origem = q.origem as OrigemCatalogo
      }
      const categoria = q.categoria?.trim() || undefined
      const perfil = perfilDeCotacao(q.perfil)

      // Rede externa ANTES da transação. Falha ou falta de provedor → lexical, com motivo.
      const porta = opcoes.embedding ?? embeddingDoAmbiente()
      const emb = await embutirConsulta(porta, consulta, { cache: cacheConsultaPadrao(sql) })

      // Pede um a mais que o limite: é assim que se sabe se cortou.
      const r = await req.comTenant((tx) => buscarCatalogo(tx, {
        consulta, perfil, limite: limite + 1,
        filtros: { ...(categoria ? { categoria } : {}), ...(origem ? { origem } : {}) },
        ...(emb.vetor ? { vetorConsulta: emb.vetor, modeloEmbedding: emb.modelo } : {}),
      }))

      return reply.send({
        itens: r.itens.slice(0, limite),
        fontes: r.fontes,
        semantica: situacaoSemantica(emb, r.fontes.includes('semantica')),
        truncado: r.itens.length > limite,
      })
    },
  )
}
