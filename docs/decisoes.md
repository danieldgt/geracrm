# Decisões técnicas (ADRs) — GeraCRM

Registro corrido das decisões estruturais. Formato: contexto → decisão → consequência.
Mesmo padrão de `~/git/drezz/docs/decisoes.md`.

---

## ADR-001 — Multi-tenant por `tenant_id` + RLS, desde a modelagem
**Decisão**: um banco, `tenant_id` em toda tabela de domínio, Row-Level Security. O `tenant_id`
deriva do token autenticado, **nunca de parâmetro**. Chaves únicas sempre compostas com o tenant
(`UNIQUE(tenant_id, cnpj)`).
**Consequência**: destrava white-label e painel de revenda (PLT-09/10) na Onda 4 sem reescrita.
Todo teste de repositório inclui caso provando que tenant A não lê dado do tenant B.
Herdado do ADR-004 do drezz.

## ADR-002 — WhatsApp: Cloud API direto, como Tech Provider
**Contexto**: o Embedded Signup é o caminho padrão da Meta desde abr/2026 e o enrollment no Tech
Provider Program é obrigatório para ISVs. Nosso modelo é multi-número por cliente (uma vendedora
por número) — passar por BSP multiplicaria o markup de US$ 0,003–0,010 por mensagem em cada número.
**Decisão**: Cloud API direto, com Embedded Signup embutido no onboarding. **O cliente paga a Meta
direto** (cadastra método de pagamento na própria conta).
**Consequência**: nossa receita nas Ondas 0–2 é só a assinatura; sem risco de crédito. Cadastrar o
método de pagamento vira passo obrigatório do onboarding e campo do painel de saúde do número
(CAN-04) — se faltar, o número não envia, e a falha precisa dizer isso. Migração para Solution
Partner reavaliada na Onda 3.

## ADR-003 — Só API Oficial nas Ondas 0–2
**Decisão**: sem Baileys/Evolution API. Canal é webhook stateless.
**Consequência**: sem sessão WebSocket persistente por número — custo de servidor por número cai
por ordens de grandeza. Elimina risco de banimento, condição para vender ao alvo (faturamento
≥ R$ 150 mil/mês). Se voltar na Onda 3, entra como módulo isolado com infraestrutura própria.

## ADR-004 — Modelo genérico com perfil de vertical configurável
**Decisão**: modelo de dados neutro; atributos variáveis (`referência`, `cor`, `tamanho`, `grade`)
como estrutura configurável, não coluna fixa de moda. Um **perfil de vertical** define nomenclatura
da UI, atributos obrigatórios, regras de pedido mínimo e faixas de RFV padrão.
**Consequência**: perfil "Moda Atacado" nasce completo — é o cliente inicial e o teste da abstração.
Permite autopeças, distribuição e material de construção sem reescrever o núcleo.

## ADR-005 — Tira-pedidos assistido: o pedido nasce na conversa, o ERP efetiva
**Contexto**: havia contradição no escopo — "o pedido vive no ERP" convivendo com "montar pedido no
app". Loja B2B self-service e tira-pedidos assistido são coisas diferentes.
**Decisão**: a vendedora monta o pedido dentro do atendimento (grade, tabela de preço do cliente,
estoque ao vivo); o rascunho é do GeraCRM, a efetivação é do ERP. **Loja B2B self-service segue
fora de escopo** — o ERP já resolve.
**Consequência**: a atribuição de receita ganha fonte **exata** (vínculo pedido ↔ conversa ↔
campanha ↔ tarefa), além da estimada por janela 3/7/14d — e as duas nunca são somadas sem
distinção. Exige do conector leitura síncrona e escrita idempotente. PED-08 (falha na efetivação
sem perder o rascunho) é o item que decide se o módulo é usado ou abandonado.

## ADR-006 — Stack herdada do drezz
**Contexto**: o drezz é PDV SaaS da mesma casa, em produção, com stack validada e ADRs escritos.
Divergir sem motivo criaria duas stacks para o mesmo time manter.
**Decisão**: monorepo pnpm + Turborepo · Node 22 + Fastify · PostgreSQL + RLS · Drizzle +
postgres.js · Zod nas bordas com `packages/shared` · **Cognito headless** (ADR-005 do drezz) ·
S3 · Sentry · Vitest + Testcontainers · Railway com deploy por watch path · **migrations SQL à mão
com runner no pre-deploy** (ADR-012 do drezz) · UUID v7 · dinheiro em centavos.
**Consequência**: as skills `drezz-arquitetura` e `drezz-testes` são adaptadas para o GeraCRM.
A regra de **paginação server-side obrigatória** vem junto — ela nasceu de OOM real no Postgres do
GeraCloud por grid não paginado, e nosso kanban tem coluna com 11 mil cards.

## ADR-007 — Push server→client: SSE + LISTEN/NOTIFY + outbox, sem Redis e sem broker
**Contexto**: mensagem do WhatsApp/Instagram precisa chegar ativamente na aba certa, sem vazar
entre empresas. O drezz não tem tempo real (e proíbe polling de fundo, por antipadrão medido no
GeraCloud); precisamos do mecanismo, com a mesma disciplina.
**Decisão**: **SSE** sobre HTTP/2 para o push (o envio vai por POST — a metade bidirecional do
WebSocket sobraria). Fan-out por **Postgres `LISTEN/NOTIFY`**, alimentado pelo **outbox pós-commit**.
Throttling por número em tabela com `UPDATE` atômico; presence por heartbeat com TTL lógico.
**Isolamento em três camadas**: (1) canal sempre prefixado por tenant, montado por função única que
não aceita canal sem tenant; (2) autorização revalidada **a cada subscrição**, não só no login —
permissão muda durante a sessão; (3) **payload mínimo** (`{tipo, conversaId, versao}`), com o
conteúdo buscado por API autenticada sob RLS.
**Consequência**: mesmo que o fan-out erre o alvo, **não vaza conteúdo** — o intruso recebe um ID
que não resolve. Infraestrutura fica em Postgres + S3 + Railway, sem Redis nem broker. O payload
mínimo torna irrelevante o limite de 8 KB do `NOTIFY`. Migração para broker dedicado (Centrifugo)
é possível sem mudar o cliente — gatilho na §12 de `stack-arquitetura.md`.

## ADR-008 — Multi-ERP com negociação de capacidade
**Contexto**: o GeraCRM será alimentado por vários ERPs — GeraCloud e drezz primeiro, depois Bling,
Tiny, TOTVS e ERPs de polo. Ele é produto horizontal de integração, não acessório de um ERP.
**Decisão**: modelo canônico nosso; **portas definidas pelo domínio, nunca pela API do fornecedor**;
um adaptador por ERP; credencial por tenant, adapter stateless (mesma forma do ADR-011 do drezz).
Cada conector **declara suas capacidades** (`saldoSincrono`, `escritaPedido`, `webhookDeVenda`…) e
o produto **degrada em vez de quebrar**.
**Consequência**: ERP sem saldo ao vivo mostra saldo da última sincronização com aviso e horário,
migrando a validação para a efetivação; ERP sem escrita de pedido transforma o tira-pedidos em
rascunho exportável. A capacidade é **visível na interface** — usuário de ERP limitado precisa
saber por que o saldo tem hora. A API pública (INT-02) sobe de importância: é o conector universal.
Suíte de conformidade da porta roda contra todo adaptador.
✅ **O GeraCloud já expõe saldo por SKU e tabela de preço em tempo real** — caminho crítico da
Onda 0 destravado.

## ADR-009 — Mobile: Expo universal
**Decisão**: React Native + Expo para o app do vendedor, com SQLite local e fila de sincronização
para o tira-pedidos offline (PED-14).
**Consequência**: aproveita as 10 skills de Expo do drezz e o domínio do time. O conflito de
sincronização **não é resolvido automaticamente** — quando o saldo muda entre montar e reconectar,
a divergência é apresentada e a vendedora decide (mesmo tratamento de PED-08). Diverge do ADR-008
do drezz (online-only), de forma consciente: campo e showroom sem sinal são caso de uso real aqui.

## ADR-010 — Front-end do console web: **Angular**

**Contexto**: o console web é onde a operação vive — inbox de quatro colunas em desktop, kanban com
arrastar-e-soltar sobre colunas de milhares de cards, tabela de campanhas com 16 colunas
ordenáveis, e um fluxo contínuo de eventos server→client. É a superfície mais densa do produto e a
mais usada (8 h/dia por vendedora). Duas candidatas: **Angular** (proposta) e **React DOM**.

### Correção de premissa
Suporte a SSE ou WebSocket **não distingue os candidatos**. `EventSource` é API nativa do
navegador e funciona igual em qualquer framework; STOMP é protocolo sobre WebSocket, também
agnóstico. E **STOMP não se aplica ao nosso caso**: é padrão de backend Java/Spring com broker
(ActiveMQ/RabbitMQ) — nosso backend é Fastify e o ADR-007 decidiu SSE + `LISTEN/NOTIFY` sem broker.
Adotar STOMP significaria adicionar broker e protocolo sem ganho.

### Argumentos reais a favor do Angular
1. **RxJS.** O stream de eventos multiplexado por canal, com reconexão, cancelamento ao trocar de
   conversa, merge com estado local e backpressure é **exatamente** o que RxJS modela. Em React,
   isso é artesanal.
2. **Angular CDK.** Virtual scroll maduro para lista de conversas e colunas de kanban; overlay;
   e **Angular Aria** (Angular 21, preview) para acessibilidade headless.
3. **Estrutura opinativa + DI.** Em app grande e de vida longa, reduz divergência arquitetural ao
   longo do tempo — vale mais em console denso do que em site.
4. **Vitest é o test runner padrão do Angular 21** — alinha com a stack de testes do drezz.
5. **Previsibilidade de upgrade.** `ng update` com schematics, cadência de 6 meses.
6. Angular 21 (nov/2025) removeu zone.js, signals dirigem o change detection: bundles menores e
   atualização mais previsível. Angular 22 (mai/2026) consolida a era signal-first.

### Custos reais
1. **Duas culturas de front na casa.** O drezz é React/Expo e o app mobile do GeraCRM será Expo.
   Angular no console significa React no mobile + Angular no web.
2. **Zero componente compartilhado** entre console e app. (`packages/shared` — tipos, Zod, regras
   puras — continua compartilhado; é o que mais importa, mas não é tudo.)
3. ⚠️ **Armadilha concreta:** CDK **drag-drop e virtual scroll não têm suporte oficial conjunto** —
   ao arrastar dentro de viewport virtualizada, os índices deixam de localizar o item. Nosso kanban
   precisa dos dois ao mesmo tempo. Existem soluções, mas é trabalho a orçar, não algo que vem de
   graça.
4. Contratação e onboarding: o pool de Angular é bom, mas o time atual é React.

### Decisão
**Angular (21+) para o console web.** O time domina Angular — o que anula os custos 1 e 4 (cultura
e contratação) e preserva os benefícios. RxJS e CDK atacam justamente os dois problemas de UI mais
difíceis do produto: o stream de eventos e as listas grandes.

Composição final das superfícies:

| Superfície | Tecnologia | Usuário |
|---|---|---|
| **Console web** | **Angular 21+** (zoneless, signals, standalone) | Gestor e atendente, desktop, 8 h/dia |
| **App do vendedor** | Expo / React Native | Campo, showroom, offline |
| **Catálogo público** | Renderizado no servidor, leve | Lojista clicando no link do WhatsApp |

### Consequências

**1. `packages/shared` passa a ser TypeScript puro, obrigatoriamente.**
Consumido por Angular, Expo e API ao mesmo tempo — nenhuma dependência de framework pode entrar.
Só tipos, schemas Zod, constantes e regras puras. ⚠️ Um `import` de React ou de Angular nesse
pacote quebra dois dos três consumidores; vira regra na skill de arquitetura.

**2. Monorepo ganha uma terceira app.**
`apps/api` (Fastify) · `apps/app` (Expo) · **`apps/console` (Angular)** · `apps/catalogo`.
Turborepo orquestra o Angular CLI como qualquer outro alvo (`build`, `test`, `lint`, `typecheck`).
Watch path de deploy próprio para `apps/console/**` + `packages/shared/**` — a armadilha do drezz
(tipo muda na API e não muda na tela) vale igual aqui.

**3. Design system em dois runtimes, tokens em um só.**
Angular (CSS) e Expo (NativeWind) não compartilham componente. Para não divergirem, a fonte da
verdade é um conjunto de **design tokens** (cor, escala tipográfica, espaçamento, raio) em formato
neutro, consumido pelos dois. Componente se duplica; token, não.

**4. SSE consumido como Observable.**
Um serviço Angular expõe o stream por canal, com reconexão, cursor de versão e cancelamento no
`takeUntilDestroyed`. É o encaixe natural do ADR-007 — e a razão técnica principal desta escolha.

**5. ⚠️ O kanban não usa virtual scroll — usa paginação por coluna.**
Resolve a armadilha do CDK (drag-drop e virtual scroll sem suporte conjunto) por desenho, em vez
de gambiarra: com card de ~120 px, uma coluna visível mostra 6–8 cards. Carregar 50 por página com
"carregar mais" ao rolar atende a coluna de 11 mil cards sem virtualizar — e a paginação
server-side já é obrigatória (ADR-006). **Virtual scroll fica para onde não há drag**: lista de
conversas, tabelas de campanha, listas de contatos.

**6. Vitest em toda a stack.** Padrão do Angular 21, já usado na API e no app. Um só runner, uma só
forma de escrever teste.

**7. Angular Aria** (preview no 21) para acessibilidade headless, em vez de reimplementar padrões
WAI-ARIA à mão.

## ADR-012 — Identidade visual própria: azul suave, claro e escuro
**Contexto**: o produto precisava de identidade, e havia três caminhos — herdar da Gera3, derivar do
drezz (laranja #FF6732) ou criar linha própria.
**Decisão**: **identidade própria**. Tons suaves de azul, tema claro com fundo branco e tema escuro
completo, layout marcante e moderno.

**A tensão que governa o sistema**: "marcante" e "oito horas por dia" puxam para lados opostos —
visual marcante que cansa é fracasso funcional. A resolução é gastar boldness em **um** lugar: o
ambiente fica quieto (azul dessaturado, sem gradiente, sem sombra empilhada) e a energia vai para
onde há informação urgente.

**Elemento assinatura — o anel de janela**: a contagem regressiva da janela de 24h vira desenho.
Anel fino ao redor do avatar na lista, barra de 2px no topo do chat, drenando ao longo das 24 horas;
turquesa com folga, âmbar nas últimas 2h, coral ao fechar. Movimento contínuo e lentíssimo — não
pisca. Nasce do domínio (só existe pela regra da Meta), é funcional (substitui leitura de número por
percepção periférica), é onipresente e nenhum concorrente tem — todos usam badge de texto.
⚠️ Nunca é a única fonte: o tempo em texto permanece, e o estado é anunciado a leitores de tela.

**Decisão tipográfica que virou identidade**: monoespaçada para **identificadores** — SKU, telefone,
protocolo, CNPJ, referência. São valores comparados e conferidos o dia inteiro; em mono eles alinham
em coluna e o olho acha a diferença entre dois SKUs parecidos, sem precisar de cor ou negrito.

**Consequências**: `packages/design-tokens/tokens.json` é a fonte da verdade, consumida por Angular
(custom properties) e Expo (NativeWind) — componente se duplica, token não. O tema escuro **não é
inversão automática**: fundo azul profundo (`#0D1830`, não preto) e cores de estado clareadas.
Ficam explicitamente descartados: gradiente em superfície, sombra empilhada, ilustração em estado
vazio, canto muito arredondado e animação de entrada em lista que atualiza em tempo real.
Detalhamento em `docs/identidade-visual.md`.

## ADR-011 — Convenções
Domínio em português (`Conversa`, `Pedido`, `Campanha`), infraestrutura em inglês, comentários em
inglês · sem `enum` do TypeScript (união de literais + `z.enum`) · sem status numérico mágico ·
erros de domínio tipados por contexto, nunca controle de fluxo por `string.includes()` · blobs em
object storage com ponteiro no banco · segredos cifrados em repouso · **toda lista paginada
server-side**, sem exceção.
