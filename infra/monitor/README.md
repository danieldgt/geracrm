# Monitor de saúde (cron service do Railway)

Script ESM puro (`monitor.mjs`, Node 22, **sem dependência**). Uma execução = uma rodada de checagens, e sai.
Roda a cada 5 min como cron service. Backup **não** faz parte deste monitor.

## O que verifica

1. `GET {API_URL}/saude/detalhada` — `status` `ok`/`degradado`/`erro`; cada `motivo` vira um alerta próprio
   (a API fora do ar ou respondendo lixo também).
2. `GET {CONSOLE_URL}/` — espera HTTP 200.
3. **Webhook parado** — a API não recebeu mensagem de entrada há mais de `WEBHOOK_PARADO_MIN` minutos
   **dentro do horário comercial**. Fonte: componente `entrada` de `/saude/detalhada`
   (`ultimaMensagemEntradaEm`, máximo global entre tenants, janela de 48 h; informativo — nunca muda o
   `status`). O silêncio só conta a partir da abertura do expediente (segunda 08:10 não acusa por causa de
   sexta). Se a API não conseguiu ler (`lido:false`), não alerta.

## Variáveis

| Variável | Padrão | Para quê |
|---|---|---|
| `API_URL` | — | Base da API (ex.: `https://api.geracrm.app`). |
| `CONSOLE_URL` | — | Base do console. Pelo menos uma entre API/CONSOLE é obrigatória. |
| `SLACK_WEBHOOK_URL` | — | Incoming webhook do Slack (`{"text"}`). |
| `DISCORD_WEBHOOK_URL` | — | Webhook do Discord (`{"content"}`). Sem nenhum dos dois, alerta só no log. |
| `HEARTBEAT_URL` | — | Healthchecks.io: chamado a cada execução bem-sucedida (avisa se o próprio monitor parar). |
| `WEBHOOK_PARADO_MIN` | `30` | Minutos sem mensagem de entrada para acusar. |
| `HORARIO_COMERCIAL` | `seg-sex 08-18` | `dia-dia HH-HH` ou `HH:MM-HH:MM` (`seg ter qua qui sex sab dom`). |
| `TZ` | `America/Fortaleza` | Fuso do horário comercial. |
| `REPETIR_MIN` | `60` | Repete o mesmo motivo, no máximo, a cada tanto. |
| `ESTADO_ARQUIVO` | — | Arquivo de estado (ex.: `/data/monitor.json`, em volume). Ver "Dedupe". |
| `TIMEOUT_SEG` | `10` | Timeout de cada chamada. |
| `AMBIENTE` | `RAILWAY_ENVIRONMENT_NAME` | Rótulo na mensagem. |

URLs de webhook são segredo: nunca vão para o log.

## Dedupe e recuperação — e a limitação

O cron do Railway sobe um container efêmero: não há memória entre execuções.

- **Com `ESTADO_ARQUIVO` num volume** (recomendado): problema novo avisa **na hora**; o mesmo motivo repete a cada
  `REPETIR_MIN`; quando some, sai "voltou ao normal". Aviso que falhou na entrega não é memorizado (tenta de novo).
- **Sem estado** (padrão): cada motivo cai numa fatia de `REPETIR_MIN` determinada pelo hash do motivo e só
  avisa naquela fatia — **no máximo uma vez por janela**, mas o **primeiro aviso pode atrasar até `REPETIR_MIN`**
  e **não há mensagem de recuperação** (não há como saber o que estava errado antes).

Sai com código ≠ 0 só em erro do próprio script (config inválida, alerta não entregue). Problema na API/console
é alerta, não falha do script.

## Criar o cron service no Railway

1. No projeto: **New → Empty Service**, nome `monitor`, mesmo repositório.
2. Settings → **Root Directory**: `infra/monitor`; **Start Command**: `node monitor.mjs`;
   **Cron Schedule**: `*/5 * * * *`. Sem build (Railpack detecta Node; não há dependência a instalar —
   se pedir, `Build Command` vazio).
3. Watch path: `infra/monitor/**` (o monitor não importa `packages/shared`).
4. Variables: `API_URL`/`CONSOLE_URL` (de preferência a URL pública, para checar o caminho de fora),
   `SLACK_WEBHOOK_URL` e/ou `DISCORD_WEBHOOK_URL`, `HEARTBEAT_URL` se usar Healthchecks.io.
5. Para dedupe exato: crie um **Volume** montado em `/data` no serviço e defina `ESTADO_ARQUIVO=/data/monitor.json`.
6. Healthchecks.io: crie um check com período 5 min e tolerância ~10 min e cole a URL em `HEARTBEAT_URL`.

## Testar localmente

```sh
# testes (fetch falso)
pnpm --filter @geracrm/monitor test

# rodada real (só log, sem webhook)
API_URL=http://localhost:3000 node infra/monitor/monitor.mjs

# forçando o alerta: webhook parado a qualquer hora
API_URL=http://localhost:3000 WEBHOOK_PARADO_MIN=0 HORARIO_COMERCIAL="dom-sab 00:00-23:59" \
  SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... node infra/monitor/monitor.mjs
```

O que fazer em cada motivo: `docs/agente-runbook.md`.
