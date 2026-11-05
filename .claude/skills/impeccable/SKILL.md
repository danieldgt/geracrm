---
name: impeccable
description: Vocabulário de crítica, auditoria e refino de interface para o console do GeraCRM (e, como segunda opinião, o app Expo e o catálogo). Comandos audit, critique, polish, typeset, layout, colorize, animate, clarify, harden, adapt, optimize, distill, quieter, bolder, onboard, delight e shape, cada um ligado aos tokens de `packages/design-tokens`, aos componentes `ui-*`, ao `cor-literal.spec.ts` e ao `pnpm lint typecheck test`. Use ao revisar, auditar, criticar ou polir uma tela de apps/console, e quando o pedido for "revisa essa tela", "o que está errado nesse layout", "tem tela repetida", "organiza o menu", "dá um acabamento", "arruma a hierarquia", "o formulário está esquisito", "a cor está demais", "está com cara de IA", "melhora os textos", "faltam estados de vazio e erro", "o chat quebrou o layout" ou "deixa mais calmo". Para redesenho grande ("subir o nível") use `uplift-de-front`, com esta skill como lente.
---

# impeccable (adaptado para o GeraCRM)

Adaptação do **Impeccable**, de Paul Bakaus (Apache-2.0), vinda da adaptação feita para a Velivo. A origem, a
licença e o que mudou estão em `NOTICE.md` e `LICENSE`, nesta pasta. Ficaram o vocabulário de comandos, as rubricas
de crítica e auditoria e o piso de acabamento. **Esta skill não roda nada de terceiros.** Para ver e medir a tela,
ela usa o ciclo da `taste-skill` e os testes que o projeto já tem.

## Onde vale, e quem vence em caso de conflito

| Superfície | Identidade e tokens | Método de redesenho | Lentes de revisão |
|---|---|---|---|
| `apps/console` (Angular 21) | **`geracrm-layout-ui`**, `geracrm-formularios`, `docs/identidade-visual.md`, `packages/design-tokens` | `uplift-de-front` | **esta skill** e a `taste-skill` |
| `apps/app` (Expo) | `packages/design-tokens` (mesmos tokens) e `expo-native-ui` | `uplift-de-front` | esta skill (`audit` nativo) |
| `apps/catalogo` (SSR) e `/f/:chave` | `geracrm-catalogo`, `geracrm-formularios` | `uplift-de-front` | esta skill, modo Preencher |

Precedência:

1. **O repositório vence.** `CLAUDE.md`, as ADRs (`docs/decisoes.md`, ADR-012 da identidade), `geracrm-layout-ui` e
   `geracrm-formularios` mandam em qualquer conflito com esta skill.
2. **Método versus lente.** O `uplift-de-front` manda no processo (fases, júri, um agente por vez). Esta skill manda
   no que se avalia. O júri e a validação do uplift usam `critique` e `audit` daqui. Na barra do uplift, troque o item
   "selo antes do título" por "título-substantivo, sem selo".
3. **Formulários com modal (decisão do dono, 2026-11-05).** Criar e editar registro usa o padrão tradicional:
   lista + botão primário no cabeçalho + `ui-modal` (padrão M). Formulário-página (padrão F) só para cadastro longo
   com seções (contato, campanha em passos). Ação sobre um registro é modal de ação (padrão A). O veto do original a
   "modal por reflexo" **não vale aqui**; o achado é o oposto (ver `referencia/piso.md`).
4. **Mono é dado.** O original trata monoespaçada como fantasia; no GeraCRM a Geist Mono (`.txt-dados`) é regra em
   SKU, telefone, CNPJ, protocolo e dinheiro.
5. **Acento lateral do card do kanban** (`--densidade-acento-lateral-card`, 3 px) é token do tema, não achado.

## Antes de qualquer comando

1. Leia `geracrm-layout-ui` (padrões L, F, M, A, D, C, os cinco estados, regras de quebra) e, se a tela tem campo,
   `geracrm-formularios`.
2. Leia os tokens: `packages/design-tokens/tokens.json` (gera `dist/tokens.css`) e `apps/console/src/estilos.css`
   (`.pagina` 960 px, `.txt-*`, `.encolhe`, `.rolagem-x`, quebra de 640 px). A casca (menu, rail do chat) mora em
   `apps/console/src/app/nucleo/shell.componente.ts`; o menu inteiro é dado em `nucleo/menu.ts` e espelha
   `docs/mapa-de-telas.md`.
3. Leia a especificação: `docs/especificacao-telas.md`, `docs/mapa-de-telas.md`, `docs/biblioteca-componentes.md`.
4. **Olhe a tela renderizada** antes de opinar: console em `ng serve` (4200) com a API (3000), a 1280 e a 390, nos
   dois temas (`data-tema`), e a 1440 nas telas com o chat aberto. Como capturar e medir: `../taste-skill/referencia/medir.md`.
5. Escolha o **modo** da superfície (abaixo). Antes de editar, leia `referencia/piso.md`.

## Modos: o que é sucesso nesta tela

| Modo | Telas do GeraCRM | Como a ambição aparece |
|---|---|---|
| **Operar** | quase todo o console: Contatos, Funil, Leads, Pedidos, Tarefas, Campanhas, Templates, Números, Configurações, Agente | precisão e contenção: padrão conhecido (L/F/M/A/D/C), densidade honesta, a tarefa mais frequente a um clique, azul só no detalhe |
| **Conversar** | o chat rail e o inbox, a ficha com WhatsApp, o Pedido Assistido ao lado da conversa | a conversa é o palco: a coluna do chat não é espremida nem cobre a tela; janela de 24h visível; compor nunca pula de lugar |
| **Ler** | Início, BI, Relatórios, Performance, Cockpit, Mercado | estrutura para entender: um contêiner de KPI dividido, gráfico de um matiz, tabela que rola dentro da caixa |
| **Preencher** | formulário público `/f/:chave`, catálogo SSR | quem chega de fora decide: poucos campos, rótulo visível, uma ação, erro no campo |

Escolha o modo pela **superfície**, não pelo produto: o rail do chat é Conversar mesmo sobre uma tela de Operar.

## Comandos

| Comando | Para quê | Como se prova no GeraCRM | Referência |
|---|---|---|---|
| `critique` | revisão de UX com nota por heurística, personas e P0 a P3 | capturas 1280/390 nos dois temas; relatório no formato de `criticar.md` | `referencia/criticar.md` |
| `audit` | qualidade técnica: a11y, desempenho, tema, responsivo, integridade | medição da `taste-skill`; `cor-literal.spec.ts`; `pnpm lint typecheck test` | `referencia/auditar.md` |
| `polish` | última passada, sem redesenho escondido | os cinco estados, foco, alvo; diff limpo; checks verdes | `referencia/refinar.md` |
| `typeset` | hierarquia e leitura | só `.txt-*` (titulo 20, secao 15, corpo 14, denso 13, rotulo 11, kpi 32) | `referencia/refinar.md` |
| `layout` | espaço, ritmo, agrupamento, estrutura do menu | `--espacamento-*`, `.pagina`, `ui-grade-form`, `menu.ts` | `referencia/refinar.md` |
| `colorize` | cor com papel | só token; azul em ação/foco/seleção/link; RFV sempre com rótulo | `referencia/refinar.md` |
| `animate` | movimento que comunica estado | `--movimento-*`; `prefers-reduced-motion` | `referencia/refinar.md` |
| `clarify` | rótulos, erros, vazios e avisos em pt-BR | falha de negócio nomeada com ação corretiva (PED-08) | `referencia/refinar.md` |
| `harden` | extremos, erros da API, 11 mil cards | 422 no campo, cursor, `.encolhe`, `.rolagem-x` | `referencia/refinar.md` |
| `adapt` | celular, toque, rail do chat | quebras 640 e 720 px; modal em tela cheia abaixo de 720 | `referencia/refinar.md` |
| `optimize` | desempenho percebido e peso | rota lazy em `rotas.ts`; lista por cursor; kanban virtualizado | `referencia/refinar.md` |
| `distill` | tirar o que sobra, fundir telas repetidas | menu enxuto, uma tela por trabalho | `referencia/refinar.md` |
| `quieter` | baixar volume | tokens existentes, sem cor nova | `referencia/refinar.md` |
| `bolder` | dar força com o vocabulário que existe | nada de token novo sem pedir | `referencia/refinar.md` |
| `onboard` | número novo, lista vazia, primeiro uso | vazio que ensina e oferece a ação | `referencia/refinar.md` |
| `delight` | um momento com personalidade, onde cabe | nunca em dinheiro, bloqueio, LGPD | `referencia/refinar.md` |
| `shape` | planejar UX antes do código | perguntas em rodadas; estrutural vira ADR em `docs/decisoes.md` | `referencia/refinar.md` |

`overdrive`, `live` e `generate` do original não entram. **Sem argumento:** não rode nada sozinho; diga em duas
linhas o que a tela parece pedir e pergunte.

## Como desenhar aqui

- **A decisão escrita vence o gosto.** Palco neutro, azul só no detalhe, turquesa da assinatura, Geist + Geist Mono,
  os seis padrões de tela e o modal para criar/editar foram decididos. Reverter é ADR, não refino.
- **Refinar preserva; redesenhar substitui.** `polish`, `typeset`, `layout`, `colorize` e `quieter` mantêm
  identidade, comportamento e texto. Redesenho é `uplift-de-front`.
- **Componente da biblioteca antes de CSS próprio.** `ui-cabecalho-tela`, `ui-tabela`, `ui-modal`, `ui-campo`,
  `ui-filtros`, `ui-paginacao`… Tela que reimplementa um deles é deriva do sistema.
- **Fundir ou apagar tela é estrutural.** Mexe em `menu.ts`, `rotas.ts` (com redirect da rota velha),
  `docs/mapa-de-telas.md` e `rotas.spec.ts` no mesmo commit.
- **Sem dependência nova por estética.** Ícone é Lucide via `ui-icone`.
- **Verde antes de entregar**: `pnpm lint typecheck test` (com `export PATH="$HOME/.local/bin:$PATH"`).

## Arquivos

| Arquivo | Leia quando |
|---|---|
| `referencia/piso.md` | **antes de qualquer edição de UI**: piso de acabamento, vetos e exceções do GeraCRM |
| `referencia/criticar.md` | `critique`: heurísticas 0 a 4, carga cognitiva, personas, formato do relatório |
| `referencia/auditar.md` | `audit` no console e no app: cinco dimensões de 0 a 4 |
| `referencia/refinar.md` | qualquer comando de refino (`polish` a `shape`) |
| `../taste-skill/SKILL.md` | para ver a tela: capturar, medir, olhar, corrigir |
