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

## 3. Autenticação — confirmada em produção

> ⚠️ Confirmado contra `apresentacao.geracloud.com.br` (bundle do frontend) e o fonte do pdv-core.
> Isto **corrige** a suposição inicial de `Authorization: Basic` — que o GeraCloud **não** aceita.

O GeraCloud **não recebe usuário e senha na API.** Ele usa **Keycloak** (`password grant`):

```
1. POST auth.geracloud.com.br/auth/realms/GERA3/protocol/openid-connect/token
      grant_type=password · client_id=modulo-retaguardaview · client_secret=<do bundle>
      username=<login da retaguarda> · password=<senha>
   → { access_token, refresh_token, expires_in }

2. GET  {baseUrl}/empresas/usuario-logado
      Authorization: Bearer <access_token>
   → { razaoSocial, nomeFantasia, ... }   ← identifica EM QUAL empresa conectou
```

| Fato | Valor | Origem |
|---|---|---|
| Realm | `GERA3` | bundle do frontend |
| Client | `modulo-retaguardaview` (confidential, tem secret) | bundle |
| Base da API | `{host}/pdvcore/api/v1/` | `@ApplicationPath("/api/v1")` no fonte |
| Sonda | `empresas/usuario-logado` (autenticado, identifica) | `RecursoEmpresa.java` |

⚠️ **A pessoa continua digitando usuário e senha da retaguarda** — o Keycloak é detalhe do
adaptador (`packages/conectores/src/geracloud/autenticacao.ts`), não aparece na tela.

⚠️ **O `client_secret` vem do bundle público** — já é distribuído a qualquer navegador, então não é
segredo real; é config do client. Overridável por ambiente para o dia em que a Gera3 der um client
dedicado à integração, sem troca de código.

⚠️ **Dois 401 com significados opostos:** `invalid_grant` no Keycloak é **senha errada** (ação da
pessoa); 401 na API **com token fresco** é **endereço errado** (aponta para outro auth). E **403 na
API** é o caso a separar: autenticou, mas falta o papel de leitura — quem libera é outra pessoa.

---

## 3a. Forma real das respostas — confirmada pela sonda

> ⚠️ Confirmado em `apresentacao.geracloud.com.br` (instância "SHOWCASE"). **Corrige** o que eu havia
> presumido lendo o Java — e cada divergência abaixo teria gravado lixo silencioso.

| Presumi | É na verdade | Consequência se não corrigido |
|---|---|---|
| paginação `{content, last}` | **array cru** | `content` = undefined → **importaria zero**, sem erro |
| venda `valorTotal` | **`valor`** | toda venda com **R$ 0** |
| venda `cliente` | **`clientePDV`** | toda venda **"sem contato"** → RFV vazio |
| data ISO | **`DD/MM/YYYY HH:mm:ss.SSSSSS`** | `03/08` vira 8/mar ou Invalid Date → venda **rejeitada** |
| — | **`status: "CANCELADA"`** existe | cancelada contaria no faturamento |
| — | **`isRascunho`** existe | rascunho contaria como venda |
| itens na listagem de venda | **não vêm** (só no detalhe) | `item_venda` fica vazio (ok p/ RFV, que usa o total) |

Cliente **não carrega username de vendedor** — tem `corretor` (por CPF) e `usernameCadastro` (quem
cadastrou). A carteira é atribuída pela **venda** (`usernameVendedor`), não pelo cliente.

⚠️ **Paginação e filtro de data — corrigidos ao vivo (a base grande revelou):**

| Presumi | É na verdade | Efeito do erro |
|---|---|---|
| `page` / `size` (estilo Spring) | **`inicio` / `limite`** (offset em linhas: `setFirstResult`/`setMaxResults`) | vinham **5 vendas**; com o certo, **430** de 2026 |
| `dataInicio` ISO (`2026-01-01`) | **`dataInicial` / `dataFinal` em `DD/MM/YYYY`** | ISO **ignorado em silêncio** → trazia o histórico inteiro achando que filtrou |

Clientes e produtos vieram completos por acaso (base pequena); só as vendas expuseram o erro. A carga
completa de 2026 (430 vendas, R$ 47.352,88) conciliou contra o faturamento do ERP (R$ 60.050,77):
**divergência de R$ 12.697,89** — real e investigável (janela de emissão × liquidez, agrupamento do
relatório), que é o produto da conciliação, não bug. Tudo travado em `conector.test.ts`.

Tudo travado em `packages/conectores/src/geracloud/conector.test.ts`, com dublês na forma real.

---

## 3b. Endpoints relevantes

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

## 6. Respondido — e o que decorre

### 6.1 ✅ Não há limite de crédito no pdv-core

**Todas as vendas são com pagamento no ato** — débito, crédito ou Pix.

`creditoCliente: false` deixa de ser "não encontrei" e passa a ser **definitivo**. O bloco de
crédito **não aparece** na tela (não aparece desabilitado), e `PED-11` simplesmente não se aplica a
este conector.

⚠️ **Mas isso abre uma pergunta de produto, não de integração — ver §7.**

### 6.2 ⚠️ `POST /vendas` provavelmente NÃO tem idempotência

É o pior caso, e ele muda a estratégia de escrita. Sem chave de idempotência no ERP, **nós** temos
de garantir que um reenvio não crie o segundo pedido. O caminho é o previsto em INV-53, que deixa
de ser exceção e vira o fluxo principal:

```
1. Grava a chave em `chave_idempotencia` ANTES de chamar o ERP
   ⚠️ Antes, não depois: se gravar depois, o timeout apaga o rastro
2. Chama o ERP
3a. Respondeu → grava o número, conclui
3b. Timeout → ⚠️ o pedido PODE existir lá. NÃO reenvia.
    → estado `aguardando_conferencia`
    → reconciliação por consulta (§6.3)
```

### 6.3 Reconciliação sem chave: busca heurística, e o limite dela

Sem idempotência nativa, "este pedido já existe?" só pode ser respondido por **busca aproximada**:
mesmo cliente, mesmo valor total, dentro de uma janela de minutos.

⚠️ **E ela é ambígua por natureza.** Dois pedidos idênticos do mesmo cliente no mesmo minuto são
raros, mas acontecem — e a heurística não sabe distinguir "achei o meu" de "achei outro parecido".

Por isso a regra é: **heurística resolve o caso claro; ambiguidade vai para conferência humana.**
Um pedido em `aguardando_conferencia` é um incômodo; um pedido duplicado no ERP do cliente é um
problema com o cliente dele.

### 6.4 Ainda em aberto

| # | Pergunta | Impacto |
|---|---|---|
| 3 | Latência de `/estoques/tela-venda` | Acima de ~2s, `saldoSincrono` vira `false` na prática |
| 4 | Limite de requisições por minuto | Dimensiona a carga histórica |
| 5 | Token do Keycloak e escopos | Autenticação do adaptador |
| 6 | `/vendas` paginado devolve os itens? | Se não, é uma chamada por venda e a carga histórica muda de ordem de grandeza |

---

## 7. ⚠️ A pergunta de produto que a resposta sobre crédito revelou

O pdv-core é um **PDV de varejo**: venda com pagamento no ato, sem crédito, sem prazo.

O GeraCRM é para **atacado**, onde vender a prazo é o normal. E há evidência disso no próprio
levantamento: o sistema de referência (Tailor) tem templates chamados **"Boleto Prazo Em Análise"**,
**"Boleto Prazo Aprovado"** e **"Boleto Prazo Recusado"**
(`inventario-funcionalidades-referencia.md`).

Ou seja: **o fluxo de boleto a prazo existe na operação do cliente, mas não no ERP que analisamos.**

Três possibilidades, e cada uma leva a um caminho diferente:

| Hipótese | Consequência |
|---|---|
| O cliente de atacado usa **outro sistema**, não o pdv-core | O conector do atacado é outro, e este levantamento serve ao varejo |
| O prazo é controlado **fora do sistema** (planilha, WhatsApp, confiança) | ⚠️ **Oportunidade de produto:** o GeraCRM poderia ser onde isso passa a existir |
| Existe módulo de crediário/prazo que **não localizei** | Basta apontar onde |

⚠️ **Isto não bloqueia a Onda 0** — a ingestão e o saldo funcionam do mesmo jeito. Mas muda o
desenho do pedido assistido e precisa ser respondido antes de PED-11/PED-12.

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


---

## 8. ⚠️ A escrita de pedido — contrato extraído do catálogo público (27/ago)

**Correção do §3b:** `POST /vendas/pedidos-catalogo` **NÃO cria pedido**. No
bundle o método é `buscarPedidosCatalogo`, tem paginação (`inicio`, `limite`,
`ordem`) e o corpo é o FILTRO — é `POST` só porque o filtro é complexo demais
para query string. Implementar a escrita por ali teria falhado.

O caminho real, extraído do JS do catálogo (`catalogoService.enviarPedido` e
`carregarDadosPedido`):

```
POST {urlBase}/catalogos-publico/orcamento
```

⚠️ **Responde `blob`**, não JSON: `{ responseType: "blob" }`. O catálogo devolve
um PDF/arquivo do orçamento — então **o número do pedido NÃO volta no corpo**.
Isso muda a nossa efetivação: `numeroExterno` terá de vir de uma consulta
posterior, ou o campo fica vazio até a sincronização seguinte.

### O corpo

| Campo | Valor | Nota |
|---|---|---|
| `clientePDV` | objeto do cliente | ⚠️ o OBJETO inteiro, não um id |
| `itens[]` | lista de `ItemVenda` | ver abaixo |
| `status` | `"Orcamento"` | fixo |
| `modo` | `"NFCEOffline"` (gestão) ou o modo do catálogo | |
| `valor` | **decimal com 2 casas** (`Number(total.toFixed(2))`) | ⚠️ reais, NÃO centavos |
| `usernameVendedor` | username ou `"catalogo"` | |
| `isCatalogo` | `true` | |
| `frete` | `0` | |
| `formasPagamento[]` | vazio, ou `PagamentoDiverso(idForma, 1, valor)` | |
| `catalogo` / `tabelaPreco` | objeto do catálogo e a tabela dele | |
| `dataAbertura` | `"DD/MM/YYYY HH:mm:ss"` | ⚠️ formato brasileiro, não ISO |
| `observacao` | **texto livre** | ⚠️ ver idempotência abaixo |
| `cupomDesconto` | só se houver | |

**Item** (`new ItemVenda(estoque, produtoPreco)`), com estes campos calculados
antes do envio:

- `precoDoMomento` = `preco * quantidade`, **decimal** — ⚠️ é o TOTAL da linha,
  não o unitário, apesar do nome;
- `valorFinalDesconto`, `valorFinalAcrescimo`, `frete` = `0`;
- `valorFinalDescontoPromocao` = calculado quando há promoção.

⚠️ O item carrega o objeto de **estoque** inteiro (com `codigoBarra`), não um id
solto. O preço vem de `GET tabela-preco/{id}/precos?idsCodigosBarras=`.

### Cliente: pessoa física e jurídica são caminhos diferentes

`ajustarClientePDVFisicoJuridico` mostra a regra, e ela é do domínio do ERP:

- `tipo === "PESSOA FISICA"` → exige **CPF**, e `delete cnpj`;
- caso contrário → exige **CNPJ** (+ `inscricaoEstadual` opcional), e `delete cpf`;
- CPF/CNPJ/telefone entram **só com dígitos**; CEP sem hífen.

⚠️ Mandar os dois documentos, ou nenhum, é recusa — o próprio front avisa
"Obrigatório informar o CNPJ" antes de enviar.

### ✅ A pergunta da idempotência tem resposta: `observacao`

É texto livre e vai no corpo. É onde gravamos a chave `pedidoId:versao` (INV-53),
o que transforma a reconciliação depois de um timeout numa **consulta exata** em
vez da busca heurística por cliente + valor + janela de minutos (§6.3). É a
diferença entre "achei o meu pedido" e "achei um parecido".

### O que ainda falta confirmar

| # | Pergunta | Como responder |
|---|---|---|
| 1 | O `blob` da resposta traz o número do pedido em algum lugar? | Criar um orçamento de teste na apresentação e abrir o arquivo |
| 2 | `catalogos-publico/` exige autenticação? | O nome sugere rota pública por chave de catálogo — confirmar |
| 3 | Dá para criar VENDA (não orçamento) por API? | `status: "Orcamento"` é fixo no catálogo; o PDV pode ter outra rota |

⚠️ **A 3 é decisão de produto, não técnica:** se o ERP só aceita ORÇAMENTO por
esta via, o pedido confirmado no chat vira orçamento no GeraCloud e alguém
converte em venda lá dentro. É honesto e já resolve — mas precisa estar claro na
tela, senão o operador acha que a venda foi fechada.
