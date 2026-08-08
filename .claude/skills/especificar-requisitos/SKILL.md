---
name: especificar-requisitos
description: >
  Transformar material bruto de descoberta em requisitos testáveis: épicos, histórias, critérios
  de aceite, regras de negócio, requisitos não-funcionais, IDs rastreáveis e organização em ondas
  de entrega. Use quando existir levantamento pronto e for preciso "definir os requisitos",
  "montar o backlog", "escrever as histórias", "criar os épicos", "priorizar o que fazer",
  ou quando um requisito existente estiver vago demais para ser implementado ou testado.
---

# Especificação de requisitos

Requisito sem **critério de aceite** não é requisito — é desejo. Requisito sem **ID** não é
rastreável. Requisito sem **origem** não é priorizável.

## Anatomia de um requisito completo

```
ID          PED-08
Título      Tratamento de falha na efetivação do pedido
Origem      Levantamento §2.4 — 5 erros observados no ERP de referência
Módulo      PED — Pedido assistido
Onda        2
Descrição   Quando a efetivação no ERP falha, o rascunho é preservado e o erro
            é apresentado de forma tipificada, com ação corretiva na própria tela.
Critérios   □ Rascunho permanece intacto e editável após qualquer falha
            □ Erro de estoque nomeia o SKU e o saldo disponível
            □ Erro de crédito mostra valor do pedido e limite disponível
            □ Reenvio após falha de comunicação não duplica pedido
            □ Nenhum erro é apresentado como texto genérico do ERP
Depende de  PED-06 (rascunho persistente), INT-01c (escrita idempotente)
```

## Sistema de IDs

Prefixo de módulo + número sequencial: `PED-08`, `INB-04`, `RFV-11`.

**Regras:**
- ID nunca é reciclado. Item removido deixa o número vago
- ID atravessa todas as etapas: requisito → entidade → estado de tela → caso de uso → cenário BDD
- Prefixo é do **módulo funcional**, não da tela nem da tabela

⚠️ **Não use numeração por ordem de prioridade.** A prioridade muda; o ID não pode mudar junto.

## Épico, história e tarefa

| Nível | Responde | Tamanho |
|---|---|---|
| **Épico** | Que capacidade o produto ganha? | Semanas; agrupa 5–20 requisitos |
| **História** | Que resultado o usuário obtém? | Dias; cabe numa entrega verificável |
| **Tarefa** | Que trabalho técnico é feito? | Horas; só existe depois da arquitetura |

Formato de história que funciona:

```
Como [papel específico, não "usuário"]
quero [ação concreta]
para [resultado mensurável no trabalho dele]
```

⚠️ **"Como usuário, quero ver os dados, para tomar decisão"** é história vazia. Papel genérico,
ação genérica, resultado genérico. Não dá para testar nem para cortar escopo.

## Critérios de aceite

Escreva no formato **verificável por observação**, não por intenção:

| ❌ Ruim | ✅ Bom |
|---|---|
| "A busca deve ser rápida" | "Resultado em até 500ms para base de 50 mil contatos" |
| "Deve funcionar bem no mobile" | "A grade de tamanhos é operável com o polegar em tela de 375px" |
| "Tratar erros adequadamente" | "Cada um dos 5 erros do ERP tem mensagem própria e ação corretiva" |
| "O usuário deve entender o custo" | "O custo estimado aparece antes do botão de envio, não depois" |

## Requisitos não-funcionais — extraia dos números

RNF não se inventa; se **deriva do volume real** levantado na descoberta:

| Número observado | RNF derivado |
|---|---|
| Coluna de kanban com 11.358 cards | Carregamento sob demanda; nunca carregar coluna inteira |
| 6.079 contatos por número, 8 números | Busca precisa rodar no servidor, com índice |
| Vendedora com a tela aberta o dia inteiro | Atualização em tempo real, não polling |
| Pedido montado em showroom sem sinal | Operação offline com fila de sincronização |

⚠️ **RNF genérico ("deve ser escalável") não serve para nada.** Se não tem número, não é requisito.

## Organização em ondas

Ondas ≠ sprints. Onda é **um estado do produto**, com critério de saída verificável.

```
Onda 0  Fundação   → os dados entram e o canal funciona
Onda 1  Operar     → o usuário larga a ferramenta antiga
Onda 2  Vender     → o produto pode ser cobrado
Onda 3  Escalar    → aguenta volume e cobre o mercado
Onda 4  Diferenciar→ sai da comparação por preço
```

**Critério de saída precisa ser observável:** não "MVP pronto", mas "a equipe operou 2 semanas
sem o sistema antigo".

## Dependências que não podem ser invertidas

Mapeie explicitamente. Exemplos de dependência real:

- Análise de comportamento depende de **carga histórica** — sem histórico, nasce vazia
- Campanha segmentada depende de **segmentação pronta** — senão vira disparo para todos
- Atribuição de receita depende de **latência do dado de venda** — se o pedido chega dias
  depois, a métrica de "3 dias" está errada por construção

⚠️ Dependência descoberta tarde é a causa nº 1 de onda que não fecha.

## Marcação de origem

Todo requisito carrega de onde veio. Sugestão de legenda:

```
[REF]  Sistema de referência analisado    [ENT]  Entrevista
[CONC] Concorrente                        [LEI]  Exigência legal/regulatória
[DONO] Decisão do dono do produto         [★]    Diferencial proposto por nós
```

Isso permite responder, em qualquer momento: *"este item existe porque…"*. E permite cortar
escopo com critério — cortar `[★]` é decisão estratégica; cortar `[LEI]` não é opção.

## Antes de fechar o backlog

Checklist:

- □ Todo item tem ID, origem, onda e critério de aceite
- □ Todo RNF tem número
- □ Toda dependência crítica está mapeada
- □ Toda onda tem critério de saída observável
- □ Nenhum item diz "melhorar", "otimizar" ou "adequar" sem dizer para quanto
- □ Contradições entre itens foram resolvidas, não empilhadas

⚠️ **Contradição empilhada é dívida disfarçada.** Se um item diz "o pedido vive no ERP" e outro
diz "montar pedido no app", os dois não podem ficar no backlog. Resolva antes.

## Próxima etapa

Backlog fechado → `modelar-dados` (etapa 3) e `especificar-telas` (etapa 4), em paralelo.
