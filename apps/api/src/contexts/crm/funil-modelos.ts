import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/index.js'

/**
 * Modelos de funil — o "molde de raias" que um cliente novo recebe ao nascer.
 *
 * ⚠️ Por que existe mais de um: o funil de venda RECORRENTE (atacado) não é o
 * funil de venda de SOFTWARE. No primeiro o cliente compra todo mês e o card
 * anda conforme a relação evolui; no segundo há uma negociação com começo e fim.
 * Forçar os dois no mesmo molde obrigava o cliente a renomear tudo na entrada.
 *
 * ⚠️ O modelo é ponto de PARTIDA, não trilho: depois de semeado, cada cliente
 * edita as etapas por `/v1/funil/config/etapas`. Nada aqui é lido em runtime
 * para decidir comportamento — quem manda é `funil_etapa.tipo`.
 *
 * `ordem` nasce com buraco antes do 9 (perdido) para caber etapa nova no meio
 * sem renumerar a coluna inteira.
 */

export type ChaveModeloFunil = 'crm-recompra' | 'erp-software'

export interface EtapaModelo {
  readonly ordem: number
  readonly chave: string
  readonly nome: string
  readonly tipo: 'aberto' | 'ganho' | 'perdido'
  readonly criterio: string
}

export interface MotivoModelo {
  readonly codigo: string
  readonly nome: string
}

export interface ModeloFunil {
  readonly nome: string
  readonly descricao: string
  readonly etapas: readonly EtapaModelo[]
  readonly motivos: readonly MotivoModelo[]
}

/** O molde histórico (migration 0034) — continua sendo o padrão de quem não escolhe. */
export const MODELO_FUNIL_PADRAO: ChaveModeloFunil = 'crm-recompra'

export const MODELOS_FUNIL: Record<ChaveModeloFunil, ModeloFunil> = {
  'crm-recompra': {
    nome: 'Venda recorrente (atacado)',
    descricao: 'O card anda conforme a relação evolui; o cliente compra de novo, não "fecha".',
    etapas: [
      { ordem: 1, chave: 'lead', nome: 'Lead', tipo: 'aberto', criterio: 'Contato novo, ainda sem conversa iniciada' },
      { ordem: 2, chave: 'conversa', nome: 'Em conversa', tipo: 'aberto', criterio: 'Conversa ativa no WhatsApp' },
      { ordem: 3, chave: 'orcamento', nome: 'Orçamento', tipo: 'aberto', criterio: 'Pedido/orçamento em montagem' },
      { ordem: 4, chave: 'pedido', nome: '1º pedido', tipo: 'ganho', criterio: 'Primeiro pedido efetivado no ERP' },
      { ordem: 5, chave: 'recorrente', nome: 'Recorrente', tipo: 'ganho', criterio: 'Comprou 2 vezes ou mais' },
      { ordem: 9, chave: 'perdido', nome: 'Perdido', tipo: 'perdido', criterio: 'Não avançou; motivo obrigatório' },
    ],
    motivos: [
      { codigo: 'preco', nome: 'Preço' },
      { codigo: 'sem_resposta', nome: 'Parou de responder' },
      { codigo: 'concorrente', nome: 'Foi para o concorrente' },
      { codigo: 'sem_interesse', nome: 'Sem interesse' },
      { codigo: 'outro', nome: 'Outro' },
    ],
  },
  'erp-software': {
    nome: 'Venda de software (ERP)',
    descricao: 'Negociação com começo e fim: da prospecção fria ao contrato assinado.',
    etapas: [
      { ordem: 1, chave: 'lead', nome: 'Lead', tipo: 'aberto', criterio: 'Empresa prospectada, ainda sem contato' },
      { ordem: 2, chave: 'contato', nome: 'Contato feito', tipo: 'aberto', criterio: 'Falou com alguém que decide' },
      { ordem: 3, chave: 'demo', nome: 'Demonstração', tipo: 'aberto', criterio: 'Demonstração agendada ou realizada' },
      { ordem: 4, chave: 'proposta', nome: 'Proposta', tipo: 'aberto', criterio: 'Proposta enviada, aguardando resposta' },
      { ordem: 5, chave: 'assinou', nome: 'Assinou', tipo: 'ganho', criterio: 'Contrato fechado' },
      { ordem: 9, chave: 'perdido', nome: 'Perdido', tipo: 'perdido', criterio: 'Não avançou; motivo obrigatório' },
    ],
    motivos: [
      { codigo: 'preco', nome: 'Preço' },
      { codigo: 'ja_tem_sistema', nome: 'Já tem sistema' },
      { codigo: 'porte_insuficiente', nome: 'Porte insuficiente' },
      { codigo: 'sem_interesse', nome: 'Sem interesse' },
      { codigo: 'sem_resposta', nome: 'Parou de responder' },
      { codigo: 'empresa_inativa', nome: 'Empresa inativa' },
    ],
  },
}

export function ehModeloFunil(valor: unknown): valor is ChaveModeloFunil {
  return typeof valor === 'string' && valor in MODELOS_FUNIL
}

/**
 * Semeia etapas e motivos se o tenant não tem nenhum (tenant novo — não há
 * bootstrap central). Idempotente. Roda dentro de `comTenant` (tenant_atual()).
 *
 * ⚠️ A guarda de contagem é o ponto: sem ela, a etapa que o cliente apagou
 * voltaria no próximo GET. Etapas e motivos são contados SEPARADAMENTE porque
 * são catálogos independentes — e ficar sem motivo nenhum trava a coluna de
 * perda, que exige motivo do catálogo.
 *
 * ⚠️ Só semeia quem já existia antes do modelo (migration 0034) com
 * 'crm-recompra': é o molde que aqueles tenants receberam.
 */
export async function garantirEtapasFunil(
  tx: Sql,
  modelo: ChaveModeloFunil = MODELO_FUNIL_PADRAO,
): Promise<void> {
  const m = MODELOS_FUNIL[modelo] ?? MODELOS_FUNIL[MODELO_FUNIL_PADRAO]

  const [temEtapa] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM funil_etapa WHERE tenant_id = tenant_atual()`
  if ((temEtapa?.n ?? 0) === 0) {
    for (const e of m.etapas) {
      await tx`INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo, criterio)
               VALUES (tenant_atual(), ${randomUUID()}, ${e.ordem}, ${e.chave}, ${e.nome}, ${e.tipo}, ${e.criterio})
               ON CONFLICT (tenant_id, chave) DO NOTHING`
    }
  }

  const [temMotivo] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM motivo_perda WHERE tenant_id = tenant_atual()`
  if ((temMotivo?.n ?? 0) === 0) {
    for (const mv of m.motivos) {
      await tx`INSERT INTO motivo_perda (tenant_id, codigo, nome)
               VALUES (tenant_atual(), ${mv.codigo}, ${mv.nome})
               ON CONFLICT (tenant_id, codigo) DO NOTHING`
    }
  }
}
