# Execução do plano de paridade AM — subtarefas e modelo por etapa

> Detalha cada raia de `docs/plano-paridade-am.md` §5 em subtarefas, com o **modelo mais barato que
> resolve** cada uma. Plano vivo: o quadro §0 é a fonte de verdade do andamento (o loop de 10 min lê
> daqui qual é a próxima tarefa). Linha de base em 2026-11-03 sobre `main` 0a44e61: lint, typecheck e
> test verdes (api 2170, shared 879, console 343, conectores 46).

## 0. Quadro de estado

Legenda: ⬜ a fazer · 🔄 em andamento (agente rodando) · 🔍 em revisão · ✅ integrada em `feat/paridade-am` · ⏸ bloqueada.

| Raia | Onda | Estado | Branch / observação |
|---|---|---|---|
| L0a primitivos de formulário | 0 | ✅ | integrada; revisão conjunta feita (R0) e corrigida (R0b) |
| L0b composição (página, modal, abas) | 0 | ✅ | integrada; revisão conjunta feita (R0) e corrigida (R0b) |
| L0c lista (tabela, filtros, paginação) | 0 | ✅ | integrada; revisão conjunta feita (R0) e corrigida (R0b) |
| L0d ícones Lucide | 0 | ✅ | integrada; desenhos de memória — revisão aponta os suspeitos |
| L0e docs e skill de formulários | 0 | ✅ | integrada; skill `geracrm-formularios` criada; docs ajustados ao contrato por cursor |
| D3 escopo por papel + usuários + filiais | 0 | ✅ | integrada com as correções de segurança (staff fora do cadastro, assumir no escopo, SSE filtrado, modo fundador fora do cadastro); suíte verde api 2676; **dono: IAM ListUsers+AdminListGroupsForUser e semear admin de cada cliente (runbook §18)** |
| G1 devolver ao agente / reatribuir / filtro | 0 | ✅ | integrada com correções (etapa `devolucao-da-equipe` no pipeline, guarda de concorrência, turno enfileirado) |
| H3 monitor | 0 | ✅ | integrada; dono cria o cron service no Railway (README) |
| A1 cadastro do contato | 1 | ✅ | integrada com correções (ERP preservado, 422 no telefone, origem validada); 0112 corrigida no lugar |
| A4 etiquetas e origens | 1 | ✅ | integrada (0113); revisão aprovou |
| C1 tarefas v2 | 1 | ✅ | integrada com correções (validação Zod, cursor µs, responsável nulo, autorização); 0114 corrigida no lugar |
| A5 pedidos em lista | 1 | ✅ | integrada; API não tem busca/período/contadores — cards e busca só no carregado |
| A2 lista de contatos + massa | 1 | ✅ | integrada (sem migration; filtro de etiqueta otimizado com EXISTS) |
| B2 modais do funil + ganho | 1 | ✅ | integrada com correções (0122 corrigida no lugar) |
| A3 ficha 2+1 | 1 | ✅ | integrada (0115); feed lê a auditoria de `qualificarContato`; 'Enviar no WhatsApp' do arquivo fica para quando o inbox enviar mídia por id |
| D5 configurações com abas + módulos | 2 | ✅ | integrada (0116); `exigirModulo('agenda')` e `ModulosServico` prontos |
| H2 LGPD retenção/anonimização | 2 | ✅ | integrada após 2 revisões (seletor reavaliado na transação, pedidos pendentes protegem, automática desligada por padrão com prévia, admin do tenant, contato anonimizado imutável, worker de mídia) |
| E1 início v2 + base de relatórios | 2 | ✅ | integrada (0123: índices de período); escopo por papel nos agregados entra com D3/E2 |
| B1 panorama do funil | 2 | ✅ | integrada (0131) |
| C2 agenda (módulo) | 2 | ✅ | integrada (0117); escopo comum e aba na ficha entregues pela C2b |
| C3 reunião pelo CRM e pelo agente (chave) | 2 | 🔍 | integrada (0137); chave por número padrão desligado; lembretes H-24/H-2 e no-show só para reuniões nascidas na conversa; revisão Opus em curso |
| D4 notificações, perfil, esqueci a senha | 2 | ✅ | integrada com as correções da revisão (0144/0145: sessão de staff no armazém do token, GlobalSignOut na troca de senha e AdminUserGlobalSignOut na redefinição, limite por e-mail, upsert com tipo novo, worker de e-mail com reserva); **dono: IAM `cognito-idp:AdminUserGlobalSignOut`** |
| D6 auditoria v2 | 2 | ✅ | integrada; login/logout entregues pela D4; pendente: janela padrão da busca `q` |
| D1 cockpit | 2 | ✅ | integrada (0129); agenda pelo escopo comum |
| D2 higienização da carteira | 2 | ✅ | integrada; `filialId` da lista de contatos passou a ser a filial efetiva (contato ou dono) |
| F2 preços, templates, consumo | 3 | ✅ | integrada (0124) |
| F1 campanhas v2 | 3 | 🔄 | F1a integrada (0134) — correção da revisão em curso (alto: tier 250/24h, rajada no não-oficial, queda no meio); F1b ✅ telas integradas (lista, wizard, detalhe; console 899) — pendências de API: filtro de templates por status/categoria, busca em listas/etiquetas/origens, rótulos do público no GET — **não ligar campanha em cliente antes da correção da F1a** |
| F3 formulários públicos | 3 | ✅ | re-revisão curta Sonnet em curso · integrada com as correções de segurança (upload fora da transação, IP real via `TRUST_PROXY_HOPS`, contato existente só com "Aplicar ao contato", assinatura de arquivo, clickjacking, hash do texto LGPD); 0127 editada no lugar; **dono: `TRUST_PROXY_HOPS=2` na API do Railway**; re-revisão curta pendente |
| G2 objeções | 3 | ✅ | integrada com correções (uma por turno, grava no turno confirmado, teto 20 mil) |
| G3 pós-venda, NPS, indicações, prova social | 3 | ✅ | integrada com as correções da revisão (0141: índice parcial e reagendamento; indicações padrão desligado, com portão e teto; NPS passa o portão com equipe disponível; prova social amarrada à versão; espalhamento e teto no não-oficial); runbook §19 |
| G4 roteamento e rodízio | 3 | ✅ | integrada com as correções da revisão (gestor de filial só cria regra para número da própria filial; roteamento por filial no handoff só com opt-in; simulador e números no escopo; aviso ao ligar sem elegíveis) |
| G5 cadência descarte/reativação | 3 | ✅ | integrada com correções (descarte desligado por padrão, só sem compra; teto de reativação por número; trava conversa+contato) |
| H1 importador | 3 | ✅ | integrada com as 13 correções da revisão (LGPD: titular bloqueado e contato anonimizado ignorados; arrendamento pelo relógio do banco e contagens dos itens; simulação fiel; venda sem referência idempotente por conteúdo; `simulada_em` obrigatória — migration 0140; windows-1252 e UTF-16 recusado; conferência só criados/atualizados) |
| H4 e2e no CI | 3 | ✅ | integrada; 8/8 em ~13 s; passo novo no ci.yml (não rodado em runner real) |
| E2 relatórios 1ª leva | 3 | ✅ | integrada com as correções da revisão (sistema e falhas fora de "enviadas", ranking no escopo, vazio, base do percentual, escopo materializado, 1ª resposta negativa, cliente antigo do ERP fora do tempo de conversão) |
| E3 relatórios 2ª leva | 3 | ✅ | integrada com as correções da revisão (cursor estrito, filial no escopo do gestor, coorte materializada por requisição, telefone sem apóstrofo no CSV); faixa etária fora (sem data de nascimento) |
| L1 retrofit das telas restantes | 4 | 🔄 | L1a ✅ (8 telas); L1b ✅ (canais, canal-config, templates, automações, catálogo, catálogo-produtos, conexões, mídia); L1c Haiku em curso (nps, fidelidade, carteiras, leads, anúncio-ROI, mapa, mercado, BI, performance, clientes da plataforma); L1d ✅ (kanban de atendimento, fila do dia, CRM avançado, funil, pedido); L1e Sonnet em curso (inbox); R2 Sonnet em curso (ui-select-multi, rodapé do modal em @if, ui-estado com ícone, ui-botao-icone, inputmode); R1 ✅ integrada (maxlength/min/max/step no campo, type/form no botão, rodapé da tabela, 9 ícones conferidos no lucide-static); pendente: multi-select local da F1b (`app-seletor-multi`) a promover para a biblioteca; `ui-modal` não projeta `[rodape]` dentro de `@if` com vários nós |
| X1 teste de ativas dependente de hora | — | ✅ | causa: semente com `now()` real, ordenação lia a linha errada; só teste |
| R0b correções da biblioteca L0 | 0 | ✅ | integrada; select paginado por cursor; console 549 testes |
| G1b correções da G1 | 0 | ✅ | Opus (etapa de pipeline + concorrência) |
| D3.4 telas de usuários e filiais | 0 | ✅ | integrada (console 656); conferir códigos de erro com a API quando D3 entrar |
| C2b agenda no escopo comum + na ficha | 2 | ✅ | integrada; contato fora do escopo → 422 e nome oculto na leitura |
| X3 teste do worker de aquisição sem isolamento de tenant | — | ✅ | integrada |
| D3.4b telas de usuário sem admin atribuído + nomear admin | 0 | ✅ | integrada; API passou a responder `acesso.admin_atribuido` no modo fundador; select de usuários entregue pela X4 |
| X2 cursores de pedidos e memória com µs | — | ✅ | integrada |
| X4 cursor em listas/metas/segmentos + usuários do cliente para o staff | — | ✅ | integrada; listas por cursor; metas e segmentos com teto documentado (limitados por construção); "Nomear admin" com select paginado; agregação RFV movida para SQL |
| X5 busca/filtros no servidor (templates por status/categoria/número; q em listas, etiquetas, origens) | — | 🔄 | Haiku; para as telas da F1b |
| X6 sobras: pedidos com busca/período/contadores na API (A5), janela padrão da busca `q` da auditoria (D6), SLA estourado avisa primeiro o gestor da filial (G4) | — | ⬜ | Sonnet; abrir quando a carga baixar |
| R0 revisão adversarial da biblioteca L0 | 0 | ✅ | aprovado com correções; correção Sonnet em curso (Esc, CSV, máscara, select paginado → cursor) |

> Última suíte completa em `feat` (após G4, D4, E3): api 2973, console 856, shared 1075 — verde. `formularios.test.ts` (anexo) oscilou uma vez sob carga 50+; passou isolado.

> Migrations 0112 e 0114 corrigidas no lugar (NOT VALID + VALIDATE) antes de qualquer deploy; bancos locais precisam do hash atualizado em `schema_migrations` ou recriação.

## 1. Política de modelos

Regra: **o modelo mais barato que entrega a subtarefa com o teste verde na primeira ou segunda tentativa**.
Subir de modelo só quando a subtarefa falhar duas vezes ou quando o erro custar caro (segurança, dinheiro,
mensagem para cliente).

| Modelo | Custo relativo | Usar para | Nunca usar para |
|---|---|---|---|
| **Haiku 5.5** | 1× | docs e fichas, troca mecânica (emoji → ícone, rótulos), tela só-leitura copiando um exemplar, função pura com contrato dado e casos de teste listados, CSV/export, ajuste de menu | regra de acesso, migration com RLS, ferramenta do agente |
| **Sonnet 5.5** | ~3× | CRUD padrão (migration aditiva + rotas + teste de 2 tenants + tela no padrão), componentes de UI, relatórios com view, revisão adversarial das raias comuns | escopo de acesso transversal |
| **Opus 5.5** | ~5× | segurança e acesso (D3), ferramentas e pipeline do agente (C3, G2, G3, G4), dinheiro e disparo (F1), revisão das raias de risco | trabalho mecânico |
| **Fable 5.1** (orquestrador) | — | contratos entre raias, ordem de integração, merge, decisão quando duas revisões discordam | implementar subtarefa |

Etapas de toda raia e o modelo padrão de cada uma:

| Etapa | Padrão | Sobe para |
|---|---|---|
| 1. Bloco da raia (ARQUIVOS / NÃO TOCAR / CONTRATO / PRONTO) | Fable (orquestrador, no brief) | — |
| 2. Migration + rotas + testes de API | Sonnet | Opus em D3, C3, F1, G2–G4 |
| 3. Regras puras (`*.regras.ts`, `packages/shared`) | Haiku com os casos listados | Sonnet se envolver data/fuso/dinheiro |
| 4. Tela no padrão da §4 | Sonnet (Haiku quando é só-leitura e há exemplar) | — |
| 5. Revisão adversarial (`revisar-raia`) | Sonnet | Opus nas raias de risco |
| 6. Docs, fichas, skill, quadro | Haiku | — |
| 7. Merge e checks completos | Fable | — |

⚠️ `pnpm --filter X lint typecheck test` roda SÓ o lint (os outros nomes viram argumentos); rodar `pnpm lint && pnpm typecheck && pnpm test` dentro do pacote. O console precisa de `pnpm --filter @geracrm/design-tokens build` antes do typecheck. Os worktrees nascem da `main`, não de `feat/paridade-am`: o brief tem de trazer o que o agente precisa do plano.

Ambiente de cada agente (worktree): `export PATH="$HOME/.local/bin:$PATH"`; copiar `.env` da raiz; banco
próprio `geracrm_<raia>` (skill `geracrm-testes` §Banco próprio por raia); `CI=true pnpm install
--frozen-lockfile`; build de `shared` e `conectores`; checks do pacote tocado verdes antes do commit;
commit no próprio branch, **sem merge**. Migrations numeradas na ordem de integração a partir de 0111
(reservas na §2 de cada raia).

## 2. Subtarefas por raia

### Onda 0 — fundação

**L0a — Primitivos de formulário** · Sonnet · sem migration
- `ui-campo` estendido: tipos text/email/tel/number/password/search/date/time/datetime/textarea/select/dinheiro; `rotulo` visível ligado por `for/id`; `obrigatorio` (asterisco + `aria-required`); `dica`; `erro` (`aria-invalid` + `aria-describedby`); `largo`; slot `[acao]` (botão ao lado); compatível com Reactive Forms (ControlValueAccessor) e com `model()`; mantém a API atual (2 usos não quebram).
- `ui-select` (opções `{valor, rotulo}`, placeholder "Selecione", CVA).
- `ui-select-paginado` (carregar(página, termo) → `{itens, temMais}`; debounce 300 ms; `opcaoInjetada` para edição).
- Diretiva `uiMascara` (cpf, cnpj, cpfCnpj, telefone, cep, dinheiro); grava só dígitos/centavos; funções puras de máscara em `compartilhado/ui/mascaras.ts` — **Haiku** escreve as funções puras e os casos de teste depois que o Sonnet fixa a assinatura.
- Testes: spec de cada componente (renderiza rótulo, erro, aria, máscara ida e volta).

**L0b — Composição de tela** · Sonnet · sem migration
- `ui-form-pagina` (cartão: cabeçalho título/subtítulo, corpo, rodapé à direita com borda), `ui-secao-form` (título `.txt-rotulo` + ícone), `ui-grade-form` (2 col; `colunas=3`; `.largo`; 1 col < 640 px), `ui-breadcrumb`, `ui-modal` (Esc, clique fora, foco preso, tela cheia < 720 px com rodapé fixo, `largura` p/m/g), `ui-abas` (por rota ou por estado, contador opcional, rolagem horizontal sem barra vertical), `ui-lista-definicao` (dl 1–3 colunas, `mono`), `ui-chips-etiqueta` (seleção múltipla, model).
- `ui-cabecalho-tela` ganha slot de breadcrumb e passa a usar `.txt-titulo`.
- Testes: spec de cada um (foco preso e Esc no modal; aba ativa por rota).

**L0c — Lista** · Sonnet · sem migration
- `ui-tabela` (colunas `{chave, rotulo, alinhamento, mono, largura}`, templates de célula por chave, `thead` real, seleção por checkbox com "todos da página", esqueleto e vazio embutidos, rola dentro da caixa), `ui-filtros` (busca com lupa + slot de controles + Filtrar/Limpar, `align-items:end`, quebra em linhas), `ui-paginacao` ("Mostrando N[ de T] · Carregar mais", cursor), `ui-acoes-lote` (faixa "N selecionados" + slot + Limpar), `ui-stat-card` (ícone + valor + rótulo, tons por token, rótulo acima opcional), `ui-filtro-periodo` (início/fim + atalhos Hoje/7d/30d/Mês atual/Mês passado, models), `ui-botao-csv` (gera CSV no cliente; função pura `paraCsv` — **Haiku** com casos: aspas, `;`, quebra de linha, BOM).
- Testes: spec de cada um.

**L0d — Ícones Lucide** · Haiku · sem migration
- `ui-icone` com mapa local de caminhos SVG copiados do Lucide (licença ISC citada no arquivo; sem dependência nova) — os ~40 ícones usados no menu e nas ações; `tamanho` 14/18; `aria-hidden` por padrão, `rotulo` opcional.
- Troca o campo `icone` do `menu.ts` de emoji para nome Lucide e o shell desenha `ui-icone`; ajusta o teste do menu.
- Não toca nas telas (as telas trocam emoji quando migrarem).

**L0e — Docs e skill** · Haiku · depois de L0a–d
- Fichas em `docs/biblioteca-componentes.md` para cada componente novo; seção "Formato de formulário" em `geracrm-layout-ui` (os seis padrões e quando usar cada um); skill `geracrm-formularios` adaptada das skills do AM (`angular-form-br`, `angular-list-pattern`, `angular-select-paginated`) com o vocabulário e os tokens do GeraCRM.

**D3 — Escopo por papel, usuários e filiais** · Opus (API) + Sonnet (telas) · migration 0111 · revisão Opus
- D3.1 (Opus) `escopoDoUsuario(tx, quem)` → `{tipo:'tudo'|'filial'|'carteira', filialIds, usuarioId}`: admin/gestor sem filial = tudo; gestor/supervisor com filial = filial; vendedor/atendente = carteira própria (contatos cuja carteira vigente é dele + conversas atribuídas a ele); modo fundador e staff = tudo. Helper de SQL `filtroDeEscopo(tx, escopo, alias)`.
- D3.2 (Opus) aplicar em: `GET /v1/contatos`, `/busca`, `/:id` (404 fora do escopo), `/v1/conversas` (lista e detalhe), `/v1/tarefas`, `/v1/pedidos`, `/v1/funil/coluna`, `/v1/leads/coluna`, `/v1/carteiras/contatos`, `/v1/fila-do-dia`. Teste por papel em cada rota (vendedor A não vê contato de B; gestor da filial X não vê Y; admin vê tudo; fundador vê tudo).
- D3.3 (Sonnet) migration 0111: `usuario` ADD `telefone`, `cargo`, `ultimo_login_em`; `filial` ADD `cor`, `tipo` ('matriz'|'filial'), `ativa` (se faltar). Rotas `GET/POST/PATCH /v1/usuarios` (admin; criar = Cognito `AdminCreateUser` atrás de uma porta com adaptador falso em teste; papéis por filial; ativar/desativar), `GET/POST/PATCH /v1/filiais` (admin).
- D3.4 (Sonnet) telas Usuários (padrão L + M) e Filiais (L + M) usando L0; itens de menu em Gestão.
- D3.5 (Haiku) atualizar `geracrm-identidade-acesso` e o plano.

**G1 — Devolver ao agente, reatribuir, filtro** · Sonnet · sem migration (🔎 confirmar colunas)
- `POST /v1/conversas/:id/devolver-agente` {motivo, observacao?}: só quem conduz ou admin/gestor; encerra o atendimento humano, volta o modo da conversa ao agente, registra auditoria e evento `conversa.devolvida`; o próximo turno do agente recebe o motivo no contexto.
- `POST /v1/conversas/:id/reatribuir` {usuarioId, motivo}: admin/gestor/supervisor; notifica o novo responsável; entra no feed.
- Filtro "Conduzido por: agente · humano · aguardando" em `GET /v1/conversas`.
- Inbox: botões e modais (motivo por rádio + outro) usando `ui-modal` se L0b já estiver integrada; senão modal local simples marcado para L1.
- Testes de 2 tenants, de papel e de evento.

**H3 — Monitor** · Sonnet · sem migration
- `infra/monitor/`: script Node sem dependências que roda a cada 5 min (cron do Railway): `GET /saude/detalhada`, `GET` do console, alerta "webhook parado" (sem inbound há N min em horário comercial, via campo novo em `/saude/detalhada` só com agregados), envio para Slack ou Discord por env, dedupe sem estado (janela por hash do motivo), heartbeat opcional (Healthchecks.io); README com o cadastro no Railway. Testes do script com fetch falso.

### Onda 1 — o dia a dia

**A1 — Cadastro do contato** · Sonnet · migration 0112
- Migration: `contato` ADD `razao_social`, `nome_fantasia`, `email`, `prioridade`, `temperatura`, `origem_id` (FK quando A4 existir; até lá `origem` texto), `valor_estimado_centavos`, `observacoes`, `modalidade` se faltar.
- `PUT /v1/contatos/:id` completo + `POST /v1/contatos` completo (422 por campo), endereço junto; consulta de CNPJ (`GET /v1/consultas/cnpj/:cnpj` atrás de porta; adaptador BrasilAPI; cache 24 h; falso em teste) e CEP (`/v1/consultas/cep/:cep`).
- Telas `contato/novo` e `contato/:id/editar` (padrão F, seções Dados principais · Endereço · Classificação · Observações; "Salvar e criar outro").
- Haiku: regras puras de validação (CNPJ/CPF já em shared? reaproveitar) e casos de teste.

**A4 — Etiquetas e origens** · Sonnet (API) + Haiku (telas M) · migration 0113
- `etiqueta`, `contato_etiqueta`, `origem` com RLS; CRUD `/v1/etiquetas`, `/v1/origens`; `PUT /v1/contatos/:id/etiquetas`.
- Telas no padrão L + M (Haiku copiando a de Filiais).

**C1 — Tarefas v2** · Sonnet · migration 0114
- `tarefa` ADD `tipo`, `responsavel_id`, `descricao`, `resultado`, `concluida_por`; filtros e contadores (`GET /v1/tarefas/contadores`); concluir com resultado; criação em lote (`POST /v1/tarefas/lote`).
- Componente `app-tarefa-modal` reutilizável; tela Tarefas no padrão L com cards.
- "Sem próximo passo": campo derivado em contatos/funil (sem tarefa aberta futura e, com o módulo Agenda ligado, sem evento futuro) — Haiku escreve a regra pura e os casos.

**A5 — Pedidos em lista** · Haiku · sem migration
- Tela Pedidos no padrão L (cards do mês, filtros, tabela) + detalhe no padrão D reaproveitando o modal atual.

**A2 — Lista de contatos + massa** · Sonnet · sem migration
- Filtros em `GET /v1/contatos` (qualificação, segmento, vendedor, filial, origem, etiqueta, busca), respeitando D3; `POST /v1/contatos/acoes-em-massa/:acao` (qualificar, descartar, transferir, etiquetar, adicionar-lista, criar-tarefa; ≤ 500 ids; auditoria; escopo).
- Tela Contatos no padrão L (tabela, filtros, seleção, faixa de lote, modais).

**B2 — Modais do funil + ganho** · Sonnet · sem migration própria
- Regra `dadosMinimosDoGanho` em `packages/shared` (CNPJ válido, razão social, nome fantasia, endereço completo) — Haiku com os casos; API valida (422 por campo) ao mover para etapa tipo Ganho; modais Ganhar (pré-preenchido + consultar CNPJ + abrir/vincular pedido), Perder, Transferir, Tarefa; botão "Nova oportunidade".

**A3 — Ficha 2+1** · Sonnet · migration 0115
- `contato_arquivo` (bucket) + rotas; `GET /v1/contatos/:id/feed` (comentários + movimentações + tarefas + pedidos + handoffs, cursor); tela no padrão D com Perfil de compra (memória), abas e lateral.

### Onda 2 — gestão

- **D5** · Haiku (tela) + Sonnet (migration 0116: `tenant` ADD contato e LGPD; `tenant_modulo`) — abas Geral · Agente · Números · Playbook; chave do módulo Agenda.
- **H2** · Sonnet — job mensal de anonimização (descartados > retenção, opt-out > 15 dias), auditado, com teste de dois tenants.
- **E1** · Sonnet — `relatorio-dimensao` + `GET /v1/painel/inicio?inicio&fim` + `GET /v1/relatorios/contatos-por/:dimensao`; Início v2.
- **B1** · Sonnet — `GET /v1/funil/panorama`; tela panorama → board com filtros.
- **C2** · Sonnet — migration 0117 `evento_agenda`; rotas atrás do módulo (404 desligado); tela Agenda; aba na ficha.
- **C3** · Opus — horários livres, botão na conversa, tool `agendar_reuniao` registrada **só** com módulo ligado **e** chave do número ligada (padrão desligado), lembretes e no-show; migration 0118 (chave no agente_config).
- **D4** · Sonnet — página de notificações, preferências (migration 0119), perfil com foto e troca de senha (porta Cognito), esqueci a senha.
- **D6** · Haiku — filtros, CSV e detalhe da auditoria; registrar login/logout (Sonnet se mexer em auth).
- **D1** · Sonnet — `GET /v1/gestao/cockpit` e `/itens`; tela com SSE.
- **D2** · Sonnet — `GET /v1/gestao/carteira` e `/indicador`; tela com lote.

### Onda 3 — campanhas, agente e relatórios

- **F2** · Sonnet — migration `preco_whatsapp`; mapeamento `{{n}}` nos templates; tela Consumo (view materializada diária).
- **F1** · Opus (API e despachante) + Sonnet (wizard) — template obrigatório no oficial, público composto com exclusões e prévia de custo, lote diário na janela, teste, iniciar digitando o nome, pausa automática, destinatários; revisão Opus.
- **F3** · Sonnet — formulário público (builder, `/f/:slug`, respostas, merge por telefone); revisão de segurança Opus (endpoint público, rate-limit, upload).
- **G2** · Opus — objeções no playbook + tool `registrar_objecao` + regra de qualidade.
- **G3** · Opus — gatilho `pedido_efetivado`, tools `registrar_nps`/`registrar_indicacoes`, prova social aprovada.
- **G4** · Opus — roteamento DDD/origem → filial e rodízio.
- **G5** · Sonnet — descarte após T4 e reativação 30/90.
- **H1** · Sonnet — importador com simulação, de-para e conferência.
- **H4** · Sonnet — compose de teste e fluxo e2e no `ci.yml`.
- **E2/E3** · Sonnet (views e telas) + Haiku (telas que repetem `relatorio-dimensao`).

### Onda 4

- **L1** · Haiku por tela (troca para os componentes de L0 seguindo o exemplar de Contatos), Sonnet nas telas densas (inbox, kanbans).

## 3. Integração

Branch de integração `feat/paridade-am` (a partir da `main`). Cada raia: worktree → commit → revisão
(Sonnet ou Opus) → merge em `feat/paridade-am` → `pnpm lint typecheck test` completo verde. A `main` só
recebe quando o dono pedir (CLAUDE.md: nada em `main` sem checks verdes).
