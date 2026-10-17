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

## ADR-013 — Precedência na atribuição de receita
**Contexto**: um pedido pode ser atribuível a mais de uma origem ao mesmo tempo — nasceu numa
conversa que veio de uma campanha, e havia uma tarefa aberta para aquele cliente. Sem regra de
precedência, a mesma receita é contada três vezes e a soma dos cards da home fica maior que o
faturamento. ⚠️ Esta decisão estava fechada dentro de `metricas-de-sucesso.md`, mas é **regra de
modelo** (INV-43) e pertence aqui.

**Decisão**: precedência **exata → estimada**, e dentro de cada uma, a origem mais próxima do
pedido vence.

1. **Atribuição exata** (pedido nascido na conversa, PED-09): vence sempre. Dentro dela, a ordem é
   `tarefa` → `campanha` → `conversa espontânea` — a tarefa é o toque deliberado mais recente.
2. **Atribuição estimada** (janela 3/7/14d) só se aplica a pedido **sem** vínculo exato.
3. ⚠️ **Uma receita tem exatamente uma origem.** Nunca somar as duas famílias sem distinção, e
   nunca creditar o mesmo pedido a duas origens "para não perder o crédito".

**Consequência**: os cards da home exibem exata e estimada **separadas, com legenda**. A soma das
origens é igual ao faturamento do período — é o teste que prova a regra. Um pedido reatribuído
(ex.: a campanha chegou depois) reescreve a origem e o histórico registra a troca.

## ADR-014 — Corte seco na virada, com ponto de não retorno declarado
**Contexto**: no dia em que o número do cliente passa a apontar para o GeraCRM, **não há como
manter os dois sistemas recebendo** — o WhatsApp entrega a mensagem a um webhook só. Convivência
real é impossível no canal; o que existe é convivência **de leitura** (consultar o histórico antigo
em outra aba).

**Decisão**: **corte seco por número**, nunca por cliente inteiro. Um número piloto primeiro, o
restante da frota depois. Antes do corte de cada número:
- a **medição do antes** já encerrou (ADR-017) — sem ela não há comparação depois;
- os templates estão aprovados e sincronizados (ADR/E3-15) — ⚠️ no minuto do corte todas as janelas
  estão fechadas;
- a carga histórica está **conciliada**, não apenas importada.

**Ponto de não retorno**: o corte de um número é reversível até a primeira mensagem entrante ser
respondida pelo GeraCRM. Depois disso, voltar ao sistema antigo **perde o histórico do intervalo** —
o rollback deixa de ser técnico e vira decisão de negócio, com perda declarada.

**Consequência**: o cronograma de entrada trata cada número como uma virada independente, com seu
próprio critério de sucesso. ⚠️ Rollback sem critério escrito é decisão tomada no desespero — o
critério está em `entrada-do-primeiro-cliente.md` e é aprovado **antes** do primeiro corte.

## ADR-015 — A Onda 0 fecha com números da Gera3; o cliente entra na Onda 1
**Contexto**: ao definir quando é seguro conectar o número de uma vendedora real,
`entrada-do-primeiro-cliente.md` exigiu que ela consiga buscar conversa, ouvir áudio, ver a ficha do
cliente e deixar comentário — o mínimo para atender de verdade. ⚠️ **Tudo isso é Onda 1.** Sem
perceber, o critério de saída da Onda 0 passou a exigir a Onda 1 inteira, esticando-a para 10–11
semanas sem nenhum marco verificável no caminho.

**Decisão**: a Onda 0 fecha em ~6 semanas usando **números da própria Gera3** (dogfooding). O
cliente real entra na **Onda 1**, quando inbox, busca, áudio e ficha existirem.

**Por quê**: o erro aparece com um número nosso, não com uma vendedora atendendo lojista. E dez
semanas sem marco verificável é tempo demais sem sinal de que a fundação funciona — carga
histórica, conciliação, canal e template são exatamente o que precisa ser provado cedo.

**Consequências**:
- Critério de saída nº 2 da Onda 0 passa a dizer "números da Gera3", e ganha a prova do template
  (E3-15) — no corte, todas as janelas nascem fechadas.
- ⚠️ **O plano da Onda 1 deixa de ser macro e precisa ser detalhado**, no formato de
  `plano-onda-0.md`: é nela que o cliente entra, com carga conciliada, medição do antes, corte por
  número (ADR-014) e treinamento.
- `entrada-do-primeiro-cliente.md` passa a ser executado **na Onda 1**; o levantamento prévio e a
  medição do antes continuam começando **agora**, porque medem o estado anterior e são
  irrecuperáveis depois.
- O que era "Plano B" do risco nº 3 (prazo da Meta) vira o plano.

## ADR-016 — Chave primária composta `(tenant_id, id)`
**Contexto**: sendo multi-tenant (ADR-001), toda tabela de domínio já carrega `tenant_id`. Restava
decidir se a chave primária é o `id` sozinho (UUID v7) ou o par `(tenant_id, id)`.

**Decisão**: **chave primária composta `(tenant_id, id)`** em toda tabela de domínio. Toda chave
estrangeira entre tabelas de domínio também é composta e carrega o `tenant_id`.

**Por quê**:
- ⚠️ **Isolamento deixa de depender só do RLS.** Com a chave composta, é impossível referenciar um
  registro sem dizer de qual tenant ele é — a FK não fecha. Uma segunda barreira, estrutural, que
  não depende de a policy estar correta nem de alguém lembrar do `WHERE`.
- **Localidade dos dados.** O índice agrupa fisicamente as linhas de cada tenant, e as consultas do
  produto são sempre "deste tenant" — inbox, kanban, contatos. Menos páginas lidas por consulta.
- **Um FK cruzando tenants vira erro de escrita, não bug em produção.**

**Custo aceito**: FKs compostas deixam o schema e as queries mais verbosos, e algumas ferramentas
lidam pior com elas. ⚠️ O custo é de digitação; o benefício é de isolamento — e o isolamento é o
requisito que este produto não pode errar.

**Consequências**:
- As migrations `0001` em diante nascem com a chave composta. **Reverter depois da `0012` seria
  reescrita de schema** — é o motivo de a decisão vir antes da primeira migration.
- Tabelas globais sem `tenant_id` (ex.: `plano`) seguem com chave simples — a lista fechada delas
  está em `modelo-de-dados.md` §7.2.
- Entidades com chave local (`contato_documento`, `contato_endereco`) usam `seq` dentro do
  agregado, não UUID — já previsto no modelo §5.3.
- O varredor de schema ganha uma verificação: **tabela de domínio sem `tenant_id` na PK falha o CI**.

## ADR-017 — Medição do antes: 2 semanas, encerrando antes do anúncio à equipe
**Contexto**: para afirmar depois que o produto melhorou a operação, é preciso medir como ela
funciona **antes**. Três indicadores (LB-10/11/12): conversas por vendedora por dia, tempo até a
primeira resposta, e percentual de entrantes sem resposta em 24h.

⚠️ **É o único dado irrecuperável do projeto.** Depois da virada, a operação antiga não existe mais
e não há de onde tirar o número retroativamente.

**O conflito que esta decisão resolve**: dois planos ancoravam a medição em siglas de cronograma —
`plano-onda-0` §5.5 em "antes da S0" e `plano-onda-1`/`entrada` em "T-8". Quando o ADR-015 moveu o
corte da Onda 0 para a Onda 1, as duas passaram a apontar para momentos com **14 semanas de
distância**, e ninguém reancorou.

**Decisão**: a medição dura **2 semanas** e é ancorada em um **fato, não em uma sigla**:

> **Encerra antes de a equipe do cliente ser informada da migração.** Durante a medição, apenas o
> dono do negócio sabe.

**Por quê**: equipe que se sabe observada responde mais rápido do que responderia. Isso produz o
pior resultado possível — o "antes" fica artificialmente bom e, na comparação, **o produto parece
ter piorado a operação**. A medição viraria arma contra o próprio produto.

**Consequências**:
- ⚠️ O anúncio à equipe passa a ser um **marco de cronograma**, com data, e não pode acontecer antes
  do encerramento da medição. Quem combina isso é o dono do negócio, não a gerência de vendas.
- A medição é **independente da onda**: pode rodar durante a Onda 0, desde que a condição acima
  valha. Não espera o corte.
- Custo: **uma pessoa, ~1 h/dia, 2 semanas** — contagem diária de conversas, amostra de 30 conversas
  por vendedora e contagem de sem-resposta às 18h.
- O termo **"janela de sombra"** sai dos documentos. Passa a ser **"medição do antes"** — jargão que
  não explica nada custa reunião, e custou uma.

## ADR-018 — Frota mista na entrada: conexão direta primeiro, portabilidade em paralelo
**Contexto**: levantamento com o cliente piloto revelou que a frota é **mista** — parte das
vendedoras usa o **app WhatsApp Business comum** e parte já opera em **API oficial por outro
fornecedor**. Os dois caminhos de entrada são diferentes em prazo e em dependência.

| Origem do número | Caminho | Depende de | Prazo |
|---|---|---|---|
| App WhatsApp Business | **Conexão direta** por Embedded Signup | Só do cliente | horas |
| API oficial de outro fornecedor | **Portabilidade entre WABAs** | ⚠️ Do fornecedor que está **perdendo** o cliente | até 3 semanas |

**Decisão**: **o piloto começa pelos números de conexão direta.** A portabilidade dos demais corre
**em paralelo**, sem bloquear o primeiro corte.

**Por quê**: o cenário misto, que parecia complicação, é na verdade uma **vantagem de cronograma** —
elimina a dependência de terceiro do caminho crítico do piloto. Se o piloto dependesse de
portabilidade, três semanas de espera de um concorrente entrariam antes da primeira conversa real.

**Consequências**:
- ⚠️ **A solicitação de portabilidade é aberta AGORA**, mesmo que os números só entrem depois — o
  relógio de três semanas é de terceiro e não paraleliza depois.
- O corte por número (ADR-014) ganha um atributo: **origem do número**, que define o procedimento.
- ⚠️ **Números do app comum precisam ser removidos do app antes de conectar**, e as conversas que
  estão lá **não migram**. A vendedora precisa saber disso antes, não no dia.
- Números portados **preservam qualidade, limite e templates** (`meta-plataforma.md` §4); números
  novos começam no tier inicial. Isso muda o que se pode disparar na primeira semana de cada um.
- O treinamento é o mesmo, mas o **roteiro do dia D difere** por origem.

## ADR-019 — Varejo e atacado, com o varejo em primeiro lugar
**Contexto**: todo o planejamento até aqui assumiu **atacado de moda** como vertical inicial — o
escopo funcional, o mapa competitivo (Tailor, Modall), o modelo de dados e o pedido assistido. A
definição agora é outra: o produto atende **atacado e varejo, principalmente varejo**.

**Decisão**: o perfil de vertical (ADR-004) deixa de ser uma abstração para o futuro e passa a ter
**dois perfis ativos desde o dia 1** — `varejo` e `atacado`. O varejo é o caso principal.

### O que muda de verdade

| Área | Atacado | Varejo | Consequência |
|---|---|---|---|
| **Identidade do cliente** | CNPJ | ⚠️ CPF, **ou só telefone e nome** | A reconciliação não pode depender de documento |
| **Pedido assistido (PED)** | Coração do produto | ⚠️ **Periférico** — a venda acontece no PDV | Ver §"O que perde peso" |
| **Grade cor × tamanho** | Essencial (grade fechada) | Compra 1 peça | Continua no modelo, some da tela no perfil varejo |
| **Tabela de preço por cliente** | Regra | Preço único | Capacidade que o perfil varejo ignora |
| **Pedido mínimo, mix, múltiplo** | Regra | Não existe | Validações desligadas por perfil |
| **RFV e recompra** | Importante | ⚠️ **É o produto** | Ganha centralidade |
| **Volume de contatos** | Milhares | ⚠️ Dezenas de milhares | Campanha e segmentação pesam mais |

### ⚠️ A mudança mais séria: identidade sem documento

No varejo, **muito cliente tem só telefone e primeiro nome**. Todo o desenho de reconciliação
partia do CNPJ como chave forte (`modelo-de-dados` §6, conector §2).

Consequências imediatas:
- O **telefone normalizado** passa a ser a chave primária de reconciliação, não a secundária —
  e a função que já existe em `packages/shared` vira ainda mais crítica.
- A **qualidade cadastral** deixa de ser um alerta e vira condição normal de operação: no sistema
  de referência, 40% da base já estava sem documento. No varejo isso será a maioria.
- **Mesclagem de contatos** (CTT-11) sobe de prioridade: sem documento, duplicata é inevitável.
- ⚠️ Isto se soma ao BSUID (`meta-plataforma.md` §6): o telefone pode nem vir. Contato **sem
  telefone e sem documento** deixa de ser hipótese remota.

### O que perde peso

**O pedido assistido (PED-01…16) deixa de ser o coração.** No varejo a venda acontece no balcão,
pelo PDV — não na conversa. Ele continua útil para encomenda, reserva e venda por WhatsApp, que
existem no varejo, mas não é mais o que define o produto.

⚠️ **A atribuição exata de receita depende dele** (ADR-013). Com o pedido nascendo no PDV, a
atribuição volta a ser majoritariamente **estimada por janela** — e isso precisa ser dito com todas
as letras, em vez de prometer precisão que o fluxo não sustenta.

### O que ganha peso

**Recompra, RFV e campanha segmentada.** É exatamente o território de Dito e Mercafácil
(`concorrentes-tailor.md` anel 2) — que analisamos como adjacentes e agora são concorrentes
diretos. ⚠️ Vale reler aquele anel com outros olhos: eles têm CDP, predição de churn e programa de
fidelidade, três coisas que descartamos por serem "de varejo".

### Crédito e prazo: fora, definitivamente
O GeraCloud já tem gestão de títulos. **Não replicamos.** `creditoCliente` fica `false` e o assunto
sai do escopo — não é lacuna a preencher depois.

**Consequências**: `escopo-funcional`, `backlog-epicos` e `concorrentes-tailor` foram escritos sob a
premissa anterior e precisam de revisão de peso — não de reescrita. O modelo de dados não muda: ele
já era genérico por ADR-004, e é isso que torna esta virada barata.

## ADR-020 — Fidelidade e cashback: o saldo é do ERP, a alavanca é nossa
**Contexto**: com o varejo como caso principal (ADR-019), fidelidade deixa de ser "coisa de PDV
fora do escopo" e vira **paridade competitiva** — é o que Dito, Mercafácil e Zoppy oferecem, e eles
passaram de adjacentes a concorrentes diretos.

**A descoberta que define o desenho**: o **pdv-core já tem cashback completo**.

```
CartaoCashback                 por cliente, com numeração e habilitação
MovimentacaoCartaoCashback     ⚠️ com dataExpiracao e vínculo à Venda
ConfiguracaoCartaoCashback     percentual base · limite de resgate · validade, POR LOJA
```

**Decisão**: **não construímos motor de cashback.** O saldo, o acúmulo, o resgate e a expiração
ficam no ERP. O GeraCRM **lê o saldo e o transforma em alavanca de recompra**.

### Por que esta é a divisão certa, e não preguiça

⚠️ **O resgate acontece no caixa.** Quem debita o saldo é o PDV, no momento da venda. Se o saldo
vivesse no CRM, toda venda no balcão dependeria de uma chamada ao nosso sistema — e uma
indisponibilidade nossa viraria fila parada na loja.

Cashback é **dinheiro do cliente**. Duas fontes de verdade para dinheiro é a pior arquitetura
possível: qualquer divergência vira discussão no balcão, com o cliente presente.

### O que o GeraCRM faz com isso

| Capacidade | Exemplo |
|---|---|
| **Saldo na ficha e na conversa** | A vendedora vê "R$ 47 disponíveis" antes de falar |
| **⚠️ Campanha por expiração** | "Seu cashback de R$ 47 vence em 5 dias" — o campo `dataExpiracao` existe e ninguém usa para isso |
| **Segmento cruzado com RFV** | Cliente `Em Risco` **com saldo** é o alvo mais barato que existe: o incentivo já está pago |
| **Atribuição** | Quanto da receita veio de campanha que citou saldo |
| **Gatilho de reativação** | Saldo prestes a expirar entra na Fila do Dia |

⚠️ **A campanha por expiração é o diferencial e é quase de graça.** O ERP já calcula a validade;
falta alguém avisar o cliente antes de o dinheiro dele evaporar. Nenhum dos concorrentes analisados
faz isso a partir do saldo real do ERP.

### Capacidade de conector

Entra `fidelidade` na declaração (ADR-008): sem ela, os blocos de saldo **não aparecem** e a
segmentação por saldo some — o produto degrada, não quebra.

**Consequências**: `FID` entra no escopo como módulo de **leitura e ativação**, não de gestão.
Nenhuma tabela de saldo no nosso banco — apenas projeção para segmentar, com o horário da última
sincronização visível. ⚠️ Saldo em cache exibido como se fosse ao vivo é reclamação no balcão.

## ADR-011 — Convenções
Domínio em português (`Conversa`, `Pedido`, `Campanha`), infraestrutura em inglês, comentários em
inglês · sem `enum` do TypeScript (união de literais + `z.enum`) · sem status numérico mágico ·
erros de domínio tipados por contexto, nunca controle de fluxo por `string.includes()` · blobs em
object storage com ponteiro no banco · segredos cifrados em repouso · **toda lista paginada
server-side**, sem exceção.

---

## ADR-021 — Canal dual: oficial (Meta) prioritário, não-oficial (PlugZapi) como opção

**Contexto.** O ADR-002 escolheu o WhatsApp Cloud API oficial (Meta) e vetou API não-oficial nas
Ondas 0–2. O registro na Meta está no caminho crítico e trava a operação. O mercado — Tailor e
concorrentes — opera com **os dois caminhos**: oficial como prioridade, não-oficial (Z-API/PlugZapi)
como alternativa. O GeraCloud já integra PlugZapi em produção.

**Decisão.** O produto suporta **dois tipos de canal WhatsApp**, lado a lado, e o cliente escolhe por
qual número caminha — inclusive com números oficiais E não-oficiais integrados ao mesmo tempo:

- **Oficial (Meta Cloud API)** — prioridade. Sem risco de banimento, janela de 24h + template, tier.
- **Não-oficial (PlugZapi/Z-API)** — opção. Automatiza um WhatsApp Web (`instance`+`token`).
  ⚠️ **Carrega risco de banimento do número** — é decisão de negócio do cliente, não nossa.

**Como isso respeita a arquitetura.** A raiz `canal_conectado` já é genérica (ADR/§1.2, migration
0011). PlugZapi entra como **mais um adaptador de canal** por trás de uma porta que o NOSSO domínio
define (mesma filosofia dos conectores de ERP, ADR-008): capacidades declaradas, degradação visível.
A janela de 24h e o template são capacidades do canal oficial; o não-oficial declara as suas (sem
janela, sem template — envia texto livre, com o alerta de risco).

**Consequências.**
- Cada canal declara `tipo` (`whatsapp_oficial` | `whatsapp_nao_oficial` | `instagram`) e capacidades.
- ⚠️ **Alertas separados por caminho**: a interface deixa claro qual número é oficial e qual é
  não-oficial, e o risco do não-oficial é visível — nunca silencioso.
- O gateway de saída escolhe o adaptador pelo canal; o resto do produto (RFV, pedido, campanha) não
  sabe por qual caminho a mensagem foi.
- **Revisa o ADR-002**, não o anula: o oficial continua sendo a prioridade e o padrão recomendado.

**Aprendizado reaproveitável.** Implementar PlugZapi agora destrava o Inbox com dado real e ensina o
fluxo de envio/recebimento; quando a Meta liberar, o oficial é só outro adaptador na mesma porta.

## ADR-022 — Lint: oxlint, porque o typescript-eslint recusa TypeScript 7

**Contexto.** O `pnpm lint` deste monorepo era literalmente `echo 'eslint pendente'` em quatro dos
cinco pacotes (`apps/api`, `apps/console`, `packages/shared`, `packages/conectores`). O CLAUDE.md
exige `pnpm lint typecheck test` verdes antes de commitar em `main` — ou seja, **um terço do portão
obrigatório não verificava nada**, e passava por verde há meses.

A tentativa óbvia falhou de forma dura, não ambígua:

```
Error: typescript-eslint does not support TS 7.0.
```

Não é aviso de peer dependency: é um `throw` proposital do pacote. O `typescript-eslint` analisa
código pela API do compilador TypeScript, e o TS 7 é a reescrita em Go, com outra API. O projeto
está em TypeScript 7.0.2.

**Decisão.** Usar **oxlint** (parser oxc, em Rust) como linter do monorepo.

⚠️ A alternativa seria **rebaixar o TypeScript do projeto inteiro** para caber na faixa que o
`typescript-eslint` aceita (`<6.1.0`). Isso inverte a hierarquia: a ferramenta de checagem passaria
a ditar a versão da linguagem em que o produto é escrito. O oxlint tem parser próprio e é indiferente
à versão de TypeScript instalada — a dependência que causou o problema deixa de existir.

**Escopo das regras: `correctness` apenas, e isso é deliberado.**

| Categoria | Achados hoje | Decisão |
|---|---|---|
| `correctness` | 0 (depois de 19 correções) | **ligada, como erro** |
| `suspicious` | 37 | fora — inclui regras de **Next.js** (`no-async-endpoint-handlers`, `next`) que não se aplicam a Fastify |
| `perf` | 332 | fora — ruído |
| `pedantic` | 924 | fora — ruído |

Lint com mil avisos é lido como zero avisos. A régua começa baixa e **verde**, e sobe por decisão
explícita — nunca por categoria inteira sem olhar o que ela traz.

**Consequências.**
- `pnpm lint` agora **reprova de verdade** (`exit 1`) — conferido injetando um `no-dupe-keys`.
- 19 achados corrigidos na adoção, três deles reais: um `try { } catch (e) { throw e }` que fingia
  tratar erro, um `init?.headers` que lançaria `TypeError` em vez de falhar limpo no teste, e um
  ternário usado como comando.
- ⚠️ **Os lints caseiros continuam sendo testes**, não regras de oxlint: `cor-literal.spec.ts`,
  `crase-em-template.spec.ts` e `crase-em-sql.test.ts` verificam invariantes do NOSSO domínio (cor
  literal fora dos tokens, crase dentro de template literal) que nenhum linter genérico conhece.
  Rodam em `pnpm test` e são complementares, não substituíveis.
- Se um dia o `typescript-eslint` suportar TS 7, reabrir a discussão é opcional — não obrigatório.

## ADR-023 — O agente é VENDEDOR: laço de ferramentas sob RLS, agente único, três modos

**Data:** 2026-10-02. **Substitui** a premissa de `agente-sdr-escopo.md` §1 ("o agente NÃO é vendedor").

**Contexto.** O SDR de uma chamada só (prompt + envelope JSON) não lê catálogo, preço nem pedido,
roda síncrono dentro do webhook e não entrega handoff real. O mercado de 2026 (Meta Business Agent,
Zenvia, Kommo, Weni) vende com catálogo e fecha no chat. O que ninguém faz é vender com **tabela de
preço e crédito por cliente** — o que o GeraCRM já tem pelo ERP (ADR-005/019).

**Decisão.**
1. O agente passa a **vender**: entende a demanda, recomenda do catálogo do tenant, monta o rascunho
   no servidor, propõe e, confirmado pelo cliente e dentro da alçada, o **domínio** efetiva.
2. O turno é um **laço de ferramentas** (`@anthropic-ai/sdk`, `tool_choice: auto`, `strict: true`,
   saída estruturada) com ferramentas que rodam **sob RLS** no nosso Postgres: catálogo, preço/estoque,
   cliente, conhecimento, pedido, transferência, memória. Preço, estoque, prazo e desconto só existem
   na resposta se vieram de ferramenta **neste turno** — verificado em código.
3. **Agente único** com seções de prompt e ferramentas. Multiagente no turno multiplica latência e
   quebra o contexto da venda; o que roda fora do turno (resumo, memória, juiz) é workflow, não agente.
4. **Três modos por canal**: `sombra` (decide e grava, não envia), `assistido` (sugere; o vendedor
   aprova), `autonomo` (envia). Todo canal nasce em sombra. `desligado` continua existindo e tem
   efeito na próxima mensagem.
5. Modelo padrão `claude-opus-5-5` com `effort: low` no turno de chat; `IA_MODELO` troca sem deploy;
   OpenRouter é reserva de **disponibilidade**, nunca de custo (o prefixo de cache não migra).

**Consequências.** Nova tabela `agente_decisao` por turno (auditoria), `agente_config.modo/persona/
alcada`, ferramentas registradas por capacidade do canal e do conector. O prompt perde toda regra de
negócio (continua a regra da skill `geracrm-ia`). A fatia "não fala preço" do SDR deixa de existir:
preço vem de `preco-de-venda.ts`, pelo perfil do contato.

## ADR-024 — Fila do agente em Postgres, com debounce e serialização por conversa

**Contexto.** O turno rodava dentro do webhook (até 90 s antes do 200) e duas mensagens rápidas
geravam dois turnos em paralelo. Avaliados `graphile-worker` e `pg-boss` (ambos bons; ambos trazem
schema próprio fora do nosso runner de migrations) e LISTEN/NOTIFY puro (notificação sem ouvinte
some — já documentado em `0019_outbox.sql`).

**Decisão.** Tabela própria `agente_tarefa` (uma pendente por conversa, `executar_em` reagendado a
cada mensagem nova — debounce de 3 s), agendada **na mesma transação** da ingestão. Worker no padrão
que o `server.ts` já usa (dono, advisory lock, intervalo curto) acordado também pelo NOTIFY do outbox.
`FOR UPDATE SKIP LOCKED` garante um turno por conversa por vez. Antes de enviar, o worker confere se
chegou mensagem nova; se chegou, descarta o rascunho e reagenda.

**Consequências.** Webhook volta a ser "grava + agenda + 200". Coerente com ADR-007 (sem broker) e
ADR-006 (migration à mão). Se um dia a fila precisar de prioridades e DLQ ricos, trocar por pg-boss
é trocar o adaptador da fila, não o agente.

## ADR-025 — Catálogo com origem múltipla (ERP e manual); preço resolvido sempre no servidor

**Contexto.** O catálogo só existia por sincronismo de ERP; a Gera3 precisa vender os próprios planos
SaaS e o produto precisa servir a loja de roupas sem ERP. `POST /pedidos/:id/itens` aceitava o preço
no corpo e o contato não guardava perfil de preço.

**Decisão.** `produto/sku/tabela_preco/sku_preco/sku_saldo` aceitam `sistema = 'manual'` e `origem`
por registro; o integrador **não sobrescreve** o que é manual (ADR-008, origem por campo). Nasce o
contexto `catalogo` com CRUD sob RLS e indexação. `contato.perfil_preco` passa a existir; adicionar
item **resolve o preço no servidor** por `preco-de-venda.ts` — o corpo da requisição leva `skuId` e
`quantidade`, nunca preço. Regras de `perfil_vertical.regras_pedido` passam a ser validadas.

**Consequências.** Uma tela de catálogo com escrita; seed de demonstração (planos SaaS + roupas);
o agente e a tela de pedido passam pelo mesmo resolvedor de preço.

## ADR-026 — Retrieval híbrido em Postgres; semântica como capacidade opcional

**Decisão.** `produto_indice` e `conhecimento_trecho` com `tsvector` (`portuguese` + `unaccent`),
`pg_trgm` e fusão por RRF — fase 1, sem dependência nova. `pgvector` (HNSW, cosseno, `voyage-4`
1024 dims atrás de `PortaEmbedding`) entra como fase 2, **somente se a extensão existir** no
ambiente; a migration cria a coluna/índice dentro de um bloco guardado e o produto declara a
capacidade `buscaSemantica` — degradação visível, nunca quebra.

**Consequências.** Nenhum serviço externo de busca; tudo sob RLS; o custo de embedding é
desprezível (≈ US$0,09 por 10 mil produtos). Reranker só se a medição pedir.

**Adendo 2026-10-04.** Dois adaptadores atrás de `PortaEmbedding`: **Cloudflare Workers AI**
(`@cf/baai/bge-m3`, 1024 dims, serverless gerenciado — modelo sempre quente, cobrado por token,
cota diária gratuita) é o padrão quando `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN` existem;
Voyage (`voyage-4`) é a alternativa; `EMBEDDING_PROVEDOR` força. Trocar de provedor muda
`porta.nome` e invalida todos os vetores (o worker `embutir-pendentes` refaz; a busca só compara
vetores do mesmo `modelo_embedding`). O vetor da **pergunta** passa por cache global
(`embedding_consulta_cache`, 0095: hash do texto normalizado + modelo, sem texto, sem tenant) e
tem tempo limite curto (2 s) — estourou, a busca segue lexical naquele turno. Descartado: nó
próprio que dorme (cold start de 10 s no caminho da pergunta) e híbrido de dois fornecedores
(vetores não comparáveis).

## ADR-027 — Propor-e-confirmar com alçada: o modelo propõe, o domínio efetiva

**Contexto.** Incidente de 27/08: um "sim" confirmou o pedido errado. O fluxo `enviar-resumo →
aguardando_confirmacao → sim → confirmado → efetivar` já existe e é conservador; o agente precisa
reusá-lo, não contorná-lo.

**Decisão.** A ferramenta `pedido_propor` grava `pedido_proposta` (versão do conteúdo, resumo,
expiração) e envia o resumo pelo gateway (botões no oficial, texto no não-oficial). O "sim" é
interpretado pelo domínio e só confirma a proposta **cuja versão ainda é a atual**. Efetivar obedece
à alçada do canal (`valor_max_autonomo`, `desconto_max = 0`, `efetiva_sozinho`): dentro, o conector
efetiva (ou degrada visível, ADR-008); fora, nasce um atendimento na fila com resumo e motivo.
`pedido_efetivar` **não é ferramenta do modelo**.

**Consequências.** Rascunho nunca se perde (ADR-005). Desconto exige humano até existir política
declarada por tenant. Toda proposta e confirmação é auditável por `agente_decisao` + `pedido_proposta`.

## ADR-028 — Vocabulário de modo: "assistido" sugere; recorte; o mais restritivo vence

**Data:** 2026-10-17. **Complementa** o ADR-023 (três modos por canal). Origem: port dos padrões do
agente da AM Consórcio (`docs/plano-port-playbook-am.md`, raias P1 e P14).

**Contexto.** O playbook da AM (§4.1) usa os mesmos quatro nomes de modo que o GeraCRM, mas um deles
com outro significado: lá, `assistido` é **o bot responde sozinho dentro de um recorte** (etapas ×
unidades × horário); aqui, desde o ADR-023, `assistido` é **o bot sugere e o vendedor aprova**. O
próprio playbook aponta o risco (§4.1, nota; §13.7): portar código antes de alinhar o vocabulário
produz uma tela que diz uma coisa e um portão que faz outra. Além disso, a AM resolve "quem manda"
entre níveis com uma regra simples e testável — **o mais restritivo vence** (§4.2) — que o nosso
`portao.ts` só aplica ao `ativo`, não ao modo.

**Decisão.**
1. **O vocabulário do GeraCRM não muda.** `desligado` (grava, não fala, transfere), `sombra` (decide e
   grava, não envia), `assistido` (**sugere**; o vendedor envia, edita ou descarta), `autonomo` (envia).
2. **O "assistido" da AM equivale ao nosso `autonomo` com recorte.** Ao ler o playbook, traduzir
   sempre: "assistido na praça X das 8h às 18h" = `autonomo` restrito por recorte. Nenhum documento,
   tela ou código do GeraCRM usa `assistido` no sentido da AM.
3. **Recorte** é configuração do número (`agente_config.recorte`: horário, segmentos de RFV e o que
   fazer fora dele). Fora do recorte o modo efetivo cai para o configurado em `foraDoRecorte`
   (padrão `sombra`) — nunca sobe.
4. **O mais restritivo vence** entre três níveis — tenant (`agente_tenant.modo_maximo`), número
   (`agente_config.modo`) e recorte — na ordem `desligado < sombra < assistido < autonomo`. O nível de
   baixo **restringe, nunca afrouxa** o de cima. A decisão é uma função pura (`decidirModoEfetivo`),
   testada sem I/O, e o modo efetivo de cada turno fica gravado em `agente_decisao`.
5. Mudança para `autonomo` ou `desligado` exige **confirmação digitada** (o nome do modo, aceito sem
   acento e sem caixa) e papel de admin; todo PUT de configuração do agente grava auditoria com
   `{antes, depois}`.

**Consequências.** O kill switch continua sendo `desligado` — nunca "parar o worker", porque o registro
da mensagem não pode depender do agente (AM §4.3). A tela mostra o modo **efetivo** e de onde veio a
restrição (tenant, número ou recorte). `identificaComoRobo` deixa de ser opção visível: identificar-se
como assistente é regra, não preferência (ADR-029).

## ADR-029 — Pipeline determinístico antes e depois do LLM; a tela só acrescenta restrição

**Data:** 2026-10-17.

**Contexto.** Boa parte da conduta do agente está **só no prompt** (`instrucao-vendedor.ts`): opt-out,
pedido de humano, reclamação, "é robô?", não repetir pergunta. O guardrail numérico
(`verificarNumerosNaResposta`) é a única regra garantida em código, e só cobre R$. A AM aprendeu com
incidentes reais que o prompt orienta mas não garante (§3.2: "o prompt existe para o modelo errar
menos, não para ser a última linha de defesa"): o filtro sem noção de negação cortava "não damos
garantia" (§12 #11); o modelo repetia a pergunta que o cliente já tinha respondido de outro jeito
(§3.8, §12 #3); completava a mensagem de handoff prometendo prazo (§12 #5); e, sem gatilho
determinístico, cada "pare" custava uma chamada de LLM. E fixou um princípio (§12): **o que o negócio
muda vira configuração versionada; o que protege fica no código.**

**Decisão.**
1. O turno do agente vira um **pipeline de ordem fixa**, com etapas determinísticas em volta do LLM:
   `modo efetivo → portão → gatilhos de entrada → slots do cliente → teto (pré) → LLM → guardrail R$ →
   números ampliados → filtro de saída → pergunta repetida → regras de qualidade → envio → teto (pós)`.
   Cada etapa registra o que fez como marca em `agente_decisao.guardrails` (etapa, código, gravidade,
   ação, trecho mascarado).
2. **Antes do LLM, sem gastar token** (regra pura sobre o texto do cliente): opt-out (com confirmação
   e cancelamento de retornos; "cancelar pedido" **não** é opt-out), pedido de humano,
   reclamação/Procon/jurídico, "é robô?" (1ª vez resposta fixa honesta, 2ª handoff), áudio sem
   transcrição (1º pede texto, 2º handoff), abertura fixa que identifica a assistente na 1ª resposta.
3. **Depois do LLM, antes do envio**:
   - **números** — além de R$, percentual, quantidade e prazo só saem com fonte no turno (ferramenta,
     política, conhecimento ou o próprio cliente); % sem fonte bloqueia (amplia o ADR-023);
   - **filtro de frases com negação** — lista base B2B (negar ser IA; garantir entrega, prazo, estoque,
     preço ou crédito; "melhor preço do mercado"; oferecer desconto; urgência falsa; pedir consentimento
     para atender; hesitações) com a regra de negação da AM: mesma oração, até 2 palavras antes, sem
     conectivo no meio, "sem" colado ao termo, dupla negação conta como afirmação. O teste que impede o
     filtro de virar censura vai junto: ≥ 30 respostas aprovadas saem **inalteradas**;
   - **pergunta repetida** — Jaccard ≥ 0,7 contra as perguntas do turno anterior, com extração
     determinística do que o cliente já respondeu; a repetida sai e entra a próxima pendente (ou uma
     neutra), registrada como violação MEDIA corrigida. A última pergunta fica em
     `agente_sessao.estado_agente` e sobrevive a restart;
   - **qualidade** — regras em 100% das mensagens (ADR-031).
4. O pipeline vale **igual** em autônomo, assistido (a sugestão chega filtrada e com avisos), sombra,
   simulação e copiloto.
5. **Regra de fronteira**: o que o negócio muda (tom, roteiro, mensagens prontas, frases proibidas
   **extras**, gatilhos de handoff **extras**, recorte, limites) é **configuração versionada** por
   tenant/número, com auditoria. O que protege (filtro base, número só com fonte, opt-out, handoff
   obrigatório, identificação como assistente, `pedido_efetivar` fora do modelo) fica **no código** e
   **não tem chave de desligar**. **A tela só acrescenta restrição** — nunca afrouxa.

**Consequências.** `vendedor.ts` deixa de crescer: cada regra mora numa etapa própria com teste isolado
(P0 cria a costura; P2–P7 e P12 preenchem). O prompt continua dizendo as mesmas coisas, mas cada regra
crítica dele passa a ter contrapartida em código. Os casos mais frequentes que não precisam de modelo
custam zero. O compliance não depende de alguém lembrar de marcar uma caixa.

## ADR-030 — Resiliência de provedor: classificar a falha, reserva com janela, nunca em silêncio

**Data:** 2026-10-17. **Complementa** o ADR-023 (OpenRouter como reserva de disponibilidade).

**Contexto.** Hoje qualquer falha do LLM vira `handoffSemModelo` imediato e **mudo**: o cliente não
recebe aviso, e a falha não muda o comportamento dos turnos seguintes (cada turno tenta o principal de
novo). Um 403 de um modelo sem acesso vira `credencial_invalida`, como se a chave inteira estivesse
errada. A AM viveu as duas pontas: "LLM fora em silêncio" (§12 #8 — o cliente recebia "já te
respondo" e ninguém era avisado) e "Haiku bloqueado no Bedrock" (§12 #9 — 403 num modelo só, com o
resto funcionando). A solução de lá (§8.3, §8.6) é classificar o erro, trocar de provedor por uma
janela e transformar a falha em handoff **com aviso**.

**Decisão.**
1. **Classificação** de toda falha da porta LLM: `fatal` (401/402, cota, créditos, chave inválida),
   `transitoria` (408/429/5xx/529, rede, tempo esgotado), `requisicao` (erro nosso — não conta para a
   reserva) e `formato` (saída inválida). `acesso_negado` (403 num modelo específico) é classe própria.
2. **Reserva com janela**: 2 falhas de provedor seguidas **no processo** ligam a reserva
   (`IA_RESERVA_PROVEDOR` / `IA_RESERVA_MODELO`) por `IA_RESERVA_JANELA_MIN` (30), com alerta
   `llm_reserva_ativo`; vencida a janela, volta sozinho. Se o turno **já executou ferramentas**, a
   chamada que falhou **não é repetida** na reserva (efeito colateral duplicado é pior que um handoff);
   sem ferramentas executadas, refaz já na reserva. Estado em memória: restart volta ao principal.
3. **403 por modelo**: bloqueia **aquele modelo** por 1 h e usa `IA_MODELO`, com alerta
   `modelo_bloqueado` — não marca a credencial como inválida.
4. **Política no turno, em autônomo**: fatal → handoff na hora com aviso ao cliente (sem prometer
   prazo); transitória na 1ª vez → "tive uma instabilidade" e reagenda o turno em 30 s (uma vez só);
   2ª seguida → handoff `modelo_indisponivel` com aviso; formato → handoff. Em sombra e assistido, só
   registra. O resumo do handoff sem modelo é **determinístico** (do estado da sessão).
5. **Falha nunca em silêncio**: todo caminho gera alerta (`agente_llm_indisponivel`) e, em autônomo, o
   cliente sempre recebe uma mensagem. Reserva ativa deixa a saúde em `degradado`.

**Consequências.** `agente_decisao.falha_tipo` permite medir por classe. A reserva é de
**disponibilidade**, não de custo: o prefixo de cache não migra entre provedores (ADR-023), e o turno
na reserva custa mais. Pré-requisito operacional: as duas credenciais cadastradas em produção, mesmo
usando uma só.

## ADR-031 — Qualidade em produção: regras em 100%, juiz amostrado, pausa em CRÍTICA, revisão humana

**Data:** 2026-10-17.

**Contexto.** O juiz com rubrica existe só nos evals (`evals/juiz.ts`, sob `IA_E2E=1`). Em produção não
há medida de qualidade além do guardrail numérico e da leitura manual de `agente_decisao`. Na AM (§7)
a qualidade é contínua: regras determinísticas em toda mensagem, avaliador LLM numa amostra, pausa da
conversa em violação crítica e revisão humana semanal que dá credibilidade ao avaliador. O risco que o
playbook nomeia para multi-tenant (§13.7) é o juiz caro.

**Decisão.**
1. **Regras em 100%** das mensagens do agente e das sugestões (palavra proibida que escapou do filtro,
   promessa de prazo, número sem fonte, pergunta repetida, múltiplas perguntas, mensagem longa), com
   gravidade `CRITICA | ALTA | MEDIA | INFO`. Custo zero; rodam no pipeline (ADR-029).
2. **Juiz com rubrica, amostrado**: 5 critérios, nota inteira 0–5 + justificativa ≤ 280 caracteres;
   roda **fora do caminho da resposta** (fim de sessão e a cada 10 turnos). A amostra é **estável por
   hash** (FNV-1a do id da conversa → [0,1)) contra `agente_config.qualidade_amostra`: a mesma conversa
   sempre cai, ou nunca cai, e as avaliações dela são comparáveis. Teto mensal próprio do avaliador por
   número. Padrões: 1,0 em homologação e sombra, 0,2 no assistido, 0,05 em autônomo amplo.
3. **Pausa em CRÍTICA**: violação crítica detectada antes do envio → a mensagem **não sai**; em
   autônomo a conversa vai ao humano (`qualidade_violacao_critica`); em assistido a sugestão chega
   marcada "não envie assim"; sempre com alerta. A pausa é **por conversa** — pausar um modo inteiro
   continua sendo decisão humana apoiada pelos dados.
4. Resultado em `agente_avaliacao` (RLS, `origem` agente/sugestão, idempotente por decisão e tipo) e
   tela de qualidade por tenant, com exportação mascarada da amostra semanal.
5. **Revisão humana com concordância**: amostra semanal de 20 conversas por número, na ordem todas as
   CRÍTICA → ALTA e nota ≤ 3 → aleatórias; o revisor dá nota por critério e gravidade. Concorda quando
   |LLM − humano| ≤ 1 em cada critério e a classe de gravidade é a mesma. **Concordância ≥ 85%** (com
   ≥ 20 revisadas) é condição para avançar de fase; sem ela, a nota do juiz não vale como critério.

**Consequências.** "0 CRÍTICA" passa a ser medido também na sombra (pelas sugestões). A revisão humana
precisa de dono no cliente — sem ele não há concordância; vira parte do onboarding.

**Critérios de fase B2B — ⚠️ PROPOSTA** (números da AM, §11.5, adaptados ao funil de recompra; a
validar com o primeiro cliente antes de virarem regra; painel na raia P19):

| Fase | Duração / volume mínimo | Para avançar (proposta) |
|---|---|---|
| Homologação | — | 25 conversas douradas com 0 CRÍTICA; smoke do provedor ok; ≥ 30 conversas no playground com 0 CRÍTICA |
| Sombra | ≥ 10 dias úteis, ≥ 150 turnos e ≥ 50 conversas | similaridade sombra × humano ≥ 0,6 em ≥ 60% dos turnos; 0 CRÍTICA; nota média ≥ 4; concordância ≥ 85% (≥ 20 revisadas); ≤ R$ 1,50 por conversa; números bloqueados ≤ 2% |
| Assistido | ≥ 10 dias úteis, ≥ 100 sugestões | uso ≥ 40%; enviadas sem edição ≥ 70% (com ≥ 50 enviadas); 0 CRÍTICA |
| Autônomo num recorte | 21 dias | 0 CRÍTICA em 14 dias; p95 da 1ª resposta ≤ 6 s; handoff entre 10% e 40%; opt-out ≤ 1%; conversão não-inferior à coorte sem agente (−2 p.p.); 0 pedido confirmado errado |
| Autônomo amplo | permanente | revisão a cada 30 dias; critério violado → volta uma fase |

## ADR-032 — Custo pelo catálogo `modelo_ia`, teto por sessão e alerta mensal por tenant

**Data:** 2026-10-17.

**Contexto.** O custo do turno é estimado por `custoEstimadoCentavos` (`porta-llm.ts`) com uma tabela
fixa de três modelos Claude; **qualquer id desconhecido cai no preço do Opus** — Groq e Gemini
gratuitos, OpenRouter e Maritaca aparecem caros, e o teto dispara por engano. A AM teve o mesmo bug
com ids de inference profile do Bedrock (§12 #10) e resolveu normalizando o id antes de procurar o
preço (§8.1). Já existe o catálogo `modelo_ia` (0093) com preço de entrada e saída por modelo, mas sem
preço de cache e fora do cálculo.

⚠️ **Correção de premissa.** O plano-mestre (§3.7 item 6 e §7, "Custo") e o playbook da AM (§13.1)
afirmam que o GeraCRM tem "teto diário de custo **por tenant**". O código diz outra coisa: `custoDoDia`
(`vendedor.ts`) soma `agente_decisao` **por `canal_id`**, e o teto (`orcamento_dia_centavos`) é do
`agente_config` do número. **O teto diário é por número**, com o dia virando à meia-noite no fuso do
tenant. Hoje não existe limite nem alerta no nível do tenant, nem por sessão.

**Decisão.**
1. **Preço vem do catálogo `modelo_ia`**, com cache de 10 min no processo, depois de
   `normalizarIdModelo` (tira prefixo de provedor, sufixo de versão/data e variações de perfil). O
   catálogo ganha preço de leitura e de escrita de cache. Modelo `gratuito` custa 0. Id desconhecido →
   **maior preço do catálogo** + alerta `preco_desconhecido` (errar para cima é seguro; errar em
   silêncio, não).
2. **Teto por sessão** (`agente_config.teto_sessao_centavos`, padrão `IA_TETO_SESSAO_CENTAVOS`): pega
   loop e conversa patológica. Antes do LLM, sessão no teto → em autônomo, handoff
   `limite_de_custo_conversa` com aviso; em sombra/assistido, silêncio. O turno que passa do teto
   responde e transfere em silêncio. O acumulado fica na sessão (sobrevive a restart).
3. **Teto diário continua por número**, como está.
4. **Orçamento mensal por tenant** (`agente_orcamento`): **só alerta**, a 80% e a 100%, uma vez por mês
   cada — não corta. Quem corta é o teto do número e o da sessão.

**Consequências.** Custo correto para modelos gratuitos e de terceiros; o painel de custo e o critério
de fase "≤ R$ 1,50 por conversa" (ADR-031) passam a ser confiáveis. A frase "teto diário por tenant"
no plano-mestre e nas skills é corrigida para "por número" pela raia de documentação (P20).

## ADR-033 — Playbook versionado × conhecimento × `agente_config`: o que mora onde

**Data:** 2026-10-17.

**Contexto.** Três lugares guardam "como o agente se comporta" e a fronteira entre eles não estava
escrita: `agente_config` (por número: modo, alçada, persona, regras do portão, tetos),
`conhecimento_documento` (base de conhecimento com busca híbrida, ADR-026) e — a partir de P17 — um
**playbook comercial versionado**. A AM tirou o conteúdo comercial de arquivos para versões imutáveis
com rascunho, sandbox, publicação com observação e restauração (§3.13), e fixou que a tela nunca
desliga guardrail.

**Decisão.**

| Onde | O que mora | Ciclo de vida | Como o agente usa |
|---|---|---|---|
| `agente_config` (por número) | **operação e segurança configurável**: modo, recorte, alçada, tetos (dia, sessão), regras do portão, amostra de qualidade, frases e gatilhos **extras** de compliance, limites de ativas | edição direta, auditada com `{antes, depois}`; troca de modo com confirmação digitada | lido a cada turno; restringe o pipeline |
| Playbook (`agente_playbook_versao`, por tenant/número) | **como vender**: estilo (tratamento, emoji, máximos de caracteres e de perguntas — aplicados no filtro), persona, roteiro de qualificação, mensagens prontas, compliance extra, ações habilitáveis | um rascunho → sandbox seco → publicação com observação (≥ 10 caracteres, admin) → versão **imutável** + auditoria; diff por seção; restaurar cria versão nova | entra no bloco estável do prompt e nas etapas do pipeline |
| Conhecimento (`conhecimento_documento` + histórico imutável, P9) | **fatos consultáveis**: políticas, prazos de entrega, condições, FAQ, descrição de catálogo | edição com histórico por versão | **nunca inteiro no prompt**; buscado por ferramenta e citado como fonte (pode ser fonte de número) |

Regras de fronteira:
1. **Fato** (o que pode virar número ou promessa) vai para o conhecimento, onde é fonte citável.
   **Conduta** (como falar, o que perguntar) vai para o playbook. **Parâmetro operacional** vai para
   `agente_config`.
2. Ferramentas de segurança e registro (transferir, opt-out, propor pedido, memória) **não aparecem**
   como ação habilitável — ficam sempre ligadas. `pedido_efetivar` continua fora do modelo (ADR-027).
3. Compliance do playbook e do `agente_config` **só acrescenta** à lista base do código (ADR-029).
4. "Atualizar a partir de documento" gera **só rascunho**, com resumo das mudanças; nada é publicado
   sem revisão humana no diff.
5. O sandbox é o playground existente em modo seco: ferramentas de escrita viram registradores e a
   memória não grava em simulação; mostra resposta, ações, guardrails acionados e custo.

**Consequências.** A primeira versão do playbook é importada, de forma idempotente, do que hoje está em
`agente_config.persona` e nas instruções. Uma decisão do agente passa a poder citar exatamente qual
versão do playbook e de cada documento de conhecimento estava em vigor.

## ADR-034 — SLA do handoff como fatia mínima de INB-22, já

**Data:** 2026-10-17. **Antecipa** parte de INB-22 (`escopo-funcional-geracrm.md`, Onda 4).

**Contexto.** O agente passa a transferir para humano por vários motivos novos (ADR-029 a 032), e todo
handoff termina num atendimento na fila sem prazo nem cobrança. O SLA de primeira resposta e de
resolução com escalonamento (INB-22) está planejado para a Onda 4. Na AM (§6.5) é o SLA do handoff que
impede que "transferir para humano" vire "abandonar o cliente": minutos **úteis**, aviso ao gestor,
reatribuição liberada e **uma** mensagem de espera ao cliente. Sem isso, o critério de fase "handoff
entre 10% e 40%" (ADR-031) mede quantos clientes foram transferidos, não quantos foram atendidos.

**Decisão padrão: fazer agora (raia P18), na fatia mínima.** Revertível pelo dono do produto antes da
onda 3 do plano de port; se revertida, P18 sai do plano e INB-22 segue inteiro na Onda 4.

Fatia mínima:
1. `atendimento_sla_config` por tenant (RLS): minutos até o SLA e até liberar a reatribuição.
2. Minutos **úteis** pelo expediente do número (`somarMinutosUteis`, `proximaAbertura`) e roteamento
   (`rotearHandoff`) como **funções puras**, testadas sem banco.
3. Worker: no SLA notifica o gestor; no 2º limiar libera a reatribuição; e manda **uma** mensagem de
   espera fixa ao cliente (sem prometer prazo), só se nenhum humano respondeu e a conversa segue com
   humano.
4. Cronômetro visível no inbox e no kanban de atendimento.

**Fica para INB-22 completo (Onda 4):** SLA de resolução, níveis de escalonamento, metas por fila,
relatórios de SLA e a métrica MO-19.

**Consequências.** O handoff passa a ter medida de resultado. A migration é aditiva (tabela nova e
colunas novas em `atendimento`) e não muda o fluxo atual de transferência.
