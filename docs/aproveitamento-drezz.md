# O que aproveitar do drezz no GeraCRM

> Análise de `~/git/drezz` — PDV SaaS para pequenos comércios de moda, da mesma casa (Gera3).
> Revisa e corrige [`stack-arquitetura.md`](./stack-arquitetura.md), escrito antes desta análise.

---

## 1. Por que este repositório importa tanto

Três coincidências que não são coincidência:

1. **Mesma casa, mesma stack.** Gera3, monorepo TypeScript, Railway, Postgres com RLS.
2. **Mesmo ERP de origem.** O drezz *"nasce de um estudo de dados reais de produção do GeraCloud
   (ERP/PDV com ~150 lojas ativas de moda)"* — o mesmo GeraCloud que vai alimentar o GeraCRM. O
   conhecimento sobre esse ERP já está documentado em `docs/estudo-geracloud.md`.
3. **Mesmo domínio.** Moda, grade cor × tamanho, catálogo público compartilhável no WhatsApp,
   multi-tenant por loja. O drezz já modelou tudo isso em produção.

**Consequência direta:** a maior parte das decisões da §4 do `stack-arquitetura.md` já foi tomada,
testada e documentada em ADR. Repetir a análise seria desperdício; divergir sem motivo seria pior —
criaria duas stacks para o mesmo time manter.

---

## 2. Inventário do drezz

### Stack

| Camada | drezz |
|---|---|
| **Monorepo** | pnpm 10 + Turborepo, `apps/*` + `packages/*` |
| **Runtime** | Node 22, TypeScript |
| **API** | Fastify 5 · `@fastify/cors`, `rate-limit`, `sensible` · `fastify-plugin` |
| **ORM / banco** | Drizzle ORM + `postgres.js` · PostgreSQL multi-tenant com **RLS** |
| **Validação** | Zod 4, nas bordas, com schemas em `packages/shared` |
| **Identidade** | **Amazon Cognito headless** — UI 100% própria, JWT validado local via JWKS |
| **Storage** | S3 (`@aws-sdk/client-s3`) |
| **Observabilidade** | Sentry |
| **Build** | esbuild (bundle único) · tsx em dev |
| **Testes** | Vitest + **Testcontainers** (Postgres real) · `fastify.inject()` · RNTL |
| **App** | **Expo 57 universal** (Android · iOS · Web) · expo-router · RN 0.86 + react-native-web · NativeWind 5 + Tailwind 4 · Zustand · expo-updates (OTA) |
| **Migrations** | **SQL à mão** + runner próprio, como `preDeployCommand` no Railway |
| **Hosting** | Railway, deploy separado por watch path |
| **IDs / dinheiro** | UUID v7 · centavos inteiros, nunca float |

### Organização

```
apps/api/src/contexts/     ← 20 contextos por capacidade de negócio
apps/api/src/db/schema/    ← schema TS espelhando o SQL
apps/api/src/http|plugins|seguranca|storage|observabilidade
apps/app/                  ← Expo universal
packages/shared            ← tipos e Zod compartilhados app↔api
packages/fiscal-client     ← client gerado do OpenAPI da ApiFiscal
infra/migrations/          ← 60 arquivos SQL numerados
docs/decisoes.md           ← ADRs
.claude/skills/            ← drezz-arquitetura, drezz-testes + 10 skills Expo + fastify + node
```

---

## 3. Aproveitamento direto — copiar sem discussão

| # | O que | Por que serve ao GeraCRM |
|---|---|---|
| **1** | **Estrutura de monorepo** (pnpm + Turbo + `tsconfig.base.json` + `turbo.json`) | Mesmo formato, ferramentas idênticas, time já opera |
| **2** | **`contexts/` por capacidade** | É exatamente o que `arquitetura-limpa` prega, já em produção com 20 contextos |
| **3** | **Multi-tenant por `tenant_id` + RLS** (ADR-004) | Decisão idêntica à nossa, com a regra crítica já escrita: *"`tenant_id` deriva do token autenticado, nunca de parâmetro"* |
| **4** | **Runner de migrations + SQL à mão** (ADR-012) | Resolve um problema real que teríamos: deploy verde com API quebrada. E a regra de **migration aditiva** (roda antes do código novo, com a versão anterior servindo) |
| **5** | **Paginação server-side obrigatória** | Nasceu de **OOM real no Postgres do GeraCloud em horário comercial**. Nosso kanban tem coluna com 11 mil cards — a regra é literalmente sobre nós |
| **6** | **Testcontainers + teste de RLS com dois tenants** | *"Todo teste de repositório inclui um caso provando que tenant A não lê dados do tenant B."* É a garantia executável do nosso requisito de isolamento |
| **7** | **Regra de webhook** (`docs/webhooks-gateway.md`) | *"O código HTTP é instrução, não relatório"* · idempotência obrigatória · **falha permanente responde 200 para não travar a fila de todos os clientes**. Vale igual para os webhooks da Meta |
| **8** | **Eventos de domínio via outbox pós-commit** | É o mecanismo que precisamos para: webhook da Meta → evento → fan-out para as abas |
| **9** | **Convenções de código** | Sem `enum` TS · união de literais + `z.enum` · dinheiro em centavos · UUID v7 · erros tipados por contexto · blobs em object storage · segredos cifrados em repouso |
| **10** | **Skills `drezz-arquitetura` e `drezz-testes`** | Viram `geracrm-arquitetura` e `geracrm-testes` com adaptação pequena |
| **11** | **10 skills de Expo** | `expo-router`, `expo-native-ui`, `expo-tailwind-setup`, `expo-data-fetching`, `eas-workflows`, `eas-app-stores`, `expo-dev-client`, `expo-project-structure`, `expo-upgrade` — todo o custo de aprendizado do mobile já pago |
| **12** | **`packages/shared`** | Padrão de tipos e Zod compartilhados, já provado |
| **13** | **Deploy por watch path no Railway** | Com a armadilha documentada: se o app passa a importar `shared`, incluir `packages/shared/**` no watch — senão o tipo muda na API e não muda na tela |
| **14** | **Catálogo público + grade cor×tamanho** | Já modelados e em produção. CAT-01/02 e PED-02 do nosso escopo |
| **15** | **Padrão de porta para integração externa** (ADR-011) | Adaptador `Adquirente` com **credencial por loja, não por plataforma**, recebida por chamada, adapter stateless. É o molde exato para o nosso conector de ERP e para as credenciais Meta por tenant |

---

## 4. Correções ao `stack-arquitetura.md`

Cinco pontos onde eu decidi diferente do drezz. Em quatro deles, **o drezz está certo**.

### 4.1 ❌ Eu errei: identidade

| Eu propus | drezz | Correção |
|---|---|---|
| Auth próprio ou plataforma empacotada | **Cognito headless** (ADR-005) | **Adotar Cognito** |

O ADR-005 já resolveu tudo: UI 100% própria (Hosted UI nunca aparece), `custom:tenant_id` como
atributo, papéis por groups, JWT validado localmente via JWKS — **stateless, sem chamada ao Cognito
por request**. MFA, verificação de e-mail e reset delegados. Custo ~zero no free tier por MAU.

E o lock-in já está mitigado por desenho: *"a fronteira é um plugin Fastify + telas próprias —
trocar o IdP não toca produto"*.

Isso também **elimina a decisão pendente nº 1** do `stack-arquitetura.md` (empacotamento de auth).

### 4.2 ❌ Eu errei: Redis

| Eu propus | drezz | Correção |
|---|---|---|
| Redis para pub/sub, throttling e presence | Não usa Redis | **Sem Redis nas Ondas 0–2** |

Reavaliando com o payload mínimo que já projetamos (§5.3 do documento de stack — o evento carrega
só `{tipo, conversaId, versao}`), **Postgres `LISTEN/NOTIFY` atende o fan-out**: o limite de 8 KB
de payload é irrelevante quando o payload tem 80 bytes.

Os outros dois usos também caem:

| Uso | Sem Redis |
|---|---|
| Fan-out de eventos | `LISTEN/NOTIFY` + outbox (mecanismo que o drezz já tem) |
| Throttling por número | Tabela de contador com `UPDATE ... RETURNING` atômico — mesmo padrão da numeração fiscal do drezz |
| Presence (aviso de colisão) | Tabela com heartbeat e TTL lógico, limpeza periódica |

**Ganho:** um componente de infraestrutura a menos — custo fixo, superfície de falha e coisa para
monitorar. Alinha com o princípio de custo reduzido. Redis entra quando **medirmos** necessidade,
não por antecipação.

### 4.3 ❌ Eu errei: fila

| Eu propus | drezz | Correção |
|---|---|---|
| BullMQ sobre Redis | Outbox pós-commit em Postgres | **Outbox + worker**, sem broker |

O outbox garante o que realmente importa: **o evento só existe se a transação commitou**. Broker
separado tem o problema oposto — publica e a transação falha, ou vice-versa.

### 4.4 ⚠️ Divergência legítima: tempo real

O drezz tem a regra *"sem polling no app: estado que muda chega por resposta da própria ação ou
revalidação sob foco"* — nasceu de um antipadrão medido: **polling permanente de fundo dominava o
tráfego do GeraCloud**.

Isso **não conflita** com o nosso SSE. Pelo contrário: SSE é a forma correta de eliminar polling.
O GeraCRM tem uma necessidade que o PDV não tem — mensagem chegando de fora, sem ação do usuário.

E o drezz já registra a exceção consciente que prova a regra: no ADR-011, o PDV faz polling de 2s
**apenas** com o painel de cobrança aberto, para no primeiro estado final e desiste em 3 min.
A disciplina existe; o mecanismo novo é justificado.

**Manter SSE.** Registrar como ADR do GeraCRM, com a justificativa.

### 4.5 ✅ Divergência resolvida: web → **Angular no console** (ADR-010)

> **Decidido:** console web em **Angular 21+**, app do vendedor em Expo. O time domina Angular, e
> RxJS + CDK atacam os dois problemas de UI mais difíceis do produto (stream de eventos e listas
> grandes). Consequências completas no [ADR-010](./decisoes.md). O texto abaixo é o registro da
> análise que levou à decisão.

Este é o único ponto onde não tenho convicção de que o drezz sirva sem ajuste.

| Eu propus | drezz |
|---|---|
| SPA React DOM (Vite) para o app + servidor separado para catálogo público | **Expo universal** — mesmo código para Android, iOS e Web |

**O caso do drezz:** PDV é mobile-first. A tela de venda é simples e o lojista opera pelo celular.
React Native Web resolve bem.

**O caso do GeraCRM é diferente.** A tela onde a vendedora passa o dia é o **inbox de quatro
colunas em desktop**, e o console tem kanban com arrastar-e-soltar, tabelas de campanha com 16
colunas ordenáveis e atalhos de teclado. São exigências de densidade de desktop que o React Native
Web atende com atrito.

Três caminhos:

| | Caminho | Prós | Contras |
|---|---|---|---|
| **A** | Expo universal para tudo | Um código, reaproveita as 10 skills e todo o aprendizado | Inbox denso e kanban com drag-drop sofrem em RNW |
| **B** | **Expo para mobile + React DOM para o console web**, compartilhando `packages/shared` | Cada superfície com a ferramenta certa; regras e tipos compartilhados | Dois front-ends; design system precisa existir nos dois |
| **C** | React DOM responsivo para tudo, sem app nativo | Um front-end | Perde offline e push confiável — inviável (PED-14, MOB-07) |

**Minha recomendação: B.** O app do vendedor (Expo) e o console de operação (React DOM) atendem
usuários e contextos diferentes — é a mesma lógica de "o mobile não é o web espremido" que já
está na `especificacao-telas.md`. O que se compartilha é o que importa: `packages/shared` com
tipos, Zod e regras puras.

⚠️ **Mas esta é decisão sua**, porque o custo de manter dois front-ends recai no time.

---

## 5. Stack consolidada do GeraCRM

Depois das correções:

| Camada | Decisão | Origem |
|---|---|---|
| Monorepo | pnpm + Turborepo | drezz |
| Runtime | Node 22 + TypeScript | drezz (ADR-002) |
| API | Fastify 5, contextos por capacidade | drezz |
| Banco | PostgreSQL + RLS, `tenant_id` do token | drezz (ADR-004) |
| ORM | Drizzle + postgres.js | drezz |
| Validação | Zod nas bordas, `packages/shared` | drezz |
| Identidade | **Cognito headless** | drezz (ADR-005) |
| Migrations | SQL à mão + runner no pre-deploy | drezz (ADR-012) |
| Storage | S3 | drezz |
| Observabilidade | Sentry | drezz |
| Testes | Vitest + Testcontainers + RLS com dois tenants | drezz |
| Hosting | Railway, watch path por app | drezz (ADR-006) |
| **Push server→client** | **SSE + `LISTEN/NOTIFY` + outbox** | **novo — ADR do GeraCRM** |
| **Fila/assíncrono** | **Outbox + workers**, sem broker | drezz, adaptado |
| **Throttling por número** | **Tabela com `UPDATE` atômico** | drezz (padrão da numeração fiscal) |
| **Analítico** | **Réplica + views materializadas** | novo |
| Mobile | Expo / React Native | drezz (ADR-009) |
| **Console web** | **Angular 21+** | **novo — ADR-010** |
| Catálogo público | Renderizado no servidor | novo |

**Componentes de infraestrutura: Postgres + S3 + Railway.** Sem Redis, sem broker, sem
Kubernetes. É o mínimo que atende — e cada adição futura terá um gatilho medido.

---

## 6. O que fazer com as skills

| Skill do drezz | Ação |
|---|---|
| `drezz-arquitetura` | **Copiar e adaptar** → `geracrm-arquitetura`. Trocar contextos fiscais pelos nossos; manter paginação obrigatória, transação por caso de uso, proibições, RLS |
| `drezz-testes` | **Copiar e adaptar** → `geracrm-testes`. Manter Testcontainers, RLS com dois tenants, teste de concorrência, "bug corrigido = teste que o reproduz antes do fix" |
| 10 skills de Expo | **Referenciar como estão.** Genéricas, não têm nada de drezz |
| `fastify`, `node` | **Referenciar como estão** |
| `frontend-design` | Referenciar; o GeraCRM terá identidade própria |

---

## 7. O drezz é o segundo conector, não a stack de origem

Duas informações que reposicionam este capítulo:

1. **O GeraCloud já expõe saldo por SKU e tabela de preço em tempo real** ✅ — o caminho crítico
   da Onda 0 está destravado. `INT-01b` deixa de ser risco.
2. **O GeraCRM será alimentado por vários ERPs.** GeraCloud e drezz são os dois primeiros; o
   produto precisa nascer pronto para os demais e ir a mercado de forma ativa.

Isso eleva a camada de integração de "módulo" a **decisão arquitetural central** — tratada na
§9. E dá ao drezz um papel novo: **ser o segundo conector desde o início é a melhor coisa que
poderia acontecer com a abstração.** Um conector só nunca prova que a porta é boa; dois, com
capacidades diferentes, provam.

Ainda assim, `docs/estudo-geracloud.md` continua valendo: mapeia os 192 recursos REST do
GeraCloud com telemetria APM de 30 dias, e é a fonte para desenhar o adaptador sem adivinhação.

---

## 8. O que NÃO trazer

| Item | Por quê |
|---|---|
| `packages/fiscal-client` e todo o domínio fiscal | O GeraCRM não emite documento fiscal — isso é do ERP |
| Contextos de caixa, cupons, trocas, condicional, etiquetas | Domínio de PDV |
| Adquirência presencial / maquininha | Nosso pagamento é link, não presencial |
| ESC/POS, Bluetooth, impressão térmica | Sem impressão no GeraCRM |
| ADR-008 (online-only) | **Nós precisamos de offline** no tira-pedidos (PED-14). Decisão oposta, e consciente |

⚠️ **E uma inversão importante:** o drezz é **produto vertical de ERP único** — ele *é* o sistema
de gestão da loja. O GeraCRM é **produto horizontal de integração** — vive de conversar com o ERP
que o cliente já tem. Copiar a stack faz todo sentido; copiar a **postura em relação ao ERP**,
nenhum. Ver §9.

---

## 9. Multi-ERP é a decisão arquitetural central

O GeraCRM não é acessório do GeraCloud nem do drezz. É produto de mercado que precisa conectar
em qualquer ERP de moda — Bling, Tiny, TOTVS, ERPs de polo, e os que ainda não conhecemos.

### 9.1 Modelo canônico + porta do domínio

```
        ┌──────────────────────────────────────┐
        │  DOMÍNIO GeraCRM                     │
        │  Cliente · Produto · Pedido · Saldo  │  ← modelo canônico, nosso
        │  TabelaPreco · Credito               │
        └───────────────┬──────────────────────┘
                        │ portas definidas por NÓS
      ┌─────────────────┼─────────────────┬──────────────┐
  ┌───┴────┐      ┌─────┴────┐      ┌─────┴────┐   ┌─────┴─────┐
  │GeraCloud│     │  drezz   │      │  Bling   │   │  API      │
  │adapter  │     │ adapter  │      │ adapter  │   │  genérica │
  └─────────┘     └──────────┘      └──────────┘   └───────────┘
```

⚠️ **A porta é definida pela necessidade do domínio, nunca pela API do fornecedor** (regra da
skill `arquitetura-limpa`). Se a interface tiver um método com o nome de um endpoint do GeraCloud,
não fizemos uma porta — copiamos o SDK.

O padrão já existe na casa: o ADR-011 do drezz define a porta `Adquirente` com **credencial por
loja, não por plataforma**, recebida por chamada, com o adapter stateless. Nosso conector de ERP
é a mesma forma — credencial por tenant, adapter stateless.

### 9.2 Negociação de capacidade — o que faz o produto vender para qualquer ERP

Nem todo ERP entrega tudo. Bling e Tiny têm API rica; um ERP de polo pode só exportar CSV. Se o
produto exigir o melhor caso, ele só vende para quem tem o melhor ERP.

**Cada conector declara o que suporta:**

```
{
  ingestaoClientes:   true,
  ingestaoProdutos:   true,
  ingestaoPedidos:    true,
  cargaHistorica:     true,
  saldoSincrono:      true,   ← GeraCloud: sim
  tabelaPrecoSincrona:true,
  creditoCliente:     true,
  escritaPedido:      true,
  webhookDeVenda:     false   ← se false, sincroniza por polling agendado
}
```

**E o produto degrada por capacidade, em vez de quebrar:**

| Capacidade ausente | Comportamento |
|---|---|
| `saldoSincrono` | Painel de pedido mostra saldo da última sincronização, **com aviso e horário**; a validação de estoque migra para o momento da efetivação (PED-08 já trata a falha) |
| `tabelaPrecoSincrona` | Preço da última carga, com aviso |
| `creditoCliente` | Bloco de crédito não aparece — não aparece desabilitado (regra dos cinco estados) |
| `escritaPedido` | Tira-pedidos vira **rascunho exportável** — a vendedora monta e envia; o lançamento no ERP é manual |
| `webhookDeVenda` | Sincronização agendada; a atribuição de receita 3/7/14d ganha a latência declarada na interface |

⚠️ **A capacidade precisa ser visível na interface, não silenciosa.** O usuário de um ERP limitado
precisa saber *por que* o saldo tem hora, senão ele acha que o produto está errado.

### 9.3 Consequências para o escopo e para a stack

| Item | Consequência |
|---|---|
| `INT-01b` (leitura síncrona) | Deixa de ser exclusiva do GeraCloud; vira **capacidade opcional da porta** |
| `INT-02` (API pública) | Sobe de importância: é o **conector universal** para ERP sem adaptador dedicado |
| `INT-10` (Bling, Tiny, TOTVS) | Sai da Onda 3 e vira estratégia comercial — cada conector novo é mercado novo |
| `INT-13` (marketplace de conectores + SDK) | Deixa de ser diferencial da Onda 4 e vira **caminho natural**: se a porta é boa, terceiros escrevem adaptador |
| **Onboarding** | Ganha uma etapa: escolher o ERP, autenticar, e **ver o que aquele ERP habilita** |
| **Testes** | Suíte de conformidade da porta, rodada contra todo adaptador — o mesmo conjunto de cenários, um adaptador de cada vez |
| **Modelo de dados** | `origem` por campo passa a ser obrigatório: com N ERPs escrevendo, é preciso saber quem escreveu o quê (regra já prevista em `modelar-dados`) |

### 9.4 O drezz como conector é vantagem comercial

Cliente do drezz é loja de moda com PDV — exatamente o perfil de quem precisa de CRM com WhatsApp.
E cliente do GeraCRM sem PDV é candidato ao drezz. Os dois produtos se vendem, e o conector é o
que torna o pacote real em vez de retórico.

Além disso: **desenvolver o adaptador do drezz é barato** (mesma casa, mesma stack, schema
conhecido) e ele tem capacidade alta — serve de referência para os demais.
