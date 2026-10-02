export const meta = {
  name: 'revisar-raia',
  description: 'Revisão adversarial de uma raia (branch ou diff): achados por lente, refutação em painel, só sobrevive o que ninguém derrubou',
  whenToUse: 'Depois que um agente entrega uma raia do plano-mestre e antes de integrar na main',
  phases: [
    { title: 'Achar', detail: 'uma lente por agente sobre o diff' },
    { title: 'Refutar', detail: 'três céticos por achado' },
    { title: 'Sintetizar', detail: 'lista final com arquivo:linha' },
  ],
}

// args: { alvo: 'worktree-agent-xxx' | 'HEAD~1' | caminho, contexto?: 'R1'…'R10' }
const alvo = (args && args.alvo) || 'HEAD~1'
const contexto = (args && args.contexto) || 'a raia'

const LENTES = [
  { key: 'reducao', prompt: `Compare o diff de ${alvo} com o briefing da raia ${contexto} em docs/plano-mestre-vendedor-autonomo.md §4. Liste REQUISITOS REDUZIDOS EM SILÊNCIO: o que o briefing pedia e o código não faz (ou faz pela metade) sem dizer. Para cada um: arquivo, o que falta, evidência.` },
  { key: 'erro', prompt: `No diff de ${alvo}, encontre CAMINHOS DE ERRO inventados ou ausentes: falha de rede, resultado tipificado ignorado, catch vazio, transação aberta esperando rede, exceção onde devia ser retorno tipificado (regra da casa: falha de negócio é retorno tipificado). arquivo:linha + cenário concreto que quebra.` },
  { key: 'contrato', prompt: `No diff de ${alvo}, encontre CONTRATOS INVENTADOS: método/porta que não existe, assinatura alterada de porta compartilhada, tipo duplicado fora de packages/shared, import interno entre contextos (apps/api/src/contexts/*). arquivo:linha + por quê.` },
  { key: 'teste', prompt: `No diff de ${alvo}, encontre TESTES QUE NÃO TESTAM: passam sem exercitar a regra, foram ajustados para caber no código, usam o superusuário onde deviam usar geracrm_api (RLS), fixture com UUID repetido de outro arquivo, ou faltam os casos obrigatórios da skill geracrm-testes (dois tenants, caminho feliz + validação + infra fora). arquivo:linha.` },
  { key: 'rls', prompt: `No diff de ${alvo}, encontre violações do ADR-001 e das regras de CLAUDE.md: tabela sem tenant_id/aplicar_rls, tenant_id vindo de parâmetro, lista sem cursor, enum TS, dinheiro em float, número monetário vindo do modelo sem ferramenta, canal sem tenant, migration não aditiva. arquivo:linha.` },
]

const ACHADOS = {
  type: 'object',
  properties: { achados: { type: 'array', items: { type: 'object', properties: {
    arquivo: { type: 'string' }, linha: { type: 'integer' }, titulo: { type: 'string' }, evidencia: { type: 'string' }, gravidade: { type: 'string', enum: ['alta', 'media', 'baixa'] },
  }, required: ['arquivo', 'titulo', 'evidencia', 'gravidade'] } } },
  required: ['achados'],
}
const VEREDITO = { type: 'object', properties: { refutado: { type: 'boolean' }, motivo: { type: 'string' } }, required: ['refutado', 'motivo'] }

const confirmados = await pipeline(
  LENTES,
  (l) => agent(l.prompt + ' Responda só com os achados; sem achado, lista vazia.', { label: `achar:${l.key}`, phase: 'Achar', schema: ACHADOS }),
  async (r, l) => {
    if (!r || !r.achados.length) return []
    const votos = await parallel(r.achados.map((a) => () =>
      parallel([0, 1, 2].map((i) => () => agent(
        `Tente REFUTAR este achado da lente ${l.key} sobre ${alvo}: "${a.titulo}" em ${a.arquivo}:${a.linha ?? '?'} — evidência: ${a.evidencia}. Leia o código de verdade. Se não conseguir provar que está errado, refutado=false. Na dúvida, refutado=true (ângulo ${i + 1}).`,
        { label: `refutar:${l.key}:${i + 1}`, phase: 'Refutar', schema: VEREDITO })))
        .then((vs) => ({ a, sobrevive: vs.filter(Boolean).filter((v) => !v.refutado).length >= 2 }))))
    return votos.filter(Boolean).filter((v) => v.sobrevive).map((v) => ({ ...v.a, lente: l.key }))
  },
)

phase('Sintetizar')
const lista = confirmados.filter(Boolean).flat()
log(`${lista.length} achado(s) sobreviveram à refutação`)
return { alvo, contexto, achados: lista.sort((a, b) => ['alta', 'media', 'baixa'].indexOf(a.gravidade) - ['alta', 'media', 'baixa'].indexOf(b.gravidade)) }
