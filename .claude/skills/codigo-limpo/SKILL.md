---
name: codigo-limpo
description: >
  Escrever e revisar código no nível micro: nomes, tamanho e responsabilidade de função, fluxo de
  controle, tratamento de erro, comentários, duplicação vs. acoplamento, complexidade, code smells
  e refatoração segura. Use ao escrever qualquer código novo, ao revisar código (humano ou de
  agente), quando um arquivo ficar difícil de ler, ou quando surgir dúvida sobre extrair função,
  nomear conceito ou tratar erro.
---

# Código limpo

`arquitetura-limpa` trata de **onde o código mora**. Esta skill trata de **como ele é escrito**.
Regras específicas do GeraCRM ficam em `geracrm-arquitetura`.

O critério final é sempre o mesmo: **quanto tempo alguém leva para entender isso daqui a seis
meses, sem contexto?** Código é lido muitas vezes mais do que escrito.

## Nomes

O nome carrega o conceito. Nome ruim é dívida que se paga em toda leitura.

| Regra | ❌ | ✅ |
|---|---|---|
| Diga o que é, não o tipo | `listaStr`, `dataObj` | `telefonesNormalizados` |
| Revele a intenção | `processar(x)` | `qualificarLead(contato)` |
| Sem abreviação inventada | `calcVlrTotPed` | `calcularValorTotalDoPedido` |
| Booleano faz pergunta | `status`, `flag` | `estaNaJanelaDe24h`, `temSaldoSuficiente` |
| Assimetria proposital | `min` e `maximo` | `minimo` e `maximo` |
| Unidade no nome quando há ambiguidade | `prazo`, `valor` | `prazoEmDias`, `valorEmCentavos` |

⚠️ **Se o nome precisa de comentário para ser entendido, o nome está errado.** Corrija o nome, não
adicione o comentário.

⚠️ **Nome do domínio vem do negócio, não do código.** Se o negócio diz "efetivar pedido", a função
não se chama `commitOrder`. Divergência entre a fala do cliente e o código é onde alguém traduz
errado (regra da linguagem ubíqua — ver `bdd`).

## Funções

**Uma função faz uma coisa.** Teste prático: descreva-a em uma frase. Se a frase precisar de "e"
ou "então", são duas funções.

- **Tamanho é sintoma, não regra.** Não conte linhas; conte **níveis de abstração**. Função que
  mistura "validar regra de negócio" com "montar string de log" opera em dois níveis.
- **Argumentos**: até dois é confortável, três já pede atenção, quatro quase sempre pede um objeto
  nomeado. ⚠️ Argumento booleano é quase sempre duas funções escondidas —
  `enviar(mensagem, true)` no ponto de chamada não diz nada.
- **Sem efeito colateral escondido.** Se o nome diz `validar`, não pode gravar. Se diz `buscar`,
  não pode alterar.
- **Retorno único de significado.** Função que às vezes devolve o objeto, às vezes `null`, às
  vezes lança — obriga quem chama a lidar com três mundos.

## Fluxo de controle

**Aninhamento profundo é o smell mais fácil de corrigir e o mais tolerado.**

```ts
// ❌ a regra fica enterrada
if (contato) {
  if (contato.recebeCampanhas) {
    if (janela.estaAberta) {
      // ...
    }
  }
}

// ✅ guard clauses: as recusas primeiro, a regra no nível raso
if (!contato) return Recusa.contatoInexistente()
if (!contato.recebeCampanhas) return Recusa.optOut()
if (!janela.estaAberta) return Recusa.foraDaJanela()
// ...
```

- **Saia cedo.** Trate os casos de recusa no topo e deixe o caminho principal sem indentação.
- ⚠️ **`else` depois de `return` é ruído** — remova.
- Condição composta com três ou mais termos vira função com nome:
  `podeReceberCampanha(contato, janela)`.

## Tratamento de erro

**Distinga os dois tipos.** Confundi-los é a causa nº 1 de erro genérico na tela do usuário.

| Tipo | Exemplo | Como tratar |
|---|---|---|
| **Falha de negócio** | Estoque insuficiente, crédito bloqueado, fora da janela | **Retorno tipificado** — é resultado esperado, a tela precisa dele nomeado |
| **Falha excepcional** | Banco fora, rede caiu, bug | Exceção — ninguém previu, ninguém trata localmente |

```ts
// ❌ falha de negócio como exceção: quem chama não sabe o que capturar
throw new Error('Estoque insuficiente')

// ✅ resultado tipificado: a tela sabe exatamente o que mostrar e o que oferecer
return Falha.estoqueInsuficiente({ sku, solicitado, disponivel })
```

⚠️ **Nunca controle de fluxo por texto de mensagem** (`erro.message.includes('duplicate')`). A
mensagem muda numa atualização de biblioteca e o fluxo quebra em silêncio.

⚠️ **`catch` vazio ou que só loga é decisão implícita.** Ou trate, ou deixe subir. "Engolir" erro
transforma defeito em comportamento estranho sem rastro.

⚠️ **Erro que chega ao usuário nomeia o sistema e oferece ação.** "Falha ao processar" não ajuda
ninguém; "O GeraCloud não respondeu — tentar novamente" ajuda.

## Comentários

**Comentário explica o porquê, nunca o quê.** O código já diz o quê.

```ts
// ❌ repete o código
// incrementa o contador
contador++

// ✅ explica a decisão
// A Meta reenvia webhook que demora >5s. Respondemos antes de processar
// porque um evento lento trava a fila de todos os clientes.
```

Comentários que **valem ouro**: decisão contraintuitiva, workaround de bug externo com link,
invariante não óbvia, e o motivo de algo *não* ter sido feito do jeito esperado.

⚠️ **Comentário desatualizado é pior que nenhum** — ele mente com autoridade. Ao alterar o código,
releia os comentários ao redor.

⚠️ **Código comentado se apaga.** O histórico do git guarda; o arquivo não precisa.

## Duplicação vs. acoplamento

A regra "não repita" é a mais mal aplicada da profissão.

**Duplicação real** — o mesmo *conhecimento* em dois lugares; mudar um exige mudar o outro.
**Extraia.**

**Duplicação aparente** — código parecido por coincidência, servindo a razões diferentes.
⚠️ **Não extraia.** Você cria acoplamento entre coisas que deveriam evoluir separado, e a abstração
ganha um parâmetro booleano a cada divergência.

> Duplicação é mais barata que a abstração errada. Na dúvida, espere a terceira ocorrência.

## Complexidade

Sinais de que algo passou do ponto:

| Sinal | O que costuma significar |
|---|---|
| Precisa rolar a tela para entender a função | Faz coisas demais |
| Muitos `if` sobre o mesmo campo | Falta uma máquina de estados ou polimorfismo |
| Nome com "e" (`salvarEEnviar`) | Duas funções |
| Parâmetro que só serve a um caminho | Duas funções disfarçadas de uma |
| Comentário dividindo seções dentro da função | Cada seção é uma função |
| Precisa de mock demais para testar | Depende de coisas demais (ver `tdd`) |

## Code smells que aparecem sempre

- **Obsessão por primitivo** — `string` para telefone, CPF, e SKU. Vira objeto de valor com
  validação e normalização no construtor. Elimina uma classe inteira de bug.
- **Inveja de dados** — função que só manipula os campos de outro objeto. Ela pertence àquele
  objeto.
- **Número mágico** — `if (dias > 267)`. Vire constante nomeada ou configuração.
- **Cadeia de acesso** (`a.b.c.d.nome`) — acopla a três estruturas internas.
- **Flag temporal** — método que só pode ser chamado depois de outro, sem que o tipo diga isso.
- **Classe/módulo que só cresce** — quando todo requisito novo cai no mesmo arquivo, a fronteira
  está errada.

## Refatoração segura

1. **Teste verde antes.** ⚠️ Refatorar sem rede é reescrever no escuro — você não sabe o que está
   preservando.
2. **Um passo por vez**, com a suíte verde entre eles.
3. **Refatoração não muda comportamento.** Se o comportamento mudou, não foi refatoração — e o
   commit precisa dizer isso.
4. ⚠️ **Não misture refatoração com mudança de comportamento no mesmo commit.** Quem revisa não
   consegue separar o que é arrumação do que é risco.
5. **Código legado**: teste de caracterização primeiro (o que ele faz *hoje*, mesmo que errado),
   depois refatore, só então corrija.

## Ao revisar (inclusive código de agente)

Ordem de verificação — os defeitos se concentram nesta sequência:

1. **Requisito silenciosamente reduzido** — pediu tratamento de 5 erros, implementou 2 e não
   avisou. O mais comum e o mais invisível
2. **Caminho de erro** — o caminho feliz costuma estar certo; o de falha, inventado
3. **Nomes** — se você precisa ler o corpo para entender o nome, o nome falhou
4. **Efeito colateral que o nome não anuncia**
5. **Teste que não testa** — passa mas não exercita a regra; ou foi ajustado para caber no código
6. **Escopo excedido** — refatorou o que ninguém pediu, misturando arrumação com comportamento

## Checklist

- □ Todo nome revela intenção, sem precisar de comentário
- □ Nome de domínio bate com a fala do negócio
- □ Cada função faz uma coisa, num nível de abstração só
- □ Recusas tratadas no topo; caminho principal sem aninhamento
- □ Falha de negócio é retorno tipificado; exceção só para o excepcional
- □ Nenhum controle de fluxo por texto de mensagem
- □ Nenhum `catch` vazio
- □ Comentários explicam porquê; nenhum desatualizado; nenhum código comentado
- □ Duplicação extraída só quando é o mesmo conhecimento
- □ Refatoração separada de mudança de comportamento

## Relacionado

`arquitetura-limpa` (onde o código mora) · `geracrm-arquitetura` (regras deste projeto) ·
`tdd` (testabilidade como sinal de desenho) · `workflow-agentes-programacao` (revisão adversarial).
