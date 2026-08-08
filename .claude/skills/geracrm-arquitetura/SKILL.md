---
name: geracrm-arquitetura
description: >
  Regras de arquitetura e código do GeraCRM. Usar SEMPRE que criar ou alterar código em apps/api,
  apps/console, apps/app ou packages/ — define fronteiras de contexto, transações, multi-tenant,
  conectores de ERP, canais de push server→client, validação, tipos compartilhados e as proibições
  (enum TS, float para dinheiro, lista não paginada, canal sem tenant, regra de negócio em adaptador).
---

# Arquitetura do GeraCRM

Herdada da stack da casa (`~/git/drezz`, skill `drezz-arquitetura`) e adaptada ao que o GeraCRM tem
de diferente: **push server→client**, **multi-ERP** e **console Angular**.

Decisões estruturais em `docs/decisoes.md` (ADRs) — consultar antes de propor mudança estrutural.
**Tudo marcado com ⚠️ corresponde a um problema real medido**, aqui ou no GeraCloud.

## Superfícies

| App | Tecnologia | ADR |
|---|---|---|
| `apps/api` | Fastify 5 + Node 22 | 006 |
| `apps/console` | **Angular 21+** (zoneless, signals, standalone) | 010 |
| `apps/app` | Expo / React Native | 009 |
| `apps/catalogo` | Renderizado no servidor | 010 |

## Contextos e fronteiras

- Domínio organizado por **contexto** em `apps/api/src/contexts/`: `atendimento`, `contato`,
  `pedido`, `crm`, `campanha`, `catalogo`, `integracao`, `identidade`, `analitico`.
- Um contexto **NUNCA** importa código interno de outro. Comunicação apenas por:
  1. **Eventos de domínio** (pós-commit, via outbox) para efeito colateral
  2. **Ids** — entidade referencia entidade de outro contexto por id, nunca por join de objeto
- O contexto `integracao` é o único que conhece formato de ERP. ⚠️ Se `pedido` souber que existe
  um campo chamado como o do GeraCloud, a abstração multi-ERP já vazou.
- Canal externo (Meta) só é acessado pelo gateway e pelo adaptador do contexto `atendimento`.
  Proibido `fetch` manual para a Graph API fora do adaptador.

## Multi-tenant — a regra que não admite exceção

- **TODA** tabela de domínio tem `tenant_id` + policy RLS (ADR-001).
- O `tenant_id` vem do contexto de request autenticado (claim `custom:tenant_id` do Cognito) —
  **nunca de parâmetro do cliente**.
- Chave única sempre composta: `UNIQUE(tenant_id, cnpj)`, nunca `UNIQUE(cnpj)`.
- Credencial de integração (token da Meta, credencial de ERP) é **por tenant**, cifrada em repouso.

## Push server→client (ADR-007)

- Transporte: **SSE**. O envio de mensagem vai por POST — não existe WebSocket no produto.
- Fan-out: **outbox pós-commit → `LISTEN/NOTIFY`**. ⚠️ Publicar evento fora do outbox permite
  evento de transação que não commitou.
- **Nome de canal é montado por UMA função**, que não aceita montar canal sem tenant:

  ```
  tenant:{T}:numero:{N} · tenant:{T}:conversa:{C} · tenant:{T}:usuario:{U} · tenant:{T}:campanha:{K}
  ```

  ⚠️ Canal sem prefixo de tenant é o vetor de vazamento nº 1 — IDs sequenciais bastam para alguém
  receber evento de outra empresa.
- **Autorização revalidada a cada subscrição**, não só no login. Permissão muda durante a sessão
  (vendedora sai de um número, carteira é transferida, usuário é desativado).
- **Payload mínimo**: `{ tipo, conversaId, versao }`. Nunca conteúdo de mensagem. O cliente busca
  o conteúdo por API autenticada, sob RLS. Assim, fan-out errado **não vaza conteúdo**.
- Sem polling de fundo (antipadrão medido no GeraCloud: polling dominava o tráfego). Exceção
  consciente só com painel aberto, com parada no primeiro estado final e desistência por tempo.

## Conectores de ERP (ADR-008)

- **A porta é definida pelo nosso domínio, nunca pela API do fornecedor.** ⚠️ Se a interface tem
  método com nome de endpoint de ERP, não é porta — é SDK copiado.
- Adapter **stateless**, credencial recebida por chamada (mesma forma do `Adquirente` do drezz).
- Todo conector **declara capacidades**: `saldoSincrono`, `tabelaPrecoSincrona`, `creditoCliente`,
  `escritaPedido`, `webhookDeVenda`, `cargaHistorica`.
- **O produto degrada por capacidade, não quebra.** Sem `saldoSincrono` → saldo da última
  sincronização com aviso e horário, validação migra para a efetivação. Sem `escritaPedido` →
  tira-pedidos vira rascunho exportável.
- A capacidade é **visível na interface**. ⚠️ Degradação silenciosa faz o usuário achar que o
  produto está errado.
- Leitura síncrona ao ERP: **timeout curto e degradação explícita**. Sem resposta em 2s, a tela
  avisa e bloqueia o envio — nunca deixa montar às cegas para falhar depois.
- Todo dado que vem de ERP guarda **origem por campo**. Com N ERPs escrevendo, é preciso saber
  quem escreveu o quê.

## Transações e banco

- **Fronteira de transação = caso de uso.** Uma transaction Drizzle por comando, aberta na camada
  de caso de uso, nunca em repositório nem atravessando contextos. Handler de evento tem transação
  própria.
- Transações **curtas** — ⚠️ nunca aguardar rede externa (ERP, Meta, IA, S3) com transação aberta.
- Escrita de pedido no ERP é **idempotente** com chave de operação: reenviar após falha não pode
  duplicar (PED-07).
- **Migrations**: SQL à mão em `infra/migrations`, numerado, aplicado pelo runner no CI e como
  `preDeployCommand` no Railway. Não usar `drizzle-kit generate`. **Migration é aditiva** — roda
  antes do código novo, com a versão anterior servindo. Remover ou renomear coluna são dois ou três
  deploys. Cada arquivo roda em transação, então `CREATE INDEX CONCURRENTLY` não entra.
- Nunca alterar schema direto no banco: o que não está na pasta não existe nos outros ambientes.

## Paginação — OBRIGATÓRIA

**Toda lista é paginada server-side**: query `{ pagina, tamanho }` (com `.max()`, nunca ilimitado)
→ resposta `{ itens, total, pagina, temMais }`. Endpoint **e** tela.

⚠️ Proibido retornar coleção sem paginação ou `top-N` cru com `.limit(N)` fixo. Filtros vêm por
query e são aplicados no banco com índice, nunca filtrando no app após buscar tudo.

Origem: grids não paginados derrubaram o Postgres do GeraCloud por OOM em horário comercial. E o
nosso kanban tem coluna com **11 mil cards** — a regra é literalmente sobre nós.

Casos que exigem atenção: lista de conversas · colunas do kanban · histórico de mensagens (cursor
para trás, em blocos de 30 dias) · tabela de campanhas · contatos · leads da IA.

## Tipos e validação

- **Zod nas bordas, tipos puros no miolo.** Toda entrada externa (HTTP, webhook, ERP, env, IA) é
  parseada com schema de `packages/shared`. Dentro do domínio, dado já é confiável — não revalidar.
- ⚠️ **`packages/shared` é TypeScript puro.** É consumido por Angular, Expo e API ao mesmo tempo —
  um `import` de framework quebra dois dos três consumidores. Só tipos, Zod, constantes e regras
  puras.
- Tipos compartilhados existem SÓ em `packages/shared` — proibido duplicar interface no console ou
  no app.
- **Proibido `enum` do TypeScript** — união de literais + `z.enum`.
- **Dinheiro nunca em float**: `numeric` no Postgres, centavos inteiros na aplicação.
- Estados como união de literais com máquina de estados explícita. ⚠️ Proibido status numérico
  mágico.
- Ids: UUID v7.

## Não-bloqueante

- ⚠️ Proibido I/O síncrono (`fs.*Sync`, `execSync`) e trabalho CPU-bound no event loop. PDF,
  processamento de mídia e afins vão para worker.
- API **stateless** — qualquer instância atende qualquer tenant. Exceção: a conexão SSE é
  stateful por natureza; o estado é a assinatura, não dado de negócio.
- Postgres via pool com limite explícito. Ordem canônica de locks documentada por caso de uso;
  retry com backoff para `40P01`.
- **Throttling de disparo é por número, não global** — cada número da frota tem tier próprio na
  Meta. Contador em tabela com `UPDATE ... RETURNING` atômico.

## Webhooks (Meta e ERP)

- **O código HTTP é instrução, não relatório.** 2xx encerra; erro faz o gateway reenviar.
- ⚠️ **Falha permanente (401/403/404) responde 200 e vai para o log.** Com entrega sequencial, um
  evento que falha sempre trava a fila de TODOS os clientes.
- Todo handler é **idempotente**. A Meta reenvia o que demora; reprocessar sem idempotência
  duplica mensagem na tela do usuário.
- O gateway faz **apenas**: valida assinatura → grava evento bruto → publica → responde. Qualquer
  processamento vai para worker.

## Console Angular

Regras próprias na skill `geracrm-console-angular`. O essencial aqui:

- SSE consumido como Observable, com cursor de versão e cancelamento no `takeUntilDestroyed`
- ⚠️ **Kanban não usa virtual scroll** — CDK não suporta drag-drop e virtual scroll juntos.
  Paginação por coluna resolve por desenho
- Design tokens são a fonte da verdade compartilhada com o app Expo; componente se duplica, token não

## Convenções gerais

- Idioma: domínio em português (`Conversa`, `Pedido`, `Campanha`, `Numero`), infraestrutura em
  inglês. Comentários em inglês.
- Erros de domínio tipados por contexto. ⚠️ Nunca controle de fluxo por `string.includes()` em
  mensagem de erro.
- **Falha de negócio é retorno tipificado, não exceção** — estoque insuficiente e crédito bloqueado
  são resultados esperados, e a tela precisa deles nomeados (PED-08).
- Blobs (áudio, imagem, PDF) sempre em object storage com ponteiro no banco. Nunca Base64 em coluna.
- Segredos cifrados em repouso; nunca em texto plano em tabela nem em log.
- **Opt-out é invariante, não filtro**: contato com `Campanhas` desligado não recebe por nenhum
  caminho — inclusive disparo manual em lote. Garantido pela camada, não por quem chama.
