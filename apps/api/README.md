# apps/api — Backend

Fastify 5 + Node 22 + TypeScript. **Monolito modular**: um código, três processos.

> Status: **não implementado**. Estrutura definida, aguardando Onda 0.

## Três entrypoints, um código

| Processo | Entrypoint | Perfil de carga | Por que é separado |
|---|---|---|---|
| **API** | `src/server.ts` | Requisições curtas, latência sentida pelo usuário | — |
| **Gateway de webhooks** | `src/gateway.ts` | Rajadas, resposta em **milissegundos** | ⚠️ A Meta reenvia o que demora. Não pode competir com consulta pesada |
| **Workers** | `src/worker.ts` | Roda por horas; processa milhões de linhas | Disparo com throttling, carga histórica, IA, mídia |

No Railway, são **três serviços apontando para o mesmo build**, com comando diferente. Não são
repositórios nem dependências separadas — compartilham domínio, banco e tipos.

## Estrutura

```
src/
  contexts/          ← domínio por capacidade de negócio
    atendimento/     conversa · fila · janela de 24h · protocolo
    contato/         cadastro unificado · opt-out · campos personalizados
    pedido/          rascunho · validação · efetivação
    crm/             funil · carteira · tarefa · fila do dia
    campanha/        template · disparo · throttling · atribuição
    catalogo/        produto · grade · link público
    integracao/      ⚠️ o ÚNICO que conhece formato de ERP
    identidade/      tenant · usuário · papel · permissão
    analitico/       RFV · atribuição · dashboards
  db/
    schema/          espelho TS do SQL (não é gerador)
    migrations.ts    runner próprio
  http/              rotas, plugins, tratamento de erro
  eventos/           outbox, publicação, LISTEN/NOTIFY
  seguranca/         JWT, tenant, autorização
  storage/           object storage
  observabilidade/   Sentry, logs estruturados
```

## Regras que valem aqui

- ⚠️ **Um contexto nunca importa código interno de outro.** Comunicação por **evento de domínio
  pós-commit** (outbox) ou por **id** — nunca por join de objeto.
- **Fronteira de transação = caso de uso.** Transações curtas; nunca aguardar rede externa (ERP,
  Meta, IA, S3) com transação aberta.
- **`tenant_id` vem do token**, nunca de parâmetro. RLS em toda tabela.
- **Falha de negócio é retorno tipificado**, não exceção.
- **Toda lista paginada por cursor.**
- ⚠️ Proibido I/O síncrono e trabalho CPU-bound no event loop.

Regras completas: [`geracrm-arquitetura`](../../.claude/skills/geracrm-arquitetura/SKILL.md) ·
[`geracrm-dados-postgres`](../../.claude/skills/geracrm-dados-postgres/SKILL.md) ·
[`fastify`](../../.claude/skills/fastify/SKILL.md)

## Integrações externas

| Integração | Skill |
|---|---|
| WhatsApp Cloud API, Instagram | [`geracrm-whatsapp-meta`](../../.claude/skills/geracrm-whatsapp-meta/SKILL.md) |
| Push server→client | [`geracrm-tempo-real`](../../.claude/skills/geracrm-tempo-real/SKILL.md) |
| ERPs | [`geracrm-conectores-erp`](../../.claude/skills/geracrm-conectores-erp/SKILL.md) |
| Cognito | [`geracrm-identidade-acesso`](../../.claude/skills/geracrm-identidade-acesso/SKILL.md) |
| IA | [`geracrm-ia`](../../.claude/skills/geracrm-ia/SKILL.md) |
