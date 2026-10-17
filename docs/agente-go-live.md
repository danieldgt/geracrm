# Agente vendedor — go-live por fases

> Para quem decide **quando** o agente sobe de fase num número de um cliente. O "como usar" está em
> `agente-vendedor-operacao.md`; incidentes em `agente-runbook.md`; a revisão semanal em
> `agente-revisao-semanal.md`. Decisões: ADR-028 (modos e recorte), ADR-031 (qualidade e critérios de
> fase), ADR-032 (custo) e ADR-034 (SLA do handoff). Estrutura portada do GO-LIVE da AM Consórcio; o
> conteúdo é do GeraCRM.

⚠️ **Os alvos são PROPOSTA** (ADR-031): números da AM adaptados ao B2B, a validar com o primeiro
cliente. Eles moram como constantes nomeadas `ALVO_*` em `packages/shared/src/dominio/agente-fases.ts`, e
este documento os repete; se divergirem, vale o código. O painel (aba **Métricas** do agente,
`GET /v1/agente/go-live?canalId`, gestor/admin, só leitura) calcula cada critério e devolve
`alvosProposta: true`. O painel **só informa**: quem muda o modo é uma pessoa, na Configuração.

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
| Conferência de homologação (douradas, smoke) | aba Métricas; `POST /v1/agente/go-live/conferencia` | admin, auditado |

O modo **efetivo** é o mais restritivo entre conta, número e recorte (ADR-028). A tela mostra de onde
veio a restrição.

## 1. Fases e como o painel decide

| Fase (`FASES_AGENTE`) | Vem do modo do número | O agente fala com o cliente? | Quem decide |
|---|---|---|---|
| Homologação (`homologacao`) | `desligado` | não — playground e evals | nosso time |
| Sombra (`sombra`) | `sombra` | não; decide e grava | nosso time + dono da loja |
| Assistido (`assistido`) | `assistido` | não — sugere no inbox | nosso time + dono da loja |
| Autônomo num recorte (`autonomo_recorte`) | `autonomo` com recorte que restringe | sim, dentro do recorte | dono da loja |
| Autônomo amplo (`autonomo_amplo`) | `autonomo` sem recorte | sim | dono da loja; revisão a cada 30 dias |

- A fase vem do modo **do número** e do recorte (`faseDoModo`), não do modo do minuto: fora do horário do
  recorte o agente está em sombra agora, mas a fase continua "autônomo num recorte". Recorte inválido
  conta como recorte. O "assistido" da AM é o nosso autônomo num recorte (ADR-028).
- **Início da fase**: a última mudança auditada (`agente.config_alterada`) que **trocou a fase**
  (`inicioDaFasePorAuditoria`). Mudar a persona ou ajustar o horário do recorte não zera a contagem. Sem
  auditoria, o início é estimado pela 1ª decisão no modo (`inicioEstimado`).
- **Dias pausados pelo teto**: com o kill switch do tenant segurando o número abaixo do modo dele, o número
  aparece "pausado pelo teto" (`pausadoPeloTeto`), a fase **não muda** e esses dias **não contam**
  (`diasPausados`, descontados de `dias`).
- **Três resultados por critério**: cumpre (`ok: true`); reprova (`ok: false`: a medida existe, tem
  amostra e ficou fora do alvo); ou **sem medida** (`ok: null`: fonte ausente, sem conferência, ou
  **amostra insuficiente**, sempre com o motivo). **Falta de amostra nunca é reprovação.**
- **Avançar** (`podeAvancar`) exige **todos** os critérios com `ok: true` (falha fechada). No autônomo
  amplo só **reprovação** recomenda voltar (`recomendacao: 'voltar'`, `voltarPara`); sem medida mantém e
  mostra o que falta medir.
- **Janela das medidas**: desde o início da fase (1 a 90 dias). No recorte, a CRÍTICA olha os últimos
  14 dias; no amplo, tudo olha os últimos 30.

### Fase 0 — Homologação

**Objetivo:** provar catálogo, políticas, playbook e provedor sem cliente real. Pré-requisitos no
checklist de `agente-vendedor-operacao.md` §2.

| Critério (id) | Alvo (PROPOSTA) | Fonte |
|---|---|---|
| Conversas douradas sem CRÍTICA (`douradas`) | ≥ 25 cenários, 0 CRÍTICA | **conferência manual**: um admin roda os evals (`IA_E2E=1`, `evals/README.md`) e registra cenários e CRÍTICAs |
| Smoke do provedor de IA (`smoke`) | ok | **conferência manual**: um admin roda `pnpm --filter @geracrm/api agente:smoke` (e `-- --reserva`) e registra |
| Conversas testadas no playground (`playground_conversas`) | ≥ 30, cada uma com ≥ 3 turnos | **medido pelo sistema** a cada reinício do playground |
| CRÍTICA no playground (`playground_critica`) | 0 | idem; regras de qualidade (P12) sobre as marcas das decisões |

- **Conferência** (`POST /v1/agente/go-live/conferencia`, só admin, auditada com antes/depois):
  `{item: 'douradas', canalId, cenarios, criticas}` ou `{item: 'smoke', canalId, ok}`. Vale **30 dias**
  (`VALIDADE_CONFERENCIA_DIAS`); o painel mostra quem declarou e quando. Fica em `agente_homologacao`.
- **Playground por reinício**: cada "Reiniciar conversa" grava uma entrada `{em, turnos, criticas}`
  (`somarPlayground`). Contam só as entradas dos últimos 30 dias **e depois do corte**: a última
  publicação do playbook ou mudança na configuração do número. Teste de uma versão anterior não vale para
  a atual.

### Fase 1 — Sombra

**Objetivo:** medir se o agente diria o que o vendedor disse, sem risco ao cliente. Liga: modo `sombra`;
amostra do juiz 1,0; revisão semanal começa (`agente-revisao-semanal.md`).

| Critério (id) | Alvo (PROPOSTA) | Fonte |
|---|---|---|
| Tempo na fase (`dias_uteis`) | ≥ 10 dias úteis | auditoria do modo (P14), menos os dias pausados |
| Turnos na fase (`turnos`) | ≥ 150 | `agente_decisao` |
| Conversas na fase (`conversas`) | ≥ 50 | `agente_decisao` |
| Sombra parecida com o humano (`similaridade_sombra`) | ≥ 60% dos turnos comparados com similaridade ≥ 0,6 | `agente_decisao.sombra_similaridade` (P13) |
| CRÍTICA que escapou (`critica`) | 0 | `agente_avaliacao` (P12) |
| Nota média do juiz (`nota_juiz`) | ≥ 4,0, **só com a concordância na meta** | juiz amostrado (P12) |
| Concordância humano × juiz (`concordancia`) | ≥ 85% com ≥ 20 conversas revisadas e 0 CRÍTICA não vista | `agente_revisao` (P16) |
| Custo por conversa (`custo_conversa`) | ≤ R$ 1,50 (o juiz aparece à parte, fora do alvo) | `agente_decisao.custo_centavos` (P6) |
| Turnos com número bloqueado (`numeros_bloqueados`) | ≤ 2% | guardrail numérico (P7) |

Fica sem medida quando: nenhuma resposta humana depois de um turno de sombra (similaridade); menos de 20
conversas revisadas comparáveis (concordância); nenhuma avaliação do juiz, ou concordância fora da meta
(nota). Uma **CRÍTICA não vista pelo juiz reprova com qualquer amostra**.

⚠️ A similaridade de sombra é **sinal a calibrar** (Jaccard de palavras): leia junto com a concordância.

### Fase 2 — Assistido

**Objetivo:** o vendedor usa a sugestão, e usa sem mexer? Liga: modo `assistido`; amostra do juiz 0,2;
treinamento do time (`agente-treinamento-1h.md`).

| Critério (id) | Alvo (PROPOSTA) | Fonte |
|---|---|---|
| Tempo na fase (`dias_uteis`) | ≥ 10 dias úteis | auditoria do modo |
| Sugestões geradas (`sugestoes`) | ≥ 100 | `agente_decisao.sugestao_estado` (P13) |
| Sugestões usadas pelo vendedor (`uso_sugestao`) | ≥ 40% | idem: (enviadas + editadas) ÷ geradas |
| Enviadas sem edição (`sem_edicao`) | ≥ 70% com ≥ 50 enviadas (abaixo de 50: sem medida) | idem |
| CRÍTICA que escapou (`critica`) | 0 | `agente_avaliacao` (P12) |

### Fase 3 — Autônomo num recorte

**Objetivo:** o agente responde sozinho onde a equipe está de olho. Liga: modo `autonomo` + recorte;
amostra do juiz 0,05; SLA do handoff do número (sem configuração vale 30/60 min úteis com aviso de
espera ligado, ADR-034).

| Critério (id) | Alvo (PROPOSTA) | Fonte |
|---|---|---|
| Tempo na fase (`dias`) | ≥ 21 dias corridos | auditoria do modo, menos os dias pausados |
| CRÍTICA nos últimos 14 dias (`critica`) | 0 | `agente_avaliacao` (P12) |
| p95 do cliente falar até a 1ª resposta (`p95_primeira`) | ≤ 6,0 s | 1ª mensagem do cliente → 1ª mensagem do agente na sessão; inclui a espera da fila (debounce) |
| Conversas passadas para humano (`handoff`) | entre 10% e 40% | `agente_decisao.desfecho = handoff` |
| Opt-out nas conversas do agente (`opt_out`) | ≤ 1% | marcas de opt-out (P4) |
| Conversão em pedido × coorte humana (`conversao`) | não-inferior: limite inferior do IC unilateral de 95% da diferença ≥ −2,0 p.p. | pedido confirmado ou efetivado por conversa, coortes maduras |
| Pedido confirmado errado (`pedido_errado`) | 0 | pedido do agente confirmado e depois cancelado (aproximação) |
| SLA do handoff cumprido (`sla_handoff`) | ≥ 90% | `atendimento` (P18): cumpridos ÷ medidos, sem arredondar |

**Conversão** (`julgarConversao`):
- Coortes **maduras** (conversa com ≥ 14 dias, `CONVERSAO_MATURACAO_DIAS`) do mesmo número. A coorte humana
  é a conversa respondida por pessoa (régua da P18, `enviada_por_id`). As coortes não são aleatorizadas
  (o agente atende o recorte, o humano o resto); o painel nomeia o **viés de seleção**.
- Diferença agente − humano com o **intervalo de Newcombe** (híbrido de Wilson), IC unilateral de 95%.
- Coorte vazia → **sem medida**.
- Intervalo inteiro abaixo de −2 p.p. → **reprova** (inferioridade clara, com qualquer n).
- n abaixo do necessário para poder de 80% (`amostraParaNaoInferioridade`; no B2B costuma passar de
  milhares por coorte) → **cumpre com alerta** "amostra sem poder para −2,0 p.p.; leitura indicativa",
  com o limite inferior e o n. É leitura, não prova.
- Com poder → cumpre se o limite inferior ≥ −2 p.p.

### Fase 4 — Autônomo amplo

Recorte removido (tirar o recorte de número autônomo pede a palavra `autonomo`). Permanente, revisado a
cada 30 dias (§4). Critérios, todos nos **últimos 30 dias**: CRÍTICA = 0, p95, handoff, opt-out,
conversão, pedido confirmado errado e SLA ≥ 90%, com os mesmos alvos da Fase 3. Aqui o pedido cancelado
depois da confirmação vira **alerta "Revise…"**, não reprovação. Critério **reprovado** → o painel
recomenda voltar para o recorte.

## 2. Como medir

O painel junta tudo: `GET /v1/agente/go-live?canalId` (gestor/admin) devolve `fase`, `dias`,
`diasUteis`, `diasPausados`, `inicioFase`, `janelaDias`, `criterios[{id, rotulo, alvo, valor, ok, fonte,
motivo?, alerta?}]`, `podeAvancar`, `recomendacao` e `pendencias`. Cada fonte é coletada à parte: a que
falha vira "sem medida" com o motivo e as outras seguem. Para investigar um número, as rotas de origem
(todas do tenant do token, com `canalId` e `dias` de 1 a 90):

| Pergunta | Rota |
|---|---|
| Turnos, respostas, sugestões, handoffs por motivo, custo, p95, números bloqueados, pedidos | `GET /v1/agente/metricas` (`MetricasAgenteDto`) |
| Sugestões usadas, editadas, descartadas; sombra × humano | `GET /v1/agente/sugestoes/metricas` |
| Notas do juiz e violações por gravidade | `GET /v1/agente/qualidade/resumo`; lista em `GET /v1/agente/qualidade` (cursor) |
| Concordância da semana por número | `GET /v1/agente/revisao/concordancia` (gestor/admin) |
| SLA do handoff | `GET /v1/performance` → `slaHandoff` (`MetricaSlaHandoff`, a mesma conta do painel) |
| Por que o agente disse isso | `GET /v1/agente/decisoes` (cursor): marcas de guardrail, ferramentas, custo, modo efetivo |
| Saúde da operação | `GET /saude/detalhada` (`agente-runbook.md`) |

## 3. Rollback (voltar uma fase)

Gatilhos (qualquer um): recomendação "voltar" do painel; violação CRÍTICA confirmada na revisão; duas
CRÍTICA no mesmo número na semana; CRÍTICA não vista pelo juiz; pedido confirmado errado confirmado na
revisão.

Procedimento:
1. **Rebaixar o modo do número** (`autonomo` → `assistido` ou `sombra`) em Configuração. Vale na
   próxima mensagem. Emergência na conta inteira: `PUT /v1/agente/tenant` com `modoMaximo: 'sombra'`
   ou `'desligado'` (kill switch: o número fica "pausado pelo teto", a fase não muda, os dias pausados
   não contam, e o registro das mensagens não para — ADR-028).
2. Conferir que nenhuma conversa ficou sem dono: handoffs em espera aparecem na fila (contador, inbox e
   kanban) com o cronômetro do SLA.
3. Registrar a decisão na revisão (`decisao = recuar_modo`, com responsável e prazo).
4. Se o problema foi conteúdo: corrigir no playbook (rascunho → testar → publicar) ou no conhecimento,
   e virar caso de regressão (`cenarios-b2b.ts` ou `agente:avaliar`). Publicar o playbook corta o
   playground da homologação: os testes têm de ser refeitos sobre a versão nova.
5. Voltar a subir só depois de cumprir de novo o critério da fase de onde voltou. A troca de modo que
   muda a fase reinicia a contagem de dias.

Nada é apagado no rollback: decisões, avaliações e revisões ficam no banco e continuam medindo.

## 4. Revisão a cada 30 dias (autônomo)

Reunião do nosso time com o dono da loja, por número autônomo, a partir da aba Métricas:
- critérios do painel (janela de 30 dias no amplo): reprovados, sem medida e alertas (conversão sem
  poder, pedido cancelado depois da confirmação);
- concordância das quatro semanas e decisões abertas da revisão semanal;
- custo: teto do dia, teto da sessão, orçamento mensal (alertas `agente_orcamento_80`/`_100`) e
  modelos sem preço (`preco_desconhecido`);
- SLA do handoff: `slaHandoff.pctCumprido` e estouros (`sla_handoff_estourado`);
- playbook: versões publicadas no período (histórico, com observação);
- resultado: manter, ampliar o recorte, ou voltar uma fase. Registrar na ata da loja.
