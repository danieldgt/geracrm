---
name: tdd
description: >
  Praticar Test-Driven Development de forma disciplinada: ciclo red-green-refactor, o que testar
  e o que não testar, test doubles, testes de integração de fronteira, e como manter a suíte
  rápida e confiável ao longo do tempo. Use quando for escrever código novo com testes, discutir
  estratégia ou pirâmide de testes, resolver suíte lenta ou instável (flaky), ou quando o usuário
  pedir para "fazer TDD", "escrever os testes primeiro" ou "aumentar a cobertura".
---

# TDD

TDD não é sobre cobertura. É sobre **projetar a interface do código antes da implementação** e
manter a possibilidade de mudar sem medo.

## O ciclo

```
RED      escreva um teste que falha por um motivo que você consegue explicar
GREEN    escreva o código mais simples que faz passar — sim, o mais simples
REFACTOR melhore o desenho, com a suíte verde o tempo inteiro
```

**Regras que fazem o ciclo funcionar:**

1. **Nunca escreva teste que passa de primeira.** Se passou, ou o teste não testa nada, ou o
   código já existia. Veja o vermelho antes.
2. **Leia a mensagem de falha.** Ela precisa dizer o que quebrou. Se disser `expected true, got
   false`, o teste está mal escrito.
3. **Refatore só no verde.** Refatorar no vermelho é depurar duas coisas ao mesmo tempo.
4. **Um motivo de falha por teste.** Teste que falha por três motivos não diz qual deles ocorreu.

## O que testar

| Teste | Cobre | Proporção saudável |
|---|---|---|
| **Unidade** | Regra de negócio, invariante, cálculo, decisão | A maioria |
| **Caso de uso** | Orquestração com dependências falsas | Uma parte relevante |
| **Fronteira** | Adaptador contra o sistema externo real ou dublê fiel | Poucos, mas existem |
| **Ponta a ponta** | Fluxo crítico completo | Muito poucos — os que, se quebrarem, o negócio para |

⚠️ **A pirâmide não é dogma, mas a inversão é sintoma.** Suíte cheia de teste ponta a ponta e
vazia de unidade indica domínio que não é testável isoladamente — problema de arquitetura, não
de teste.

## O que NÃO testar

- **Getter, setter, mapeamento trivial** — testa a linguagem, não seu código
- **Framework** — o roteador HTTP já foi testado por quem o escreveu
- **Detalhe de implementação** — se o teste quebra ao renomear um método privado sem mudar
  comportamento, ele testa a implementação, não o contrato
- **Mock verificando mock** — teste que só confirma que um dublê foi chamado não prova nada

## Test doubles: escolha certa

| Tipo | Uso | ⚠️ |
|---|---|---|
| **Stub** | Devolve dado fixo para a entrada | Preferido na maioria dos casos |
| **Fake** | Implementação simples de verdade (repositório em memória) | O melhor para portas; força a porta a ser boa |
| **Mock** | Verifica que a interação aconteceu | Só quando **a interação é o comportamento** (ex.: "enviou a mensagem") |
| **Spy** | Registra chamadas para inspeção | Ok, com moderação |

**Regra:** quanto mais mocks, mais o teste conhece a implementação e mais frágil fica. Se um
teste precisa de cinco mocks, o código sob teste faz coisas demais.

## Nome do teste

O nome é documentação. Formato que funciona:

```
efetivar_pedido_abaixo_do_minimo_retorna_falha_com_quantidade_faltante
janela_fechada_rejeita_mensagem_livre_e_sugere_template
contato_com_optout_nao_recebe_campanha_nem_por_disparo_manual
```

⚠️ **`testPedido1`, `testShouldWork`, `test_ok`** — se o nome não diz a regra, o teste não
documenta nada e ninguém sabe se pode apagar.

## Estrutura: Arrange–Act–Assert, separados

```
// arrange
cliente com mínimo de 10 peças
pedido com 7 peças

// act
resultado = EfetivarPedido(pedido)

// assert
resultado é falha do tipo MinimoNaoAtingido
falha informa que faltam 3 peças
```

**Um Act por teste.** Dois Acts = dois testes.

## Suíte lenta e instável

Suíte lenta deixa de ser rodada; suíte instável deixa de ser acreditada. Ambas morrem.

| Sintoma | Causa comum | Correção |
|---|---|---|
| Lenta | Banco/rede em teste de unidade | Fake em memória atrás da porta |
| Instável (flaky) | Tempo real, ordem, concorrência, dado compartilhado | Injetar relógio; isolar estado por teste |
| Quebra em cascata | Teste acoplado à implementação | Testar pelo contrato |
| Ninguém confia | Teste que "às vezes falha" tolerado | ⚠️ Teste instável é **defeito**, conserta ou apaga |

⚠️ **Nunca tolere teste instável.** Um flaky tolerado ensina o time a ignorar vermelho, e aí a
suíte inteira perde valor.

## Cobertura

Cobertura é **termômetro, não meta**. Regras práticas:

- Cobertura baixa em regra de negócio é problema real
- Cobertura baixa em adaptador e código de entrega é aceitável
- Perseguir 100% produz teste de getter e cria a ilusão de segurança
- O que importa: **toda invariante do modelo tem pelo menos um teste que a viola e espera falha**

## TDD com código existente

Não tente cobrir tudo. Ordem:

1. Escreva um teste de caracterização — o que o código faz **hoje**, mesmo que errado
2. Refatore com a rede montada
3. Só então corrija o comportamento, agora com teste de verdade

⚠️ **Não refatore código legado sem teste.** Você não sabe o que está preservando.

## Checklist

- □ Vi o teste falhar antes de fazer passar
- □ A mensagem de falha explica o problema
- □ Um Act, um motivo de falha
- □ O nome descreve a regra
- □ Nenhum teste depende de relógio, ordem ou estado compartilhado
- □ Toda invariante tem teste que a viola
- □ Nenhum teste instável está tolerado

## Relacionado

`bdd` — para o nível de comportamento e linguagem de negócio.
`arquitetura-limpa` — testabilidade é consequência de arquitetura; se testar dói, o desenho está errado.
