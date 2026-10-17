# Agente vendedor — go-live por fases

> Para quem decide **quando** o agente sobe de fase num número de um cliente. O "como usar" está em
> `agente-vendedor-operacao.md`; incidentes em `agente-runbook.md`; a revisão semanal em
> `agente-revisao-semanal.md`. Decisões: ADR-028 (modos e recorte), ADR-031 (qualidade e critérios de
> fase), ADR-032 (custo) e ADR-034 (SLA do handoff). Estrutura portada do GO-LIVE da AM Consórcio; o
> conteúdo é do GeraCRM.

⚠️ **Números de fase são PROPOSTA** (ADR-031). O painel com o critério calculado é da raia P19
(`GET /v1/agente/go-live?canalId`, shared `agente-fases.ts`), **ainda não integrada**. Até lá cada
número é medido à mão pelas rotas da §2. Onde houver `⚠️ P19:` o texto será conferido com
`agente-fases.ts` quando a P19 entrar.

## 0. O que liga e desliga

| Alavanca | Onde | Quem |
|---|---|---|
| Modo do número (`desligado`, `sombra`, `assistido`, `autonomo`) | Atendimento → Agente → Configuração; `PUT /v1/canais/:id/agente` | admin; `autonomo` e `desligado` pedem a palavra digitada |
| Teto da conta (kill switch) | `PUT /v1/agente/tenant` `{modoMaximo, confirmacao}` | admin, auditado |
| Recorte (horário, feriado dentro/fora, segmentos RFV, modo fora do recorte) | `agente_config.recorte`, mesma tela | admin |
| Playbook (estilo, roteiro, mensagens, compliance extra, ações) | aba Playbook; publicar exige observação | admin |
| Tetos de custo (dia e sessão do número; orçamento mensal da conta) | aba Proteções; `PUT /v1/canais/:id/agente/custo`, `PUT /v1/agente/orcamento` | admin |
| Amostra do juiz e teto mensal do juiz | aba Qualidade; `PUT /v1/canais/:id/agente/qualidade` | admin |
| SLA do handoff (minutos úteis, reatribuição, aviso de espera) | `PUT /v1/canais/:id/sla` | admin |

O modo **efetivo** é o mais restritivo entre conta, número e recorte (ADR-028). A tela mostra de onde
veio a restrição.

## 1. Fases

| Fase | O agente fala com o cliente? | Quem envia | Duração mínima (proposta) | Quem decide |
|---|---|---|---|---|
| 0 Homologação | não — playground e evals | ninguém | — | nosso time |
| 1 Sombra | não | o vendedor; o agente decide e grava | ≥ 10 dias úteis, ≥ 150 turnos e ≥ 50 conversas | nosso time + dono da loja |
| 2 Assistido | não — sugere no inbox | o vendedor (Usar, editar ou Descartar) | ≥ 10 dias úteis, ≥ 100 sugestões | nosso time + dono da loja |
| 3 Autônomo num recorte | sim, dentro do recorte | o agente | 21 dias | dono da loja |
| 4 Autônomo amplo | sim | o agente | permanente, revisão a cada 30 dias | dono da loja |

"Autônomo num recorte" é o que a AM chama de "assistido" (ADR-028): `autonomo` no número com
`agente_config.recorte` limitando horário e segmento. Fora do recorte o modo cai para o
`foraDoRecorte` (padrão `sombra`).

### Fase 0 — Homologação

**Objetivo:** provar catálogo, políticas, playbook e provedor sem cliente real.

Pré-requisitos (checklist de `agente-vendedor-operacao.md` §2): catálogo indexado, políticas escritas,
persona, alçada, aviso de privacidade (`PUT /v1/privacidade`), playbook importado e publicado.

| Critério (proposta) | Como medir |
|---|---|
| Evals B2B e conversas douradas com 0 CRÍTICA | `pnpm test` (CI, simulado) e a rodada real `IA_E2E=1` (`apps/api/src/contexts/atendimento/agente/evals/README.md`) |
| Smoke do provedor ok, inclusive a reserva | `pnpm --filter @geracrm/api agente:smoke` e `-- --reserva` (saída 0) |
| ≥ 30 conversas no playground com 0 CRÍTICA | aba Playground (`POST /v1/canais/:id/agente/simular`); transcrições difíceis em `agente:avaliar` (saída 2 = CRÍTICA) |

⚠️ P19: conferir nomes e alvos com `agente-fases.ts`.

### Fase 1 — Sombra

**Objetivo:** medir se o agente diria o que o vendedor disse, sem risco ao cliente.

Liga: modo `sombra`; amostra do juiz 1,0 (padrão do modo); revisão semanal começa
(`agente-revisao-semanal.md`).

| Critério (proposta, ADR-031) | Alvo | Como medir |
|---|---|---|
| Similaridade sombra × humano | ≥ 0,6 em ≥ 60% dos turnos comparados | `GET /v1/agente/sugestoes/metricas?canalId&dias` → `sombra.taxaAcimaDoLimiar` (limiar 0,6) |
| Violações CRÍTICA | 0 | `GET /v1/agente/qualidade/resumo?canalId&dias` → `porGravidade.CRITICA` |
| Nota média do juiz | ≥ 4 | mesmo resumo → `notaMedia` |
| Concordância juiz × gestor | ≥ 85% com ≥ 20 conversas distintas e 0 falso negativo crítico | `GET /v1/agente/revisao/concordancia?canalId&semana` → `atingeMeta` |
| Custo por conversa | ≤ R$ 1,50 | `GET /v1/agente/metricas?canalId&dias` → `custoPorConversaCentavos` |
| Turnos com número bloqueado | ≤ 2% | mesma rota: `turnosComNumeroBloqueado` ÷ `turnos` |

⚠️ A similaridade de sombra é **sinal a calibrar**, não régua firme: é Jaccard de palavras
(`similaridadeTextos`), e dois textos certos escritos de jeitos diferentes pontuam baixo. Use junto
com a concordância; não reprove só por ela até haver histórico real (ADR-031, atualização).

⚠️ P19: conferir alvos e fonte de cada critério com `agente-fases.ts`.

### Fase 2 — Assistido

**Objetivo:** o vendedor usa a sugestão? E usa sem mexer?

Liga: modo `assistido`; amostra do juiz 0,2. Treinamento do time: `agente-treinamento-1h.md`.

| Critério (proposta) | Alvo | Como medir |
|---|---|---|
| Uso da sugestão | ≥ 40% | `GET /v1/agente/sugestoes/metricas` → `assistido.taxaUso` |
| Enviadas sem edição | ≥ 70% (com ≥ 50 enviadas) | `assistido.taxaSemEdicao` |
| Violações CRÍTICA | 0 | `GET /v1/agente/qualidade/resumo` |

⚠️ P19: conferir.

### Fase 3 — Autônomo num recorte

**Objetivo:** o agente responde sozinho onde a equipe está de olho (ex.: horário comercial, segmento
de recompra).

Liga: modo `autonomo` + recorte; amostra do juiz 0,05; SLA do handoff configurado no número (sem linha
vale 30/60 minutos úteis com aviso de espera ligado — ADR-034).

| Critério (proposta) | Alvo | Como medir |
|---|---|---|
| Violações CRÍTICA | 0 nos últimos 14 dias | `GET /v1/agente/qualidade/resumo?dias=14` |
| 1ª resposta | p95 ≤ 6 s | `GET /v1/agente/metricas` → `latenciaP95Ms` |
| Handoff | entre 10% e 40% dos turnos | mesma rota: `handoffs` ÷ `turnos` e `handoffPorMotivo` |
| Opt-out | ≤ 1% | linha `opt_out` de `handoffPorMotivo` ÷ `conversas` |
| Conversão | não-inferior à coorte sem agente (−2 p.p.) | `pedidos` (propostos, confirmados, efetivados) da mesma rota × período anterior |
| Pedido confirmado errado | 0 | revisão semanal (decisão registrada) |
| SLA do handoff cumprido | acompanhar | `GET /v1/performance` → `slaHandoff.pctCumprido` |

⚠️ P19: conferir; a conversão não-inferior depende de coorte que a P19 define.

### Fase 4 — Autônomo amplo

Recorte removido (tirar o recorte de número autônomo pede a palavra `autonomo`). Revisão a cada 30
dias (§4). Critério violado → volta uma fase.

## 2. Como medir

Todas as rotas abaixo são do tenant do token (RLS) e aceitam `canalId`; as de período aceitam
`dias` (1–90, padrão 7).

| Pergunta | Rota |
|---|---|
| Quantos turnos, respostas, sugestões, handoffs por motivo, custo, p95, números bloqueados, pedidos | `GET /v1/agente/metricas` |
| Sugestões usadas, editadas, descartadas; sombra × humano | `GET /v1/agente/sugestoes/metricas` |
| Notas do juiz e violações por gravidade | `GET /v1/agente/qualidade/resumo`; lista em `GET /v1/agente/qualidade` (cursor) |
| Concordância da semana por número | `GET /v1/agente/revisao/concordancia` (gestor/admin) |
| SLA do handoff | `GET /v1/performance` → `slaHandoff` (`MetricaSlaHandoff`) |
| Por que o agente disse isso | `GET /v1/agente/decisoes` (cursor): marcas de guardrail, ferramentas, custo, modo efetivo |
| Saúde da operação | `GET /saude/detalhada` (`agente-runbook.md`) |

## 3. Rollback (voltar uma fase)

Gatilhos (qualquer um): violação CRÍTICA confirmada na revisão; duas CRÍTICA no mesmo número na
semana; falso negativo crítico (o gestor viu CRÍTICA que o sistema não viu); critério da fase violado
na revisão de 30 dias; pedido confirmado errado.

Procedimento:
1. **Rebaixar o modo do número** (`autonomo` → `assistido` ou `sombra`) em Configuração. Vale na
   próxima mensagem. Emergência na conta inteira: `PUT /v1/agente/tenant` com `modoMaximo: 'sombra'`
   ou `'desligado'` (kill switch; o registro das mensagens não para — ADR-028).
2. Conferir que nenhuma conversa ficou sem dono: handoffs em espera aparecem na fila (contador,
   inbox e kanban) com o cronômetro do SLA.
3. Registrar a decisão na revisão (`decisao = recuar_modo`, com responsável e prazo).
4. Se o problema foi conteúdo: corrigir no playbook (rascunho → testar → publicar) ou no conhecimento,
   e virar caso de regressão (`cenarios-b2b.ts` ou `agente:avaliar`).
5. Voltar a subir só depois de cumprir de novo o critério da fase de onde voltou.

Nada é apagado no rollback: decisões, avaliações e revisões ficam no banco e continuam medindo.

## 4. Revisão a cada 30 dias (autônomo)

Reunião do nosso time com o dono da loja, por número autônomo:
- critérios da Fase 3 recalculados nos últimos 30 dias (§2);
- concordância das quatro semanas e decisões abertas da revisão semanal;
- custo: teto do dia, teto da sessão, orçamento mensal (alertas `agente_orcamento_80`/`_100`) e
  modelos sem preço (`preco_desconhecido`);
- SLA do handoff: `slaHandoff.pctCumprido` e estouros (`sla_handoff_estourado`);
- playbook: versões publicadas no período (histórico, com observação);
- resultado: manter, ampliar o recorte, ou voltar uma fase. Registrar na ata da loja.

⚠️ P19: quando o painel de fase existir, a revisão parte dele.
