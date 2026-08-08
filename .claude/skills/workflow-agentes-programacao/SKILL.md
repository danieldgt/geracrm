---
name: workflow-agentes-programacao
description: >
  Orquestrar agentes de IA para trabalho de programação: decompor a tarefa em raias independentes,
  briefar cada agente com contexto suficiente, isolar o ambiente de cada um, verificar o resultado
  de forma adversarial e integrar sem conflito. Use quando for preciso paralelizar implementação
  entre agentes, revisar código gerado por agente, definir como um time trabalha com IA, ou quando
  o usuário pedir para "rodar vários agentes", "paralelizar", "dividir entre agentes" ou
  "montar o fluxo de desenvolvimento com IA".
---

# Workflow de agentes de programação

Agente não é desenvolvedor mais rápido — é desenvolvedor **sem memória entre sessões, com
contexto limitado e viés de agradar**. O workflow existe para compensar exatamente essas três
características.

## Quando paralelizar (e quando não)

| Paralelize | Não paralelize |
|---|---|
| Tarefas que tocam arquivos diferentes | Trabalho no mesmo arquivo |
| Trabalho repetitivo em muitos alvos (migração, varredura) | Tarefa que exige decisão de arquitetura |
| Investigação por ângulos independentes | Cadeia onde cada passo depende do anterior |
| Revisão sob perspectivas distintas | Tarefa que cabe em 20 minutos |

⚠️ **Paralelizar tarefa acoplada produz conflito e retrabalho maior que o ganho.** O custo de
integrar duas soluções divergentes supera o de fazer em sequência.

## Decompor em raias

Uma raia é um pacote com **fronteira de arquivo clara**. Antes de despachar, escreva:

```
RAIA        Efetivação de pedido
ARQUIVOS    dominio/pedido/**, casos-de-uso/efetivar-pedido/**
NÃO TOCAR   adaptadores/erp/**  (outra raia)
CONTRATO    usa a porta EstoqueConsultavel — não a implemente
PRONTO      cenários BDD de PED-05 e PED-08 passando
```

**Se duas raias listam o mesmo arquivo, elas são uma raia só.**

## Briefing de agente

Agente com briefing ruim produz código plausível e errado. Um bom briefing tem cinco partes:

1. **Objetivo em uma frase** — o resultado de negócio, não a tarefa técnica
2. **Contexto necessário** — que arquivos ler primeiro, qual documento manda
3. **Fronteira** — o que ele pode tocar e o que é de outro
4. **Contrato** — interfaces que ele consome e não deve alterar
5. **Definição de pronto** — teste que precisa passar, verificação que precisa rodar

⚠️ **"Implemente a funcionalidade X" não é briefing.** O agente vai inventar o que faltou, e a
invenção parece razoável até alguém ler com atenção.

⚠️ **Aponte o documento que manda.** Se existem requisitos escritos, o briefing referencia o ID
(`PED-08`), não parafraseia. Paráfrase perde detalhe e cria uma segunda fonte de verdade.

## Isolamento

Agentes que escrevem em paralelo precisam de ambientes separados — worktree, branch ou cópia.
Sem isso, um sobrescreve o trabalho do outro sem que ninguém perceba.

Regras:
- Um agente, um ambiente, uma raia
- Integração é feita por quem orquestra, não pelo agente
- ⚠️ **Nunca deixe dois agentes com permissão de escrita no mesmo diretório de trabalho**

## Verificação adversarial

A parte mais importante, e a mais pulada.

**Agente tende a concordar consigo mesmo.** Pedir "verifique se está correto" produz confirmação,
não verificação. O que funciona:

| Técnica | Como |
|---|---|
| **Refutação** | Peça para **tentar provar que está errado**, não para confirmar. "Encontre o caso onde isso falha" |
| **Perspectivas distintas** | Revisores com lentes diferentes: correção, segurança, desempenho, "isso reproduz mesmo?" |
| **Voto** | Vários revisores independentes; só sobrevive o que a maioria não conseguiu derrubar |
| **Verificação por execução** | Teste que roda vale mais que qualquer opinião. Se dá para executar, execute |

⚠️ **Achado não verificado não é achado.** Agente produz problemas plausíveis que não existem
com a mesma facilidade com que encontra os reais.

## Revisar código gerado por agente

Onde os defeitos se concentram — verifique nesta ordem:

1. **Requisito silenciosamente reduzido** — pediu tratamento de 5 erros, implementou 2 e não
   avisou. É o defeito mais comum e o mais invisível
2. **Caminho de erro** — o caminho feliz costuma estar certo; o de falha, inventado
3. **Invenção de contrato** — chamou um método que não existe, ou mudou a assinatura de uma porta
4. **Teste que não testa** — passa mas não exercita a regra; ou foi ajustado para caber no código
5. **Regra de negócio vazando de camada** — validação no controller, SQL no caso de uso
6. **Escopo excedido** — refatorou o que ninguém pediu, misturando mudança de comportamento com
   arrumação

⚠️ **Teste ajustado para passar é pior do que teste ausente**, porque cria confiança falsa.
Se o agente alterou um teste existente, entenda por quê antes de aceitar.

## Integração

```
1. Cada raia entrega com seus testes verdes, isoladamente
2. Quem orquestra integra uma raia por vez
3. Suíte completa roda a cada integração
4. Conflito é resolvido por quem orquestra, com contexto das duas raias
5. Nenhuma raia entra sem revisão adversarial
```

⚠️ **Não integre tudo de uma vez no fim.** Se cinco raias entram juntas e a suíte quebra, você
não sabe qual causou.

## O que nunca delegar

- **Decisão de arquitetura** — o agente escolhe o que parece comum, não o que serve ao caso
- **Escolha de dependência externa** — tende a sugerir a mais popular, sem avaliar manutenção
- **Modelagem de domínio** — exige entender o negócio, não reconhecer padrão
- **Resolução de contradição em requisito** — ele escolhe uma leitura e segue, sem avisar que
  havia duas
- **Ação destrutiva ou irreversível** — migração que apaga dado, deploy, envio para cliente

## Ciclo saudável

```
orquestrador decompõe  →  agentes executam em paralelo, isolados
        ↑                              ↓
integração incremental  ←  verificação adversarial
```

O orquestrador — pessoa ou agente — mantém o **modelo mental do todo**. Nenhum agente de raia
tem essa visão, e não deveria ter: é o que permite que trabalhem em paralelo.

## Checklist antes de despachar

- □ Cada raia tem fronteira de arquivo sem sobreposição
- □ Cada briefing tem objetivo, contexto, fronteira, contrato e definição de pronto
- □ Cada briefing aponta o ID do requisito, sem parafrasear
- □ Cada agente tem ambiente isolado
- □ A verificação é adversarial, não confirmatória
- □ Nada da lista "nunca delegar" foi delegado

## Relacionado

`quadro-agentes-paralelos` — quando o trabalho vem de um board de tarefas.
`tdd` · `bdd` — a definição de pronto de uma raia é sempre um teste que roda.
