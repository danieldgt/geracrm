# GeraCRM — Contrato de API

> Lacuna nº 4 de [`prontidao-para-inicio.md`](./prontidao-para-inicio.md) (§2.4) e entrega nº 5 da
> ordem sugerida. Deriva de [`modelo-de-dados.md`](./modelo-de-dados.md),
> [`decisoes.md`](./decisoes.md), [`especificacao-telas.md`](./especificacao-telas.md) e
> [`escopo-funcional-geracrm.md`](./escopo-funcional-geracrm.md).
>
> **O que este documento é:** a **superfície** da API — rota, método, o que faz, qual requisito
> atende e **qual contrato de erro** oferece. Não é schema campo a campo: isso mora em
> `packages/shared` como Zod, que é a fonte da verdade executável.
>
> **O que ele fecha:** a resposta para *"a tela pediu isso — qual chamada devolve, e o que acontece
> quando dá errado?"*. Toda invariante do modelo que a tela precisa **distinguir** aparece aqui como
> um código de erro nomeado.
>
> Contextos espelham `apps/api/src/contexts/`: `atendimento` · `contato` · `pedido` · `crm` ·
> `campanha` · `catalogo` · `integracao` · `identidade` · `analitico`.

---

## 1. Convenções

### 1.1 As três superfícies HTTP

⚠️ **Não é uma API só, e tratá-las como uma é o erro que custa caro depois.** Elas têm público,
autenticação e **promessa de compatibilidade** diferentes.

| Superfície | Prefixo | Autenticação | Consumidor | Compatibilidade |
|---|---|---|---|---|
| **API do produto** | `/v1/**` | JWT do Cognito | console Angular, app Expo | Cliente e servidor sobem juntos (mesmo monorepo, ADR-010). Quebra é coordenável |
| **API pública de ingestão** | `/ingest/v1/**` | Bearer token de integração (INT-03) | ERP de terceiro, script do cliente, n8n | ⚠️ **Rígida.** Quem consome faz deploy no calendário dele. Só mudança aditiva dentro de `v1` |
| **Webhooks** | `/webhooks/**` | Assinatura HMAC do emissor | Meta, ERP do cliente | Versionada pelo emissor, não por nós |

⚠️ **As duas primeiras são disjuntas.** Token de integração **não** abre rota `/v1/**`; JWT do
Cognito **não** abre `/ingest/v1/**`. O "testar conexão" do console chama
`POST /v1/integracao/conexoes/{id}/testar`, que exercita o mesmo caso de uso por dentro — não a rota
pública com um JWT. Misturar as duas autenticações num mesmo handler é como um token de integração
vazado vira acesso ao inbox.

### 1.2 Versionamento

- Versão **na rota**, apenas major: `/v1`. Sem header de versão, sem `?version=`.
- **Dentro de uma major, só mudança aditiva:** campo novo opcional, valor novo em união de
  literais **só quando o cliente já trata desconhecido**, endpoint novo.
- Quebra de contrato ⇒ `/v2` convivendo com `/v1`. Depreciação anunciada por
  `Sunset: <data RFC 7231>` + `Deprecation: true` na resposta, e por notificação in-app (PLT-07)
  para quem tem token de integração ativo.
- ⚠️ **Acrescentar um valor a uma união de literais é breaking change para cliente ingênuo.** Todo
  cliente nosso (console, app) trata literal desconhecido como "estado não reconhecido" e não
  quebra; o cliente de terceiro não temos como obrigar — por isso `/ingest/v1` **nunca** ganha
  literal novo em campo de saída sem `/v2`.

### 1.3 Nomenclatura de rota

| Regra | Exemplo | ⚠️ |
|---|---|---|
| Substantivo **plural**, kebab-case | `/v1/contatos`, `/v1/listas-salvas`, `/v1/respostas-rapidas` | Nunca verbo no recurso (`/v1/getContatos` não existe) |
| Domínio em **português**; infraestrutura em inglês (ADR-011) | `/v1/conversas`, mas `/v1/auth/login` e `/v1/health` | — |
| Sub-recurso quando a vida é do pai | `/v1/contatos/{id}/telefones` | Se tem ciclo de vida próprio, é raiz: `/v1/pedidos`, não `/v1/conversas/{id}/pedidos` |
| **Comando** = sub-rota no imperativo, via `POST` | `POST /v1/atendimentos/{id}/assumir` | ⚠️ Purismo REST aqui custa clareza: "assumir" **não é** `PATCH {estado:'em_atendimento'}` — ele carrega invariante (INV-51), autor e horário, e falha de um jeito que a tela precisa nomear |
| Coleção de tentativas em vez de comando idempotente disfarçado | `POST /v1/pedidos/{id}/efetivacoes` | O recurso criado **é a tentativa** (INV-30: linha nova por tentativa, nunca mutação do pedido) |
| ⚠️ **`tenantId` nunca aparece em rota nenhuma** | — | §2.2 |

**Métodos:** `GET` seguro e cacheável por `private, no-store` (dado de cliente nunca em cache
compartilhado) · `POST` cria ou comanda · `PATCH` parcial · `PUT` só onde a substituição total é o
significado real (raríssimo) · `DELETE` só onde apagar é o significado (⚠️ contato **nunca** é
apagado — INV-11; "excluir" na tela é descarte ou mesclagem).

**Semântica de `PATCH`:** campo **ausente** = não mexe; campo **`null`** = limpa. São coisas
diferentes e o schema Zod distingue as duas.

### 1.4 Formatos

| Dado | Formato no fio | ⚠️ |
|---|---|---|
| **Instante** | RFC 3339 em **UTC com `Z`**, milissegundos: `"2026-08-07T14:03:12.482Z"` | Nunca offset local, nunca epoch. O fuso do tenant (`tenant.fuso`) é aplicado na **apresentação** e na **agregação analítica**, nunca no transporte |
| **Data civil** | `"2026-08-07"` (sem hora) | Só onde o domínio é data: `venda.data`, `meta.periodoDe`, `tarefa.venceEm` quando for o dia todo |
| **Dinheiro** | Inteiro de **centavos** + moeda: `{ "centavos": 99100, "moeda": "BRL" }` | ⚠️ Nunca float, nunca `"R$ 991,00"`, nunca `991.00`. Campo escalar usa sufixo: `totalCentavos: 99100` (INV-46) |
| **Percentual** | `descontoPct: 5.5` (número, base 100) | Desconto não é dinheiro; float aqui é aceitável e o arredondamento acontece na conta em centavos |
| **Id** | UUID v7 em string | ⚠️ A **UI** nunca exibe id interno (spec §0.3); a **API** transporta — são coisas diferentes |
| **Estado** | União de literais em string: `"rascunho"`, `"efetivado"` | ⚠️ Nunca status numérico mágico (ADR-011) |
| **Telefone** | E.164 canônico: `"+5581998617049"` | ⚠️ A forma canônica é **nossa**, não a que a Meta devolve (§6.5 do modelo). `telefoneEnvio` é campo separado quando relevante |
| **Documento** | Só dígitos: `"60631000001430"` | A formatação é da tela |
| **Coleção** | Sempre `{ itens, cursorProximo, temMais }` | §3 |
| Chaves JSON | `camelCase`, domínio em português: `ultimaMensagemEm`, `qtdVendas` | Coluna é `snake_case`; a tradução é do repositório |

`Content-Type: application/json; charset=utf-8` em tudo. ⚠️ **Blob nunca trafega pela API** —
áudio, imagem, PDF e vídeo vão para object storage por URL assinada (§5.2), com ponteiro no banco.

### 1.5 Cabeçalhos

| Cabeçalho | Direção | Uso |
|---|---|---|
| `Authorization: Bearer …` | entrada | §2 |
| `Idempotency-Key: <uuid>` | entrada | Obrigatório em `POST` que produz efeito externo (envio de mensagem, disparo, ingestão). §4.5 |
| `X-Request-Id` | entrada/saída | Ecoado; entra em todo log e no corpo do erro. Se não vier, geramos |
| `Retry-After` | saída | Sempre acompanha `429` e `503` |
| `X-RateLimit-Limite` / `-Restante` / `-Reinicia-Em` | saída | §8.5 |
| `Deprecation` / `Sunset` | saída | §1.2 |
| ⚠️ `X-Tenant-Id` **não existe** | — | Nem é lido, nem é ignorado em silêncio: se aparecer, a resposta é `400 requisicao.cabecalho_proibido`. §2.2 |

---

## 2. Autenticação e tenancy

### 2.1 O fluxo

Cognito **headless** (ADR-006): o provedor é o Cognito, mas **toda a UI é nossa** e o cliente
**nunca** fala com o Cognito diretamente. A API intermedeia.

| Método | Rota | O que faz | Requisito |
|---|---|---|---|
| `POST` | `/v1/auth/login` | E-mail + senha → `{ acesso, renovacao, expiraEm }`. Pode devolver `desafio: 'mfa'` | PLT-04 |
| `POST` | `/v1/auth/mfa` | Conclui o desafio | PLT-04 |
| `POST` | `/v1/auth/renovar` | Renovação silenciosa | PLT-04 |
| `POST` | `/v1/auth/logout` | Revoga a renovação **e encerra as assinaturas SSE no servidor** | §6.6 |
| `POST` | `/v1/auth/senha/esqueci` · `/v1/auth/senha/redefinir` | Recuperação | PLT-04 |
| `POST` | `/v1/convites/{token}/aceitar` | Primeiro acesso de usuário convidado | PLT-02 |
| `GET` | **`/v1/eu`** | **A chamada de boot.** Devolve usuário, tenant, filiais e **papel em cada uma** (INV-59), canais visíveis, plano e limites (PLT-06), perfil de vertical (ADR-004) e **as capacidades de cada conexão de ERP** (ADR-008) | PLT-01/02/06 |

⚠️ **`GET /v1/eu` não é conveniência — é o que torna dois dos cinco estados obrigatórios possíveis**
(spec §0.1). "Sem permissão" (o elemento **não aparece**), "recurso não contratado" (aparece com
cadeado) e "degradado" (o bloco de crédito **não aparece** quando `creditoCliente = false`) são
todos decisões de renderização que dependem desta resposta. Sem ela, cada tela adivinha.

⚠️ **O papel não vem do token.** Vem de `/v1/eu` e é reavaliado no servidor a cada caso de uso.
Papel dentro do JWT fica velho: a vendedora sai de uma filial e continua com o token antigo até
expirar. O único claim de autorização no token é o grupo de **staff da Gera3**.

### 2.2 ⚠️ Nenhuma rota aceita `tenantId` por parâmetro

**A regra (ADR-001, INV-02):** o `tenant_id` vem da claim `custom:tenant_id` do JWT — nunca de
path, query, corpo ou cabeçalho. Não é "validado depois". **O campo não existe no schema.**

O plugin Fastify de autenticação faz, em ordem:

```
1. valida o JWT localmente por JWKS      (stateless, sem chamada ao Cognito por request)
2. extrai custom:tenant_id e sub
3. abre a transação e executa  SET LOCAL app.tenant_id = <claim>
4. entrega ao handler um contexto { tenantId, usuarioId, papeis } imutável
```

A partir do passo 3, **a RLS do Postgres é quem isola** (INV-01), com policy `FORCE` e `WITH CHECK`
idêntico ao `USING` — sem `WITH CHECK` dá para *escrever* em outro tenant.

**Por quê — os quatro motivos, em ordem de dor:**

| # | Motivo | O que acontece se houver o parâmetro |
|---|---|---|
| 1 | **Duas fontes de verdade** | A checagem vira `if (params.tenantId !== claim.tenantId) throw`. São ~200 rotas; basta **uma** esquecer. A ausência do campo é a única forma de garantia que não depende de disciplina |
| 2 | **A mesma regra vale para outras portas de entrada** | Worker, webhook da Meta, ingestão pública e job noturno não têm request. Se o tenant fosse parâmetro do HTTP, cada porta inventaria o seu jeito — e a policy de RLS receberia o que a porta mandasse |
| 3 | **A RLS lê uma variável de sessão, não o corpo do request** | `SET LOCAL app.tenant_id` é o único ponto de entrada do isolamento. Um parâmetro que não alimenta essa variável é decorativo; um que alimenta é **escalação de privilégio por query string** |
| 4 | **Auditável por teste, não por revisão** | Um teste varre todas as rotas registradas e falha se qualquer schema declarar `tenantId` (INV-02). Revisão de código não pega isso na milésima vez |

**As três aparências de exceção — e por que nenhuma é exceção:**

| Caso | Como se resolve **sem** parâmetro de tenant |
|---|---|
| **Staff da Gera3 acessando dado de cliente** | ⚠️ Não reusa as rotas do produto com um `?tenantId=`. O staff pede uma **sessão de acesso** (`POST /v1/staff/acessos { tenantId, motivo }`) que emite um **token novo**, curto, cujo `custom:tenant_id` **é o do cliente** e que carrega `atorStaff`. Daí em diante ele usa as rotas normais. Cada emissão grava `auditoria` (PLT-05). O tenant continua vindo do token — muda **quem** emitiu o token |
| **Webhook da Meta** (não tem token nosso) | O tenant é **resolvido** a partir do `phone_number_id`/`waba_id` do payload contra `numero_whatsapp`. §7.1 |
| **Webhook de ERP e ingestão pública** | O tenant vem da **conexão** identificada pelo token de integração ou pelo id opaco da rota. §7.3 e §8 |
| **Revenda / white-label** (PLT-10, Onda 4) | `tenant.tenant_pai_id` + policy de revenda. Continua vindo do token: o token do usuário da revenda alcança os filhos **pela policy**, não por parâmetro |

### 2.3 Token de integração (INT-03)

- Forma: `gcrm_live_<32 bytes base62>` — opaco, exibido **uma única vez** na criação. No banco só o
  hash (`token_integracao.hash`).
- Escopos: `ingest:customers`, `ingest:products`, `ingest:orders`, `ingest:read`. ⚠️ Escopo
  ausente ⇒ `403 autorizacao.escopo_insuficiente`, nunca `404`.
- Amarrado a **uma conexão** (`conexao_erp`) — é isso que dá tenant, papel (`fiscal`/`secundario`),
  precedência (§6.3 do modelo) e `fonte_de_venda` (INV-55) à ingestão. Token sem conexão não existe.
- Revogação imediata (`revogado_em`); `ultimo_uso_em` alimenta o painel INT-08.

---

## 3. Paginação por cursor

**Obrigatória em toda coleção** (INV-47, ADR-011). Sem exceção — inclusive listas que "hoje têm 5
linhas".

### 3.1 Query

```
GET /v1/conversas?canalId=…&semResposta=true&limite=50&cursor=eyJrIjpbIjIwMjYt…
```

| Parâmetro | Regra |
|---|---|
| `limite` | Default **50**, máximo **200** (`.max()` sempre). Fora da faixa ⇒ `400`, não silenciosamente ajustado |
| `cursor` | Opaco. Ausente = primeira página |
| **Ordenação** | **Não é parâmetro livre.** Cada endpoint declara a(s) ordenação(ões) suportada(s) por um `ordem` de valores fechados (ex.: `ultimaMensagem` \| `ultimaEntrante`), porque **cada uma exige um índice** (§8.6 do modelo). ⚠️ Ordenação arbitrária é como uma lista de 11 mil cards vira varredura sequencial |
| Filtros | Por query, aplicados **no banco com índice** — nunca filtrando no app depois de buscar tudo |

### 3.2 Resposta

```json
{
  "itens": [ … ],
  "cursorProximo": "eyJrIjpbIjIwMjYtMDgtMDdUMTQ6MDM6MTIuNDgyWiIsIjAxOTgi…",
  "temMais": true
}
```

- `cursorProximo` é `null` quando `temMais` é `false`.
- ⚠️ **Não existe `total` por padrão.** `COUNT(*)` sobre o conjunto filtrado é exatamente a consulta
  que derrubou o Postgres do GeraCloud. Onde a tela precisa de número (contador de coluna do kanban,
  `Fila (99+)` da §7 da spec), existe endpoint próprio:

  ```
  GET /v1/negocios/contagem?funilId=…        → { "porEtapa": [ { "etapaId": "…", "valor": 11358, "exato": true } ] }
  GET /v1/atendimentos/contagem?estado=na_fila → { "valor": 99, "exato": false, "teto": 99 }
  ```

  Contador **exato** só vem de contador denormalizado ou view materializada (com dono e job de
  reconciliação, INV-57). Contador **caro** vem com teto — é de onde nasce o `99+`.

### 3.3 O cursor por dentro

```
base64url( { "k": [<valor da chave de ordenação>, <id>], "o": "ultimaMensagem:desc", "f": "<hash dos filtros>", "v": 1 } ) + "." + HMAC
```

- É `(campo_ordenacao, id)` — **keyset**, o mesmo par declarado como VO `Cursor` no modelo (§1.3).
  O `id` desempata, e é por isso que todo índice da §8.6 termina em `, id DESC`.
- **Assinado (HMAC com chave do servidor).** Cursor forjado é entrada não confiável que vira
  cláusula `WHERE` — e cursor é o único parâmetro que o cliente devolve sem entender.
- Carrega o **fingerprint dos filtros**. Trocar de filtro e reusar o cursor ⇒
  `422 listagem.cursor_incompativel`. ⚠️ Sem isso, mudar o filtro no meio da rolagem devolve uma
  página coerente com o cursor antigo e **ninguém percebe** que faltam itens.
- Opaco por contrato: o cliente **não** decodifica, **não** monta, **não** guarda além da sessão da
  lista.

### 3.4 Paginação para trás (histórico de mensagens)

```
GET /v1/conversas/{id}/mensagens?ate=2026-08-07T00:00:00Z&limite=50&cursor=…
```

Ordem fixa `criado_em DESC, id DESC`, servida pelo índice por partição. O recorte de 30 dias da tela
(INB-08) é o **cliente** movendo `ate` — não scroll infinito (spec §1.3). ⚠️ Sem `ate`, a consulta
atravessa todas as partições de `mensagem` e o planner perde o *partition pruning*.

### 3.5 Por que não `OFFSET`

| Problema | Consequência concreta no GeraCRM |
|---|---|
| **Custo O(offset)** | O Postgres precisa produzir e descartar as `offset` primeiras linhas. Página 40 de uma coluna de kanban com 11.358 cards varre 2 mil linhas para devolver 50 — e o custo cresce enquanto o usuário rola |
| **Instabilidade sob escrita concorrente** | ⚠️ O inbox **reordena a cada mensagem que chega**. Entre a página 1 e a 2, uma conversa sobe para o topo: um item é **pulado**; outra desce: um item **duplica**. É o caso de uso mais quente do produto e o pior caso do `OFFSET` |
| **Convite ao `total`** | `OFFSET` só faz sentido com número de páginas, que exige `COUNT(*)`. Foi essa dupla que causou o OOM real do GeraCloud (INV-47) |
| **Sem índice que ajude** | Keyset vira `WHERE (ordenacao, id) < (?, ?)` e usa o índice composto direto |

⚠️ **Contradição a corrigir na skill:** `.claude/skills/geracrm-arquitetura/SKILL.md` ainda descreve
paginação como `{ pagina, tamanho } → { itens, total, pagina, temMais }`. **Este documento e a
INV-47 são a autoridade** — o texto da skill é herança do drezz e precisa ser atualizado.

---

## 4. Erro tipificado

### 4.1 O corpo

Um envelope, sempre o mesmo, em qualquer status ≥ 400:

```json
{
  "erro": {
    "codigo": "pedido.estoque_esgotado",
    "mensagem": "VERDE G42 não tem mais saldo (0 disponível)",
    "detalhe": {
      "variantes": [ { "sku": "22625-VER-G42", "descricao": "CONJUNTO LAILA VERDE G42",
                       "pedido": 3, "disponivel": 0 } ]
    },
    "campos": [ { "caminho": "itens[1].quantidade", "codigo": "quantidade_maior_que_saldo" } ],
    "requestId": "01J8Z…"
  }
}
```

| Campo | Regra |
|---|---|
| **`codigo`** | `contexto.slug`, estável, **parte do contrato**, nunca traduzido. É por ele que a tela decide o que oferecer |
| `mensagem` | pt-BR, para humano. ⚠️ **Pode mudar sem aviso.** Controle de fluxo por `mensagem` (ou por `string.includes()`) é proibido (ADR-011) |
| `detalhe` | Objeto **tipado por código** — o schema de `detalhe` faz parte do contrato daquele código. É o que permite a tela dizer *"VERDE G42: pedido 3, disponível 1"* em vez de *"erro de estoque"* |
| `campos` | Só em erro de validação de forma; `caminho` em notação de JSON Pointer simplificado |
| `requestId` | Ecoa `X-Request-Id`. É o que o suporte pede e o que liga a tela ao log e ao Sentry |

⚠️ **Falha de negócio é resultado tipificado, não exceção** (skill `geracrm-arquitetura`). No fio
isso significa: estoque esgotado é **422 com código**, não `500`, e não `200` com `sucesso:false`
escondido. Um `500` diz "nós quebramos"; um `422` diz "o mundo disse não" — e são reações
diferentes no cliente, no alerta e no Sentry (`500` vira issue; `422` não vira).

### 4.2 Status HTTP — o que cada um significa aqui

| Status | Significa | Cliente deve |
|---|---|---|
| `400` | Corpo/parâmetro malformado — o schema Zod recusou | Corrigir. É bug do cliente |
| `401` | Token ausente, inválido ou expirado | Renovar; se falhar, login |
| `403` | Autenticado, **sem direito**: papel, escopo, carteira, número, plano | Não retentar. ⚠️ A tela **já deveria** ter escondido — o `403` existe para as outras portas de entrada |
| `404` | Recurso não existe **ou não é deste tenant** | ⚠️ Nunca distinguir os dois: "existe mas é de outro tenant" é vazamento de existência |
| `409` | Conflito de **estado ou unicidade** — o pedido é válido, o mundo mudou | Recarregar e decidir. Ex.: atendimento já assumido, rascunho já existe |
| `422` | **Regra de negócio recusou.** Sintaxe ok, semântica não | Mostrar a ação corretiva nomeada. É o status do catálogo do PED-08 |
| `429` | Limite de requisições, ou **quota de tier do número** (INV-22) | Respeitar `Retry-After` |
| `500` | Nós quebramos | Reportar. Vira issue no Sentry |
| `502` / `504` | **Terceiro** falhou (ERP, Meta, IA). `detalhe.origem` nomeia quem | ⚠️ §4.4: `502` é retentável, `504` **não** |
| `503` | Manutenção ou circuit breaker aberto | `Retry-After` |

⚠️ **`404` versus `403` na multi-tenancy:** com RLS ligada, a linha de outro tenant **não existe**
para a consulta — o `404` sai naturalmente e é o comportamento correto. O `403` é para o caso em que
a linha é do tenant e o usuário não pode vê-la (carteira, número, filial — INV-34).

### 4.3 Catálogo de erros de negócio

> Todo código abaixo existe porque **uma tela precisa distinguir** aquele caso de outro. Código que
> não muda o que a tela faz não deveria existir — vira ruído e cria acoplamento sem valor.

#### Pedido — os cinco erros do PED-08, mais os que o modelo obriga

| Código | HTTP | `detalhe` | O que a tela oferece | Origem |
|---|---|---|---|---|
| `pedido.estoque_esgotado` | `422` | `variantes[] { sku, descricao, pedido, disponivel }` | "VERDE G42 não tem mais saldo (0 disponível)" · **Ajustar quantidade** · **Remover item** | PED-08, spec §2.4 |
| `pedido.credito_bloqueado` | `422` | `{ pedidoCentavos, disponivelCentavos, bloqueado }` | "Crédito insuficiente: pedido R$ 991, disponível R$ 400" · **Solicitar liberação** · **Reduzir pedido** | PED-08/PED-11 |
| `pedido.item_inativado` | `422` | `variantes[] { sku, descricao }` | "08825 foi inativado no ERP" · **Remover item** · **Buscar substituto** | PED-08 |
| `pedido.cliente_sem_cadastro_fiscal` | `422` | `{ contatoId, faltando: ['cnpj'\|'inscricao'\|'endereco'] }` | "Cliente sem CNPJ cadastrado no ERP" · **Abrir ficha para completar** | PED-08 |
| `pedido.erp_indisponivel` | `502` | `{ origem: 'geracloud', tentativaId }` | "GeraCloud não respondeu" · **Tentar novamente** — ⚠️ **mesma** `versaoConteudo`, mesma `chaveEfetivacao`: reenviar **não duplica** (INV-29) | PED-08/PED-07 |
| `pedido.erp_timeout` | `504` | `{ origem, tentativaId, estadoDoPedido, reconciliavel: bool }` | ⚠️ **Não oferecer "tentar novamente".** Ver §4.4 | INV-53 |
| `pedido.validacao_pendente` | `422` | `validacoes[] { regra, mensagem, faltando }` | As linhas do PED-05: *"Mínimo 10 peças — faltam 3"*, *"grade fechada — falta 1 P38"*, *"Mix mínimo: 2 categorias"* | PED-05, spec §2.3 |
| `pedido.divergencia_na_revalidacao` | `409` | `{ divergencias[] { campo, congelado, atual } }` | Apresenta a diferença entre o que estava congelado no rascunho e o que o ERP diz agora — ⚠️ **nunca silenciar** (INV-28) | INV-28 |
| `pedido.versao_conteudo_divergente` | `409` | `{ enviada, atual }` | O rascunho mudou em outra aba/dispositivo (PED-06). Recarregar e reenviar | INV-29 |
| `pedido.rascunho_ja_existe` | `409` | `{ pedidoId }` | Abre o rascunho existente em vez de criar o segundo | INV-52 |
| `pedido.imutavel` | `409` | `{ estado }` | Pedido efetivado não se edita; oferece **duplicar** (PED-16) | INV-31 |

⚠️ **Os cinco erros do PED-08 são o motivo de este documento existir.** Se qualquer um deles chegar
à tela como `500 "erro ao enviar pedido"`, a vendedora volta a lançar no ERP e o módulo morre —
está escrito assim no escopo (§14) e no ADR-005. **Erro genérico aqui é falha de produto, não de
engenharia.**

#### Atendimento e canal

| Código | HTTP | O que a tela faz | Origem |
|---|---|---|---|
| `atendimento.ja_assumido` | `409` | "Eduarda assumiu este atendimento" — atualiza o card, **não** mostra erro vermelho. ⚠️ É o resultado normal de duas pessoas clicando junto (INV-51), não uma exceção | INB-09 |
| `atendimento.janela_fechada` | `422` | Troca o composer para o modo template **preservando o texto digitado** (INB-05, spec §1.3). ⚠️ Este erro só deve acontecer na corrida de fronteira — o composer já bloqueia antes | INV-17 |
| `canal.template_nao_aprovado` | `422` | Nomeia a versão e o status na Meta | INV-20 |
| `canal.nao_aceita_template` | `422` | Instagram: explica que **não há como reabrir** e sugere migrar para WhatsApp | INV-19 |
| `canal.sem_pagamento_meta` | `422` | ⚠️ Diz **exatamente isso** — "falta cadastrar método de pagamento na conta Meta" — com link para o passo do onboarding. Nunca "erro ao enviar" (ADR-002) | INV-21 |
| `canal.desconectado` | `422` | Banner no topo da lista, não modal (spec §1.2) | CAN-03 |
| `canal.quota_de_tier_esgotada` | `429` | `detalhe { canalId, limite, reiniciaEm }` + `Retry-After`. Disparo pausa e retoma sozinho | INV-22 |
| `canal.qualidade_abaixo_do_limiar` | `422` | Bloqueia campanha naquele número e explica (CAN-06) | INV-24 |

#### Contato, campanha e integração

| Código | HTTP | Nota | Origem |
|---|---|---|---|
| `contato.telefone_principal_em_uso` | `409` | `detalhe { contatoId }` — oferece **tornar secundário** ou abrir o contato existente. ⚠️ Nunca funde sozinho | INV-07/49 |
| `contato.conflito_de_identidade` | `409` | `detalhe { conflitoId, chave, contatoA, contatoB }`. Manda para a fila de deduplicação (CTT-11) | §6.4 |
| `contato.mesclagem_irreversivel` | `422` | Recusa mesclagem que não é desfazível | INV-11 |
| `campanha.contato_recusa_campanha` | `422` | Inclusão manual de destinatário com opt-out. ⚠️ O caminho normal nem chega aqui: o materializador de público **já exclui** (INV-13) | CTT-08 |
| `campanha.telefone_bloqueado` | `422` | Comparação por **chave reduzida** (INV-50) | CMP-14 |
| `campanha.canal_incompativel` | `422` | Instagram como público de campanha — bloqueia **e explica por quê** | INV-19 |
| `integracao.capacidade_indisponivel` | `422` | `detalhe { capacidade: 'escritaPedido', conexaoId, alternativa: 'rascunho_exportavel' }`. ⚠️ **É o contrato de degradação no fio** (ADR-008): a tela sabe *qual* capacidade falta e *o que* oferecer | ADR-008 |
| `integracao.erp_indisponivel` | `502` | Circuit breaker; o resto do produto continua | ADR-008 |
| `plano.limite_excedido` | `403` | `detalhe { recurso: 'numeros', contratado, atual }` — vira o cadeado de upsell (PLT-06) | PLT-06 |
| `autorizacao.sem_permissao` | `403` | Genérico de propósito: não conta **por que** | INV-34 |
| `listagem.cursor_incompativel` | `422` | Cliente reinicia a lista | §3.3 |
| `requisicao.limite_de_requisicoes` | `429` | `Retry-After` | §8.5 |

⚠️ **O que deliberadamente NÃO é erro:** dado fora da cobertura de ingestão (INV-56). Um contato sem
histórico de venda ingerido **não** devolve erro — devolve `200` com
`{ metricas: null, confiavel: false, apuradoDesde: null }`, e a tela mostra **"não sabemos"** em vez
de "Perdido". Transformar isso em erro faria a ficha inteira quebrar por causa de um bloco.

### 4.4 ⚠️ `502` e `504` exigem comportamentos **opostos** — e essa é a distinção mais cara do contrato

| | `pedido.erp_indisponivel` (`502`) | `pedido.erp_timeout` (`504`) |
|---|---|---|
| O que aconteceu | A chamada **não chegou** ou foi recusada antes de criar | A resposta **se perdeu**. O pedido **pode** ter sido criado no ERP |
| Botão na tela | **Tentar novamente** | ⚠️ **Não existe** |
| O que a API faz | Nova tentativa reusa a **mesma** `chaveEfetivacao` | `POST /v1/pedidos/{id}/reconciliacao` consulta o ERP pela chave |
| Sem `consultaPedidoPorChave` | — | Pedido vai para `aguardando_conferencia` e a tela **pede confirmação humana** — degradação anunciada, não garantia fingida (INV-53) |

E os dois grupos de erro do PED-08 também exigem chaves diferentes (INV-29):

| Erro | O que a vendedora faz | `versaoConteudo` | `chaveEfetivacao` |
|---|---|---|---|
| `erp_indisponivel`, `erp_timeout` | Repete | **A mesma** | **A mesma** — reenviar não duplica |
| `estoque_esgotado`, `credito_bloqueado`, `item_inativado`, `cliente_sem_cadastro_fiscal` | **Ajusta o pedido** | **Incrementa** | **Nova** — ⚠️ sem isso, um ERP corretamente idempotente devolveria o **primeiro pedido, errado**, como sucesso |

### 4.5 Idempotência no fio

| Onde | Chave | Comportamento no reenvio |
|---|---|---|
| Envio de mensagem, disparo, criação de tarefa | `Idempotency-Key` (uuid do cliente), escopo `(tenant, rota)` | Devolve **a resposta original gravada**, com `Idempotency-Replayed: true` |
| **Efetivação de pedido** | ⚠️ **Não é o header.** É `chave_efetivacao = hash(tenant, pedidoId, versaoConteudo)`, derivada **pelo servidor** (INV-29) | Mesma versão ⇒ no máximo um pedido no ERP, sempre |
| Ingestão pública | `operacaoId` no corpo (INT-04) + `idExterno` por item | §8.4 |
| Webhook da Meta | `(canal, id_externo_evento)` em `evento_externo` (INV-37) | Segundo evento é descartado sem processar |

⚠️ **A chave de efetivação não pode vir do cliente.** Cliente que gera chave por tentativa produz
chave nova a cada clique — exatamente o cenário em que o ERP cria o **segundo** pedido. A chave é
função do **conteúdo**, e por isso é do servidor.

---

## 5. Endpoints por contexto

> Convenções das tabelas: rotas sob `/v1`. "Erros" lista **apenas** os códigos de negócio próprios
> daquele endpoint — `401`, `403`, `404`, `429` e `500` valem em toda parte e não se repetem.

### 5.1 `identidade`

| Método | Rota | O que faz | Requisito | Erros |
|---|---|---|---|---|
| `GET` | `/eu` | Contexto de boot: tenant, filiais + papel, canais, plano, capacidades das conexões, perfil de vertical, **e o estado do onboarding** (passo pendente, para o banner) | PLT-01/02/06, ADR-004/008 | — |
| `GET` | `/onboarding` | Estado do assistente: passos, situação de cada um, próximo pendente. ⚠️ **Estado é do servidor** — o admin fecha o navegador no meio do Embedded Signup e retoma de onde parou | ADR-002/008 | — |
| `POST` | `/onboarding/passos/{passo}/concluir` | Conclui um passo. `passo`: `empresa` \| `canal_whatsapp` \| `pagamento_meta` \| `erp` \| `aceite_capacidades` \| `carga_historica` | ADR-002/008 | `onboarding.passo_anterior_pendente` |
| `POST` | `/onboarding/aceite-capacidades` | ⚠️ Registra **a data em que o admin foi informado** do que aquele ERP habilita. Sem isso, não há como mostrar depois que a limitação foi apresentada | ADR-008 | — |
| `GET` `POST` `PATCH` | `/filiais` `/filiais/{id}` | Filiais e unidades | PLT-01 | — |
| `GET` `POST` `PATCH` | `/setores` | Destino de transferência | INB-15 | — |
| `GET` `POST` `PATCH` | `/usuarios` `/usuarios/{id}` | Gestão de usuários (nunca pelo console AWS) | PLT-02 | `plano.limite_excedido` |
| `PUT` `DELETE` | `/usuarios/{id}/filiais/{filialId}` | Atribui **papel por filial** (INV-59). ⚠️ Emite `permissao.alterada` no canal do usuário | PLT-02 | — |
| `PUT` `DELETE` | `/usuarios/{id}/canais/{canalId}` | Acesso ao número. ⚠️ Encerra as assinaturas SSE do canal **no servidor** | CAN-02 | — |
| `POST` | `/usuarios/convites` | Convida por e-mail | PLT-02 | `plano.limite_excedido` |
| `GET` `POST` `DELETE` | `/integracao/tokens` | Tokens de integração — segredo exibido **uma vez** | INT-03 | — |
| `GET` | `/notificacoes` · `POST /notificacoes/{id}/lida` | In-app com contador (`count WHERE lida_em IS NULL`) | PLT-07 | — |
| `PUT` `DELETE` | `/dispositivos-push` | Token de push por dispositivo | MOB-07 | — |
| `GET` | `/auditoria` | Cursor; filtros por ator, ação, entidade, período | PLT-05 | — |
| `GET` `PUT` | `/eu/preferencias` | Aparência (claro/escuro/sistema), notificações por evento × canal, assinatura da atendente e **escopo ativo** (filial/número). ⚠️ **No servidor** — é a única forma de app e console concordarem (exigência 23) | §7, exig. 23 | — |
| `GET` | `/eu/sessoes` · `DELETE /eu/sessoes/{id}` · `DELETE /eu/sessoes` | Dispositivos ativos; encerrar uma ou **todas as outras** | §7 | — |
| `POST` | `/eu/2fa` · `DELETE /eu/2fa` | Configurar (QR + chave manual + códigos de recuperação) e desativar | §1.3 | — |
| `POST` | `/usuarios/{id}/2fa/resetar` | Admin reseta o 2FA de outro usuário | §5.2 | `autorizacao.sem_permissao` |
| `PUT` | `/eu/foto` | Foto do perfil — URL assinada | §7 | — |
| `GET` | `/plano` | Limites contratados × uso atual. ⚠️ A contagem de uso vem de `contador_por_tenant`, avaliada **no servidor** (exigência 24) | PLT-06 | — |
| `GET` | `/plano/faturas` | Histórico de faturas e forma de pagamento | PLT-06, §8 | — |
| `POST` | `/staff/acessos` | ⚠️ Sessão de acesso cross-tenant do staff, **auditada** (§2.2) | PLT-05 | `autorizacao.sem_permissao` |

### 5.2 `atendimento`

| Método | Rota | O que faz | Requisito | Erros |
|---|---|---|---|---|
| `GET` | `/canais` | Frota: tipo, nome amigável, filial, estado, **tier, qualidade, pagamento OK**, capacidades | CAN-02/03/04 | — |
| `GET` `PATCH` | `/canais/{id}` | Detalhe e nome amigável | CAN-02 | — |
| `POST` | `/canais/whatsapp/signup` | Conclui o **Embedded Signup** (troca o código pelo acesso, registra WABA e número) | CAN-01 | `plano.limite_excedido` |
| `GET` | `/canais/whatsapp/signup/estado` | Estado da conexão em andamento — a tela consulta em loop enquanto a janela da Meta está aberta | CAN-01 | — |
| `POST` | `/canais/{id}/pagamento/verificar` | ⚠️ Reconsulta o método de pagamento na conta Meta do cliente. É o botão **"Verificar de novo"**: sem pagamento cadastrado o número não envia, e a falha precisa dizer isso | CAN-04, ADR-002 | `canal.sem_pagamento_meta` |
| `POST` | `/canais/instagram/signup` | Instagram Business Login | CAN-07 | — |
| `GET` | `/canais/{id}/contadores` | Contatos, clientes, conversas ativas | CAN-05 | — |
| `GET` `PUT` | `/canais/{id}/configuracao` | Horário de atendimento, mensagem de ausência, assinatura da atendente | CAN-02 | — |
| `POST` | `/canais/{id}/reconectar` | ⚠️ **Ação de reparo** — reabre o Embedded Signup só na etapa necessária | CAN-03 | — |
| `POST` | `/canais/{id}/disparo/retomar` | ⚠️ **Ação de reparo** — retoma disparo em número pausado por qualidade (CAN-06) | CAN-06 | `canal.qualidade_insuficiente` |
| `DELETE` | `/canais/{id}` | Remove da frota. ⚠️ Resposta de pré-confirmação informa **quantas conversas deixarão de receber mensagem** | CAN-02 | `canal.possui_conversas_ativas` |
| `GET` | `/conversas` | Lista do inbox. Filtros: `canalId`, `semResposta`, `arquivada`, `busca`. `ordem`: `ultimaMensagem` \| `ultimaEntrante` | INB-01/07 | `listagem.cursor_incompativel` |
| `GET` | `/conversas/{id}` | Cabeçalho: contato, canal, **janela derivada** `{ aberta, expiraEm, duracaoH, reabrePor }`, `versao`, atendimento atual | INB-04 | — |
| `GET` | `/conversas/{id}/mensagens` | Histórico para trás em blocos (`ate`, cursor) | INB-08 | `listagem.cursor_incompativel` |
| `POST` | `/conversas/{id}/mensagens` | Envia texto, mídia, template. `Idempotency-Key` obrigatório | INB-02, CMP-04 | `atendimento.janela_fechada`, `canal.template_nao_aprovado`, `canal.sem_pagamento_meta`, `canal.quota_de_tier_esgotada`, `canal.desconectado`, `campanha.telefone_bloqueado` |
| `POST` | `/conversas/{id}/leitura` | `{ ateVersao }` — leitura é **do usuário**, não da conversa | §3.4.1 | — |
| `POST` | `/conversas/{id}/presenca` | Heartbeat de presença (TTL lógico) | INB-18 | — |
| `POST` | `/midias` | Devolve `{ midiaId, urlUpload, expiraEm }`. ⚠️ O byte **nunca** passa pela API | INB-02, exigência 11 | — |
| `GET` | `/midias/{id}/url` | URL assinada de download, curta | INB-03 | — |
| `GET` | `/atendimentos` | `estado=na_fila\|em_atendimento`, `canalId`. É a Fila mobile e as abas Meus/Fila | INB-09/10, MOB-03 | — |
| `GET` | `/atendimentos/contagem` | `{ valor, exato, teto }` — o `99+` | INB-10 | — |
| `POST` | `/atendimentos/{id}/assumir` | Modo *pull* | INB-09 | **`atendimento.ja_assumido`** |
| `POST` | `/atendimentos/{id}/transferir` | Para atendente ou setor, **com motivo** | INB-15 | `autorizacao.sem_permissao` |
| `POST` | `/atendimentos/{id}/encerrar` · `/reabrir` | Fim do episódio; protocolo preservado | INB-16 | — |
| `GET` `POST` | `/templates` · `/templates/{id}/versoes` | Biblioteca, submissão à Meta, status por versão | CMP-03/04 | — |
| `GET` | `/respostas-rapidas` | Atalhos com variáveis, opcionalmente por setor | INB-13 | — |

### 5.3 `contato`

| Método | Rota | O que faz | Requisito | Erros |
|---|---|---|---|---|
| `GET` | `/contatos` | Cursor. Filtros: `busca` (nome/telefone/documento), `faixaRfv`, `donoId`, `filialId`, `grupoId`, `listaSalvaId`, `tipoRelacao`, `descartado` | CTT-01…05, CRM-08 | — |
| `POST` `GET` `PATCH` | `/contatos` `/contatos/{id}` | Cadastro. ⚠️ `DELETE` não existe (INV-11) | CTT-01…04 | `contato.telefone_principal_em_uso`, `contato.conflito_de_identidade` |
| `GET` `POST` `PATCH` `DELETE` | `/contatos/{id}/telefones` · `/documentos` · `/enderecos` · `/nomes` | Os multivalorados, com marcação de principal/padrão/preferido (INV-08) | CTT-01/02/03/04 | `contato.telefone_principal_em_uso` |
| `PUT` | `/contatos/{id}/preferencias` | `recebeCampanhas` / `recebeAutomacoes` — ⚠️ grava **evento de consentimento** com autor e origem (INV-16) | CTT-08/15 | — |
| `GET` | `/contatos/{id}/canais` | "Está no telefone" — badge por número | CTT-07 | — |
| `GET` | `/contatos/{id}/timeline` | Cursor, unificada: mensagens, pedidos, tarefas, campanhas, carteira | CTT-12 | — |
| `GET` | `/contatos/{id}/carteira` | Histórico com autor e horário — auditoria de posse | CRM-07 | — |
| `PUT` | `/contatos/{id}/dono` | Atribui carteira (fecha a vigente e abre a nova **na mesma transação**) | CRM-06 | — |
| `GET` | `/contatos/{id}/condicao-comercial` | `{ tabela, prazoDias, descontoPct, apuradoEm, aoVivo }`. ⚠️ **Sempre com hora e origem** — nunca "a tabela" | PED-03, INT-01b | `integracao.capacidade_indisponivel`, `integracao.erp_indisponivel` |
| `GET` | `/contatos/{id}/credito` | `{ limiteCentavos, disponivelCentavos, bloqueado, apuradoEm, aoVivo }` | PED-11 | idem |
| `GET` `POST` `PATCH` `DELETE` | `/contatos/{id}/comentarios` | Anotação interna, editável e auditável | CTT-10 | — |
| `GET` `POST` | `/pessoas` · `/contatos/{id}/pessoas` | N:N com papel | CTT-09 | — |
| `GET` `POST` | `/listas-salvas` · `/{id}/membros` | Estática e dinâmica (critério) | CTT-14 | — |
| `GET` | `/contatos/duplicados` | Fila de sugestões (chave média nunca funde sozinha) | CTT-11 | — |
| `POST` | `/contatos/mesclagens` | Fusão **humana**, registrada e **reversível** | CTT-11, INV-11 | `contato.mesclagem_irreversivel`, `contato.conflito_de_identidade` |
| `DELETE` | `/contatos/mesclagens/{id}` | Desfaz a fusão a partir de `dados_antes` | INV-11 | — |
| `GET` `POST` | `/campos-personalizados` | Definição (o valor é JSONB no contato) | CTT-06 | — |
| `POST` | `/contatos/{id}/exportacao-lgpd` · `DELETE /contatos/{id}/dados-pessoais` | Direitos do titular | CTT-15 | — |

### 5.4 `pedido`

⚠️ **Toda resposta de pedido — inclusive as de mutação de item — devolve o pedido inteiro com
`versaoConteudo`, `totalCentavos`, `totalPecas` e `validacoes[]`.** O rodapé de validação da spec
(§2.3) precisa reagir a cada célula da grade preenchida; um `GET` extra por tecla digitada é o que
transforma a tela mais importante do produto em tela lenta.

| Método | Rota | O que faz | Requisito | Erros |
|---|---|---|---|---|
| `POST` | `/pedidos` | Abre rascunho `{ contatoId, conversaId?, campanhaId?, tarefaId? }` — congela `regras_aplicadas` (INV-28) | PED-01/06/09 | **`pedido.rascunho_ja_existe`** |
| `GET` | `/pedidos` | Cursor; filtros por contato, estado, vendedora, período | PED-06 | — |
| `GET` | `/pedidos/{id}` | Rascunho completo, com validações | PED-01 | — |
| `POST` `PATCH` `DELETE` | `/pedidos/{id}/itens` `…/{itemId}` | Grade cor × tamanho. **Snapshot de preço na inclusão** (INV-25). Incrementa `versaoConteudo` | PED-02/03 | `pedido.imutavel`, `integracao.erp_indisponivel` |
| `PUT` | `/pedidos/{id}/documento-fiscal` · `/endereco-entrega` | ⚠️ Escolhe **qual** dos N (`seq`) — "faturar na filial 2" (§5.3 do modelo) | PED-01 | — |
| `PUT` | `/pedidos/{id}/contato` | Troca a empresa do pedido entre contatos do mesmo grupo econômico (§4.1) | CTT-03 | — |
| **`POST`** | **`/pedidos/{id}/efetivacoes`** | **Cria uma tentativa.** Corpo `{ versaoConteudo }`. Resposta `201 { tentativaId, resultado, numeroExterno? }` | PED-07 | **Os 11 códigos de `pedido.*` da §4.3** |
| `GET` | `/pedidos/{id}/efetivacoes` | Histórico de tentativas com erro tipificado. ⚠️ Falha **nunca** altera o rascunho (INV-30) | PED-08 | — |
| `POST` | `/pedidos/{id}/reconciliacao` | Depois de `504`: consulta o ERP pela `chaveEfetivacao` antes de qualquer retentativa | INV-53 | `integracao.capacidade_indisponivel` |
| `POST` | `/pedidos/{id}/conferencia` | Confirmação **humana** quando o ERP não sabe consultar por chave | INV-53 | — |
| `GET` | `/pedidos/{id}/resumo` | Texto formatado do pedido para colar na conversa. ⚠️ **Não envia** — ação sugerida, não automática (PED-10) | PED-10 | — |
| `POST` | `/pedidos/{id}/exportacoes` | ⚠️ **Rascunho exportável** — `202` + job + URL assinada (CSV/PDF com itens, grade, preços e dados do cliente), para lançamento manual no ERP. É o contrato de degradação do ADR-008 quando `escritaPedido` é ausente: sem esta rota, "degrada em vez de quebrar" vira "quebra com uma frase bonita". ⚠️ Distinto de `/resumo`, que é **texto para a conversa**, não arquivo para o ERP | ADR-008, PED-07 | — |
| `POST` | `/pedidos/{id}/duplicar` | "Repetir última compra" | PED-16 | — |
| `GET` | `/vendas` | Fato do ERP: cursor, filtros por contato, período, filial, vendedor | RFV-04, BI-05 | — |

### 5.5 `crm`

| Método | Rota | O que faz | Requisito | Erros |
|---|---|---|---|---|
| `GET` `POST` `PATCH` | `/funis` · `/funis/{id}/etapas` | Múltiplos funis configuráveis | CRM-05 | — |
| `GET` | `/negocios` | **Uma coluna do kanban por vez**, com cursor (`funilId` + `etapaId`). ⚠️ Coluna de 11 mil cards nunca vem inteira | CRM-01, exigência 7 | `listagem.cursor_incompativel` |
| `GET` | `/negocios/contagem` | Contador por etapa | CRM-01 | — |
| `POST` | `/negocios/{id}/etapa` | Move. Desfazer é `POST` de volta (5 s na tela, não estado no servidor) | CRM-01/04 | `crm.motivo_de_perda_obrigatorio` (`422`, INV-36) |
| `GET` | `/contatos-relacionamento` | O **Funil de Relacionamento** (CRM-02). ⚠️ Rota separada de propósito: as colunas são **derivadas de `qtd_vendas`**, não etapas gravadas | CRM-02 | — |
| `GET` `POST` | `/motivos-perda` | Catálogo fechado | CRM-09 | — |
| `GET` `POST` `PATCH` | `/tarefas` | Tipo, canal, responsável, vencimento, origem | TSK-01/02/03 | — |
| `POST` | `/tarefas/{id}/concluir` | ⚠️ Exige `registroDoQueFoiFeito` — vira histórico do cliente | TSK-04 | `crm.registro_obrigatorio` (`422`) |
| `GET` | `/fila-do-dia` | Agendadas/vencidas/concluídas do dia, por vendedor; Onda 4 acrescenta `sugestaoDeMensagem` | TSK-07/08 | — |
| `GET` `POST` | `/metas` | Alvo por usuário, equipe, filial ou tenant | GES-01 | — |
| `GET` | `/metas/acompanhamento` | ⚠️ Alvo × **realizado derivado de `venda`** — o realizado **nunca é gravado** (§5.4) | GES-01/04 | — |

### 5.6 `campanha`

| Método | Rota | O que faz | Requisito | Erros |
|---|---|---|---|---|
| `GET` `POST` `PATCH` | `/campanhas` | Público (critério, lista, CSV), template, canais, agendamento | CMP-01/08 | `campanha.canal_incompativel` |
| `POST` | `/campanhas/{id}/publico/previa` | ⚠️ Devolve `{ elegiveis, excluidos: { optOut, bloqueados, semTelefone, canalIncompativel } }`. **Mostrar quem ficou de fora e por quê** é o que evita o cliente achar que o produto "perdeu" contatos | CMP-01, INV-13/15 | — |
| `POST` | `/campanhas/{id}/simulacao` | Custo estimado na Meta + receita esperada do segmento | CMP-18, D4 | — |
| `POST` | `/campanhas/{id}/disparo` | Congela o público e enfileira. `Idempotency-Key` obrigatório | CMP-07 | `canal.qualidade_abaixo_do_limiar`, `canal.sem_pagamento_meta`, `plano.limite_excedido` |
| `POST` | `/campanhas/{id}/disparo/pausar` · `/retomar` · `/cancelar` | Controle da fila | CMP-07 | — |
| `GET` | `/campanhas/{id}/destinatarios` | Cursor; filtro por estado e `erroTipo` | CMP-10 | — |
| `GET` | `/campanhas/{id}/relatorio` | Entregues, lidos, respostas, falhas por tipo, opt-outs, **custo**, e receita **exata e estimada em campos separados** | CMP-10/11/12 | — |
| `GET` `POST` `DELETE` | `/lista-bloqueio` | Chaveada por **chave reduzida** (INV-50) | CMP-14 | — |

⚠️ **`GET /campanhas/{id}/relatorio` nunca devolve um campo de receita total.** São
`receitaExataCentavos` e `receitaEstimadaCentavos`, com `janelaDias` e `metodo` — somar as duas é
proibido pelo modelo (INV-42) e a API não oferece o campo que tornaria a soma fácil.

### 5.7 `catalogo`

| Método | Rota | O que faz | Requisito | Erros |
|---|---|---|---|---|
| `GET` | `/produtos` | Busca por referência, SKU, nome, categoria (trigram + índice) | PED-02, CAT-01 | — |
| `GET` | `/produtos/{id}/variantes` | Grade com atributos configuráveis (ADR-004) | CAT-01 | — |
| `POST` | `/variantes/saldos` | Lote de SKUs → `[{ varianteId, quantidade, apuradoEm, aoVivo }]`. ⚠️ **`POST` porque a lista de SKUs da grade não cabe em query string**, e ⚠️ **nunca devolve um número solto** — `SaldoApurado` é valor **com hora e origem** | PED-04, INT-01b | `integracao.erp_indisponivel` (`502`, timeout ~2 s ⇒ tela avisa e **bloqueia o envio**) |
| `GET` | `/tabelas-preco` · `/tabelas-preco/{id}/itens` | Vigência e preços | PED-03 | — |
| `POST` `GET` | `/links-catalogo` | Link compartilhável e rastreável | CAT-02 | — |
| `GET` | `/links-catalogo/{id}/visitas` | Quem abriu, o que olhou, quando | CAT-03 | — |

### 5.8 `integracao`

| Método | Rota | O que faz | Requisito | Erros |
|---|---|---|---|---|
| `GET` `POST` `PATCH` | `/integracao/conexoes` | Conexões de ERP. ⚠️ Credencial **entra** e nunca **sai** — a resposta traz só `{ configurada: true, ultimaValidacaoEm }` | INT-01, ADR-008 | `integracao.papel_fiscal_ja_definido` (`409`, §6.3), `integracao.fonte_de_venda_ja_definida` (`409`, INV-55) |
| `GET` | `/integracao/conexoes/{id}/capacidades` | ⚠️ **O contrato de degradação, legível pela tela.** É o que faz o bloco de crédito **não aparecer** em vez de aparecer desabilitado | ADR-008 | — |
| `GET` | `/integracao/conexoes/{id}/cobertura` | Por fluxo: `{ desde, ate, cargaHistoricaEstado }`. ⚠️ É o que separa **"nunca comprou"** de **"não sabemos"** (INV-56) | INT-05 | — |
| `POST` | `/integracao/conexoes/{id}/testar` | Valida credencial e **redescobre capacidades** | INT-01 | `integracao.erp_indisponivel` |
| `GET` | `/integracao/operacoes` | Painel de sincronização: última carga, volume, erros | INT-08 | — |
| `POST` | `/integracao/operacoes/{id}/reprocessar` | Retomada a partir do `cursorRetomada` | INT-05/08 | — |
| `GET` `POST` | `/integracao/conflitos` · `/{id}/resolver` | Conflitos de identidade (§6.4) e vendedores não mapeados (§8.4) | RFV-08, GES-02 | — |
| `GET` `POST` `PATCH` `DELETE` | `/integracao/webhooks` | Assinaturas de saída: URL, segredo, eventos | INT-07 | — |
| `GET` | `/integracao/webhooks/{id}/entregas` · `POST /entregas/{id}/reenviar` | Log de entrega e replay | INT-07 | — |
| `POST` | `/integracao/importacoes` | CSV com mapeamento de colunas → vira `operacao_ingestao` | INT-09 | — |

### 5.9 `analitico`

⚠️ **Toda resposta deste contexto carrega `{ apuradoEm, confiavel, apuradoDesde }`** (INV-56) e é
servida pela **réplica de leitura** (§8.7 do modelo). Consulta pesada não pode competir com o inbox.

| Método | Rota | O que faz | Requisito |
|---|---|---|---|
| `GET` | `/analitico/home` | Vendas, ticket, clientes novos × recorrentes, por período e filial | BI-01/04 |
| `GET` | `/analitico/vendas/serie` | Série com eixo duplo e comparação com o ano anterior | BI-03 |
| `GET` | `/analitico/vendas` · `/analitico/top-produtos` | Tabela detalhada e top por valor/quantidade | BI-05 |
| `GET` | `/analitico/atribuicao` | ⚠️ `{ exata: {...}, estimada: { janelaDias, ... } }` — **dois objetos, nunca um total** (INV-42) | BI-02, CMP-11 |
| `GET` | `/analitico/ranking-vendedores` | Por `venda.vendedor_usuario_id` + `naoMapeados: { qtd, valorCentavos }`. ⚠️ Venda não mapeada entra no **total** e fica **fora** do ranking | GES-02/03 |
| `GET` | `/analitico/atendimento` | Tempo médio de resposta, conversas atendidas, receita por pessoa | GES-03 |
| `GET` | `/analitico/contatos/{id}/metricas` | Total, 1ª/última venda, dias sem vendas, ticket, **média entre vendas** | RFV-04 |
| `GET` | `/analitico/contatos/{id}/rfv` | Faixa atual + **trajetória** (`faixaDe` → `faixaPara` por transição) | RFV-01/02 |
| `GET` | `/analitico/contatos/{id}/categorias` | Donut com drill-down até SKU-cor-tamanho | RFV-05 |
| `GET` | `/analitico/rfv/distribuicao` · `/qualidade-cadastral` · `/mercado` | Base inteira, com filtro de filial e vendedor | RFV-07/08/09 |
| `POST` | `/analitico/exportacoes` | ⚠️ **`202` + job.** Devolve `{ exportacaoId }`; o arquivo sai por URL assinada quando pronto. CSV síncrono da base inteira não existe | BI-09 |
| `GET` | `/analitico/exportacoes/{id}` | Estado e link | BI-09 |

---

## 6. Canal SSE

> Segue `geracrm-tempo-real` e o ADR-007. ⚠️ **É a área de maior risco de segurança do produto** —
> um erro aqui entrega conversa de uma empresa para outra.

### 6.1 Caminho do evento

```
webhook/ação → transação → OUTBOX (mesmo commit) → worker → NOTIFY → SSE → aba
```

O evento nasce no outbox, **na mesma transação do dado** (INV-40). Publicar fora dela entrega aviso
de mensagem que não commitou.

### 6.2 Conexão

| Passo | Chamada | Resposta |
|---|---|---|
| 1 | `POST /v1/eventos/token` | `{ token, expiraEm }` — 5 a 15 min, claims `{ tenantId, usuarioId }`. ⚠️ **Não carrega lista de canais** |
| 2 | `GET /v1/eventos?token=…&canais=a,b,c` | Stream SSE. Cada canal do `canais` é validado **individualmente**; os recusados vêm no primeiro evento `subscricao.resultado` |
| 3 | `POST /v1/eventos/{conexaoId}/subscricoes` `{ canais: [...] }` | Assina canal novo **durante** a conexão (abrir outra conversa) → `[{ canal, estado: 'assinado'\|'recusado', codigo }]` |
| 4 | `DELETE /v1/eventos/{conexaoId}/subscricoes` | Cancela (trocar de conversa) |

⚠️ **Por que o token vai na query string e não no `Authorization`:** `EventSource` não permite
cabeçalho customizado. A escolha tem preço — query string entra em log de proxy — e é **por isso**
que o token é curto, de propósito único e não substitui o JWT. **Redigir `?token=` no log é
obrigatório**, não recomendação.

⚠️ **A subscrição é um `POST` separado porque SSE é unidirecional** — e porque a autorização precisa
ser revalidada **a cada canal pedido**, não só no login (permissão muda durante a sessão).

### 6.3 Autorização por subscrição

Antes de assinar **qualquer** canal, o servidor responde quatro perguntas:

```
1. o canal pertence ao tenant do token?
2. o usuário tem permissão neste número?         (usuario_canal, ou papel de escopo maior)
3. o número pertence a este tenant?
4. a conversa pertence a este número?
```

Recusa é **por canal**, com `codigo` (`autorizacao.sem_permissao`, `canal.invalido`) — nunca derruba
a conexão inteira. ⚠️ Derrubar a conexão por um canal recusado transforma um erro de permissão numa
tela que para de atualizar.

**Nomenclatura** — montada por **uma função** que não aceita construir canal sem tenant:

```
tenant:{T}:numero:{N}      nova conversa, mensagem, status, saúde do canal
tenant:{T}:conversa:{C}    conversa aberta na tela
tenant:{T}:usuario:{U}     pessoais: tarefa, menção, pedido, permissão, notificação
tenant:{T}:campanha:{K}    progresso de disparo
```

⚠️ **Canal sem prefixo de tenant é o vetor de vazamento nº 1.** Não é convenção — é uma função que
torna o erro impossível de escrever.

### 6.4 Formato do evento

```
event: mensagem.recebida
data: {"tipo":"mensagem.recebida","canal":"tenant:0198…:conversa:0198…","conversaId":"0198…","canalId":"0198…","versao":8412}

:keep-alive
```

⚠️ **Payload mínimo — o evento NUNCA carrega conteúdo.** Sem texto, sem nome do contato, sem
telefone, sem valor. Só `tipo`, `canal`, os ids e a `versao`. O cliente recebe o aviso e **busca o
conteúdo pela API autenticada**, que passa por RLS.

**Por que vale o round-trip:** se o fan-out errar o alvo, o intruso recebe um id que **não consegue
resolver**. É a diferença entre um bug e um incidente. Efeito colateral bom: 80 bytes tornam
irrelevante o limite de 8 KB do `NOTIFY`.

⚠️ **Não emitimos `id:` no frame SSE — deliberadamente.** Emitir faz o navegador reenviar
`Last-Event-ID` na reconexão e cria a **ilusão** de que o servidor recupera o histórico. Ele não
recupera: a reconexão é por **cursor de versão no cliente + delta pela API** (§6.5). Um mecanismo de
recuperação que parece existir e não existe é pior que nenhum.

**Catálogo de eventos:**

| `tipo` | Canal | Ids no payload | Consumidor |
|---|---|---|---|
| `mensagem.recebida` | `conversa` + `numero` | `conversaId`, `canalId`, `versao` | Inbox, contador de não lida |
| `mensagem.status` | `conversa` | `conversaId`, `mensagemId`, `status`, `versao` | Balão `✓`/`✓✓` |
| `conversa.criada` | `numero` | `conversaId`, `canalId` | Lista do inbox |
| `atendimento.assumido` · `.transferido` · `.encerrado` | `numero` + `usuario` | `atendimentoId`, `conversaId` | ⚠️ Fila: a conversa **sai da fila dos outros em tempo real** (spec §7) |
| `presenca.alterada` | `conversa` | `conversaId`, `usuarioId` | "Eduarda está nesta conversa" (INB-18) |
| `pedido.efetivado` · `pedido.falhou` | `usuario` | `pedidoId`, `erroTipo?` | Painel de pedido |
| `campanha.progresso` | `campanha` | `campanhaId`, `enviadas`, `falhas` | Fila de disparo (CMP-07) |
| `canal.saude_alterada` | `numero` | `canalId`, `campo` | Painel de saúde (CAN-04/06) |
| `tarefa.atribuida` · `notificacao.criada` | `usuario` | `tarefaId` / `notificacaoId` | Sino (PLT-07) |
| **`permissao.alterada`** | `usuario` | — | ⚠️ Cliente **descarta o token** e re-autoriza |

### 6.5 Reconexão

- O cliente guarda a **última `versao` por canal**; ao reconectar, busca o **delta pela API**
  (`GET /v1/conversas?desdeVersao=…`, `GET /v1/conversas/{id}/mensagens?desdeVersao=…`).
- ⚠️ **Não confiar em histórico de broker.** O cursor no cliente é mais simples, mais barato e
  sobrevive à troca de infraestrutura (e ao gatilho de migração para Centrifugo).
- Backoff exponencial com teto.
- ⚠️ **Estado da conexão é visível na tela** — conectado / reconectando / offline. Silêncio é pior
  que aviso: a vendedora precisa saber que parou de receber.

### 6.6 Revogação

| Situação | Tratamento |
|---|---|
| Permissão mudou | `permissao.alterada` no canal do usuário → cliente descarta o token e re-autoriza |
| Token expirou | Renovação silenciosa; falhando, estado degradado **com aviso**, nunca tela branca |
| Usuário removido do número / desativado / logout | ⚠️ **Assinaturas encerradas no servidor**, não só no cliente. Encerrar só no cliente não é revogação |

### 6.7 Testes obrigatórios do canal

```
□ usuário do tenant A pedindo canal do tenant B → recusado
□ usuário sem permissão no número → recusado
□ permissão revogada durante a sessão → evento não entregue
□ payload publicado não contém conteúdo de mensagem
□ evento de transação revertida não é publicado
□ reconexão com cursor recupera o delta sem duplicar
□ canal recusado não derruba os demais canais da mesma conexão
```

---

## 7. Webhooks

### 7.1 Entrada — Meta (WhatsApp e Instagram)

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/webhooks/meta` | Verificação: devolve `hub.challenge` quando `hub.verify_token` confere |
| `POST` | `/webhooks/meta` | Recepção. WhatsApp e Instagram no **mesmo endpoint**; o campo `object` distingue |

**Assinatura:** `X-Hub-Signature-256: sha256=<hmac do corpo BRUTO>`. ⚠️ O parser JSON do Fastify
precisa **preservar o raw body** — reserializar antes de validar quebra a assinatura de forma
intermitente (espaço, ordem de chave, escape de unicode) e o sintoma aparece só em produção.

**Resolução de tenant** — ⚠️ e aqui a regra da §2.2 se sustenta sem exceção: o tenant **não está na
URL nem em parâmetro**. Ele é **resolvido** de `entry[].id` (WABA) + `changes[].value.metadata.phone_number_id`
contra `numero_whatsapp` (ou `ig_user_id` contra `perfil_instagram`). `phone_number_id` desconhecido
⇒ **`200` + log**, nunca `4xx`.

**O que o gateway faz — e nada além disso:**

```
valida assinatura → INSERT em evento_externo ON CONFLICT DO NOTHING → outbox → responde 200
```

| Regra | Por quê |
|---|---|
| ⚠️ **O código HTTP é instrução, não relatório** | `2xx` encerra; erro faz a Meta reenviar |
| ⚠️ **Falha permanente (401/403/404, tenant desconhecido, payload sem sentido) responde `200`** | Com entrega sequencial, um evento que falha sempre **trava a fila de TODOS os clientes** |
| Assinatura inválida ⇒ `401` | Único `4xx` legítimo: não veio da Meta, e retentativa não é problema nosso |
| Orçamento de resposta < 5 s | Processar dentro do handler é o que produz reenvio em loop |
| Idempotência por `(canal, id_externo_evento)` | INV-37. ⚠️ `evento_externo` **não é particionada** justamente para essa única existir de verdade (INV-60) |
| Retenção da linha-chave **além da janela máxima de reentrega da Meta** | Reentrega tardia que passa pela dedup insere **custo em dobro** (INV-54) |

**Eventos tratados:** mensagem recebida · status de entrega (enviado/entregue/lido/falha, monotônico
por INV-39) · mudança de qualidade e tier do número · aprovação/rejeição de template.

### 7.2 Saída — nossos webhooks para clientes (INT-07)

| Item | Contrato |
|---|---|
| Método | `POST` na URL da assinatura, `Content-Type: application/json` |
| Assinatura | `X-GeraCRM-Assinatura: t=<unix>,v1=<hmac_sha256(t + "." + corpo)>` com o segredo da assinatura. ⚠️ Tolerância de **5 min** no `t` — sem isso o webhook é reproduzível para sempre |
| Cabeçalhos | `X-GeraCRM-Evento`, `X-GeraCRM-Entrega-Id`, `X-GeraCRM-Tentativa` |
| Entrega | **At-least-once.** ⚠️ O consumidor **precisa** ser idempotente por `entregaId` — está escrito na documentação pública (INT-06) |
| Retentativa | `2xx` = sucesso. Backoff 1 min → 5 min → 30 min → 2 h → 6 h; 5 tentativas |
| Desativação | Após N falhas consecutivas, assinatura **desativada** com notificação in-app (PLT-07) — nunca em silêncio |
| Replay | `POST /v1/integracao/webhooks/entregas/{id}/reenviar` |

**Eventos publicados:** `mensagem.recebida` · `contato.qualificado` · `negocio.etapa_alterada` ·
`campanha.finalizada` · `tarefa.concluida` · `pedido.efetivado`.

⚠️ **Aqui o payload NÃO é mínimo — e a diferença em relação ao SSE é deliberada.** O SSE fala com
uma aba que já tem sessão autenticada e pode buscar o conteúdo sob RLS; o webhook fala com o sistema
do cliente, que **não tem sessão**, e um payload de ids obrigaria uma chamada de volta para cada
evento. Então o webhook carrega os campos de negócio do evento. **Conteúdo de mensagem é opt-in por
assinatura** (`incluirConteudo`, default `false`): é dado do cliente, mas mandá-lo para uma URL
configurada por engano não deve ser o comportamento padrão.

### 7.3 Entrada — ERP do cliente (`webhookDeVenda`)

```
POST /webhooks/erp/{conexaoId}
X-GeraCRM-Assinatura: t=…,v1=…        (segredo por conexão)
```

⚠️ **`conexaoId` na rota não viola a §2.2.** Ele **não é** `tenantId`: é um UUID v7 opaco de uma
linha sob RLS, que **deriva** o tenant, e a assinatura HMAC por conexão é quem autentica. A regra
proibida é o cliente **escolher o tenant**; aqui ele prova posse de um segredo de uma conexão
específica. Conexão inativa ou assinatura inválida ⇒ `401`, e nada é gravado.

Conexão **sem** `webhookDeVenda` usa sincronização agendada, e a latência da atribuição 3/7/14 d é
**declarada na interface** — degradação anunciada, não bug (ADR-008).

---

## 8. API pública de ingestão (INT-02)

> ⚠️ **Ela é o conector universal e não pode ser menos capaz que um adaptador nativo.** Se qualquer
> coisa que o conector GeraCloud faz for exclusiva dele, o produto vira acessório do ERP da casa e
> perde o mercado externo (regra de ouro da §4 do escopo, diferencial **D6**).

### 8.1 Superfície

Prefixo `/ingest/v1`. Autenticação por Bearer token de integração (§2.3), amarrado a **uma**
`conexao_erp`.

| Método | Rota | Fluxo | Requisito |
|---|---|---|---|
| `POST` | `/ingest/v1/customers` | Clientes | INT-02, CTT-01…04 |
| `POST` | `/ingest/v1/products` | Produtos, variantes, tabelas de preço, saldo | INT-02, CAT-01 |
| `POST` | `/ingest/v1/orders` | Vendas (fato do ERP) | INT-02, RFV |
| `POST` | `/ingest/v1/orders/historico` | Abre/fecha janela de carga histórica | INT-05 |
| `GET` | `/ingest/v1/operacoes/{operacaoId}` | Estado, contadores, `cursorRetomada` | INT-08 |
| `GET` | `/ingest/v1/customers/{idExterno}` | ⚠️ **Leitura de volta.** O integrador precisa ver **o que gravamos** para depurar — sem isso, todo suporte de integração vira troca de e-mail | INT-06/08 |

⚠️ **Os nomes dos três fluxos ficam em inglês** (`customers`, `products`, `orders`), contra a
convenção de domínio em português. Dois motivos: o escopo já os fixou assim (INT-02) e o público é
integrador de qualquer ERP, não o usuário do produto. Renomear depois quebraria clientes que fazem
deploy no calendário deles (§1.2).

**Os três fluxos são independentes e combináveis.** Um cliente que só manda `orders` tem RFV, ciclo
de vida e Funil de Relacionamento funcionando — e a cobertura declarada diz que o cadastro veio de
outro lugar.

### 8.2 Corpo do lote

```json
{
  "operacaoId": "2026-08-07T03:00Z#customers#lote-12",
  "modo": "incremental",
  "itens": [
    { "idExterno": "4471",
      "documentos": [ { "tipo": "CNPJ", "digitos": "60631000001430", "fiscalPadrao": true } ],
      "nomes": [ { "valor": "SATURNO E ALVES LTDA", "preferido": true } ],
      "telefones": [ { "bruto": "(81) 99861-7049", "principal": true } ],
      "enderecos": [ … ], "atualizadoEm": "2026-08-07T02:55:00Z" }
  ]
}
```

- `modo`: `incremental` (default) ou `historico` (§8.6).
- ⚠️ **Nós normalizamos, o integrador não precisa.** Telefone em formato livre é aceito e
  normalizado na escrita (INV-06, §6.5 do modelo) — exigir E.164 do ERP de polo é exigir que ele
  resolva o problema do nono dígito, que nem nós resolvemos por adivinhação.
- ⚠️ **`atualizadoEm` do item é do ERP**, e é o que permite ordenar precedência sem depender da
  ordem de chegada dos lotes.

### 8.3 Resposta

```json
{
  "operacaoId": "2026-08-07T03:00Z#customers#lote-12",
  "repetida": false,
  "recebidos": 1000, "aceitos": 994, "rejeitados": 5, "conflitos": 1,
  "erros": [
    { "indice": 17, "idExterno": "4471", "codigo": "documento_invalido",
      "mensagem": "CNPJ com dígito verificador inválido" }
  ],
  "conflitosDetectados": [
    { "indice": 22, "idExterno": "9982", "conflitoId": "0198…",
      "codigo": "contato.conflito_de_identidade" }
  ],
  "cursorRetomada": "0198…"
}
```

⚠️ **Sucesso parcial é `200`, não `207` nem `400`.** Uma linha ruim entre mil **não pode** derrubar o
lote: o job noturno do ERP de polo não tem quem o babysitte, e um `400` transforma um CNPJ digitado
errado em "a integração parou de funcionar há três semanas".

**A exceção que impede importar lixo:** mais de **50%** rejeitado ⇒ `422
ingestao.lote_majoritariamente_invalido`, **nada é gravado**. Taxa alta de rejeição é mapeamento
errado, não dado sujo — e falhar alto aqui é mais barato que reconciliar depois.

### 8.4 Idempotência — em **dois** níveis, e os dois são necessários

| Nível | Chave | O que protege |
|---|---|---|
| **Operação** (INT-04) | `operacaoId` no corpo (ou `Idempotency-Key`), gravado em `chave_idempotencia (tenant, escopo, chave)` | Reenvio do **mesmo lote** devolve **o resultado original**, com `repetida: true`, **sem reprocessar** |
| **Item** | `idExterno` → `(conexao_id, id_externo)`, a chave determinística nº 1 da precedência (§6.2 do modelo) | Upsert convergente: o mesmo item em lotes diferentes atualiza, não duplica |

⚠️ **Só um dos dois não basta:**

| Só chave de operação | Só id externo |
|---|---|
| Um lote reenviado **com um item a mais** tem `operacaoId` novo e reprocessa os 999 já gravados; ou o integrador reusa o id e o item novo **nunca entra** | Contadores (`aceitos`, `rejeitados`), cobertura e o job de reconciliação (INV-57) rodam de novo a cada retry — e a ingestão de venda é a travessia de agregado "que mais dói" (§3.8 do modelo) |

**Venda tem uma terceira guarda:** `venda_chave_externa (tenant, conexao, numeroExterno)`, tabela
não particionada, é quem garante que a mesma venda não entra duas vezes (§6.6) — e **INV-55** garante
que duas conexões diferentes não gravam a mesma venda física: só **uma** conexão por tenant é
`fonte_de_venda`; a outra abre conflito em vez de gravar.

### 8.5 Limites

| Limite | Valor | ⚠️ |
|---|---|---|
| Itens por lote | **1.000** | Acima ⇒ `413 ingestao.lote_grande_demais`, com o limite no `detalhe` |
| Corpo | **5 MB** | Idem |
| Requisições | **60/min** por token, burst 120 | `429` + `Retry-After` + `X-RateLimit-*` |
| Lotes concorrentes | **4** por conexão e por fluxo | Acima ⇒ `409 ingestao.operacao_em_andamento` |
| **Carga histórica** | Faixa própria, **prioridade menor** | ⚠️ Carga histórica **nunca** compete com a primária. Ela roda com concorrência menor e cede na hora comercial — é a regra "sem derrubar a primária" da skill de conectores |
| Retenção do resultado de operação | 30 dias | Depois disso, reenvio de `operacaoId` antigo reprocessa |

### 8.6 Carga histórica (INT-05) — e por que ela é declarada, não inferida

```
POST /ingest/v1/orders/historico   { "acao": "iniciar", "desde": "2021-01-01", "ate": "2026-08-01" }
  → { "cargaId": "0198…" }                cobertura ← 'em_andamento'

POST /ingest/v1/orders   { "modo": "historico", "cargaId": "0198…", "operacaoId": "…", "itens": [...] }
  … repetido, com cursorRetomada em caso de queda …

POST /ingest/v1/orders/historico   { "acao": "concluir", "cargaId": "0198…" }
  → cobertura ← 'completa'  +  reconciliação (INV-57)  +  reclassificação de RFV
```

⚠️ **Sem a janela declarada, o produto mente com confiança.** `operacao_ingestao` registra a
**execução do lote**, não o **horizonte coberto**. Num ERP sem carga histórica — ou com carga
parcial, ou em andamento — a ficha exibe *"Dias sem vendas: 267"* e *"Perdido"* para cliente ativo, a
base inteira cai na coluna "Lead" do CRM-02 e a matriz RFV classifica tudo como Perdido. É
exatamente o que INV-56 existe para impedir, e a única forma de o servidor saber é o integrador
**dizer** que janela está mandando.

Enquanto `cargaHistoricaEstado` ≠ `completa`, toda projeção derivada de venda responde com
`confiavel: false` e a tela mostra **"não sabemos"** — não um número errado.

### 8.7 Erros HTTP da ingestão

| Status | Código | Quando |
|---|---|---|
| `400` | `requisicao.corpo_invalido` | JSON malformado ou schema recusado |
| `401` | `autenticacao.token_invalido` | Token inexistente, revogado ou hash não confere |
| `403` | `autorizacao.escopo_insuficiente` | Token sem `ingest:orders`, por exemplo |
| `403` | `integracao.conexao_inativa` | Conexão desativada no console |
| `409` | `ingestao.operacao_em_andamento` | Mesmo `operacaoId` ainda executando |
| `409` | `ingestao.carga_historica_em_andamento` | Segunda carga histórica no mesmo fluxo |
| `413` | `ingestao.lote_grande_demais` | §8.5 |
| `422` | `ingestao.fluxo_nao_habilitado` | Conexão sem aquele fluxo declarado |
| `422` | `ingestao.lote_majoritariamente_invalido` | >50% rejeitado; **nada gravado** |
| `429` | `requisicao.limite_de_requisicoes` | `Retry-After` obrigatório |
| `503` | `servico_indisponivel` | Manutenção / breaker. `Retry-After` obrigatório |
| `200` | — | ⚠️ **Inclui sucesso parcial.** §8.3 |

### 8.8 ⚠️ Paridade com o adaptador nativo — a tabela que prova (ou desmente) o D6

O adaptador nativo **puxa** do ERP; a API pública recebe **empurrado**. Isso resolve ingestão, mas
não resolve sozinho as capacidades **síncronas**, que são exatamente as que o Painel de Pedido usa.
A resposta é **callback declarado**: o cliente registra, na conexão, as URLs que nós chamamos.

| Capacidade (ADR-008) | Adaptador nativo | API pública | Se ausente |
|---|---|---|---|
| `ingestaoClientes/Produtos/Pedidos` | pull agendado | `POST /ingest/v1/{customers,products,orders}` | Fluxo desligado, cobertura declarada como `ausente` |
| `cargaHistorica` | pull paginado com retomada | `modo: "historico"` + janela declarada (§8.6) | RFV começa a contar da instalação, **e a tela diz isso** |
| `webhookDeVenda` | webhook do ERP | ingestão em quase tempo real por `POST /ingest/v1/orders` | Sincronização agendada; latência da atribuição **declarada na interface** |
| `saldoSincrono` | `GET` no ERP em ≤ 2 s | **callback** `conexao.callbacks.saldo` — mesmo timeout, mesmo contrato | Saldo da última sincronização **com aviso e horário**; validação migra para a efetivação |
| `tabelaPrecoSincrona` · `creditoCliente` | idem | callbacks `precos` · `credito` | Preço da última carga com aviso; bloco de crédito **não aparece** (não aparece desabilitado) |
| `escritaPedido` | `POST` no ERP idempotente | **callback** `pedido`, recebendo `chaveEfetivacao` e devolvendo `{ numeroExterno }` **ou um dos códigos do PED-08** | Tira-pedidos vira **rascunho exportável** |
| `consultaPedidoPorChave` | `GET` por chave | callback `pedidoPorChave` | Pedido em `aguardando_conferencia` com confirmação humana (INV-53) |

⚠️ **O callback de pedido tem de devolver erro tipificado, não string do ERP.** Se o sistema do
cliente responde `"erro 42: falha"`, a tela do PED-08 não consegue oferecer "ajustar quantidade" nem
"solicitar liberação" — e o módulo cai no cenário de abandono descrito no escopo. Isso está na
documentação pública (INT-06) como requisito, e a suíte de conformidade (§9.4) roda contra a conexão
pública igual roda contra um adaptador nativo.

⚠️ **Capacidade da conexão pública é declarada pelo cliente, nunca inferida.** Registrou o callback
de saldo ⇒ `saldoSincrono: true`. Não registrou ⇒ `false`, e a interface degrada **visivelmente**.
Inferir capacidade por tentativa e erro produz a degradação silenciosa que o ADR-008 proíbe.

---

## 9. Porta dos conectores de ERP

> Segue `geracrm-conectores-erp` e o ADR-008. Vive em `packages/shared` (tipos) +
> `apps/api/src/contexts/integracao` (implementação). ⚠️ **Só o contexto `integracao` conhece
> formato de ERP.**

### 9.1 A regra que define a porta

⚠️ **A porta é definida pela necessidade do NOSSO domínio, nunca pela API do fornecedor.** Se a
interface tem método com nome de endpoint de ERP (`getClientesV2`, `postPedidoIntegracao`), não é
porta — é SDK copiado, e o segundo conector prova isso da pior forma. Existe teste que varre os
nomes de método da interface e falha se aparecer nome de fornecedor.

### 9.2 Declaração de capacidades

```ts
export type Capacidades = {
  ingestaoClientes: boolean
  ingestaoProdutos: boolean
  ingestaoPedidos: boolean
  cargaHistorica: boolean
  webhookDeVenda: boolean
  saldoSincrono: boolean
  tabelaPrecoSincrona: boolean
  creditoCliente: boolean
  escritaPedido: boolean
  consultaPedidoPorChave: boolean    // INV-53 — sem ela, timeout vira conferência humana
  consultaPedidoPorNumero: boolean
}
```

Preenchida **antes** de escrever código do adaptador, exposta em
`GET /v1/integracao/conexoes/{id}/capacidades`, e **visível na interface**. ⚠️ Capacidade ausente é
`skip` na suíte de conformidade, **não** falha — ERP sem saldo síncrono não é conector quebrado.

### 9.3 A interface

```ts
/** Contexto de chamada. Adaptador é STATELESS: credencial vem por chamada, nunca em campo. */
export type ContextoErp = {
  tenantId: string
  conexaoId: string
  credencial: CredencialDecifrada   // decifrada pelo repositório, nunca logada
  prazoMs: number                   // 2000 nas leituras síncronas, 15000 na escrita de pedido
  sinal: AbortSignal
}

/** Falha de negócio é RETORNO, não exceção. */
export type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: ErroIntegracao }

/** Exatamente o catálogo da §4.3 — o adaptador TRADUZ, nunca repassa string do ERP. */
export type ErroIntegracao =
  | { tipo: 'estoque_esgotado'; variantes: { skuExterno: string; disponivel: number }[] }
  | { tipo: 'credito_bloqueado'; disponivelCentavos: number }
  | { tipo: 'item_inativado'; variantes: { skuExterno: string }[] }
  | { tipo: 'cliente_sem_cadastro_fiscal'; faltando: string[] }
  | { tipo: 'indisponivel' }                      // → 502, retentável com a MESMA chave
  | { tipo: 'timeout' }                           // → 504, ⚠️ exige reconciliação (INV-53)
  | { tipo: 'capacidade_indisponivel'; capacidade: keyof Capacidades }
  | { tipo: 'recusa_do_erp'; codigoExterno: string }   // ⚠️ último recurso; `bruto` vai para erro_detalhe
```

```ts
export interface ConectorErp {
  readonly sistema: string
  capacidades(): Capacidades

  // ── 1. Ingestão em lote ────────────────────────────────────────────────────
  lerClientes(ctx: ContextoErp, cursor?: string): Promise<Resultado<Pagina<ClienteCanonico>>>
  lerProdutos(ctx: ContextoErp, cursor?: string): Promise<Resultado<Pagina<ProdutoCanonico>>>
  lerVendas(ctx: ContextoErp, janela: { desde: string; ate: string },
            cursor?: string): Promise<Resultado<Pagina<VendaCanonica>>>

  // ── 2. Leitura síncrona (durante a montagem do pedido) ──────────────────────
  consultarSaldo(ctx: ContextoErp, skus: string[]): Promise<Resultado<SaldoApurado[]>>
  consultarCondicaoComercial(ctx: ContextoErp, idExternoCliente: string): Promise<Resultado<CondicaoComercialApurada>>
  consultarCredito(ctx: ContextoErp, idExternoCliente: string): Promise<Resultado<CreditoApurado>>

  // ── 3. Escrita de pedido ───────────────────────────────────────────────────
  efetivarPedido(ctx: ContextoErp, pedido: PedidoCanonico,
                 chaveEfetivacao: string): Promise<Resultado<{ numeroExterno: string }>>
  consultarPedidoPorChave(ctx: ContextoErp, chaveEfetivacao: string): Promise<Resultado<{ numeroExterno: string } | null>>
}
```

| Detalhe | Regra |
|---|---|
| **Stateless** | Credencial por chamada, cifrada em repouso, **por tenant**. ⚠️ Credencial de um cliente jamais alcança outro (INV-41), e nunca aparece em log |
| **`chaveEfetivacao` entra por parâmetro** | Ela é **do nosso domínio** (INV-29), derivada de `versao_conteudo`. O adaptador só a repassa ao ERP como chave de idempotência — **não** a gera |
| **Modelo canônico** | `ClienteCanonico`, `PedidoCanonico`… são **nossos**. ⚠️ Nenhum tipo de fornecedor cruza a fronteira de `integracao` |
| **`SaldoApurado`** | ⚠️ Sempre `{ quantidade, apuradoEm, aoVivo }` — **nunca** um número solto. Um saldo sem hora é uma mentira com aparência de dado |
| **Timeout** | 2 s nas leituras síncronas (spec, exigência 3). Estourou ⇒ a tela **avisa e bloqueia o envio** — nunca deixa montar às cegas para falhar depois |
| **Circuit breaker** | Por `(tenant, conexao)`. ERP fora do ar degrada **localizado**: o inbox continua mostrando histórico, o pedido bloqueia com aviso claro |
| **Origem por campo** | Todo dado ingerido grava `contato_campo_origem` (§6.3). Com N ERPs escrevendo, é preciso saber quem escreveu o quê — é o que responde *"por que o nome mudou sozinho?"* |
| **Sem regra de negócio no adaptador** | Ele mapeia e traduz erro. Validação de pedido mínimo, mix e grade é do agregado `Pedido` (INV-27) |

### 9.4 Suíte de conformidade

**Uma suíte, rodada contra todo adaptador — e contra a conexão pública (§8.8).** É o que prova que a
porta é do nosso domínio e não do fornecedor.

```ts
describe.each(conectores)('conformidade — %s', (c) => {
  it('ingestão de cliente produz o modelo canônico completo', …)
  it('reenvio da mesma operação é idempotente', …)
  it('erro do ERP volta tipificado, nunca string crua', …)
  it.skipIf(!c.capacidades().saldoSincrono)('saldo responde dentro do timeout', …)
  it.skipIf(!c.capacidades().escritaPedido)('escrita devolve número OU um dos 4 erros de negócio', …)
  it.skipIf(!c.capacidades().escritaPedido)('mesma chaveEfetivacao não cria segundo pedido', …)
  it.skipIf(c.capacidades().saldoSincrono)('sem saldo síncrono, a resposta traz apuradoEm e aoVivo=false', …)
})
```

⚠️ **A degradação também é testada** — o `skipIf` invertido do último caso. Conector mockado **pelo
contrato**, com fixtures reais (sucesso, recusa tipificada, timeout). Proibido stub ad-hoc de
`fetch`; ERP real só em teste manual etiquetado, nunca no CI.

---

## 10. O que este contrato proíbe

| # | Proibição | Onde já mordeu |
|---|---|---|
| 1 | `tenantId` em path, query, corpo ou cabeçalho | INV-02 · §2.2 |
| 2 | Coleção sem paginação por cursor, ou `top-N` com `.limit(N)` fixo | INV-47 · OOM real no GeraCloud |
| 3 | `OFFSET`, e `total` por `COUNT(*)` em endpoint de lista | §3.5 |
| 4 | Erro de negócio como `500`, ou como `200` com `sucesso:false` | §4.1 · PED-08 |
| 5 | Controle de fluxo por texto de mensagem de erro | ADR-011 |
| 6 | Dinheiro em float, string de reais ou campo sem sufixo `_centavos` | INV-46 |
| 7 | `enum` do TypeScript, status numérico mágico | ADR-011 |
| 8 | Payload de SSE com conteúdo de mensagem | ADR-007 · §6.4 |
| 9 | Canal de push sem prefixo de tenant | INV-05 |
| 10 | Autorização decidida no controller | `geracrm-identidade-acesso` |
| 11 | Blob (áudio, imagem, PDF) trafegando pela API ou em Base64 | §1.4 · §5.2 |
| 12 | Credencial de ERP ou da Meta na resposta de qualquer endpoint | INV-41 |
| 13 | Saldo, crédito ou condição comercial devolvidos sem `apuradoEm`/`aoVivo` | §6.8 do modelo |
| 14 | Campo somando atribuição **exata** com **estimada** | INV-42 |
| 15 | Webhook da Meta respondendo `4xx`/`5xx` em falha permanente | §7.1 |
| 16 | Lote de ingestão inteiro rejeitado por uma linha ruim | §8.3 |
| 17 | Capacidade de conector **inferida** em vez de declarada | ADR-008 |
| 18 | Chave de efetivação gerada pelo cliente | INV-29 · §4.5 |

---

## 11. Decisões em aberto

| # | Decisão | Depende de | Impacto se resolver tarde |
|---|---|---|---|
| 1 | **Domínio e versionamento de host** (`api.geracrm.com.br` × path-based) | Infra Railway + white-label (PLT-09) | White-label com domínio próprio por tenant muda o CORS e o callback do Cognito. Barato agora |
| 2 | **Limites de rate por plano** (PLT-06) — 60/min é o default; plano maior compra mais? | Comercial | Só configuração, se `X-RateLimit-*` existir desde o dia 1 |
| 3 | **`incluirConteudo` em webhook de saída** — default `false` está proposto aqui | LGPD + validação com cliente | Mudar o default depois é vazamento retroativo. ⚠️ Errar para o lado fechado |
| 4 | **Formato do callback público de escrita de pedido** (§8.8) — nosso schema ou algo tipo OpenAPI negociado | Primeiro cliente sem adaptador nativo | Define se o D6 é real. É a peça que falta para a paridade ser demonstrável |
| 5 | **Retenção do resultado de `operacaoId`** (30 dias proposto) | Volume real do primeiro cliente | Curto demais faz reenvio antigo reprocessar; longo demais é storage barato |
| 6 | **`GET /ingest/v1/{fluxo}/{idExterno}` para products e orders** — só `customers` está definido | Feedback de integrador | Aditivo |
| 7 | **Documentação pública gerada a partir do Zod (INT-06)** ou escrita à mão | Onda 1 | Duas fontes de verdade divergem no segundo mês |

---

## 12. Checklist de fechamento

- ☑ Convenção de rota, versionamento, data, dinheiro e cabeçalho declaradas — com as **três
  superfícies** separadas e a assimetria de compatibilidade explicada
- ☑ `tenantId` por parâmetro **não existe**, com os quatro motivos e as **três aparências de exceção**
  resolvidas sem exceção (staff, webhook da Meta, webhook de ERP)
- ☑ Paginação por cursor com formato exato de query, resposta e **cursor assinado com fingerprint de
  filtro** — e o motivo de não ser `OFFSET` ligado à tela que reordena sozinha
- ☑ Erro tipificado com envelope único, tabela de status e **catálogo por código**, incluindo os
  **cinco erros do PED-08** com o `detalhe` que a tela consome
- ☑ A distinção `502` × `504` está escrita, e com ela as **duas chaves de idempotência opostas**
  (mesma versão × versão nova)
- ☑ Superfície completa dos nove contextos, cada endpoint amarrado a um ID de requisito
- ☑ Canal SSE: token curto, subscrição revalidada por canal, **payload mínimo**, reconexão por cursor
  de versão, revogação no servidor — e a justificativa de **não** emitir `id:`
- ☑ Webhooks de entrada (Meta e ERP) e de saída, com assinatura, idempotência e a regra de responder
  `200` em falha permanente
- ☑ API pública de ingestão com três fluxos, **dois níveis de idempotência**, carga histórica
  **declarada** (INV-56) e limites — e a **tabela de paridade** que sustenta o D6
- ☑ Porta dos conectores com capacidades, `Resultado` tipado, modelo canônico e suíte de conformidade
  que também testa a **degradação**
- ☑ Nenhum endpoint existe "porque vai precisar": cada linha tem um ID de requisito ou uma invariante

**Próximas etapas:** os códigos de erro viram união de literais em `packages/shared`; o catálogo da
§4.3 vira cenários executáveis (`bdd`); a §5 vira as rotas Fastify com schema Zod (`geracrm-arquitetura`);
a §9 vira a suíte de conformidade (`geracrm-testes`).
