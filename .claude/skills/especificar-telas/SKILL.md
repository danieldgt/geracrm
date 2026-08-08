---
name: especificar-telas
description: >
  Especificar telas e fluxos de interface antes do design visual: regiões, elementos, os cinco
  estados obrigatórios, transições, diferenças entre web e mobile, e extração das exigências
  técnicas que cada tela impõe à arquitetura. Use quando for preciso "definir as telas",
  "especificar a interface", "desenhar o fluxo", trabalhar UI/UX de um produto, ou quando uma
  tela precisar ser detalhada o suficiente para virar implementação e teste.
---

# Especificação de telas (UI/UX)

Especificação **não é design visual**. Cor, tipografia e espaçamento vêm depois, sobre esta base.
Aqui se define estrutura, estado e comportamento — o que um desenvolvedor precisa para implementar
e um testador para verificar.

## Os cinco estados obrigatórios

Toda tela e todo bloco de dados precisa dos cinco. Especificação sem eles está incompleta.

| Estado | Regra |
|---|---|
| **Carregando** | Esqueleto com a forma do conteúdo real. Nunca spinner solto no centro |
| **Vazio** | Explica *por que* está vazio e oferece a ação seguinte. Nunca "nenhum resultado" isolado |
| **Erro** | Diz o que falhou, se é recuperável e o que fazer. Erro de integração nomeia o sistema |
| **Sem permissão** | O elemento **não aparece**. Exceção: recurso não contratado, que aparece com cadeado como upsell |
| **Parcial / degradado** | Dado principal carregou, secundário falhou. A tela funciona com aviso localizado |

⚠️ **Especificar só o caminho feliz é o erro nº 1.** O produto morre no estado de erro: é ali que
o usuário decide se confia na ferramenta ou volta para a planilha.

## Método por tela

### 1. Uma frase de propósito

*"A tela onde a vendedora passa o dia."* Se não couber numa frase, ou a tela faz coisas demais,
ou você ainda não entendeu para que ela serve.

### 2. Layout em blocos

Desenhe em ASCII, com larguras. É rápido, versionável e força decidir proporção.

```
┌─────────┬──────────────┬────────────────────┬─────────────┐
│  MENU   │  LISTA       │  CONTEÚDO          │  CONTEXTO   │
│  240px  │  320px       │  flexível          │  360px      │
└─────────┴──────────────┴────────────────────┴─────────────┘
```

### 3. Região por região

Para cada uma: elementos, comportamento, estados, e **a regra de negócio que ela expressa**.

Elemento sem regra é enfeite. Se você não consegue dizer por que o filtro existe, ele não existe.

### 4. Interações-chave

Só as que têm regra não óbvia:

| Ação | Comportamento |
|---|---|
| Chega dado novo com a tela aberta | Entra em tempo real? Ou avisa e espera? |
| Outro usuário mexe no mesmo registro | Avisa? Bloqueia? Deixa colidir? |
| Ação falha | O que acontece com o que o usuário já digitou? |
| Ação destrutiva | Confirma? Desfaz? Por quanto tempo? |

### 5. Transições de estado

O momento mais delicado de qualquer tela. Especifique explicitamente quando o **contexto muda com
a tela aberta**:

> Quando a janela de 24h fecha durante a conversa aberta na tela, o composer troca de modo
> **sem recarregar**, **preserva o texto já digitado** e o oferece para colar no template.

Sem esse nível de detalhe, o desenvolvedor implementa o razoável — e o razoável perde o texto que
o usuário escreveu.

### 6. Web vs. mobile

Mobile **não é o web espremido**. Para cada tela mobile, responda: *por que ela existe no bolso
do usuário?* Se não houver resposta, ela não deveria estar lá.

Padrões de adaptação:
- Coluna lateral → folha deslizante
- Tabela larga → cards empilhados, ou rolagem horizontal quando a matriz é o dado (ex.: grade de tamanhos)
- Formulário longo → passos
- Alvos de toque dimensionados para o polegar, não para o cursor

## Ordem de conteúdo é prioridade

No mobile, a ordem dos blocos **é** a hierarquia de importância. Numa ficha de cliente para uso
em campo, "Vendas" e "Categorias compradas" vêm antes de "Endereço" — porque o vendedor precisa
saber quanto vale e o que compra, não onde fica.

Escreva a ordem explicitamente e justifique a primeira posição.

## Densidade: quem usa o dia inteiro precisa de densidade

Tela de uso ocasional pode respirar. Tela de operação — inbox, kanban, fila — precisa mostrar
muita informação de uma vez, porque o usuário faz **leitura periférica**: ele varre, não lê.

Para isso funcionar, **badges e indicadores precisam de ordem fixa**. Se a posição do badge muda
entre cards, a varredura visual quebra e o usuário volta a ler item por item.

## Extraia as exigências técnicas

Esta é a parte que mais rende. Cada decisão de tela vira requisito de arquitetura:

| Decisão de tela | Exigência técnica |
|---|---|
| Dado novo aparece sem recarregar | Tempo real bidirecional, não polling |
| Coluna com 11 mil itens | Carregamento sob demanda; nunca a coluna inteira |
| Contagem regressiva ao vivo | Estado derivado calculado no cliente, sem round-trip |
| Consulta ao ERP durante a montagem | Leitura síncrona com latência baixa; lote não serve |
| Rascunho retomado em outro dispositivo | Estado no servidor, não no navegador |
| Gráfico com histórico e drill-down | Leitura analítica separada da escrita transacional |
| Uso em campo sem sinal | Offline com fila e resolução de conflito |

Feche a especificação com essa tabela. **É a entrada do documento de stack** — e garante que a
tecnologia responda a exigências reais, não a preferências.

## Checklist antes de fechar

- □ Toda tela tem uma frase de propósito
- □ Todo bloco tem os cinco estados
- □ Toda transição de contexto com a tela aberta está especificada
- □ Todo elemento tem uma regra de negócio associada
- □ Toda tela mobile justifica por que existe
- □ A ordem de blocos no mobile está justificada
- □ As exigências técnicas foram extraídas em tabela

## Próxima etapa

Telas prontas → `arquitetura-limpa` (as exigências técnicas viram limites) e `bdd`
(as transições viram cenários).
