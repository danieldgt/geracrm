---
name: geracrm-dados-postgres
description: >
  Trabalhar com o banco do GeraCRM: PostgreSQL com RLS multi-tenant, Drizzle, migrations SQL à mão
  com runner no pre-deploy, paginação por cursor, particionamento de mensagens, índices, separação
  entre transacional e analítico, e views materializadas. Usar ao criar ou alterar tabela, escrever
  migration, otimizar consulta lenta, ou decidir onde uma leitura pesada deve rodar.
---

# Banco de dados

PostgreSQL único, multi-tenant por `tenant_id` + RLS (ADR-001). Drizzle + postgres.js para as
queries; **o SQL é quem manda no schema** (ADR-006, herdado do ADR-012 do drezz).

## Multi-tenant — a regra que não admite exceção

- **TODA** tabela de domínio tem `tenant_id` + policy RLS.
- O `tenant_id` vem do contexto de request autenticado (claim `custom:tenant_id`) — ⚠️ **nunca de
  parâmetro do cliente**.
- **Chave única sempre composta**: `UNIQUE(tenant_id, cnpj)`. ⚠️ `UNIQUE(cnpj)` impede dois
  clientes de terem o mesmo fornecedor cadastrado — e o bug só aparece com o segundo tenant.
- Índice de consulta frequente começa por `tenant_id`.
- ⚠️ **O isolamento é garantido pela camada, não por `WHERE` escrito à mão.** Um `WHERE` esquecido
  em uma consulta entre centenas é questão de tempo.

## Migrations

- SQL escrito à mão em `infra/migrations`, numerado (`0042_descricao.sql`), aplicado em ordem de
  nome pelo runner com controle em `schema_migrations`.
- Roda no **CI** e como **`preDeployCommand` no Railway** — falhou, o deploy não prossegue e a
  versão anterior continua servindo.
- ⚠️ **Migration é aditiva.** Ela roda **antes** do código novo, com a versão anterior ainda
  atendendo tráfego. Coluna nova, tudo bem; **remover ou renomear são dois ou três deploys**.
- ⚠️ Cada arquivo roda **em transação** — `CREATE INDEX CONCURRENTLY` não entra. Índice em tabela
  grande exige migration própria fora de transação, ou janela de manutenção.
- Atualize o schema TS de `apps/api/src/db/schema/` junto: ele tipa as queries, mas é **espelho**
  do SQL, não gerador. Não use `drizzle-kit generate`.
- ⚠️ **Nunca alterar schema direto no banco** — o que não está na pasta não existe nos outros
  ambientes.

## Transações

- **Fronteira = caso de uso.** Uma transação por comando, aberta na camada de caso de uso.
- ⚠️ **Transação curta. Nunca aguardar rede externa** (ERP, Meta, IA, S3) com transação aberta.
  É a causa clássica de pool esgotado sob carga.
- Handler de evento roda em transação própria.
- Ordem canônica de locks documentada por caso de uso; retry com backoff para `40P01`.
- Contador atômico sempre com `UPDATE ... RETURNING`. ⚠️ Proibido ler-incrementar-gravar — é onde
  nasce disparo acima do limite diário.

## Paginação — OBRIGATÓRIA

Toda coleção pagina server-side: `{ pagina, tamanho }` (com `.max()`) → `{ itens, total, temMais }`.

⚠️ **Proibido lista sem paginação e `top-N` cru com `.limit(N)` fixo.** Origem: grids não paginados
derrubaram o Postgres do GeraCloud por OOM em horário comercial. E nosso kanban tem coluna com
**11 mil cards**.

**Cursor, não `OFFSET`.** `OFFSET` profundo faz o banco varrer e descartar tudo que veio antes:

```sql
-- ❌ na página 500, o banco descarta 25.000 linhas
... ORDER BY criado_em DESC OFFSET 25000 LIMIT 50

-- ✅ cursor: o índice leva direto ao ponto
... WHERE (criado_em, id) < ($cursor_data, $cursor_id) ORDER BY criado_em DESC, id DESC LIMIT 50
```

Filtro vem por query e é aplicado **no banco, com índice** — nunca filtrando no app depois de
buscar tudo.

## Tabelas que crescem

| Tabela | Estratégia |
|---|---|
| **mensagens** | ⚠️ Particionamento por período **desde o início** — barato agora, caro depois. Cursor para trás em blocos de 30 dias |
| eventos de campanha | Particionamento por período; arquivamento |
| histórico de segmento RFV | Série temporal; consulta sempre por cliente + período |
| outbox | Expurgo após processamento confirmado |
| auditoria | Retenção definida por política, não infinita |

## Analítico não compete com transacional

| Carga | Onde |
|---|---|
| Inbox, pedido, CRM, cadastro | Primária |
| RFV, evolução de segmento, atribuição 3/7/14d, Visão de Mercado, relatórios | **Réplica de leitura** |
| Agregações recorrentes (RFV da base, ranking, dashboards) | **Views materializadas**, atualizadas por worker |

⚠️ **Consulta pesada na primária trava quem está atendendo.** O inbox é a tela que não pode piscar.

⚠️ **Não calcule RFV da base inteira sob demanda** a cada abertura de tela. É view materializada
com atualização agendada; o cliente individual pode ser calculado ao vivo.

## Carga histórica

RFV depende de anos de venda importados — sem isso a matriz nasce vazia e o produto perde o
argumento central (dependência crítica nº 1 do backlog).

O worker de importação precisa de: **lotes**, **retomada de onde parou**, **idempotência** e
**não derrubar a primária**. ⚠️ Importar milhões de linhas em uma transação só é receita de
`WAL` estourado e lock prolongado.

## Tipos

- Dinheiro: `numeric` no banco, **centavos inteiros** na aplicação. ⚠️ Nunca `float`.
- Ids: **UUID v7** — ordenável por tempo, bom para índice.
- Estado: `text` com união de literais na aplicação. ⚠️ Nunca status numérico mágico; nunca `enum`
  do Postgres (alterar valor exige migration dolorosa).
- Campos personalizados (CTT-06): `JSONB` com índice GIN quando houver busca.
- Blob (áudio, imagem, PDF): object storage com **ponteiro** no banco. ⚠️ Nunca Base64 em coluna —
  infla backup e mata o custo.
- Origem por campo quando vários ERPs escrevem no mesmo lugar (ADR-008).

## Índices

- Nascem de **consulta real de tela**, não de intuição.
- Começam por `tenant_id` nas consultas multi-tenant.
- Índice composto segue a ordem do `WHERE` + `ORDER BY` do cursor.
- ⚠️ Índice não usado custa escrita em toda inserção. Revise periodicamente.

## Depuração de consulta lenta

1. `EXPLAIN (ANALYZE, BUFFERS)` — leia o plano, não adivinhe
2. Seq scan em tabela grande → falta índice, ou o índice não cobre a ordem
3. Muitas linhas lidas e poucas retornadas → filtro no app em vez de no banco
4. Lento só em produção → volume de dados, ou consulta na primária que devia estar na réplica
5. Lento de vez em quando → lock, ou plano mudou por estatística desatualizada
