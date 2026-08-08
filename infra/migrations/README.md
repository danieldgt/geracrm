# infra/migrations — Schema do banco

SQL escrito **à mão**, numerado, aplicado em ordem de nome por runner próprio.

> Status: **vazio**. As migrations iniciais derivam de `docs/modelo-de-dados.md`.

## Como funciona

```
0000_identidade.sql
0001_tenant-rls.sql
0002_contato.sql
...
```

O runner (`apps/api/src/db/migrations.ts`) controla o estado em `schema_migrations` e roda em dois
lugares:

- **CI**, a cada PR — assim o caminho que sobe produção é exercitado antes
- **`preDeployCommand` no Railway** — ⚠️ **falhou, o deploy não prossegue** e a versão anterior
  continua servindo

## ⚠️ Toda migration é aditiva

Ela roda **antes do código novo, com a versão anterior ainda atendendo tráfego**.

| Operação | Deploys |
|---|---|
| Adicionar coluna, tabela, índice | 1 |
| Renomear coluna | 2–3 (adicionar → migrar dado → remover) |
| Remover coluna | 2 (parar de usar → remover) |
| Mudar tipo | 2–3 |

## Outras regras

- ⚠️ Cada arquivo roda **em transação** — `CREATE INDEX CONCURRENTLY` não entra. Índice em tabela
  grande precisa de tratamento próprio.
- ⚠️ **Nunca alterar schema direto no banco.** O que não está nesta pasta não existe nos outros
  ambientes.
- **Não use `drizzle-kit generate`** (ADR-006). O schema TS em `apps/api/src/db/schema/` é
  **espelho** do SQL, não gerador — mantê-los em dia é responsabilidade de quem escreve a migration.
- Toda tabela de domínio nasce com **`tenant_id` + policy RLS** e **chave única composta**.
- **Mensagens nascem particionadas** por período. Barato agora, caro depois.

Regras completas: [`geracrm-dados-postgres`](../../.claude/skills/geracrm-dados-postgres/SKILL.md)

---

## ⚠️ Antes de rodar as migrations em desenvolvimento

O container do Postgres cria o `POSTGRES_USER` como **superusuário** — e
**superusuário ignora RLS**, com ou sem `FORCE ROW LEVEL SECURITY`.

Se a API se conectar com ele, o isolamento entre empresas **não acontece**, e
nenhum teste percebe: as consultas voltam com dados de todos os tenants e a
suíte fica verde.

Foi detectado rodando, no primeiro dia: `/v1/eu` devolveu o tenant errado.

```bash
docker compose up -d postgres
docker exec -i geracrm-postgres psql -U geracrm -d geracrm < infra/migrations/0001_base.sql
# ... demais migrations ...
docker exec -i geracrm-postgres psql -U geracrm -d geracrm < infra/dev/setup-dev.sql
```

| Conexão | Usuário | Para quê |
|---|---|---|
| `DATABASE_URL` | **`geracrm_api`** | A API. Sem superusuário, sem `BYPASSRLS` |
| `DATABASE_ADMIN_URL` | `geracrm` | Migrations e preparo de dados de teste |

⚠️ Todo teste de isolamento prepara dado com a conexão de **dono** e consulta
com a conexão da **API**. Se as duas fossem a mesma, o teste passaria sem provar
nada.
