# Mapa de Telas — Módulo Web (Console)

> **O que é**: o inventário COMPLETO das telas do console web, a arquitetura de navegação (menu),
> e a especificação de cada tela — o blueprint para construir um sistema grande **com consistência**.
> Levantado a partir da referência **Tailor** (21 capturas) reconciliada com o **nosso escopo**.
>
> **Não é** reprodução do Tailor: adotamos o que serve aos anéis 1, 3 e 4; e-commerce fica de fora
> (o ERP já resolve, ADR-005/019); o **pedido assistido** e a **Fila do Dia por RFV explicável** são
> nossos e não têm equivalente à altura na referência.

## 0. Princípios que TODA tela obedece (não-negociáveis)

Estes vêm das skills/docs já definidas — não são opinião por tela, são o contrato de consistência:

| Princípio | Origem | Regra |
|---|---|---|
| **5 estados obrigatórios** | `especificar-telas`, `especificacao-telas.md` | carregando (esqueleto, nunca spinner solto), vazio (explica por quê + ação), erro (nomeia o sistema), sem permissão (some, ou cadeado se upsell), parcial/degradado |
| **Densidade > animação** | `geracrm-console-angular`, `identidade-visual.md` | operação fica 8h na mesma tela; linha densa, nada piscando exceto o anel de janela |
| **Rampa RFV informa antes de ler — sempre com rótulo** | `identidade-visual.md` §3 | cor do segmento (`rfv.*` tokens) **+** texto; cor sem rótulo é proibida |
| **Números em monoespaçada, alinhados** | `identidade-visual.md` | R$, contagens, SKU, telefone, protocolo |
| **Listas por cursor, nunca offset** | ADR / regra do projeto | grid não paginado derrubou o Postgres do GeraCloud; kanban com coluna de 11 mil cards |
| **Regra de negócio fora do console** | `arquitetura-limpa`, `packages/shared` | RFV, janela 24h, validação de pedido vêm da API/shared; o console apresenta |
| **Cor/estado só de design tokens** | `geracrm-console-angular` | cor literal diverge do app Expo em 3 meses |
| **Tenant do token, nome amigável na tela** | ADR-001, A-07 | nunca o código do conector/fornecedor exposto |
| **Janela de 24h visível e o composer preserva o texto** | `geracrm-tempo-real`, INB | fechar janela com conversa aberta não perde o que foi digitado |

⚠️ **Toda tela nova passa por**: skill `especificar-telas` (spec dos 5 estados) → `geracrm-console-angular`
(implementação) → tokens de `identidade-visual`. Sem exceção — é o que dá a "cara única" consistente.

---

## 1. Arquitetura de navegação (o menu lateral)

Espelha a referência, adaptada ao nosso domínio (pt-BR: Conversa, Pedido, Campanha, Número) e ao
escopo. Cada item marca a **onda** e o **status** (`✅ feito` · `🟡 parcial` · `⬜ pendente` · `⛔ fora de escopo`).

```
GeraCRM
├── Início ................................. dashboard operacional          [O1]  ⬜
├── Visão de Mercado ....................... origens + distribuição RFV     [O1]  ⬜
├── Agentes IA ............................. leads atendidos/qualif. pela IA [O3]  ⬜
├── Equipe de Agentes ...................... config dos agentes IA          [O3]  ⬜
├── Catálogo ............................... produtos, SKUs, grade, preço   [O1]  🟡 (ingestão feita)
│
├── ▸ Atendimento (Números Conectados)
│   ├── Conversas (Inbox) .................. o coração operacional          [O1]  ⬜
│   ├── Meus Números ....................... frota WhatsApp + saúde         [O0]  🟡 (schema+config ERP)
│   ├── Templates (HSM) .................... catálogo aprovado na Meta      [O0]  🟡 (schema feito)
│   ├── Campanhas (Disparos) ............... disparo em massa + ROI         [O3]  ⬜
│   ├── Mensagens Enviadas ................. log de envios                  [O1]  ⬜
│   ├── Listas Personalizadas ............. públicos de campanha            [O3]  ⬜
│   ├── Performance de Atendimento ........ SLA, 1ª resposta, MC-05        [O2]  ⬜
│   ├── WhatsApp Flows .................... formulários nativos            [O3+] ⬜
│   ├── Respostas dos Flows ............... o que os Flows coletaram       [O3+] ⬜
│   └── Configurações do Canal ............ horário, ausência, assinatura  [O1]  ⬜
│
├── ▸ Gestão de Vendas
│   ├── Fila do Dia ....................... ⭐ RFV explicável, quem ligar hoje [O1] ⬜
│   ├── Contatos .......................... base de clientes + RFV          [O1]  🟡 (tela Clientes feita)
│   ├── CRM (Kanban Leads) ................ leads por etapa                 [O1]  ⬜
│   ├── CRM Avançado ...................... clientes por nº de pedidos/RFV  [O1]  ⬜
│   ├── Funil de Vendas ................... etapas + conversão              [O2]  ⬜
│   ├── Leads e Conversão ................. taxa por origem/canal           [O2]  ⬜
│   ├── Vendedores e Carteiras ............ atribuição de dono              [O1]  ⬜
│   ├── Configurar Funis .................. desenho das etapas              [O2]  ⬜
│   ├── Tarefas / Follow-ups .............. agenda de contato               [O1]  ⬜
│   ├── Sequências (Cadências) ............ passos automáticos de contato   [O2]  ⬜
│   ├── Metas / Metas por Vendedor ........ objetivos e acompanhamento      [O2]  ⬜
│   ├── Mapa de Clientes .................. distribuição geográfica         [O3]  ⬜
│   ├── Cidades ........................... clientes por cidade             [O3]  ⬜
│   └── NPS ............................... satisfação                      [O3]  ⬜
│
├── ▸ Recompra & Retenção
│   ├── Retenção .......................... funil de recompra (churn)       [O2]  ⬜
│   ├── Fidelidade / Cashback ............. saldo do ERP + alavancagem      [O2]  ⬜ (ADR-020)
│   └── Segmentos RFV ..................... construtor de segmento          [O2]  ⬜
│
├── ▸ Integrações
│   ├── ERP (Conexões) ................... conectar/testar ERP             [O0]  ✅ FEITO
│   └── Operações / Sincronização ........ cargas, conciliação, conflitos  [O0]  🟡 (backend feito)
│
├── ▸ Gestão (BI)
│   ├── Painéis .......................... vendas, ranking, top produtos    [O2]  ⬜
│   └── Relatórios ....................... exportações                      [O2]  ⬜
│
├── Automações ............................ gatilhos e ações               [O2]  ⬜
├── Link de Pagamento ..................... 🔒 (upsell)                     [O3]  ⛔ (avaliar)
├── Dispare Emails ........................ e-mail                          [—]  ⛔ (foco é WhatsApp)
├── Configurações Gerais .................. empresa, usuários, perfis       [O1]  🟡 (schema)
└── Novidades ............................. changelog                       [O1]  ⬜
```

⚠️ **Decisões de escopo que divergem do Tailor** (e por quê):
- **Dispare Emails / e-mail**: fora — nosso canal é WhatsApp/Instagram (escopo). Reavaliar só se o piloto pedir.
- **Link de Pagamento**: o ERP/GeraCloud já emite cobrança; entra só se houver caso claro.
- **E-commerce/catálogo público de venda**: fora (ADR-005) — o ERP tem loja. Temos catálogo de **consulta**
  para o pedido assistido, não vitrine transacional.
- **Fila do Dia** e **Pedido Assistido**: NOSSOS diferenciais, ausentes/fracos na referência.

---

## 2. Telas de detalhe e modais (fora do menu, alcançadas por navegação)

| Tela | Chega de | Papel | Onda | Status |
|---|---|---|---|---|
| **Ficha do Contato** | Contatos, Kanban, Inbox, Fila | 360° do cliente: dados, RFV, tarefas, conversas, vendas, categorias, evolução do segmento | O1 | ⬜ |
| **Thread da Conversa** | Inbox | chat + janela 24h + composer + mídia + pedido assistido embutido | O1 | ⬜ |
| **Pedido Assistido** | Thread, Ficha | ⭐ tira-pedido no chat: grade cor×tamanho, saldo/preço ao vivo, falha tipificada | O1 | ⬜ |
| **Detalhe de Campanha** | Campanhas | entregas, erros, vendas 3/7/14d, ROI | O3 | ⬜ |
| **Modal Enviar Mensagem** | Ficha, Contatos | template/texto, sugestão de IA (atacado/varejo), copiar catálogo | O2 | ⬜ |
| **Modal Itens da Categoria** | Ficha (pizza de categorias) | SKUs vendidos: referência, produto, qtd, total | O2 | ⬜ |
| **Onboarding** | pós-cadastro | Embedded Signup Meta, conectar ERP, medição do antes | O0 | 🟡 (schema) |
| **Login** | público | Cognito headless (UI nossa) | O1 | ⬜ |
| **Equipe / Convites** | Config | usuários, papéis, carteiras | O1 | ⬜ |

Especificações detalhadas de login/onboarding/equipe já existem em
[`especificacao-telas-entrada.md`](especificacao-telas-entrada.md); das 7 telas críticas de operação,
em [`especificacao-telas.md`](especificacao-telas.md).

---

## 3. Especificação por tela (as principais)

Formato: **Objetivo · Componentes-chave · Estados que importam · Fontes de dado**. Os 5 estados são
sempre obrigatórios; abaixo destaco o que é peculiar a cada tela.

### 3.1 Início (Dashboard) · [O1]
- **Objetivo**: o gestor abre e sabe em 3 segundos como o negócio está hoje.
- **Componentes**: KPIs (Vendas, Ticket Médio, Clientes, Novos/Recorrentes); cards Vendas por
  Campanha / por Tarefa / Leads IA; gráfico de vendas no período (comparar com ano anterior);
  Ranking (vendedores | clientes); Tabela de Vendas recentes; Top Produtos (valor | qtd).
- **Peculiar**: o gráfico de vendas é o único elemento "grande"; todo o resto é denso. Comparação de
  período é toggle, não recarrega a tela.
- **Dados**: `mv_metricas_contato`, `venda`, `campanha`, atribuição de receita (ADR-013).

### 3.2 Conversas (Inbox) · [O1] · ⭐ coração
- **Objetivo**: a vendedora vive aqui; responde, vende, não perde a janela.
- **Componentes**: seletor de número; busca; filtros (ordenar por msg do cliente, só sem resposta);
  **lista de conversas** (virtual scroll, cursor) com etiquetas (Lead, nº de pedidos, quem atende);
  **thread** com **estado da janela** (Janela Aberta/Fechada + contagem regressiva); composer que
  troca de modo (texto livre × template) **sem perder o que foi digitado**; mídia, áudio com
  transcrição; **pedido assistido embutido**.
- **Peculiar**: a janela de 24h é o elemento-assinatura (anel/barra, movimento lento, nunca pisca —
  `identidade-visual` §5). Presença ("Eduarda está aqui") por heartbeat. SSE por canal, cursor de versão.
- **Dados**: `conversa`, `mensagem` (particionada), `atendimento`, `canal_conectado.capacidades` (janela).

### 3.3 Fila do Dia · [O1] · ⭐ nosso diferencial
- **Objetivo**: responder "com quem eu falo AGORA e por quê" — a predição explicável (RFV-10).
- **Componentes**: lista priorizada por urgência (atraso relativo ao ritmo do cliente); cada item com
  segmento RFV (cor+rótulo), a **frase do porquê** ("comprou há 44 dias, costuma a cada 3 — 16× além
  do ritmo"), ação sugerida, botão de abrir conversa/pedido.
- **Peculiar**: NÃO é uma lista de "todos os clientes" — é a fila do dia daquela vendedora, cortada
  por carteira e urgência. Reaproveita o classificador `@geracrm/shared/rfv`.
- **Dados**: `metricas_contato` (view), `carteira_atribuicao`.

### 3.4 Contatos / Ficha do Contato · [O1] · 🟡 (lista Clientes feita)
- **Lista**: já construída — clientes com RFV humanizado, cursor, 5 estados. Falta: filtros
  (segmento, canal, cidade, atacado/varejo), busca por nome/telefone/CNPJ.
- **Ficha (360°)**: dados (nome, status, atacado/varejo, telefones com principal, Instagram, e-mail,
  CNPJ/CPF, endereço); Tarefas (agendadas/vencidas/concluídas); Conversas; Comentários; **Informações
  de vendas** (total, 1ª/última, dias sem comprar, qtd, ticket, média entre vendas, Perfil RFV);
  **Categorias mais vendidas** (pizza → modal de itens); **Evolução do Segmento RFV** (linha no tempo);
  gráfico de vendas; campos personalizados; toggles de campanha/automação; enviar mensagem.
- **Peculiar**: a "Evolução do Segmento RFV" conta a história do cliente — é o que justifica a ação.
- **Dados**: `contato` + satélites, `venda`, `item_venda`, `mv_metricas_contato`.

### 3.5 CRM (Kanban Leads) e CRM Avançado · [O1]
- **Objetivo**: mover leads/clientes por etapa; ver a carteira de relance.
- **Componentes**: colunas (Leads, Qualificados… / Clientes 2 pedidos, 3+, Representantes, Descartados);
  cards com nome, telefone, responsável, "está no telefone", segmento RFV, valor, Ativo/Perdido, ações.
- **Peculiar**: ⚠️ **paginação POR COLUNA** — o CDK não faz drag-drop + virtual scroll juntos, e temos
  coluna de 11 mil cards. Cada coluna tem seu cursor. Drag-drop com otimista + rollback.
- **Dados**: `contato`, `mv_metricas_contato`, funil configurável.

### 3.6 Meus Números · [O0/1] · 🟡
- **Objetivo**: saúde da frota WhatsApp — o que está no ar, o que está caindo.
- **Componentes**: card por número (nome amigável, telefone, disponível, contatos/clientes, filial);
  status da conta (LIMITE/DIA, PAGAMENTO OK, LIVE, EMPRESA VERIFICADA); ações (configurar, importar,
  comandos). ⚠️ **Saúde é histórico** (quando começou a cair), não só o estado atual (`canal_saude_evento`).
- **Dados**: `canal_conectado`, `numero_whatsapp`, `canal_saude_evento`, `canal_configuracao`.

### 3.7 Campanhas (Disparos) · [O3]
- **Objetivo**: disparo em massa com **ROI honesto** (o diferencial do Tailor que adotamos).
- **Componentes**: filtros de período/janela; KPIs (Gasto, Vendas, Retorno Nx, Clientes 3d/7d);
  tabela (Data, Campanha, Status + "N com erro → ver detalhe", Contatos, Entregues, Lidos, Respostas,
  **Vendas 3d/7d/14d**, Total, Gasto, Retorno, Falhas); paginação por cursor.
- **Peculiar**: atribuição de receita com precedência (ADR-013); "N com erro" é link para o detalhe,
  não um número morto. Público sai de **Listas** e respeita opt-out/bloqueio (INV-13/15).
- **Dados**: `campanha`, `venda` (atribuída), `lista_bloqueio`, `consentimento_contato`.

### 3.8 Visão de Mercado · [O1/2]
- **Objetivo**: entender a base — sobreposição de origens e distribuição RFV.
- **Componentes**: Venn (Cadastros Catálogo × Contatos WhatsApp × Clientes ERP) com interseções;
  totais por documento (CPF/CNPJ/Não informado); barra/pizza de distribuição RFV.
- **Dados**: reconciliação de identidades (`contato_identidade_externa`), `mv_metricas_contato`.

### 3.9 Pedido Assistido · [O1] · ⭐
- **Objetivo**: o tira-pedido dentro da conversa (o pedido nasce no chat, o ERP efetiva — ADR-005).
- **Componentes**: busca de produto/SKU; **grade cor × tamanho** (com subtamanho, ADR-004); saldo e
  preço **ao vivo** com hora e origem (degrada para última sincronização se o ERP não responde);
  condição comercial do cliente; total em peças e R$; **falha tipificada** (estoque, crédito, item
  inativo, sem cadastro fiscal — PED-08) com ação corretiva; efetivação idempotente (INV-29/53).
- **Peculiar**: ⚠️ falha na efetivação **nunca perde o rascunho**; timeout (504) vai para
  `aguardando_conferencia`, não oferece "tentar de novo" cego.
- **Dados**: conector ERP (`consultarSaldo`, `consultarPrecos`, `efetivarPedido`), `pedido`.

### 3.10 Agentes IA · [O3]
- **Objetivo**: ver o que a IA qualificou — leads atendidos, taxa de conversão, tempo de qualificação.
- **Componentes**: KPIs (Leads Totais, Qualificados, Taxa, Últimos 30d, Vendas); tabela filtrável
  (Data, Nome, WhatsApp, CNPJ, Email, Instagram, Necessidade, Canal, Status Qualificado/Desqualificado,
  Virou Cliente, Origem, Data/Tempo de Qualificação).
- **Dados**: pipeline de IA (skill `geracrm-ia`), `atendimento`, `contato`.

> As demais telas do menu (Metas, Sequências, Funil, NPS, Mapa, Automações, Performance, Flows,
> Gestão/BI) seguem o mesmo formato e serão especificadas na abertura da onda que as constrói —
> cada uma com os 5 estados e a origem de dado apontada. O padrão desta seção é o gabarito.

---

## 4. Consistência — o que amarra tudo (a "casca")

Para 40+ telas não virarem 40 estilos, a **casca** é única:

1. **Shell de navegação**: topo (marca, busca global, notificações, usuário) + menu lateral com os
   grupos acima (colapsáveis, item ativo destacado, ícone + rótulo). Um só componente.
2. **Cabeçalho de tela**: título + subtítulo (o "job" da tela) + ações à direita. Mesmo componente.
3. **Bloco de dados**: todo bloco tem os 5 estados via um wrapper comum — ninguém reimplementa "vazio".
4. **Tabela/lista**: um componente de lista com cursor, ordenação por coluna, densidade fixa (linha
   ~32-44px), números monoespaçados. Kanban é a variante com paginação por coluna.
5. **Selo de segmento RFV**: um componente (cor da rampa + rótulo) usado em Ficha, Kanban, Fila, Listas.
6. **Selo de janela 24h**: um componente (anel/barra) usado no Inbox e onde a janela importa.
7. **Modais**: um padrão (título, corpo, ações, foco preso, ESC fecha) — Enviar Mensagem, Itens, etc.
8. **Tokens**: cor, espaçamento, tipografia, densidade — só de `packages/design-tokens`.

⚠️ **Rota e lazy loading**: uma pasta por capacidade (`funcionalidades/{atendimento,crm,recompra,
integracao,gestao}`), espelhando os contextos da API; rotas com lazy loading; funcionalidade não
importa de funcionalidade (`geracrm-console-angular`).

---

## 5. O que já existe e o que vem a seguir

**Feito** (✅): Integração ERP (conexões, testar, capacidades); primeira tela de Contatos (Clientes com
RFV); a casca mínima (abas Clientes/Integração); design tokens; classificador RFV em `shared`.

**Próximo passo recomendado** (para o "menus prontos" com consistência):
1. Construir a **casca definitiva** (shell + menu completo dos grupos acima) com **todas as telas
   roteadas** — as ainda não construídas aparecem no estado **"em construção"** (um dos 5 estados,
   honesto), não em branco. Isso deixa os menus prontos e consistentes desde já.
2. Preencher, na ordem das ondas: **Inbox → Fila do Dia → Ficha do Contato → Pedido Assistido** (o
   núcleo da operação, Onda 1), reaproveitando a base de RFV/ingestão que já roda com dado real.

Cada tela nova entra pela porta única: `especificar-telas` → `geracrm-console-angular` → tokens.
