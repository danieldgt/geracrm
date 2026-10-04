---
name: geracrm-catalogo
description: >
  Trabalhar com o catálogo do GeraCRM (ADR-025/026): produto/SKU/preço/saldo com origem múltipla
  (ERP e manual), tabelas de preço por perfil, índice de busca híbrida (FTS pt + trgm + pgvector
  opcional), reindexação e as regras de cotação. Usar ao criar/alterar produto, mexer em preço ou
  saldo, depurar "não achou o produto" ou "cotou errado", ou ligar um novo ERP ao catálogo.
---

# Catálogo

Código em `apps/api/src/contexts/catalogo/` (`busca.ts`, `indexador.ts`, `escrita-manual.ts`,
`porta-embedding.ts`, `rotas-catalogo-manual.ts`). A regra de PREÇO mora em
`pedido/preco-de-venda.ts` e é uma só para tela, pedido e agente.

## Origem múltipla (ADR-025)

- `produto.origem`, `sku.origem`, `sku_saldo.origem` ∈ `erp | manual`. O integrador **não
  sobrescreve** o que é manual; a API manual **não edita** campos do ERP (409 `catalogo.origem_erp`;
  só `descricao_longa`, `imagens`, `categoria` são nossos).
- Tabelas de preço manuais: `tabela_preco(sistema='manual', id_externo=perfil, perfil declarado)`,
  criadas sob demanda por `garantirTabelasPrecoManuais`. Preço manual em `sku_preco` com
  `tabela_externa = perfil`. Assim a regra de cotação não tem caso especial.

## Cotação (preco-de-venda.ts)

1. Nunca tabela de custo; 2. nunca desativada; 3. perfil **declarado** ganha do nome;
4. perfil não declarado cai no palpite por nome. Perfil do cliente: `contato.perfil_preco`
(`montagem.perfilDoContato`), padrão `atacado`. O corpo de requisição **nunca carrega preço**.

## Busca híbrida (ADR-026)

`produto_indice.texto` = `textoParaIndice()` (shared): referência, nome, categoria, descrição
longa, atributos agregados — **sem preço nem estoque**. Pernas: FTS `pt_sem_acento`
(`websearch_to_tsquery`), trgm sobre `texto_sem_acento` (`<%`, por token), semântica só se a
coluna `embedding` existir e houver vetor de consulta (`embutirConsulta` ANTES da transação).
Fusão por RRF (k=60). `fontes` diz quais pernas rodaram — a tela mostra.

- Reindexar: `indexarProduto` após escrita manual; `reindexarTenant` após sincronismo do ERP e
  por `POST /v1/catalogo/reindexar`. Hash do texto evita trabalho repetido.
- pgvector é **capacidade**: 0088/0089 criam coluna/HNSW só se a extensão existir, e **0094**
  reaplica a mesma guarda num banco que ganhou a extensão depois (local: imagem
  `pgvector/pgvector:pg17` no compose e no CI). Sem ela, o produto funciona lexical.
- **Embeddings pendentes**: `atendimento/agente/conhecimento/embutir-pendentes.ts` —
  `capacidadesDeBusca` (pgvector? chave? pendentes/embutidos), `embutirPendentes` (lê lote →
  embute FORA da transação → grava com guarda de `texto_hash`), `passadaDeEmbedding` (worker, dono,
  advisory lock, pool `max:1`, a cada 60 s em `server.ts`, só com `VOYAGE_API_KEY`). Lote pequeno
  (16) por causa da faixa gratuita da Voyage. Trocar de provedor (`porta.nome`) torna tudo pendente.
- A tela lê `GET /v1/agente/conhecimento/capacidades` e mostra "lexical" ou "lexical + semântica"
  com o motivo (`sem_pgvector` / `sem_chave`, e `falta` nomeia as variáveis) — degradação visível
  (ADR-008).
- **Provedores** (`porta-embedding.ts`): Cloudflare Workers AI `@cf/baai/bge-m3` (padrão quando
  `CLOUDFLARE_ACCOUNT_ID`+`CLOUDFLARE_AI_TOKEN`) e Voyage `voyage-4`; `EMBEDDING_PROVEDOR` força.
  Pedido explícito sem chave fica desligado (não cai para o outro). `embutir(textos, tipo,
  { timeoutMs })` aceita tempo limite por chamada.
- **Cache da pergunta** (`cache-consulta.ts`, tabela global `embedding_consulta_cache` 0095 —
  exceção de tenancy no scanner): `embutirConsulta(porta, texto, { cache })` lê por hash de
  (modelo + texto normalizado), grava no acerto do fornecedor; LRU em memória na frente;
  `TIMEOUT_CONSULTA_MS = 2 s` no caminho quente; `podarCache` roda na passada do worker. Falha de
  cache nunca falha a busca.

## Seed de demonstração

`SEED_DEMO=on pnpm --filter @geracrm/api seed:demo`: tenant "Loja Demo" com 3 planos SaaS,
12 produtos de vestuário (47 SKUs com varejo/atacado e saldo) e 5 contatos. Idempotente.

## Testes

`catalogo/*.test.ts` (rotas, busca, embedding, origem manual) + `db/scanners.test.ts`. Caso
obrigatório: ERP não sobrescreve manual; dois tenants; "camisetta" acha "camiseta" (trgm);
semântica desligada sem erro.
