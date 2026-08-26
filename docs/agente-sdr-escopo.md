# Agente SDR (AQ-19 / EP-18) — escopo antes do código

> **Estado:** proposta de escopo. Nada implementado. Decisões pendentes marcadas com **[DECIDIR]**.
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
- **Limite de turnos.** **[DECIDIR]** quantas idas e vindas antes de desistir. Sem teto, um cliente
  confuso conversa com o robô por vinte mensagens e vai embora.

⚠️ **Handoff sem contexto é pior que não ter agente**: o cliente repete tudo para o humano, e a
sensação é de ter perdido tempo com uma máquina. O handoff carrega resumo, dados extraídos e o
motivo da entrega.

---

## 4. Perguntas que precisam de resposta antes do código

Sem estas, qualquer implementação é chute caro.

### 4.1 **[DECIDIR]** Qual é o negócio do cliente-alvo?

Um agente de qualificação precisa saber **o que separa um lead bom de um ruim** — e isso é
específico do ramo. Para a Gera3 (varejo/atacado via GeraCloud), candidatos: é CNPJ? compra para
revenda? qual volume? qual cidade? já é cliente?

Sem essa lista, o agente conversa bonito e não qualifica nada.

### 4.2 **[DECIDIR]** Base de conhecimento: de onde vem?

O agente precisa responder sobre a loja: o que vende, prazo, forma de pagamento, entrega. Opções:

- **Texto curado pelo cliente** — ele escreve, versionamos. Simples, e o erro é dele.
- **Extraído do catálogo/ERP** — automático, e desatualiza sozinho quando o ERP muda.
- **Híbrido** — catálogo do ERP + texto livre para políticas.

⚠️ Isto define quanto trabalho de onboarding cada cliente novo dá. É decisão de produto, não técnica.

### 4.3 **[DECIDIR]** O agente atende 24/7 ou só fora do expediente?

Três desenhos, com consequências opostas:

| Desenho | Consequência |
|---|---|
| Só fora do expediente | Substitui a ausência. Baixo risco, ganho claro, escopo pequeno |
| 24/7 com humano por cima | Máximo ganho. ⚠️ Agente e humano na mesma conversa ao mesmo tempo é o problema difícil |
| 24/7, humano só no handoff | Simples de programar, mas o time perde o contato com o cliente |

**Recomendo o primeiro para a fatia 1** — é onde o agente compete com o silêncio, não com uma
pessoa. Errar contra o silêncio é barato.

### 4.4 **[DECIDIR]** Canal: oficial, não-oficial, ou os dois?

⚠️ O canal não-oficial **carrega risco de banimento** (ADR-021), e um agente conversando 24/7
aumenta volume e padrão-de-robô no número. Ligar o agente no não-oficial é aumentar a aposta que o
cliente já está fazendo — e ele precisa saber disso na interface, não no contrato.

### 4.5 **[DECIDIR]** O agente fala preço?

Preço é a informação que mais gera conflito quando errada. Se sim, ele lê do catálogo/ERP em tempo
real (nunca do prompt) e a tabela por cliente precisa estar resolvida — hoje há um `TODO` aberto
exatamente aí no conector GeraCloud.

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

**Fatia 1 — Agente fora do expediente, sem escrever nada no cadastro.**
Recebe, conversa, extrai dados, **propõe** qualificação e entrega ao humano de manhã com resumo.
Nada entra no cadastro sem uma pessoa aprovar. É o agente com rodinhas: se ele for ruim, o custo é
um resumo ruim que alguém descarta.

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

## 9. O que eu preciso de você para começar

Em ordem de bloqueio:

1. **§4.1** — a lista do que qualifica um lead no seu negócio. É o que o agente vai perseguir.
2. **§4.3** — fora do expediente ou 24/7. Recomendo fora do expediente.
3. **§4.2** — de onde vem a base de conhecimento.
4. **§4.5** — se ele fala preço.

As demais (**§4.4**, **§4.6**, limite de turnos, rascunho de pedido) dá para decidir durante a
fatia 1, mas as quatro acima definem o que se constrói.
