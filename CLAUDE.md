# GeraCRM

CRM de atendimento (WhatsApp/Instagram) + funil de recompra + campanhas com ROI + pedido assistido,
para venda B2B recorrente. Monorepo pnpm+Turborepo: `apps/api` (Fastify), `apps/console` (Angular),
`apps/app` (Expo), `apps/catalogo` (SSR), `packages/shared` (tipos/Zod **TypeScript puro**),
`packages/conectores` (adaptadores de ERP).

- **Decisões técnicas**: `docs/decisoes.md` (ADRs) — consultar antes de propor mudança estrutural.
- **Regras de código**: skills `geracrm-arquitetura`, `geracrm-testes`, `geracrm-console-angular`
  (`.claude/skills/`) — obrigatórias em qualquer código. Há skills por área: `geracrm-whatsapp-meta`,
  `geracrm-tempo-real`, `geracrm-dados-postgres`, `geracrm-conectores-erp`,
  `geracrm-identidade-acesso`, `geracrm-monorepo-deploy`, `geracrm-ia`, `geracrm-observabilidade`,
  `geracrm-agente-vendas` (o vendedor autônomo), `geracrm-catalogo` (catálogo e busca).
- **Arquitetura em diagramas**: `docs/arquitetura-visual.md` — 11 diagramas Mermaid.
- **`tenant_id` vem do token autenticado, NUNCA de parâmetro.** RLS em toda tabela de domínio.
  Chave única sempre composta (`UNIQUE(tenant_id, cnpj)`). É o ADR-001 e não tem exceção.
- **Canal de push nunca é montado sem tenant.** O nome do canal sai de uma única função que não
  aceita montar sem `tenant_id`; a autorização é revalidada **a cada subscrição**, não só no login;
  e o payload do evento **não carrega conteúdo** — o cliente busca por API sob RLS. Se o fan-out
  errar o alvo, o intruso recebe um ID que não resolve. Regras em `geracrm-tempo-real`.
- **Listas sempre paginadas** (server-side, por **cursor**, nunca `OFFSET` profundo): endpoint E
  tela. Proibido lista ilimitada ou `top-N` cru. Origem: grids não paginados derrubaram o Postgres
  do GeraCloud por OOM em horário comercial — e nosso kanban tem coluna com 11 mil cards.
- **Migrations sobem sozinhas, antes do código**: SQL à mão em `infra/migrations`, runner no
  `preDeployCommand`. A migration roda com a **versão anterior ainda atendendo** — tem de ser
  aditiva; remover ou renomear coluna são dois deploys. Sem `drizzle-kit generate` (ADR-006).
- **Falha de negócio é retorno tipificado, não exceção.** Estoque insuficiente e crédito bloqueado
  são resultados esperados — a tela precisa deles nomeados, com ação corretiva (PED-08).
- **O pedido nasce na conversa, o ERP efetiva** (ADR-005). ⚠️ Falha na efetivação **nunca perde o
  rascunho** — é onde produtos desse tipo morrem na prática.
- **Multi-ERP**: a porta é definida pelo NOSSO domínio, nunca pela API do fornecedor. Cada conector
  declara capacidades e o produto **degrada em vez de quebrar** — e a degradação é visível na
  interface (ADR-008). Só o contexto `integracao` conhece formato de ERP.
- **Webhook: o código HTTP é instrução, não relatório** — 2xx encerra, erro faz a Meta reenviar.
  Falha permanente (401/403/404) responde 200 e vai para o log: com entrega sequencial, um evento
  que falha trava a fila de TODOS os clientes. Todo handler é idempotente.
- **Canal WhatsApp é dual (ADR-021)**: oficial (Meta) é a **prioridade**; não-oficial (PlugZapi/Z-API)
  é **opção**, e o cliente escolhe por qual número caminha — os dois convivem. O não-oficial
  **carrega risco de banimento** e a interface deixa isso VISÍVEL, com alertas separados por caminho.
  Cada tipo é **um adaptador atrás da porta genérica de canal** (`canal_conectado`), com capacidades
  declaradas — janela de 24h e template são do oficial; o não-oficial declara as suas.
- **`packages/shared` é TypeScript puro.** Consumido por Angular, Expo e API ao mesmo tempo — um
  `import` de framework quebra dois dos três consumidores.
- **Deploy separado por watch path**: ao adicionar import de `packages/shared` num app, confira o
  watch path **no mesmo commit** — senão o tipo muda na API e não muda na tela.
- Idioma: prosa em pt-BR; código/comentários em inglês; domínio em português (`Conversa`, `Pedido`,
  `Campanha`, `Numero`). Dinheiro em centavos inteiros; IDs UUID v7; sem `enum` do TypeScript.
- Não commitar em `main` sem os checks (`pnpm lint typecheck test`) verdes.
- **Estado atual (2026-10-17): produto em operação (dogfooding); port dos padrões do agente da AM.**
  Stack no Railway com chat bidirecional, pedido assistido, campanhas e agente VENDEDOR (laço de
  ferramentas sob RLS, fila `agente_tarefa`, modos sombra/assistido/autônomo, propor-e-confirmar). O port
  (`docs/plano-port-playbook-am.md`, ADR-028…034) pôs pipeline determinístico, qualidade com revisão
  humana, playbook versionado, SLA do handoff e painel de fase (`GET /v1/agente/go-live`, alvos PROPOSTA).
  Operação: `docs/agente-go-live.md`, `agente-runbook.md`, `agente-revisao-semanal.md`. Skills da área:
  `geracrm-agente-vendas`, `geracrm-catalogo`.
- **O turno do agente é um pipeline de ordem fixa** (`agente/pipeline/`, ADR-029): regra nova é etapa
  com teste, nunca `vendedor.ts`. O que protege fica no código e **não tem chave de desligar**; tela e
  playbook só acrescentam restrição. Modo efetivo = o mais restritivo entre conta, número e recorte
  (ADR-028); o kill switch é modo, nunca parar o worker.
- **Teto de custo é por NÚMERO (dia) e por sessão**; o tenant só tem alerta mensal (ADR-032). Preço vem
  do catálogo `modelo_ia`, nunca de tabela no código.
- **Teste que consome fila usa `workerDoTenant`/`somenteTenant`, nunca o dono**; cada raia em banco
  próprio (`geracrm_<raia>`). Ver `geracrm-testes`.
- **O modelo nunca inventa número.** Preço, estoque, prazo e desconto só entram na resposta se vieram
  de ferramenta no mesmo turno — verificado em código (`verificarNumerosNaResposta`). `pedido_efetivar`
  não é ferramenta do modelo (ADR-027).
- **Catálogo tem origem múltipla** (ERP e manual) e o preço é resolvido SEMPRE no servidor pelo perfil
  do contato (ADR-025). Corpo de requisição nunca carrega preço.
