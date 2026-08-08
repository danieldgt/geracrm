# GeraCRM — Stack e arquitetura de módulos

> Etapa 7 da trilha. Cada escolha aqui aponta para uma exigência de
> [`especificacao-telas.md`](./especificacao-telas.md) §8, [`escopo-funcional-geracrm.md`](./escopo-funcional-geracrm.md)
> ou [`backlog-epicos-geracrm.md`](./backlog-epicos-geracrm.md).
> **Escolha sem exigência apontada é preferência disfarçada** — e não entra.

---

## 1. Desambiguação necessária: "server-side" aqui significa duas coisas

O pedido menciona *"princípio de server-side com dados vindo de server→client"*. São dois conceitos
distintos, e confundi-los leva a escolher o framework errado:

| Conceito | O que é | Precisamos? |
|---|---|---|
| **SSR** (Server-Side Rendering) | O HTML é montado no servidor a cada requisição | **Só no catálogo público.** No app autenticado, não agrega — o usuário faz login uma vez e fica horas na mesma tela |
| **Server push** (server→client) | O servidor **empurra** eventos para a aba aberta, sem o cliente perguntar | **Sim, é o coração do produto.** Mensagem do WhatsApp/Instagram chegando na aba certa, em tempo real |

Este documento trata os dois separadamente: SSR na §7, server push na §5 — que é a seção mais
longa, porque é onde mora a exigência de isolamento entre empresas.

---

## 2. Princípios que governam as escolhas

| Princípio | Como se traduz em decisão |
|---|---|
| **Custo reduzido** | Menos componentes de infraestrutura. Cada serviço novo é custo fixo mensal + superfície de falha + coisa para monitorar. Só entra o que se paga |
| **Robustez** | Falha de um canal externo (Meta, ERP) não pode derrubar o produto. Degrada localizado |
| **Confiabilidade** | Nada crítico depende de "lembrar de fazer". Isolamento, idempotência e opt-out são garantidos pela camada |
| **Performance** | Otimizar o que o usuário sente: inbox, busca, montagem de pedido. O resto pode ser lento |
| **Escalabilidade** | Escalar quando doer, com o ponto de dor conhecido de antemão (§12). Não antes |
| **Uma linguagem** | TypeScript de ponta a ponta. O maior custo de um time pequeno é troca de contexto, não CPU |

⚠️ **Contra o instinto:** microserviços, Kubernetes e event sourcing atendem "escalabilidade" no
papel e destroem "custo reduzido" e "estabilidade" na prática, com o volume que teremos nas
Ondas 0–3. Ficam de fora, com o gatilho de reavaliação escrito na §12.

---

## 3. Arquitetura de módulos

**Monolito modular + workers + gateways.** Um deployable principal, processos auxiliares separados
apenas onde o perfil de carga é genuinamente diferente.

```
┌───────────────────────────────────────────────────────────────────┐
│  CLIENTES                                                         │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────────────┐   │
│  │ Web SPA    │  │ Mobile (RN)  │  │ Catálogo público (SSR)  │   │
│  └─────┬──────┘  └──────┬───────┘  └───────────┬─────────────┘   │
└────────┼────────────────┼──────────────────────┼─────────────────┘
         │ HTTP + SSE     │ HTTP + SSE + sync    │ HTTP
┌────────┴────────────────┴──────────────────────┴─────────────────┐
│  API (monolito modular — TypeScript)                             │
│                                                                   │
│   atendimento │ pedido │ crm │ campanha │ catalogo │ analitico    │
│   ─────────────────────────────────────────────────────────────  │
│   núcleo: identidade · tenancy · autorização · eventos           │
└───────┬───────────────────────┬───────────────────────┬──────────┘
        │                       │                       │
┌───────┴──────┐      ┌─────────┴────────┐     ┌────────┴────────┐
│  GATEWAY     │      │  WORKERS         │     │  DADOS          │
│  Meta        │      │  disparo         │     │  Postgres (RLS) │
│  webhooks    │      │  sincronização   │     │  + réplica      │
│  entrada     │      │  IA assíncrona   │     │  Object storage │
└──────────────┘      │  mídia           │     └─────────────────┘
                      └──────────────────┘
```

### Por que separar exatamente estes três

| Processo | Por que é separado | Exigência |
|---|---|---|
| **Gateway de webhooks** | A Meta exige resposta em milissegundos e reenvia se demorar. Não pode competir com uma consulta pesada de RFV. Só valida, grava e publica | INB-01, CAN-01 |
| **Workers** | Disparo com throttling por número roda por horas; sincronização de carga histórica processa milhões de linhas. Perfil oposto ao de uma requisição web | CMP-07/09, INT-05 |
| **API** | Requisições curtas, latência sentida pelo usuário | Todas as telas |

Tudo o mais — atendimento, pedido, CRM, campanha, catálogo — é **módulo dentro do mesmo
deployable**, separado por capacidade de negócio, com fronteira de contrato entre eles
(`arquitetura-limpa`: módulo por capacidade, nunca por camada técnica).

⚠️ **O teste do limite:** se dá para extrair um módulo para outro processo sem tocar nos demais,
a fronteira está certa. Vamos manter essa propriedade **sem** pagar o preço de já extrair.

---

## 4. A stack, camada por camada

| Camada | Escolha | Exigência que a justifica | Descartado, e por quê |
|---|---|---|---|
| **Linguagem** | **TypeScript** em API, web, mobile e workers | Tipos compartilhados de ponta a ponta eliminam a classe de bug mais comum: contrato divergente entre front e back. Time único, sem troca de contexto | **Go/Elixir**: melhores em conexões persistentes, mas obrigam segunda linguagem. O gargalo real é I/O e banco, não CPU do runtime. **Python**: forte em IA, fraco no resto — a IA entra por API, não precisa dominar a stack |
| **Runtime API** | **Node LTS**, framework HTTP enxuto | Ecossistema maduro para Meta, filas e Postgres | — |
| **Banco transacional** | **PostgreSQL** | **RLS resolve o isolamento de tenant na camada** (INV-04) · JSONB para campos personalizados (CTT-06) · particionamento para mensagens · transação forte para PED-07 | **NoSQL**: perde transação e integridade justo onde o domínio é relacional (cliente↔pedido↔item). **Multi-banco**: custo e complexidade sem ganho nesta fase |
| **Fila, throttling e presence** | **Postgres** — outbox pós-commit, contador em tabela com `UPDATE ... RETURNING`, presence com `expira_em` | ADR-007. Um componente a menos: custo fixo, superfície de falha e coisa para monitorar. O outbox garante que o evento só existe se a transação commitou — broker separado tem o problema oposto | **Redis**: foi a escolha inicial, revista ao adotar a stack do drezz. Com payload mínimo (§5.3), `LISTEN/NOTIFY` atende o fan-out e o limite de 8 KB fica irrelevante. Entra quando **medirmos** necessidade |
| **Push server→client** | **SSE sobre HTTP/2 + `LISTEN/NOTIFY`** | §5 inteira | **WebSocket próprio**: bidirecional que não usamos — o envio vai por POST. **Serviço gerenciado** (Pusher/Ably): custo por conexão cresce com a base, e conexão aberta o dia inteiro é o nosso padrão de uso |
| **Analítico** | **Réplica de leitura + views materializadas**, no mesmo Postgres | RFV, evolução de segmento, atribuição 3/7/14d (§8 da spec de telas) sem competir com o inbox | **Colunar (ClickHouse/DuckDB)**: correto no volume certo, caro e desnecessário agora. Gatilho de migração na §12 |
| **Mídia** | **Object storage S3-compatível + URLs assinadas** | Áudio, imagem, PDF em volume (INB-02) | Guardar binário no banco — inflaciona backup e mata o custo |
| **Console web** | **Angular 21+** (zoneless, signals, standalone), servido por CDN | **RxJS** modela o stream SSE multiplexado por canal · **CDK** para virtual scroll das listas grandes · estrutura opinativa em app denso de vida longa · Vitest padrão · **o time domina Angular** (ADR-010) | **React DOM**: compartilharia cultura com o Expo, mas o stream de eventos e as listas ficariam artesanais. **SSR no console**: não ajuda quem fica 8 h na mesma tela e adiciona servidor para pagar |
| **Web (catálogo público)** | **Renderizado no servidor**, deployable separado | CAT-02: link compartilhado no WhatsApp precisa abrir rápido em 4G e gerar preview | SPA aqui seria lenta no primeiro carregamento, que é o único que importa |
| **Mobile** | **React Native + Expo** | Funções críticas em campo (MOB-01…08) · offline (PED-14) · **o time já domina Expo** · compartilha TypeScript, tipos e regras com o web | **Nativo duplo**: dois times, dois ciclos. **PWA**: push confiável e SQLite local ainda são frágeis demais para operação de campo |
| **Banco local mobile** | **SQLite** + camada de sincronização própria | PED-14, MOB-08: pedido montado sem sinal | Sync genérico pronto: resolve conflito de forma que o negócio não aceita (§6) |
| **IA** | **API externa**, atrás de porta do domínio | IA-01…13. Modelo é adaptador, não núcleo | Modelo próprio: custo e manutenção sem retorno nesta fase |
| **Infra** | **Railway** para começar | Custo baixo, deploy simples, o time já opera lá. Sem Kubernetes | Kubernetes agora: custo fixo e operação que não temos por que pagar |

---

## 5. Server push e isolamento entre empresas

Esta é a seção que o pedido enfatizou, e é onde um erro vaza conversa de um cliente para outro.

### 5.1 O modelo de canais

Todo canal é **prefixado por tenant, sem exceção**:

```
tenant:{T}:numero:{N}       eventos do número — nova conversa, mensagem, mudança de status
tenant:{T}:conversa:{C}     eventos de uma conversa aberta na tela
tenant:{T}:usuario:{U}      pessoais — tarefa, menção, atribuição, invalidação de permissão
tenant:{T}:campanha:{K}     progresso de disparo
```

A aba que está vendo o número da Janaina assina `tenant:42:numero:7`. A aba que está vendo o
número da Eduarda assina outro canal. **A separação é do lado do servidor, não um filtro no
cliente.**

⚠️ **Canal sem prefixo de tenant é o vetor de vazamento nº 1.** Um único canal `conversa:{C}`
sem tenant, e IDs sequenciais bastam para alguém receber evento de outra empresa. Regra: o
nome do canal é montado por uma única função, que **não aceita** montar canal sem tenant.

### 5.2 Autorização — no momento da subscrição, não no login

```
1. Usuário autentica          → sessão normal
2. Cliente pede token de push → API emite token curto (5–15 min) com { tenantId, userId }
                                 ⚠️ o token NÃO carrega a lista de canais permitidos
3. Cliente pede um canal      → servidor valida ANTES de assinar:
                                   • o canal pertence ao tenant do token?
                                   • o usuário tem permissão neste número?
                                   • o número pertence a este tenant?
                                   • a conversa pertence a este número?
4. Só então                   → subscrição efetivada
```

**Por que a validação é por subscrição e não só no login:** permissão muda durante a sessão.
Vendedora sai de um número, carteira é transferida, usuário é desativado. Validar só na entrada
deixa uma sessão privilegiada aberta até o logout.

### 5.3 Payload mínimo — a defesa em profundidade que quase ninguém faz

O evento empurrado **não carrega conteúdo**:

```json
{ "tipo": "mensagem.recebida", "conversaId": "…", "numeroId": "…", "versao": 8412 }
```

O cliente recebe o aviso e **busca o conteúdo pela API autenticada**, que passa por RLS.

Consequência: **mesmo que o fan-out erre o alvo, não vaza conteúdo.** O intruso recebe um ID
que não consegue resolver. É a diferença entre um bug e um incidente.

Custo: uma requisição extra por evento. Compensa com folga — e a maior parte dos eventos só
atualiza contador, sem precisar do conteúdo.

### 5.4 Revogação e reconexão

| Situação | Tratamento |
|---|---|
| Permissão mudou | Publica `permissao.alterada` no canal do usuário → cliente descarta o token e re-autoriza |
| Token expirou | Renovação silenciosa; se falhar, cai para estado degradado com aviso, não tela branca |
| Conexão caiu | Cliente guarda a **última versão recebida** e, ao reconectar, busca o delta pela API |

⚠️ **Não confiar no histórico do broker para recuperar eventos perdidos.** O cursor de versão
no cliente + delta pela API é mais simples, mais barato e à prova de troca de infraestrutura.

### 5.5 Por que SSE e não WebSocket

| | SSE | WebSocket |
|---|---|---|
| Direção | Servidor → cliente | Bidirecional |
| O que precisamos | **Exatamente isso** — o envio de mensagem vai por POST | Metade sobra |
| Reconexão | Nativa no protocolo | Implementar |
| Proxy/rede corporativa | HTTP comum, passa | Às vezes bloqueado |
| Limite de 6 conexões por domínio | **Só em HTTP/1.1** — some com HTTP/2 | N/A |

**Ordem de grandeza que justifica a escolha:** uma vendedora com a tela aberta = 1 conexão.
Cliente com 20 vendedoras = 20. Cem clientes assim = 2.000 conexões simultâneas — confortável
para poucas instâncias Node, sem infraestrutura de realtime dedicada. Gatilho de mudança na §12.

### 5.6 Presence (aviso de colisão, "digitando")

Heartbeat por POST a cada N segundos, gravado na tabela `conversa_presenca` com coluna `expira_em`
e varredura periódica de expirados. ⚠️ **Postgres não tem TTL nativo** — o vencimento é lógico, e a
leitura sempre filtra por `expira_em > agora()`, nunca confia só na varredura. Sem conexão bidirecional, sem
componente novo. Atende INB-18 com precisão de segundos — que é o suficiente para "Eduarda está
nesta conversa".

### 5.7 Multi-aba

Uma conexão por aba, no início. Se o custo de conexão pesar, uma conexão por navegador com
`SharedWorker` distribuindo para as abas — otimização com gatilho, não decisão inicial.

---

## 6. Mobile — o que muda por ser campo

O app não é o web reduzido. Três exigências que o web não tem:

### 6.1 Offline com fila de sincronização (PED-14)

```
SQLite local           catálogo, tabela de preço e carteira sincronizados
                       rascunhos de pedido
Fila de operações      pedido montado offline aguarda conexão
Ao reconectar          revalida saldo e preço ANTES de efetivar
```

⚠️ **O conflito aqui não é técnico, é comercial.** O saldo mudou entre montar e reconectar. O
sistema **não decide sozinho** — apresenta a divergência e a vendedora resolve, com o mesmo
tratamento de PED-08. Sync genérico automático resolveria "sozinho" e criaria pedido errado.

### 6.2 Push notification

Nova mensagem, tarefa vencendo, meta em risco (MOB-07). Notificação carrega **apenas o
identificador**, nunca o conteúdo — mesma regra da §5.3, e ainda evita expor conversa na tela
de bloqueio.

### 6.3 Rascunho multi-dispositivo (PED-06)

O rascunho é **estado do servidor**, não do aparelho. Começar no celular no showroom e terminar
no computador precisa funcionar — é caso de uso real, não conveniência.

---

## 7. Web — duas superfícies, dois perfis

| | App autenticado | Catálogo público |
|---|---|---|
| Renderização | SPA no cliente | Servidor |
| Distribuição | CDN estática | Servidor com cache agressivo |
| Custo de servidor | **Zero** | Baixo, cacheável |
| Por quê | Sessão de horas, alta interatividade, dados privados | Primeiro carregamento em 4G é tudo; precisa de preview no WhatsApp |

**Responsividade do app:** o mesmo código atende desktop e tablet. Abaixo de tablet, o app web
degrada para as funções de consulta — quem trabalha no celular usa o app nativo, que é melhor
nisso. Tentar fazer o inbox de 4 colunas caber em 375px produz duas experiências ruins.

---

## 8. Dados: transacional e analítico não competem

| Carga | Onde roda | Por quê |
|---|---|---|
| Inbox, pedido, CRM, cadastro | Primária | Latência sentida pelo usuário |
| RFV, evolução de segmento, atribuição, Visão de Mercado, relatórios | **Réplica de leitura** | Consulta pesada não pode travar quem está atendendo |
| Agregações recorrentes (RFV da base, ranking, dashboards) | **Views materializadas**, atualizadas por worker | Calcular sob demanda a cada abertura de tela é desperdício |

**Mensagens** são a tabela que mais cresce — particionamento por período desde o início. É barato
agora e caro depois.

⚠️ **RFV depende de carga histórica** (dependência crítica nº 1 do backlog). O worker de
importação precisa processar milhões de linhas sem derrubar nada: lotes, retomada de onde parou,
idempotência.

---

## 9. Assíncrono, throttling e integrações

### 9.1 Disparo de campanha

```
Campanha → fila por número → throttling por número → envio → registro de custo
                                    ↑
                        CMP-09: intervalo randômico, limite diário,
                        aquecimento gradual, pausa automática se a
                        qualidade do número cair (CAN-06)
```

O **limite é por número, não global** — cada número da frota tem tier próprio na Meta. Contador em
tabela com `UPDATE ... RETURNING` atômico, no mesmo padrão da numeração fiscal do drezz.

⚠️ **A janela não é o dia de calendário.** Chave por `dia` permite enviar o limite inteiro às 23h e
de novo às 00h05. A modelagem correta está em `modelo-de-dados.md` §2.5.

### 9.2 Webhooks da Meta

Gateway separado, que faz **apenas**: valida assinatura → grava evento bruto → publica → responde
`200`. Qualquer processamento vai para worker. A Meta reenvia o que demora, e reprocessamento sem
idempotência duplica mensagem na tela do usuário.

### 9.3 ERP — multi-conector com negociação de capacidade

**O GeraCRM é alimentado por vários ERPs.** GeraCloud e drezz são os dois primeiros; Bling, Tiny,
TOTVS e ERPs de polo vêm depois. Cada conector novo é mercado novo — a camada de integração é
decisão arquitetural central, não detalhe. Desenho completo em
[`aproveitamento-drezz.md`](./aproveitamento-drezz.md) §9.

**Três contratos, todos definidos pelo nosso domínio:**

| Contrato | Uso | Exigência |
|---|---|---|
| **Ingestão em lote** | Clientes, produtos, pedidos históricos | INT-01, INT-05 |
| **Leitura síncrona ao vivo** | Saldo por SKU, tabela de preço, crédito, **durante a montagem do pedido** | INT-01b — ✅ o GeraCloud já expõe |
| **Escrita idempotente** | Efetivação do pedido | INT-01c, PED-07 |

**Cada conector declara suas capacidades**, e o produto degrada em vez de quebrar: ERP sem saldo
síncrono mostra o saldo da última sincronização com aviso e horário, migrando a validação para o
momento da efetivação; ERP sem escrita de pedido transforma o tira-pedidos em rascunho exportável.

⚠️ **Quando há leitura síncrona, ela precisa de timeout curto e degradação explícita.** Se o ERP
não responde em 2s, a tela avisa e **bloqueia o envio** — nunca deixa montar às cegas para falhar
depois.

⚠️ **A capacidade é visível na interface.** O usuário de um ERP limitado precisa saber por que o
saldo tem hora, senão conclui que o produto está errado.

### 9.4 Circuit breaker em toda integração

Meta fora do ar, ERP fora do ar, provedor de IA fora do ar: cada um degrada **localizado**. O
inbox continua mostrando histórico com o ERP caído; o pedido bloqueia com aviso claro. Uma
integração ruim não pode derrubar o produto.

---

## 10. Segurança — além do isolamento de push

| Item | Decisão |
|---|---|
| **RLS no Postgres** | Ativo em toda tabela de domínio. `tenant_id` obrigatório. Isolamento garantido pela camada, não por `WHERE` escrito à mão |
| **Chaves únicas** | Sempre compostas com tenant: `UNIQUE(tenant_id, cnpj)` |
| **Credenciais de integração** | Criptografadas em repouso, por tenant. Token da Meta de um cliente nunca alcança outro |
| **Mídia** | URLs assinadas com expiração curta. Nunca URL pública adivinhável |
| **Auditoria** | Envio, exclusão, transferência, mudança de carteira e acesso a dado de cliente (PLT-05) |
| **LGPD** | Exportação e exclusão do titular (CTT-15) precisam alcançar mídia e réplica, não só a tabela principal |

---

## 11. Ambientes e custo

**Três ambientes:** desenvolvimento (local, com dublês das integrações) · homologação (com sandbox
da Meta e ERP de teste) · produção.

**O que domina o custo, em ordem:**

1. **Banco de dados** — cresce com histórico de mensagens e volume de pedidos
2. **Object storage** — áudio e imagem de conversa acumulam rápido; política de retenção desde o dia 1
3. **API de IA** — por token; transcrição e agente autônomo são os pesados
4. **Compute da API** — relativamente barato, escala horizontal
6. **CDN** — desprezível

⚠️ **Custo por mensagem da Meta não é nosso** — decisão de Tech Provider (o cliente paga a Meta
direto). Mas **medimos e exibimos** (CMP-12, BI-11), o que exige gravar custo por conversa e
por campanha.

**Alavancas de custo, na ordem em que valem a pena:**
- Retenção de mídia (arquivar áudio antigo em camada fria)
- Particionar e arquivar mensagens antigas
- Cache de resposta de IA para perguntas repetidas
- Views materializadas em vez de agregação sob demanda

---

## 12. Escalabilidade: o que quebra primeiro, e o gatilho

Escalar antes da hora é o inimigo do custo reduzido. Cada item abaixo tem **sintoma observável**
e **próximo passo já definido** — assim ninguém precisa decidir sob pressão.

| Ordem | O que quebra | Sintoma | Próximo passo |
|---|---|---|---|
| 1 | **Consulta analítica** | Dashboard e RFV lentos; réplica com carga alta | Colunar dedicado (ClickHouse/DuckDB) para o analítico |
| 2 | **Tabela de mensagens** | Escrita degradando; índice grande demais | Particionamento mais agressivo + arquivamento em camada fria |
| 3 | **Conexões SSE por instância** | Memória alta; reconexões frequentes | Broker dedicado (Centrifugo) — o modelo de canais da §5 já é compatível, a migração não muda o cliente |
| 4 | **Worker de disparo** | Fila acumulando em horário de pico | Escalar workers horizontalmente; o throttling é por número, então paraleliza natural |
| 5 | **Módulo de campanha** | Pico de disparo afetando latência da API | Extrair para deployable próprio — a fronteira de módulo já permite |
| 6 | **Gateway de webhook** | Meta reportando timeout | Escalar só o gateway; já é processo separado |

**Nenhum desses passos exige reescrita** — todos foram preservados como possibilidade pelas
fronteiras de módulo e pelo modelo de canais.

---

## 13. Como isso atende cada exigência das telas

Fechando o ciclo com a §8 da especificação de telas:

| # | Exigência | Atendida por |
|---|---|---|
| 1 | Tempo real bidirecional | SSE + outbox + `LISTEN/NOTIFY` (§5); envio por POST |
| 2 | Contagem regressiva de janela | Estado derivado no cliente, a partir do timestamp; sem round-trip |
| 3 | Leitura síncrona ao ERP | Contrato INT-01b com timeout curto e degradação explícita (§9.3) |
| 4 | Escrita transacional idempotente | Postgres + chave de idempotência (§9.3) |
| 5 | Rascunho multi-dispositivo | Estado no servidor (§6.3) |
| 6 | Histórico paginado para trás | Particionamento + cursor (§8) |
| 7 | Listas grandes sob demanda | Paginação por cursor; nunca `OFFSET` profundo |
| 8 | Analítico separado | Réplica + views materializadas (§8) |
| 9 | Offline com fila | SQLite + fila, com conflito resolvido pela vendedora (§6.1) |
| 10 | Isolamento por tenant | RLS no banco + canais prefixados + payload mínimo (§5, §10) |
| 11 | Mídia com transcrição | Object storage + worker assíncrono |
| 12 | Throttling por número | Contador em tabela com `UPDATE ... RETURNING` (§9.1) |

---

## 14. Decisões que ainda dependem de informação que não temos

| # | Decisão | Situação |
|---|---|---|
| 1 | ~~Empacotamento de Postgres + Auth + Storage~~ | ✅ **Resolvida** — Cognito headless + Postgres + S3, conforme a stack da casa (ADR-005/004/006 do drezz) |
| 2 | ~~Protocolo do GeraCloud~~ | ✅ **Resolvida** — o GeraCloud já expõe saldo por SKU e tabela de preço em tempo real. Caminho crítico da Onda 0 destravado |
| 3 | ~~Front-end do console web~~ | ✅ **Resolvida** — **Angular 21+** no console, Expo no app do vendedor (ADR-010). O time domina Angular |
| 4 | **Ordem dos conectores de ERP** | ⚠️ **Aberta** — GeraCloud e drezz são os dois primeiros. Quais vêm depois (Bling? Tiny? ERP de polo?) é decisão comercial que define o roadmap de integração |
| 5 | **Volume real do primeiro cliente** | Nº de números, mensagens/dia, contatos, anos de histórico. Muda o dimensionamento inicial e quando os gatilhos da §12 disparam |
| 6 | **Provedor de IA** | Custo por token e latência de transcrição definem se a IA entra na Onda 2 ou 3 |

Nenhuma das abertas bloqueia a Onda 0. A nº 5 deveria ser levantada durante a Onda 0, junto com a
carga histórica — o próprio volume importado responde a maior parte dela.
