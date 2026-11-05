# Tela de app: regras da casa para as telas do console

Adaptado de `references/app-screens.md` da taste-skill (MIT; ver `../SKILL.md`). Os números entre parênteses são do
estudo original (23 telas de produto reais). O que diz "GeraCRM" é decisão deste repositório e vence o número.
Anatomia dos padrões L, F, M, A, D e C: `geracrm-layout-ui`.

## 1. Quando vale

Todo `apps/console` dentro da casca. O formulário público `/f/:chave` e o catálogo SSR seguem as mesmas regras de
campo e estado, com uma ação só.

## 2. Antes de desenhar: inventário e pergunta

- Escreva de 8 a 12 linhas com o que é desta tela e de nenhuma outra: os objetos (conversa, contato, pedido,
  oportunidade, campanha, template, número), as grandezas (centavos, horas de janela, dias desde a compra, cards),
  quem usa e a tarefa mais frequente.
- **Uma pergunta, uma resposta.** O maior bloco responde à pergunta da tela. Na Fila do Dia: "com quem falar agora?".
- **Uma tela por trabalho.** Se outra tela já responde a mesma pergunta com o mesmo dado, as duas viram uma (aba,
  filtro ou visão) — achado de `distill`.
- Um fato mostrado duas vezes é uma variável só: o contador do menu e a lista contam a mesma coisa.
- Todo número relativo diz contra o quê. Dado de exemplo é crível; nunca métrica de vaidade.

## 3. A casca

- Menu lateral recua: o item atual é `--superficie-selecionada` com o texto em `--texto`; o azul não pinta o item
  atual além do detalhe, e o item atual não pesa mais que a ação primária.
- Grupos com até ~7 itens; rótulo é o trabalho ("Pedidos"), não o módulo. Item leva a outra tela, nunca a âncora.
- Contador num item só quando há fila que pede ação, com o substantivo no nome acessível.
- **Coluna à direita só para fluxo secundário estável: o chat rail.** O conteúdo encolhe de verdade ao lado dele
  (grade de 3 colunas, `min-width: 0`) e não pode ficar abaixo de ~560 px; quando não cabe, o rail vira sobreposição
  explícita (gaveta com véu) ou tela própria, nunca cobertura parcial do conteúdo.
- Botão flutuante só se for a única ação e não cobrir nada em nenhuma largura.

## 4. Título e área de trabalho

- `ui-cabecalho-tela` sempre: título-substantivo em `.txt-titulo` (20 px), subtítulo com o "job" da tela (a
  `descricao` do `menu.ts`). Nada de saudação, nada de selo acima.
- **Uma primária por tela**, no slot do cabeçalho ("Novo contato", "Nova campanha"). Ao lado, uma ou duas secundárias.
- Cartões lado a lado dividem a mesma linha de baixo. Faixa vazia de mais de 40 px dentro de cartão é sobra.
- Moldura `.pagina` (960 px). Kanban, inbox e BI podem ser largos; declaram por quê.

## 5. Números (KPI)

- `ui-stat-card` num contêiner só, dividido por linhas de 1 px, rótulo sobre valor. `.txt-kpi` (32 px), nunca 48.
- Nada de ícone em círculo colorido (0 de 23) nem de sparkline (0 de 23).
- A cor diz bom ou ruim, não subiu ou desceu. Zero e indefinido em cinza.
- Dinheiro de centavos inteiros, em `.txt-dados`.

## 6. Gráficos (BI, Relatórios, Performance, Cockpit)

- Uma série por gráfico, três no máximo. 3 a 5 linhas de grade discretas, rótulo do eixo x nunca girado.
- Linha de 2 px sem marcador; até 4 matizes na tela. RFV usa `--rfv-*` com rótulo.
- Lacuna é lacuna. A tabela equivalente fica disponível (exportar ou `<details>`).

## 7. Listas, tabelas e kanban

- `ui-tabela`: linha de 32 a 40 px (`--densidade-linha-tabela`), item de lista 56 px. Cabeçalho discreto, sem zebra.
- Número à direita em `.txt-dados`. Um selo de estado por linha (`ui-badge`), que não encolhe.
- Ação da linha: um "⋯" ou um botão fantasma em coluna fixa. Seleção em lote com `ui-acoes-lote`.
- **Paginação por cursor** com `ui-paginacao` ("Carregar mais"). Kanban: coluna com contador e carga sob demanda.

## 8. Formulários e ajustes

- **Criar e editar abre `ui-modal`** (padrão M, decisão do dono de 2026-11-05) a partir do primário do cabeçalho.
  Formulário-página (F) só para cadastro longo com seções. Ação sobre registro: modal de ação (A).
- Nunca formulário inline ou expansível no meio da lista, nem "cartão de criar" fixo acima da tabela.
- Rótulo acima do campo (`ui-campo`, `ui-select`), asterisco no obrigatório, grade de 2 colunas (`ui-grade-form`).
- Rodapé à direita: `Cancelar` → um primário → `Salvar e criar outro` (só em série).
- Interruptor ligado usa `--sucesso` ou a cor do texto, não o azul de ação.
- **Um modelo de salvar por tela:** ou tudo salva sozinho com "Salvo", ou um "Salvar" por painel. Nunca os dois.
- Configurações agrupadas por assunto: padrão C (`ui-abas`), não uma tela por ajuste no menu.
- O destrutivo vem por último, com confirmação que nomeia o objeto.

## 9. Estados e as sete perguntas

- Os cinco estados como ramos `@switch`. Zero aparece como zero; dado que falta é traço cinza.
- Carregando: `ui-esqueleto` no tamanho real, sem pulo de layout. Erro no bloco que falhou, com "Tentar de novo".
- **Vermelho é sinal, não textura.**

Depois de capturar e medir, responda por escrito:

1. A pergunta da tela é respondida pela maior coisa nela, e essa coisa é lida primeiro?
2. Todos os blocos dividem as bordas? Há faixa morta, cartão curto, célula órfã, cartão esticado com sobra?
3. A cor está só no dado, no estado e na ação primária? O item atual do menu pesa mais que a ação?
4. Os números batem, e cada fato que aparece duas vezes concorda consigo mesmo?
5. Algo cobre algo? O chat rail, um popover ou um botão flutuante sobrepõe conteúdo em alguma largura?
6. Existe outra tela que faz o mesmo trabalho, ou outro jeito de criar o mesmo tipo de registro?
7. No celular, a navegação recolheu, o modal virou tela cheia e a primeira linha útil começa nos 60 % de cima?

## 10. Conversar: inbox e chat rail

- **A conversa é o palco.** Lista de conversas, conversa e contexto (ficha, pedido) dividem a largura sem que o
  compositor ou a última mensagem fiquem cobertos ou fora da tela.
- A janela de 24h fica sempre visível (anel turquesa); o caminho do número (oficial ou não-oficial, com risco) também.
- O compositor fica fixo embaixo da conversa e não pula quando chega mensagem ou abre o teclado.
- Bolha com texto longo, URL e mídia: `overflow-wrap: anywhere`, mídia com `max-width: 100%`.
- No celular, uma região por vez (lista → conversa → contexto), com voltar.

## 11. Celular

- Navegação recolhe em gaveta. Alvo de 44 px. Texto ≥ 14 px no corpo.
- Abaixo de 640 px, grades em 1 coluna e tabela rola na própria caixa; abaixo de 720 px, modal em tela cheia.

## 12. O que relaxa (e o que continua proibido)

Permitido, com limite: borda de 1 px em cartão, painel, tabela e controle; régua entre linhas; tracejado em grade de
gráfico e lugar vazio; `.txt-rotulo` em maiúsculas (11 px) em cabeçalho de seção e de tabela; fileira de cartões iguais
só para pares de verdade (3 a 6, sem ícone no topo); Geist Mono em dado; selo dentro de linha; ícone Lucide de 14 a
20 px; sombra no que flutua; o acento lateral do card do kanban.

Continua proibido: degradê, brilho, vidro; ícone em círculo tingido em cada cartão; gráfico arco-íris; emoji em
rótulo, menu ou vazio; dado de enfeite; cor de estado em variação zero; azul no cromo; número de 48 px; tela que não
diz de quem é nem oferece ação; formulário inline no meio da lista.
