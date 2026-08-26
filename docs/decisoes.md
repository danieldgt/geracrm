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
