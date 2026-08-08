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
