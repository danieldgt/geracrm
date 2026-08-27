# Agente SDR (AQ-19 / EP-18) — escopo antes do código

> **Estado (2026-08-27):** **fatia 1 implementada e no ar**, desligada por padrão. As decisões
> bloqueantes foram respondidas; o que resta em aberto está marcado com **[DECIDIR]**.
> **Regras que governam:** skill `geracrm-ia` (camada "agente autônomo"), ADR-005, ADR-021, INV-50.

---

## Por que este documento existe

O agente é a **única parte do produto que fala com o cliente final em nome da marca, sem ninguém
revisando**. Todo o resto do GeraCRM ou é operado por uma pessoa (inbox, pedido, campanha) ou é
mecânico e previsível (resposta de ausência, disparo, alerta).

Isso muda o que "pronto" significa. Um bug no kanban atrasa um atendimento; um bug no agente
manda a coisa errada para o cliente de alguém e ninguém descobre até o cliente reclamar — para o
dono da loja, não para nós.

⚠️ **O maior risco não é o agente responder mal. É ele responder mal com confiança, em escala, e o
operador só descobrir pelo resultado comercial semanas depois.** O escopo abaixo é construído em
torno disso.

---

## 1. O que o agente é — e o que ele NÃO é

O produto já tem uma resposta automática fora do expediente (`ausencia.ts`). Ela **não é o agente**,
e a distinção importa:

| | Resposta de ausência (existe) | Agente SDR (AQ-19) |
|---|---|---|
| O que faz | Diz que ninguém está e quando alguém volta | Conversa, pergunta, extrai, qualifica |
| Decide algo? | Não | Sim — qualifica ou desqualifica |
| Pode errar como? | Manda no horário errado | Diz algo errado sobre o negócio do cliente |
| Reversível? | Sim, é uma frase | ⚠️ Não — o cliente já leu |

**O agente é um SDR:** recebe quem chegou, entende o que a pessoa quer, coleta o que falta para
qualificar, e entrega ao humano **só quem está pronto** — com o contexto do que já foi conversado.

**O agente NÃO é:** atendente completo, vendedor, suporte técnico, nem substituto do time. Se a
promessa for "atende tudo", o escopo está errado.

---

## 2. Os invariantes — não negociáveis

Estes não são preferências; violá-los produz os defeitos que este produto existe para evitar.

1. **⚠️ Nenhuma regra de negócio mora no prompt.** Pedido mínimo, prazo de entrega, política de
   troca, preço — tudo isso é domínio, validado em código. Regra em prompt falha em silêncio e
   ninguém testa (skill `geracrm-ia`).

2. **⚠️ O agente nunca efetiva pedido.** O pedido nasce na conversa, o ERP efetiva (ADR-005). O
   agente pode *montar rascunho*; confirmar é do humano. **[DECIDIR]** se ele pode montar rascunho.

3. **⚠️ Opt-out vale para o agente igual.** A chave de bloqueio (INV-50) é checada no gateway único
   de envio; o agente não tem caminho paralelo de saída. Ele fala pelo mesmo gateway que tudo.

4. **⚠️ Extração estruturada é entrada externa.** CNPJ que o agente "leu" na conversa passa por Zod
   e dígito verificador antes de tocar o cadastro. O modelo alucina campo bem formatado e errado
   com facilidade.

5. **⚠️ Provedor de IA fora do ar manda a conversa para a fila humana.** Nunca deixa sem resposta,
   nunca derruba o inbox.

6. **⚠️ Toda conversa conduzida pelo agente é registrada e auditável**, com o motivo de cada
   qualificação/desqualificação. "Desqualificado" sem razão é ruído que ninguém consegue contestar.

7. **⚠️ Botão de desligar por número e por tenant**, que tem efeito na próxima mensagem — não no
   próximo deploy.

---

## 3. Onde o agente PARA

Esta é a parte que decide se o produto é confiável. Um agente sem fronteira clara é uma aposta.

Ele **para e chama humano** quando:

- **Incerteza.** Não sabe responder, ou a resposta não está na base de conhecimento.
- **Fora do escopo declarado.** Reclamação, cobrança, problema com pedido existente, jurídico.
- **Sinal emocional.** Cliente irritado, ameaça de cancelamento, reclamação pública.
- **Pedido de humano.** "Quero falar com alguém" encerra o turno do agente, sempre.
- **Qualificou.** Missão cumprida — entrega com contexto.
- **Limite de turnos.** ✅ Implementado: `agente_config.max_turnos`, padrão 6, ajustável de 1 a 20
  por número na tela. Bater no teto ENCERRA a sessão com motivo — sem isso ela ficaria aberta para
  sempre e a conversa nunca chegaria ao humano.

⚠️ **Handoff sem contexto é pior que não ter agente**: o cliente repete tudo para o humano, e a
sensação é de ter perdido tempo com uma máquina. O handoff carrega resumo, dados extraídos e o
motivo da entrega.

---

## 4. Perguntas que precisam de resposta antes do código

Sem estas, qualquer implementação é chute caro.

### 4.1 ✅ O que qualifica um lead — **decidido**

Seis sinais, definidos pelo dono do produto:

| Sinal | Origem | Observação |
|---|---|---|
| **Histórico de compra** | nosso banco (carga do ERP) | ⚠️ Já temos — não perguntar o que sabemos |
| **Tipo de compra** (consumo final ou revenda) | conversa | O separador varejo/atacado (ADR-019) |
| **Cidade** | conversa ou cadastro | Define atendimento e frete |
| **Volume** | conversa | Qualifica o tamanho |
| **CNPJ** | conversa | ⚠️ Validar dígito antes de gravar |
| **Interações** | nosso banco | Histórico de conversa já existente |

⚠️ **Três dos seis já estão no nosso banco.** O agente que pergunta o CNPJ de quem já é cliente
soa como um formulário, não como atendimento — e é o jeito mais rápido de a pessoa desistir. A
regra que sai daqui: **o agente carrega o que já sabe antes de abrir a boca, e só pergunta o
buraco.**

### 4.2 ✅ Base de conhecimento: **híbrido** — decidido

> Modelo pronto do texto curado, com as quatro regras que decidem se ele
> funciona: `docs/agente-politicas-exemplo.md`.

O agente precisa responder sobre a loja: o que vende, prazo, forma de pagamento, entrega. Opções:

- **Texto curado pelo cliente** — ele escreve, versionamos. Simples, e o erro é dele.
- **Extraído do catálogo/ERP** — automático, e desatualiza sozinho quando o ERP muda.
- **Híbrido** — catálogo do ERP + texto livre para políticas.

**Decidido: híbrido** — catálogo/ERP para o que muda sozinho (produto, preço, estoque) e texto
curado pelo cliente para políticas (prazo, pagamento, entrega, troca).

⚠️ **Consequência de onboarding:** cada cliente novo precisa escrever o texto de políticas antes de
ligar o agente. Isso é trabalho dele, não nosso — e um agente ligado com a base vazia responde
"não sei" a tudo, o que é pior que não ter agente. ✅ **Implementado: o produto BLOQUEIA** — recusa
na tela com a frase que diz o que fazer, e um CHECK no banco como rede de segurança (`0071`).
Modelo de texto pronto em `agente-politicas-exemplo.md`.

### 4.3 ✅ Fora do expediente — **decidido**

Confirmada a recomendação: começa fora do expediente, onde o agente compete com o silêncio e não
com uma pessoa. Errar contra o silêncio é barato.

As três opções ficam registradas para quando o 24/7 voltar à mesa:

| Desenho | Consequência |
|---|---|
| Só fora do expediente | Substitui a ausência. Baixo risco, ganho claro, escopo pequeno |
| 24/7 com humano por cima | Máximo ganho. ⚠️ Agente e humano na mesma conversa ao mesmo tempo é o problema difícil |
| 24/7, humano só no handoff | Simples de programar, mas o time perde o contato com o cliente |

### 4.3.1 ✅ E a resposta de ausência? — **decidido e implementado**

Escolher "fora do expediente" cria um choque que não existia: **a ausência já ocupa esse horário.**
Ela está em produção, funcionando, e dispara em 2 segundos. Se o agente também responder, o cliente
recebe duas mensagens automáticas seguidas — e a primeira, "voltamos amanhã às 9h", **contradiz** a
segunda, que puxa conversa.

Três desenhos possíveis:

| Desenho | O cliente vê | Custo |
|---|---|---|
| **Agente substitui a ausência** quando ligado | Só o agente | ⚠️ Perde o "voltamos às 9h", que administra expectativa |
| **Ausência primeiro, agente se a pessoa responder** | "Voltamos às 9h" e, se ela insistir, o agente | Mais conversas mortas; mas quem responde está engajado |
| **Agente só para contato NOVO**, ausência para quem já é cliente | Depende de quem é | Mais código, e o cliente antigo perde o agente |

✅ **Escolhido o segundo** (26/08) e implementado: o agente não escuta "mensagem fora do
expediente", e sim "mensagem **depois** de uma ausência já enviada, nas últimas 12h". Vale para os
dois webhooks — não-oficial e Meta — a partir de um lugar só (`resposta-automatica.ts`).

### 4.4 **[DECIDIR]** Canal: oficial, não-oficial, ou os dois?

⚠️ O canal não-oficial **carrega risco de banimento** (ADR-021), e um agente conversando 24/7
aumenta volume e padrão-de-robô no número. Ligar o agente no não-oficial é aumentar a aposta que o
cliente já está fazendo — e ele precisa saber disso na interface, não no contrato.

### 4.5 ✅ Fala preço, lendo do ERP — **decidido, com um bloqueio pela frente**

Decisão: sim, e o preço vem do ERP em tempo real, nunca do prompt.

⚠️ **O conector NÃO consegue fazer isso hoje, e isso não é detalhe.** Em
`packages/conectores/src/geracloud/conector.ts`, `consultarPrecos` recebe o cliente e o **ignora**:

```ts
async consultarPrecos(_clienteExterno: string, skusExternos) {
  // TODO: map customer → price table. …WHICH table belongs to a customer
  // was not found while reading the source
```

Ele devolve a tela de venda padrão. Num produto que atende **varejo e atacado** (ADR-019), tabela de
preço varia por cliente — então o agente diria o preço errado, com confiança, fora do expediente,
sem ninguém olhando. É o modo de falha nº 1 do §8 acontecendo na primeira semana.

**Portanto:** falar preço é requisito do produto, mas **não entra na fatia 1**. Vira pré-requisito:
resolver `cliente → tabela de preço` no conector (investigação na API do GeraCloud) antes de o
agente cotar qualquer valor. Até lá, ele coleta a intenção de compra e entrega ao humano.

### 4.6 **[DECIDIR]** Quem responde quando o agente erra feio?

Não "se" — "quando". Precisa existir: um jeito de o operador ver o que foi dito, corrigir na
conversa, e desligar o agente para aquele cliente. **[DECIDIR]** se desligar é por conversa, por
número, ou os dois.

---

## 5. Como saber se está funcionando

⚠️ Sem isto, ninguém consegue dizer se o agente ajuda ou atrapalha — e a discussão vira opinião.

| Métrica | O que revela |
|---|---|
| Taxa de qualificação | Se o agente separa lead bom de ruim |
| **Tempo até qualificação** | O ganho real prometido ao cliente |
| Taxa de handoff | Escopo apertado demais (alta) ou largo demais (baixa) |
| Handoff por incerteza vs. por sucesso | Se ele está desistindo ou entregando |
| **Conversas que o humano precisou corrigir** | ⚠️ A métrica mais honesta — é a taxa de vergonha |
| Custo por conversa, por tenant | Se o preço do plano fecha |

A última linha da direita é a que ninguém gosta de medir e a que mais importa.

---

## 6. Fatias sugeridas

Cada fatia entrega valor sozinha e pode parar ali sem deixar coisa pela metade.

**Fatia 1 — Agente fora do expediente, sem escrever nada no cadastro e SEM falar preço.**
Recebe, conversa, extrai dados, **propõe** qualificação e entrega ao humano de manhã com resumo.
Nada entra no cadastro sem uma pessoa aprovar. É o agente com rodinhas: se ele for ruim, o custo é
um resumo ruim que alguém descarta.

⚠️ **Sem preço na fatia 1** (§4.5): o conector ainda não resolve `cliente → tabela de preço`, e
cotar da tabela padrão é dizer o número errado com confiança. O agente reconhece a intenção de
compra, registra, e entrega ao humano.

Os seis sinais de qualificação (§4.1) entram assim: **histórico, interações e cadastro vêm do nosso
banco antes da primeira mensagem**; tipo de compra, cidade e volume são o que o agente pergunta —
e só se ainda não souber.

**Fatia 2 — Extração entra no cadastro sozinha**, depois que a fatia 1 mostrar que a extração é
confiável (medida contra o conjunto de casos reais, não por impressão).

**Fatia 3 — Qualificação automática com motivo registrado** e painel de auditoria.

**Fatia 4 — 24/7**, com a convivência agente/humano resolvida.

⚠️ **A ordem não é negociável por conveniência.** Começar pela fatia 3 é ligar decisão automática
antes de saber se a extração acerta.

---

## 7. O que fica fora (não-objetivos)

Escrever isto evita a conversa de "mas eu achei que também faria":

- Não atende suporte pós-venda nem reclamação.
- Não negocia preço, prazo ou desconto.
- Não confirma pedido (ADR-005).
- Não faz cobrança.
- Não age fora da conversa (não liga, não manda campanha por conta própria).
- Não substitui o time — o desenho é entregar **menos** conversas ao humano, com **mais** contexto.

---

## 8. Riscos, na ordem em que doem

1. **O agente diz algo errado sobre o negócio do cliente.** Mitigação: base de conhecimento
   versionada, escopo estreito, handoff por incerteza, e a métrica de correção humana.
2. **Banimento do número não-oficial** por padrão de robô. Mitigação: decisão explícita e visível
   do cliente; considerar restringir o agente ao canal oficial.
3. **Custo fora de controle.** Mitigação: limite por tenant com degradação para humano, medição por
   funcionalidade, modelo dimensionado por tarefa.
4. **Extração plausível e errada** entrando no cadastro. Mitigação: validação de domínio, e fatia 1
   sem escrita.
5. **LGPD.** Conversa enviada a provedor externo é tratamento de dado pessoal: precisa estar na
   política, no contrato, e a exclusão do titular tem de alcançar o que foi enviado.

---

## 9. Situação das decisões

✅ **Respondidas em 2026-08-26** — as quatro que bloqueavam o início:

| | Decisão |
|---|---|
| §4.1 | Qualifica por histórico, tipo de compra (final/revenda), cidade, volume, CNPJ e interações |
| §4.2 | Base híbrida: ERP para o que muda sozinho, texto curado para políticas |
| §4.3 | Fora do expediente, inicialmente |
| §4.5 | Fala preço, lendo do ERP — **bloqueado até o conector resolver cliente → tabela** |

⚠️ **Aberta e bloqueando a fatia 1:** §4.3.1 — como o agente convive com a resposta de ausência,
que já ocupa esse horário em produção. Recomendação registrada: ausência primeiro, agente se a
pessoa responder.

**Podem esperar a fatia 1 acontecer:** §4.4 (canal), §4.6 (desligar por conversa ou por número),
teto de turnos, se o agente monta rascunho de pedido, e se o produto bloqueia ligar o agente com a
base de políticas vazia.

---

## 10. Pré-requisito técnico fora deste escopo

**`cliente → tabela de preço` no conector GeraCloud.** Hoje `consultarPrecos` ignora o cliente e
devolve a tela de venda padrão. Enquanto isso não for resolvido, o agente não cota preço — e o
produto inteiro fica sem preço por cliente, o que já afeta o pedido assistido, não só o agente.

É uma investigação na API do GeraCloud (`/tabela-preco/todas` existe; falta descobrir qual tabela
pertence a qual cliente), e vale por si — independe do agente ser construído.
