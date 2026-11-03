# Teste ponta a ponta (e2e)

Sobe a **API de verdade** (`tsx src/server.ts`, workers ligados) contra um Postgres
migrado e percorre o fluxo do produto pela API HTTP:

1. webhook da Meta assinado (HMAC) cria contato e conversa (e é idempotente no reenvio);
2. o agente (`IA_PROVEDOR=simulado`, número em modo autônomo) responde — envio visto na Meta falsa;
3. um vendedor assume a conversa e envia mensagem humana (o agente fica calado);
4. `devolver-agente` e o agente volta a responder ao próximo inbound;
5. pedido assistido: rascunho, item do catálogo semeado, resumo, "sim" do cliente
   (`pedido.confirmado` no outbox, visto pelo replay do SSE) e efetivação no ERP falso.

## Rodar

```sh
pnpm e2e                 # da raiz; ~25 s
E2E_MANTER=1 pnpm e2e    # não derruba o banco no fim (inspecionar com psql)
```

Precisa de um Postgres com pgvector e usuário dono (`DATABASE_ADMIN_URL` no ambiente ou
no `.env` da raiz). O teste cria e derruba o banco `geracrm_e2e` sozinho
(`E2E_BANCO` troca o nome); portas 39100–39102 (`E2E_PORTA_BASE`). O log da API fica em
`e2e/api.e2e.log` (ignorado pelo git).

## Peças

- `global-setup.ts` — banco novo, migrations, `infra/dev/setup-dev.sql` (papel sem
  BYPASSRLS), semente `seed-demo`, servidores falsos e o processo da API num ambiente
  **isolado** (nada do `.env` do desenvolvedor entra).
- `fakes.ts` — Meta Cloud API falsa e GeraCloud/Keycloak falso; gravam o que recebem
  (`GET /__registro`).
- `cliente.ts` — cliente HTTP (cabeçalho `x-tenant-id` de dev), webhook assinado, esperas.
- `fixtures/meta-mensagem-texto.json` — formato real de mensagem entrante da Meta.
- `fluxo.e2e.ts` — o roteiro.

## Costuras de teste no código da API

Duas variáveis, **ignoradas com `NODE_ENV=production`**: `META_GRAPH_BASE_URL`
(`canais/meta-oficial.ts`) e `GERACLOUD_TOKEN_URL` (`integracao/conector-do-tenant.ts`).
Sem elas a API fala com a Meta e o Keycloak reais — nada além do endereço muda.

## Por que dentro de `apps/api`

Reaproveita o vitest, o `postgres` e o `tsx` já instalados (sem dependência nova na raiz) e
o runner de migrations; o script da raiz só delega (`pnpm --filter @geracrm/api e2e`).
