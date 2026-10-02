export const meta = {
  name: 'rodada-raias',
  description: 'Executa raias do plano-mestre em paralelo (uma por agente, em worktree), cada uma revisada por um cético antes de ser devolvida',
  whenToUse: 'Para abrir uma rodada de implementação com várias raias independentes (ex.: R5, R8, R10)',
  phases: [
    { title: 'Implementar', detail: 'um agente por raia, em worktree' },
    { title: 'Revisar', detail: 'um cético por raia, com a definição de pronto na mão' },
  ],
}

// args: { raias: ['R5','R8'], extra?: 'instruções comuns' }
const raias = (args && args.raias) || ['R5', 'R8']
const extra = (args && args.extra) || ''

const BRIEF = (r) => `Você implementa a raia ${r} de docs/plano-mestre-vendedor-autonomo.md §4 (leia o bloco inteiro da raia: ARQUIVOS, NÃO TOCAR, CONTRATO, PRONTO) e os ADRs citados em docs/decisoes.md. Skills obrigatórias em .claude/skills (geracrm-arquitetura, geracrm-testes, e as da área: geracrm-agente-vendas, geracrm-catalogo, geracrm-console-angular/layout-ui quando tocar apps/console). Ambiente: export PATH="$HOME/.local/bin:$PATH"; cp /Users/danieldgt/git/Gera3/GeraCRM/.env ./.env; pnpm install --frozen-lockfile; pnpm --filter @geracrm/shared build; pnpm --filter @geracrm/conectores build. O Postgres local (5442) é compartilhado: migrations aditivas com o número reservado no plano; fixtures de teste com UUIDs exclusivos. Definição de pronto = o bloco PRONTO da raia + typecheck/lint/test verdes do pacote tocado. Commit no seu branch (conventional, pt-BR, terminando com "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"); NÃO faça merge. Relate: branch, arquivos, escopo reduzido (explícito). ${extra}`

const RELATORIO = { type: 'object', properties: { branch: { type: 'string' }, resumo: { type: 'string' }, reduzido: { type: 'string' } }, required: ['branch', 'resumo'] }
const REVISAO = { type: 'object', properties: { aprovado: { type: 'boolean' }, problemas: { type: 'array', items: { type: 'string' } } }, required: ['aprovado', 'problemas'] }

const resultados = await pipeline(
  raias,
  (r) => agent(BRIEF(r), { label: `raia:${r}`, phase: 'Implementar', isolation: 'worktree', schema: RELATORIO }),
  (rel, r) => rel ? agent(
    `Revise o branch ${rel.branch} contra a definição de pronto da raia ${r} (docs/plano-mestre-vendedor-autonomo.md §4) e contra docs/decisoes.md. Procure requisito reduzido em silêncio, caminho de erro inventado, contrato inventado, teste que não testa, violação de RLS/paginação/dinheiro. Rode os testes do pacote. aprovado=false com a lista se houver qualquer item de gravidade alta.`,
    { label: `revisar:${r}`, phase: 'Revisar', schema: REVISAO }).then((rev) => ({ raia: r, ...rel, revisao: rev })) : null,
)

const prontos = resultados.filter(Boolean)
log(`${prontos.filter((p) => p.revisao && p.revisao.aprovado).length}/${prontos.length} raia(s) aprovadas`)
return prontos
