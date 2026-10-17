import { randomUUID } from 'node:crypto'
import { ALERTA_TETO_JUIZ, ALERTA_VIOLACAO_CRITICA } from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../../db/index.js'

/**
 * ALERTAS DA QUALIDADE (ADR-031, raia P12) na tabela `alerta` — o sino e a
 * faixa de alertas do console já leem dela (SSE `alerta.novo`).
 *
 * ⚠️ Um alerta ABERTO por tipo e tenant (índice `alerta_aberto_unico`): a 2ª
 *    violação crítica com o 1º ainda aberto não vira spam — o log registra cada uma.
 * ⚠️ O texto do alerta NÃO carrega conteúdo da conversa (nem trecho, nem
 *    telefone): só a regra. Quem quer ver abre a aba Qualidade, sob RLS.
 */

/** Log estruturado com contexto de tenant (skill geracrm-observabilidade): sem PII. */
export function logQualidade(nivel: 'warn' | 'error', evento: string, dados: Readonly<Record<string, unknown>>): void {
  const linha = JSON.stringify({ nivel, contexto: 'agente.qualidade', evento, ...dados })
  if (nivel === 'error') console.error(linha)
  else console.warn(linha)
}

async function abrir(tx: Sql, tipo: string, severidade: 'aviso' | 'critico', mensagem: string): Promise<boolean> {
  const nova = await tx<{ id: string }[]>`
    INSERT INTO alerta (tenant_id, id, tipo, severidade, mensagem)
    VALUES (tenant_atual(), ${randomUUID()}, ${tipo}, ${severidade}, ${mensagem})
    ON CONFLICT (tenant_id, tipo) WHERE resolvido_em IS NULL DO NOTHING
    RETURNING id`
  if (nova.length > 0) {
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'alerta.novo', 'tenant', tenant_atual(), '{}'::jsonb)`
  }
  return nova.length > 0
}

/** Violação CRÍTICA antes do envio. Melhor-esforço: nunca derruba o turno. */
export async function abrirAlertaViolacaoCritica(p: {
  readonly tenantId: string; readonly conversaId: string; readonly canalId: string; readonly modo: string
  readonly regras: readonly string[]; readonly pausou: boolean
}): Promise<void> {
  logQualidade('error', ALERTA_VIOLACAO_CRITICA, {
    tenantId: p.tenantId, conversaId: p.conversaId, canalId: p.canalId, modo: p.modo, regras: [...new Set(p.regras)], pausou: p.pausou,
  })
  const regras = [...new Set(p.regras)].join(', ').slice(0, 160)
  const mensagem = p.pausou
    ? `O agente escreveu uma resposta com violação crítica (${regras}). A mensagem NÃO foi enviada e a conversa foi para a equipe. Veja em Agente → Qualidade.`
    : `Uma sugestão do agente teve violação crítica (${regras}) e foi marcada "não envie assim". Veja em Agente → Qualidade.`
  await comTenantServico(p.tenantId, (tx) => abrir(tx, ALERTA_VIOLACAO_CRITICA, 'critico', mensagem))
    .catch((e: Error) => logQualidade('warn', 'alerta_violacao_critica_falhou', { tenantId: p.tenantId, erro: e.message }))
}

/** O juiz parou no teto mensal do número. Chamar sob tenant. */
export async function abrirAlertaTetoJuiz(tx: Sql, canalNome: string, tetoCentavos: number): Promise<boolean> {
  const reais = (tetoCentavos / 100).toFixed(2).replace('.', ',')
  return abrir(tx, ALERTA_TETO_JUIZ, 'aviso',
    `O avaliador de qualidade do número "${canalNome.slice(0, 60)}" chegou ao teto do mês (R$ ${reais}) e parou até o mês virar. `
    + 'As regras continuam valendo em 100% das mensagens. Ajuste em Agente → Qualidade.')
}
