---
name: taste-skill
description: Olho contra o visual "genérico de IA" e contra a quebra de layout nas telas do console GeraCRM. O ciclo é capturar, medir no navegador, olhar a imagem, corrigir os três piores e repetir, no máximo três rodadas. Inclui as regras da casa para telas de operação (listas, kanban, inbox com chat rail, CRUD em modal, configurações), o registro de sinais de tela gerada e uma medição própria (transbordo, sobreposição, contraste, alvo, tipos, ícone tingido, ação dominante) para colar no Chrome. Use ao revisar ou ajustar o visual de uma tela de apps/console, ao conferir uma tela antes de entregar, e quando o pedido for "está com cara de template", "está genérico", "olha essa tela", "confere o visual", "tira print e vê", "mede a tela", "está poluído", "quebrou o layout" ou "o chat está cobrindo a tela". Para o vocabulário de crítica e auditoria use `impeccable`; para redesenho grande, `uplift-de-front`.
---

# taste-skill (adaptada para o GeraCRM)

Adaptação da **taste-skill v2** (`design-taste-frontend`) de Leonxlnx, https://github.com/leonxlnx/taste-skill,
licença MIT (texto em `LICENSE`), via a adaptação feita para a Velivo. Vieram a ideia do ciclo "olhar e corrigir", as
regras de tela de app e o registro de sinais, reescritos para os tokens, componentes e telas do GeraCRM. **Não veio
nenhum script do original**; a medição de `referencia/medir.md` foi escrita do zero e só lê o DOM.

## Onde vale, e quem vence em caso de conflito

- **Console (`apps/console`)**: vale esta skill, junto com a `impeccable`. Em conflito com `geracrm-layout-ui`,
  `geracrm-formularios`, `CLAUDE.md` ou uma ADR, **vale o repositório**.
- **Com o `uplift-de-front`:** ele manda no processo; esta skill é o "julgue a imagem" de cada fase.
- **Com a `impeccable`:** ela tem os comandos e o relatório; esta tem o ciclo de captura e medição e as regras de tela.
  Em número, vale o mais estrito para acessibilidade.
- **Decisão do dono (2026-11-05):** criar e editar é **modal** (`ui-modal`, padrão M); formulário-página só para
  cadastro longo com seções. Formulário inline no meio da lista é sinal de tela montada, não escolha.

## Que tipo de tela é

- **Operar** (quase tudo): listas, kanban, CRUD, configurações. Siga `referencia/tela-de-app.md` inteira.
- **Conversar**: inbox e chat rail. A conversa é o palco; seção 10 de `tela-de-app.md`.
- **Ler**: Início, BI, Relatórios, Cockpit. KPI e gráfico pelas seções 5 e 6.
- **Preencher**: `/f/:chave` e o catálogo SSR. Poucos campos, uma ação.

## O ciclo

1. **Leia a tela e o projeto:** o item em `nucleo/menu.ts` (a `descricao` é o "job"), `docs/mapa-de-telas.md`, o
   padrão de tela em `geracrm-layout-ui`. Escreva em uma linha a pergunta que a tela responde.
2. **Monte dados que pedem ação** (seed demo ou tenant de dogfooding local, nunca produção) e **capture** a 1280 e a
   390 (toque), nos dois temas; a 1440 com o chat rail aberto. Como: `referencia/medir.md`.
3. **Meça** com o bloco de `referencia/medir.md`. Corrija ou defenda cada `FALHA`; cada `AVISO` está errado até ser
   defendido numa frase.
4. **Olhe** cada captura com a ferramenta Read e responda às sete perguntas (`tela-de-app.md`, seção 9).
5. **Corrija os três piores**, capture, meça e olhe de novo. No máximo três rodadas, registradas no formato de `medir.md`.
6. **Feche com os testes:** `export PATH="$HOME/.local/bin:$PATH" && pnpm lint typecheck test` (inclui
   `cor-literal.spec.ts` e `crase-em-template.spec.ts`).

Uma revisão para no passo 4: entregue os achados com medição, capturas e as três mudanças que mais movem a tela.

## Regras da casa (resumo; o detalhe está em `tela-de-app.md`)

| Regra | No lugar |
|---|---|
| Uma ação dominante por tela | a primária em `--acao` no slot do `ui-cabecalho-tela`; as outras com contorno ou fantasma |
| Título-substantivo, sem selo acima | `.txt-titulo` (20 px); o "job" no subtítulo, em `--texto-secundario` |
| Cor só em dado, estado, ação e assinatura | o resto em `--texto*`, `--borda*`, `--superficie*` |
| Nada de ícone em círculo tingido repetido | uma marca de estado por linha |
| KPI sem cartão com ícone, sem sparkline | `ui-stat-card` em contêiner dividido, `.txt-kpi` (32 px) |
| Profundidade por degrau de tom | `--fundo` → `--superficie` → `--superficie-elevada`; sombra só no que flutua |
| Criar/editar em modal | `ui-modal` + `ui-grade-form` + rodapé Cancelar/primário |
| Duas famílias | Geist na interface, Geist Mono em dado (`.txt-dados`) |
| Nada sobrepõe nada | `.encolhe`, `.rolagem-x`; o chat rail nunca cobre conteúdo sem véu |
| Sem emoji como ícone, sem dado de mentira, sem degradê ou vidro | Lucide por `ui-icone`, dado real do tenant |

## Arquivos

| Arquivo | Leia quando |
|---|---|
| `referencia/medir.md` | para montar os dados, capturar, medir (o bloco de JavaScript) e registrar a rodada |
| `referencia/tela-de-app.md` | em qualquer tela do console: as regras, as relaxações e as sete perguntas |
| `referencia/sinais.md` | para checar sinais de tela gerada |
| `../impeccable/SKILL.md` | para o relatório de `critique` ou de `audit`, ou para um comando de refino |
