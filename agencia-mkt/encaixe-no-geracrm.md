# Encaixe no GeraCRM — o que reusa, o que falta, o que não reusar

> Avaliação feita em 2026-08-19 sobre o estado real do repositório (57 migrations, ~260 arquivos
> `.ts`, Ondas 0–3 majoritariamente entregues — ver `../docs/onde-estamos.md`).
> ⚠️ O `../CLAUDE.md` ainda diz "fase de planejamento, sem código de produção". Está desatualizado;
> a reconciliação de 2026-08-09 registra o stack rodando no Railway.

## Veredito

**Serve como base.** A metade difícil de um produto de mídia paga — isolamento multi-tenant,
conversa, qualificação de lead, opt-out invariante, atribuição de receita honesta e leitura da
venda no ERP — já está construída e testada. O que falta é **um contexto novo e periférico**
(`aquisicao`), aditivo, sem alterar a forma do núcleo.

⚠️ O que **não** funciona é tratar a operação de agência como "mais uma tela do CRM". São dois
vocabulários que colidem (ver §4) e dois regimes de risco diferentes: o CRM erra e alguém corrige;
a mídia erra e o dinheiro já foi embora.

---

## 1. O que reusa direto, sem tocar

| Ativo | Onde | Uso na agência |
|---|---|---|
| **Multi-tenant + RLS** (ADR-001) | todas as migrations, `aplicar_rls()` | Um tenant por cliente da agência. Isolamento de dado de lead entre clientes sai de graça. |
| **`contato` neutro** | `0008_contato_nucleo.sql` | ⚠️ Achado importante: **só `nome` é obrigatório** e o telefone é a chave primária de reconciliação (ADR-019). Um lead de anúncio — nome + telefone, sem CNPJ — cabe no cadastro **sem nenhuma alteração**. |
| **`qualificado` nullable** | `contato.qualificado` | `NULL` = não avaliado ≠ desqualificado. É exatamente a semântica que o agente de qualificação precisa. |
| **Kanban de Leads** | `crm/rotas-leads.ts` | Três colunas derivadas (Leads / Qualificados / Descartados), paginadas por cursor. A tela de curadoria humana **já existe**. |
| **Opt-out invariante** | `contato.recebe_campanhas`, `lista_bloqueio`, `rotas-bloqueios.ts` | ⚠️ Desligar bloqueia em **todos** os caminhos, inclusive disparo manual. Sem isso, agente autônomo é passivo jurídico. |
| **Gateway único de envio** | `atendimento/canais/gateway.ts` (E5-13) | Revalida no servidor: opt-out → estado do canal → credencial → janela 24h. **Toda** mensagem do SDR agent passa por aqui. Não há atalho. |
| **Motor de automações** | `crm/automacao-motor.ts`, `0046` | Gatilho → ação com dedup transacional (`automacao_execucao`) e advisory lock. Base do nurture de lead frio. |
| **Sequências e tarefas** | `0044`, `0039` | Cadência de follow-up e trabalho humano derivado do agente. |
| **Atribuição exata × estimada** | `0036`, `crm/campanha-analise.ts` | ⚠️ **O ativo conceitual mais valioso do repo.** A regra "nunca somar as duas, janela sempre declarada" é precisamente a disciplina que falta em ROAS de agência. Reusar a *régua*, não a tabela. |
| **Pedido efetivado no ERP** | ADR-005, `0021`, `contexts/pedido` | Receita **exata** em centavos. É o sinal que devolvemos à plataforma (ver `loop-de-dados.md`). |
| **Webhooks de saída** | `0033` + despachante (HMAC, retry, dead-letter) | Transporte confiável para fora já resolvido. |
| **Série temporal + alertas** | `0031` (`metrica_janela`, `alerta`) | ⚠️ O *Anomaly Watcher* de mídia não precisa de infra nova: gasto anômalo e CPL fora de banda são mais uma métrica e mais um tipo de alerta. |
| **Fila + assunção atômica** | INV-51, `atendimento_aberto_unico` (`0012`), `rotas-fila.ts` | ⚠️ O atendimento **puxado por humano** já existe, com corrida resolvida por índice único. O agente entra como mais um participante, sem caminho paralelo. |
| **Kanban de atendimento** | `0055`, `0056` | Etapas configuráveis por tenant, incluindo "Aguardando nós" — destino natural do handoff. |
| ⚠️ **Contra-métrica MC-05** | `primeira_resposta_humana_em` vs `primeira_resposta_em` (`0012`) | **O schema já previu o robô que responde em 2s e falseia o tempo de resposta.** É exatamente o risco do nosso argumento comercial. |
| **Auditoria** | `auditoria` + helper `auditar()` | Toda ação de agente que mexe em verba entra aqui. Requisito, não enfeite. |
| **Tempo real (SSE)** | ADR-007, outbox → NOTIFY → SSE | Lead novo aparece na tela na hora, sem polling. |
| **Skill `geracrm-ia`** | `.claude/skills/geracrm-ia/` | Já separa copiloto × agente autônomo e lista o checklist do autônomo (base de conhecimento versionada, limite de escopo, handoff, painel de auditoria, botão de desligar). Vale integralmente. |

## 2. O que falta — a lacuna real

Confirmado por varredura: **não há uma única ocorrência** de `utm`, `ad_id`, `click_id`, `fbclid`
ou `gclid` no schema ou no código.

| Falta | Por que é bloqueante | Onde entra |
|---|---|---|
| **Origem do lead** (UTM, `campaign_id`/`adset_id`/`ad_id`, `click_id`) | Sem isso não existe atribuição. É o item nº 1. | `midia_lead_origem`, 1:1 com `contato` |
| **Custo de mídia** | O CRM não tem noção de custo de veiculação. Sem custo não há CAC nem ROAS — só receita. | `midia_metrica_dia` |
| **Hierarquia de veiculação** | conta → campanha → conjunto → anúncio → criativo | tabelas `midia_*` |
| **Adaptadores de plataforma** | Meta Marketing API, Google Ads API | ⚠️ atrás de porta do **nosso** domínio, com capacidades declaradas — mesmo padrão do ADR-008 dos conectores de ERP |
| **Devolução de conversão** | CAPI / offline conversions com valor da venda | worker novo, alimentado pelo outbox |
| **Ingestão de lead de anúncio** | Lead Ads (webhook Meta), formulário de LP, Click-to-WhatsApp | gateway de webhooks já existe; falta o handler |
| **Públicos (custom audience)** | não há caminho para subir público a partir do ERP/RFV — o ativo mais raro da operação | `rede-de-pesca.md` §3 |
| **Roteamento do lead** | nada decide entre agente e fila humana hoje | `roteamento-do-lead.md` |
| **Catálogo público** | ⚠️ `apps/catalogo` está **não implementado** ("aguardando Onda 2") — é a landing page natural da Rede B | dívida da Onda 2 |
| **Reação em segundos** | ⚠️ `automacao-motor` varre a cada **5 min**. Speed-to-lead exige < 60s. | caminho por evento, ver §3 |
| **Ação "enviar mensagem"** | Decisão consciente atual: automação **não fala** com o cliente (`../docs/automacoes.md` §2) | ⚠️ mudança de política — AMK-004 |
| **Visão cross-tenant da agência** | A agência opera N tenants; o token dá **um**. | ⚠️ nunca furando RLS na API — AMK-005 |

## 3. As três colisões com o desenho atual

Não são defeitos do CRM — são consequências de ele ter sido desenhado para outro trabalho.

### 3.1 O motor de automação é agendado, e speed-to-lead não pode esperar

`../docs/automacoes.md` justifica bem a varredura: recompra e retenção são gatilhos **por tempo**,
onde latência de minutos é irrelevante. Para lead de anúncio a premissa se inverte — responder em
5 minutos em vez de 30 segundos custa conversão medida.

**Encaminhamento:** modelo híbrido, que o próprio documento já prevê em "o que viria depois". O
agendado continua dono de tempo/estado (nurture, lead frio); um caminho **por evento** — o outbox
que já existe, consumido pós-commit — atende o lead novo. Não é motor novo: é um segundo gatilho.

### 3.2 A automação foi proibida de falar com o cliente

Decisão explícita e correta no contexto dela: "automação que envia WhatsApp sozinha carrega risco
real (opt-out, janela de 24h, banimento no não-oficial)".

⚠️ A operação de agência **precisa** furar isso — é o coração do SDR agent. Mas não furando a
regra, e sim satisfazendo as condições que a motivaram:

- **Opt-out**: já resolvido — o gateway revalida.
- **Janela de 24h**: em **Click-to-WhatsApp Ads o lead inicia a conversa**, então a janela nasce
  aberta e a resposta é texto livre, sem template. É o formato que deve ser priorizado.
- **Banimento**: o ponto sério, e ⚠️ **só do canal não-oficial** (PlugZapi). Agente autônomo em
  volume ali é pedir ban (ADR-021). ✅ **O canal oficial já existe em código** (commits
  `ec4bbd1`/`44cdb06`, provedor `meta_oficial` ativo no catálogo) — num tenant oficial vale
  janela de 24h + template, não risco de ban. Ver AMK-014 e a **revisão de AMK-012**.

### 3.3 "Campanha" já tem dono no vocabulário

`campanha` no GeraCRM é **disparo de WhatsApp para a base**. Campanha de mídia paga é outra coisa,
com outro custo e outra unidade. Usar a mesma palavra cria duas verdades dentro do nome — o mesmo
erro que o comentário de `contato.qtd_vendas` evita de propósito.

**Encaminhamento:** prefixo `midia_` no schema e `Veiculacao` como termo de domínio para o conjunto.
Ver §4.

## 4. Vocabulário proposto

| Termo | Significa | ⚠️ Não confundir com |
|---|---|---|
| `Veiculacao` | Um anúncio no ar, com custo | `campanha` (disparo WhatsApp) |
| `midia_conta` | Conta de anúncio, por plataforma | `canal_conectado` (número de WhatsApp) |
| `midia_campanha` / `midia_conjunto` / `midia_anuncio` | Hierarquia espelhada da plataforma | `campanha` |
| `Criativo` | Peça (copy + imagem/vídeo), versionada | `template` (HSM da Meta) |
| `Origem` | De onde o lead veio (UTM + ids + `click_id`) | `origem_carga` (ERP × conversa) |
| `midia_metrica_dia` | Impressão, clique, **custo em centavos** | `metrica_janela` (série do CRM) |
| `Conversao` | O fato devolvido à plataforma | `venda` (fato do ERP) |

⚠️ `Conversao` e `venda` são deliberadamente distintas: uma venda gera uma conversão *devolvida*,
com identificador de entrega própria, retry e possibilidade de falha na plataforma. Colapsar as
duas esconde a falha de entrega.

## 5. O que **não** reusar

| Não reusar | Por quê |
|---|---|
| A tabela `campanha` para veiculação paga | §3.3 — vocabulário e unidade de custo diferentes |
| `classificarRfv` para lead novo | ⚠️ RFV pressupõe **histórico de compra**. Lead de anúncio tem zero. Qualificação de lead é outra régua (intenção, fit, orçamento) e precisa de motivo registrado. |
| O funil de relacionamento (`oportunidade`, `0034`) | É por **quantidade de pedidos** — eixo de recompra. Aquisição é eixo de qualificação, e esse já é o kanban de Leads. |
| O canal não-oficial para SDR autônomo | ADR-021 + AMK-004 — risco de banimento incompatível com volume automatizado |
| A visão de "campanha com ROI" como ROAS | Ela mede receita ÷ envios. ROAS exige **custo de mídia**, que não existe no modelo atual. |

## 6. Custo estimado da lacuna

Grosso modo, em ordem de dependência (detalhado em `roteiro.md`):

| Bloco | Peso | Depende de |
|---|---|---|
| Schema `midia_*` + origem do lead | pequeno | — |
| Ingestão de lead (webhook + LP + CTWA) | médio | schema |
| Adaptador Meta (leitura: métricas e custo) | médio | conta conectada, App Review |
| Devolução de conversão (CAPI/offline) | médio | origem do lead + pedido efetivado |
| Caminho por evento (speed-to-lead) | pequeno | outbox existente |
| SDR agent autônomo | grande | ⚠️ canal oficial da Meta (hoje deferido) |
| Adaptador de escrita (criar/pausar campanha) | grande | tudo acima + guardrails |

⚠️ O caminho crítico não é técnico: é o **registro na Meta** (Business Verification → Tech Provider
→ App Review), que `../docs/prontidao-para-inicio.md` já identifica como semanas fora do nosso
controle — e que vale tanto para o canal oficial de WhatsApp quanto para a Marketing API.
