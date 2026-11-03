---
name: geracrm-layout-ui
description: >
  Padrão de layout, UI e estética do console GeraCRM: identidade "palco neutro, azul só nos
  detalhes", tipografia Geist e a escala, moldura de página e o padrão CANÔNICO de tela CRUD,
  os cinco estados, responsividade e regras de "sem quebra de layout / sem sobreposição", uso da
  biblioteca de componentes e dos design tokens. Usar SEMPRE ao criar ou alterar qualquer tela do
  console (apps/console), especialmente CRUDs — para que toda tela nova saia coesa e autoexplicativa.
---

# Layout & UI — o padrão do console

Ferramenta de operação B2B usada **8h/dia** (inbox denso, kanban, tabelas, CRUDs). Densidade,
consistência e clareza valem mais que enfeite. Complementa `geracrm-console-angular` (Angular,
signals, SSE) e `especificar-telas` (os cinco estados). Direção visual: `docs/identidade-visual.md`
· ADR-012 · tokens em `packages/design-tokens`.

## A tese: palco neutro, azul só nos detalhes

⚠️ **O azul NÃO é a cor do sistema — é o acento.** Superfícies, textos e bordas são **neutros**
(slate dessaturado, matiz 217°). O azul entra SÓ em: **ação/primário, foco, item ativo/selecionado,
marca e links**. Nada de fundo/painel azul dominante.

- **Turquesa** é reservada à **assinatura** (anel da janela de 24h + status "ao vivo") — um acento,
  nunca decoração espalhada.
- **Dois temas**, mesma disciplina: **claro** (fundo off-white, superfícies `neutro`) e **escuro**
  (slate profundo `neutro.900`, não preto, não azul). Trocados pelo seletor no shell; `data-tema`
  na raiz vence o SO, ausência = segue `prefers-color-scheme`.
- Gaste ousadia em **um** lugar (a assinatura). O resto é quieto e disciplinado.

## Tokens — a única fonte de cor, tamanho e ritmo

⚠️ **Proibido cor literal (`#hex`, `rgb()`) em componente.** Um `#25d366` solto diverge do app Expo
em três meses e o lint `cor-literal.spec.ts` quebra o build. Tudo vem de `var(--token)`.

| Precisa de | Use |
|---|---|
| Cor de ação/link | `var(--acao)` `var(--acao-hover)` `var(--acao-texto)` |
| Fundo de estado (aviso/erro/ok/ia) | `var(--atencao-suave)` `var(--erro-suave)` `var(--sucesso-suave)` `var(--ia-suave)` `var(--acao-suave)` |
| Superfície | `var(--fundo)` `var(--superficie)` `var(--superficie-elevada)` `var(--superficie-hover)` `var(--superficie-selecionada)` |
| Texto | `var(--texto)` `var(--texto-secundario)` `var(--texto-suave)` |
| Borda | `var(--borda)` `var(--borda-forte)` `var(--borda-controle)` `var(--borda-foco)` |
| Estado semântico | `var(--sucesso)` `var(--atencao)` `var(--erro)` `var(--ativo)` `var(--ia)` |
| Espaço (grade 4px) | `var(--espacamento-1..12)` — nunca px solto |
| Raio | `var(--raio-controle)` (6px) `var(--raio-painel)` (10px) `var(--raio-completo)` |
| Elevação | `var(--elevacao-dropdown)` `var(--elevacao-modal)` — **borda antes de sombra** |
| Cor RFV | `var(--rfv-*)` — **NUNCA sem rótulo ao lado** |

Se faltar um token, **adicione em `tokens.json` e rode o build** — não hardcode.

## Tipografia — a escala, nunca tamanho solto

Fontes: **Geist** (interface) + **Geist Mono** (dados: SKU, telefone, protocolo, CNPJ, dinheiro).
Carregadas no `index.html`; fallback IBM Plex → system-ui.

⚠️ Em vez de `font-size: 20px`, use as **classes utilitárias** (uma fonte de verdade do ritmo):

`.txt-kpi` · `.txt-titulo` · `.txt-secao` · `.txt-corpo` · `.txt-denso` (o mais usado: lista/tabela) ·
`.txt-rotulo` (maiúsculas, esmaecido) · `.txt-dados` (mono, tabular).

Dado numérico/identificador vai **sempre** em `.txt-dados` (mono, `tabular-nums`) — dois SKUs
parecidos o olho só distingue alinhados.

## Moldura de página — toda tela igual

```
.pagina  →  max-width 960px, centrada, padding responsivo. Toda tela usa.
```

```
┌──────────────────────────────────────────────┐
│ Cabeçalho: título (.txt-titulo) + subtítulo   │  ← o que é a tela, em 1 linha
│            .................. [ Ação primária ]│
├──────────────────────────────────────────────┤
│ (opcional) barra: busca · filtros · importar   │
├──────────────────────────────────────────────┤
│ Conteúdo: tabela / lista / cards               │  ← densidade > enfeite
│  · linha 32px, item-lista 56px (tokens)        │
│  · paginação por CURSOR ("carregar mais")      │
├──────────────────────────────────────────────┤
│ Painel de form (inline ou lateral) quando cria │
└──────────────────────────────────────────────┘
```

Header padrão: `<ui-cabecalho-tela titulo="…" subtitulo="…">` + ação no slot. Nunca um `<h1>` solto
com estilo próprio.

## O padrão CANÔNICO de CRUD (todo CRUD novo copia este)

Os componentes que implementam cada parte estão na §5B de `docs/biblioteca-componentes.md`.

1. **Cabeçalho**: `<ui-cabecalho-tela titulo="…" subtitulo="…">` com a ação primária no slot padrão e a
   trilha (`ui-breadcrumb`) no slot `[trilha]`, quando a tela é uma subpágina.
2. **Filtros** (quando há muitos registros): `ui-filtros`, com os controles projetados. Filtro que muda zera o cursor.
3. **Lista**: `ui-tabela` (com `track` no `@for` dos templates, `uiCelula` por coluna) + `ui-paginacao`
   ("Carregar mais", por cursor). Dado numérico ou identificador em `mono`. Nada de `OFFSET` nem lista ilimitada (ADR).
4. **Criar/editar**: padrão **F** (formulário-página) quando é longo ou tem seções; padrão **M** (modal) quando
   é curto. Preserva o texto digitado ao alternar modo.
5. **Os cinco estados**, sempre (abaixo).
6. **Falha de negócio é texto nomeado com ação corretiva**, nunca "erro genérico".

Exemplares de referência (`crm/bloqueios.pagina.ts`, `integracao/webhooks.pagina.ts`,
`plataforma/auditoria.pagina.ts`) ainda usam o formato anterior. Copie a estrutura dos componentes acima,
não a deles; a migração das telas é a onda 1+ de `docs/plano-paridade-am.md` §4.5.

## Formato de formulário e padrões de tela

Toda tela do console cai em **um** dos seis padrões. Escolha o padrão antes de desenhar; telas do mesmo
padrão têm a mesma anatomia. Origem: `docs/plano-paridade-am.md` §4 (disposição do AM Consórcio, com os
tokens e a pele do GeraCRM). Regras de campo, máscara, select e validação: skill `geracrm-formularios`.

| Padrão | Quando usar | Componentes |
|---|---|---|
| **L · Lista** | Ver e filtrar muitos registros | `ui-cabecalho-tela`, `ui-filtros`, `ui-acoes-lote`, `ui-tabela`, `ui-paginacao`, `ui-botao-csv` |
| **F · Formulário-página** | Criar ou editar com seções (contato, campanha em passos) | `ui-breadcrumb`, `ui-form-pagina`, `ui-secao-form`, `ui-grade-form`, `ui-campo`, `ui-select`, `ui-select-paginado` |
| **M · CRUD em modal** | Cadastro curto de configuração (grupo, meta, carteira, template) | `ui-cabecalho-tela`, `ui-tabela`, `ui-modal`, `ui-grade-form`, `ui-campo` |
| **A · Modal de ação** | Uma ação sobre um registro com 1 a 3 dados (perder com motivo, transferir, agendar) | `ui-modal`, `ui-campo`, `ui-select`, `ui-select-paginado` |
| **D · Detalhe** | Ver um registro com ações, histórico e dados laterais | `ui-breadcrumb`, `ui-cabecalho-tela`, `ui-chips-etiqueta`, `ui-abas`, `ui-lista-definicao`, `ui-stat-card` |
| **C · Configurações com abas** | Ajustes agrupados por assunto | `ui-cabecalho-tela`, `ui-abas`, `ui-form-pagina`, `ui-grade-form`, `ui-campo`, `ui-select` |

Anatomia de cada padrão (de cima para baixo):

```
L · Lista
┌ cabeçalho ........................ [ Ação primária ]┐
│ ui-filtros: [ busca ] [controles] [Filtrar][Limpar]  │
│ ui-acoes-lote: "3 selecionados" [ações] (só com seleção)
│ ui-tabela: cabeçalho · linhas de 40 px · ações à dir.│
│ ui-paginacao: "Mostrando 50 · [Carregar mais]"       │
└──────────────────────────────────────────────────────┘

F · Formulário-página
Início › Contatos › Novo contato          ← ui-breadcrumb
┌ Novo contato / subtítulo ──────────────────────────┐
│ DADOS PRINCIPAIS        (ui-secao-form)            │
│ [ Nome*      ] [ Telefone*  ]   ← ui-grade-form 2 col
│ [ Observações (largo)                    ]         │
│ ENDEREÇO                                           │
│ ...                                                │
│────────────────────────────────────────────────────│
│                  [Cancelar] [Salvar] [Salvar e criar outro]
└────────────────────────────────────────────────────┘

M · CRUD em modal
Lista (L) ............................. [+ Novo grupo]
   └─ ui-modal (largura m)
      ┌ Novo grupo ×─────────────┐
      │ [ Nome*      ] [ Ativo ] │  ← grade 2 col
      │──────────────────────────│
      │        [Cancelar] [Salvar]│
      └──────────────────────────┘

A · Modal de ação
┌ Perder oportunidade ×─────────────────┐
│ Lead: Ana Souza                    │
│ [ Motivo*                 ▾ ]          │
│ [ Observação                         ] │
│───────────────────────────────────────│
│              [Cancelar] [Perder]      │  ← cor de perigo
└───────────────────────────────────────┘

D · Detalhe 2+1
Início › Contatos › Ana Souza
┌ Ana Souza  [chips] [Editar][Pedido][Tarefa] ┐  ┌ Informações ┐
│ [ Feed | Dados | Pedidos | Tarefas ]        │  │ rótulo/valor │
│ conteúdo da aba                             │  │ ...          │
└─────────────────────────────────────────────┘  └──────────────┘

C · Configurações com abas
Configurações
[ Geral | Atendimento | Privacidade ]          ← ui-abas
┌ Cabeçalho do cartão (título + descrição) ────────┐
│ campos em grade de 3 colunas (ui-grade-form)     │
│                                    [Salvar]      │
└──────────────────────────────────────────────────┘
```

**Regras que valem para os seis padrões:**

- **Rótulo visível acima do controle, sempre.** `ui-campo`/`ui-select` com `rotulo`. Placeholder só mostra
  o formato ("(00) 00000-0000"); nunca substitui o rótulo.
- **Asterisco no obrigatório**: `[obrigatorio]="true"`. Atributo sem valor não liga (ver §5B.1 da biblioteca).
- **Grade de 2 colunas** com `ui-grade-form`; campo que pede a linha toda (nome longo, observação) recebe
  `[largo]="true"`. Abaixo de 640 px do contêiner, a grade vira 1 coluna sozinha.
- **Seções** com `ui-secao-form` (título em caixa normal; o CSS põe em maiúsculas), separadas por espaço,
  não por linha.
- **Rodapé à direita**, em ordem fixa: `Voltar` ou `Cancelar` (secundário) → **um** primário → `Salvar e criar
  outro` (secundário, só em cadastro em série). O botão mantém o nome do começo ao fim.
- **Erro 422 vai para o campo.** A API diz qual campo falhou; o formulário aplica a mensagem no `erro` do
  campo e o foco vai para o primeiro campo com erro. Erro sem campo certo: texto inline no corpo, nomeando a
  ação corretiva.
- **Toast só no sucesso.** Erro de salvamento ou de carga fica na tela (inline ou no estado de erro), nunca só
  num toast que some.
- **Modal**: `ui-modal` vira tela inteira abaixo de 720 px, com o rodapé fixo. Modal com dados digitados não
  fecha sem perguntar (ver §5B.9).
- **Listas por cursor**: `ui-paginacao` com "Carregar mais". Sem página numerada, sem "de N páginas". `total`
  só quando a API devolve um total barato.
- **Celular**: o formulário-página mantém o cartão com margem menor; o rodapé ocupa a largura toda nos botões.

**Qual padrão usar (decisão rápida):**

- Muitos campos ou seções, ou fluxo em passos → **F** (página, com breadcrumb).
- Poucos campos, de configuração, sem contexto de outra tela → **M** (modal).
- Ação sobre um registro que pede 1 a 3 dados → **A** (modal de ação, nomeia o registro).
- Quer ver o registro inteiro e agir nele → **D**.
- Ajustes agrupados por assunto → **C**.
- Muitos registros para achar e agir em lote → **L**.

## Os cinco estados (obrigatório — `especificar-telas`)

| Estado | No console |
|---|---|
| **Carregando** | Esqueleto com a forma do conteúdo. ⚠️ Nunca spinner solto no centro |
| **Vazio** | Explica por quê + oferece a próxima ação |
| **Erro** | Diz o que falhou e se dá para tentar de novo. Integração **nomeia o sistema** |
| **Sem permissão** | O elemento **não aparece** (não é "erro"); nada de "tentar de novo" |
| **Parcial** | Secundário falhou, principal não — aviso localizado, tela não quebra (ex.: saúde da frota) |

Estados como ramos EXPLÍCITOS (`@switch`), nunca derivados de `lista.length === 0` — vazio-por-falha
e vazio-por-não-ter pedem telas opostas.

## Rótulo × placeholder (regra, não gosto)

| Campo | O que usar |
|---|---|
| **Cria ou edita registro** (nome, URL, telefone, valor, mensagem) | ⚠️ **`<label>` VISÍVEL.** Placeholder some quando a pessoa digita, e no celular ela perde a referência de onde está |
| **Busca** com ícone/contexto óbvio | Placeholder + `aria-label`. Um rótulo "Buscar" acima é ruído |
| **Filtro `<select>`** cuja 1ª option já nomeia ("Categoria…") | A option É o rótulo |
| **Campo em frase** ("Ativo até `[ ]` dias") | O texto ao redor É o rótulo — um label separado quebra a frase |
| **Botão-ícone** | `aria-label`, sempre |

⚠️ **Nunca `aria-label` num campo que JÁ tem `<label>` visível.** O `aria-label`
SUBSTITUI o texto visível para leitor de tela: quem enxerga lê um nome e quem
ouve, outro — e comando de voz ("clique em Nome da conta") deixa de funcionar
(WCAG 2.5.3). Se o rótulo visível está certo, o `aria-label` sobra.

Na barra de "adicionar" (campo + botão numa linha), o container leva
`align-items: end` — sem isso o botão sobe para a altura do texto do rótulo.

⚠️ **A armadilha das crases.** `template:` e `styles:` são template literals: uma
crase dentro de comentário HTML (`<!-- … -->`) ou CSS **fecha o literal**, e o
erro que aparece é `NG1002: Incorrect number of arguments to @Component
decorator` — que não menciona crase nem a linha certa. Já mordeu três vezes; o
teste `compartilhado/ui/crase-em-template.spec.ts` agora aponta o arquivo.

## Responsividade & SEM quebra de layout (regra dura)

⚠️ Elemento sobreposto ou empurrado por quebra é **defeito**, não detalhe. Regras:

- **`box-sizing: border-box`** é global — nunca desligue.
- Filho de `flex`/`grid` que tem texto longo leva **`min-width: 0`** (classe `.encolhe`) + o texto
  trunca (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`). É o remédio nº 1 de
  "estourou a coluna e empurrou o vizinho".
- Conteúdo largo (tabela, código, diagrama) rola **dentro da própria caixa** (`.rolagem-x` /
  `overflow-x: auto`). **A página nunca rola na horizontal.**
- Grid com colunas fixas + `1fr`: no `@media (max-width: 640px)` colapsa para **1 coluna**
  (`grid-template-columns: 1fr`).
- `img/svg` já têm `max-width: 100%` no base — não estouram.
- Teste **de 320px a wide** e nos dois temas antes de dar por pronto.

## Movimento

Nada anima em loop — **exceto** o anel de janela (24h por volta, nunca pisca). Micro-transições de
estado (`var(--movimento-estado-*)`) em hover/foco/troca de tema. `prefers-reduced-motion` sempre
respeitado (já no base).

## Escrita na interface (é material de design)

- Do lado de quem usa a tela: "Opt-out / Bloqueios", não "lista_bloqueio". Nome do que a pessoa
  controla, nunca do que o sistema é.
- **Voz ativa, o botão diz o que faz**: "Bloquear", "Importar", "Adicionar e conversar". A ação
  mantém o nome do começo ao fim (botão "Publicar" → toast "Publicado").
- Erro não pede desculpa e não é vago: diz o que houve e como resolver.
- Tela vazia é convite para agir, não recado triste.
- pt-BR, sentence case, sem filler.

## Antes de dar por pronto (autocrítica)

- [ ] Zero cor literal (`cor-literal.spec.ts` verde).
- [ ] Tamanhos por `.txt-*`, espaços por `--espacamento-*`.
- [ ] Os cinco estados presentes e como ramos explícitos.
- [ ] Cursor na lista (sem OFFSET/ilimitado).
- [ ] Responsivo 320px→wide, sem overflow horizontal, sem sobreposição.
- [ ] Claro e escuro conferidos.
- [ ] Foco visível no teclado; `prefers-reduced-motion` respeitado.
- [ ] Uma ousadia só (a assinatura); removi um "acessório" a mais.
