---
name: levantar-requisitos
description: >
  Conduzir descoberta de requisitos: entrevista com usuário, análise de sistema existente ou
  concorrente a partir de capturas de tela, mapeamento do processo real de trabalho e extração
  de regras de negócio implícitas. Produz material bruto organizado e rastreável, não backlog.
  Use quando o usuário fornecer prints de um sistema, gravação de reunião, descrição de processo,
  pedir para "entender como funciona hoje", "analisar esse sistema", "levantar o que precisa ter",
  ou quando for preciso descobrir o que construir antes de escrever qualquer requisito.
---

# Levantamento de requisitos

Descoberta produz **evidência**, não opinião. Todo item levantado precisa apontar para uma fonte
verificável: uma tela, uma frase dita, um documento, um número.

## Quatro fontes, em ordem de confiabilidade

| Fonte | Confiabilidade | O que revela |
|---|---|---|
| **Sistema em uso** (telas, dados reais) | Alta | O que a operação realmente faz, incluindo o que ninguém conta |
| **Observação do trabalho** | Alta | Atalhos, planilhas paralelas, retrabalho — a verdade operacional |
| **Entrevista** | Média | Intenção, dor percebida, prioridade — mas enviesada |
| **Concorrente** | Média | O que o mercado já normalizou; o que é tabela de entrada |

⚠️ **O que o usuário diz que faz e o que ele faz divergem.** Não por má-fé — ele descreve o
processo ideal, não o real. Sempre que possível, confirme com dado ou tela.

## Analisar um sistema a partir de capturas

Este é o caso mais rico e o mais mal aproveitado. Método:

### 1. Extraia o mapa de navegação primeiro

Antes de olhar qualquer tela em detalhe, monte a **árvore de menus completa**. Ela revela a
arquitetura mental do produto: o que é módulo, o que é sub-item, o que está agrupado com o quê.

Registre também os **badges nos itens de menu** — `NOVO`, `BETA`, cadeado, selo de integração.
Eles contam a estratégia: o que é recente, o que é upsell, o que depende de terceiro.

### 2. Por tela, catalogue em quatro camadas

| Camada | O que capturar |
|---|---|
| **Estrutura** | Regiões, colunas, hierarquia visual |
| **Elementos** | Filtros, colunas de tabela, botões, badges, estados |
| **Dados** | Que campos existem, com que formato, com que valores reais |
| **Regra implícita** | O que a tela revela sobre o negócio sem dizer |

A quarta camada é a que importa. Exemplos de leitura:

- Coluna "Vendas 3d / 7d / 14d" numa tabela de campanha → o negócio atribui receita por
  **janela temporal**, e escolheu três janelas. Isso é uma decisão de produto, não um detalhe.
- Badge "está no telefone: Janaina, Mari" na ficha do cliente → o mesmo contato existe em
  **vários números** e o sistema precisa reconciliar identidade.
- Aviso de custo antes de enviar template → o negócio **paga por mensagem** e decidiu educar o
  usuário no clique em vez de deixar descobrir na fatura.

### 3. Anote os números reais

Volumes das capturas são requisito não-funcional disfarçado: "11.358 leads" numa coluna de
kanban diz que a coluna **não pode carregar inteira**. "6.079 contatos" por número diz o
tamanho da frota. Guarde todos.

### 4. Registre o que está ausente

Tão importante quanto o que existe. Se não há tela de SLA, de setores, de builder de fluxo —
ou o produto não faz, ou faz por outro caminho. Ambos são achados.

## Conduzir entrevista

Cinco perguntas que produzem mais que trinta genéricas:

1. **"Me mostra como você faz isso hoje"** — peça a tela, não a descrição
2. **"O que você faz quando dá errado?"** — o caminho de exceção é onde mora a complexidade
3. **"O que você faz fora do sistema?"** — planilha paralela, caderno, grupo de WhatsApp
4. **"Quanto tempo isso leva?"** e **"quantas vezes por dia?"** — prioriza melhor que qualquer nota
5. **"Se você pudesse apagar uma parte do seu dia, qual seria?"** — dor real, não desejo de feature

⚠️ **Nunca pergunte "que funcionalidade você quer".** A resposta vem em forma de solução mal
desenhada e você perde o problema original.

## Organizar o material bruto

Saída da descoberta é um documento com esta estrutura:

```
1. Contexto      — quem é o usuário, qual o negócio, qual o volume
2. Mapa          — navegação/processo completo
3. Inventário    — por módulo ou etapa, o que existe, em detalhe
4. Regras        — o que foi inferido, com a evidência de cada inferência
5. Números       — volumes, tempos, frequências
6. Ausências     — o que não existe e por que isso importa
7. Fontes        — de onde veio cada coisa
```

**Cada item precisa de origem citável.** Sem isso, na etapa de priorização ninguém sabe se um
item veio do dono do negócio ou de um palpite.

## Erros que se repetem

⚠️ **Traduzir tela em requisito direto.** "A tela tem um botão exportar" não é requisito. O
requisito é "o gestor precisa levar a carteira para uma reunião fora do sistema". Descubra o
*porquê* antes de fixar o *como*.

⚠️ **Ignorar o rodapé e os estados vazios.** Mensagem de estado vazio, texto de ajuda e aviso
de erro são onde o produto explica as próprias regras.

⚠️ **Analisar concorrente só pelo site.** O marketing mostra o que vende, não o que o produto
faz. Capturas de tela e documentação de API valem dez landing pages.

⚠️ **Parar quando parece suficiente.** Descoberta termina quando você consegue **descrever o dia
de trabalho do usuário do começo ao fim sem inventar nenhum passo.**

## Próxima etapa

Material bruto organizado → `especificar-requisitos`.
Se for análise de mercado, use `analise-competitiva` em paralelo.
