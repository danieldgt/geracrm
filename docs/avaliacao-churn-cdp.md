# CDP e predição de churn — vale entrar no escopo?

> Avaliação pedida depois do ADR-019 (varejo em primeiro lugar), que transformou Dito e Mercafácil
> de adjacentes em concorrentes diretos.

---

## Resposta curta

| | Veredito |
|---|---|
| **CDP** | ❌ **Não construir.** Já temos os componentes — o que falta é nome, não código |
| **Predição de churn** | ✅ **Sim, mas na forma explicável.** E o valor não está em prever |

---

## 1. CDP — já está construído, só não se chama assim

CDP é três coisas: **unificar identidade de várias fontes**, **segmentar** e **ativar**.

| O que um CDP faz | Onde já está |
|---|---|
| Unificar identidade entre fontes | `contato_identidade_externa`, reconciliação por telefone e documento (`modelo-de-dados` §6) |
| Resolver conflito entre fontes | `conflito_identidade`, `contato_campo_origem`, mesclagem reversível (CTT-11) |
| Perfil unificado | Ficha do cliente com histórico, categorias, RFV |
| Segmentar | `lista_salva` dinâmica, filtros por RFV, por saldo, por comportamento |
| Ativar | Campanhas, Fila do Dia, copiloto |

⚠️ **Construir "um CDP" seria refazer o que existe com outro nome.** A diferença entre nós e um CDP
de mercado é que eles ingerem dezenas de fontes (e-commerce, loja física, app, mídia paga) e nós
ingerimos ERP + canais. Isso é escopo de ingestão, não arquitetura nova.

**Ação:** nenhuma no código. Nos materiais comerciais, chamar pelo nome — "perfil unificado do
cliente" comunica melhor que "CDP" para o dono de loja, mas na comparação com Dito o termo importa.

---

## 2. Predição de churn — a pergunta certa não é a que parece

A pergunta que se faz naturalmente é *"conseguimos prever?"*. A que importa é outra:

> **A previsão muda o que a vendedora faz amanhã de manhã?**

Se o RFV já classifica como `Em Risco` e a Fila do Dia já prioriza, um número mais preciso sobre a
mesma pessoa **não muda a ação**. Vira relatório mais bonito.

### O que já temos, e que já é predição

O modelo guarda, por cliente: `media_entre_vendas`, `dias_sem_vendas`, histórico de segmento RFV ao
longo do tempo, ticket, categorias, e agora saldo de cashback com data de expiração.

Com isso dá para dizer, hoje, sem modelo nenhum:

> *"Compra a cada 33 dias em média. Está em 47. Já passou do ponto em 42% das vezes anteriores."*

⚠️ **Isso é predição — e é explicável.** A vendedora entende, confere com o que ela sabe do cliente,
e age. É a diferença entre uma ferramenta que ela usa e uma que ela ignora.

### O que um modelo estatístico acrescentaria

| Ganha | Custa |
|---|---|
| Precisão marginal, cruzando mais variáveis | Dados de treino, avaliação contínua, retreino |
| Captura padrões que a regra não vê (sazonalidade, mix) | ⚠️ **Explicabilidade** — o custo real |
| Palavra "IA" no material de venda | Manutenção de algo que degrada em silêncio |

⚠️ **O custo que subestimam é a explicabilidade.** "0,87 de probabilidade de churn" não diz à
vendedora o que fazer. E no varejo de moda ela **precisa acreditar para agir** — ela conhece a
cliente, e se o sistema discordar dela sem explicar, ela para de olhar.

Um modelo que ninguém entende produz duas reações, ambas ruins: obediência cega (a vendedora liga
para quem o sistema mandou, sem julgamento) ou descrédito (ela ignora e volta à intuição).

### E há um problema de dado, específico do varejo

⚠️ **No varejo, "parou de comprar" é ambíguo.** No atacado, o lojista some e isso é churn claro.
No varejo, a cliente comprou um vestido em maio e não voltou — ela churnou, ou simplesmente não
precisava de vestido? Sem rótulo confiável de churn, treinar modelo supervisionado é adivinhação
com aparência de ciência.

O RFV contorna isso não afirmando causa: ele diz **"está fora do padrão dela"**, que é verificável.

---

## 3. Recomendação

### Fazer: predição explicável, antecipada para a Onda 3

`RFV-10` já existia no escopo, na Onda 4. **Antecipar para a Onda 3**, na forma baseada no ritmo do
próprio cliente:

```
atraso = dias_sem_comprar ÷ media_entre_vendas_do_cliente

  < 1,0   no ritmo
  1,0–1,5 atrasado          ⚠️ é aqui que a ação vale mais
  > 1,5   fora do padrão
  > 2,5   provavelmente perdido
```

Comparar com o **próprio histórico do cliente**, nunca com uma média geral — o cliente que compra a
cada 90 dias não está atrasado aos 60, e uma régua única erraria os dois extremos.

**Por que a Onda 3 e não antes:** depende de carga histórica consolidada e de RFV rodando. Antes
disso, o denominador não existe.

### Não fazer agora: modelo estatístico

Reavaliar **depois** de a versão explicável rodar por um ciclo, com uma pergunta objetiva:

> Das clientes que a régua apontou, quantas voltaram após o contato — e quantas voltariam de
> qualquer jeito?

⚠️ Sem essa medição, trocar régua por modelo é trocar algo que se entende por algo que não se
entende, sem saber se melhorou.

### E o que realmente vale mais que os dois

**A previsão só vira dinheiro na Fila do Dia** (`TSK-08`). Prever quem vai sumir e não fazer nada é
relatório. O diferencial é a sequência completa:

```
prever  →  priorizar por valor esperado  →  entregar a mensagem pronta  →  medir o resultado do toque
```

⚠️ **Nenhum concorrente analisado fecha esse ciclo.** Dito e Mercafácil preveem e segmentam; a ação
volta para o humano decidir. Nós temos o inbox — a ação pode acontecer no mesmo lugar, e o resultado
volta para ajustar a régua.

**É aí que o esforço rende**, não em melhorar de 78% para 83% de acurácia numa previsão que ninguém
vai executar.

---

## 4. Efeito no mapa competitivo

Reler `concorrentes-tailor.md` anel 2 com o varejo em primeiro plano:

| Dito / Mercafácil | Nós |
|---|---|
| CDP com muitas fontes | Perfil unificado ERP + canais — ⚠️ **menos fontes, mais profundidade em conversa** |
| Predição de churn | Régua explicável, ligada à ação |
| Fidelidade própria | ⚠️ **Leitura do saldo real do ERP** — e campanha por expiração, que eles não fazem |
| Campanha multicanal | Idem, com WhatsApp como canal principal |
| ❌ Não têm | **Atendimento**. O inbox é nosso, e é onde a ação acontece |

⚠️ **O flanco real não é predição — é que eles preveem e não atendem.** Competir onde eles são
fortes (modelo, CDP) é caro e chega empatado. Competir onde eles não estão (a conversa que fecha a
recompra) é onde o produto ganha.

---

## 5. Decisão proposta

| # | Item | Decisão |
|---|---|---|
| 1 | Construir CDP | ❌ Não. Já existe; é questão de nome |
| 2 | `RFV-10` predição explicável | ✅ Antecipar Onda 4 → **Onda 3** |
| 3 | Modelo estatístico de churn | ⏸️ Reavaliar após um ciclo, com medição |
| 4 | `TSK-08` Fila do Dia | ⬆️ **É a prioridade real.** Sem ela, previsão é relatório |
| 5 | Material comercial | Nomear "perfil unificado" na comparação com CDP |
