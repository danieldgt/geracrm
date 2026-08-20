# Arquitetura de agentes

## O princípio: o fluxo é determinístico, o julgamento é do modelo

⚠️ **Não é um agente livre decidindo o que fazer com a verba do cliente.** O fluxo é código —
fila, job agendado, transação, retry. O modelo entra só nos pontos onde há julgamento genuíno:
escrever copy, classificar intenção, ler uma curva, decidir se um lead é bom.

Isso vale três coisas que um agente autônomo não entrega: custo previsível, comportamento
auditável e a possibilidade de testar cada passo isoladamente. É a mesma lógica da skill
`geracrm-ia`: **nenhuma regra de negócio mora no prompt** — "teto diário é R$ 500" é validado em
código, não pedido educadamente ao modelo.

Corolário: o agente **propõe**; o sistema aplica dentro de limites; o humano aprova o que sai deles.

## Os papéis

Cada agente tem escopo estreito, ferramentas limitadas e saída tipada (Zod na borda, como qualquer
entrada externa — o modelo alucina campo bem formatado e errado com facilidade).

### Aquisição

| Agente | Entrada | Saída | Escreve? |
|---|---|---|---|
| **Pesquisador** | vertical, concorrentes, oferta do cliente | briefing de ângulos e público | não |
| **Fábrica de criativo** | briefing + guidelines da marca | N variações (hook, corpo, CTA, prompt de imagem) | não |
| **Construtor de veiculação** | briefing + criativos aprovados | **plano de mudança** (diff da estrutura), com *naming convention* aplicada | ⚠️ só via aprovação |
| **Revisor de conformidade** | criativo + landing page | veredito + motivo por regra violada | não (barra) |

⚠️ A **Meta Ad Library é pública e tem API**: os anúncios que o concorrente mantém no ar há meses
são o insumo mais barato que existe para o Pesquisador — sem custo e sem raspagem. Anúncio velho
é anúncio que está pagando a própria veiculação.

⚠️ A *naming convention* do Construtor não é estética: é o que permite ler a conta por query em
vez de por leitura humana. Ela é validada em código — nome fora do padrão é erro, não aviso.

⚠️ O **Revisor de conformidade** roda **antes** de qualquer publicação, sempre. É o agente mais
barato do conjunto e o que evita o dano mais caro (conta banida). Checa política de anúncio
(inclusive categorias especiais: crédito, emprego, moradia, saúde, política), promessa de
resultado, e coerência anúncio ↔ landing page.

### Análise

| Agente | Cadência | O que decide |
|---|---|---|
| **Analista de performance** | diária | criativo: escalar / manter / matar; detecção de fadiga (frequência, CTR caindo, CPM subindo) |
| **Vigia de anomalia** | de hora em hora | gasto fora de banda, veiculação parada, evento parando de chegar, CPL estourando |

⚠️ O Analista decide com **janela estatisticamente honesta**. Matar criativo com 12 cliques é
ruído, não decisão — o limiar de massa mínima é regra de código (o `avaliarEntrega` de `0031` já
faz isso para entrega de mensagem: massa mínima 20, limiar 70%; a régua de criativo segue o mesmo
padrão).

O Vigia **não precisa de infra nova**: `metrica_janela` e `alerta` (migration `0031`) já dão
agregação por hora, dedup de alerta aberto, resolução automática e evento no SSE.

### Lead

| Agente | Papel | Gatilho |
|---|---|---|
| **Qualificador** | enriquece, aplica ICP, atribui score, **registra o motivo** | lead novo (evento) |
| **SDR** | responde em segundos, faz 3–5 perguntas, agenda ou encaminha | lead novo / resposta do lead |
| **Nurture** | cadência para lead frio e reativação | agendado (motor existente) |

⚠️ Qualificação é **decisão de negócio e precisa de motivo auditável** (regra da skill
`geracrm-ia`). "Descartado" sem razão é ruído que ninguém consegue contestar — e, numa agência, é
exatamente o que o cliente vai questionar quando o CPL subir.

O SDR é o único agente que **fala com o cliente final em nome da marca**. Ele carrega o checklist
completo do agente autônomo: base de conhecimento versionada, limite de escopo explícito, handoff
por regra **e por incerteza**, registro de toda conversa, painel de auditoria e **botão de
desligar por número e por tenant**.

### Orquestração

O **Orquestrador** não é um agente: é o job que mantém o estado do ciclo, decide o que despachar e
escala para humano ao ultrapassar limiar. Código, não prompt.

## Como isso se apoia no que já existe

```
Lead Ads / CTWA / LP ──webhook──▶ gateway (existe) ──▶ contato + midia_lead_origem
                                                              │
                                            outbox (existe) ──┴──▶ NOTIFY (existe)
                                                              │
                                        ┌─────────────────────┴──────────┐
                                        ▼                                ▼
                              Qualificador (novo)              SSE → tela (existe)
                                        │
                                        ▼
                                  SDR (novo) ──▶ gateway de envio (existe: opt-out,
                                        │         estado do canal, janela 24h)
                                        ▼
                         conversa / kanban de Leads (existe)
                                        ▼
                              pedido → ERP efetiva (existe)
                                        ▼
                      Conversor (novo) ──▶ CAPI / offline conversions
```

Note que a coluna vertical inteira já está construída. Os três blocos "novo" são o trabalho.

## Dois caminhos de gatilho, não um

| Caminho | Motor | Latência | Para quê |
|---|---|---|---|
| **Por evento** | outbox pós-commit → NOTIFY | segundos | lead novo, resposta do lead, alerta de gasto |
| **Agendado** | `automacao-motor.ts`, varredura | minutos/horas | nurture, lead frio, análise diária, sync de métrica |

⚠️ Manter os dois com o **mesmo modelo de dedup**. O agendado já registra `automacao_execucao` na
mesma transação da ação; o caminho por evento precisa da mesma disciplina — evento reentregue não
pode gerar segunda mensagem ao lead. Handler idempotente é regra da casa (webhooks já são).

## Custo de IA

A IA é uma das maiores linhas de custo variável, e numa operação de agência ela multiplica pelo
número de contas.

- **Modelo pelo tamanho da tarefa.** Classificar intenção e escrever copy não pedem o mesmo modelo.
  Usar o maior para tudo é desperdício que aparece na fatura.
- **Medir por tenant e por funcionalidade** — sem isso não há como precificar o fee nem detectar
  abuso.
- **Cache** para pergunta repetida na base de conhecimento.
- **Limite por tenant** com degradação definida: estourou, cai para humano — ⚠️ nunca falha calada.

## Fallback

| Recurso | Provedor de IA fora |
|---|---|
| Fábrica de criativo | fila espera; nada quebra |
| Analista / Vigia | ⚠️ alerta de "análise indisponível" — silêncio não pode parecer "está tudo bem" |
| **SDR** | ⚠️ conversa vai para a **fila humana**, nunca fica sem resposta |
| Construtor | não publica; plano fica pendente |

## Avaliação de qualidade

Prompt não se testa como código, mas também não se ajusta por impressão.

- Conjunto de **casos reais com resultado esperado**, rodado a cada mudança de prompt ou modelo.
- Métricas que revelam degradação: taxa de qualificação, **tempo até qualificação**, taxa de
  handoff, e a mais honesta — quantas sugestões do copiloto são enviadas **sem edição**.
- ⚠️ Mudança de prompt é **mudança de comportamento**: vai para o changelog e é reversível.
