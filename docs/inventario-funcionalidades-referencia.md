# Inventário de funcionalidades — sistema de referência (Tailor)

> Extraído de 38 capturas em `docs/referencias/imagens de referencia/`.
> Sistema: **Tailor** — `app.usetailor.com.br`. Posicionamento: *"CRM para atacado de moda"*. Web (desktop) + app iOS nativo.
> Cliente de exemplo nas telas: confecção/atacado de moda feminina com múltiplas filiais, vários números de WhatsApp (um por vendedora) e integração com ERP.

Este documento lista **o que existe**, agrupado por módulo. Cada grupo tem as funcionalidades macro e, abaixo, o detalhe observado tela a tela.

---

## 0. Estrutura de navegação (o mapa do produto)

### 0.1 Menu lateral — Web

| Grupo | Itens |
|---|---|
| **(raiz)** | Home · Visão de Mercado · Agentes · Equipe de Agentes · Catálogo · Dispare Emails `NOVO` · Link de Pagamento `🔒` |
| **Gestão de Vendas** | Contatos · CRM Clássico · CRM Avançado · Fila do dia `NOVO` · Configurar Funis · Vendedores e Carteiras · Gerenciar Metas · Metas por Vendedor · Gestão de Tarefas · Minhas Sequências · Funil de Vendas · Funil de Conversão · Leads e Conversão `NOVO` · NPS `NOVO` · Mapa de Clientes · Lista de Cidades |
| **Retenção** `🔒` | (bloqueado no plano da conta demonstrada) |
| **Números Conectados** | Meus Telefones · Mensagens Enviadas · Campanhas (Disparos) · Contatos · Listas Personalizadas · Conversas · Performance de Atendimento · Templates `META API` · WhatsApp Flows `NOVO` · Respostas dos Flows · Configurações |
| **Tailor Gestão** | (submenu recolhido) |
| **Configurações Gerais** | (submenu recolhido) |
| **(raiz)** | Automações · Novidades |
| **Rodapé** | Solicitar Ajuda · Mais · frase motivacional rotativa ("tailor: Paixão vende com facilidade ❤️") |

**Padrões de navegação a copiar:**
- Badges de estado no próprio item de menu: `NOVO` (laranja), `META API` (verde), `🔒` (cadeado = recurso não contratado → gancho de upsell dentro do produto).
- Menu com dois níveis, grupos colapsáveis, item ativo destacado em azul.
- Ícone de sino (notificações) ao lado da logo.

### 0.2 Navegação — App mobile (iOS)

- **Tab bar (5):** Indicadores · Atendimento · Catálogo · CRM · Pagamentos.
- **Sub-abas contextuais** acima da tab bar: em CRM → `Tarefas | CRM | Metas`; em Indicadores → `Visão geral | Equipe`.
- Botão flutuante de engrenagem (configuração da tela atual) e avatar do usuário com badge de contador no topo direito.
- O app **não é um espelho do web** — é o recorte de campo: indicadores, atendimento, ficha do cliente, tarefas, catálogo, pagamentos.

---

## 1. Home / Indicadores (dashboard)

**Macro:** painel executivo de vendas com atribuição de receita por origem (campanha, tarefa, IA).

**Detalhe:**
- **Filtros de período em chips:** Hoje · Ontem · 7 dias · Sem. anterior · Mês anterior · Este mês · Personalizado.
- **Filtro de filial:** "Todas as filiais" (multi-unidade).
- **Cards de KPI:**
  - Vendas — R$ 348.877 · 459 pedidos
  - Ticket Médio — R$ 760,08
  - Clientes — 225 · **22 novos · 203 recorrentes**
  - 📣 **Vendas por Campanhas** — R$ 250.298 · 169 clientes · custo aprox. R$ 1.357 · **184.5x retorno**
  - ☑️ **Vendas por Tarefas** — R$ 157.820 · 111 clientes
  - 🤖 **Leads Atendidos pela IA** — 399 · 121 qualificados · 30% conversão
  - 👤 **Leads que viraram Clientes** — 2 · R$ 3.673
- **Gráfico de Vendas no período:** barras (R$) + linha (Qtd. Clientes) em eixo duplo, tooltip com "Período atual / Qtd. Clientes / Ticket Médio Atual", toggle **"Comparar ano anterior"**.
- **Ranking** — desempenho no período, alternável entre **Vendedores | Clientes**; posição, nome, R$ e nº de pedidos.
- **Tabela de Vendas** (Recentes | Todos): Data, Pedido, Cliente, Telefone, Cidade/UF, Valor, Status (ex.: `Fechada`), origem.
- **Top Produtos** — mais vendidos no período, alternável **Valor | Qtd**.
- No mobile: mesmos cards, engrenagem para configurar quais indicadores aparecem, alternância **Visão geral | Equipe**.

> **Sacada de produto:** os três cards de atribuição (Campanhas / Tarefas / IA) transformam o dashboard em prova de ROI da própria ferramenta. É o argumento de retenção do SaaS.

---

## 2. Visão de Mercado (inteligência de base)

**Macro:** raio-X da base de contatos cruzando as três fontes de dados da operação.

**Detalhe:**
- **Diagrama de Venn de 3 círculos** com sobreposições calculadas:
  - Cadastros no Catálogo — 15.020
  - Contatos do WhatsApp — 17.920
  - Clientes do ERP — 3.561
  - Interseções: 4.804 · 2.180 · 3.417 · 2.179 (núcleo)
- **Barra de qualidade cadastral:** Total 29.780 · CPF 9.840 (33%) · CNPJ 8.174 (27%) · **Não informado 11.766 (40%)**.
- **RFV** — distribuição dos clientes por **Recência, Frequência e Valor**, dos últimos 24 meses, com base na integração de dados. Link "O que é RFV?" (educação no produto).

> Esta tela responde "quantos contatos eu tenho de verdade e quanto da minha base está órfã de cadastro". É diferencial raro no mercado brasileiro.

---

## 3. Agentes (atendimento com IA)

**Macro:** IA que atende, qualifica e classifica leads automaticamente, com painel de auditoria.

**Detalhe — tela `Agentes` (`/atendimento-ia`):**
- KPIs: Leads Totais (433) · Qualificados (134) · Taxa de Conversão (30.9%) · Últimos 30 dias (134) · Vendas geradas (R$).
- Filtros de período: 7 dias · 15 dias · 30 dias.
- Filtros da tabela: Todos os leads · Todos os canais · Virou Cliente · Todas as origens · busca por WhatsApp · busca por Nome.
- **Tabela "Leads Atendidos pela IA"** (colunas ordenáveis): Data Criação · Nome · WhatsApp · CNPJ · Email · Instagram · **Necessidade** (ex.: "atacado") · **Canal** (WhatsApp / Instagram) · **Status** (`QUALIFICADO` / `DESQUALIFICADO`) · Virou Cliente (SIM/NÃO) · **Origem** (WhatsApp Manual / Instagram Direct) · Data Qualificação · **Tempo de Qualificação** (3 min, 18 min, 13h 17min).

**Funcionalidades implícitas:**
- A IA **extrai campos estruturados da conversa** (CNPJ, e-mail, Instagram, necessidade) e preenche o cadastro.
- A IA **decide qualificar ou desqualificar** o lead.
- Métrica de **tempo até qualificação** — SLA do robô.
- Item de menu separado **"Equipe de Agentes"** → múltiplos agentes de IA com papéis distintos, organizados em time.

---

## 4. Números Conectados (WhatsApp / infraestrutura)

### 4.1 Meus Telefones

**Macro:** gestão de uma frota de números da API Oficial, um por vendedora, agrupados por filial.

**Detalhe — card de cada número:**
- Nome amigável editável (ex.: `Janaina`, `Sandy`, `Eduarda`, `Layla`, `Mari`) + ícone de edição.
- **Badge de filial** (`Filial Santa Cruz`) — agrupamento por unidade.
- Número no formato internacional (`558191400969`).
- **Status:** `disponível` (verde).
- **Contadores:** `6.079 contatos · 5.714 clientes`.
- **Painel "Tailor & Meta"** com selos de saúde da conta:
  - CONTA: `LIMITE: 10K/DIA` · `PAGAMENTO OK` · `LIVE`
  - VERIFICAÇÕES: `EMPRESA VERIFICADA`
- **Ações:** `configurar` · `importar` · `comandos` · `importado` (estado concluído).

> Isto é o **painel de saúde do número** — tier de envio, status de billing da Meta, verificação do Business. Requisito para operar API Oficial em escala.

### 4.2 Conversas (inbox)

**Macro:** caixa de entrada multi-número com contexto comercial embutido.

**Detalhe:**
- **Seletor de número no topo** da lista (`(Janaina) - 558191400969`) — o atendente escolhe qual caixa está vendo.
- Busca por nome ou telefone.
- **Toggles de triagem:** `Ordenar por msg do cliente` · **`Só sem resposta`**.
- Recorte temporal: `Histórico dos últimos 30 dias` + botão **"Carregar mais 30 dias"** dentro da conversa.
- **Lista de conversas** — cada linha traz nome (ou número), telefone, horário, prévia da última mensagem e uma **fileira de badges de contexto**:
  - `Lead` · `Lead Qual.` — estágio
  - `JANAINA` — vendedora dona
  - `1 pedido` / `3+ pedidos` — histórico de compra
  - `Pietà IA` — quem está conduzindo
  - `Arquivo enviado` · `[Imagem]` — tipo do último conteúdo
  - bolinha verde = não lido / atividade
- **Janela do chat:**
  - Header: nome do contato + **badge `Janela Aberta` (verde) / `Janela Fechada` (vermelho)** — estado da janela de 24h da Meta, sempre visível.
  - Canto superior direito: **seletor de funil e etapa** (`Funil de Leads · Lead novo`) — move o negócio sem sair da conversa.
  - Balões com hora, **player de áudio inline** (0:00 / 0:12, velocidade, menu), texto em itálico para transcrição/nota.
  - Composer: campo com dica **`Ctrl+Enter para enviar`**, botão `+` (anexos), botão de **gravar áudio**, botão enviar.

### 4.3 Campanhas (Disparos)

**Macro:** disparo em massa com **atribuição de receita por janela de tempo** — o módulo mais sofisticado do sistema.

**Detalhe:**
- Filtros: `Data início` · `Data fim` · **`Janela de conversas (dias)`** · botão Filtrar.
- **Faixa de KPIs consolidados:**
  - **Gasto aprox.** ≈ R$ 1.356,61 — `60 camp · 4.217 entregues`
  - **Vendas** R$ 250.297,79 — `169 clientes · 4.01% conv`
  - **Retorno 184.5x** — R$ 250.297,79 / R$ 1.356,61
  - **Clientes 3D** 130 cli. (R$ 203.018,18) · **Clientes 7D** 34 cli. (R$ 43.008,61)
- **Tabela de campanhas** (todas as colunas ordenáveis, com paginação):
  | Ações · Data · Campanha · **Nome (número disparante)** · Status · Contatos · Entregues · **Lidos** · **Respostas** · **Vendas 3d** · **Vendas 7d** · **Vendas 14d** · Total · **Gasto ≈** · **Retorno (x)** · Falhas |
- **Status composto:** `FINALIZADO` (laranja) + `6 COM ERRO` (vermelho) + link **`ver detalhe`** dos erros.
- Colunas de vendas mostram **valor + nº de clientes** ("R$ 14.861,63 / 12 cli.").
- Mesma campanha disparada por vários números aparece em linhas separadas → comparação de performance por vendedora.

> **O padrão-ouro aqui:** cada campanha carrega custo real, receita atribuída em 3/7/14 dias e ROI calculado. Nenhum concorrente popular brasileiro entrega isso de forma nativa.

### 4.4 Templates (Meta API)

**Macro:** biblioteca de templates HSM aprovados, usável tanto em campanha quanto no atendimento 1-a-1.

**Detalhe (mobile):**
- Tela **"Escolher template"** com seletor do número remetente (`Eduarda-105` + link `Trocar`) e busca por nome.
- Lista de templates com título e preview do corpo contendo **variáveis `{{1}}`, `{{2}}`**.
- Exemplos reais da operação: `Boleto Prazo Em Análise`, `Boleto Prazo Aprovado`, `Boleto Prazo Recusado`, `Iniciar Atendimento`, `LA MEDITERRANEA LANÇAMENTO 12 07`, `LA MEDITERRANEA CAMPEAO FIEL RECENTES...`.
- Tela **"Enviar template"**: preview renderizado do texto final, destinatário (`Para VEST FACIL MODAS LTDA · 5567999688755`) e **aviso de custo destacado**:
  > *"Cada template entregue tem custo cobrado pela Meta (marketing, utilidade e autenticação). Só respostas dentro da conversa aberta são grátis. Enviar muitos em sequência aumenta o risco de o número ser limitado."* + link **"Entenda as tarifas"**.

> Educar o usuário sobre custo e risco **no momento do clique** é uma decisão de UX excelente — reduz churn por susto de fatura e protege o número.

### 4.5 Demais itens do grupo

- **Mensagens Enviadas** — log de tudo que saiu (auditoria).
- **Contatos** — base do WhatsApp (distinta de "Contatos" da Gestão de Vendas, que é a base comercial).
- **Listas Personalizadas** — segmentos salvos para uso em campanha.
- **Performance de Atendimento** — produtividade por atendente/número.
- **WhatsApp Flows** `NOVO` + **Respostas dos Flows** — formulários nativos do WhatsApp e as respostas coletadas como dados estruturados.
- **Configurações** — do grupo de números.

---

## 5. Gestão de Vendas (CRM)

### 5.1 CRM Clássico — funil de leads

- Kanban horizontal. Colunas observadas: **Leads (11.358)** · **Leads Qualificados** · …
- Contador por coluna com controle de ordenação.
- **Card do lead:** nome (ou o próprio número quando sem cadastro) · telefone formatado · **Responsável** (badge com nome ou `NÃO ATRIBUÍDO`) · **"Está no telefone: Janaina"** (em quais números da frota aquele contato existe) · UF (`PA`, `PE`) · botões rápidos **`Trab.` / `Desc.` / `Qualificado`** · data · botão de abrir conversa.

### 5.2 CRM Avançado — "CRM: Gestão de Leads e Clientes"

**Macro:** kanban por **estágio de relacionamento comercial**, não por etapa de negociação.

- Ações do topo: **Exportar** · **Filtros**.
- Colunas observadas: `Leads` · **`Clientes de 2 Pedidos` (566)** · **`Clientes 3+ Pedidos` (1.434)** · `Representantes` (0) · `Descartados`.
- **Card do cliente:** nome · telefone · ⭐ (favorito/principal) · 📅 **Última compra** · **Responsável** + **tempo desde o último toque** (`25 min`, `4 min`, `3 meses`) · "Está no telefone: …" · UF · **badge de segmento RFV** (`Campeão`, `Potencial Fiel`, `Não Perder`, `Em Risco`) · **valor R$** · status (`Ativo` / `Perdido`) · ação de abrir conversa.
- Coluna vazia mostra estado "Nenhum contato encontrado".

> O eixo do funil é **quantidade de pedidos**, coerente com atacado recorrente. Combinado ao RFV no card, o vendedor vê em um olhar quem está esfriando.

### 5.3 Ficha do cliente — Web

Layout de duas colunas.

**Coluna esquerda — cadastro:**
- Nome/Razão Social + **"Ver todos os nomes"** (o mesmo CNPJ aparece com nomes diferentes nas várias fontes) + menu **Ações**.
- **Badges de estado:** `PERDIDO` · `Qualificado` / `Desqualificado` (com ⓘ) · **"Qualificado em: 23/02/2026, 20:25"** · `Atacado` / `Varejo`.
- **CONTATO:** múltiplos telefones, um marcado como **principal (estrela)**, ícone de adicionar contato por telefone; Instagram; E-mail — todos com "Editar" inline.
- **IDENTIFICAÇÃO:** Razão Social · **CNPJ (vários)** · CPF · Data de Aniversário.
- **ENDEREÇO:** Localização (`Feira Nova/PE`) · Endereço.
- **RELACIONAMENTO:** Nome do Contato · Nome da Empresa · canal (`WhatsApp Manual`) · vendedor responsável (`EDUARDA`) · **toggles `Campanhas — Recebe` e `Automações — Recebe`** (opt-out granular por tipo) · botão **Enviar Mensagem**.
- **Campos personalizados** (ex.: `Modalidade`) com "Adicionar".
- **Pessoas** — múltiplos contatos-pessoa vinculados à empresa.
- **Comportamento Online** — atividade do cliente no catálogo.
- **Informações de vendas:** Total em vendas · Primeira venda · Última venda · **Dias sem vendas (267)** · Quantidade de vendas · Ticket médio · **Média entre vendas (33.5 dias ⓘ)** · **Perfil RFV** (`Não Perder`).
- **Informações do Tailor:** "Está no telefone" com badge por número (`LAYLA (8189485620)`, `PIETA (8189752400)`).

**Coluna direita — atividade:**
- **Status do Contato** ⓘ
- **Conversas** (acesso ao histórico)
- **Tarefas (2)** — abas `Todas | Agendadas | Vencidas | Concluídas`; cada tarefa com data, título, **tipo `Follow-up`**, **canal `Whatsapp`**, responsável e descrição do que foi feito; concluídas aparecem riscadas; "Ver mais 10 tarefas".
- **Comentários** — anotação interna livre + "Salvar comentário".
- **Gráfico de vendas** — Valor (R$) x Data.
- **Categorias mais vendidas** — pizza (CONJUNTO 27%, MACACÃO 26,5%, CALÇA 24,5%, VESTIDO, BLUSA, CROPPED, Outras); **clicar abre modal "Itens da categoria: X"** com busca por SKU/produto e tabela Referência · Produto · Categoria · Qtd · Total (nível SKU-cor-tamanho: `08825-AZUL - AZUL-GG 44`).
- **Evolução do Segmento RFV** — gráfico de linha ao longo do tempo com o eixo Y na escala completa: Campeão → Clientes Fiéis → Potencial Fiel → Clientes Promissores → Clientes Recentes → Não Perder → Em Risco → Precisa de Atenção → Semi Perdido → Hibernando → **Perdido**. Link "Histórico de segmentação".

> **Onze faixas de RFV com histórico temporal** é o coração analítico do produto. Mostra a trajetória do cliente, não só a foto de hoje.

### 5.4 Ficha do cliente — Mobile

Mesma informação, reorganizada em cards verticais:
- Header: nome editável · telefone · badges `Em Risco` `Atacado` `Qualificado` · ações **▷ Trabalhar** / **✕ Descartar** · ícone de abrir conversa.
- **VENDAS:** Total em vendas · Pedidos · Ticket médio · Última compra · "Cliente desde".
- **CATEGORIAS MAIS COMPRADAS:** donut com total de peças (11) + lista com qtd e %.
- **TELEFONES:** lista com marcação de principal + "Adicionar telefone".
- **CADASTRO:** Vendedor responsável (navegável) · Instagram · E-mail · CNPJ · Cidade · "Está no telefone" · Criado em.
- **CAMPOS PERSONALIZADOS**.
- **HISTÓRICO DE VENDAS (1):** `Pedido 71691.2 · Pietà (Moda Center) · 06/10/25 · Fechada · R$ 1.500,80`.
- **TAREFAS (5)** com checkbox, data e responsável, "Carregar mais".
- **COMENTÁRIOS** — "Escreva uma anotação interna…".
- **HISTÓRICO DA CARTEIRA:** eventos `Atribuição — → EDUARDA` e `Remoção — → —` com data/hora. **Auditoria de posse do cliente.**
- **PREFERÊNCIAS:** toggles Campanhas / Automações.
- Ação de rodapé: **"Marcar como representante"**.

### 5.5 Tarefas / Fila do dia

- Mobile: navegação por dia (`‹ HOJE · SEGUNDA ›`), abas **`Agendadas (0)` | `Vencidas (143)` | `Concluídas (0)`** com contadores, filtro **"Todos os vendedores"**.
- Card de tarefa: checkbox de conclusão · título (`Oferecer reposição`, `Pós-venda 7 dias`) · descrição · **data e hora** · **canal (`Whatsapp`)** · **tipo (`Follow-up`)** · **Responsável** (nome ou papel genérico "Vendedor").
- Estado vazio: "Nenhuma tarefa agendada no período 🎉" + botão **"Ver 143 vencidas"**.
- Menu web tem ainda **Fila do dia** `NOVO` (lista priorizada de quem falar hoje) e **Gestão de Tarefas**.

### 5.6 Demais itens de Gestão de Vendas

- **Configurar Funis** — funis e etapas customizáveis.
- **Vendedores e Carteiras** — carteirização; quem é dono de quais clientes.
- **Gerenciar Metas** / **Metas por Vendedor**.
- **Minhas Sequências** — cadências de follow-up.
- **Funil de Vendas** e **Funil de Conversão** — relatórios de conversão etapa a etapa.
- **Leads e Conversão** `NOVO`.
- **NPS** `NOVO`.
- **Mapa de Clientes** — geolocalização da base.
- **Lista de Cidades** — cobertura geográfica.

---

## 6. Atendimento (mobile)

- Abas **`Meus atendimentos` | `Fila (99+)`**.
- **Busca por nome, telefone ou protocolo** — existe numeração de protocolo.
- Lista com avatar (`?` quando desconhecido), número, prévia ("Sem mensagens ainda"), data e bolinha de não lido.
- **Chat da fila:** header com nome + subtítulo de estado **"Na fila · aguardando atendimento"**; rodapé bloqueado com aviso **"Visualizando um atendimento da fila. Assuma para responder."** e botão **"Assumir atendimento"**.

> Modelo **pull**: o atendente enxerga a fila inteira em modo leitura e assume explicitamente. Evita colisão entre atendentes sem precisar de distribuição automática.

---

## 7. Catálogo, pagamentos e e-mail

- **Catálogo** — produtos com SKU estruturado (referência-cor-tamanho), categorias, preços; catálogo público com link compartilhável (`pietaoficial.com.br/catalogo/7f6a674b4ae6cd4`); rastreamento de **"Comportamento Online — atividade no catálogo"** por cliente.
- No modal de envio de mensagem existe **"Copiar catálogo"** — insere o link do catálogo na conversa em um clique.
- **Link de Pagamento** `🔒` e tab **Pagamentos** no app.
- **Dispare Emails** `NOVO` — campanhas por e-mail no mesmo produto.

---

## 8. IA de apoio ao vendedor (copiloto)

No modal **"Enviar Mensagem"** da ficha do cliente:
- Botões **`Copiar catálogo`** · **`💡 Gerar Ideia Atacado`** · **`🏪 Gerar Ideia Varejo`**.
- Campo de mensagem livre.
- **`PARA:`** seletor entre os telefones do contato · **`DE:`** número/vendedora remetente com selo **`✅ Telefone disponível`**.
- **"Sugestões de Mensagem"** geradas pela IA, numeradas, cada uma com botão **`Copiar e Enviar`**. As sugestões usam contexto real do cliente:
  > *"Tava olhando aqui e senti falta dos seus pedidos! Como estão as vendas por aí em Feira Nova? Sei que os conjuntos e macacões sempre fazem sucesso na Saturno Modas e preparei umas novidades que são a sua cara para a gente retomar nossa parceria. 🚀"*

> A IA lê **cidade, histórico de categorias compradas, nome da loja e tempo sem comprar** para escrever. É personalização com dados do ERP, não template genérico.

---

## 9. Automações e integrações

- Item de menu **Automações** (raiz) — motor de regras/gatilhos.
- **API de Integração ERP** — documentação pública em `/api/erp-webhook/docs`:
  - **Três fluxos independentes**, combináveis:
    | Fluxo | `data_type` | O que faz |
    |---|---|---|
    | Pedidos/Vendas | `orders` | Registra vendas, dados do cliente e itens vendidos |
    | Cadastro de Produtos + Estoque | `products` | Cadastra/atualiza catálogo e controla estoque |
    | Cadastro de Clientes | `customers` | Cadastra/atualiza base de clientes (sem vendas) |
  - `POST` · `Bearer Token` · `JSON`.
  - Seções documentadas: Autenticação · Endpoint · Campos do Pedido · Items Vendidos · Campos do Produto · Estoque · Campos do Cliente · Resposta · **Erros HTTP** · **Limites** · **Carga Histórica** · **Idempotência** · Formatos Aceitos · **Exemplos cURL**.
  - Token gerado em **`/automacoes → Tokens de Integração`**.

> Documentação de API com **idempotência e carga histórica** explícitas indica maturidade — foi desenhada para ERPs de terceiros integrarem sozinhos.

---

## 10. Plataforma / administração

- **Multi-filial** — números agrupados por filial, filtro "Todas as filiais" nos indicadores.
- **Multiusuário com papéis** — vendedores, responsáveis por carteira, filtro "Todos os vendedores".
- **Planos e upsell no produto** — cadeado `🔒` em Link de Pagamento e Retenção.
- **Novidades / changelog no app** — modal "Novidades (3)" com cards categorizados por badge (`CRM`, `WhatsApp`, `Análise ✨ Novidade`), data, **"Marcar como lido"**, **"Marcar tudo como lido"** e "Ver todos os artigos". Exemplos reais:
  - *CRM — "Defina quando um cliente é Ativo, Inativo ou Perdido"* (por dias sem comprar, configurável)
  - *WhatsApp — "WhatsApp cobrado em reais: tarifas e configuração"*
  - *Análise — "Relatórios por E-mail: seus números na caixa de entrada"* (resumo diário da operação por e-mail)
- **Solicitar Ajuda** fixo no rodapé do menu.
- Contador de notificações no avatar.

---

## 11. Síntese — o que este sistema faz de diferente

Cinco decisões de produto que valem copiar no GeraCRM:

1. **Atribuição de receita em tudo.** Campanha, tarefa e IA cada uma com R$ gerado, custo e ROI. O sistema prova o próprio valor toda vez que o dono abre a Home.
2. **Frota de números, não um número.** Cada vendedora tem o seu, agrupado por filial, com painel de saúde Meta (tier, billing, verificação) e contadores próprios. E o card do cliente mostra **em quais números ele existe**.
3. **RFV como espinha dorsal.** 11 segmentos, histórico de evolução por cliente, distribuição na base inteira e badge no card do kanban. O funil é por **quantidade de pedidos**, não por etapa de negociação — desenho certo para venda recorrente.
4. **Custo e risco explicados no clique.** O aviso de tarifa da Meta antes de enviar template, o badge `Janela Aberta`/`Janela Fechada` no header do chat, o campo "Gasto ≈" na tabela de campanhas.
5. **IA em duas camadas.** Agente autônomo que qualifica lead sozinho (com painel de auditoria e tempo de qualificação) **e** copiloto que escreve a mensagem usando histórico de compras, cidade e categorias do cliente.

### O que está ausente ou fraco nas telas vistas
- Sem construtor visual de fluxo de chatbot (existe "Automações" e "WhatsApp Flows", mas nenhuma tela de builder foi capturada).
- Sem setores/departamentos, SLA ou distribuição automática — a fila é 100% **pull** ("Assumir atendimento").
- Sem multiempresa/white-label aparente — é produto único, vertical em atacado de moda.
- Sem CSAT (existe NPS marcado como `NOVO`, sem tela capturada).
- Sem canais além de WhatsApp e Instagram Direct (e-mail é só disparo).

---

## 12. Ligação com o estudo de mercado

Cruzando com [`estudo-crms-whatsapp.md`](./estudo-crms-whatsapp.md):

| Módulo | Tailor | Média do mercado BR | Nota |
|---|---|---|---|
| Inbox multiatendente | ✅ pull, multi-número | ✅ com setores/filas automáticas | Tailor é mais simples |
| Funil Kanban | ✅✅ por nº de pedidos + RFV | ✅ por etapa de negociação | Tailor é superior para recorrência |
| Campanhas | ✅✅✅ com ROI 3/7/14d | ✅ métricas de entrega apenas | **Maior diferencial do Tailor** |
| Templates HSM | ✅✅ com aviso de custo | ✅ | Tailor é mais didático |
| IA | ✅✅ agente + copiloto | ⚠️ só agente | Tailor à frente |
| Chatbot visual | ❌ não visto | ✅ padrão | **Lacuna** |
| SLA / setores / CSAT | ❌ | ✅ | **Lacuna** |
| Multiempresa / white-label | ❌ | ⚠️ | Decisão de posicionamento |
| Integração ERP | ✅✅ API documentada | ⚠️ via Zapier/n8n | Tailor à frente |
| BI / RFV | ✅✅✅ | ❌ raro | **Maior diferencial do Tailor** |
