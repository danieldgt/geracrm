---
name: bdd
description: >
  Praticar Behavior-Driven Development: descobrir regras por exemplos concretos, escrever cenários
  Gherkin que o negócio entende, manter linguagem ubíqua entre time e código, e ligar cenários a
  critérios de aceite e testes automatizados. Use quando for preciso "escrever cenários", "definir
  critérios de aceite testáveis", alinhar entendimento entre negócio e desenvolvimento, ou quando
  uma regra estiver ambígua e precisar ser esclarecida com exemplos antes de codificar.
---

# BDD

BDD não é "Cucumber". É **descobrir a regra conversando por exemplos concretos**, antes de
escrever código. A automação é consequência, não o objetivo.

## O maior valor está antes da ferramenta

A conversa de exemplos (*example mapping*) é onde as ambiguidades morrem. Junte quem conhece o
negócio, quem testa e quem programa, e para cada história pergunte:

```
REGRA      qual é a regra?
EXEMPLO    me dá um caso concreto onde ela vale
EXEMPLO    e um onde ela NÃO vale
DÚVIDA     o que ninguém aqui sabe responder?
```

⚠️ **Se a sessão termina sem nenhuma dúvida levantada, ela foi superficial.** Dúvida encontrada
na conversa custa minutos; encontrada em produção custa retrabalho e confiança.

⚠️ **Regra sem contraexemplo não foi entendida.** "O pedido precisa atingir o mínimo" — mínimo de
peças ou de valor? Conta grade fechada? Vale por categoria? Cada resposta é um exemplo.

## Estrutura do cenário

```gherkin
Funcionalidade: Efetivação de pedido assistido

  Regra: pedido abaixo do mínimo do cliente não é efetivado

    Cenário: pedido com peças insuficientes informa o que falta
      Dado que o cliente "Vest Fácil" tem pedido mínimo de 10 peças
      E a vendedora montou um pedido com 7 peças
      Quando ela tenta enviar o pedido
      Então o envio é bloqueado
      E a tela informa "faltam 3 peças"
      E o rascunho é preservado

    Cenário: pedido no limite exato é efetivado
      Dado que o cliente "Vest Fácil" tem pedido mínimo de 10 peças
      E a vendedora montou um pedido com 10 peças
      Quando ela tenta enviar o pedido
      Então o pedido é efetivado
      E recebe um número do ERP
```

## Regras de escrita

| Faça | Não faça |
|---|---|
| Linguagem do negócio | Linguagem de implementação |
| `Quando ela envia o pedido` | `Quando POST /api/pedidos retorna 201` |
| Um comportamento por cenário | Cenário com 5 `Quando` encadeados |
| Dados concretos e reais | `Dado um cliente qualquer` |
| Cenário legível por quem não programa | Cenário que só o dev entende |

⚠️ **O cenário que fala de botão, endpoint ou tabela envelhece a cada refatoração.** Descreva
**o que acontece**, não *como* é feito. `Então o envio é bloqueado` sobrevive a uma reescrita da
interface; `Então o botão fica cinza` não.

## Dado / Quando / Então

| Palavra | Papel | Erro comum |
|---|---|---|
| **Dado** | Contexto que já existe | Colocar ação nele |
| **Quando** | **A** ação sob teste — exatamente uma | Encadear várias ações |
| **Então** | Resultado observável | Verificar estado interno que o usuário não vê |

Se você precisa de dois `Quando`, provavelmente há dois cenários — ou o primeiro `Quando` era, na
verdade, contexto (`Dado`).

## Exemplos em tabela

Para a mesma regra com vários dados, use tabela em vez de repetir cenário:

```gherkin
    Esquema do Cenário: janela de 24h define o que pode ser enviado
      Dado que a última mensagem do cliente foi há <horas> horas
      Quando a vendedora abre a conversa
      Então o composer está em modo "<modo>"

      Exemplos:
        | horas | modo         |
        | 0     | livre        |
        | 23    | livre        |
        | 24    | só template  |
        | 72    | só template  |
```

**Inclua sempre a fronteira.** `23` e `24` valem mais que `1` e `100` — o defeito mora na borda.

## Ligação com o resto

```
requisito (PED-05)
   └─ regra de negócio
        └─ cenários BDD  ← critério de aceite executável
             └─ testes de unidade (TDD)  ← detalhe de implementação
```

**O cenário BDD É o critério de aceite.** Não escreva os dois separados — vira duplicação que
desatualiza.

**Invariante do modelo vira cenário.** Cada `INV-xx` de `modelar-dados` precisa de pelo menos um
cenário que tenta violá-la e espera falha:

```gherkin
    Cenário: contato com opt-out não recebe campanha nem por disparo manual
      Dado que o contato "Saturno" desativou o recebimento de campanhas
      Quando o gestor dispara uma campanha para toda a base
      Então "Saturno" não recebe a mensagem
      E o relatório da campanha o registra como "bloqueado por opt-out"
```

## Quantos cenários

- **Regra de negócio:** todos os caminhos relevantes, incluindo as bordas
- **Fluxo crítico do usuário:** um cenário fim a fim
- **Variação de dado:** tabela, não cenários repetidos
- **Detalhe técnico:** não vira cenário — vira teste de unidade

⚠️ **Suíte BDD gigante fica lenta e ninguém roda.** BDD cobre **comportamento de negócio**;
o resto é TDD, que é mais rápido e mais barato.

## Linguagem ubíqua

Os termos dos cenários precisam ser os mesmos do código, do modelo de dados e da conversa com o
cliente. Se o negócio diz "efetivar pedido", o código não pode chamar `commitOrder()`.

Mantenha um **glossário** e trate divergência como defeito. Quando negócio e código falam línguas
diferentes, toda tradução perde informação — e alguém traduz errado.

## Checklist

- □ Cada regra tem exemplo positivo e negativo
- □ As dúvidas da sessão foram registradas e respondidas
- □ Nenhum cenário menciona botão, endpoint ou tabela
- □ Um `Quando` por cenário
- □ As fronteiras estão nos exemplos
- □ Toda invariante do modelo tem cenário que a viola
- □ Os termos batem com o glossário do domínio

## Relacionado

`tdd` — o nível abaixo. `especificar-requisitos` — o cenário é o critério de aceite.
`modelar-dados` — invariantes viram cenários.
