# GeraCRM — Especificação das telas críticas

> Deriva de [`escopo-funcional-geracrm.md`](./escopo-funcional-geracrm.md) e [`backlog-epicos-geracrm.md`](./backlog-epicos-geracrm.md).
> Cobre as **seis telas onde a operação vive**. As demais telas seguem os padrões definidos aqui.
> A seção 8 traduz cada tela em **exigência técnica** — é a ponte para o documento de stack.

**Escopo desta especificação:** estrutura, regiões, estados, transições e regras de negócio visíveis. **Não** é design visual (cor, tipografia, espaçamento) — isso vem depois, sobre esta base.

---

## 0. Padrões transversais

### 0.1 Estados obrigatórios de toda tela

Toda tela e todo bloco de dados precisa definir os cinco:

| Estado | Regra |
|---|---|
| **Carregando** | Esqueleto com a forma do conteúdo real, nunca spinner solto no centro |
| **Vazio** | Explica *por que* está vazio e oferece a ação seguinte. Nunca "nenhum resultado" isolado |
| **Erro** | Diz o que falhou, se é recuperável e o que fazer. Erro de integração nomeia o sistema de origem |
| **Sem permissão** | O elemento não aparece — não aparece desabilitado. Exceção: recurso não contratado, que aparece com cadeado como upsell (PLT-06) |
| **Parcial / degradado** | Dado principal carregou, dado secundário falhou. A tela funciona com aviso localizado, não quebra inteira |

### 0.2 Hierarquia de navegação

- **Web:** menu lateral de dois níveis, colapsável, com item ativo destacado e badges no item (`NOVO`, `META API`, `🔒`)
- **Mobile:** tab bar de 5 — Indicadores · Atendimento · Catálogo · CRM · Pagamentos — com sub-abas contextuais acima
- **Regra:** o app mobile **não é espelho do web**. É o recorte de campo. Toda tela mobile precisa justificar por que existe no bolso da vendedora

### 0.3 Identidade do contato na interface

O mesmo cliente chega por telefone, Instagram e CNPJ. Em **toda** superfície onde ele aparece, exibir nesta ordem de preferência: nome cadastrado → nome do WhatsApp → `@instagram` → número formatado. Nunca mostrar ID interno.

---

## 1. Inbox / Conversa (web) — a tela onde a vendedora passa o dia

**Épico:** EP-05, EP-16, EP-27 · **Onda:** 1 (base), 2 (pedido e funil)

### 1.1 Layout

```
┌─────────┬──────────────────┬──────────────────────────────┬─────────────────┐
│  MENU   │  LISTA           │  CONVERSA                    │  CONTEXTO       │
│ lateral │                  │                              │  (retrátil)     │
│         │ ┌──────────────┐ │ ┌──────────────────────────┐ │                 │
│         │ │(Janaina) ▾   │ │ │ VEST FACIL MODAS    ⧉    │ │ ┌─────────────┐ │
│         │ │ 5581914009   │ │ │ 🟢 Janela aberta · 4h12  │ │ │  CLIENTE    │ │
│         │ └──────────────┘ │ │ Funil de Leads ▾ · Novo  │ │ │ Em Risco    │ │
│         │ ┌──────────────┐ │ ├──────────────────────────┤ │ │ Atacado     │ │
│         │ │🔍 buscar     │ │ │                          │ │ │ R$ 21.817   │ │
│         │ └──────────────┘ │ │   ← recebida             │ │ │ 267d s/comp │ │
│         │ ○ só sem resposta│ │                          │ │ ├─────────────┤ │
│         │ ○ ordenar p/ msg │ │            enviada →     │ │ │  TAREFAS    │ │
│         │ ─ últimos 30d ─  │ │            ✓✓ 09:13      │ │ │  2 abertas  │ │
│         │ ┌──────────────┐ │ │                          │ │ ├─────────────┤ │
│         │ │Kleber   agora│ │ │   ▶ 0:12 áudio           │ │ │  ÚLTIMOS    │ │
│         │ │Lead · Vi que…│ │ │   "transcrição…"         │ │ │  PEDIDOS    │ │
│         │ ├──────────────┤ │ │                          │ │ ├─────────────┤ │
│         │ │Marília  09:18│ │ ├──────────────────────────┤ │ │  CATEGORIAS │ │
│         │ │JANAINA·1 ped │ │ │ [+] mensagem…    🎤  ➤   │ │ │  compradas  │ │
│         │ │📎 Arquivo    │ │ │ Ctrl+Enter para enviar   │ │ └─────────────┘ │
│         │ └──────────────┘ │ └──────────────────────────┘ │  [🛒 Pedido]    │
└─────────┴──────────────────┴──────────────────────────────┴─────────────────┘
   240px          320px                  flexível                  360px
```

### 1.2 Coluna A — Lista de conversas

| Elemento | Comportamento |
|---|---|
| **Seletor de número** | Dropdown com a frota que o usuário pode ver. Mostra nome amigável + número. Se o usuário tem 1 número só, vira rótulo estático |
| **Busca** | Nome, telefone e **protocolo**. Busca no servidor, com debounce; resultado substitui a lista com "voltar à lista" |
| **`Só sem resposta`** | Filtra conversas cuja última mensagem é do cliente. É o filtro mais usado do dia |
| **`Ordenar por msg do cliente`** | Ordena pela última mensagem *recebida*, não pela última do thread |
| **Recorte temporal** | Rótulo fixo "últimos 30 dias". Não é filtro — é aviso de que a lista tem limite |
| **Item de conversa** | Nome · horário · **fileira de badges** · prévia de 1 linha · marca de não lido |

**Badges do item** (ordem fixa, para virar leitura periférica):
`estágio` (Lead / Lead Qual.) → `vendedora dona` → `histórico` (1 pedido / 3+ pedidos) → `quem conduz` (IA / humano) → `tipo do último conteúdo` (📎 Arquivo, 🖼 Imagem, 🎤 Áudio)

**Estados:** carregando (10 esqueletos) · vazio com filtro (oferece limpar filtro) · vazio sem filtro ("nenhuma conversa neste número em 30 dias") · erro de conexão do número (**banner no topo da lista**, não modal).

### 1.3 Coluna B — Conversa

**Header** — três linhas fixas, sempre visíveis:
1. Nome do contato + link para a ficha completa (`⧉` abre em nova aba)
2. **Badge da janela de 24h** — `🟢 Janela aberta · faltam 4h12` ou `🔴 Janela fechada`, com contagem regressiva ao vivo
3. **Seletor de funil e etapa** — muda o estágio sem sair da conversa

**Corpo:**
- Balões com hora e status (`✓` enviado, `✓✓` entregue, `✓✓` azul lido, `⚠` falha com motivo ao clicar)
- Áudio com player inline: play, duração, velocidade, e **transcrição abaixo** quando disponível (IA-03)
- "Carregar mais 30 dias" no topo, sob demanda — nunca scroll infinito para trás
- Mensagem de campanha aparece marcada com o nome da campanha

**Composer — dois modos, e a transição entre eles é a regra mais importante da tela:**

| Janela | Composer |
|---|---|
| **Aberta** | Campo livre · `+` (anexo, catálogo, pedido) · 🎤 gravar · ➤ enviar · dica `Ctrl+Enter` |
| **Fechada** | Campo livre **bloqueado**, com explicação de uma linha e **botão "Escolher template"** em destaque. Nunca deixar digitar para falhar no envio |

**Transição:** quando a janela fecha durante a conversa aberta na tela, o composer troca **sem recarregar** e sem perder o rascunho digitado — o texto é preservado e oferecido para colar no template.

### 1.4 Coluna C — Contexto (retrátil)

Resumo do cliente sem sair da conversa: estado (segmento RFV, Atacado/Varejo, Ativo/Perdido) · total em vendas e **dias sem comprar** · tarefas abertas · últimos pedidos · categorias mais compradas · botão **`🛒 Pedido`** que abre o painel da seção 2.

Retrátil porque em tela de 13" a conversa fica estreita demais com quatro colunas. Estado da retração é lembrado por usuário.

### 1.5 Interações-chave

| Ação | Comportamento |
|---|---|
| Nova mensagem recebida | Entra em tempo real, sem recarregar. Se a conversa não está aberta, incrementa não lido e toca som |
| Conversa aberta por outro atendente | Aviso no topo da conversa em tempo real: "Eduarda está nesta conversa" |
| Envio falha | O balão permanece com `⚠` e ação "tentar novamente" — nunca some |
| Mudança de etapa no funil | Aplica imediato, com desfazer por 5s |

---

## 2. Painel de Pedido (dentro da conversa)

**Épico:** EP-27 · **Onda:** 2

A tela que fecha a venda. Abre **sobre a coluna de contexto** no web; como folha deslizante no mobile.

### 2.1 Layout (web)

```
┌──────────────────────────────────────┬────────────────────────────────┐
│  CONVERSA                            │  PEDIDO · rascunho             │
│                                      │  VEST FACIL MODAS LTDA         │
│  Cliente: manda o conjunto laila     │  Tabela: ATACADO · Prazo 30d   │
│  no G, e a karine M                  │  Crédito: R$ 8.000 disponível  │
│                                      │ ┌────────────────────────────┐ │
│                                      │ │🔍 referência, SKU ou nome  │ │
│                                      │ └────────────────────────────┘ │
│                                      │ ┌────────────────────────────┐ │
│                                      │ │22625 CONJUNTO LAILA        │ │
│                                      │ │  ROSA  P38 ─ M40 ─ G42 ─   │ │
│                                      │ │        [1]   [2]   [2]     │ │
│                                      │ │  VERDE P38 ─ M40 ─ G42 ─   │ │
│                                      │ │        [ ]   [1]   [ ]  ⚠3 │ │
│                                      │ │  R$ 146,00 un · 6 un       │ │
│                                      │ ├────────────────────────────┤ │
│                                      │ │08825 CONJUNTO KARINE       │ │
│                                      │ │  PRETO M40 [1]             │ │
│                                      │ │  R$ 115,00 un · 1 un       │ │
│                                      │ └────────────────────────────┘ │
│                                      │  ─────────────────────────     │
│  [+] mensagem…            🎤  ➤      │  7 peças · R$ 991,00           │
│                                      │  ⚠ Mínimo 10 peças — faltam 3  │
│                                      │  [ Salvar rascunho ]           │
│                                      │  [ Enviar ao GeraCloud ]  ⊘    │
└──────────────────────────────────────┴────────────────────────────────┘
```

### 2.2 Regiões

| Região | Conteúdo | Regra |
|---|---|---|
| **Cabeçalho** | Cliente · **tabela de preço aplicada** · condição de pagamento · **crédito disponível** | Vem do ERP em leitura ao vivo (INT-01b). Se o crédito estiver bloqueado, o cabeçalho fica vermelho e o botão de enviar desabilita **antes** de a vendedora montar |
| **Busca de produto** | Por referência, SKU, nome, categoria | Resultado mostra foto pequena, referência, preço da tabela do cliente e saldo |
| **Item na grade** | Matriz cor × tamanho com campo de quantidade por célula | Célula sem estoque fica desabilitada com o saldo em tooltip. Célula com saldo menor que o pedido mostra `⚠` com o disponível |
| **Rodapé de totais** | Peças · valor · **validações pendentes** | Cada regra violada vira uma linha explicando **o que falta**, não só "inválido" |
| **Ações** | Salvar rascunho · Enviar ao GeraCloud | Enviar fica desabilitado enquanto houver validação pendente, com o motivo no hover |

### 2.3 Validações (PED-05) — sempre dizem o que falta

```
⚠ Mínimo 10 peças — faltam 3
⚠ CONJUNTO LAILA vende em grade fechada (P38+M40+G42) — falta 1 P38
⚠ Mix mínimo: 2 categorias — só CONJUNTO selecionado
⚠ VERDE G42: pedido 3, disponível 1
```

### 2.4 Estados do pedido

```
   rascunho ──► validando ──► enviando ──► EFETIVADO (nº do ERP)
       ▲                          │
       └──────────────────────────┘
              falhou (PED-08)
```

**O estado `falhou` é o mais importante da tela.** Regras:
- O rascunho **nunca é perdido** — permanece intacto e editável
- O erro é **tipificado e acionável**, não genérico:

| Erro do ERP | O que a tela mostra | Ação oferecida |
|---|---|---|
| Estoque esgotou entre montar e enviar | "VERDE G42 não tem mais saldo (0 disponível)" | Ajustar quantidade · remover item |
| Crédito bloqueado | "Crédito insuficiente: pedido R$ 991, disponível R$ 400" | Solicitar liberação · reduzir pedido |
| Item inativado | "08825 foi inativado no ERP" | Remover item · buscar substituto |
| Cliente sem cadastro fiscal | "Cliente sem CNPJ cadastrado no ERP" | Abrir ficha para completar |
| Erro de comunicação | "GeraCloud não respondeu" | **Tentar novamente** — com idempotência garantida (PED-07), reenviar não duplica |

### 2.5 Efetivado

Ao efetivar: número do pedido do ERP exibido em destaque · **resumo formatado oferecido para enviar na conversa** (PED-10, ação sugerida, não automática) · **vínculo gravado** com conversa, campanha de origem e tarefa (PED-09) · opção de gerar link de pagamento (PED-12, Onda 3).

### 2.6 Mobile

Folha deslizante de baixo para cima, em três passos, porque a grade não cabe na largura:
1. **Buscar produto** — lista com foto, referência, preço, saldo
2. **Escolher grade** — matriz cor × tamanho em rolagem horizontal, com célula grande o suficiente para o polegar
3. **Revisar e enviar** — itens, totais, validações, ações

Rascunho sincroniza entre web e mobile (PED-06): começar no celular no showroom e terminar no computador precisa funcionar.

---

## 3. Ficha do Cliente

**Épico:** EP-04, EP-09 · **Onda:** 0 (base), 2 (analítico)

### 3.1 Web — duas colunas

```
┌────────────────────────────────┬──────────────────────────────────────┐
│  CADASTRO                      │  ATIVIDADE                           │
│                                │                                      │
│  SATURNO E ALVES LTDA          │  ┌ TAREFAS (2) ──────────────────┐   │
│  ▾ ver todos os nomes          │  │ Todas·Agendadas·Vencidas·Conc.│   │
│  [Perdido][Qualificado]        │  │ ○ 10/08 VERIFICAR ACESSO…     │   │
│  [Atacado][Varejo]             │  │   Follow-up·WhatsApp·Eduarda  │   │
│  Qualificado em 23/02/26 20:25 │  └───────────────────────────────┘   │
│  ────────────────────────────  │  ┌ COMENTÁRIOS ──────────────────┐   │
│  CONTATO                       │  │ anotação interna…             │   │
│  ★ 55 81 99861-7049            │  └───────────────────────────────┘   │
│    55 81 99930-8490            │  ┌ VENDAS ───────────────────────┐   │
│    @saturno_modasfn            │  │ ▁▃▅▂▇▁ gráfico no tempo       │   │
│  ────────────────────────────  │  └───────────────────────────────┘   │
│  IDENTIFICAÇÃO                 │  ┌ CATEGORIAS ───────────────────┐   │
│  CNPJ 60.631.000/0014-30       │  │  ◕ CONJUNTO 27% ← clicável    │   │
│       06.063.100/0001-43       │  │    MACACÃO 26% · CALÇA 24%    │   │
│  ────────────────────────────  │  └───────────────────────────────┘   │
│  RELACIONAMENTO                │  ┌ EVOLUÇÃO RFV ─────────────────┐   │
│  Vendedora: EDUARDA            │  │ Campeão ●─●                   │   │
│  ⦿ Campanhas    Recebe         │  │ Fiéis      ●──●               │   │
│  ⦿ Automações   Recebe         │  │ Não Perder      ●─────●       │   │
│  [ Enviar Mensagem ]           │  └───────────────────────────────┘   │
│  ────────────────────────────  │                                      │
│  VENDAS                        │                                      │
│  Total R$ 21.817,60            │                                      │
│  Dias sem vendas 267           │                                      │
│  Média entre vendas 33,5d ⓘ    │                                      │
│  RFV: [Não Perder]             │                                      │
│  ────────────────────────────  │                                      │
│  ESTÁ NO TELEFONE              │                                      │
│  [LAYLA][PIETA][JANAINA]       │                                      │
└────────────────────────────────┴──────────────────────────────────────┘
```

### 3.2 Blocos e regras

| Bloco | Regra específica |
|---|---|
| **Múltiplos nomes** | O mesmo CNPJ chega com nome diferente de cada fonte (ERP, WhatsApp, catálogo). Mostrar o preferido e revelar os outros sob demanda |
| **Múltiplos telefones** | Um marcado como principal (★). O principal é o padrão de envio |
| **Múltiplos CNPJs** | Grupo econômico é comum no atacado. Todos visíveis, um marcado como fiscal |
| **Preferências** | Toggles independentes `Campanhas` e `Automações`. Desligar aqui **bloqueia em todos os módulos**, sem exceção — inclusive disparo manual em lote |
| **Está no telefone** | Badge por número da frota onde o contato existe. Clicável: abre a conversa naquele número |
| **Métricas** | `Dias sem vendas` e `Média entre vendas` lado a lado — a comparação é o insight (267 dias com média de 33,5 = cliente perdido, não atrasado) |
| **Categorias** | Clicar na fatia abre modal com os itens daquela categoria, até SKU-cor-tamanho, com busca |
| **Evolução RFV** | Linha do tempo nas 11 faixas. É o bloco que explica *por que* o cliente está onde está |
| **Histórico da carteira** | Eventos de atribuição e remoção com data, hora e autor. Auditoria de posse |

### 3.3 Mobile

Mesma informação em cards verticais empilhados, nesta ordem — a ordem é a prioridade de campo:
header com badges e ações `▷ Trabalhar` / `✕ Descartar` → **Vendas** → **Categorias** (donut) → Telefones → Cadastro → Campos personalizados → Histórico de vendas → Tarefas → Comentários → Histórico da carteira → Preferências → `Marcar como representante`.

---

## 4. Kanban CRM

**Épico:** EP-08 · **Onda:** 2

Dois kanbans com a mesma mecânica e eixos diferentes:

| Kanban | Colunas |
|---|---|
| **Funil de Leads** | Lead · Qualificado · Trabalhando · Descartado |
| **Funil de Relacionamento** | Lead · 1 pedido · 2 pedidos · 3+ pedidos · Representantes · Descartados |

### 4.1 Card

```
┌────────────────────────────────────┐
│ CIRLANEIDE                      ⭐ │
│ +55 (88) 99965-3875                │
│ 📅 Última compra: 17/07/2026       │
│ Responsável: [EDUARDA] · 0 min     │
│ Está no telefone: Eduarda, Sandy+3 │
│ ┌──┐ ┌────────┐ ┌────────┐ ┌────┐ │
│ │CE│ │Campeão │ │R$70.238│ │Ativo│ │
│ └──┘ └────────┘ └────────┘ └────┘ │
│                              [ ⧉ ] │
└────────────────────────────────────┘
```

**Leitura em três segundos:** quem é · quando comprou · quem é o dono e **há quanto tempo não toca** · onde está no RFV · quanto vale · se está ativo.

O **tempo desde o último toque** é o dado mais acionável do card, e é o que o gestor varre visualmente.

### 4.2 Comportamento

- Colunas com contador e **carregamento sob demanda** — coluna com 11.358 leads não carrega inteira
- Arrastar entre colunas dispara automação da etapa (CRM-10), com desfazer por 5s
- Mover para `Descartado` **exige motivo** (CRM-09) — modal bloqueante, é o único caso justificado
- Filtros e exportação no topo; filtro aplicado fica visível como chip removível

---

## 5. Fila do Dia

**Épico:** EP-10, EP-22 · **Onda:** 2 (tarefas), 4 (motor de priorização)

A tela que responde "com quem eu falo agora". Na Onda 4, com priorização automática e mensagem sugerida.

```
┌──────────────────────────────────────────────────────┐
│  ‹  HOJE · SEGUNDA, 10 AGO  ›       [Todos vend. ▾]  │
│  ┌──────────┬──────────┬──────────┐                  │
│  │Agendadas │ Vencidas │Concluídas│                  │
│  │   (12)   │  (143)   │   (8)    │                  │
│  └──────────┴──────────┴──────────┘                  │
│  ┌────────────────────────────────────────────────┐  │
│  │ ○ SATURNO E ALVES                    R$ 21.817 │  │
│  │   Em Risco · 267 dias sem comprar              │  │
│  │   Oferecer reposição · Follow-up · WhatsApp    │  │
│  │   ┌──────────────────────────────────────────┐ │  │
│  │   │ 💡 "Tava olhando aqui e senti falta dos  │ │  │
│  │   │ seus pedidos! Como estão as vendas em    │ │  │
│  │   │ Feira Nova?…"                            │ │  │
│  │   │            [ Editar ]  [ Abrir conversa ]│ │  │
│  │   └──────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**Regras:**
- Ordenação (Onda 4): risco de churn × valor esperado de reativação × tempo sem toque
- A **mensagem sugerida vem junto do item**, editável antes de enviar — nunca envia sozinha
- Concluir a tarefa exige **registro do que foi feito**, que vira histórico do cliente
- Estado vazio comemora e oferece a próxima ação: *"Nenhuma tarefa agendada 🎉"* + `Ver 143 vencidas`
- **Fechamento do ciclo (D1):** o resultado do toque é medido — respondeu? comprou? — e volta como aprendizado da priorização

---

## 6. Home / Indicadores

**Épico:** EP-14 · **Onda:** 2

```
┌───────────────────────────────────────────────────────────────────┐
│ [Hoje][Ontem][7 dias][Sem.ant][Mês ant][ESTE MÊS][Personalizado]  │
│ [⌂ Todas as filiais ▾]                                        ⚙   │
├───────────────┬───────────────┬───────────────────────────────────┤
│ Vendas        │ Ticket Médio  │ Clientes                          │
│ R$ 348.877    │ R$ 760,08     │ 225                               │
│ 459 pedidos   │               │ 22 novos · 203 recorrentes        │
├───────────────┼───────────────┼─────────────────┬─────────────────┤
│📣 CAMPANHAS   │☑ TAREFAS      │🤖 IA            │👤 VIRARAM CLIENTE│
│ R$ 250.298    │ R$ 157.820    │ 399 leads       │ 2               │
│ custo R$1.357 │ 111 clientes  │ 121 qual · 30%  │ R$ 3.673        │
│ 184.5x        │               │                 │                 │
├───────────────┴───────────────┴─────────────────┴─────────────────┤
│  Vendas no período      [◻ Comparar ano anterior]   │  RANKING    │
│  ▁▃█▂▇▃█▁▅  R$ + linha de qtd. clientes             │  1 Janaina  │
├─────────────────────────────────────────────────────┤  2 Mari     │
│  Tabela de Vendas          [Recentes][Todos]        │  [Vend|Cli] │
└─────────────────────────────────────────────────────┴─────────────┘
```

**A linha dos quatro cards de atribuição é o coração da tela** — é onde o produto prova o próprio valor. Regras:
- Campanhas mostra **custo e retorno**, não só receita
- Cada card é clicável e leva ao detalhamento
- Onda 4: card adicional de **ROI da própria ferramenta** (BI-11)
- Receita atribuída de forma **exata** (pedido nascido na conversa) e **estimada** (janela 3/7/14d) são exibidas separadas, com legenda — jamais somadas sem distinção

---

## 7. Fila de Atendimento (mobile)

**Épico:** EP-06 · **Onda:** 1

```
┌───────────────────────────┐   ┌───────────────────────────┐
│  Atendimentos          A³ │   │ ‹  Ale                  ⋮ │
│ ┌──────────┬────────────┐ │   │    Na fila · aguardando   │
│ │  Meus    │ Fila (99+) │ │   ├───────────────────────────┤
│ └──────────┴────────────┘ │   │                           │
│ 🔍 nome, telefone, protoc.│   │  ┌─────────────────────┐  │
│ ┌───────────────────────┐ │   │  │ mensagem recebida   │  │
│ │ ? 5511956543016  26/01│ │   │  └─────────────────────┘  │
│ │   Nova coleção…     ● │ │   │                           │
│ ├───────────────────────┤ │   ├───────────────────────────┤
│ │ ? 5513996049845  26/01│ │   │ 👁 Visualizando da fila.  │
│ │   Sem mensagens ainda │ │   │    Assuma para responder. │
│ └───────────────────────┘ │   │ ┌───────────────────────┐ │
│                           │   │ │  Assumir atendimento  │ │
│ [Ind][ATEND][Cat][CRM][$]│   │ └───────────────────────┘ │
└───────────────────────────┘   └───────────────────────────┘
```

**O modelo pull é a decisão central:** o atendente vê a fila inteira em **modo leitura** e assume explicitamente. Isso evita colisão sem precisar de distribuição automática — que só chega na Onda 3 (INB-21).

Ao assumir: composer libera · conversa sai da fila em tempo real para os outros · vai para "Meus atendimentos" · registra quem assumiu e quando.

---

## 8. O que estas telas exigem da stack

Esta seção é a entrada do próximo documento. Cada exigência abaixo nasce de uma tela concreta, não de preferência técnica.

| # | Exigência | Origem | Por quê |
|---|---|---|---|
| **1** | **Tempo real bidirecional** | Inbox (§1.5), Fila (§7) | Mensagem nova, conversa assumida por outro, aviso de colisão, contador de não lido. Polling não atende — a vendedora fica com a tela aberta o dia inteiro |
| **2** | **Contagem regressiva de janela por conversa** | Inbox (§1.3) | Estado derivado do timestamp da última mensagem do cliente, precisa virar no cliente sem round-trip, e **mudar o composer** ao expirar |
| **3** | **Leitura síncrona ao ERP com latência baixa** | Pedido (§2.2) | Saldo por SKU, tabela de preço e crédito consultados **durante a montagem**. Carga em lote não serve. Define o contrato do INT-01b |
| **4** | **Escrita transacional idempotente** | Pedido (§2.4) | Reenviar após falha não pode duplicar pedido. Erro precisa voltar **tipificado**, não como string |
| **5** | **Rascunho persistente multi-dispositivo** | Pedido (§2.6) | Começar no celular, terminar no desktop. Estado de rascunho é do CRM, não do navegador |
| **6** | **Histórico de mensagens paginado para trás** | Inbox (§1.3) | Volume alto por conversa; carregar sob demanda em blocos de 30 dias |
| **7** | **Listas grandes com carregamento sob demanda** | Kanban (§4.2) | Coluna com 11 mil cards. Nunca carregar coluna inteira |
| **8** | **Analítico separado do transacional** | Ficha (§3), Home (§6) | RFV com histórico, evolução de segmento, categorias com drill-down até SKU, atribuição 3/7/14d. Consulta pesada não pode competir com o inbox |
| **9** | **Offline com fila de sincronização** | Pedido mobile (§2.6, Onda 3) | Showroom e feira sem sinal. Exige resolução de conflito quando o saldo mudou |
| **10** | **Isolamento por tenant em toda consulta** | Transversal | Decisão registrada (PLT-03). Precisa ser garantido pela camada, não pela disciplina do desenvolvedor |
| **11** | **Mídia: upload, armazenamento e entrega** | Inbox (§1.3), Catálogo | Áudio, imagem, PDF, vídeo em volume, com transcrição assíncrona |
| **12** | **Processamento assíncrono com throttling por número** | Campanhas (Onda 3) | Disparo distribuído pela frota, com intervalo randômico e limite diário por número |

---

## 9. O que ainda não está especificado

Telas que seguem os padrões da seção 0 e serão detalhadas na onda correspondente:

- **Onda 1:** Meus Telefones (frota e saúde) · configurações de número
- **Onda 2:** Catálogo · Metas e ranking · Templates
- **Onda 3:** Construtor de campanha · Painel de agentes de IA · Visão de Mercado (Venn) · Tira-pedidos offline
- **Onda 4:** Builder visual de fluxo · SLA e CSAT · Trilhas de capacitação · Painel de revenda
