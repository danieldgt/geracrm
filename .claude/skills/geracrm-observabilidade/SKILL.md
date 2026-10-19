---
name: geracrm-observabilidade
description: >
  Observabilidade do GeraCRM: o que vira issue no Sentry e o que não vira, logs estruturados com
  contexto de tenant, métricas que importam (entrega de mensagem, latência do ERP, fila de disparo,
  custo), alertas acionáveis e dados que nunca podem aparecer em log. Usar ao instrumentar código,
  criar alerta, investigar incidente, ou quando o Sentry estiver ruidoso demais.
---

# Observabilidade

Sentry para erro, logs estruturados para investigação, métricas para tendência.

O objetivo não é registrar tudo — é **conseguir responder "o que aconteceu com este cliente às
14h?" em minutos**, e ser avisado antes do cliente ligar.

## ⚠️ O que NÃO vira issue

Este é o item mais importante da skill. Sentry ruidoso é Sentry ignorado, e aí o erro real passa
despercebido.

**Não são erros de aplicação:**

- Validação de entrada recusada (Zod) — é o sistema funcionando
- Falha de negócio esperada — estoque insuficiente, crédito bloqueado, fora da janela de 24h
- `401`/`403` de usuário sem permissão
- Recusa esperada de terceiro — template rejeitado pela Meta, ERP dizendo que o item está inativo
- Webhook com falha permanente que respondemos `200` deliberadamente

Todos vão para **log com nível apropriado**, não para o rastreador de exceções.

**São erros:** exceção não tratada · falha de infraestrutura · integração devolvendo o inesperado ·
invariante violada · timeout acima do previsto.

## Log estruturado

Todo log carrega, sem exceção:

```
tenantId · requestId · usuarioId · contexto · (numeroId, conversaId, pedidoId quando aplicável)
```

⚠️ **Log sem `tenantId` é inútil em produção multi-tenant** — você não consegue isolar o cliente
que reclamou.

⚠️ **`requestId` atravessa tudo**: HTTP → caso de uso → worker → chamada externa. Sem ele, um
problema que passa por três processos vira três investigações separadas.

## ⚠️ O que nunca aparece em log

- Conteúdo de mensagem de cliente
- Credencial, token, chave — de qualquer tipo
- CPF/CNPJ completo (mascare)
- Payload cru de webhook com dado pessoal

Log é lido por mais gente do que o banco, fica em ferramenta de terceiro e é retido por tempo que
ninguém controla.

## Métricas que importam

| Métrica | Por que |
|---|---|
| **Taxa de entrega por número** | Queda súbita = número em risco antes da Meta avisar |
| **Qualidade e tier do número** | Ativo mais frágil do cliente |
| **Latência do ERP (p95)** | Passou de 2s, o pedido assistido degrada (`geracrm-conectores-erp`) |
| **Tamanho da fila de disparo** | Acúmulo em pico = worker insuficiente |
| **Conexões SSE ativas** | Gatilho de escala (§12 da stack) |
| **Eventos no outbox não processados** | Fan-out parou; a tela dos usuários está desatualizada |
| **Custo de IA por tenant** | Precificação e detecção de abuso |
| **Custo de mensagem por tenant** | Alimenta o ROI que o produto promete |
| **Latência de consulta analítica** | Réplica começando a sofrer |

## Alertas — só o acionável

Alerta que não tem ação associada treina o time a ignorar.

| Alerta | Ação |
|---|---|
| Qualidade de número caindo | Pausar disparo naquele número |
| Outbox parado > N minutos | Investigar worker — usuários sem atualização |
| ERP com p95 > 2s | Avisar o cliente; validação de pedido migra para a efetivação |
| Fila de disparo crescendo em pico | Escalar workers |
| Taxa de erro do webhook subindo | Verificar assinatura e idempotência |
| Migration falhou no pre-deploy | Deploy não subiu — versão anterior servindo (comportamento correto) |

⚠️ **Sem alerta de "CPU alta" sem consequência.** Se ninguém sabe o que fazer ao receber, não é
alerta — é ruído.

## Saúde em três estados (`GET /saude/detalhada`)

`avaliarSaude` (shared `agente-saude.ts`, pura) + medição em `plataforma/saude-detalhada.ts`:

- `ok` / `degradado` (HTTP **200**) / `erro` (HTTP **503**, só `encerrando`). Dependência fora — banco,
  worker parado, fila atrasada, LLM na reserva — é `degradado`: 503 faria a plataforma derrubar o
  processo que segura a operação. O healthcheck do Railway segue em `/saude`; `/pronto` testa o banco.
- Rota **pública**: só contagens, idades em segundos e códigos (`MOTIVOS_SAUDE`). Nada de tenant, modelo,
  URL ou mensagem de erro.
- Componentes usam `estado`, nunca `status`: o monitor externo procura a palavra-chave `"status":"ok"`.
- Batimento: todo worker de intervalo chama `batimento(nome)` (`plataforma/batimento.ts`) no `finally`;
  worker novo que deve contar na saúde precisa disso e de entrar em `EntradaSaude`.
- Leitura crítica (fila do agente, retornos) separada das opcionais (transcrição, embeddings), cada uma
  com teto e cache próprios — uma lenta não apaga a outra.
- ⚠️ Limiares provisórios (`LIMITES_SAUDE_PROVISORIOS`): calibrar com histórico antes de acordar gente.

## Alertas do produto (tabela `alerta`)

Um aberto por `(tenant, tipo)` (`alerta_aberto_unico`); escreva com `ON CONFLICT … DO NOTHING` e feche
ao normalizar. Tipos ligados ao agente e à operação, com ação no `docs/agente-runbook.md`:

| Tipo | Origem |
|---|---|
| `agente_llm_indisponivel` | política de falha do LLM; fecha no turno bem-sucedido |
| `agente_violacao_critica` | regras de qualidade pausaram uma conversa |
| `agente_qualidade_teto` | teto mensal do juiz no número |
| `preco_desconhecido` | modelo fora do catálogo `modelo_ia` |
| `agente_orcamento_80` / `agente_orcamento_100` | orçamento mensal do tenant (só avisa) |
| `opt_out_confirmar` / `opt_out_cliente` | pedido de opt-out a confirmar (assistido) / opt-out registrado |
| `qualidade_numero` | Meta baixou a qualidade ou restringiu a conta; ativas e campanhas suspensas |
| `canal_desconectado` | vigia do canal |
| `sla_handoff_estourado` | SLA do handoff vencido sem resposta humana |
| `entrega_baixa` | taxa de entrega por número |

Alertas **de processo** (sem tenant) não vão para a tabela: saem no log com o campo `"alerta"`
(`llm_reserva_ativo`, `llm_reserva_encerrado`, `llm_reserva_falhou`, `modelo_bloqueado`, contexto
`agente.llm`) e aparecem como motivo em `/saude/detalhada`.
`particoes_horizonte_curto` (contexto `plataforma.particoes`, worker diário de partições) segue o
mesmo molde: log `error` com `"alerta"` + motivo `particoes_curtas` na saúde (runbook §16).

## Workers: trava sem vazar

- Worker que trabalha entre instâncias usa **concessão com TTL numa tabela** (linha por item, token,
  `expira_em`), nunca `pg_advisory_lock` de sessão pelo pool: com pool > 1 o unlock cai noutra conexão e a
  trava vaza presa, parando o worker em todas as instâncias. Padrões: `copiloto_geracao` (0103) e
  `qualidade_juiz_concessao` (0108, juiz por sessão). A escolha do lote fica sob
  `pg_try_advisory_xact_lock` numa transação curta; a chamada externa roda fora de transação.
- As conexões dono dos workers do `server.ts` usam `application_name=geracrm-workers`: em
  `pg_stat_activity` dá para ver quem está consumindo fila.

## Resposta humana: `enviada_por_id`

"Alguém respondeu" é `mensagem.enviada_por_id IS NOT NULL` (régua única): o envio humano grava o autor
na rota de envio, no resumo da proposta e no template; agente, aviso de espera e campanha não têm autor.
Alimenta o SLA do handoff (`sla_respondido_em`), a coorte humana da conversão e
`atendimento.primeira_resposta_humana_em` (tempo de 1ª resposta em `GET /v1/performance`). Envio humano
novo que não grave o autor some dessas métricas.

## Logs estruturados do agente

- Uma linha JSON por evento, com `contexto` (`agente.llm`, `agente.qualidade`…), ids (`tenantId`,
  `conversaId`, `canalId`), o código (`alerta` ou `evento`) e nada de conteúdo: nem texto do cliente, nem
  chave, nem mensagem do fornecedor. Ex.: `{"contexto":"agente.qualidade","evento":"agente_violacao_critica",
  "regras":[…],"pausou":true}`.
- A auditoria de "por que o robô disse isso" é `agente_decisao` (marcas de guardrail, ferramentas, custo,
  modo efetivo), não log.
- Scripts que tocam provedor passam a saída por `semSegredos` (`evals/segredos.ts`).

## Investigar um incidente

1. **Isole o tenant** — o problema é de um cliente ou de todos? Muda tudo
2. **Siga o `requestId`** através dos processos
3. **Linha do tempo**: houve deploy, migration ou mudança de prompt perto do horário?
4. **Terceiro ou nós?** Verifique a página de status da Meta e a latência do ERP antes de suspeitar
   do código
5. **Reproduza com o dado real** do cliente, em homologação

Ao terminar: **bug corrigido = teste que o reproduz, escrito antes do fix** (`geracrm-testes`).

## Auditoria ≠ log

São coisas diferentes e não se substituem:

| | Log | Auditoria |
|---|---|---|
| Para quê | Investigar problema | Responder "quem fez isso?" |
| Onde | Ferramenta externa, retenção curta | **Banco, com retenção definida** |
| O quê | Técnico | Ação de negócio: envio, exclusão, transferência, mudança de carteira, acesso de staff |

⚠️ Auditoria é requisito de produto (PLT-05), não de infraestrutura. Não a implemente como log.
