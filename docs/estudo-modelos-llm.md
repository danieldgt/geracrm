# Estudo — modelos de IA para o vendedor: o que serve, o que é grátis, e como o cliente escolhe

> 2026-10-04. Pergunta do dono: "quais LLMs gratuitas dão conta do nosso escopo, e como deixar o
> cliente do CRM escolher o modelo — com a Gera3 controlando o que cada cliente pode usar?"

## 1. O que o nosso escopo exige do modelo

O vendedor (ADR-023) não é um chatbot de texto: a cada turno ele precisa **chamar ferramentas**
(buscar catálogo, cotar, montar pedido, propor), **devolver JSON no esquema** `respostaDoAgente`,
escrever **português brasileiro natural** e **respeitar regras** ("número só se veio de ferramenta").
Isso elimina a maioria dos modelos pequenos: sem tool calling confiável, o agente não vende — só
conversa. Critérios, em ordem:

1. Tool calling estável (chama a ferramenta certa com argumentos válidos, várias rodadas).
2. Saída estruturada (ou pelo menos obedece "responda só JSON" — o adaptador já tolera texto cru).
3. Português do Brasil sem sotaque de tradução.
4. Latência compatível com chat (< 5 s por chamada).
5. Limite gratuito que caiba numa loja pequena (dezenas de conversas/dia ≈ 300–600 chamadas).

## 2. Levantamento (out/2026)

| Fornecedor / modelo | Grátis? | Limite gratuito | Ferramentas | pt-BR | Veredito para vender |
|---|---|---|---|---|---|
| **Groq · GPT-OSS 120B** | sim | 30 req/min, 1 000 req/dia, 8k tokens/min | sim | bom | **melhor gratuito** |
| **Groq · Llama 3.3 70B** | sim | 30 req/min, 1 000 req/dia, 12k tokens/min | sim | bom | ótimo para começar |
| Groq · GPT-OSS 20B | sim | 30 req/min, 1 000 req/dia | sim | ok | loja pequena |
| Groq · Llama 3.1 8B | sim | 14 400 req/dia | fraco | fraco | só triagem |
| Cerebras · Llama 3.3 70B / Qwen3 235B | sim | 30 req/min, 1 M tokens/dia, **contexto 8k** | sim | bom | reserva do Groq (8k aperta com histórico) |
| Gemini 2.5 Flash (AI Studio) | sim | ~5 req/min, ~100 req/dia desde abr/2026 | sim | muito bom | cota pequena demais |
| Mistral (Experiment) | sim | ~1 bi tokens/mês | sim | bom | **exige opt-in de treinar com os dados** — LGPD: não |
| OpenRouter `openrouter/free` | sim | varia | filtra quem aceita | varia | funciona; qualidade oscila a cada chamada |
| OpenRouter `qwen/qwen3-coder:free` | sim | varia | sim | ok | razoável |
| OpenRouter `cohere/north-mini-code:free` | sim | varia | diz que sim | ok | **ignorou o formato em produção** — não usar |
| Maritaca · Sabiá 3.1 | não (barato) | R$ 5 / R$ 10 por 1 M tokens | verificar | **o melhor pt-BR** | ótimo custo/benefício nacional |
| Claude Sonnet 5.5 | não | US$ 2 / 10 por 1 M | excelente | excelente | operação diária |
| Claude Opus 5.5 | não | US$ 4 / 20 por 1 M (cache -60%) | excelente | excelente | autônomo sem susto |

Observações que mudam a decisão:
- O limite que morde no Groq é **tokens por minuto**, não req/dia: um turno do vendedor tem ~3–5k
  tokens de prompt (persona + políticas + histórico). Com 8–12k TPM, cabem 2–3 turnos por minuto
  por chave — suficiente para uma loja, insuficiente para dez. A chave é por organização.
- Modelo gratuito **não garante formato**: por isso o adaptador escreve o esquema no prompt,
  tenta `json_schema` → `json_object` → nada, e aceita texto cru como uma mensagem (confiança
  baixa). O guardrail numérico e a alçada continuam valendo — a segurança não depende do modelo.
- LGPD: conversa de cliente vai para o fornecedor. Groq, Cerebras e OpenRouter (modelos pagos)
  não treinam com dados por padrão; Mistral Experiment e vários `:free` do OpenRouter **podem**.
  O catálogo registra isso na observação, e a tela mostra.

## 3. A pergunta de produto: quem escolhe o quê

Três camadas, cada uma com um dono:

| Camada | Quem decide | Onde mora | Exemplo |
|---|---|---|---|
| **Catálogo** — o que o produto sabe operar | Gera3 (engenharia) | `modelo_ia` (global, 0093) | "Groq GPT-OSS 120B, grátis, ferramentas, qualidade 4" |
| **Permissão** — o que este cliente pode escolher | Gera3 (comercial/staff), por cliente ou plano | `tenant_modelo_ia` | "Loja X: só os gratuitos"; "Loja Y: + Sonnet" |
| **Escolha** — qual modelo este número usa | O cliente, na tela do agente | `agente_config.modelo` (código do catálogo) | "WhatsApp Loja Centro: Llama 3.3 70B" |

Regras:
- A **chave do fornecedor é nossa**, uma por fornecedor, no ambiente. O cliente escolhe o modelo,
  nunca vê credencial. Fornecedor sem chave no servidor aparece como **indisponível**, com o nome
  da variável — nunca some em silêncio (ADR-008).
- Sem permissão explícita, o cliente vê os modelos marcados `padrao_novos_tenants` (hoje: os
  gratuitos do Groq + Opus/Sonnet). Comercial restringe ou amplia por cliente.
- Trocar de modelo vale na próxima mensagem; a decisão de cada turno grava qual modelo respondeu
  (`agente_decisao.modelo`), então custo e qualidade são comparáveis por modelo no painel.
- Cobrança: o plano pode incluir um modelo gratuito e cobrar excedente dos pagos; o custo
  estimado por turno já existe (`custo_centavos`) para isso.

## 4. Como ficou implementado

- `modelo_ia` + `tenant_modelo_ia` (0093), catálogo inicial com 12 entradas.
- API: `GET /v1/agente/modelos` (o que este tenant pode escolher, com `disponivel` e
  `motivoIndisponivel`); PUT do agente valida `modelo` contra a permissão; staff:
  `GET/PUT /v1/plataforma/clientes/:id/modelos`.
- Fábrica: o código do catálogo resolve `{provedor, modelo}` e monta o adaptador certo
  (Claude, OpenRouter, Groq, Gemini, Cerebras, Maritaca — os cinco últimos pelo fio OpenAI).
- Console: seletor de modelo na tela do agente (grátis/pago, ferramentas, qualidade, custo,
  indisponível com motivo); na Plataforma → Clientes, a lista de modelos permitidos por cliente.

## 5. Recomendação de operação

1. **Hoje, sem orçamento:** `GROQ_API_KEY` no servidor; catálogo libera `groq-gpt-oss-120b` e
   `groq-llama-3-3-70b` para todos; `openrouter-free` como reserva.
2. **Primeiro cliente pagante:** Sonnet 5.5 permitido para ele; medir custo por conversa no painel.
3. **Quando o volume passar de uma loja por chave Groq:** chave paga do Groq (centavos por
   conversa) ou Maritaca para pt-BR.
4. Rodar as conversas douradas (`IA_E2E=1`) **por modelo** antes de liberar no catálogo — o juiz
   diz se o modelo vende ou só conversa.

Fontes: [Free LLM APIs 2026 (OpenRouter)](https://openrouter.ai/blog/tutorials/free-llm-apis-compared/) ·
[Free tiers Groq/Cerebras/Mistral](https://ianlpaterson.com/blog/free-llm-api-2026/) ·
[Groq free plan](https://costbench.com/software/llm-api-providers/groq/free-plan/) ·
[Groq models](https://console.groq.com/docs/models.md) · [Gemini free tier 2026](https://agentdeals.dev/gemini-api-pricing-changes) ·
[OpenRouter free router](https://openrouter.ai/docs/guides/routing/routers/free-router) ·
[Maritaca API](https://www.maritaca.ai/en/api) · [LLMs em pt-BR](https://www.promptquorum.com/pt/local-llms/best-local-llms-portuguese-language-2026).
