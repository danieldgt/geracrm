---
name: workflow-produto
description: >
  Orquestra a trilha completa de construção de um produto de software, do zero à stack:
  descoberta → requisitos → modelo de dados → telas → arquitetura → testes → implementação.
  Diz qual etapa vem agora, qual skill usar em cada uma e qual artefato precisa existir antes
  de avançar. Use quando o usuário pedir para "começar um projeto", "estruturar o produto",
  "definir o que vamos construir", perguntar "qual o próximo passo", ou quando o trabalho
  estiver pulando etapas (ex.: escolher banco de dados antes de existir modelo de dados).
---

# Workflow de produto — do zero à stack

Trilha de sete etapas. Cada uma **produz um artefato** que a seguinte consome. Pular etapa
não acelera: empurra a decisão para um momento em que ela custa mais caro.

## A trilha

```
1. DESCOBERTA        → material bruto organizado      [levantar-requisitos]
2. REQUISITOS        → backlog com IDs e critérios    [especificar-requisitos]
3. DOMÍNIO           → modelo de dados e invariantes  [modelar-dados]
4. INTERFACE         → telas, estados, transições     [especificar-telas]
5. ARQUITETURA       → camadas e limites              [arquitetura-limpa]
6. QUALIDADE         → estratégia de teste            [tdd] [bdd]
7. STACK             → tecnologia e infraestrutura    ← só aqui
```

**Regra de ouro:** a stack é a **última** decisão, não a primeira. Ela responde às exigências
que as etapas 3–6 revelaram. Escolher tecnologia antes disso é escolher a resposta antes de
conhecer a pergunta.

## Quando cada etapa está pronta

| Etapa | Pronta quando… | ⚠️ Armadilha |
|---|---|---|
| 1. Descoberta | Você consegue descrever o dia de trabalho do usuário sem inventar nada | Parar na primeira entrevista. O que o usuário *diz* que faz e o que ele *faz* divergem |
| 2. Requisitos | Todo item tem ID, critério de aceite e origem rastreável | Requisito sem critério de aceite não é requisito, é desejo |
| 3. Domínio | As invariantes do negócio estão escritas e você sabe quem as protege | Modelar tabela em vez de conceito. Tabela vem depois |
| 4. Interface | Cada tela tem os 5 estados definidos e as transições entre eles | Especificar só o caminho feliz. O erro é onde o produto morre |
| 5. Arquitetura | Você sabe onde cada tipo de código mora e por que | Desenhar camadas sem um caso de uso concreto atravessando todas |
| 6. Qualidade | Existe pelo menos um cenário BDD por regra de negócio | Deixar teste para depois da stack. A testabilidade é requisito de arquitetura |
| 7. Stack | Cada escolha aponta para uma exigência das etapas 3–6 | Escolher por familiaridade e justificar depois |

## Como conduzir

### Antes de começar qualquer etapa

Pergunte-se: **qual artefato da etapa anterior estou usando?** Se a resposta for "nenhum",
você está pulando etapa. Volte.

### Ao terminar uma etapa

Escreva o artefato em arquivo, com **IDs estáveis**. IDs são o que costura as etapas:
o requisito `PED-08` vira entidade no modelo, estado na tela, caso de uso na arquitetura e
cenário no BDD. Sem ID, a rastreabilidade se perde e ninguém sabe se algo foi implementado.

### Iteração é esperada, retrabalho não

A trilha **não é cascata**. Descobrir na etapa 4 que falta um requisito é normal — volte,
adicione com ID, siga. O que não pode é chegar na etapa 7 e descobrir que a etapa 2 nunca
aconteceu.

## Ondas de implementação

Depois da etapa 7, o backlog vira **ondas**, nunca um cronograma linear:

| Onda | Pergunta que responde |
|---|---|
| 0 — Fundação | Os dados entram e o canal funciona? |
| 1 — Operar | O usuário consegue largar a ferramenta antiga? |
| 2 — Vender | O produto já pode ser cobrado? |
| 3 — Escalar | Aguenta volume e cobre o mercado? |
| 4 — Diferenciar | O que nos tira da comparação por preço? |

Cada onda precisa de um **critério de saída verificável** — não "está pronto", mas
"a equipe operou 2 semanas sem o sistema antigo".

## Erros que se repetem

⚠️ **Definir stack cedo para "destravar o time".** O time fica ocupado, não produtivo.
Código escrito sobre requisito inexistente é retrabalho garantido.

⚠️ **Confundir inventário com especificação.** Listar "a tela tem busca e filtro" é inventário.
Especificação diz o que a busca busca, onde executa, o que mostra quando não acha nada e o
que acontece com o filtro anterior.

⚠️ **Backlog sem origem.** Todo item precisa apontar de onde veio: entrevista, concorrente,
regra legal, decisão do dono. Item órfão é o primeiro a ser cortado errado.

⚠️ **Pular a etapa 3 porque "é CRUD".** Não existe CRUD. Existe domínio mal compreendido,
que parece CRUD até a primeira regra de negócio aparecer.

## Skills da trilha

| Skill | Etapa |
|---|---|
| `levantar-requisitos` | 1 |
| `especificar-requisitos` | 2 |
| `modelar-dados` | 3 |
| `especificar-telas` | 4 |
| `arquitetura-limpa` | 5 |
| `tdd` · `bdd` | 6 |
| `analise-competitiva` | apoio a 1 e 2 |
| `funil-de-vendas` | domínio comercial (apoio a 2 e 3) |
