# Stack — o que já é da casa e o que entra

⚠️ A regra é **não trazer stack nova**. Quase tudo que uma operação de mídia paga precisa já está
resolvido no GeraCRM, e cada peça nova é mais uma coisa para o mesmo time manter (o raciocínio do
ADR-006). O que entra abaixo entra por falta genuína.

## Já é da casa — reusar, não escolher de novo

| Necessidade | O que usamos | Por quê |
|---|---|---|
| Banco / fonte de verdade | **PostgreSQL + RLS** | ⚠️ A fonte de verdade **nunca** é o painel da plataforma — cada uma reivindica a mesma conversão. É o nosso banco, com o ERP por baixo. |
| Fila / agendamento | job no processo + **advisory lock** | padrão do `automacao-motor`, do despachante de webhooks e do integrador |
| Push para a tela | **SSE + outbox + NOTIFY** (ADR-007) | sem Redis, sem broker |
| Entrega confiável para fora | despachante de `webhook_saida` (`0033`) | HMAC, cursor, backoff, dead-letter após 8 tentativas |
| Mensageria com o lead | **WhatsApp Cloud API** (ADR-002/021) | ⚠️ oficial para o SDR autônomo (AMK-004) |
| Mídia / assets de criativo | bucket S3 do Railway + URL assinada (E5-14) | já resolvido, inclusive expiração curta |
| Série temporal e alerta | `metrica_janela` + `alerta` (`0031`) | agregação por hora, dedup, resolução automática |
| Auditoria | `auditoria` + helper `auditar()` | requisito de guardrail, não enfeite |
| Tipos e validação de borda | `packages/shared` (Zod, **TypeScript puro**) | a saída do LLM é entrada externa e passa por Zod como qualquer outra |
| Deploy | Railway, por watch path | ⚠️ ao importar `shared` num app novo, conferir o watch path **no mesmo commit** |

## O que entra de novo

| Peça | Escolha | Observação |
|---|---|---|
| Meta Marketing API | adaptador de leitura → depois escrita | ⚠️ atrás de porta do **nosso** domínio, capacidades declaradas (padrão ADR-008) |
| Google Ads API | idem | developer token tem níveis de acesso — pedir cedo |
| TikTok Business API / LinkedIn | conforme o nicho | ⚠️ só entram quando um cliente pagar por eles |
| Meta Conversions API (CAPI) | devolução de conversão | dedup por `event_id` |
| Google Enhanced / Offline Conversion Import | devolução de conversão | janela de importação limitada |
| **Meta Ad Library API** | insumo do Pesquisador | ⚠️ **é pública** — anúncios ativos de concorrente sem custo e sem raspagem |
| Provedor de LLM | por tarefa, não um só | ver `arquitetura-agentes.md` (custo) |

## Data warehouse: quando o Postgres deixa de bastar

Não agora. O volume de uma operação de agência é pequeno perto do que o Postgres aguenta, e separar
o dado de mídia do dado de venda **destrói justamente o que torna o produto defensável** — os dois
precisam se cruzar numa query.

⚠️ Os gatilhos que justificariam um warehouse (BigQuery + dbt), e nenhum antes:

- consulta analítica competindo com a operação a ponto de degradar o atendimento;
- necessidade de série histórica longa que a política de retenção não permite manter na base viva;
- MMM ou modelagem que peça dado de fora (sazonalidade, concorrência, mídia offline).

Até lá: **materialized view** e tabela de agregação, como `mv_metricas_contato` e `metrica_janela`
já fazem.

## Observabilidade da operação

O que existe hoje cobre o sistema. Falta o que cobre a **conta do cliente**:

| Saída | Cadência | Para quem |
|---|---|---|
| **Resumo diário** — gasto, leads, CPL, ROAS exato, o que mudou | diária | cliente e gestor |
| **Exceções** — só quando algo saiu da banda | na hora | gestor |
| Painel de auditoria do agente | contínuo | gestor e cliente |

⚠️ Entrega pelo canal que a operação já lê — **WhatsApp**, o mesmo que o CRM opera — em vez de mais
uma ferramenta. E ⚠️ **silêncio nunca pode parecer "está tudo bem"**: análise indisponível é alerta,
não ausência dele.

## O que NÃO entra

- **Ferramenta de BI externa** na primeira fase — o console já é a superfície.
- **Broker de mensagem** (Kafka/RabbitMQ) — o outbox resolve, e o ADR-007 já rejeitou isso uma vez.
- **Redis** — idem.
- **Automação de navegador** em plataforma de anúncio — AMK-003, sem exceção.
- **Ferramenta de "IA de marketing" pronta** — o valor está no loop com o ERP, que nenhuma delas
  tem. Comprar uma seria comprar o pedaço commodity e terceirizar o pedaço defensável.
