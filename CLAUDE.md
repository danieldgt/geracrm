# GeraCRM

CRM de atendimento (WhatsApp/Instagram) + funil de recompra + campanhas com ROI + pedido assistido,
para venda B2B recorrente. Monorepo pnpm+Turborepo: `apps/api` (Fastify), `apps/console` (Angular),
`apps/app` (Expo), `apps/catalogo` (SSR), `packages/shared` (tipos/Zod **TypeScript puro**),
`packages/conectores` (adaptadores de ERP).

- **Decisões técnicas**: `docs/decisoes.md` (ADRs) — consultar antes de propor mudança estrutural.
- **Regras de código**: skills `geracrm-arquitetura`, `geracrm-testes`, `geracrm-console-angular`
  (`.claude/skills/`) — obrigatórias em qualquer código. Há skills por área: `geracrm-whatsapp-meta`,
  `geracrm-tempo-real`, `geracrm-dados-postgres`, `geracrm-conectores-erp`,
  `geracrm-identidade-acesso`, `geracrm-monorepo-deploy`, `geracrm-ia`, `geracrm-observabilidade`.
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
- **`packages/shared` é TypeScript puro.** Consumido por Angular, Expo e API ao mesmo tempo — um
  `import` de framework quebra dois dos três consumidores.
- **Deploy separado por watch path**: ao adicionar import de `packages/shared` num app, confira o
  watch path **no mesmo commit** — senão o tipo muda na API e não muda na tela.
- Idioma: prosa em pt-BR; código/comentários em inglês; domínio em português (`Conversa`, `Pedido`,
  `Campanha`, `Numero`). Dinheiro em centavos inteiros; IDs UUID v7; sem `enum` do TypeScript.
- Não commitar em `main` sem os checks (`pnpm lint typecheck test`) verdes.
- **Estado atual: fase de planejamento**, sem código de produção. O caminho crítico é o registro na
  Meta (semanas, fora do nosso controle) — ver `docs/prontidao-para-inicio.md`.
