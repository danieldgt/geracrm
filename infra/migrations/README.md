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
