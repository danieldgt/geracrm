---
name: funil-de-vendas
description: >
  Modelar funil de vendas e relacionamento em software: escolher o eixo do funil, definir estágios,
  segmentação RFV, ciclo de vida do cliente, carteirização, métricas de conversão e atribuição de
  receita. Use quando for preciso desenhar funil, kanban de vendas, estágios de negociação,
  segmentação de base, régua de recompra, ou quando aparecerem termos como lead, oportunidade,
  pipeline, RFV, churn, recompra, carteira, atribuição ou ROI de campanha.
---

# Funil de vendas em software

O erro que define o resto: **copiar o funil de negociação B2B para um negócio de venda recorrente.**
São modelos diferentes, e o eixo errado torna o produto inútil para o vendedor.

## Escolha o eixo do funil

| Eixo | Estágios típicos | Quando serve | Quando falha |
|---|---|---|---|
| **Negociação** | Prospecção → Proposta → Negociação → Fechamento | Venda complexa, ciclo longo, ticket alto, poucos clientes | Venda recorrente: o cliente compra todo mês, não "fecha" |
| **Relacionamento** | Lead → 1º pedido → 2 pedidos → 3+ pedidos → Recorrente | Venda recorrente, atacado, distribuição, B2B de reposição | Venda única de ticket alto |
| **Ciclo de vida** | Novo → Ativo → Em risco → Inativo → Perdido | Base grande, foco em retenção | Aquisição pura |

⚠️ **Em negócio recorrente, os três coexistem.** Funil de negociação para o lead novo; funil de
relacionamento para o cliente que já comprou; ciclo de vida rodando por baixo, sempre. Modelar só
um dos três deixa buraco.

## Estágios: regras que evitam funil inútil

1. **Estágio precisa ter critério objetivo de entrada.** "Qualificado" definido por sensação
   produz funil que ninguém confia. Defina: *qualificado = respondeu + informou CNPJ + tem
   interesse declarado*
2. **Máximo 5–7 estágios.** Mais que isso, o vendedor não move os cards e o funil apodrece
3. **Todo estágio precisa de saída** — inclusive a de perda, com motivo obrigatório e catálogo
   de motivos
4. **Tempo em estágio é métrica de primeira classe.** Card parado há 30 dias num estágio é o
   sinal mais acionável do funil
5. ⚠️ **Estágio que ninguém usa é ruído.** Se 90% dos cards pulam de A para C, B não existe

## RFV — segmentação por comportamento de compra

RFV classifica o cliente por três eixos, com dados que **já existem** no histórico de venda —
sem pesquisa, sem formulário:

| Eixo | Pergunta | Sinal |
|---|---|---|
| **Recência** | Há quanto tempo comprou? | O mais preditivo dos três |
| **Frequência** | Quantas vezes compra? | Mede hábito |
| **Valor** | Quanto gasta? | Mede tamanho |

**Faixas típicas** (11 segmentos, do melhor ao pior):

```
Campeão · Cliente Fiel · Potencial Fiel · Cliente Promissor · Cliente Recente
Não Perder · Em Risco · Precisa de Atenção · Semi Perdido · Hibernando · Perdido
```

**O que importa mais que a foto: a trajetória.** Um cliente que era Campeão e virou Em Risco é um
problema urgente; um que sempre foi Em Risco é outro tipo de trabalho. Guarde o **histórico de
segmento** ao longo do tempo, não só o valor atual.

⚠️ **Recência isolada engana.** "60 dias sem comprar" significa coisas opostas para quem compra
a cada 30 dias e para quem compra a cada 180. Compare sempre com a **média entre compras daquele
cliente** — é essa razão que indica atraso, não o número absoluto.

## Ciclo de vida: Ativo / Inativo / Perdido

Definição por **dias sem comprar**, e precisa ser **configurável por negócio** — o que é inativo
para uma confecção não é para uma revenda de máquinas.

```
Ativo    comprou dentro de N dias
Inativo  entre N e M dias
Perdido  mais de M dias
```

Configurar isso é decisão do dono do negócio, não do desenvolvedor. Deixe explícito na interface.

## Carteirização

Quem é o dono do cliente. Três decisões que precisam de resposta:

| Decisão | Opções |
|---|---|
| **Atribuição** | Manual · rodízio · por região · por porte · por afinidade de histórico |
| **Exclusividade** | Um dono só, ou dono + apoio? |
| **Órfãos** | Cliente sem dono aparece para todos ou para ninguém? |

⚠️ **Guarde o histórico de carteira** — quem foi dono, de quando a quando, e quem transferiu.
Sem isso, comissão vira discussão e ninguém consegue auditar.

## Métricas que valem

| Métrica | Cuidado |
|---|---|
| **Conversão por estágio** | Meça de A→B, não só topo→fundo. É onde o gargalo aparece |
| **Tempo médio em estágio** | Mais acionável que taxa de conversão |
| **Taxa de recompra** | A métrica central do recorrente |
| **Ticket médio** | Sempre com a mediana ao lado — um pedido gigante distorce a média |
| **Tempo até o 2º pedido** | O melhor preditor de retenção que existe em atacado |
| **Churn** | Precisa da definição de "perdido" fechada antes |

## Atribuição de receita

Onde quase todo CRM mente. Duas formas, e a diferença precisa ficar visível:

| Forma | Como funciona | Confiabilidade |
|---|---|---|
| **Exata** | O pedido nasceu vinculado à conversa/campanha/tarefa | Fato registrado |
| **Estimada por janela** | "Quem comprou em 3/7/14 dias depois de receber" | Correlação, não causa |

⚠️ **Nunca some as duas sem distinção.** Atribuição estimada infla o número e vira promessa que
o produto não sustenta. Exiba separado, com legenda.

⚠️ **Janela de atribuição precisa ser configurável e declarada.** "Vendas 7d" só significa algo
se estiver escrito o que é a janela e o que acontece quando o cliente recebeu duas campanhas no
período (primeira? última? divide?).

## Régua de relacionamento

Automatizar o toque com base no comportamento, não no calendário:

```
Pós-venda D+7          → verificar recebimento
Reposição em 0,8 × média entre compras do cliente  → oferecer antes de ele precisar
Cruzou para "Em Risco" → tarefa prioritária para o dono da carteira
Aniversário do 1º pedido → reconhecimento
```

⚠️ **Régua por calendário fixo ignora o ritmo do cliente.** Quem compra a cada 15 dias e quem
compra a cada 90 não podem receber o mesmo "faz tempo que você não compra".

## Checklist

- □ O eixo do funil corresponde ao tipo de venda do negócio
- □ Todo estágio tem critério objetivo de entrada e de saída
- □ Perda exige motivo, de um catálogo fechado
- □ RFV guarda histórico, não só o estado atual
- □ Recência é comparada com a média do próprio cliente
- □ Ativo/Inativo/Perdido é configurável pelo dono do negócio
- □ Histórico de carteira é auditável
- □ Atribuição exata e estimada aparecem separadas
- □ A janela de atribuição está declarada na interface

## Relacionado

`modelar-dados` — RFV com histórico é série temporal; carteira é histórico de atribuição.
`especificar-requisitos` — as métricas viram requisitos com número.
