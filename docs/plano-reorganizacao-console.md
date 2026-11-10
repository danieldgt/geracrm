# Plano — reorganização do console (layout, telas repetidas, formulários)

> Revisão de 2026-11-05 sobre `main` (`383c118`), com o console rodando local (1454 e 1667 px de janela,
> tema escuro) e leitura do código de `apps/console`. Lentes: skills `impeccable` (crítica e `distill`) e
> `taste-skill` (captura e medição), com `geracrm-layout-ui` e `geracrm-formularios` vencendo em conflito.
> Pedido do dono: organizar o produto, fundir telas e formulários que fazem a mesma coisa, consertar o
> layout onde o chat do WhatsApp aparece e adotar um padrão de formulário tradicional, com modal.
>
> Plano **vivo**: a §6 é o quadro de estado. Cada onda é uma raia com teste; nada sai do ar sem redirect.

---

## 0. Resumo

- **O menu tem 50 entradas em 8 grupos, para umas 20 tarefas.** Há telas diferentes que respondem à mesma
  pergunta com réguas diferentes. Quatro respondem "onde a base está no ciclo de recompra?" (Segmentos,
  Retenção, CRM Avançado e o bloco RFV de Mercado). Quatro mostram vendas e ranking (Início, Painéis BI,
  Relatórios e Mercado). A qualificação do lead é mudada em quatro lugares. A proposta da §3 leva o menu a
  **21 entradas**, com abas no lugar de telas irmãs. Nenhuma função some.
- **O chat quebra a tela de duas formas** (§1). No modo "empurrar", a tela ao lado fica com 657 px: os
  filtros quebram em quatro linhas, um cartão fica sozinho e a tabela quebra em três linhas por célula. No
  modo "sobrepor", o chat cobre a barra do topo e o conteúdo sem véu nem Esc. Nos dois, o nome do contato
  fica com 71 px ("Lead Fo…") porque três botões de três estilos disputam o cabeçalho.
- **Formulário: o modal já é maioria**, com 23 telas em `ui-modal`. O que parece esquisito são as exceções:
  - painéis com "Salvar" no meio da tela (Agente, Configurações, Config. do Canal);
  - dois modelos de salvar na mesma tela (no Agente, o Modo aplica no clique e o resto espera o "Salvar");
  - moldura de largura diferente por tela (Agente e Cadastro de Produtos a 960 px centrados, o resto em
    largura cheia);
  - barras de 9 botões com 3 cheios (ficha do contato).

  A regra nova está na §4.

---

## 1. O chat do WhatsApp (o que está quebrado)

Evidência: `/pedidos` e `/contato/:id` com o rail aberto, janela de 1667 px, rail com 760 px salvos.

| # | Gravidade | O que acontece | Onde |
|---|---|---|---|
| C1 | P1 | No modo **empurrar**, o conteúdo cai para 657 px. Filtros e "De/Até" quebram em 4 linhas, o cartão "Falharam" fica órfão e a célula "0 itens · 0 pç" ocupa 3 linhas. Nada impede que o rail coma a tela | `chat-rail.componente.ts` (`.rail.aberto { width: var(--rail-w) }`), `shell.componente.ts` (grade `auto 1fr auto`) |
| C2 | P1 | No modo **sobrepor**, o painel é `position: fixed` com z 60. Cobre a barra do topo (sino, conta, tempo real) e a lateral da ficha, sem véu e sem Esc. O conteúdo atrás continua clicável | `chat-rail.componente.ts` (`.rail.aberto.sobrepor`) |
| C3 | P1 | No cabeçalho da conversa (459 px), o nome fica com 71 px e o status ("WhatsApp não…") é cortado. "Montar pedido" (pílula cinza), "Agendar reunião" (contorno) e "Assumir" (cheio laranja) quebram em duas linhas, com o cabeçalho a 83 px | `inbox.pagina.ts` `.topo` / `.topo-acoes` |
| C4 | P2 | **"Conversas" aparece duas vezes**: a faixa "CONVERSAS" do rail e o título da lista do inbox | `chat-rail.componente.ts` `.cab` + `inbox.pagina.ts` `.barra` |
| C5 | P2 | **Dois itens ativos no menu**: "Conversas" (rail aberto) e a rota atual usam a mesma classe `.ativo` | `shell.componente.ts:85` |
| C6 | P2 | O botão de modo é um glifo unicode (`⧉` / `⇥`), sem rótulo visível. A escolha empurrar × sobrepor é um ajuste que ninguém entende | `chat-rail.componente.ts:65` |
| C7 | P3 | A paleta própria `--wa-*` e as cores literais (`#25d366`, `#14e39c`, `#e0b341`, `#fff` nos avatares) fazem o chat parecer outro produto. Nos tokens já existem `--sucesso`, `--atencao` e `--erro` | `inbox.pagina.ts`, `chat-rail.componente.ts` |
| C8 | P2 | A ficha do contato tem a aba **WhatsApp**, que só mostra o número e "Abrir no chat". É a mesma coisa que o botão "Conversar" do topo da ficha | `ficha-whatsapp.componente.ts` |

**Correção (onda R0):**

1. **Um comportamento só, decidido pela largura, sem botão de modo.** Se ao empurrar o conteúdo continuar
   com ≥ 960 px, empurra. Abaixo disso, o rail vira **gaveta sobreposta com véu, Esc e foco preso**, sem
   cobrir a barra do topo (`top: var(--altura-barra-topo)`). A largura salva é limitada pela janela, e o
   puxador continua.
2. **O cabeçalho da conversa dá prioridade ao nome.** Ficam visíveis **um primário** (Assumir, ou o selo do
   atendimento) e um botão-ícone de pedido. Agendar, devolver, reatribuir e SLA vão para um menu "⋯".
   Container query no `.conversa`: abaixo de 520 px os rótulos viram só ícone com `aria-label`.
3. **Um título só.** A faixa do rail sai, e o "recolher" passa para o cabeçalho da lista do inbox, como já
   acontece no celular.
4. **"Conversas" no menu** usa `aria-pressed` e um estilo de alternador (só o ícone muda), nunca o `.ativo`
   de rota.
5. A paleta `--wa-*` passa a derivar dos tokens do tema (superfícies e estados). A cor do avatar vem de uma
   lista de tokens.
6. **Sai a aba WhatsApp da ficha.** "Conversar" abre o rail na conversa.

Testes: `casca.regras.spec.ts` (a decisão empurrar ou gaveta como função pura da largura), teste de
cabeçalho com nome longo e o `cor-literal.spec.ts` sem exceção para o chat.

---

## 2. Telas: o que repete e o que é só parecido

Inventário pelo código: endpoints `/v1` de cada tela, blocos, ações e links internos. Os detalhes estão
nas tabelas abaixo.

### 2.1 Duplicado de verdade (mesmo dado, mesma ação)

| Grupo | Telas | O que repete |
|---|---|---|
| Vendas e ranking | Painéis (BI), Início, Relatórios → Vendas/Vendedores | Top clientes, top produtos e ranking por vendedor: o BI é um subconjunto de Relatórios |
| Contatos por dimensão | Mapa, Visão de Mercado, Relatórios → Contatos | Por UF (Mapa) e por origem (Mercado) já são abas de Relatórios. Só "top cidades" e "o quanto dá para agir" são novos |
| Ciclo de recompra | Segmentos RFV, Retenção, CRM Avançado, Mercado (RFV), coluna e filtro de segmento em Contatos | A mesma pergunta respondida com três réguas (RFV, dias, nº de pedidos) |
| Qualificação | CRM (Leads), CRM Avançado (1ª coluna), Contatos (coluna, filtro e lote), ficha (Qualificar/Descartar) | Todos chamam `PATCH /v1/leads/:id/qualificar` |
| Produtos | Catálogo, Cadastro de Produtos | A mesma lista de produtos: uma para consultar, outra para editar |
| Horário e equipe | Configurações Gerais (painéis Atendimento e Equipe), Config. do Canal, Usuários | O mesmo PUT de horário do número; a equipe só leitura repete Usuários |
| Atalhos | Configurações → abas Agente, Números, Playbook | São links que repetem o menu |
| Ficha | aba WhatsApp × botão Conversar | §1, C8 |

### 2.2 Parecidas, mas são entidades diferentes (não fundir; deixar a diferença visível)

- **Funil** (oportunidade) × **Painel de Atendimentos** (atendimento da conversa): são dois kanbans de
  objetos diferentes. Ficam separados, cada um no seu grupo, com nomes que digam o objeto.
- **Cockpit** × **Higienização da carteira**: o cockpit linka para a higienização, as duas são só da gestão
  e olham "sem próximo passo". Viram **abas da mesma tela**.
- **Tarefas** (follow-up) × **Agenda** (evento com horário, módulo opcional): duas visões do mesmo dia do
  vendedor, que viram **"Agenda e tarefas"** com Lista e Calendário (a aba Calendário só aparece com o módulo).
- **Sequências** × **Automações**: as duas são regras que geram ação, e viram uma tela com as abas Regras e
  Réguas.
- **Pedido Assistido** × **Pedidos**: são complementares, mas ficam lado a lado no menu. Fica só "Pedidos",
  com o primário "Novo pedido" levando a `/pedido`, que continua como rota (6 links apontam para ela).
- **Mensagens Enviadas** × detalhe da campanha: o log vira a aba "Enviadas" de Relatórios → WhatsApp.

---

## 3. Menu proposto (de 50 para 21 entradas)

Antes: 8 grupos e 50 itens, com "Atendimento" sozinho somando 13 (Consumo, Performance e Config. do Canal
dentro de Atendimento).

```
Início
Conversas                      (alternador do rail)
ATENDIMENTO
  Fila do Dia                  ← o vendedor começa aqui
  Painel de Atendimentos
  Pedidos                      [Novo pedido → /pedido]
  Campanhas                    abas: Campanhas · Templates
VENDAS
  Contatos                     (ficha, formulário de contato)
  Funil                        abas: Board · Qualificação (o kanban do CRM Leads) · Panorama
  Agenda e tarefas             abas: Lista · Calendário (módulo)
  Base                         abas: Segmentos RFV · Ciclo de recompra · Por nº de pedidos · Cashback · Visão de mercado
  Públicos                     abas: Listas · Opt-out/Bloqueios
CATÁLOGO E IA
  Catálogo                     busca + grade; Novo/Editar produto (só origem manual)
  Agente vendedor              5 grupos de abas (§3.1)
CRESCIMENTO
  Aquisição                    abas: Mídia paga · Formulários
  Automações                   abas: Regras · Réguas (sequências)
GESTÃO
  Cockpit                      abas: Agora · Carteira (higienização)        [só gestão]
  Metas
  Relatórios                   abas: Vendas · Contatos · Atendimento (Performance, NPS) · WhatsApp (+ Enviadas) · Comparativo · Raio-X · Imprimíveis
  Auditoria
Configurações                  abas: Empresa · Usuários e filiais · Números e canal · Atendimento (roteamento, SLA) ·
                                     Etiquetas e origens · Integrações (ERP, Webhooks, Importar, Sincronização) · Faturamento (Consumo)
PLATAFORMA (staff)
  Clientes
```

**Saem do menu e viram redirect** (`/rota-antiga` → `/destino?aba=x`, sem link quebrado):

| Rota | Vai para | Links internos a trocar |
|---|---|---|
| `bi` | `relatorios?aba=vendas` | nenhum |
| `mapa` | `relatorios?aba=contatos&dim=uf` (+ bloco top cidades) | nenhum |
| `mercado` | `base?aba=mercado` | linka para `/segmentos` |
| `performance`, `nps` | `relatorios?aba=atendimento` | nenhum |
| `mensagens` | `relatorios?aba=whatsapp&sub=enviadas` | nenhum |
| `crm` | `funil?aba=qualificacao` | nenhum |
| `crm-avancado` | `base?aba=pedidos` | nenhum (Descartar/Reabrir já existem em Contatos e na ficha) |
| `segmentos`, `retencao` | `base?aba=rfv` / `base?aba=ciclo` | 2 links (mercado, retenção) |
| `fidelidade` | `base?aba=cashback` | nenhum |
| `listas`, `bloqueios` | `publicos?aba=listas` / `publicos?aba=optout` | verificar |
| `carteira-higienizacao` | `cockpit?aba=carteira` | link do cockpit |
| `catalogo-produtos` | `catalogo` | nenhum |
| `pedido` (só o item de menu) | a rota fica; o menu aponta para `pedidos` | 6 links mantidos |
| `templates` | `campanhas?aba=templates` | verificar |
| `tarefas`, `agenda` | `agenda-e-tarefas?aba=lista` / `?aba=calendario` | notificação abre `/agenda` (o redirect resolve) |
| `sequencias` | `automacoes?aba=reguas` | nenhum |
| `midia`, `formularios` | `aquisicao?aba=midia` / `?aba=formularios` | subpáginas `/midia/anuncio/:id` e `/formularios/:id` ficam |
| `canal-config`, `numeros`, `usuarios`, `filiais`, `etiquetas-origens`, `integracao`, `sincronizacao`, `webhooks`, `importar`, `consumo` | `config/<aba>` | agente-config, canais, inbox, campanha-wizard, contato-form, clientes, agenda, e as notificações `/numeros` e `/consumo` (o redirect resolve). `importar` continua só da gestão dentro da aba |

### 3.1 Agente vendedor: de 10 abas para 5

As 10 abas de hoje rolam de lado, com a barra de rolagem à mostra.

| Grupo | Abas de hoje |
|---|---|
| Configurar | Configuração (9 seções) + Proteções |
| Ensinar | Conhecimento + Playbook |
| Testar | Playground |
| Acompanhar | Sessões + Decisões (auditoria por turno) |
| Qualidade | Qualidade + Revisão + Métricas (go-live) |

O seletor de número vai para o cabeçalho, ao lado do título. A página deixa a `.pagina` de 960 px e passa a
usar a largura cheia, como as outras telas de operação. Configurar tem **um modelo de salvar só**: o Modo
também espera o "Salvar", ou tudo aplica no clique com "Salvo". Nunca os dois.

---

## 4. Padrão de formulário (decisão de 2026-11-05)

**Criar e editar abre `ui-modal`** (padrão M; padrão A para uma ação sobre um registro). A
formulário-página (F) fica só para cadastro longo com seções ou passos: contato, wizard de campanha,
builder de formulário e importação. A regra está em `geracrm-layout-ui`, `impeccable/referencia/piso.md` e
`taste-skill`.

O que muda nas telas:

| # | Tela | Hoje | Vira |
|---|---|---|---|
| F1 | Ficha do contato | 9 botões numa linha (Editar, Conversar, Novo pedido, Nova tarefa, Agendar, Qualificar, Descartar, Anonimizar), 3 cheios em cores diferentes | **Conversar** (primário) · Editar · Novo pedido · "⋯" (Nova tarefa, Agendar, Qualificar, Descartar em perigo, Anonimizar LGPD por último) |
| F2 | Tarefas | 4 cartões de contagem que repetem as 4 abas + dois "Nova tarefa" | a contagem vai **no rótulo da aba** ("Atrasadas 3"); um "Nova tarefa" só, no cabeçalho |
| F3 | Pedidos | 4 cartões de contagem (o 4º órfão em outra linha) | a contagem vai no rótulo do filtro de estado; sem cartões |
| F4 | Agente → Configuração | 9 seções em painel, dois modelos de salvar | padrão C com um "Salvar" por seção e o Modo como o resto (ver §3.1) |
| F5 | Configurações Gerais / Config. do Canal | painel inline + lista de canais à esquerda com formulário à direita | padrão C (abas); editar um número abre o **modal do número** |
| F6 | Agente, Cadastro de Produtos, Perfil, Configurações | `.pagina` de 960 px ou `--largura-forma`, centrados | lista, kanban e operação em largura cheia; só formulário-página e Configurações usam `.pagina-forma`. Uma regra, escrita na skill |
| F7 | `ui-filtros` | quebra em 4 linhas abaixo de ~900 px; "Hoje · 7 dias · 30 dias · Mês atual · Mês passado" + De/Até repetidos em várias telas | container query: a busca ocupa a linha, os selects quebram em grade e o período vira **um** controle (`ui-filtro-periodo` com os atalhos dentro) |
| F8 | Modal "Nova tarefa" | a lista do campo Contato abre vazia ("Nada encontrado.") ao focar e cobre o campo Tipo | só abre a lista com 2+ caracteres digitados; posição sobreposta com sombra, nunca empurrando |
| F9 | Botões | o primário cheio laranja, o secundário em pílula cinza, o contorno arredondado e o "Descartar" rosa cheio, todos na mesma tela | `ui-botao` em 3 variantes (primário, secundário, perigo), uma ação cheia por área |

---

## 5. Ondas (o pipeline)

Cada onda é uma raia com teste (`pnpm lint typecheck test`) e captura antes e depois a 1280 e 1440, nos
dois temas. As ondas de fusão começam por `menu.ts` e `rotas.ts`, com redirect testado em `rotas.spec.ts`
(rota antiga → destino com a aba).

| Onda | O quê | Depende de decisão? |
|---|---|---|
| **R0 · Consertos** | §1 inteira (C1–C8); F1, F2, F3, F6, F7, F8 | não |
| **R1 · Fusões sem perda** | BI, Mapa, Performance, NPS e Mensagens → Relatórios; Catálogo + Cadastro; Pedido sai do menu; Configurações com abas (Empresa, Usuários e filiais, Números e canal, Atendimento, Etiquetas, Integrações, Faturamento); Higienização → Cockpit; Sequências → Automações; Mídia + Formulários → Aquisição; Templates → Campanhas | só os nomes |
| **R2 · Fusões com escolha de produto** | **Base** (Segmentos, Retenção, CRM Avançado, Mercado, Fidelidade); **Funil** ganha a aba Qualificação (CRM Leads); **Agenda e tarefas**; **Públicos**; Agente em 5 grupos (F4) | **sim** (§7) |
| **R3 · Padrão de formulário** | Auditoria de todos os `ui-modal`: rótulo acima, grade de 2 colunas, rodapé Cancelar → primário, 422 no campo, fecha com pergunta se houver dado digitado; F5 e F9 | não |

---

## 6. Quadro de estado

| Onda | Estado | Commit | Nota |
|---|---|---|---|
| Casca | feito | | `menu.ts` com `abas` e `ROTAS_ANTIGAS`; `TelaAbasPagina` + `TELA_EMBUTIDA`; notificações nas rotas novas; `menu-reorganizacao.spec.ts` |
| R0 | feito | | chat: empurra ou gaveta (`modoTrilho`), cabeçalho com "⋯", um título, sem `.ativo` duplo, tokens; ficha sem aba WhatsApp e com "⋯"; filtros e período por container query; select paginado abre com 2+ caracteres; Pedidos com abas de estado |
| R1 | feito | | Relatórios em 8 abas (BI, Mapa, Performance, NPS e Enviadas dentro); Configurações com 11 abas (Empresa sem os painéis duplicados; Atendimento com seletor de número); Catálogo único; Cockpit + Higienização; Aquisição; Automações + Réguas; Públicos |
| R2 | feito | | Base de clientes (5 abas; Por nº de pedidos sem a coluna de qualificação); Funil com Panorama, Oportunidades e Qualificação; Agenda e tarefas (contagem na aba); Agente em 5 grupos com um modelo de salvar |
| R3 | feito | | `ui-modal` pergunta antes de descartar o que foi digitado; foco no 1º campo com erro; erros fora do toast; 22 estados vazios sem segundo botão cheio; telefone e documento da ficha em modal |

Verificação (2026-11-05): `pnpm lint`, `pnpm typecheck` e `pnpm test` do console verdes (992 testes). Conferido no Chrome a 1670 px:
o chat como gaveta, o cabeçalho da conversa, o "⋯" da ficha, as telas com abas, os redirects (`/bi`, `/numeros`,
`/mensagens`, `/crm`) e a pergunta de descartar do modal.

**Pendências conhecidas:**
- **Celular (390) e tema claro:** não capturados.
- ~~**Busca do Catálogo**~~ resolvido em 2026-11-09: `GET /v1/catalogo/busca-inteligente` expõe a busca híbrida do agente (palavras, grafia aproximada, significado; teto de 30 com `truncado`; motivo quando a semântica está desligada). A tela do Catálogo usa por padrão com texto; "Por trecho" e "Mostrar inativos" voltam ao `ILIKE` paginado. O pedido assistido (`/v1/catalogo/busca`) ainda é `ILIKE`.
- **BI:** a quantidade vendida por produto, que só o BI mostrava, saiu.
- **Agente vendedor:** trocar de número com alterações não salvas não pergunta antes.

---

## 7. Decisões do dono (2026-11-05)

1. **Base:** uma tela com abas (Segmentos RFV, Ciclo de recompra, Por nº de pedidos, Cashback, Alcance).
2. **Qualificação (CRM Leads):** vira a aba "Qualificação" do Funil, mantendo o arrastar.
3. **Rail do chat:** empurra só quando o conteúdo continua com ≥ 960 px; abaixo disso, gaveta com véu e Esc.
   O botão de modo sai.
4. **Escopo:** executar R0 a R3.
5. **Nomes** (decididos na execução, trocáveis só em `menu.ts`): "Base de clientes", "Públicos", "Agenda e
   tarefas", "Crescimento".

## 8. O que não foi medido

- A largura de celular (390) não foi capturada: a janela do Chrome não aceitou o redimensionamento. Fica
  para a R0, pelo método de `taste-skill/referencia/medir.md`.
- O tema claro não foi olhado nesta rodada.
- Não verifiquei se a API de Tarefas e a de Agenda podem ser lidas juntas no Calendário. Sem isso, a aba
  Calendário mostra só os eventos.
- Não verifiquei se a regra de "sem próximo passo" do Panorama do funil é igual à da Higienização.
