# O roteamento do lead — automático ou puxado por humano

> O instante em que a rede entrega o peixe. `rede-de-pesca.md` termina aqui; o atendimento começa
> aqui. ⚠️ É o ponto de costura entre a operação de mídia e o CRM — e o lugar onde a maioria das
> operações perde o lead que pagou caro para conseguir.

## 1. A boa notícia: metade já existe

O GeraCRM já resolveu a parte difícil do atendimento puxado:

| Ativo | Onde |
|---|---|
| **Fila derivada** — conversa entrante sem atendimento aberto | `0055`, `rotas-fila.ts` |
| **"Assumir atendimento" com vencedor atômico** | ⚠️ INV-51: índice único parcial `atendimento_aberto_unico` — em 50 assunções concorrentes da mesma conversa, exatamente 1 vence |
| **Estado do atendimento** | `na_fila` \| `em_atendimento` \| `encerrado` (`0012`) |
| **Kanban com etapas configuráveis por tenant** | `0055`, incluindo ⚠️ "Aguardando nós" vs "Aguardando cliente" (`0056`) |
| **Setor e atendente** | `atendimento.setor_id`, `atendimento.atendente_id` |
| **Notificação só para quem assumiu** | `notificacao`, canal do usuário no SSE |
| **Presença na conversa** | `presenca_conversa` — dois atendentes se enxergam |

O que falta é **a decisão**: quem pega este lead, o agente ou uma pessoa.

## 2. ⚠️ O agente é participante da fila, não um desvio

A tentação é dar ao SDR agent um caminho próprio, paralelo ao atendimento humano. **Não.**

O agente assume a conversa **pelo mesmo mecanismo atômico** que uma vendedora usa (INV-51). As
consequências são todas boas e nenhuma delas precisa de código novo:

- ⚠️ **Agente e humano nunca respondem juntos** — o índice único garante um só atendimento aberto.
  Sem isso, o cliente recebe duas respostas conflitantes e nenhum dos dois sabe que o outro está lá.
- O **handoff** já tem forma: encerrar o atendimento do agente e devolver à fila, ou transferir o
  `atendente_id`. O histórico da conversa fica inteiro.
- O agente aparece no **kanban do gestor** como qualquer atendimento — visível, auditável,
  movível à mão.
- O **botão de desligar** (exigência do agente autônomo) fica trivial: agente desligado
  simplesmente não assume, e tudo cai na fila humana. ⚠️ **Degradar é o comportamento padrão**,
  não um caminho de exceção.

Implementação: o agente é um `usuario` do tenant, marcado como não-humano. O `atendente_id` já é FK
para `usuario` — nada muda de forma.

## 3. ⚠️ A armadilha que o schema já previu

Em `0012_conversa_mensagem.sql` existem **duas colunas separadas**, com este comentário:

> `primeira_resposta_humana_em` — *"Preenchida SÓ por mensagem de pessoa. A automática de ausência
> preenche `primeira_resposta_em` e não esta — é o que torna a contra-métrica MC-05 possível. Uma
> coluna só tornaria a diferença invisível."*

E a justificativa original: *"um robô respondendo 'Recebemos sua mensagem!' em 2 segundos faz o
tempo de primeira resposta despencar e a métrica declarar uma vitória que não houve."*

⚠️ **Isso é exatamente o risco desta operação inteira.** Nosso principal argumento comercial é
"speed-to-lead em segundos" — e ele pode ser fabricado por um agente que responde rápido e não
resolve nada. A defesa já está no banco, e a regra é:

- O SDR agent preenche `primeira_resposta_em`, **nunca** `primeira_resposta_humana_em`.
- O painel do agente (AQ-20) mostra as duas, **lado a lado e rotuladas** — a mesma disciplina de
  "exata × estimada" que vale para a receita (AMK-009).
- A métrica que importa não é tempo de resposta: é **tempo até qualificação** e **taxa de
  conversa que vira pedido**. Resposta rápida é meio, não resultado.

## 3.5. ⚠️ Refinamento na implementação: "Rede A/B" virou política do tenant

AMK-014 formulou a regra como **Rede A × Rede B**. Ao implementar (`rotearLead`), isso virou
**`politicaAgente`** — `autonomo` | `copiloto` | `desligado` — declarada por tenant.

A regra é a mesma; a expressão é melhor por três motivos:

- ⚠️ **O domínio não precisa saber quem é a Gera3 e quem é a loja.** "Rede A" é o nosso organograma,
  não um conceito do produto — e organograma dentro de regra de negócio envelhece mal.
- Um **cliente também pode preferir copiloto**, e nada na formulação original permitia isso.
- **O kill switch cabe na mesma dimensão** (`desligado`) em vez de virar uma flag paralela — o que
  torna possível provar que nenhuma combinação escapa dele.

## 4. As regras de roteamento

Avaliadas em ordem, em código — ⚠️ não no prompt (AMK-007). A primeira que casar decide.

| # | Condição | Destino | Por quê |
|---|---|---|---|
| 1 | Agente desligado (tenant/número) | **fila humana** | kill switch tem precedência sobre tudo |
| 2 | Campanha declara `outbound_formulario` | **fila humana** | ⚠️ AMK-016 — o modo da campanha decide, não o operador. O agente **só responde**, nunca aborda |
| 3 | Contato é **cliente de alto valor** (RFV topo, `qtd_vendas` alto) | **fila humana**, notificando o dono da carteira | ⚠️ ver abaixo |
| 4 | Contato **tem dono de carteira** ativo | fila do dono | relação já existe; robô no meio a quebra |
| 5 | Assunto fora do escopo declarado | **fila humana** | limite de escopo do agente |
| 6 | **Lead novo de anúncio** (tem `midia_lead_origem`) **e é Rede B** | **agente** | é o caso de uso central |
| 6b | Lead novo de anúncio **e é Rede A** | **fila humana** com copiloto | ⚠️ AMK-014 — lead B2B é caro, a pessoa envia |
| 7 | Fora do expediente | **agente**, com expectativa declarada | ⚠️ ver §6 |
| 8 | padrão | fila humana | ⚠️ **o default é humano**, não robô |

⚠️ **Regra 3 é inegociável: cliente grande nunca é triado por robô.** O CRM sabe o RFV e o
histórico de compra — é a única operação de mídia do mercado que **pode** saber isso no instante da
chegada. Deixar o melhor cliente conversando com um agente automático para economizar um minuto de
vendedora é trocar uma relação por um centavo.

⚠️ **Regra 2 mudou com AMK-014.** Antes ela mandava todo o canal não-oficial para humano, o que
tornaria a Rede B inviável depois de AMK-012. A regra agora separa o que realmente importa: o
agente **responde** quem escreveu, e **nunca aborda** quem não escreveu. É o link `wa.me` (AQ-44)
que garante que praticamente todo lead chegue como inbound.

⚠️ **Regra 6 usa a origem, não o palpite.** É a razão de `midia_lead_origem` (AQ-09) existir antes
do agente (AQ-19) no roteiro: sem saber que o contato veio de anúncio, o roteamento não tem em que
se apoiar.

## 5. Handoff — três gatilhos

| Gatilho | Exemplo |
|---|---|
| **Por regra** | lead qualificado, quer preço, pediu humano, assunto fora de escopo |
| **Por incerteza** | ⚠️ o agente não entendeu, ou entendeu com baixa confiança |
| **Por falha** | provedor de IA fora do ar → ⚠️ **fila humana, nunca sem resposta** |

O que atravessa junto, sempre: transcrição, o que foi qualificado, **o motivo**, a origem de mídia
e o que ainda falta perguntar. ⚠️ Handoff sem contexto obriga o cliente a repetir tudo — e o lead
percebe na hora que falou com um robô.

O destino natural é a etapa **"Aguardando nós"** (`0056`), criada precisamente para "a bola está
com a gente, é o que não pode esfriar".

## 6. Fora do expediente

O caso que sozinho justifica o agente: anúncio roda 24/7, vendedora não.

- O agente **atende, qualifica e agenda** — mas ⚠️ **declara a expectativa**: diz quando uma pessoa
  retoma, e não finge disponibilidade que não existe.
- Sem agente, a alternativa não é "esperar": é ⚠️ **pausar a veiculação fora do horário**, que é
  uma decisão de mídia legítima e às vezes a certa. Pagar por lead às 23h para responder às 9h é
  comprar um lead frio a preço de quente.
- ⚠️ **Nunca deixar sem resposta.** Mensagem automática de ausência preenche `primeira_resposta_em`
  e não a humana (§3) — o schema já sabe distinguir, e o painel precisa mostrar.

## 7. O que isso acrescenta ao backlog

Épicos novos em [`backlog-tecnico.md`](backlog-tecnico.md): motor de roteamento (AQ-40), agente
como participante da fila (AQ-41), handoff com contexto (AQ-42) e a separação humano × automático
nas métricas de resposta (AQ-43).
