# Conector GeraCloud — análise do pdv-core

> Levantado por leitura do código-fonte em `~/git/Gera3/pdv-core`, na ausência de documentação
> de API. Substitui o item M-09 do plano.
> Regras da porta em [`geracrm-conectores-erp`](../.claude/skills/geracrm-conectores-erp/SKILL.md) · ADR-008.

---

## 1. O que o pdv-core é

Monolito **Java com JAX-RS**, ~2.200 classes, dividido em módulos (`core-module`, `coremodel-module`,
`commons-module`, `security-module`). **199 recursos REST**, com autenticação por **Keycloak**.

⚠️ **Não existe documentação de API.** O que está abaixo veio de leitura de código — o que significa
que é preciso **confirmar em ambiente de homologação** antes de tratar como contrato.

---

## 2. O modelo, e a descoberta que mais importa

```
Produto            referencia · descricao · ncm · caracteristica
   │
   └── CodigoBarra ◄── ⚠️ É AQUI que mora o SKU real
          │  valor (o código de barras) · cor · tamanho · subTamanho
          │
          ├── Estoque       quantidade · quantidadeDecimal · LOJA · dataEstoque
          └── ProdutoPreco  preço por tabela
```

⚠️ **`Produto` não é o SKU.** A grade cor × tamanho vive em **`CodigoBarra`**, e é ela que tem
estoque e preço. Um conector que tratar `Produto` como unidade vendável vai errar saldo, preço e
grade — que é justamente o que o painel de pedido precisa acertar (PED-02/03/04).

E há **`subTamanho`**, além de tamanho. Modelagem de vestuário: manequim e comprimento, por exemplo.
Nosso modelo genérico de atributos (ADR-004) acomoda isso; um modelo com colunas fixas de cor e
tamanho, não.

### Estoque é por loja

`Estoque` referencia `Loja`. O saldo é **por SKU e por filial**, não global — o que casa com o nosso
`filial` (0004) e com o escopo ativo do usuário.

### Clientes

`ClientePDV` traz `cpf`, `cnpj`, `nome`, `sobrenome`, `email`, `telefone`, `status`, `observacao`.

⚠️ **E traz `usernameVendedor` e `usernameSupervisor`.** É a **carteirização já existente no ERP**,
como texto. É exatamente o caso que a migration `0007` previu: o vendedor chega como string e
precisa de correspondência para virar usuário nosso — e agora sabemos qual é o campo.

⚠️ **Um telefone só, e um e-mail só.** Nosso modelo prevê múltiplos (CTT-02). A ingestão preenche o
principal; os demais chegam por WhatsApp e por importação. Não é limitação nossa — é do ERP.

---

## 3. Endpoints relevantes

| Recurso | Rota | Serve a |
|---|---|---|
| Clientes | `GET /clientespdv` (paginado, `filtro`) · `GET /clientespdv/{id}` | Ingestão `customers` |
| Produtos | `/produtos` | Ingestão `products` |
| Preço por produto | `GET /produtos-precos?IdProduto=` | Tabela de preço |
| Tabelas de preço | `GET /tabela-preco/todas` | Catálogo de tabelas |
| **Estoque** | `GET /estoques` · **`GET /estoques/tela-venda?filtroTabelaPreco=`** | ⚠️ Ver §4 |
| Vendas | `GET /vendas` (paginado) · `POST /vendas/pedidos-catalogo` | Ingestão `orders` |

### ⚠️ `/estoques/tela-venda` é a rota mais valiosa que encontramos

Ela devolve **saldo já com o preço da tabela informada**. É precisamente o que o painel de pedido
precisa em uma chamada — saldo (PED-04) e preço do cliente (PED-03) juntos, em vez de duas
consultas que podem discordar entre si.

Existe também `tela-venda-busca-valor-codigo-barra`, que resolve a busca por SKU do painel.

---

## 4. Declaração de capacidades (ADR-008)

Preenchida pelo que o código mostra. ⚠️ **Cada uma precisa ser confirmada em homologação** — a
leitura de código diz que o endpoint existe, não que ele responde no tempo que precisamos.

| Capacidade | Situação | Base |
|---|---|---|
| `ingestaoClientes` | ✅ | `/clientespdv` paginado |
| `ingestaoProdutos` | ✅ | `/produtos` + `CodigoBarra` |
| `ingestaoPedidos` | ✅ | `/vendas` paginado |
| `saldoSincrono` | ✅ | `/estoques/tela-venda` — ⚠️ medir latência (contrato exige ~2s) |
| `tabelaPrecoSincrona` | ✅ | mesma rota, por `filtroTabelaPreco` |
| `creditoCliente` | ❓ | **Não localizado.** Ver §6 |
| `escritaPedido` | ⚠️ | `POST /vendas/...` existe; **falta confirmar idempotência** — ver §6 |
| `webhookDeVenda` | ❌ | Nenhum webhook de saída no código. Sincronização será **agendada** |
| `cargaHistorica` | ✅ | Paginação permite varrer o histórico |

**Consequências imediatas na interface:** sem `webhookDeVenda`, a atribuição de receita 3/7/14d
ganha a latência da sincronização agendada, e isso **precisa estar declarado na tela** — não pode
parecer tempo real quando não é.

---

## 5. Estratégia de sincronização

```
Carga histórica ──► varredura paginada por fluxo, com retomada por cursor
                    ⚠️ em lotes; não em transação única (WAL e lock)

Incremental ──────► agendada, porque não há webhook
                    janela de segurança com sobreposição, e idempotência
                    resolvendo o que vier repetido (evento_externo, 0006)

Ao vivo ──────────► /estoques/tela-venda durante a montagem do pedido,
                    com timeout curto e degradação explícita
```

⚠️ **Sem webhook, a janela de sobreposição não é opcional.** Sincronizar "só o que mudou desde a
última vez" com relógios diferentes perde registro na borda. Sobrepor e deixar a idempotência
descartar o repetido é mais barato que descobrir venda faltando três meses depois.

---

## 6. O que só o ambiente responde

| # | Pergunta | Por que importa |
|---|---|---|
| 1 | 🔴 **`POST /vendas` aceita chave de idempotência?** | Sem ela, timeout de rede duplica pedido no ERP de cliente real (INV-53). Se não aceitar, precisamos de estratégia de reconciliação por consulta — e isso muda PED-08 |
| 2 | 🔴 **Onde está o limite de crédito do cliente?** | Não localizado no código lido. Se não existir, `creditoCliente: false` e o bloco some da tela (não fica desabilitado) |
| 3 | **Latência de `/estoques/tela-venda`** | O contrato exige resposta em ~2s. Acima disso, `saldoSincrono` vira `false` na prática |
| 4 | **Limite de requisições por minuto** | Dimensiona a carga histórica |
| 5 | **Formato do token do Keycloak e escopos** | Autenticação do adaptador |
| 6 | **`/vendas` paginado devolve os itens?** | Se não, é uma chamada por venda — e a carga histórica muda de ordem de grandeza |

⚠️ **As duas primeiras são bloqueantes de PED-07/PED-08** e precisam ser respondidas antes de o
tira-pedidos ser construído. As demais afinam, não travam.

---

## 7. O que a análise já destravou

- **A porta do conector pode ser escrita agora**, com o adaptador GeraCloud implementando os fluxos
  de ingestão e a leitura síncrona.
- **`0007` foi confirmada pelo campo `usernameVendedor`** — a correspondência de vendedor não era
  hipótese, é necessidade concreta.
- **A grade cor × tamanho + subTamanho** confirma que o modelo genérico de atributos (ADR-004)
  estava certo, e que colunas fixas teriam quebrado.
- **A ausência de webhook** é a descoberta que mais muda o produto: a latência da atribuição de
  receita precisa aparecer na interface.
