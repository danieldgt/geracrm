# Plano — paridade do GeraCRM com o AM Consórcio (funcionalidades e formato de tela)

> Estudo feito em 2026-11-03 sobre `AMConsorcio/repo` (main `a521cd2`) e `GeraCRM` (main `0a44e61`).
> Pedido do dono: ver o que falta no GeraCRM para ficar **igual** ao AM Consórcio e revisar o layout das
> páginas, porque **os formulários são muito diferentes** — a disposição e o formato de formulário do AM
> devem valer aqui. Plano **vivo**, no formato de `plano-port-playbook-am.md`: a §5 vira quadro de estado
> quando as raias começarem.

**Premissa de direção.** O AM Consórcio é a **referência** e o GeraCRM é o **alvo**. É a mesma direção do
port anterior (`CLAUDE.md`: "port dos padrões do agente da AM"; `docs/plano-port-playbook-am.md`) e é o que
a frase sobre os formulários diz. Se o dono quiser o inverso (levar o GeraCRM para dentro do AM), a matriz
da §2 serve igual — só muda a coluna que vira "a fazer".

**O que NÃO entra.** A identidade visual do GeraCRM (ADR-012: tokens, azul de ação, Geist, dois temas) é
mantida; o que se importa do AM é a **disposição** das telas e o **formato** dos formulários (§4). Também
não entram as capacidades de consórcio (grupos, assembleias, simulação de plano, regulamento, taxas do BCB).

---

## 0. Resumo executivo

**Funcionalidades.** Comparei 123 capacidades do AM com o GeraCRM (§2). O resultado:

| Situação | Quantas | O que significa |
|---|---|---|
| ✅ igual ou melhor | 29 | tudo que foi portado do agente (P0–P20), inbox em tempo real, pedido, ERP, RFV |
| 🟡 parcial | 52 | existe a base (API ou tela), falta a camada que o AM tem |
| ❌ falta | 33 | não existe nem na API |
| ⛔ não se aplica | 7 | domínio de consórcio ou substituído por algo nosso |
| 🔎 verificar | 2 | não dá para afirmar só lendo o código |

**As dez lacunas que mais pesam** (o que a vendedora e o gestor sentem todo dia):

1. **Cadastro do contato é um nome e um telefone.** O AM tem formulário de 4 seções, ~22 campos, etiquetas, prioridade e temperatura; endereço no GeraCRM nem tem tela (a API tem).
2. **Lista de contatos sem filtros, sem tabela e sem ações em massa.** O AM filtra por status, etapa e origem e move/atribui em lote.
3. **Ficha sem feed, sem abas e sem lateral de informações.** O "Perfil de compra" que o agente preenche existe na API do GeraCRM (memória do contato) e não tem tela.
4. **Não existe Agenda** (calendário, evento com status, reagendar, horários livres, reunião marcada pelo agente).
5. **Tarefas sem tipo, responsável, resultado e sem o selo "sem próximo passo".**
6. **Não existe Cockpit do gestor nem Higienização da carteira**; e as consultas **não aplicam o papel** (vendedor enxerga a base inteira).
7. **Não há cadastro de usuários nem de filiais** (a equipe é só leitura; o 1º acesso é criado pela Plataforma).
8. **Relatórios: 17 KPIs no AM contra 4 painéis fixos** (BI, Performance, Mercado, Mapa) sem período livre nem CSV.
9. **Campanhas sem template, sem público composto com exclusões, sem lote diário, sem detalhe por destinatário; sem tela de Consumo nem preços do WhatsApp.**
10. **Operação: sem anonimização LGPD, sem monitor com alerta em canal, sem e2e no CI** (backup com restore provado também falta, mas ficou fora por decisão do dono).

**Layout e formulários.** A queixa se confirma na medida: das 41 telas do console, **38 reimplementam o
próprio cabeçalho**, o componente de campo só faz input de texto e é usado por 2 telas, não há modal de
formulário, tabela com cabeçalho, barra de filtros nem página de formulário. O AM resolve tudo com **seis
padrões de tela** (lista, formulário-página, CRUD em modal, modal de ação, detalhe 2+1 com abas,
configurações com abas). A proposta (§4) é adotar os seis padrões **com os tokens do GeraCRM**, criar/estender
20 componentes e uma diretiva de máscara em `compartilhado/ui` e migrar as telas na ordem de uso diário.

**Decisões do dono (respondidas em 2026-11-03, §6):** direção AM → GeraCRM confirmada; menu lateral
mantido; ícones Lucide no lugar de emoji; Agenda entra como **módulo opcional por tenant**, e o agente
marcar reunião é uma **chave à parte** que pode ficar desligada; Site Social e Influenciadores **não
entram**; ganho exige só **CNPJ, razão social, nome fantasia e endereço**; **backup fica fora agora**.

---

## 1. Método e fontes

- **AM Consórcio**: `CLAUDE.md`, `docs/ARQUITETURA.md`, `docs/TAREFAS.md`, `docs/mapeamento-amcrm.md`,
  `docs/BACKLOG-PRODUTO.md`, capturas em `docs/mapeamento/`, todas as rotas e telas de `frontend/src/app`,
  controllers de `backend/src/main/java/br/com/amconsorcio/crm`, 23 migrations Flyway, `agent-worker/src`,
  `infra/` e `.railway/`.
- **GeraCRM**: `CLAUDE.md`, `docs/decisoes.md`, `docs/plano-port-playbook-am.md`, `docs/onde-estamos.md`,
  `docs/mapa-de-telas.md`, `docs/identidade-visual.md`, `docs/biblioteca-componentes.md`, skill
  `geracrm-layout-ui`, `apps/console/src/app` (41 telas, `menu.ts`, `rotas.ts`, `compartilhado/ui`),
  `apps/api/src` (rotas por contexto, workers), `infra/`, `.github/workflows/ci.yml`.
- Dois inventários funcionais completos (um por projeto) feitos por leitura do código; os pontos em 🔎
  são os que a leitura não resolveu.
- Vocabulário cruzado: Lead (AM) = **Contato** (GeraCRM); Unidade/vendedor (AM) = **Carteira**; Grupo/praça
  (AM) = **Filial**; Follow-up = **Tarefa**; Venda/proposta = **Pedido**; Etapa do funil = etapa do **Funil
  de Vendas** (e a qualificação de `CRM (Leads)`); Formulário público ≈ **Landing page** da Aquisição.

---

## 2. Matriz de paridade

Legenda: ✅ igual ou melhor · 🟡 parcial · ❌ falta · ⛔ não se aplica · 🔎 verificar. A última coluna é a
raia da §5 que fecha a lacuna.

### 2.1 Painel

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 1 | Dashboard: saudação, filtro de período, 4 cards, cards por unidade com categorias, gráficos (status, por mês), ranking, recentes, próximos follow-ups | Início: 4 KPIs fixos de 30 dias + bloco de pedidos | 🟡 | E1 |
| 2 | Atalhos do gestor (Cockpit, Higienizar carteira) | — | ❌ | D1 |

### 2.2 Kanban e funil

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 3 | Panorama por grupo/unidade com contadores por etapa e selos (ativos, ganhos, sem follow-up, perdidos) | — | ❌ | B1 |
| 4 | Board por unidade: select, busca, filtros (etiqueta, origem, categoria), arrastar | Funil: arrastar sem filtros; CRM (Leads): 3 colunas | 🟡 | B1 |
| 5 | Card com ações rápidas e menu (agendar, follow-up, produtos, transferir, inativar) | Qualificar/Descartar/Reabrir; abrir conversa | 🟡 | B2 |
| 6 | Modal Perder: motivo + descrição | Botões de motivo ao soltar em "Perdido" | 🟡 | B2 |
| 7 | Modal Ganhar com dados mínimos obrigatórios (I-19) | — (etapa tipo Ganho sem formulário) | ❌ | B2 |
| 8 | Modal Follow-up no card (data, hora, tipo, detalhes) | — | ❌ | C1 |
| 9 | Transferir (unidade/vendedor) | Select "Transferir…" em Carteiras | 🟡 | B2 |
| 10 | Funil configurável (etapas aberto/ganho/perdido, motivos de perda) | Configurar funil + motivos | ✅ | — |
| 11 | Movimentação de etapa com autor e data no feed; perdido exige motivo | Mover com versão otimista; motivo ✅; feed ❌ | 🟡 | A3 |
| 12 | Selo de sub-fase "Negociação" | — | ⛔ | — |

### 2.3 Leads → Contatos

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 13 | Lista com filtros (busca, status, etapa, origem), tabela, paginação | Busca por nome/telefone; lista sem cabeçalho | 🟡 | A2 |
| 14 | Ações em massa: mover etapa (observação obrigatória), alterar responsável | — | ❌ | A2 |
| 15 | Formulário completo: Dados principais · Endereço · Classificação · Observações; "Salvar e criar outro" | Nome + telefone numa linha | ❌ | A1 |
| 16 | Botão consultar CPF/CNPJ (no AM não funciona) | — | ❌ | A1 |
| 17 | Detalhe: cabeçalho com selos (status, prioridade, temperatura) e ações coloridas | Ficha: nome editável + 4 botões | 🟡 | A3 |
| 18 | "Perfil de compra" preenchido pelo agente | `GET /v1/contatos/:id/memoria` existe, sem tela | 🟡 | A3 |
| 19 | Abas Feed (observações + movimentações) · Dados · Follow-ups · WhatsApp · Agenda | Comentários; sem feed nem abas | 🟡 | A3 |
| 20 | Lateral: Informações (dl), Produtos, Arquivos (upload + enviar no WhatsApp), Etiquetas | Vendas/RFV/categorias; sem etiquetas, arquivos, produtos de interesse | 🟡 | A3 |
| 21 | Catálogos: origens, etiquetas, motivos e submotivos de perda | Motivos ✅; origem fixa; etiquetas ❌ | 🟡 | A4 |
| 22 | Prioridade e temperatura do lead | — | ❌ | A1 |
| 23 | Reabrir lead | Reabrir | ✅ | — |
| 24 | Atribuição CTWA (1º/último toque) | Aquisição: contas, anúncios, LPs, ROI por anúncio | ✅ | — |
| 25 | Avisos de privacidade e opt-out | Portados (P4) | ✅ | — |
| 26 | Anonimização LGPD (perdidos > 12 meses; opt-out em 15 dias) com retenção configurável | — | ❌ | H2 |
| 27 | Endereço editável | `PUT /endereco` existe; ficha só mostra | ❌ | A1 |
| 28 | Telefone único por lead ativo (RN-01) e fusão | Fusão por telefone com alerta na ficha | ✅ | — |

### 2.4 Agenda

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 29 | Calendário mensal com eventos do dia | — | ❌ | C2 |
| 30 | Evento: título, descrição, data, início/fim, tipo, modalidade, local, link, lembrete, cor, contato | — | ❌ | C2 |
| 31 | Status Realizado / Não compareceu / Reagendar | — | ❌ | C2 |
| 32 | Horários livres do vendedor; reunião marcada pelo CRM e pelo agente, lembretes, no-show → reagendar/handoff | — | ❌ | C3 |

### 2.5 Follow-ups → Tarefas

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 33 | Cards Pendentes/Atrasados/Hoje/Semana + abas | Abas Hoje/Vencidas/Abertas/Concluídas | 🟡 | C1 |
| 34 | Tipo (ligação, WhatsApp, reunião, e-mail, visita), responsável, detalhes, concluir com resultado | Título + vencimento; concluir/cancelar | 🟡 | C1 |
| 35 | Criação pelo kanban, pela ficha e em lote (modal) | Formulário inline só na tela de Tarefas | 🟡 | C1 |
| 36 | Cadência T1–T4 sem LLM → perdido → reativação 30/90 dias | Retornos com expediente, limites e template (P11) | 🟡 | G5 |
| 37 | Selo "sem próximo passo" (ativo sem tarefa futura) | — | ❌ | D2 |

### 2.6 Vendas → Pedidos

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 38 | Lista com cards do mês, filtros (status, unidade, período, busca), tabela | Chips por estado + cursor | 🟡 | A5 |
| 39 | Aba "Leads ganhos → criar venda" | Ficha → "Novo pedido" | 🟡 | B2 |
| 40 | Venda manual com titular, parcelas, financeiro | — (o ERP efetiva; forma de pagamento já existe no pedido) | ⛔ | — |
| 41 | Proposta criada pelo agente (`registrar_proposta`) | Propor-e-confirmar com alçada (ADR-027) | ✅ | — |

### 2.7 WhatsApp / Inbox

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 42 | Filtros Todas / BOT / HUMANO / Aguardando humano | Todas / Fila / Meus + busca por protocolo | 🟡 | G1 |
| 43 | Selos de atendente e modo, cronômetro de SLA | Idem | ✅ | — |
| 44 | Assumir · **Devolver ao bot com motivo** | Assumir ✅ · devolver ❌ (não há rota) | 🟡 | G1 |
| 45 | Reatribuir a vendedor X com motivo (gestor, após prazo) | Liberação para qualquer pessoa após prazo | 🟡 | G1 |
| 46 | Faixa de handoff com motivo e resumo | Handoff com contexto (P13/P18) | ✅ | — |
| 47 | Sugestão pré-preenchida com avisos; copiloto; sugestão proativa | Portado (P13) | ✅ | — |
| 48 | Nova conversa por busca de lead | "Adicionar e conversar"; ficha → Abrir conversa | ✅ | — |
| 49 | Agendar videochamada na conversa | — | ❌ | C3 |
| 50 | Ver lead | Ficha + Montar pedido | ✅ | — |
| 51 | Polling 15 s | SSE | ✅ | — |
| 52 | — | Editar/apagar, áudio, imagem, cards de ação, presença | ✅ | — |

### 2.8 KPI's (17 relatórios)

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 53 | Dashboard geral: período, grupo, 6 cards, top 5 por unidade, dia da semana, top produtos/origens, top 10 unidades | BI: top clientes/produtos/por vendedor em 7/30/90 | 🟡 | E2 |
| 54 | Lista de vendas por agrupamento (dia, dia da semana, produto, cliente, origem, formulário, unidade, canal) | BI parcial | 🟡 | E2 |
| 55 | Performance de vendedores (leads, follow-ups, conversões, taxa, valor, ticket; top 10) | Performance = SLA; BI por vendedor | 🟡 | E2 |
| 56 | Análise comparativa de até 10 vendedores | — | ❌ | E3 |
| 57 | Visão geral (totais, por unidade, unidade × dia, por formulário, detalhamento com CSV) | — | ❌ | E3 |
| 58 | Leads completo (filtros extras + CSV de 1000) | — | ❌ | E3 |
| 59 | Raio-X por formulário e por unidade | — | ❌ | E3 |
| 60 | Desempenho: completude de dados, tipo de pessoa, status, faixa etária, origem, canal, UF, cidade, funil | Mapa (UF/cidade) e Mercado (origem) | 🟡 | E3 |
| 61 | "Leads x dimensão" genérico (unidade, formulário, produto, dia, canal, origem, etapas) | Mercado por origem; Funil por etapa | 🟡 | E2 |
| 62 | Tempo de conversão (média, extremos, faixas, por unidade) | — | ❌ | E2 |
| 63 | Período livre + atalhos + CSV em todo relatório | Períodos fixos 7/30/90; sem CSV | 🟡 | E1 |
| 64 | Operacional (mês atual × anterior, funil, top origens/formulários) | — | ❌ | E2 |
| 65 | Relatórios imprimíveis (funil, origens, motivos de perda, WhatsApp) | — | ❌ | E3 |
| 66 | Relatório WhatsApp (7 cards, mensagens/dia, 1ª resposta p50/p95 por autor) | Performance (1ª resposta humana, SLA) | 🟡 | E2 |
| 67 | Relatório de go-live M1–M15 | Portado (P19) | ✅ | — |

### 2.9 Gestão

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 68 | Cockpit: aguardando humano com cor de SLA, SLA estourado hoje, esquecidos, reuniões hoje, no-shows, sem próximo passo; por praça/unidade/vendedor; itens clicáveis; 60 s | — | ❌ | D1 |
| 69 | Higienização da carteira: % com próximo passo (meta ≥ 95%), filtros, seleção, lote (follow-up, perder, transferir) | Fila do dia (RFV) + Carteiras | 🟡 | D2 |
| 70 | Escopo por papel na consulta: vendedor só o próprio, gestor a unidade, fora do escopo = 404 | Papéis por filial existem; consultas não filtram | ❌ | D3 |
| 71 | Rodízio na criação pelo agente (RN-04) e roteamento do handoff (DDD/origem → unidade → gestor) | SLA libera após prazo; sem roteamento | 🟡 | G4 |

### 2.10 Campanhas

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 72 | Formulários públicos: builder (13 tipos, condicional, referência, token, embed), página `/f/:slug` (LGPD, honeypot, anexos, rate-limit), respostas + CSV, lead criado/mesclado | LPs da Aquisição (nome, título, WhatsApp) + `/publico/lp/:chave/lead` | 🟡 | F3 |
| 73 | Site Social ("link na bio" por unidade, layouts, prévia, QR, métricas, OG) | — (decisão: não entra) | ⛔ | — |
| 74 | Campanha WhatsApp: lista por status, wizard de 4 passos, template MARKETING aprovado obrigatório | Formulário inline: nome, segmento, texto livre, janela ROI | 🟡 | F1 |
| 75 | Público composto (etapas, motivos, unidades, origens, etiquetas, temperaturas, categorias, sem interação há N dias, criado entre) + exclusões (opt-out, conversa/campanha/compra recente, anonimizado) + prévia (total, elegíveis, custo, amostra) | Segmento RFV ou todos; listas à parte; opt-out no gateway | 🟡 | F1 |
| 76 | Envio: lote diário na janela de contato, início agendado, teste até 5 números, iniciar digitando o nome | Disparar com confirmação de alcance; teto de aquecimento | 🟡 | F1 |
| 77 | Detalhe: funil até a venda (custo por venda, opt-outs, falhas), progresso, pausa automática (qualidade ✅, opt-out > 2%, falhas > 10%), pausar/retomar/cancelar, destinatários por status | ROI exato/estimado 3/7/14 dias; pausa por qualidade do número | 🟡 | F1 |
| 78 | Resposta do cliente atribuída à campanha (wamid por 7 dias) | ROI por venda existe; atribuição de resposta | 🔎 | F1 |
| 79 | Templates: status na Meta, ativo, mapeamento `{{n}}` → campo do lead | Criar/versionar; sem submissão à Meta; sem mapeamento | 🟡 | F2 |
| 80 | Preços do WhatsApp por categoria (R$) + câmbio | — | ❌ | F2 |
| 81 | Consumo mensal: WhatsApp por categoria, IA por finalidade/modelo contra o teto com projeção e alerta 80/100%, transcrição, série diária, por campanha, top conversas | Orçamento mensal e teto por sessão com alerta (P6); sem tela de consumo | 🟡 | F2 |
| 82 | E-mail, Landing pages, Bots (placeholders no AM) | LPs ✅ (Aquisição); e-mail ⛔; bots ⛔ (o agente cobre) | ⛔ | — |

### 2.11 Mais

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 83 | Influenciadores (CRUD; origem "Digital Influencer" exige o nome) | — (decisão: não entra) | ⛔ | — |
| 84 | Notificações: página (lista, filtro, marcar todas), tipos, preferências tipo × canal, e-mail no handoff | Sino + Web Push | 🟡 | D4 |
| 85 | Meu perfil: foto, nome, telefone, cargo, trocar senha, preferências | Leitura + presença | 🟡 | D4 |
| 86 | Configurações gerais: contato da empresa, horário, LGPD (DPO, política, retenção, consentimento, exigir no WhatsApp); gestor só lê | Nome, fuso, horário, aviso de privacidade | 🟡 | D5 |
| 87 | Configurações com abas (Geral · Agente · WhatsApp · Playbook) | 4 telas separadas no menu | 🟡 | L0/§4.5 |
| 88 | Agente de IA: modo e kill switch com confirmação digitada, recorte, auditoria | Portado (P14, ADR-028) | ✅ | — |
| 89 | WhatsApp › Conexão (QR, desconectar/reconectar, Meta) | Meus Números | ✅ | — |
| 90 | WhatsApp › Comportamento (nome, sugestão proativa, reengajamento, PJ, videochamada, link) | Persona + "quando o agente entra"; videochamada → C3 | ✅ | — |
| 91 | WhatsApp › Regras de contato: janela + feriados, limites dia/semana, SLA, reatribuição, hora do follow-up fora do horário, roteamento | Ativas, SLA, horário ✅; hora do follow-up 🔎; roteamento ❌ | 🟡 | G4 |
| 92 | Playbook versionado (rascunho, publicar com diff, histórico, restaurar, testar, sugerir de documento) | Portado (P17) | ✅ | — |
| 93 | Seções do playbook: estilo ✅ · roteiro/persuasão/processo em markdown · qualificação ✅ · **objeções (código, gatilhos, resposta)** · mensagens ✅ · compliance ✅ · ações ✅ | Sem objeções; texto longo vive no Conhecimento | 🟡 | G2 |
| 94 | Qualidade do agente + revisão humana + CSV semanal | Portado (P12, P16) | ✅ | — |
| 95 | Auditoria: filtros (período, usuário, ação, módulo, busca), CSV, detalhe, login/logout | Rastro por cursor, sem filtros | 🟡 | D6 |
| 96 | Grupos de consórcio, importação CSV, assembleias, taxas BCB, regulamento | — | ⛔ | — |

### 2.12 Admin

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 97 | Usuários: lista (cargo, nível, perfil, grupos, status, último login) e modal (senha, telefone, cargo, perfil, nível, grupos, unidade, ativo); ativar/desativar | Equipe só leitura; 1º acesso criado pela Plataforma | ❌ | D3 |
| 98 | Unidades e grupos (praças) com tipo e cor | Filial existe no modelo (`usuario_filial`); sem tela | ❌ | D3 |
| 99 | Migração: usuários, leads, vendas, follow-ups, agenda; simulação obrigatória por hash, de-para de colunas, relatório, conferência | CSV de contatos (nome, telefone, documento) | 🟡 | H1 |
| 100 | Prova social (tipo, frase com vetos, fonte, link, data, consentimento, aprovado) + tool do agente | Conhecimento sem tipo/fonte/aprovação | 🟡 | G3 |

### 2.13 Autenticação

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 101 | Login com lembrar-me e "esqueci a senha" | Login Cognito; sem "esqueci" | 🟡 | D4 |
| 102 | Troca de senha obrigatória no 1º acesso | NEW_PASSWORD_REQUIRED | ✅ | — |
| 103 | Perfis ADMIN/GESTOR/PADRÃO + nível EMPRESA/GRUPO/UNIDADE | admin/gestor/supervisor/vendedor/atendente por filial (modelo ✅; aplicação ❌ → #70) | 🟡 | D3 |

### 2.14 Worker / agente

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 104 | Tools genéricas: transferir ✅ · bloquear/opt-out ✅ · consentimento ✅ · qualificar (slots) ✅ · mover etapa 🔎 · agendar tarefa para o vendedor 🔎 · enviar mídia 🟡 · **registrar objeção** ❌ · **registrar NPS** ❌ · **registrar indicações** ❌ · **prova social** ❌ · **agendar reunião** ❌ | Ferramentas de catálogo, pedido e cliente sob RLS | 🟡 | G2/G3/C3 |
| 105 | Tools de consórcio (simular plano, estatísticas do grupo, regulamento, checklist, proposta) | Catálogo + pedido + propor-e-confirmar | ⛔ | — |
| 106 | Pós-venda automático (D+0 parabéns, NPS, indicações, pôster D+1) disparado por LEAD_GANHO | Automações (RFV, dias sem comprar, lead frio, NPS detrator, reposição) sem gatilho "pedido efetivado" | ❌ | G3 |
| 107 | SLA do handoff com mensagem de espera e alerta ao gestor | Portado (P18) | ✅ | — |
| 108 | Outbox de eventos para o worker (ganho, devolvida ao bot, no-show, agendada, sugestão) | Outbox + SSE; "devolvida" ❌ (→ #44) | ✅ | — |
| 109 | Campanhas no worker: blocos de 50, guardrails por item, memória wamid | Despachante + gateway único (opt-out, aquecimento) | 🟡 | F1 |
| 110 | Agregador de consumo (LLM + STT por dia, finalidade, modelo) | Custo por decisão (centavos); STT sem custo | 🟡 | F2 |
| 111 | Qualidade (regras, números sem fonte, juiz, monitor, pausa) | Portado (P12) | ✅ | — |
| 112 | Copiloto (sugestão, resumo, proativa) | Portado (P13) | ✅ | — |
| 113 | Webhook durável antes do 200, debounce por telefone, estado com versão | `tarefa_pos_ingestao`, fila, `estado_agente` | ✅ | — |
| 114 | Canais Meta + Baileys; templates fora da janela; envio humano | Meta + PlugZapi (ADR-021) | ✅ | — |
| 115 | STT (faster-whisper próprio) | Transcrição (Groq) | ✅ | — |
| 116 | Provedor reserva e fallback de modelo | Portado (P5) | ✅ | — |
| 117 | Limite de envio do portfólio Meta (250/24 h até verificar) | Aquecimento cobre o não-oficial; oficial | 🔎 | F1 |

### 2.15 Infra e operação

| # | AM Consórcio | GeraCRM hoje | Sit. | Raia |
|---|---|---|---|---|
| 118 | monitor-cron a cada 5 min (resumo, health, alertas Slack/Discord com dedupe, heartbeat, "webhook parado"), token e role só leitura | `/saude/detalhada` + alertas na casca; monitor externo é ação do dono (pendente) | 🟡 | H3 |
| 119 | backup-cron (pg_dump → bucket, retenção 7/4/6) + restore drill validado | Nada no repositório (decisão: fora agora) | ❌ | adiado |
| 120 | IaC do Railway (`railway.ts`, `provisionar.sh` idempotente) | — | ❌ | H3 (opcional) |
| 121 | e2e no CI (compose + `run.sh`) | CI: lint, typecheck, test; evals por `IA_E2E` | ❌ | H4 |
| 122 | Jobs: anonimização mensal, opt-out diário | — | ❌ | H2 |
| 123 | ProblemDetail único em pt-BR; `@Version`; auditoria automática | Falha tipificada; versão otimista; auditoria | ✅ | — |

---

## 3. Lacunas detalhadas — o que construir, por lote

Cada item traz o que o AM faz, o que o GeraCRM tem hoje, o que fazer e a **adaptação ao B2B** quando o
domínio muda. Tamanho: **P** = uma tela ou rota, sem migration · **M** = tela + rotas + uma migration ·
**G** = várias telas, migrations e worker/tools. Toda tela nova nasce já no padrão da §4.

### Lote A — Contato (cadastro, lista, ficha)

**A1 — Cadastro completo do contato** (#15, #16, #22, #27) · **M**
- AM: formulário-página com Dados principais · Endereço · Classificação · Observações, etiquetas, "Salvar e criar outro".
- Hoje: "+ Novo contato" = nome + telefone; endereço sem tela (a API tem `PUT /endereco`).
- Fazer: telas `contato/novo` e `contato/:id/editar` (padrão F) com Dados principais (nome*, razão social, nome fantasia, e-mail, telefone*, WhatsApp, CNPJ/CPF com **consultar** via BrasilAPI), Endereço (CEP preenche logradouro/bairro/cidade/UF; número, complemento), Classificação (vendedor/carteira, filial, origem, prioridade, temperatura, modalidade atacado/varejo, categoria de interesse, valor estimado, etiquetas), Observações. Validação por campo com mensagem; 422 da API vai para o campo.
- Migration: `contato` ADD `razao_social`, `nome_fantasia`, `prioridade`, `temperatura`, `origem_id`, `valor_estimado_centavos`, `observacoes`.

**A2 — Lista de contatos com filtros, tabela e ações em massa** (#13, #14) · **M**
- AM: busca + Status + Etapa + Origem + Filtrar; tabela; seleção → mover etapa (observação obrigatória) e alterar responsável.
- Hoje: busca; lista sem cabeçalho; sem seleção.
- Fazer: padrão L — filtros (busca, qualificação novo/qualificado/descartado, segmento RFV, vendedor, filial, origem, etiqueta), tabela (segmento, nome + e-mail, qualificação, origem, vendedor, última compra, total, criado em, ações), ações em massa: qualificar/descartar com observação, transferir carteira, aplicar etiqueta, adicionar a lista, criar tarefa. API: filtros em `GET /v1/contatos`; `POST /v1/contatos/acoes-em-massa/:acao` (até 500 ids, auditado, respeita o escopo de D3).

**A3 — Ficha com feed, abas, lateral e perfil de compra** (#11, #17, #18, #19, #20) · **G**
- AM: cabeçalho com selos e ações; "Perfil de compra" (o que o agente levantou); abas Feed · Dados · Follow-ups · WhatsApp · Agenda; lateral Informações, Produtos, Arquivos, Etiquetas.
- Hoje: nome editável, 4 botões, cartões de contato/vendas/RFV/comentários; a memória do contato (`GET /v1/contatos/:id/memoria`) não tem tela.
- Fazer: padrão D — cabeçalho (selos: segmento RFV, qualificação, prioridade, temperatura, modalidade; ações: Editar, Conversar, Novo pedido, Nova tarefa, Agendar, Qualificar/Descartar); card **Perfil de compra** lendo a memória; abas **Feed** (comentários, movimentações de funil e qualificação, handoffs, tarefas concluídas, pedidos — cronológico, com autor), **Dados** (dl), **Pedidos**, **Tarefas**, **WhatsApp** (últimas mensagens + abrir no trilho), **Agenda**; lateral **Informações** (dl), Categorias mais compradas (existe), **Arquivos** (upload ao bucket + "enviar no WhatsApp"), **Etiquetas**.
- Migration: `contato_arquivo`; o feed é uma leitura unificada (comentário + auditoria + movimentação) com cursor.

**A4 — Catálogos do CRM: etiquetas e origens** (#21) · **P/M**
- AM: origens, etiquetas, motivos e submotivos configuráveis; Influenciadores com obrigatoriedade quando a origem é "Digital Influencer".
- Hoje: motivos de perda ✅; origem fixa; sem etiquetas.
- Fazer: `etiqueta` (nome, cor) e `origem` (nome, ativa) por tenant, telas no padrão M. Influenciadores/parceiros **não entram** (decisão do dono); indicação é só uma origem.
- Migration: `etiqueta`, `contato_etiqueta`, `origem`.

**A5 — Pedidos no padrão de lista** (#38) · **P**
- Fazer: cards do mês (efetivados, valor, rascunhos, falharam), filtros (busca por cliente/nº ERP, estado, vendedor, período), tabela e detalhe em D com dl e itens. Sem migration.

### Lote B — Funil e kanban

**B1 — Panorama e board com filtros** (#3, #4) · **M**
- AM: panorama por grupo/unidade com contadores por etapa e selos; board com select de unidade, busca e filtros.
- Fazer: `GET /v1/funil/panorama` (por filial e carteira: ativos, ganhos, sem próximo passo, perdidos, por etapa) → clique abre o board da carteira; board ganha select de carteira, busca e filtros (etiqueta, origem, categoria). Sem migration.

**B2 — Modais de ação e criação de oportunidade** (#5, #6, #7, #9, #39) · **M**
- AM: Perder (motivo + descrição), Ganhar (dados mínimos), Transferir, Follow-up; card com menu.
- Hoje: botões de motivo; transferir só pelo select de Carteiras; `POST /v1/funil/oportunidades` sem botão.
- Fazer (padrão A): **Ganhar** exigindo os dados mínimos decididos pelo dono — **CNPJ** (validado), **razão social**, **nome fantasia** e **endereço** (CEP, logradouro, número, bairro, cidade, UF) — pré-preenchidos com o que o contato já tem e com a consulta de CNPJ preenchendo razão social, fantasia e endereço; ao confirmar, grava no contato e abre o pedido assistido ou vincula um pedido existente; **Perder** (motivo select + descrição); **Transferir** (vendedor + motivo, vai ao feed e notifica); **Tarefa** (C1); botão "Nova oportunidade"; menu do card. Movimentações com autor/data (auditoria → feed de A3).
- Migration: nenhuma própria se A1 já tiver criado `razao_social` e `nome_fantasia` no contato (A1 cria); a regra fica em `packages/shared` (`dadosMinimosDoGanho`), validada também na API (422 com o campo faltante).

### Lote C — Tarefas e agenda

**C1 — Tarefas v2** (#8, #33, #34, #35, #37) · **M**
- AM: tipo, responsável, detalhes, concluir com resultado; cards; abas; criação pelo kanban, pela ficha e em lote; selo "sem próximo passo".
- Fazer: `tarefa` ganha tipo (ligação, WhatsApp, reunião, e-mail, visita, outro), responsável, descrição, resultado ao concluir; cards Pendentes/Atrasadas/Hoje/Semana; filtros (busca, tipo, responsável, período); modal de criação reutilizável (funil, ficha, carteira, inbox); **selo "sem próximo passo"** = contato qualificado/em funil sem tarefa futura nem evento (campo derivado na listagem e no card).
- Migration: `tarefa` ADD `tipo`, `responsavel_id`, `descricao`, `resultado`, `concluida_por`.

**C2 — Agenda (módulo opcional)** (#29, #30, #31) · **G**
- AM: calendário mensal, painel do dia, evento com status, reagendar, lembrete.
- Fazer: tela Agenda (mês; semana/dia depois), evento (título, descrição, **contato**, data, início/fim, tipo reunião/ligação/visita/outro, modalidade presencial/online, local, link, lembrete, cor), status Agendado/Realizado/Não compareceu/Cancelado, reagendar, modal de detalhe (padrão M), lembrete pelo sino e push; aba Agenda na ficha (A3).
- **Módulo por tenant** (decisão do dono): `tenant_modulo` com `agenda` ligado/desligado (padrão desligado; liga em Configurações › Geral). Desligado, a tela some do menu, a aba Agenda some da ficha, os cards de reunião somem do cockpit e a API responde 404 em `/v1/agenda/*`. O resto do produto não depende da agenda: "sem próximo passo" conta só tarefas quando o módulo está desligado.
- Migration: `evento_agenda` (RLS; índice por responsável + início); `tenant_modulo` (tenant_id, modulo, ativo) se ainda não houver lugar para chaves de módulo.

**C3 — Reunião marcada pelo agente e pelo CRM** (#32, #49, #104) · **G** · depende de C2 · só com o módulo Agenda ligado
- AM: horários livres (responsável primeiro, depois outro da unidade), tool ofertar/confirmar, lembretes, no-show → 1 reagendamento → handoff; botão no inbox.
- Fazer: `GET /v1/agenda/horarios-livres` (expediente − eventos); tool `agendar_reuniao` (só assistido/autônomo, dentro do recorte, nunca cria sem confirmação do cliente); botão "Agendar reunião" na conversa (vendedor da carteira ou outro da filial; 409 se ocupado; outro vendedor vira responsável com registro no feed); lembretes H-24/H-2 pelo gateway (template fora da janela); no-show → reagendar por template uma vez → handoff.
- **Chave própria** (decisão do dono): "O agente pode marcar reuniões" em Agente › Configuração, por número, padrão **desligado**, e só aparece com o módulo Agenda ligado. Desligada, a tool `agendar_reuniao` não é registrada no turno (não basta instruir o prompt — ADR-029: o que protege fica no código) e o botão "Agendar reunião" da conversa continua disponível para o humano. Teste: com a chave desligada a tool não aparece no rastro do laço.

### Lote D — Gestão, acesso e conta

**D1 — Cockpit do gestor** (#2, #68) · **M** · depende de C1 (e de C2 para os cards de reunião, que só aparecem com o módulo ligado)
- Fazer: cards Aguardando humano (faixa de SLA por cor + rótulo), SLA estourado hoje, Esquecidos (sem toque há N dias), Reuniões hoje, No-shows, Sem próximo passo; agrupamento por filial/vendedor; tabela clicável; lista de itens com ação; atualização por SSE (não polling). API: `GET /v1/gestao/cockpit`, `/itens`.

**D2 — Higienização da carteira** (#69) · **M** · depende de A2 e C1
- Fazer: indicador "% da carteira com próximo passo" (meta ≥ 95%), filtros (situação, filial, vendedor, etapa, busca), tabela com seleção, ações em lote (tarefa, descartar com motivo, transferir com motivo). API: `GET /v1/gestao/carteira`, `/indicador`, lotes reaproveitando A2.

**D3 — Usuários, filiais e escopo por papel** (#70, #97, #98, #103) · **G** · ⚠️ raia de segurança
- AM: vendedor vê só o próprio, gestor a unidade; fora do escopo = 404; tela de Usuários e de Unidades/Grupos.
- Hoje: papéis por filial no modelo, mas `rotas-contatos`, conversas, tarefas, pedidos e relatórios não filtram.
- Fazer: (1) **escopo nas consultas** — vendedor: só a própria carteira; supervisor/gestor: a filial; admin: tudo; fora do escopo = 404 — aplicado em contatos, conversas, tarefas, pedidos, funil e relatórios, com teste por papel em cada rota; (2) tela **Usuários** (padrão L + M: nome, e-mail, telefone, cargo, papel por filial, ativo, último login; criar = `AdminCreateUser` no Cognito + convite; desativar/ativar; redefinir senha); (3) tela **Filiais** (nome, tipo matriz/filial, cor, ativa).
- Migration: `usuario` ADD `telefone`, `cargo`, `ultimo_login_em`; `filial` com cor e tipo se ainda não houver tabela própria.

**D4 — Notificações, perfil e "esqueci a senha"** (#84, #85, #101) · **M**
- Fazer: página Notificações (lista por cursor, filtro lida/não lida, marcar todas, abrir leva ao alvo); preferências por tipo × canal (app, push, e-mail); e-mail no SLA estourado e na menção; Meu perfil com foto (bucket), telefone, cargo, **trocar senha** (Cognito `ChangePassword`) e preferências; "Esqueci a senha" no login (`ForgotPassword`/`ConfirmForgotPassword`); "lembrar-me".
- Migration: `usuario_preferencia_notificacao`.

**D5 — Configurações gerais com abas** (#86, #87) · **P**
- Fazer (padrão C): abas Geral · Agente · Números · Playbook (as três últimas como atalhos para as telas que já existem). Geral: empresa (nome, CNPJ, telefone, WhatsApp, e-mail, site, endereço, fuso), atendimento (existe), LGPD (DPO nome/e-mail, política, **retenção em meses**, texto de consentimento, exigir consentimento no WhatsApp). Gestor lê, admin salva.
- Migration: `tenant` ADD campos de contato e LGPD.

**D6 — Auditoria v2** (#95) · **P**
- Fazer: filtros (período, usuário, ação criar/editar/excluir/login/logout, módulo, busca), tabela, CSV da página, modal de detalhe (antes/depois); registrar login e logout.

### Lote E — Painel e relatórios

**E1 — Início v2 e a base dos relatórios** (#1, #63) · **M**
- Fazer: componentes `relatorio-dimensao` (cards + gráfico + tabela por dimensão, período livre com atalhos, CSV) e `ui-filtro-periodo`; Início com saudação, período, cards (contatos no período, pedidos, valor, tarefas pendentes, conversão), cards por filial/vendedor com categorias, gráficos (distribuição por qualificação, pedidos por mês), ranking de vendedores, contatos recentes, próximas tarefas e reuniões. API: `GET /v1/painel/inicio?inicio&fim`, `GET /v1/relatorios/contatos-por/:dimensao`.

**E2 — Relatórios, 1ª leva** (#53, #54, #55, #61, #62, #64, #66) · **G**
- Fazer: Contatos × (origem, canal, etapa, dia da semana, vendedor, landing page, categoria); Tempo de conversão (média, extremos, faixas 0–7…90+, por vendedor); Performance de vendedores (contatos, tarefas, conversões, taxa, valor, ticket; top 10); Vendas por agrupamento (dia, dia da semana, produto, cliente, origem, vendedor, canal); Operacional (mês × anterior, funil, top origens/LPs); WhatsApp (mensagens por dia, 1ª resposta p50/p95 por autor, cards). Leituras pesadas em views materializadas (`geracrm-dados-postgres`), nunca na transacional.

**E3 — Relatórios, 2ª leva** (#56, #57, #58, #59, #60, #65) · **G**
- Fazer: Análise comparativa de até 10 vendedores; Visão geral (vendedor × dia, por LP, detalhamento com CSV); Contatos completo (filtros extras, CSV até 1000 linhas); Raio-X por LP e por vendedor; Desempenho (completude de dados, tipo de pessoa, UF/cidade, funil); Relatórios imprimíveis (funil, origens, motivos de perda, WhatsApp) com `@media print`.

### Lote F — Campanhas, consumo e captação

**F1 — Campanhas v2** (#74–#78, #109, #117) · **G**
- AM: wizard de 4 passos; template aprovado obrigatório; público composto com exclusões e prévia de custo; lote diário na janela; teste; iniciar digitando o nome; detalhe com funil até a venda, pausa automática, destinatários.
- Hoje: nome + segmento + texto livre + janela ROI; ROI exato/estimado; pausa por qualidade; aquecimento.
- Fazer: wizard (Detalhes e template · Público · Envio · Revisão); **template aprovado obrigatório no oficial** (texto livre só no não-oficial, com o aviso de risco do ADR-021); público = segmentos RFV + listas + etapas + origens + etiquetas + categorias + "sem interação há N dias" + criado entre, com **exclusões automáticas** (opt-out, conversa recente, campanha recente, compra recente, anonimizado) e **prévia** (total, elegíveis, custo pelos preços de F2, excluídos por motivo, amostra); lote diário dentro da janela de contato, início agendado, duração e custo; teste até 5 números; iniciar digitando o nome; detalhe: enviadas → entregues → lidas → respostas → pedidos, custo por venda, opt-outs, falhas, progresso, **pausa automática** (qualidade ✅, opt-out > 2%, falhas > 10%), pausar/retomar/cancelar, destinatários por status (cursor); resposta do cliente atribuída à campanha (🔎 conferir o que o gateway já grava); limite diário do número oficial não verificado (250/24 h).
- Migration: `campanha` ADD `template_id`, `publico` jsonb, `lote_diario`, `inicio_em`, `pausa_motivo`; `campanha_destinatario` (status por webhook).

**F2 — Consumo e preços** (#79, #80, #81, #110) · **M**
- Fazer: Configurações › **Preços** (marketing/utility/autenticação em R$ + câmbio US$→R$); templates com mapeamento `{{n}}` → campo do contato e status na Meta; tela **Consumo** (mês: WhatsApp por categoria em R$, IA em US$/R$ por finalidade e modelo contra o orçamento com projeção, transcrição em minutos, série diária, por campanha, conversas que mais custaram); agregação diária em view materializada sobre `agente_decisao`, mensagens enviadas e transcrições.
- Migration: `preco_whatsapp` por tenant; `transcricao` ADD duração e custo.

**F3 — Formulários públicos** (#72) · **G**
- AM: builder com 13 tipos de campo, condicional, referência, token, embed; página pública com LGPD, honeypot, anexos, rate-limit; respostas + CSV; lead criado ou mesclado.
- Hoje: LPs da Aquisição (nome, título, WhatsApp de destino) + `/publico/lp/:chave/lead`.
- Fazer: evoluir a LP em **Formulário**: builder (nome, slug `/f/:slug`, título, descrição, tipo, filial, etapa destino, responsável padrão, cor, texto do botão, ativo, token; campos com obrigatório/placeholder/opções, seleção condicional, campo de referência, arrastar), página pública (LGPD, honeypot, anexos ao bucket, rate-limit por IP + slug, `?embed=1`), respostas (tabela + CSV + link para o contato), contato criado ou **mesclado por telefone** com origem = formulário.
- Migration: `formulario`, `formulario_campo`, `formulario_resposta` (RLS; leitura pública por slug via função).

**F4 — Site Social** · **removida** (decisão do dono em 2026-11-03: não entra).

### Lote G — Agente e inbox

**G1 — Devolver ao agente, reatribuir e filtro** (#42, #44, #45, #108) · **P/M**
- Fazer: "Devolver ao agente" com motivo (radio + outro) → `POST /v1/conversas/:id/devolver-agente`, evento `conversa.devolvida`, o agente retoma com o resumo; "Reatribuir" para vendedor X com motivo (gestor; feed + notificação); filtro "Conduzido por: agente · humano · aguardando".

**G2 — Objeções e seções de texto do playbook** (#93, #104) · **M**
- Fazer: seção **Objeções** no playbook (código, objeção, gatilhos, resposta com prévia, ativo, busca) + tool `registrar_objecao` (na 3ª seguida → handoff) + regra de qualidade "objeção respondida fora do catálogo"; seções de texto (roteiro de venda, processo) com prévia markdown — ou decisão de mantê-las no Conhecimento (§6); conferir se existem tools para mover/qualificar no funil (nunca Ganho) e para criar tarefa ao vendedor; criar se faltarem.

**G3 — Pós-venda, NPS, indicações e prova social** (#100, #104, #106) · **M**
- Fazer: gatilho `pedido_efetivado` nas Automações + ação "agente envia mensagem" (D+0 agradecimento/instruções, D+N NPS, pedido de indicação); tool `registrar_nps` (0–10; detrator → gestor) alimentando a tela NPS; tool `registrar_indicacoes` (contatos com origem indicação, sem duplicar telefone); **Prova social** = tipo de documento do Conhecimento com fonte, link, data, consentimento e **aprovado** — só aprovado chega à tool `consultar_prova_social`, e a frase passa pelo filtro de saída.

**G4 — Roteamento do handoff e rodízio** (#71, #91) · **M**
- Fazer: regras DDD → filial, origem → filial, carteira padrão por filial; rodízio entre vendedores ativos ao criar contato pelo agente (RN-04); responsável → fila da filial → gestor após o SLA; tela em Config. do Canal.
- Migration: `regra_roteamento`.

**G5 — Cadência: descarte e reativação** (#36) · **P**
- Fazer: após T4 sem resposta → descartar no CRM com motivo "sem resposta"; reativação em 30 e 90 dias por template de marketing com opt-out; qualquer resposta cancela.

### Lote H — Dados e operação

**H1 — Importador** (#99) · **M**
- Fazer: assistente (contatos → vendas históricas → tarefas) com modelo CSV, hash do arquivo, **simulação obrigatória**, de-para de colunas quando o cabeçalho não bate (422 com sugestão), opções (criar catálogos, assíncrono), relatório por linha (CSV), conferência (contagens por filial × qualificação contra o esperado). Reaproveita `POST /v1/contatos/importar`; vendas históricas alimentam o RFV de quem não tem ERP.
- Migration: `importacao`, `importacao_item`.

**H2 — LGPD: retenção e anonimização** (#26, #122) · **P/M**
- Fazer: retenção configurável (D5); job mensal que anonimiza contatos descartados há mais de N meses e opt-outs há mais de 15 dias (mantém agregados, apaga dados pessoais e mídia); auditoria e relatório do que foi anonimizado.

**H3 — Monitor** (#118) · **M**
- Fazer: `infra/monitor` (cron de 5 min: `/saude/detalhada`, console, latência do conector, "webhook parado" em horário comercial; alertas em Slack/Discord com dedupe; heartbeat).
- **Backup (#119) e IaC (#120) ficam fora agora** (decisão do dono em 2026-11-03). Registrado como risco aberto: não há restore provado do Postgres de produção.

**H4 — e2e no CI** (#121) · **M**
- Fazer: compose de teste (API + console + Postgres + adaptador falso de canal) e o fluxo "mensagem entra → agente responde → vendedor assume → pedido efetiva" rodando no `ci.yml`.

### ⛔ O que não entra (domínio de consórcio ou substituído)
Grupos de consórcio e assembleias (importação, elegíveis, estatísticas), simulação de plano, taxas do BCB,
busca no regulamento, checklist de fechamento de cota, proposta de cota (o pedido assistido cobre), Baileys
(o não-oficial do GeraCRM é PlugZapi/Z-API, ADR-021), créditos Meta por PIX, JWT próprio (Cognito), bots de
fluxo e campanhas de e-mail (o próprio AM não os clonou).

---

## 4. Revisão de layout e formulários

> Pedido do dono: "os formulários são muito diferentes do AM Consórcio; quero uma disposição similar e um
> formato de formulário". Esta seção compara os dois consoles tela a tela, lista as diferenças concretas e
> propõe UM formato de formulário e UMA disposição de tela para o GeraCRM — mantendo os tokens, as cores,
> a tipografia e os cinco estados que o GeraCRM já tem (ADR-012, `geracrm-layout-ui`). O que se importa do
> AM é a **anatomia** (onde cada coisa fica), não a identidade visual (âmbar, Font Awesome, Tailwind).

### 4.1 Como o AM Consórcio dispõe as telas (a referência)

Fontes: `frontend/src/styles.scss` (classes `.card`, `.input`, `.label`, `.table`, `.btn-*`),
`features/leads/lead-form.component.html`, `features/leads/leads-list.component.html`,
`features/leads/lead-detail.component.ts`, `features/admin/usuarios.component.ts`,
`features/kanban/kanban-modais.component.ts`, `features/mais/configuracoes*.ts`, `shared/ui/*`,
capturas `docs/mapeamento/clone/*.jpg` e `docs/mapeamento/screenshots/09-lead-create.jpg`, `10-lead-view.jpg`.

**Casca.** Barra superior fixa (64 px, branca, borda inferior) com o menu horizontal: Dashboard · Kanban ·
Leads · Agenda · Follow-ups · Vendas · WhatsApp · KPI's ▾ · Campanhas ▾ · Mais ▾ · sino · avatar ▾. Item
ativo com borda inferior na cor de ação. Conteúdo centrado em 1440 px sobre fundo cinza; tudo que é
conteúdo vive dentro de **cartões brancos** (`rounded-xl`, sombra leve, borda).

**Os seis padrões de tela do AM** (todas as rotas do frontend caem num deles):

| # | Padrão | Anatomia (de cima para baixo) | Telas |
|---|---|---|---|
| L | **Lista** | `page-header` (título + subtítulo + **botão primário à direita**) → **cartão de filtros** (busca com lupa ocupando o espaço livre + selects com **rótulo pequeno acima** + botão Filtrar; `items-end`) → faixa de **seleção em massa** quando há marcados → **cartão da tabela** (`thead` cinza em caixa baixa 12 px; linha ~44 px; 1ª coluna = nome em negrito com dado secundário abaixo; chips de status; números em mono e `nowrap`; coluna **Ações** à direita) → rodapé "Mostrando 1–20 de 137 · ‹ Página 1 de 7 ›" → modais das ações em lote | Leads, Vendas, Follow-ups, Usuários, Unidades, Campanhas, Formulários, Grupos, Auditoria, Notificações, Qualidade |
| F | **Formulário-página** | breadcrumb (`Leads › Novo Lead`) → `<form>` com largura máxima 3xl → **um cartão**: cabeçalho (h1 "Cadastrar Novo Lead" + "Preencha as informações do lead") → corpo com **seções** separadas por espaço (`DADOS PRINCIPAIS`, `ENDEREÇO`, `CLASSIFICAÇÃO`, `OBSERVAÇÕES`: título em maiúsculas pequenas com ícone na cor de ação) → cada seção é uma **grade de 2 colunas** (1 coluna no celular; campo largo ocupa as duas) → **campo = rótulo acima + controle + erro abaixo** (asterisco no obrigatório; botão-ícone ao lado quando há ação, ex. consultar CNPJ) → **rodapé** com borda superior e botões à direita: `Voltar` (secundário) · `Salvar` (primário) · `Salvar e criar outro` | Lead (novo/editar), wizard de campanha (4 passos), builder de formulário, importar CSV |
| M | **CRUD em modal** | tela de lista + botão "Novo X" abre `<app-modal>` (largura 2xl; **tela cheia no celular** com rodapé fixo) → `<form>` em grade de 2 colunas → `fieldset`/`legend` para rádios e checkboxes → checkbox "ativo" por último → rodapé `Cancelar` · `Salvar` | Usuários, Unidades, Prova social, Influenciadores, Grupos |
| A | **Modal de ação** | `<app-modal titulo>` → linha "Lead: **nome**" → form curto (1–2 colunas) → rodapé `Cancelar` · `Confirmar <ação>` com **cor semântica** (perigo para perder, sucesso para ganhar) | Perder, Ganhar, Follow-up, Transferir, Mover etapa, Alterar responsável, Agendar videochamada, Categoria |
| D | **Detalhe** | grade **2 + 1** → esquerda: cartão-cabeçalho (nome + chips de estado/prioridade/temperatura + **botões de ação com cor de fundo suave**: Editar, Agendar, WhatsApp, Follow-up, Ganhar, Perder) → cartão "Perfil de compra" (`dl` em 3 colunas) → cartão com **abas** (Feed · Dados · Follow-ups · WhatsApp · Agenda) → direita: cartões **Informações** (`dl` rótulo/valor), Produtos, Arquivos, Etiquetas | Lead, Campanha, Pedido (no nosso caso) |
| C | **Configurações com abas** | `page-header` → `nav` de abas com borda inferior (Geral · Agente de IA · WhatsApp · Playbook) → cartões com **cabeçalho próprio** (ícone + título + descrição) → corpo em grade de 3 colunas → aviso "somente leitura" para quem não edita → erros em lista → botão Salvar à direita no fim | Configurações, WhatsApp (conexão/comportamento/contato/templates/preços), Agente de IA |

E dois padrões de painel: **Dashboard** (saudação, cartão de período com `Data inicial` / `Data final` /
Aplicar / Mês atual, quatro `stat-card` com ícone colorido à esquerda + valor + rótulo, cartões por
unidade com cabeçalho colorido, gráficos, rankings, listas recentes) e **Kanban** (panorama por grupo com
chips e cartões-resumo por unidade → board com select de unidade, busca, filtros, Novo Lead, Transferir).

### 4.2 Como o GeraCRM dispõe as telas hoje

Fontes: `apps/console/src/estilos.css`, `compartilhado/ui/*`, `funcionalidades/crm/{clientes,bloqueios,
ficha,leads}.pagina.ts`, `plataforma/config.pagina.ts`, `atendimento/canal-config.pagina.ts`,
`nucleo/shell.componente.ts`.

**Casca.** Menu **lateral** (250 px, recolhível, agrupado: Atendimento · Vendas · Recompra · Aquisição ·
Integrações · Gestão · Plataforma; gaveta no celular), barra superior de 52 px (estado do tempo real,
tema, sino, usuário) e **chat rail à direita**. Conteúdo em `.pagina-forma` (largura legível centrada) ou
`.pagina-densa` (largura total). Cartões (`.painel`/`.bloco`/`.cartao`) com borda e sombra só no claro.

**O que existe de base e está bom:** tokens (cor, espaço, raio, escala tipográfica `.txt-*`), temas
claro/escuro, `.btn` com variantes, `.campo` (rótulo + controle + dica), os cinco estados como ramos
explícitos, cursor em toda lista, `ui-painel`, `ui-badge`, `ui-esqueleto`, `ui-estado`, `ui-confirmar`,
`ui-horario-atendimento`, toasts. Nada disso muda.

**O que diverge do AM (medido):**

| # | Diferença | Evidência |
|---|---|---|
| 1 | **Não existe tela de formulário.** Criar/editar é uma linha inline com 1–2 campos ou um painel curto; nenhuma tela tem breadcrumb + cartão + seções + rodapé | `clientes.pagina.ts` ("+ Novo contato" abre `<form class="novo-contato">` com dois inputs e dois botões); `bloqueios.pagina.ts` (campo + botão) |
| 2 | **Campo sem rótulo visível** (placeholder faz de rótulo) — contraria a própria regra de `geracrm-layout-ui` ("cria ou edita registro → `<label>` visível") | `clientes.pagina.ts` (`placeholder="Nome"`, `"Telefone (DDD + número)"`); `ficha.pagina.ts` (`placeholder="Novo telefone"`, `"Número"`) |
| 3 | **Sem seções tituladas** dentro do formulário; o AM agrupa (Dados principais / Endereço / Classificação / Observações) | `config.pagina.ts` tem painéis, mas o form é uma coluna só de 420 px |
| 4 | **Grade de 1 coluna** (`.form { max-width: 420px }`) contra a grade de 2 colunas com campo largo | `config.pagina.ts`, `canal-config.pagina.ts` |
| 5 | **Rodapé de ações sem padrão**: Salvar + mensagem inline ao lado; não há `Voltar/Cancelar` à esquerda do primário nem "Salvar e criar outro" | `config.pagina.ts` `.acoes`; `canal-config.pagina.ts` |
| 6 | **Sem modal de formulário nem modal de ação** — só `ui-confirmar` (sim/não). Ganhar/perder/transferir/mover/agendar não têm onde morar | `compartilhado/ui/confirmar.componente.ts` (1 uso) |
| 7 | **`ui-campo` cobre só `<input>` de texto** (sem select, textarea, data, hora, dinheiro, máscara de CPF/CNPJ/telefone/CEP, dica, obrigatório, botão ao lado) — e é usado por 2 telas | `compartilhado/ui/campo.componente.ts` |
| 8 | **Cabeçalho de tela reimplementado em cada tela**: 38 das 41 telas escrevem o próprio `<h1>`; `ui-cabecalho-tela` é usado por 3 | contagem por `grep` em `funcionalidades/` |
| 9 | **Listas sem tabela**: `<ul>` com grade CSS por linha, sem `thead` (o leitor não sabe o que é cada coluna), sem coluna Ações, sem seleção em massa; só 6 telas usam `<table>` | `clientes.pagina.ts`, `bloqueios.pagina.ts`, `carteiras`, `metas`… |
| 10 | **Sem barra de filtros**: a lista de clientes tem só a busca; não há `Status ▾ · Etapa ▾ · Origem ▾ · Filtrar` | `clientes.pagina.ts` |
| 11 | **Paginação só "Carregar mais"**, sem "Mostrando N" nem total (o cursor é correto pelo ADR; o que falta é o rodapé informativo) | todas as listas |
| 12 | **Detalhe sem abas, sem feed e sem `dl` lateral**: a ficha é uma grade de cartões 2 colunas com edição inline campo a campo | `ficha.pagina.ts` |
| 13 | **Sem breadcrumb**: a ficha tem "← Voltar"; edição não tem trilha | `ficha.pagina.ts` |
| 14 | **Ícones em emoji** (menu, botões: 💬 🛒 🧾 ✅ ✎ ×) contra biblioteca de ícones | `nucleo/menu.ts` ("emoji por ora; vira ícone real depois"), `ficha.pagina.ts` |
| 15 | **Sem máscaras BR** nem validação por campo com mensagem tipificada fora de `ui-campo` | — |
| 16 | **Sem `stat-card`, abas, breadcrumb, lista de definição, select paginado, botão CSV, filtro de período** na biblioteca | `compartilhado/ui/index.ts` |

Resumo: o GeraCRM tem a **base** (tokens, estados, cursor) e não tem a **camada de composição** (os seis
padrões da §4.1). Cada tela compõe do zero, e por isso cada formulário sai diferente.

### 4.3 O padrão proposto — "disposição AM, pele GeraCRM"

Adota-se a anatomia dos seis padrões da §4.1 **com os tokens do GeraCRM** (`--acao` no lugar do âmbar,
Geist, `.txt-*`, `--raio-painel`, temas claro/escuro). Regras que valem para todos:

- **Tudo em cartão**: lista, filtros, formulário e detalhe vivem em `ui-painel` com borda, raio `--raio-painel` e sombra só no claro (já é assim no `estilos.css`).
- **Campo = rótulo visível acima + controle + dica/erro abaixo.** Asterisco no obrigatório. Placeholder só como exemplo de formato ("(00) 00000-0000"), nunca como rótulo. `id`/`for` ligados; `aria-invalid` no erro.
- **Grade de 2 colunas** (`gap: var(--espacamento-4)`), 1 coluna abaixo de 640 px; campo largo (nome, endereço, observações) ocupa as duas (`.largo`). Configurações usam 3 colunas a partir de 960 px.
- **Seções** dentro do formulário com título `.txt-rotulo` (maiúsculas pequenas) + ícone na cor de ação, separadas por `--espacamento-8`.
- **Rodapé de ações**: borda superior, alinhado à direita, ordem fixa `Voltar/Cancelar` (secundário) → **um** primário (`Salvar`) → opcional `Salvar e criar outro` (secundário). O botão mantém o nome do começo ao fim (regra de escrita já existente).
- **Validação**: no campo, com mensagem nomeando o que fazer; erro de negócio tipificado da API (422) vai para o campo certo, não para toast; o toast só confirma sucesso.
- **Celular**: modal vira tela cheia com rodapé fixo (como o `app-modal` do AM); formulário-página mantém o cartão com padding menor.
- **Largura**: formulário em `.pagina-forma`; lista, kanban e BI em `.pagina-densa`.

Decisão de escopo para as **listas**: o rodapé mostra "Mostrando 1–50 · Carregar mais" por **cursor**; o
total só aparece quando a API devolver `total` barato (estimativa do planner ou contador mantido), nunca
`count(*)` em tabela grande e nunca `OFFSET`. O visual do AM ("página 1 de 7") não se copia porque o ADR de
paginação proíbe — e o dono já viu o Postgres cair por isso.

### 4.4 Componentes a criar ou estender em `apps/console/src/app/compartilhado/ui/`

Todos com `OnPush`, tokens, foco visível e teste de spec; fichas a escrever em `docs/biblioteca-componentes.md`.

| Componente | O que é | Entradas/slots principais | Origem no AM |
|---|---|---|---|
| `ui-campo` (**estender**) | rótulo + controle + dica + erro | `tipo`: text/email/tel/number/password/search/**date/time/textarea/select/dinheiro**; `mascara`: cpf/cnpj/telefone/cep; `obrigatorio`; `dica`; `erro`; `largo`; slot `acao` (botão ao lado) | `.label` + `.input` + `error-msg`, `appMask` |
| `ui-select` | select nativo estilizado com placeholder "Selecione" e opções `{valor, rotulo}` | `opcoes`, `valor` (model), `vazio` | `<select class="input">` |
| `ui-select-paginado` | select com busca no servidor e página de 10 (vendedor, contato, produto) | `carregar(pagina, termo)`, `opcaoInjetada` (edição) | skill `angular-select-paginado` |
| `ui-secao-form` | título de seção com ícone, dentro do formulário | `titulo`, `icone` | `<section><h2 class="uppercase">` |
| `ui-form-pagina` | cartão de formulário: cabeçalho (título/subtítulo) + corpo + rodapé de ações | `titulo`, `subtitulo`, slots `corpo` e `rodape` | `lead-form` |
| `ui-grade-form` | grade de 2 (ou 3) colunas com `.largo` | `colunas` | `grid sm:grid-cols-2` |
| `ui-breadcrumb` | trilha `Leads › Novo Lead` | `itens[{rotulo, rota?}]` | `nav aria-label="breadcrumb"` |
| `ui-modal` | overlay + cartão com cabeçalho, corpo rolável e rodapé fixo; Esc e clique fora fecham; tela cheia no celular; prende o foco | `aberto`, `titulo`, `largura`, slot `rodape`, `fechar` | `app-modal` |
| `ui-tabela` | `<table>` com `thead`, linhas de 32–44 px, célula de nome com secundário, `nowrap` para mono, coluna Ações, seleção por checkbox opcional, esqueleto e vazio integrados | `colunas[{chave, rotulo, alinhamento, mono}]`, `linhas`, `selecionavel`, templates de célula | `.table`, `angular-list-pattern` |
| `ui-filtros` | cartão de filtros: busca com lupa + N controles rotulados + Filtrar/Limpar; `items-end` | slot de campos; `(aplicar)`, `(limpar)` | card de filtros das listas |
| `ui-paginacao` | rodapé "Mostrando N · Carregar mais" por cursor; aceita `total?` | `mostrados`, `total?`, `temMais`, `(mais)` | `app-pagination` (adaptado ao cursor) |
| `ui-acoes-lote` | faixa "N selecionado(s)" + botões de ação | `quantidade`, slot de ações, `(limpar)` | faixa de seleção dos Leads |
| `ui-abas` | abas por rota (`routerLink`) ou por estado, com borda inferior e contador opcional | `abas[{id, rotulo, icone?, contador?}]`, `ativa` (model) | `configuracoes-abas`, abas do detalhe |
| `ui-stat-card` | ícone colorido à esquerda + valor + rótulo (ou rótulo acima) | `valor`, `rotulo`, `icone`, `tom` | `app-stat-card` |
| `ui-filtro-periodo` | Data inicial / Data final / Aplicar / atalhos (Hoje, 7 dias, Mês atual) | `inicio`, `fim` (models), `(aplicar)` | `filtro-periodo` |
| `ui-lista-definicao` | `dl` rótulo/valor em 1–3 colunas (lateral "Informações") | `itens[{rotulo, valor, mono?}]`, `colunas` | lateral do detalhe |
| `ui-chips-etiqueta` | chips selecionáveis (etiquetas) | `opcoes`, `selecionadas` (model) | etiquetas do lead-form |
| `ui-feed` | linha do tempo (ícone, texto, autor, data) + caixa "Adicionar observação" | `itens`, `(adicionar)` | aba Feed |
| `ui-botao-csv` | exporta a lista corrente em CSV | `linhas`, `nomeArquivo` | `botao-csv` |
| `ui-icone` | biblioteca de ícones (Lucide, já usada pela skill do AM) substituindo emoji | `nome`, `tamanho` | `lucide-icons` |
| diretiva `uiMascara` | máscaras BR (cpf, cnpj, telefone, cep, dinheiro); grava só dígitos/centavos | `uiMascara="cpf"` | `mask.directive`, `angular-form-br` |

### 4.5 Telas a migrar para o padrão (ordem sugerida)

A ordem segue o uso diário: primeiro o que a vendedora abre toda hora, depois gestão, depois admin.

| Ordem | Tela (GeraCRM) | Padrão alvo | O que muda |
|---|---|---|---|
| 1 | Contatos (`clientes.pagina.ts`) | L + F + M | cabeçalho padrão; cartão de filtros (busca, segmento RFV, vendedor, estado); tabela com `thead` (segmento, nome, última compra, compras, total, ação, WhatsApp); `ui-paginacao`; "+ Novo contato" vira **formulário-página** `contato/novo` com seções Dados principais (nome*, empresa, e-mail, telefone*, WhatsApp, CPF, CNPJ + consultar), Endereço (CEP → preenche, endereço, cidade, UF), Classificação (vendedor/carteira, origem, etiquetas, modalidade atacado/varejo), Observações; importar CSV vira modal |
| 2 | Ficha do contato (`ficha.pagina.ts`) | D | breadcrumb; cartão-cabeçalho com chips (segmento RFV, qualificado, modalidade) e ações (Editar → F, Abrir conversa, Novo pedido, Tarefa, Agendar); abas Feed · Dados · Pedidos · Tarefas · WhatsApp · Agenda; lateral `ui-lista-definicao` (segmento, vendedor, origem, criado/atualizado), Produtos mais comprados, Arquivos, Etiquetas |
| 3 | CRM (Leads) (`leads.pagina.ts`) | Kanban + A | modais Qualificar com dados mínimos, Descartar com motivo obrigatório, Transferir (vendedor), Follow-up; menu do card; lista de leads (L) como visão alternativa com seleção em massa (mover etapa, alterar responsável) |
| 4 | Tarefas / Follow-ups (`tarefas.pagina.ts`) | L + A | cartões Pendentes/Atrasados/Hoje/Semana; abas; filtros (busca, tipo); modal Novo follow-up (contato, tipo, data, hora, detalhes); Concluir com resultado |
| 5 | Pedidos (`pedidos.pagina.ts`) e Pedido assistido | L + D | lista com cartão de filtros (busca, estado, vendedor, período) e tabela; detalhe em D com `dl` lateral e aba de itens |
| 6 | Opt-out / Bloqueios, Webhooks, Carteiras, Metas, Listas, Segmentos, Templates | L + M | lista em tabela + CRUD em `ui-modal` com grade de 2 colunas |
| 7 | Campanhas (`campanhas.pagina.ts`) | L + F (wizard) + D | lista com filtros/tabela; criação em 4 passos (Detalhes · Público · Mensagem · Revisão) num formulário-página; detalhe com métricas em `ui-stat-card` |
| 8 | Configurações Gerais, Config. do Canal, Agente, Meus Números | C | cabeçalho + `ui-abas` (Geral · Atendimento · Privacidade · Equipe / Conexão · Comportamento · Regras · Templates · Preços); cartões com cabeçalho; grade de 3 colunas; aviso somente leitura; Salvar à direita |
| 9 | Início (`inicio.pagina.ts`) | Dashboard | saudação; `ui-filtro-periodo`; quatro `ui-stat-card`; cartões por vendedor/carteira com cabeçalho; ranking; recentes; próximas tarefas |
| 10 | Painel de atendimentos, Funil | Kanban | panorama por vendedor com contadores por etapa → board |
| 11 | Catálogo, Cadastro de produtos, Conexões, Mídia paga, Auditoria, BI, Performance | L / C | tabela padrão, filtros padrão, export CSV |

### 4.6 O que NÃO muda — e uma decisão para o dono

- **Não muda**: tokens e cores (azul de ação, turquesa de assinatura, neutros), Geist, escala `.txt-*`,
  temas claro/escuro, os cinco estados, cursor nas listas, densidade de 32 px, zero cor literal (o lint
  continua), `packages/design-tokens` como fonte. O âmbar do AM **não** entra: ele é a marca do AMCRM,
  não um padrão de layout.
- **Decisão 1 — menu superior (AM) ou lateral (GeraCRM)?** Recomendo **manter o lateral**: o GeraCRM tem
  40 itens em 8 grupos (o AM cabe em 7 itens + 3 dropdowns), o chat rail depende da casca de 3 colunas e
  a casca de celular acabou de ser publicada. A "disposição similar" é obtida **dentro** da área de
  conteúdo (cabeçalho, cartões, filtros, tabela, formulário). Se o dono quiser o menu superior mesmo
  assim, é uma raia à parte (shell) e não bloqueia as demais.
- **Decisão 2 — ícones**: substituir emoji por Lucide (a skill `lucide-icons` já existe no AM e pode ser
  copiada). Recomendo fazer junto com a biblioteca (§4.4), porque toda tela migrada toca nos ícones.

### 4.7 Documentação e skills a atualizar

- `geracrm-layout-ui`: nova seção "Formato de formulário" com os seis padrões, a regra de rótulo/grade/rodapé e o mapa "que padrão usar quando" (formulário-página × modal × inline).
- `docs/biblioteca-componentes.md`: fichas dos componentes da §4.4 (anatomia, variantes, estados, armadilha).
- `docs/mapa-de-telas.md`: coluna "padrão de tela" (L/F/M/A/D/C) por rota.
- Copiar e adaptar do AM as skills `angular-form-br`, `angular-list-pattern`, `angular-select-paginated`, `lucide-icons` para `.claude/skills/geracrm-formularios` (vocabulário do GeraCRM, tokens, cursor).

---

## 5. Raias e ondas

Formato de execução igual ao do `plano-port-playbook-am.md`: cada raia ganha, ao começar, o bloco
`OBJETIVO / MIGRATION / ARQUIVOS / NÃO TOCAR / CONTRATO / TESTES / PRONTO`; roda em worktree próprio,
`pnpm lint typecheck test` verde **e** revisão adversarial (`revisar-raia`) antes de entrar na `main`.
Migrations aditivas, com RLS, numeradas a partir de **0111** na ordem de integração.

### 5.1 Quadro de raias

| Raia | Lote | Escopo | Depende de | Migration | Tam. |
|---|---|---|---|---|---|
| **L0** | Layout | Biblioteca de componentes e o formato de formulário (§4.4); skill `geracrm-formularios`; ícones | — | não | G |
| **D3** | Gestão | Escopo por papel nas consultas; Usuários; Filiais | — | sim | G |
| **H3** | Operação | monitor-cron + alertas (backup fora, decisão do dono) | — | não | M |
| **H2** | Operação | Retenção e anonimização LGPD | D5 (campo de retenção) | sim | P/M |
| **A1** | Contato | Cadastro completo (formulário-página), endereço, CNPJ/CEP | L0 | sim | M |
| **A4** | Contato | Etiquetas e origens | L0 | sim | P/M |
| **A2** | Contato | Lista com filtros, tabela, ações em massa | L0, A1, A4, D3 | não | M |
| **A3** | Contato | Ficha com feed, abas, lateral, perfil de compra, arquivos | L0, A1, A4, C1 | sim | G |
| **A5** | Contato | Pedidos no padrão de lista | L0 | não | P |
| **C1** | Tarefas | Tarefas v2 + modal + "sem próximo passo" | L0 | sim | M |
| **B2** | Funil | Modais ganhar/perder/transferir/tarefa; nova oportunidade | L0, C1 | sim | M |
| **G1** | Inbox | Devolver ao agente, reatribuir, filtro | — | não | P/M |
| **B1** | Funil | Panorama + board com filtros | L0, A4 | não | M |
| **C2** | Agenda | Módulo opcional por tenant: calendário, eventos, status, lembretes | L0 | sim | G |
| **C3** | Agenda | Reunião pelo CRM e pelo agente (chave própria, padrão desligado), horários livres, no-show | C2, G1 | sim | G |
| **D1** | Gestão | Cockpit do gestor | C1, C2, D3 | não | M |
| **D2** | Gestão | Higienização da carteira | A2, C1, D3 | não | M |
| **D4** | Conta | Notificações, perfil, esqueci a senha | L0 | sim | M |
| **D5** | Conta | Configurações gerais com abas (contato, LGPD, retenção) | L0 | sim | P |
| **D6** | Gestão | Auditoria com filtros, CSV, detalhe | L0 | não | P |
| **E1** | Painel | Início v2; `relatorio-dimensao`; filtro de período; CSV | L0 | não | M |
| **E2** | Relatórios | 1ª leva (por dimensão, tempo de conversão, vendedores, vendas, operacional, WhatsApp) | E1, D3 | views | G |
| **E3** | Relatórios | 2ª leva (comparativo, visão geral, completo, raio-X, desempenho, impressão) | E2 | views | G |
| **F2** | Consumo | Preços do WhatsApp, mapeamento de templates, tela Consumo | L0 | sim | M |
| **F1** | Campanhas | Wizard, template, público com exclusões, lote diário, pausa automática, destinatários | L0, A4, F2 | sim | G |
| **F3** | Captação | Formulários públicos (builder, página, respostas) | L0, A4 | sim | G |
| **G2** | Agente | Objeções no playbook + tool; seções de texto | — | sim | M |
| **G3** | Agente | Pós-venda, NPS e indicações pelo agente; prova social | — | sim | M |
| **G4** | Agente | Roteamento do handoff e rodízio | D3 | sim | M |
| **G5** | Agente | Cadência: descarte após T4 e reativação | — | não | P |
| **H1** | Dados | Importador com simulação e conferência | A1, D3 | sim | M |
| **H4** | Operação | e2e no CI | — | não | M |
| **L1** | Layout | Retrofit das telas não tocadas pelas raias acima (§4.5 #8–#11) | L0 | não | M |

### 5.2 Ondas e ordem de integração

| Onda | Raias (∥ = em paralelo) | Ordem de integração | Entrega |
|---|---|---|---|
| **0 — fundação** | L0 ∥ D3 ∥ H3 ∥ G1 | L0 → D3 → G1 → H3 | biblioteca + padrão de formulário; vendedor só vê o que é dele; monitor com alerta |
| **1 — o dia a dia** | A1 ∥ A4 ∥ C1 ∥ A5 → A2 ∥ B2 → A3 | A1 → A4 → C1 → A5 → A2 → B2 → A3 | cadastro, lista, ficha e tarefas no formato do AM |
| **2 — gestão** | B1 ∥ C2 ∥ D4 ∥ D5 ∥ D6 ∥ E1 → C3 ∥ D1 ∥ D2 ∥ H2 | D5 → H2 → E1 → B1 → C2 → C3 → D4 → D6 → D1 → D2 | panorama, agenda, cockpit, carteira, notificações, perfil |
| **3 — campanhas e relatórios** | F2 ∥ G2 ∥ G3 ∥ G5 ∥ H4 → F1 ∥ F3 ∥ G4 ∥ H1 → E2 → E3 | F2 → F1 → F3 → G2 → G3 → G4 → G5 → H1 → H4 → E2 → E3 | campanhas v2, consumo, formulários, 17 relatórios |
| **4 — retrofit** | L1 | L1 | todas as telas no padrão |

Regras: uma raia por worktree; raias da mesma onda não editam o mesmo arquivo (o quadro de donos é
escrito no início da onda, como na §2.2 do plano do port); quem toca `menu.ts`/`rotas.ts` é só L0 e L1.
Toda tela nova passa por `especificar-telas` → padrão da §4 → `geracrm-console-angular` → tokens.

### 5.3 O que a onda 0 precisa fechar antes das outras começarem

- **L0 — contrato mínimo**: `ui-campo` com todos os tipos e máscaras; `ui-form-pagina`, `ui-secao-form`,
  `ui-grade-form`; `ui-modal`; `ui-tabela`, `ui-filtros`, `ui-paginacao`, `ui-acoes-lote`; `ui-abas`;
  `ui-breadcrumb`; `ui-stat-card`; `ui-filtro-periodo`; `ui-lista-definicao`; `ui-chips-etiqueta`;
  `ui-icone`. Cada um com spec e ficha em `docs/biblioteca-componentes.md`. A primeira tela migrada
  (Contatos, A1 + A2) é a **prova** do contrato — se ela precisar de algo que a biblioteca não tem, o
  componente nasce em L0, nunca na tela.
- **D3 — contrato mínimo**: função única `escopoDoUsuario(req)` → `{tipo: 'tudo'|'filial'|'carteira', ids}`
  aplicada nas consultas por um helper de query; fora do escopo responde **404**, nunca 403 (não revela
  existência). Teste por papel em cada rota tocada; teste de que `workerDoTenant` continua passando.

---

## 6. Decisões do dono

Respondidas em 2026-11-03.

| # | Decisão | Resposta | Efeito no plano |
|---|---|---|---|
| 1 | Direção: AM Consórcio é a referência e o GeraCRM o alvo? | **Sim** | premissa confirmada |
| 2 | Menu lateral (atual) ou superior (AM)? | **Manter o lateral** | a disposição do AM vale dentro da área de conteúdo (§4) |
| 3 | Trocar emoji por Lucide? | **Sim** | `ui-icone` entra em L0 |
| 4 | Agenda e reunião pelo agente entram? | **Sim, como módulo à parte**, habilitável; e o agente marcar reunião é ligável ou não | C2 vira módulo por tenant (padrão desligado); C3 ganha chave própria por número (padrão desligado); cockpit e "sem próximo passo" funcionam sem a agenda |
| 5 | Site Social e Influenciadores entram? | **Não** | F4 removida; parceiros saem de A4; #73 e #83 viram ⛔ |
| 6 | Dados mínimos ao ganhar um negócio | **CNPJ, razão social, nome fantasia e endereço** | B2 exige esses quatro; A1 cria `razao_social` e `nome_fantasia`; regra em `packages/shared` + 422 na API |
| 7 | Backup e monitor | **Não mexer com backup agora** | H3 fica só com o monitor; backup e IaC adiados como risco aberto |

**Ainda sem resposta** (o plano segue a recomendação até o dono dizer o contrário):

| # | Decisão | Recomendação seguida |
|---|---|---|
| 8 | Financeiro de vendas (parcelas, titular) fica fora porque o ERP efetiva? | Fora |
| 9 | Texto longo do playbook (roteiro, processo): playbook ou Conhecimento? | Conhecimento; o playbook guarda regras, não prosa |

---

## 7. Apêndice — o que o GeraCRM tem e o AM não tem (não é lacuna)

Catálogo com grade cor × tamanho e origem múltipla; pedido assistido com efetivação idempotente no ERP e
"propor-e-confirmar" com alçada; conectores de ERP com capacidades declaradas e degradação visível; RFV
explicável (Fila do Dia, Retenção, Segmentos, CRM Avançado, Mercado, Mapa); Fidelidade/cashback lido do
ERP; Sequências, Metas, Automações, Listas; Mídia paga com ROI por anúncio e landing pages; Webhooks de
saída assinados; multi-tenant com Plataforma, staff e catálogo de modelos de IA por cliente; dois temas e
casca de celular; SSE com outbox (o AM faz polling); Web Push; presença na conversa; editar/apagar
mensagem; cards de ação; conhecimento versionado com busca semântica; painel de fase do go-live;
partições mensais; saúde em três estados.

---

## 8. Fontes consultadas

- AM: `CLAUDE.md`, `docs/ARQUITETURA.md`, `docs/TAREFAS.md`, `docs/mapeamento-amcrm.md`, `docs/BACKLOG-PRODUTO.md`,
  `docs/mapeamento/clone/*.jpg`, `docs/mapeamento/screenshots/09-lead-create.jpg` e `10-lead-view.jpg`,
  `frontend/src/app/app.routes.ts`, `layout/*`, `features/**`, `shared/**`, `frontend/src/styles.scss`,
  `.claude/skills/{angular-list-pattern,angular-form-br,angular-select-paginated,design-tokens}`,
  `backend/src/main/java/br/com/amconsorcio/crm/**` (controllers, jobs), `backend/src/main/resources/db/migration`,
  `agent-worker/src/**`, `infra/`, `.railway/`, `docker-compose.e2e.yml`.
- GeraCRM: `CLAUDE.md`, `docs/plano-port-playbook-am.md`, `docs/onde-estamos.md`, `docs/mapa-de-telas.md`,
  `docs/identidade-visual.md`, `docs/biblioteca-componentes.md`, `.claude/skills/geracrm-layout-ui/SKILL.md`,
  `apps/console/src/app/{rotas.ts,nucleo/menu.ts,nucleo/shell.componente.ts,compartilhado/ui/*,funcionalidades/**}`,
  `apps/console/src/estilos.css`, `apps/api/src/{app.ts,server.ts,contexts/**,workers/*}`, `infra/`,
  `.github/workflows/ci.yml`.
