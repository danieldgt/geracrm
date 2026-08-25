# Backlog técnico — o que falta programar

> Consolidação dos pontos de implementação identificados em [`encaixe-no-geracrm.md`](encaixe-no-geracrm.md),
> agrupados pelas fases do [`roteiro.md`](roteiro.md). Prefixo **AQ** (aquisição), no mesmo espírito
> dos épicos EP/E5/INT do `../docs/backlog-epicos-geracrm.md`.

⚠️ Este é o backlog do **contexto novo**. Ele não altera a forma do núcleo do GeraCRM — só adiciona.

## Estado da implementação (2026-08-23)

| Legenda | Significa |
|---|---|
| ✅ | pronto e testado |
| 🔨 | parcial — a parte de baixo (schema/domínio) existe, falta rota/tela/worker |
| (sem marca) | não começado |

**Feito até aqui** — branch `docs/agencia-mkt`:

| Entrega | Onde |
|---|---|
| Schema de estrutura, custo e `modo_entrada` | `infra/migrations/0058_midia_estrutura.sql` |
| Schema de origem do lead + sessão da LP | `infra/migrations/0059_midia_lead_origem.sql` |
| Conversão de custo na borda (micros · decimal · soma · ROAS) | `packages/shared/src/dominio/midia-custo.ts` |
| Código de origem (gerar · montar · **extrair**) | `packages/shared/src/dominio/midia-origem.ts` |
| Porta de plataforma com capacidades declaradas | `apps/api/src/contexts/aquisicao/plataformas/porta.ts` |
| Motor de roteamento (regra pura, 9 regras em ordem) | `packages/shared/src/dominio/roteamento-lead.ts` |
| Resolução tardia da origem (idempotente, não adivinha) | `apps/api/src/contexts/aquisicao/resolucao-origem.ts` |
| Schema da devolução de sinal | `infra/migrations/0060_midia_conversao.sql` |
| Despachante de conversões (backoff, dead-letter, advisory lock) | `apps/api/src/contexts/aquisicao/despachante-conversao.ts` |
| Enfileirador (venda → conversão, uma por plataforma) | `apps/api/src/contexts/aquisicao/enfileirar-conversao.ts` |
| Rotas HTTP (contas · painel · ROI · sessão da LP · diagnóstico) | `apps/api/src/contexts/aquisicao/rotas-aquisicao.ts` |
| **Adaptador Google Ads** (leitura, versão configurável, paginação) | `apps/api/src/contexts/aquisicao/plataformas/google-ads.ts` |
| Provedor de access token (refresh → access, com cache e folga) | `.../plataformas/google-oauth.ts` |
| Fábrica por variável de ambiente (degrada sem config) | `.../plataformas/fabrica.ts` |
| Sincronizador de mídia (UPSERT, órfãs contadas, cota medida) | `apps/api/src/contexts/aquisicao/sincronizador.ts` |
| Diagnóstico da primeira chamada real | `.../plataformas/diagnostico-google.ts` |
| Agendamento das varreduras (cadência pela cota) | `apps/api/src/contexts/aquisicao/worker.ts` |
| Vigia de anomalia (5 regras puras, reusa `alerta` de `0031`) | `apps/api/src/contexts/aquisicao/vigia.ts` |
| Resumo diário (geração pura, entrega injetada) | `apps/api/src/contexts/aquisicao/resumo-diario.ts` |
| Tela de mídia + formulário de conexão de conta | `apps/console/src/app/funcionalidades/aquisicao/midia.pagina.ts` |
| ROI da veiculação (custo · leads · atribuição por modelo) | `apps/api/src/contexts/aquisicao/roi.ts` |

**Verificado:** 10 varredores de schema · **549 testes na API** · 94 no `shared` · build do console ok · ⚠️ **os três checks verdes** (`lint`, `typecheck`, `test`).

### ✅ A Fase 0 está LIGADA de ponta a ponta (2026-08-23)

Adaptador Google, worker agendado, rotas e tela existem e rodam. As credenciais estão no Railway, e
a **primeira chamada real** confirmou que o nível de acesso alcança conta de produção
([`onboarding-google-ads.md`](onboarding-google-ads.md)).

⚠️ **O único bloqueio agora é externo e é do dono da conta:** a conta de anúncio `997-075-4431` tem
o cadastro incompleto (falta forma de pagamento) e responde `CUSTOMER_NOT_ENABLED`. Sem conta
habilitada não há estrutura nem métrica para ler — e sem dado real não dá para **medir a cota**, que
é o número que define quantos clientes cabem antes do Basic.

---

## Antes de tudo: o que NÃO está aqui porque já existe

Isolamento multi-tenant, cadastro de lead sem documento, kanban de qualificação, opt-out
invariante, gateway de envio, motor de automação agendado, sequências, tarefas, série temporal,
alertas, auditoria, tempo real, entrega confiável para fora, storage de mídia, leitura de venda e
pedido do ERP. É a metade cara, e está construída.

---

## Fase 0 — Observar (só leitura, zero risco de gasto)

| # | Épico | Depende de | Peso |
|---|---|---|---|
| ✅ **AQ-01** | Schema `midia_*`: conta, campanha, conjunto, anúncio, criativo. RLS em todas, chave composta `(tenant_id, id)`, id externo da plataforma com `UNIQUE(tenant_id, plataforma, id_externo)` | — | P |
| ✅ **AQ-02** | `midia_metrica_dia`: impressão, clique, **custo em centavos**, conversões reivindicadas pela plataforma. ⚠️ Conversão de micros (Google) e float (Meta) **no adaptador** | AQ-01 | P |
| ✅ **AQ-04** | **Adaptador Google — leitura**, validado por chamada real. Versão configurável (⚠️ o Google desativa versões e as requisições **falham**), paginação obrigatória, causa do erro desenterrada | credencial ✅ | M |
| **AQ-03** | Adaptador **Meta — leitura**, ⚠️ **restrito à conta da própria Gera3** (Rede A). Sem App Review não lê conta de cliente (AMK-012) | — | M |
| ✅ **AQ-05** | **Sincronizador agendado** (6h, por conta, ⚠️ **pula a MCC**) + conversões (15 min). A cadência foi decidida pela **cota medida**, não por palpite | AQ-02/04 | M |
| ✅ **AQ-06** | **Painel de mídia**: endpoints + **tela** (5 estados, custo/lead, paginada por cursor). ⚠️ ROAS fica de fora de propósito — exige modelo e janela declarados | AQ-02 | M |
| ✅ **AQ-07** | **Vigia de anomalia** (5 regras puras, dedup e resolução automática de `0031`, de hora em hora). ⚠️ Inclui "cliques e gasto sem NENHUM lead" — o sinal que o painel da plataforma não mostra | AQ-02 | P |
| ✅ **AQ-08** | **Resumo diário**: geração + **entrega LIGADA** por webhook de saída (`0033`). Uma por tenant por dia, travada pela chave `(tenant_id, dia)` do `0061`, na **hora local** do cliente. ⚠️ Dia sem dado não vira recibo — o lead que entra às 21h ainda faz o resumo sair | AQ-07 | P |
| ✅ **AQ-36** | **`modo_entrada`** editável por campanha (`PATCH /v1/aquisicao/campanhas/:id`) e escolhido na criação da LP — com a **consequência escrita na tela** (quem começa a conversa decide se a janela de 24h nasce aberta e se o agente assume). Vale daqui para a frente: o modo é copiado na ENTRADA do lead | AQ-01 | M |
| ✅ **AQ-44** | **LP no ar**: `GET /publico/lp/:chave` serve a página e `POST .../sessao` grava o clique. ⚠️ O que estava travado não era a página — era o TENANT: a rota é pública e o tenant é **resolvido pela chave** (`lp_por_chave`, `0062`), como o webhook resolve pelo `phone_number_id` (`0057`). Sessão nasce no CLIQUE, não no carregamento | AQ-01 | G |
| ✅ **AQ-45** | **Consumo LIGADO na ingestão**: a mensagem entrante consome o código e vira `midia_lead_origem` no MESMO commit (savepoint — atribuição não derruba mensagem). Estados nomeados (`sem_codigo`/`sessao_desconhecida`/`ja_consumida`/`registrada`) e ⚠️ **taxa de código perdido** por LP na tela | AQ-44 | M |

**Critério de saída:** lemos as contas dos clientes todo dia, produzimos relatório que eles não
tinham, e **não tocamos em nada**.

---

## Fase 1 — Loop de dados (a fase que define o produto)

| # | Épico | Depende de | Peso |
|---|---|---|---|
| ✅ **AQ-09** | `midia_lead_origem` **1:N** com `contato`: UTM, ids de plataforma, `click_id` (`fbclid`/`gclid`/`wbraid`), LP, referrer, **consentimento (texto + timestamp)**, `capturado_em` do servidor | AQ-01 | P |
| **AQ-10** | Ingestão **Lead Ads** (webhook Meta), handler idempotente. ⚠️ Código HTTP é instrução: falha permanente responde 200 e vai para o log | AQ-09 | M |
| **AQ-11** | ~~Ingestão **Click-to-WhatsApp**~~ — ⏸️ **fora de escopo** enquanto AMK-012 valer (CTWA é formato Meta). Substituído por AQ-44/45. Volta sem retrabalho se o registro sair | — | — |
| ✅ **AQ-12** | **Formulário na LP**: `POST /publico/lp/:chave/lead` com rate limit, campo-armadilha e ⚠️ **reconciliação por telefone** (AQ-13) — quem já é cliente ganha um TOQUE, não um contato duplicado. Grava a submissão CRUA (`midia_lp_submissao`, `0063`) além do contato | AQ-09 | P |
| 🔨 **AQ-13** | Reconciliação por **telefone normalizado** ✅ no caminho do formulário e no da mensagem (ADR-019, só telefone PRINCIPAL). Falta nos caminhos que ainda não existem (Lead Ads) | AQ-09 | P |
| **AQ-14** | **CAPI / Enhanced Conversions** com `event_id` compartilhado com o pixel (dedup) e PII **hasheada** | AQ-09 | M |
| 🔨 **AQ-15** | **Conversor**: schema (`0060`), **despachante** e **enfileirador** prontos. ⚠️ Falta só o **adaptador real** — que depende do developer token. Devolve `Compra` com **valor real do pedido efetivado**, com cursor no outbox, retry, dead-letter e ⚠️ falha de janela **nomeada** — mesma forma do despachante de `webhook_saida` (`0033`) | AQ-14, pedido | M |
| ✅ **AQ-16** | **ROI da veiculação** com custo: cálculo, endpoint **e tela**, com fato e modelo em blocos separados e a DISTÂNCIA entre o ROAS atribuído e o sem ambiguidade lida em português. ⚠️ "Exata × estimada" não transfere para mídia — ver `implementacao.md` §7. ⚠️ Nunca somados, janela sempre declarada (régua de `0036`) | AQ-02, AQ-15 | M |
| **AQ-37** | **Sincronização de públicos** (Google **Customer Match**): sobe lista a partir de compradores reais do ERP e das faixas RFV, PII **hasheada**, re-sync periódico. ⚠️ Customer Match tem **requisitos de elegibilidade** — verificar **antes** de prometer ao cliente (AMK-015) | AQ-14 | M |
| **AQ-38** | **Públicos de exclusão**: já é cliente, já está em conversa e ⚠️ **opt-out** (`recebe_campanhas = false` deve alcançar a mídia paga, não só a mensagem) | AQ-37 | P |
| **AQ-39** | **Funil por origem** como instrumento de diagnóstico: impressão → clique → lead → qualificado → pedido → venda, com custo em cada etapa | AQ-16, AQ-18 | M |

⚠️ A Fase 1 devolve **dois sinais** à plataforma: as **conversões** (o que funcionou) e os
**públicos** (para quem procurar). Mesma disciplina de hash e de janela nos dois.

**Critério de saída:** dizer, com auditoria, **quanto cada anúncio faturou no ERP**.

---

## Fase 2 — Leads

| # | Épico | Depende de | Peso |
|---|---|---|---|
| **AQ-17** | **Caminho por evento** para lead novo (outbox → NOTIFY → handler), latência de segundos. ⚠️ Dedup com a mesma disciplina do `automacao_execucao` — reentrega não gera segunda mensagem | AQ-10/11/12 | P |
| **AQ-18** | **Qualificador**: enriquecimento, score, ⚠️ **motivo registrado**. Saída tipada com Zod | AQ-17 | M |
| **AQ-19** | **SDR agent** (Rede B, identificado como assistente): base de conhecimento versionada, limite de escopo, handoff por regra **e por incerteza**, registro de toda conversa, ⚠️ **botão de desligar por número e por tenant**. Todo envio pelo gateway | AQ-36 · ⚠️ **só inbound** (AMK-014) | G |
| **AQ-46** | **Copiloto da Rede A**: sugere, a pessoa envia. Dispensa o checklist do agente autônomo (AMK-014) | AQ-18 | M |
| **AQ-47** | ⚠️ **Teto de volume e saúde do número para o agente**: o SDR respeita o aquecimento em rampa (`0037`) e a saúde da frota (EP-03) — o risco do não-oficial fica **medido**, não evitado | AQ-19 | P |
| **AQ-20** | **Painel de auditoria do agente**: atendidos, qualificados, descartados, **tempo até qualificação**, canal, origem | AQ-18/19 | M |
| **AQ-21** | **Nurture**: gatilho e ação novos no motor agendado existente (`0046`) | AQ-18 | P |
| **AQ-22** | ⚠️ **Ação "enviar mensagem"** na automação — mudança da política atual (`../docs/automacoes.md` §2), atrás do gateway e dos guardrails | AQ-19 | M |
| 🔨 **AQ-40** | **Motor de roteamento** (`roteamento-do-lead.md` §4): 8 regras avaliadas em ordem, ⚠️ em código, com **default humano** | AQ-17, AQ-09 | M |
| **AQ-41** | **Agente como participante da fila**: `usuario` não-humano que assume pelo **mesmo INV-51**. ⚠️ Sem caminho paralelo — agente desligado simplesmente não assume | AQ-19 | P |
| **AQ-42** | **Handoff com contexto**: transcrição, o que foi qualificado, **motivo**, origem de mídia e o que falta perguntar → etapa "Aguardando nós" (`0056`) | AQ-41 | M |
| **AQ-43** | ⚠️ **Resposta humana × automática** no painel: o agente preenche `primeira_resposta_em`, **nunca** `primeira_resposta_humana_em` (contra-métrica MC-05, `0012`) | AQ-41 | P |

**Critério de saída:** speed-to-lead em segundos, 24/7 — vendável isoladamente.

---

## Fase 3 — Criativo em volume

| # | Épico | Depende de | Peso |
|---|---|---|---|
| **AQ-23** | **Fábrica de criativo**: N variações por ângulo, saída tipada (hook, corpo, CTA, formato), guidelines por cliente | AQ-01 | M |
| **AQ-24** | **Revisor de conformidade** como **gate** antes de qualquer publicação: política de anúncio, categorias especiais, coerência anúncio ↔ LP | AQ-23 | M |
| **AQ-25** | **Biblioteca de criativo** versionada, com histórico de desempenho por peça | AQ-23, AQ-02 | M |
| **AQ-26** | **Analista de performance**: fadiga (frequência, CTR, CPM), escalar/manter/matar com ⚠️ **piso de massa** — mesmo padrão de `avaliarEntrega` (`0031`) | AQ-02 | M |
| **AQ-27** | **Pesquisador** com **Meta Ad Library** (API pública) | — | M |

⚠️ **AQ-36 — Destino e entrada** aparece antes de todos estes, na Fase 0/1: decidir e implementar
CTWA como formato prioritário (`rede-de-pesca.md` §2) é pré-requisito de AQ-11, e é o que faz a
janela de 24h nascer aberta — sem ele o SDR agent depende de template pago e engessado.

---

## Fase 4 — Escrita em veiculação (risco crescente)

| # | Épico | Depende de | Peso |
|---|---|---|---|
| **AQ-28** | **Plano de mudança** persistido e comparável + **modo dry-run** por ação e por conta (AMK-008) | AQ-03 | M |
| **AQ-29** | Guardrails em código: teto diário, delta máximo por ciclo, frequência mínima entre ações, **kill switch** global/tenant/conta | AQ-28 | M |
| **AQ-30** | Fluxo de **aprovação humana** com auditoria (`auditar()`: valor antes/depois + justificativa) | AQ-28 | M |
| **AQ-31** | Adaptador de **escrita**: (1) pausar criativo → (2) publicar criativo → (3) orçamento no delta → (4) criar estrutura. ⚠️ Nesta ordem | AQ-29/30 | G |

---

## Fase 5 — Escala

| # | Épico | Depende de | Peso |
|---|---|---|---|
| **AQ-32** | **Agregação cross-tenant** em worker dono, materializada por tenant. ⚠️ A API nunca ganha caminho "listar tudo" (AMK-005) | — | M |
| **AQ-33** | **Console da agência** sobre o resumo materializado | AQ-32 | M |
| **AQ-34** | **Onboarding de conta de anúncio**: vínculo no BM como parceiro + ⚠️ **meio de pagamento como passo obrigatório** (AMK-002) | AQ-03 | M |
| **AQ-35** | Playbooks por vertical (herda o conceito de perfil de vertical do ADR-004) | — | M |

---

## Dívida herdada que bloqueia

| Item | Estado hoje | Bloqueia |
|---|---|---|
| **Canal oficial da Meta** | ✅ **código pronto** (`ec4bbd1`/`44cdb06`) — falta o cadastro, que é **do cliente** | — |
| **Marketing API da Meta** | ❓ ⚠️ **verificar** se o padrão "App do cliente" serve para anúncios — reabre AMK-015 | CTWA · `ctwa_clid` |
| **Nosso Tech Provider / App Review** | ⬜ não iniciado | Embedded Signup · escalar sem onboarding manual |
| **Developer token + MCC do Google Ads** | 🔴 **não iniciado** — guia executável em [`onboarding-google-ads.md`](onboarding-google-ads.md) | ⚠️ AQ-04. **Mas ver o `Explorer`**: ele já toca produção e costuma ser automático, então a Fase 0 pode destravar sem esperar aprovação |
| **`apps/catalogo` ou LP mínima** | ✅ **LP mínima servida pela API** (`pagina-lp.ts`), na mesma origem do console pelo proxy do nginx. Quando o catálogo SSR existir, vira rota lá — o contrato `/publico/lp/:chave` não muda | — |
| **CI como gate** (R-08) | ❌ dívida da Onda 0 | ⚠️ tudo — agente com poder de escrita sem CI verde é risco desnecessário |
| **Biblioteca de componentes** (R-12) | ❌ dívida da Onda 0 | AQ-06, AQ-20, AQ-33 (telas novas) |

⚠️ O caminho crítico continua sendo **externo**: o registro na Meta leva semanas e não depende de
nós. Se a Fase 2 está no plano, ele começa **junto com a Fase 0**.
