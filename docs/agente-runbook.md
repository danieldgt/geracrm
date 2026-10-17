# Agente vendedor — runbook de incidentes

> Um bloco por incidente: **sintoma → como confirmar → ação → volta**. Estrutura portada do runbook da AM
> (GO-LIVE §5 e MONITORAMENTO); conteúdo do GeraCRM. Fases e rollback: `agente-go-live.md`. Decisões:
> ADR-028…034. Cada rota, alerta, motivo e variável citado aqui existe no código (conferido por script na
> raia P20).

## 0. Sempre, antes de agir

1. **Isolar o alcance**: um tenant, um número ou todos? (skill `geracrm-observabilidade`)
2. `GET /saude/detalhada` — o veredito do processo (§0.1).
3. `GET /v1/alertas` com o token do tenant afetado — alertas abertos (um aberto por tipo).
4. Logs do serviço no Railway: logs estruturados em JSON. Os alertas de **processo** (sem tenant) saem
   no log com o campo `"alerta"`; os de **tenant** ficam na tabela `alerta` e aparecem no sino.
5. Registrar início, fim e efeito no cliente.

⚠️ O kill switch é **modo**, nunca parar o worker (ADR-028): `PUT /v1/agente/tenant`
`{"modoMaximo":"sombra"|"desligado","confirmacao":"<palavra>"}` (admin, auditado) cala o agente na conta
inteira, inclusive retornos e "digitando…"; a mensagem de ausência volta a responder no lugar dele, e o
registro das mensagens continua. Por número:
mudar o modo na tela do agente (`PUT /v1/canais/:id/agente`).

### 0.1 Saúde em três estados e monitor externo

`GET /saude/detalhada` é pública e não carrega dado de tenant: `{status, motivos[], componentes{processo,
banco, workerAgente, filaAgente, llm, transcricao, embeddings, retornos}}`.

| `status` | HTTP | Significa |
|---|---|---|
| `ok` | 200 | tudo dentro dos limites |
| `degradado` | 200 | alguma dependência fora ou atrasada — os `motivos` dizem qual |
| `erro` | 503 | só quando o próprio processo está encerrando (`encerrando`) |

Dependência fora é `degradado` com 200 de propósito: 503 faria a plataforma derrubar o processo que
está segurando a operação. O healthcheck do Railway continua em `/saude` (`railway.json`), e `/pronto`
testa o banco.

**Monitor externo (UptimeRobot ou equivalente):** monitor de **palavra-chave** em
`https://<api>/saude/detalhada`, alertando quando a palavra `"status":"ok"` **não** aparece. Intervalo de 5 min,
alerta depois de 2 falhas seguidas. Os componentes usam `estado`, não `status`, justamente para um
componente `ok` dentro de uma resposta degradada não enganar o monitor.

Motivos possíveis (`MOTIVOS_SAUDE`, shared `agente-saude.ts`): `encerrando`, `banco_indisponivel`,
`banco_lento`, `filas_sem_leitura`, `worker_agente_desligado`, `worker_agente_parado`,
`fila_agente_acumulada`, `fila_agente_atrasada`, `fila_agente_travada`, `llm_reserva_ativo`,
`modelo_bloqueado`, `transcricao_parada`, `transcricao_atrasada`, `transcricao_sem_leitura`,
`embeddings_parado`, `embeddings_acumulados`, `embeddings_sem_leitura`, `retornos_desligado`,
`retornos_parado`, `retornos_atrasados`.

⚠️ **Limiares provisórios** (`LIMITES_SAUDE_PROVISORIOS`): banco lento 1 s; worker do agente sem
passada há 120 s; fila do agente com 50 vencidas ou a mais antiga esperando 60 s; travada há 240 s;
transcrição 300 s / 600 s; embeddings 900 s / 20.000 pendentes; retornos 300 s / 900 s. Escolhidos pela
cadência dos workers e pelos números da AM, **sem calibração com produção**. Antes de pôr o monitor
para acordar gente de madrugada, recalibrar com 2–4 semanas de histórico.

---

## 1. LLM fora

- **Sintoma:** em autônomo, clientes recebendo "tive uma instabilidade" e, na 2ª falha seguida, sendo
  transferidos; em sombra/assistido, decisões com desfecho `falha` e sem sugestão.
- **Confirmar:** alerta `agente_llm_indisponivel` aberto no tenant; decisões com `falha_tipo`
  (`fatal`, `transitoria`, `requisicao`, `formato`) em `GET /v1/agente/decisoes`; handoffs com motivo
  `modelo_indisponivel`; log `"alerta":"llm_reserva_falhou"` quando a reserva também caiu.
  `pnpm --filter @geracrm/api agente:smoke` diz provedor, autenticação e latência (nunca imprime chave).
- **Ação:** a política já age sozinha (ADR-030): fatal → handoff com aviso sem prazo; transitória → um
  aviso e novo turno em 30 s; 2ª seguida → handoff. Se nem a reserva responde por mais de 15 min,
  rebaixar para `sombra` (kill switch) e avisar a equipe para atender pela fila. Erro de modelo
  específico: trocar `IA_MODELO` ou o modelo do número no catálogo.
- **Volta:** o primeiro turno bem-sucedido do tenant fecha `agente_llm_indisponivel`. Subir o modo de
  volta só depois de `agente:smoke` ok.

## 2. Reserva ativa

- **Sintoma:** respostas normais, custo por turno maior; tela do agente mostra a reserva.
- **Confirmar:** `/saude/detalhada` `degradado` com `llm_reserva_ativo`; log
  `"alerta":"llm_reserva_ativo"` (contexto `agente.llm`).
- **Ação:** nenhuma imediata — 2 falhas de provedor seguidas ligaram `IA_RESERVA_PROVEDOR`/
  `IA_RESERVA_MODELO` por `IA_RESERVA_JANELA_MIN` (30). Conferir a página de status do provedor
  principal. Se o principal ficar fora além de várias janelas, tornar a reserva o principal
  (`IA_PROVEDOR`/`IA_MODELO`) e redeploy.
- **Volta:** sozinha ao vencer a janela (log `"alerta":"llm_reserva_encerrado"`); restart também volta ao
  principal (estado em memória). ⚠️ Pré-requisito: a chave da reserva cadastrada em produção mesmo sem
  uso; provar uma vez por mês com `agente:smoke -- --reserva`.

## 3. Modelo bloqueado

- **Sintoma:** um modelo específico responde 403/404; os outros funcionam.
- **Confirmar:** `/saude/detalhada` `degradado` com `modelo_bloqueado`; log `"alerta":"modelo_bloqueado"`.
- **Ação:** o modelo fica bloqueado 1 h e as chamadas vão para `IA_MODELO`. Conferir acesso ao modelo
  no fornecedor (plano, região, permissão). Se persistir, trocar o modelo do número.
- **Volta:** sozinha em 1 h ou no restart.

## 4. Fila do agente travada

- **Sintoma:** clientes sem resposta em autônomo; nenhuma decisão nova.
- **Confirmar:** `/saude/detalhada` com `worker_agente_parado`, `worker_agente_desligado`,
  `fila_agente_acumulada`, `fila_agente_atrasada` ou `fila_agente_travada`. Somente leitura:
  `SELECT estado, count(*), min(executar_em), min(iniciada_em) FROM agente_tarefa WHERE estado IN
  ('pendente','executando') GROUP BY 1;`
- **Ação:** `worker_agente_desligado` = instância sem `DATABASE_ADMIN_URL` (o worker não agenda);
  corrigir a variável. Travada: a recuperação devolve tarefas em `executando` há mais de 120 s
  (`PRAZO_EXECUCAO_MS`); se não devolver, redeploy. Acumulada com worker vivo: turnos lentos (LLM ou
  ERP) — ver §1 e §8.
- **Volta:** saúde `ok`; a fila drena sozinha (debounce e serialização por conversa preservados).

## 5. Outbox parada (tela sem atualizar)

- **Sintoma:** mensagens chegam no banco mas o inbox não atualiza sem recarregar; sugestão do assistido
  não aparece.
- **Confirmar:** o evento nasce no mesmo commit do dado (trigger da `outbox` → `pg_notify('geracrm_evento')`)
  e cada instância mantém **um** `LISTEN`. Se `SELECT max(id), max(criado_em) FROM outbox` cresce e a
  aba não recebe nada em `GET /v1/eventos`, o `LISTEN` da instância caiu.
- **Ação:** redeploy/restart da API (o `LISTEN` é aberto no boot).
- **Volta:** o console reconecta com `Last-Event-ID` e recebe o delta da `outbox` — nada se perde.

## 6. Canal desconectado

- **Sintoma:** envios não saem por um número; clientes não recebem.
- **Confirmar:** alerta `canal_desconectado`; `GET /v1/canais` e `GET /v1/frota/saude`;
  `POST /v1/canais/:id/testar`.
- **Ação:** não-oficial: reparear pelo QR (`GET /v1/canais/:id/qrcode`, só admin). Oficial: conferir
  token e número no Gerenciador do WhatsApp. Enquanto isso, rebaixar o número para `sombra` se ele
  estiver autônomo.
- **Volta:** o vigia do canal fecha o alerta quando a conexão volta; subir o modo de volta.

## 7. Número RED / suspensão de ativas e campanhas

- **Sintoma:** retornos do agente e campanhas daquele número param; respostas a quem escreve continuam.
- **Confirmar:** alerta `qualidade_numero`; `GET /v1/canais/:id/agente/ativas` mostra a suspensão e o
  motivo (`qualidade:…` ou `conta:…`); tela da campanha diz "pausada por qualidade do número".
- **Ação:** é a proteção funcionando (webhook `phone_number_quality_update`/`account_update`).
  Investigar a causa (template ruim, volume, denúncias) no Gerenciador do WhatsApp. Não liberar antes
  da Meta normalizar.
- **Volta:** GREEN/UNFLAGGED da Meta libera sozinho; restrição de **conta** só libera manualmente:
  `POST /v1/canais/:id/agente/ativas/liberar` (admin, auditado).

## 8. ERP degradado

- **Sintoma:** propostas e efetivações lentas ou falhando; agente transferindo com
  `ferramenta_indisponivel`.
- **Confirmar:** `GET /v1/integracao/latencia`, `GET /v1/integracao/operacoes`,
  `GET /v1/integracao/conexoes`; handoffs por motivo em `GET /v1/agente/metricas`.
- **Ação:** o produto degrada em vez de quebrar (ADR-008): o rascunho do pedido **nunca se perde**;
  resposta perdida vai para `aguardando_conferencia` e não é reenviada às cegas; conector sem escrita
  fica `degradado` com exportação manual. Avisar o cliente; se o agente estiver autônomo e
  transferindo demais, rebaixar para `assistido` até o ERP voltar.
- **Volta:** reprocessar os pedidos em falha pela tela do pedido; subir o modo.

## 9. Teto de custo

- **Sintoma:** agente transferindo com `limite_de_custo` (teto do **dia do número**) ou
  `limite_de_custo_conversa` (teto da **sessão**); sino com orçamento mensal.
- **Confirmar:** `GET /v1/canais/:id/agente/custo` (dia e sessão do número); `GET /v1/agente/orcamento`
  (mês da conta); alertas `agente_orcamento_80`, `agente_orcamento_100` (só avisam, não cortam) e
  `preco_desconhecido` (modelo fora do catálogo cobrado pelo maior preço). Juiz: `agente_qualidade_teto`.
- **Ação:** sessão no teto = loop ou conversa patológica — ler a conversa antes de subir o teto
  (`IA_TETO_SESSAO_CENTAVOS`, padrão R$ 3,00, ou o do número). Dia no teto: conferir se é volume real
  antes de subir `PUT /v1/canais/:id/agente/custo`. `preco_desconhecido`: cadastrar o preço no catálogo
  `modelo_ia` (migration).
- **Volta:** o teto do dia vira à meia-noite no fuso do tenant; os alertas mensais rearmam no mês
  seguinte.

## 10. Violação CRÍTICA / pausa

- **Sintoma:** em autônomo, a mensagem não saiu e a conversa foi para a fila; em assistido, a sugestão
  chega "Não envie assim".
- **Confirmar:** alerta `agente_violacao_critica`; log com `"evento":"agente_violacao_critica"` (contexto
  `agente.qualidade`, sem conteúdo); handoff `qualidade_violacao_critica`; regra em
  `GET /v1/agente/qualidade?gravidade=CRITICA`.
- **Ação:** a pausa é **por conversa** (ADR-031) — ninguém precisa agir para proteger o cliente. Ler a
  decisão: falso positivo vira ajuste de regra; verdadeiro vira ajuste de playbook/conhecimento e caso
  de regressão. **Duas CRÍTICA no mesmo número na semana** → rebaixar o modo (`agente-go-live.md` §3).
- **Volta:** registrar a decisão na revisão semanal (`agente-revisao-semanal.md`).
- **Juiz parado** (sem avaliações novas na aba Qualidade): o worker de qualidade escolhe o lote numa
  transação curta e reserva cada sessão em `qualidade_juiz_concessao` com TTL; instância que morreu no
  meio deixa a linha expirar e a sessão volta a ser escolhida sozinha. Sessão com erro do juiz conta como
  falha e o lote segue. Se nada anda: conferir `agente_qualidade_teto` (teto mensal do juiz no número) e
  o provedor (§1).

## 11. Webhook parado

- **Sintoma:** nenhuma mensagem de cliente entra.
- **Confirmar:** somente leitura, `SELECT max(criado_em) FROM mensagem WHERE direcao = 'entrante';` sem
  entrada há mais de 15 min em horário comercial. Oficial: `GET /webhooks/meta?hub.mode=subscribe&
  hub.verify_token=<META_VERIFY_TOKEN>&hub.challenge=123` responde `123`; log
  "META_APP_SECRET ausente — webhook Meta recusado" indica segredo faltando. Não-oficial:
  `POST /webhooks/plugzapi/:canalId` configurado no painel do PlugZapi.
- **Ação:** corrigir `META_APP_SECRET`/`META_VERIFY_TOKEN` e reassinar o webhook no app da Meta. O
  webhook só grava, agenda e responde 200 (ausência e mídia saem pelo worker de pós-ingestão).
- **Volta:** a Meta reenvia o que não foi confirmado por um tempo; conferir que o intervalo entrou.

## 12. Embeddings fora

- **Sintoma:** busca no catálogo/conhecimento pior (só lexical); nada para o cliente.
- **Confirmar:** `/saude/detalhada` com `embeddings_parado`, `embeddings_acumulados` ou
  `embeddings_sem_leitura`; `GET /v1/agente/conhecimento/capacidades`; log "busca semântica desligada —
  falta variável de embedding".
- **Ação:** conferir `EMBEDDING_PROVEDOR`, `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_AI_TOKEN` ou
  `VOYAGE_API_KEY`, e pgvector no Postgres. A semântica é capacidade opcional (ADR-026): degradar é
  correto.
- **Volta:** `POST /v1/agente/conhecimento/embutir` para adiantar os pendentes.

## 13. Transcrição fora

- **Sintoma:** áudio de cliente sem transcrição; o agente pede texto e, no 2º áudio perdido, transfere.
- **Confirmar:** `/saude/detalhada` com `transcricao_parada`, `transcricao_atrasada` ou
  `transcricao_sem_leitura`; handoffs `audio_sem_transcricao`; log "transcrição de áudio desligada (sem
  GROQ_API_KEY)" no boot.
- **Ação:** impacto baixo, o fallback já existe. Conferir `GROQ_API_KEY`, `TRANSCRICAO_MODELO`,
  `TRANSCRICAO_URL`.
- **Volta:** áudios pendentes são transcritos e o turno é reagendado.

## 14. SLA estourado em massa

- **Sintoma:** muitos cronômetros vermelhos no inbox e no kanban; gestores recebendo aviso de estouro.
- **Confirmar:** alerta `sla_handoff_estourado`; `GET /v1/performance` → `slaHandoff`
  (`estourados`, `pendentes`, `pctCumprido`); por conversa, `GET /v1/conversas/:id/sla`.
- **Antes, descartar falso estouro:** o SLA para quando uma **pessoa** responde — mensagem com autor
  (`enviada_por_id`). Se o time responde e o cronômetro não para, algum caminho de envio humano não está
  gravando o autor (bug; a régua também alimenta `primeira_resposta_humana_em` em `GET /v1/performance`).
- **Ação:** é falta de gente na fila, não falha do agente. Redistribuir: depois do 2º limiar a
  reatribuição fica liberada a todos do número; gestão (admin/gestor/supervisor) assume a qualquer
  momento. Se o volume de handoff subiu de repente, ver o motivo dominante em
  `GET /v1/agente/metricas` (`handoffPorMotivo`) — pode ser §1, §8 ou §10. Ajustar minutos em
  `PUT /v1/canais/:id/sla` só se o prazo estiver irreal para a operação.
- **Volta:** o cliente recebe **uma** mensagem de espera por handoff (padrão ligado; resultado em
  `aviso_espera_resultado`); nada a desfazer.

## 15. Copiloto ocupado

- **Sintoma:** "Sugerir resposta" responde "O assistente está atendendo outros pedidos agora".
- **Confirmar:** `POST /v1/conversas/:id/sugestao/gerar` devolvendo 503 `copiloto.ocupado` (com
  `retry-after: 5`); 502 `copiloto.indisponivel` é outro caso (modelo não respondeu em 20 s, ver §1).
- **Ação:** é o teto de copilotos simultâneos por processo (`COPILOTO_MAX_SIMULTANEOS`, padrão 3, abaixo
  de `DB_POOL_MAX`, padrão 10) protegendo o pool do inbox. Subir com cuidado e sempre abaixo do pool;
  com muitos vendedores, escalar instâncias.
- **Volta:** passa sozinho quando as gerações em curso terminam.
