# Comandos de refino

Adaptado de `polish`, `typeset`, `layout`, `colorize`, `animate`, `clarify`, `harden`, `adapt`, `optimize`, `distill`,
`quieter`, `bolder`, `onboard`, `delight`, `shape` e `extract`, do Impeccable (Apache-2.0; ver `../NOTICE.md`). Antes
de editar, leia `piso.md`. Depois, olhe a tela de novo (ciclo da `taste-skill`) e rode `pnpm lint typecheck test`.

## `polish`: a última passada

Polir é refinar, nunca redesenhar às escondidas. Se o conceito está errado, diga e pare.

- **Classifique a deriva:** token que falta, implementação avulsa (CSS no lugar de `ui-*`), conceito desencontrado
  (padrão de tela errado) ou defeito local. Corrija no nível mais estreito que resolve.
- **Ordem:** 1) tarefa quebrada, perda de rascunho, sobreposição, caminho inacessível; 2) estado que falta (os cinco);
  3) fluxo, hierarquia, responsivo, deriva; 4) inconsistência visual; 5) limpeza.
- **Checklists:** salvar com a mesma palavra e o mesmo modal que a tela vizinha; mesmo papel com a mesma `.txt-*`;
  só token; Lucide por `ui-icone`; foco visível e ordem do Tab; sem CSS morto.
- **Verifique:** mouse, teclado e toque; 390, 640, 720, 1280 e 1440 com o chat; os dois temas; console sem erro.

## `typeset`: tipografia

- Escala fixa: `.txt-titulo` 20, `.txt-secao` 15, `.txt-corpo` 14, `.txt-denso` 13 (o mais usado), `.txt-rotulo`
  11 em maiúsculas, `.txt-kpi` 32, `.txt-dados` mono tabular. Nada de `font-size` solto.
- Duas famílias e só: Geist (interface) e Geist Mono (dado). Tamanhos vizinhos próximos demais não carregam papéis
  diferentes: junte-os.
- No escuro, texto claro pede um passo a mais de peso ou entrelinha onde a leitura cansa (inbox).

## `layout`: espaço, ritmo e estrutura

- Teste de apertar os olhos: sem detalhe, ainda dá para achar o primário, o secundário e os grupos?
- Toda tela cai num padrão (L, F, M, A, D, C) com a anatomia de `geracrm-layout-ui`. `ui-cabecalho-tela` no topo,
  sempre. `.pagina` (960 px) como moldura; telas de trabalho largas (kanban, inbox) declaram por que saem dela.
- Coluna à direita só para fluxo secundário estável: o chat rail, o painel de pedido. Ela **não cobre** o conteúdo e
  o conteúdo encolhe de verdade (`min-width: 0`), ou o rail vira sobreposição explícita com véu abaixo da largura útil.
- `gap` entre irmãos; base 4 (`--espacamento-*`). Ordem do DOM igual à visual.
- Menu: item leva a uma tela com trabalho próprio; grupo com até ~7 itens; o rótulo é o trabalho, não o módulo.

## `colorize`: cor com papel

- Papéis: superfície `--fundo`, `--superficie`, `--superficie-elevada`, `--superficie-hover`,
  `--superficie-selecionada`; texto `--texto`, `--texto-secundario`, `--texto-suave`; borda `--borda`,
  `--borda-forte`, `--borda-controle`, `--borda-foco`; ação `--acao`, `--acao-hover`, `--acao-texto`, `--acao-suave`;
  estado `--sucesso`, `--atencao`, `--erro`, `--ativo`, `--ia` e os `-suave`; RFV `--rfv-*`; janela `--janela-*`.
- Azul só em ação, foco, seleção e link. Turquesa só na assinatura. Nunca gaste a cor da ação em enfeite.
- Nunca só por cor. Token novo vai em `tokens.json` e no build, nunca hardcode.

## `animate`: movimento

- Só para reconhecer ação, mostrar estado ou dar continuidade. `--movimento-estado-*` (hover/foco/tema),
  `--movimento-painel-*` (modal, rail). Saída mais rápida que a entrada. Só `transform` e `opacity`.
- Movimento reduzido é "menos", não "nada": mantém opacidade e cor.

## `clarify`: texto da interface (pt-BR)

- O fato de agora, a próxima ação, o contexto que muda a decisão. Cada ideia uma vez.
- Rótulo é verbo e objeto ("Novo contato", "Efetivar pedido"), e mantém o nome do botão ao toast.
- Ação destrutiva nomeia o objeto e a consequência. Nada de "Sim", "Não", "OK".
- Erro: o que falhou, por que, como sair. Falha de negócio (estoque, crédito) é texto nomeado com ação corretiva.
  Integração nomeia o sistema ("O GeraCloud não respondeu").
- Vazio distingue primeiro uso, sem resultado, filtrado, sem permissão e falha.
- Nome do que a pessoa controla, nunca do que o sistema é ("Opt-out / Bloqueios", não "lista_bloqueio").

## `harden`: extremos

- Nome de 120 caracteres, emoji; 0, 1, 50 e 11 mil itens; R$ 1.234.567,89 de centavos inteiros; erros 401, 403,
  404, 409, 422, 429, 500, 503; ERP fora; SSE caído; dez cliques em salvar.
- CSS: `.encolhe`, `overflow-wrap: anywhere` em nome e e-mail, `.rolagem-x` em tabela.
- Comportamento: campo guarda o digitado no erro; 422 no campo com foco no primeiro; envio duplo bloqueado; modal
  com dado digitado não fecha sem perguntar; um bloco com erro não derruba a tela.

## `adapt`: celular e toque

- Abaixo de 640 px, grade em 1 coluna e tabela que rola na própria caixa ou vira linha de duas linhas; abaixo de
  720 px, modal em tela cheia com rodapé fixo; o chat rail vira tela própria, não coluna espremida.
- `(pointer: coarse)`: alvo 44 px, nada só no hover.

## `optimize`: desempenho

- Rota lazy; lista por cursor; kanban virtualizado; nada de buscar tudo para filtrar no navegador.
- Meça antes e depois. Não micro-otimize antes do maior gargalo.

## `distill`, `quieter` e `bolder`

- **`distill`.** Ache o trabalho da tela. Uma primária, poucas secundárias, o resto no "⋯". Card não é layout.
  **Também no menu:** duas telas com o mesmo dado viram uma (com abas ou filtro); tela sem trabalho próprio vira aba
  de outra ou sai. Escreva o que saiu, para onde foi e o redirect da rota velha.
- **`quieter`.** Neutros dominando, cor como acento (regra dos 10 %), peso 600 no lugar de 700, borda mais fina.
  Calmo não é genérico: não tire a affordance.
- **`bolder`.** Só o alvo nomeado muda, com o vocabulário que já existe. Um movimento decisivo, o resto quieto.

## `onboard` e `delight`

- **`onboard`.** Medida: tempo até o valor (primeiro número conectado, primeira conversa respondida, primeiro pedido).
  Vazio diz o que vai aparecer, por que importa e a ação.
- **`delight`.** Só na conclusão (pedido efetivado, campanha enviada) e no primeiro uso. Nunca em dinheiro, bloqueio,
  LGPD ou risco de banimento.

## `shape` e `extract`

- **`shape`.** Planejar sem código, em rodadas de 2 a 3 perguntas: para que serve, quem chega, ação principal,
  sucesso; depois conteúdo real, estados, restrições. Estrutural (fundir telas, mudar padrão) vira ADR em
  `docs/decisoes.md` e atualiza `docs/mapa-de-telas.md`.
- **`extract`.** Só vira componente `ui-*` ou token o que aparece três vezes ou mais com a mesma intenção, em
  `compartilhado/ui/` e na §5B de `docs/biblioteca-componentes.md`.
