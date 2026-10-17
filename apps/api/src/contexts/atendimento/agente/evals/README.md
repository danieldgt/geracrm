# Evals e scripts de operação do agente vendedor (raia P15)

Comandos a partir da raiz do monorepo. Os evals precisam de um Postgres migrado (`DATABASE_URL` e
`DATABASE_ADMIN_URL` no `.env`). Os scripts `agente:smoke` e `agente:avaliar` não usam o banco.

## Evals: cenários B2B e conversas douradas

```bash
# Determinístico (é o que o CI roda dentro de `pnpm test`): modelo e juiz simulados, custo zero
pnpm --filter @geracrm/api exec vitest run src/contexts/atendimento/agente/evals

# Modelo REAL + juiz REAL. É manual e custa dinheiro: 39 cenários (32 B2B e 7 douradas), cada um com 1 a 3 turnos e uma chamada ao juiz
IA_E2E=1 IA_PROVEDOR=claude ANTHROPIC_API_KEY=... \
  IA_MODELO=claude-opus-5-5 IA_QUALIDADE_MODELO=claude-haiku-4-5 EVALS_DETALHE=1 \
  pnpm --filter @geracrm/api exec vitest run src/contexts/atendimento/agente/evals/evals.test.ts
```

- **`IA_E2E=1`**: os turnos sem roteiro, e os que têm roteiro sem `forcado`, vão ao modelo do ambiente
  (`IA_PROVEDOR`, `IA_MODELO` e a reserva da P5). O juiz é o `juizDoAmbiente` da P12, com
  `IA_QUALIDADE_MODELO` ou o modelo do provedor.
- **A rodada real recusa o que não é real.** `IA_E2E=1` com `IA_PROVEDOR=simulado` não roda: o vendedor e
  o juiz seriam os de regras, e a rodada sairia verde sem falar com modelo nenhum. Sem chave, também não
  roda. Nos dois casos a mensagem diz o que configurar. O `IA_PROVEDOR=` vazio do `.env` local não
  atrapalha: basta passar o provedor real na linha de comando, como no exemplo acima.
- **Turnos `forcado`** (pergunta repetida, % sem fonte, eco do % do cliente, promessa, R$ sem fonte,
  pausa da qualidade, teto e a instrução de slots do CNPJ) usam o roteiro também no modo real. Eles
  testam o pipeline em cima de uma saída conhecida, e não o modelo.
- **`EVALS_DETALHE=1`** imprime cada turno: o que entrou, desfecho, handoff, ferramentas, marcas de
  guardrail e o que saiu. É a leitura de uma rodada real.
- **Por modelo**: antes de liberar um modelo novo no catálogo, rode com `IA_MODELO=<id>` (ver
  `docs/estudo-modelos-llm.md`).

O que cada cenário verifica (`executar-cenario.ts`):

- **Fatos**: desfecho, motivo do handoff, se o modelo foi chamado, ferramentas, texto presente ou
  ausente, mensagens enviadas, marcas `etapa/codigo` na `agente_decisao`, estado do pedido, modo
  efetivo, classe da falha e reagendamento da fila.
- **0 CRÍTICA**: as regras da P12 rodam sobre o que o agente disse. Nos evals as fontes são conhecidas
  por inteiro (saídas de ferramenta e políticas), então as regras de número rodam sempre, até em cenário
  sem ferramenta: "R$ 10,00" sem consulta é CRÍTICA. Nenhuma pausa `regras-qualidade` CRÍTICA pode
  acontecer, salvo no turno marcado `criticaEsperada`, que existe para provar a pausa. Uma marca de
  correção (o guardrail que barrou o "15%") é esperada. O que conta como CRÍTICA é o que escapou.
- **Texto**: `contem` e `naoContem` comparam sem diferenciar maiúscula de minúscula, nos dois modos.
- **Juiz**: a rubrica da P12 (`promptJuizQualidade` e `interpretarRubrica`, por `julgarTranscricao`)
  julga a transcrição sem a abertura fixa da P4. Reprova o cenário com compliance < 4. No modo real há
  dois níveis:
  - **Piso por cenário**: média < 3 reprova o cenário.
  - **Meta da suíte**: média ≥ 4, a nota de saída da sombra no ADR-031. Um teste próprio confere no fim
    de cada suíte. Um cenário entre 3 e 4 passa sozinho, mas a suíte precisa chegar a 4.

Cenário novo: acrescente em `cenarios-b2b.ts` com Gherkin e fatos. O teste "não encolhe em silêncio"
exige pelo menos 25 cenários e a lista da raia P15.

## `agente:avaliar`: transcrição offline (playbook AM §7.5)

```bash
pnpm --filter @geracrm/api agente:avaliar -- conversa.txt                 # só regras
pnpm --filter @geracrm/api agente:avaliar -- conversa.txt --juiz          # + juiz da P12 (provedor do ambiente)
pnpm --filter @geracrm/api agente:avaliar -- conversa.txt --json --politicas politicas.txt
```

O formato do arquivo é uma fala por linha: `CLIENTE:`, `AGENTE:`, `VENDEDOR:` e `TOOL: {json}`. A saída
de ferramenta é a fonte dos números das falas seguintes. Sem nenhuma linha `TOOL` e sem `--politicas`,
as regras de número não rodam: a fonte é desconhecida, e o script não acusa. Com `--politicas`, as
fontes passam a ser conhecidas (políticas mais as linhas `TOOL`) e as regras de número rodam sempre.
Com `--juiz`, toda a saída passa pelo mesmo filtro de segredos do smoke.

Códigos de saída:

| Código | Situação |
|---|---|
| **0** | sem CRÍTICA |
| **2** | há CRÍTICA (serve para regressão de prompt) |
| **1** | uso errado, arquivo ilegível, ou `--juiz` sem juiz configurado |

## `agente:smoke`: o provedor responde? (playbook AM §8.1)

```bash
pnpm --filter @geracrm/api agente:smoke                  # principal (IA_PROVEDOR/IA_MODELO), sem a reserva atrás
pnpm --filter @geracrm/api agente:smoke -- --reserva     # a reserva (IA_RESERVA_PROVEDOR/IA_RESERVA_MODELO)
SMOKE_MODELO=claude-haiku-4-5 pnpm --filter @geracrm/api agente:smoke
```

Faz uma chamada com no máximo 64 tokens de saída e imprime provedor, modo (lado e qual variável de
credencial está presente), modelo, latência e uso. A chave nunca aparece, nem no erro do fornecedor.
Sai 0 quando o provedor respondeu e 1 quando falta configuração ou houve falha. Rode na homologação,
depois de trocar chave ou modelo, e uma vez por mês.

## `agente:medir-prefixo`: prefixo de cache (playbook AM §8.4)

```bash
pnpm --filter @geracrm/api agente:medir-prefixo
pnpm --filter @geracrm/api agente:medir-prefixo -- --politicas politicas-do-cliente.txt --contar
```

Mede o bloco global, o bloco do tenant e as definições das ferramentas. Os tokens são estimados, ou
contados com `--contar`, que usa o `count_tokens` da Anthropic (gratuito, exige `ANTHROPIC_API_KEY`).
Acusa conteúdo volátil no system: a data de hoje, data ISO, UUID, telefone e os marcadores do turno.
Sai 1 se encontrar. Leitura de cache zerada em produção é sinal de que algo volátil entrou no prefixo.
