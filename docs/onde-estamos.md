# Onde estamos vs. o plano de ondas

## ✅ Histórico — concluído (não revisitar)

- **Infra Railway**: API, console, Postgres, worker integrador. Deploy por serviço.
- **Auth Cognito** (login server-side, client confidencial) + RLS + papel `geracrm_api`.
- **Integrador GeraCloud** agendado (clientes/produtos/vendas + preços, reconciliação).
- **Tempo real (ADR-007)**: outbox → trigger → NOTIFY → SSE (payload só ids, cursor, filtro por tenant). Consolidado num único trigger (0026).
- **Inbox estilo WhatsApp**: lista + thread + composer.
- **Mensagens**: enviar/receber **texto, imagem, áudio** (gravação + player), **apagar/editar**, **tiques** (entregue/lida), **emoji**.
- **Contatos**: cadastro + busca (nome/telefone) + "iniciar conversa".
- **Ação no chat**: card genérico (`tipo:'acao'`) + **pedido** (Confirmar/Recusar) + resolver (0028).
- **Janela 24h/template**: só no canal oficial (não-oficial = texto livre).
- **#1 Fundação — CI como gate (R-08)**: 8 varredores de schema + `.github/workflows/ci.yml` + isolamento SSE no `test`.
- **#2 Fundação — Biblioteca (R-12)**: bloco 1 de componentes (`compartilhado/ui`) + `tokens.d.ts` + lint anti-cor-literal.
- **Provisionamento de `usuario`** (por `cognito_sub`) + `req.usuarioEmail`.
- **EP-06 — Fila e assunção**: "Assumir atendimento" com vencedor atômico (INV-51, índice único parcial) + protocolo (contador por tenant) + estado na thread + evento de tempo real. Teste de concorrência preciso.
- **EP-04 — Ficha do contato (360°)**: tela `contato/:id` com telefones, RFV, métricas e os 5 estados (já construída em etapa anterior).
- **E5-12 — Não-lido por usuário**: `naoLida` derivado (`versao − lida_ate_versao`) por usuário na lista + marcar-lida ao abrir + badge. Teste de per-usuário.
- **E5-10 — Protocolo numerado**: `formatarProtocolo`/`parsearProtocolo` (shared, com teste — busca aceita `#`/zeros) + protocolo exposto na thread.
- **E6-02 — Abas Fila / Meus / Todas**: filtro server-side (`?filtro=`) + `GET /v1/fila/contadores` + abas com contador no Inbox. `@geracrm/shared` virou dep do console (watch path).
- **E5-09 — Recorte temporal**: thread carrega as mais recentes (DESC+LIMIT, poda partição) + `GET /v1/conversas/:id/mensagens` (cursor `(criado_em,id)` para trás) + botão "Ver anteriores". Teste de cursor sem overlap.
- **EP-07 — Governança/auditoria**: helper `auditar()` + tabela `auditoria` + registro em assumir/apagar/editar (ator, ação, entidade, dados). Endpoint `GET /v1/auditoria` **paginado por cursor** `(criado_em,id)` (era top-N cru — corrigido para honrar o invariante) + **tela "Auditoria"** (Gestão) com 5 estados, rótulos no vocabulário da operação e "carregar mais". Teste de registro+leitura com ator + teste de cursor (120 linhas em 3 páginas, sem perder/duplicar, cursor inválido → 422, isolamento por tenant).
- **INT-08 — Painel de sincronização**: helper `registrarOperacao()` grava em `operacao_ingestao` a cada fluxo (clientes/produtos/vendas: lidos/aceitos/rejeitados + amostra de rejeições truncada em 100), `GET /v1/integracao/operacoes` (sob RLS) e painel "Últimas sincronizações" na tela de Conexões (estado parcial — não derruba a lista). Teste de gravação + truncamento + isolamento por tenant.
- **INT-07 — Webhooks de saída**: tabela `webhook_saida` (migration 0033, RLS, cursor+retry por webhook) + despachante `webhook-saida.ts` (entrega por **cursor no outbox**, ordenada/at-least-once, **HMAC-SHA256** + headers `X-GeraCRM-Signature/Event/Delivery`, **retry com backoff** e **dead-letter** após 8 tentativas, **advisory lock** multi-instância) rodando por intervalo no `server.ts` (como dono). CRUD `GET/POST/DELETE /v1/webhooks` (só https, segredo mostrado 1x, cursor nasce no topo do outbox) + **tela "Webhooks de saída"** (Integrações). Testes: 8 do despachante (assinatura, cursor, filtro, retry, dead-letter, despacharTodos) + 4 do CRUD.
- **EP-02 — Importação CSV de contatos**: parser puro `parseCsvContatos` (auto-detecta `,`/`;`, mapeia colunas com acento/caixa, respeita aspas, valida nome/telefone/CNPJ-CPF) + `POST /v1/contatos/importar` (dedup por telefone, grava documento, rejeição tipificada por linha, teto 5000) + painel "Importar CSV" na tela de Contatos (colar ou enviar arquivo, resumo criados/atualizados/rejeitados). Testes: 8 do parser + 4 do endpoint.
- **EP-03 — Saúde da frota**: `/v1/canais` marca `riscoBanimento` (ADR-021, não-oficial) e `GET /v1/frota/saude` (entrega 24h + alertas abertos), com painel de saúde na tela "Meus Números". 🐛 **Corrigido bug pré-existente**: `canal_conectado` não tinha `ultimo_erro` (migration 0032) — o `/v1/canais` respondia 500 e a tela estava quebrada. Testes: riscoBanimento, soma de entrega, alertas, sem-envios.
- **EP-04 — Opt-out / bloqueios (tela)**: `GET/POST/DELETE /v1/bloqueios` (bloquear por telefone → deriva chave INV-50; lista por cursor; idempotente) + tela "Opt-out / Bloqueios" (menu Vendas) com 5 estados, adicionar por telefone e desbloquear. O gateway de envio (E5-13) já respeitava a lista no servidor — agora dá para gerir. Testes: bloquear/listar/remover, telefone inválido→422, idempotência, isolamento por tenant.
- **I-11/I-10 — Série temporal + alertas (Postgres)**: tabelas `metrica_janela` (agregação por hora) e `alerta` (migration 0031, RLS, dedup por índice parcial `alerta_aberto_unico`). O envio grava `envio_ok`/`envio_falha` (só transporte, não recusa de política) e avalia a regra pura `avaliarEntrega` (massa mínima 20, limiar 70%): sobe alerta `entrega_baixa` deduplicado, **resolve** quando volta ao normal, e emite `alerta.novo` no SSE só no alerta novo. `GET /v1/metricas/:metrica` + `GET /v1/alertas` + **barra de alerta no shell**. Testes: regra pura (limiares), agregação por balde, dedup, resolução, isolamento.
- **E5-14 — Mídia em storage (fora do banco)**: bucket S3-compatível do Railway (`geracrm-midia`, iad). `midia/dataurl.ts` (valida tipo/tamanho ≤16MB, puro) + `midia/armazenamento.ts` (SDK S3, chave namespaced `tenant/{T}/uuid`, URL assinada curta). O `POST .../mensagens` intercepta o base64 ANTES da transação, sobe ao bucket e persiste **só a chave**; o provedor recebe URL assinada de 10min; a leitura da thread devolve URL assinada de 1h (console não muda). Entrada (URL do provedor) passa direto. Degrada para base64 se o bucket não estiver configurado. Testes: 9 de validação/detecção de chave + smoke real (upload→assinada→GET 200).
- **PLT-07 — Notificações (sino)**: tabela `notificacao` (migration 0030, RLS, índice único parcial de dedup por conversa não-lida) + gatilho real na ingestão de entrante (`notificarMensagemEntrante`: só notifica o atendente que assumiu, no mesmo commit, com evento no canal `usuario`) + `GET /v1/notificacoes` (cursor) + `/contador` + `POST /lidas` + **sino no shell** (contador, dropdown, abre a conversa e marca lida) reagindo a `notificacao.nova` do SSE. A casca virou dona da conexão SSE global (o inbox não a derruba mais). Testes: fila não notifica, assumida notifica, dedup (3 entrantes = 1 pendência), marcar lida + nova, evento no outbox.
- **INB-18 — Presença na conversa**: tabela `presenca_conversa` (migration 0029, RLS, TTL lógico) + `POST/DELETE /v1/conversas/:id/presenca` (heartbeat que já devolve quem mais está ali — sem polling de fundo, sem conexão viva) + faixa "Fulano está nesta conversa" no Inbox (heartbeat 15s enquanto a conversa está aberta, some ao trocar/fechar). Testes: dois atendentes se enxergam, ninguém se vê, expira pelo TTL, isolamento por tenant.
- **E5-13 — Gateway único de envio**: `canais/gateway.ts` (`avaliarEnvio` puro + `enviarPeloGateway`) revalida no servidor, nesta ordem: opt-out (`lista_bloqueio` por `chave_bloqueio`/INV-50) → estado do canal (suspenso/desconectado barram; degradado envia) → credencial → **janela 24h só no oficial** (não-oficial = texto livre, ADR-021). A rota de envio despacha **só** via gateway; recusa nossa → 409 com motivo nomeado, transporte → 502. Testes: 13 unitários (ordem/política) + 1 de endpoint (opt-out barra com 409, sem despacho, mensagem marcada `falhou`).

---


> Reconciliação após o **sprint de dogfooding** (2026-08-09). O CLAUDE.md dizia
> "fase de planejamento, sem código de produção" — isso ficou desatualizado: há
> um stack rodando no Railway com chat bidirecional real. Este doc mapeia o que
> o sprint entregou contra as ondas planejadas e lista o que falta, **na ordem
> das ondas**.

## 1. O que o sprint entregou (uma fatia vertical do EP-05, no canal NÃO-OFICIAL)

O sprint construiu um **protótipo funcional de atendimento** ponta a ponta, mas
sobre o **PlugZapi (não-oficial)** — não sobre a Meta oficial (ADR-015/021). É um
adianto do EP-05 da Onda 1, valioso para dogfooding, **não** o produto final.

- **Infra Railway**: API (Fastify), console (Angular/nginx), Postgres, worker integrador. Deploy por serviço.
- **Auth**: Cognito (login server-side por client confidencial), RLS, papel `geracrm_api`.
- **Integrador GeraCloud**: clientes/produtos/vendas + preços/estoque, reconciliação, agendado (amostra `MAX_PAGINAS=5`).
- **Tempo real (ADR-007)**: outbox no mesmo commit → trigger → `NOTIFY` → SSE, payload só ids, filtro por tenant, cursor de reconexão. → cobre **E5-02**.
- **Inbox estilo WhatsApp**: lista + thread, avatares, bolhas, tiques, separadores. → **E5-01/03**.
- **Mensagens**: enviar/receber **texto, imagem, áudio** (gravação no navegador + player). → **E5-04/05** (parcial).
- **Apagar/editar** mensagem (recall/edit via Z-API). *(além do plano)*
- **Status** (entregue/lida) via webhook de status. → parte de **E3-14**.
- **Contatos**: cadastro + busca (nome/telefone) + "iniciar conversa". → **E5-08** (parcial).
- **Janela 24h/template** só no canal oficial (no não-oficial, texto livre). → lógica de **E5-06/07** (parcial).
- **Pedido assistido** (base), tabelas de preço/saldo. → adianto da Onda 2.

## 2. ⚠️ O que o sprint PULOU — dívida da Onda 0 (fundação)

Estes são pré-requisitos que o dogfooding contornou e precisam ser feitos para
virar produto:

| Item | Onda 0 | Estado |
|---|---|---|
| **CI completo (R-08)**: lint · typecheck · test · build de todos os apps · runner de migration em 2 cenários · **8 varredores de schema** · teste de isolamento SSE como **gate** · conformidade de conectores como **gate** · verificador de watch path | S0 | ❌ (só `test`/`build` manuais) |
| **Biblioteca de componentes + tokens + lint anti-cor-literal (R-12)** | S0 | ❌ (usamos CSS ad-hoc / cores WhatsApp) |
| ~~**Script de anonimização determinístico (R-11)**~~ | — | 🚫 **descartado (2026-08-09)** — só servia para copiar base real para ambiente de teste da Gera3; no modelo real o sincronismo vive no tenant do cliente sob RLS, dado comercial dele, sem cópia para fora. Se um dia a Gera3 baixar base real para dev, é decisão de processo/LGPD, não código |
| **Alertas (I-10) + série temporal (I-11)** | infra | 🔨 **decidido (2026-08-09): Postgres** (tabelas de agregação) + **alertas junto**. Em implementação |
| **Migration em preDeploy (ADR-006)** | infra | 🟡 **configurado (2026-08-09)**: `apps/api/pre-deploy.sh` + `railway.json` na raiz com `preDeployCommand` **guardado** (roda onde o script existe; no-op no console — deploy do console segue SUCCESS, risco descartado). ⚠️ **Fallback mantido** no `docker-start.sh` (migrate idempotente no start) até confirmar nos **deploy logs do painel** que o `[pre-deploy]` executa — o CLI não expõe a fase de preDeploy. Só depois de confirmado, remover o migrate do start |
| **Mídia por URL assinada de expiração curta (I-05)** | — | ⚠️ hoje base64 no banco / URL direta |
| **Registro na Meta (M-01…07)** | crítico externo | ⏸️ **decidido (2026-08-09): ainda não** — seguimos no canal não-oficial; o oficial fica para quando o produto amadurecer |

## 3. As ondas, na ordem — o que falta implementar

### Onda 0 — Fundação (fechar a dívida acima)
Objetivo: transformar o protótipo em base sustentável.
1. **CI como gate** (R-08) — sem merge sem checks; os 8 varredores de schema.
2. **Biblioteca de componentes + tokens** (R-12) — botão/campo/badge/esqueleto/vazio/erro/toast/painel/cabeçalho, lint anti-`#hex`. Refazer o inbox sobre ela.
3. **Alertas + série temporal (I-10/I-11)** — ⚠️ precisa de decisão: Postgres × serviço gerenciado. (Anonimização R-11 🚫 descartada — ver §2.)
4. **Migration em preDeploy** (Railway per-service preDeploy) — sair do start.
5. **Iniciar registro na Meta** (M-01…07) — semanas de espera, começar já.
6. **Carga histórica completa + reconciliação assinada** (critério de saída nº 1) — hoje é amostra.

### Onda 1 — Atender (o produto de verdade)
> **Estado (2026-08-09): praticamente fechada no canal NÃO-OFICIAL.** Só restam
> o canal Meta OFICIAL (deferido por decisão) e o marco de negócio (corte do 1º
> cliente). Todo o resto abaixo está ✅.
- **Canal WhatsApp Oficial (Meta)** — ⏸️ **deferido** (decisão 2026-08-09): adaptador atrás da mesma porta (ADR-021), janela 24h + template reais (**E5-06/07**). Fica para quando o produto amadurecer.
- **Gateway único de envio (E5-13)** ✅ feito: opt-out, estado do canal, credencial e janela (só oficial) revalidados no servidor; a rota de envio só despacha via gateway. Falta expandir para o allowlist de aquecimento e para os caminhos de template/campanha quando existirem.
- **Mídia por URL assinada (E5-14)** ✅ SAÍDA e ENTRADA. Entrada: a ingestão sinaliza `midiaExterna`; o webhook copia a mídia do provedor para o bucket **pós-commit e best-effort** (fetch com timeout, mantém a URL do provedor se falhar). Testes de sinalização (imagem sim, texto não, duplicada não).
- **EP-06 — Fila e assunção**: modo pull, "Assumir atendimento" com corrida resolvida por índice único (INV-51).
- **EP-07 — Governança**: auditoria (PLT-05) ✅ + notificações (PLT-07) ✅ — sino no shell, canal do usuário sobre o SSE. Falta push nativo (fora do navegador).
- **EP-03 — Saúde da frota** ✅: entrega 24h + alertas + risco de banimento na tela "Meus Números". Tier/pagamento/qualidade são do oficial (Meta), entram com ele. Pausa automática por queda: pendente (deriva do alerta de entrega).
- **EP-04 — Superfície do contato** ✅: ficha ✅, opt-out (tela) ✅. Campos customizados e "está no telefone": backlog.
- **EP-02 cont. — Integração** ✅: webhooks de saída (INT-07) ✅, CSV ✅, painel de sync (INT-08) ✅.
- **Protocolo numerado (E5-10)**, **não-lido por usuário (E5-12)**, **recorte temporal por partição (E5-09)**.
- 🔴 **Corte do primeiro cliente (ADR-015)** — o marco que abre a Onda 1 de fato.

### Onda 2 — Vender
- **Kanban do funil** ✅ (2026-08-10): eixo RELACIONAMENTO (migration 0034), endpoints por cursor (coluna paginada), mover com histórico + concorrência otimista (versao) + perda com motivo de catálogo; tela com drag-drop nativo do CDK, prompt de motivo, 5 estados. Fix: `garantirUsuarioId` com sub por-tenant no dev (RLS). Testes: 7 (criar/1-aberta-por-contato, mover+histórico, conflito 409, perda-exige-motivo, ordenação, isolamento).
- Falta: **pedido assistido** completo (leitura síncrona + escrita idempotente no ERP, rascunho nunca perdido), medição da **latência do conector**.

### Onda 3 — Reter / Competir
Funil de recompra com RFV, **campanhas com ROI** e atribuição de receita, aquecimento de frota (calendário, começa na Onda 2), governança de reputação, Instagram Direct.

### Onda 4 — Sem paralelo
IA no atendimento (transcrição de áudio, sugestão), analítico avançado, o que a operação real pedir.

## 4. Recomendação de próximo passo
Duas frentes paralelas, sem inverter dependência:
- **Trilho A (externo, começa já):** iniciar **registro na Meta** (M-01…07) — semanas paradas se não começar.
- **Trilho B (nós):** fechar a **fundação da Onda 0** — CI como gate + biblioteca de componentes — porque tudo daqui pra frente constrói sobre isso, e sem a biblioteca a Onda 2 refaz as telas da Onda 1.

O protótipo do sprint continua sendo o **ambiente de dogfooding** enquanto isso.
