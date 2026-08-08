# GeraCRM — Biblioteca de componentes

> Deriva de [`identidade-visual.md`](./identidade-visual.md) §10 (inventário),
> [`direcao-visual.md`](./direcao-visual.md) §7, [`especificacao-telas.md`](./especificacao-telas.md),
> [`especificacao-telas-entrada.md`](./especificacao-telas-entrada.md) e
> [`packages/design-tokens/tokens.json`](../packages/design-tokens/tokens.json).
> Fecha a lacuna registrada em [`prontidao-para-inicio.md`](./prontidao-para-inicio.md) §5 —
> **"token sem componente não constrói tela"**.

**O que este documento é:** a especificação de **comportamento e anatomia** de cada componente,
escrita **uma vez**. **O que não é:** código, nem tela — a tela está em `especificacao-telas.md`,
o valor visual está em `tokens.json`.

---

## 0. Como ler

### 0.1 ⚠️ A regra que governa o documento inteiro

> **Componente se duplica. Token, não.** (ADR-010, consequência 3)

Console (Angular, CSS) e app (Expo, NativeWind) **não compartilham uma linha de componente**. Cada
ficha abaixo é implementada **duas vezes**. O que impede a divergência são três coisas, nesta ordem:

| # | Mecanismo | Garantido por |
|---|---|---|
| 1 | `tokens.json` como fonte única de cor, escala, espaço, raio, movimento | Build + `tokens.d.ts` + lint que proíbe literal de cor |
| 2 | **Esta especificação escrita** | Revisão — a segunda implementação lê a ficha, não o código da primeira |
| 3 | Nomes idênticos nas duas superfícies | Convenção da §0.3 |

⚠️ **A memória de quem implementou primeiro não é especificação.** Quando as duas superfícies
divergem, a ficha é a árbitra; se a ficha estiver errada, corrige-se a ficha e depois as duas
implementações — nunca só uma.

### 0.2 Estrutura de cada ficha

**Anatomia** (as partes) · **Variantes** (quando usar cada uma) · **Tamanhos** · **Estados** ·
**Acessibilidade** · **⚠️ Armadilha** — a que é específica daquele componente, não a genérica.

### 0.3 Nomes

Domínio em português (ADR-011). Mesmo nome nas duas superfícies:

| | Console (Angular) | App (Expo) |
|---|---|---|
| Seletor / arquivo | `gc-anel-janela` · `anel-janela.ts` | `AnelJanela` · `anel-janela.tsx` |
| Onde mora | `apps/console/src/app/compartilhado/` | `apps/app/src/compartilhado/` |

⚠️ Componente de domínio (§5) mora em `compartilhado` **mesmo sendo de domínio** — ele apresenta,
não decide. Regra de negócio (cálculo de RFV, decisão de janela, validação de pedido mínimo) vem da
API ou de `packages/shared`. Um componente que calcula é um bug de arquitetura com aparência de UI.

---

## 1. Regras transversais

Valem para **todo** componente. Nenhuma ficha as repete.

### 1.1 Os cinco estados obrigatórios

Todo componente que **busca dado** define os cinco (§0.1 de `especificacao-telas.md`). Componente que
só recebe `props` não precisa — mas o bloco que o contém, sim.

| Estado | Componente da §4 | Regra inegociável |
|---|---|---|
| **Carregando** | Esqueleto | Com a forma **e a contagem** do conteúdo real. ⚠️ Nunca spinner solto no centro |
| **Vazio** | Estado vazio | Motivo + ação seguinte. ⚠️ Nunca "nenhum resultado" isolado. Sem ilustração |
| **Erro** | Estado de erro | Nomeia a origem, diz se é recuperável, oferece ação |
| **Sem permissão** | **Ausência** | O elemento **não aparece**. Não aparece desabilitado. Exceção única: recurso **não contratado** → badge de cadeado (upsell, PLT-06) |
| **Parcial / degradado** | Aviso localizado | Aviso **no bloco** que falhou, nunca na tela inteira |

⚠️ **"Sem permissão" e "desabilitado" são opostos e o time confunde os dois.** Desabilitado significa
*"você pode, mas ainda não"* — e **exige motivo legível** (§2.1). Sem permissão significa *"não é para
você"* — e some. Controle desabilitado sem motivo é a forma mais comum de o produto parecer quebrado.

### 1.2 Os oito estados de interação

| Estado | Token / regra | ⚠️ |
|---|---|---|
| **Repouso** | Como o componente nasce | — |
| **Hover** | `superficie-hover`; 120ms | Só existe onde há ponteiro. No app **não existe** — não reservar espaço para ele |
| **Foco** | Anel 2px `borda-foco` (turquesa) + `outline-offset: 2px` | §1.5 |
| **Pressionado / ativo** | `acao-pressionada` ou `azul-600`; sem transição na entrada, 120ms na saída | Feedback de pressão precisa ser instantâneo |
| **Selecionado** | `superficie-selecionada` + borda 1px | ⚠️ Distinto de foco. Um item pode estar selecionado e não focado |
| **Desabilitado** | Opacidade 0.5 sobre o mesmo fundo, cursor `not-allowed` | ⚠️ **Motivo obrigatório**, alcançável por teclado (§2.1) |
| **Carregando** | Substitui a ação, **não** o layout | ⚠️ Largura congelada. Botão que encolhe ao carregar move a tela sob o dedo |
| **Erro** | `borda-erro` + mensagem abaixo, nunca só borda | ⚠️ Cor nunca sozinha |

### 1.3 Densidade

Valores em `tokens.json → densidade`. O que eles significam na prática:

| Elemento | Console | App |
|---|---|---|
| Linha de tabela | **32px** | — (tabela vira lista) |
| Item de lista (conversa, contato) | **56px** | 64px |
| Card de kanban | mín. 112px | mín. 112px |
| Controle `sm` | 24px | — |
| **Controle `md` (padrão)** | **28px** | **44px** |
| Controle `lg` | 36px | 52px |
| Célula da grade cor × tamanho | 44 × 36px | 44 × 44px |

**Tipografia por contexto** — o produto tem um tamanho dominante e os outros são exceção:

| Tamanho | Onde | Proporção estimada |
|---|---|---|
| **`denso` 13px** | Lista, tabela, card, badge de conteúdo, célula, botão `md` | **~80% do texto do produto** |
| `corpo` 14px | Texto corrido, modal, estado vazio, mensagem de erro longa | ~10% |
| `secao` 15px / `titulo` 20px / `kpi` 32px | Cabeçalhos e Home | ~5% |
| `rotulo` 11px | Badge, cabeçalho de coluna | ~5% |

⚠️ **13px é o padrão; 14px é a exceção.** O caminho inverso — começar em 14 e "compactar depois" —
não acontece, porque compactar depois quebra todo o layout já testado. E ⚠️ **peso 700 não existe**:
em 13px ele empasta.

⚠️ **Mono para identificador, sempre**: SKU, referência, telefone, CNPJ/CPF, protocolo, número do
pedido no ERP, `phone_number_id`. Nunca para nome, endereço ou texto livre.

### 1.4 Badges em ordem fixa

Posição vale mais que cor (identidade §2). A ordem é **por superfície** e não muda entre itens da
mesma superfície — nem quando um badge está ausente (o slot fecha, os seguintes **não** trocam de
ordem).

| Superfície | Ordem canônica |
|---|---|
| **Item de conversa** | estágio → vendedora dona → histórico (`1 pedido` / `3+ pedidos`) → quem conduz (IA / humano) → tipo do último conteúdo |
| **Card de kanban** | iniciais → **segmento RFV** → valor total → estado (`Ativo` / `Perdido`) |
| **Ficha do cliente** | estado do funil → qualificação → `Atacado` / `Varejo` → segmento RFV |
| **Cartão de número (frota)** | LIVE → verificada → pagamento → qualidade → tier |
| **Menu lateral** | `NOVO` → `META API` → `🔒` |

⚠️ **Ordem por relevância dinâmica é a tentação errada.** "O badge mais importante primeiro" parece
melhor e destrói a varredura periférica: o olho aprende a posição, não o conteúdo.

### 1.5 Foco visível

- Anel de **2px** em `borda-foco` com `outline-offset: 2px`. ⚠️ `outline: none` é **proibido** e
  deve ser barrado por lint.
- **Dentro de linha densa** (tabela de 32px, célula de grade): `outline-offset: -2px`. O foco vai
  para dentro em vez de sumir.
- Console: `:focus-visible` (mouse não acende foco). App: acende sempre que há teclado externo.
- Contraste do anel: 3:1 **contra o fundo e contra o elemento** — turquesa passa nos dois temas; é
  por isso que o foco não é azul (o azul é a ação, e ação sobre ação some).

### 1.6 Alvo de clique e de toque

| | Regra |
|---|---|
| **Console** | 28px visual, **32px de área de clique** via pseudo-elemento de hit area. ⚠️ A saída para o conflito densidade × alvo é a hit area, nunca aumentar o controle |
| **App** | **44 × 44px** reais, sem exceção. Se não cabe, o layout está errado — não o alvo |
| **Espaçamento entre alvos** | Mínimo 4px entre dois alvos destrutivos adjacentes; ⚠️ `Remover` colado em `Salvar` é erro de projeto, não de usuário |

### 1.7 Movimento

| Duração | Uso |
|---|---|
| `120ms` | Estado (hover, foco, pressão, cor) |
| `200ms` | Entrada de painel, folha, modal |
| `24h linear` | **Só o anel de janela** (§5.1) |

- ⚠️ **Nada anima em loop**, exceto o anel — e ele leva 24h por volta. Isso inclui o esqueleto (§4.3).
- ⚠️ **Nada anima na entrada de item de lista.** A lista atualiza por SSE o dia inteiro; animação de
  entrada vira tremor.
- ⚠️ **Troca de tema não tem transição.** Animar 200 propriedades de cor produz flash pior que corte.
- `prefers-reduced-motion` desliga **toda** transição; o anel vira arco estático (§5.1.7).

### 1.8 Composição de texto

| Nunca | Sempre |
|---|---|
| "Erro", "Inválido", "Falha" | O que falhou e o que fazer |
| "Nenhum resultado" | Por que está vazio e qual a ação seguinte |
| "Campo obrigatório" isolado num toast | A mensagem **no campo**, com o nome do campo |
| Mensagem crua do ERP ou código HTTP na tela | Erro tipificado; o código vai no rodapé copiável (id de correlação) |
| ⚠️ **Nome literal do ERP** ("Enviar ao GeraCloud") | O nome da **conexão ativa** do tenant, vindo de **`detalhe.origem.nome`** — ⚠️ nunca `origem.conector`, que é o slug do fornecedor e não vai para a tela (`contrato-api` §4.3) |

### 1.9 Ícones

Um conjunto só, dois tamanhos: **14px** (dentro de controle `sm`/`md`) e **18px** (controle `lg`,
ícone isolado). Traço 1.5px. ⚠️ **Ícone que carrega significado precisa de rótulo acessível e de
contraste 3:1** — ícone decorativo leva `aria-hidden`. ⚠️ Ícone **sozinho** só em ação óbvia e
repetida (fechar, abrir em nova aba, enviar); tudo mais leva texto.

---

## 2. Base

### 2.1 Botão — `gc-botao`

**Anatomia:** `[ícone-esquerda] rótulo [ícone-direita] [indicador de carga]` · raio `controle` 6px ·
peso 500 · texto `denso` 13px em `md`.

**Variantes — e quando usar cada uma:**

| Variante | Aparência | Usar quando | ⚠️ |
|---|---|---|---|
| **Primário** | Fundo `acao`, texto `acao-texto` | A ação que a tela existe para realizar | **Um por região visível.** Dois primários lado a lado significam que a tela não decidiu o que ela faz |
| **Secundário** | Fundo transparente, borda `borda-forte`, texto `texto` | Alternativa legítima à primária (`Salvar rascunho` ao lado de `Enviar pedido`) | Não é "o botão menos importante" — é **outra** ação |
| **Sutil** | Sem fundo, sem borda, texto `texto-secundario`; fundo só no hover | Ação repetida em item de lista, cabeçalho de painel, barra de ferramentas | ⚠️ Sem borda, ele depende do hover — no app **não há hover**: use borda ou aumente o alvo |
| **Destrutivo** | Fundo `erro` (primário) ou texto `erro` + borda (secundário) | Remove, descarta, desconecta | ⚠️ Só destrutivo **de verdade** — irreversível ou com efeito em terceiros. `Cancelar` não é destrutivo |
| **Link** | Texto `acao`, sublinhado no hover | Navegação inline dentro de texto | ⚠️ Se navega, é `<a>`. Botão que navega quebra "abrir em nova aba" |

**Tamanhos:** `sm` 24px (dentro de linha de tabela) · **`md` 28px console / 44px app (padrão)** ·
`lg` 36px console / 52px app (ação principal de modal e folha) · `icone` quadrado do mesmo lado.

**Estados:** repouso · hover (`acao-hover`) · foco (§1.5) · pressionado (`acao-pressionada`, sem
transição de entrada) · desabilitado · **carregando** · sucesso momentâneo (só onde não há toast).

**Carregando:** o rótulo permanece, o ícone-esquerda é substituído pelo indicador, a **largura é
congelada** no valor de repouso e o botão fica `aria-busy="true"`.

**Acessibilidade:** `<button type="button">` de verdade · nome acessível igual ao rótulo visível ·
Espaço e Enter ativam · ícone-só exige `aria-label`.

> ⚠️ **Armadilha: botão desabilitado não recebe foco — e o motivo fica inalcançável por teclado.**
>
> A §2.2 de `especificacao-telas.md` exige que `Enviar pedido` desabilitado **diga o motivo no
> hover**. Com `disabled` nativo, o elemento sai da ordem de tabulação, não dispara eventos de
> ponteiro em alguns navegadores e o leitor de tela só anuncia "indisponível". A vendedora de
> teclado nunca descobre que faltam 3 peças.
>
> **Regra:** botão bloqueado por regra de negócio usa `aria-disabled="true"` + permanece **focável**
> + o clique é no-op + o motivo vai em `aria-describedby` **e** em tooltip. `disabled` nativo fica
> só para o estado `carregando`. ⚠️ E o motivo é o texto da validação (`Mínimo 10 peças — faltam 3`),
> não "há pendências".
>
> ⚠️ **Corolário:** o botão **nunca** é a proteção contra envio duplicado. Ele entra em `carregando`
> por cortesia; a idempotência é do servidor (ADR-005, INV-29).

### 2.2 Campo de texto — `gc-campo`

**Anatomia (de cima para baixo):** rótulo · [dica] · caixa `[prefixo] entrada [sufixo] [ação]` ·
mensagem de erro **ou** contador. ⚠️ A mensagem de erro **ocupa espaço reservado** — campo que cresce
ao errar empurra o formulário.

**Variantes:** texto · área de texto (auto-crescimento até 5 linhas) · numérico · senha (com revelar) ·
busca (ícone + limpar) · **com máscara** (telefone, CNPJ — em mono, §1.3) · **bloqueado com
explicação**.

**Tamanhos:** `md` 28px console / 44px app · `lg` 36px / 52px. Área de texto: mín. 2 linhas.

**Estados:**

| Estado | Regra |
|---|---|
| Repouso | Borda **`borda-forte`** — ⚠️ ver armadilha |
| Hover | `borda-forte` escurece um passo |
| Foco | Anel de foco + borda `borda-foco` |
| Preenchido | Igual ao repouso. ⚠️ Sem "estado preenchido" especial — rótulo flutuante é ruído em formulário denso |
| Erro | `borda-erro` + mensagem + `aria-invalid="true"` |
| Desabilitado | Opacidade 0.5, não focável |
| Somente-leitura | Sem borda, fundo `superficie`, texto selecionável, **focável** |
| **Bloqueado com explicação** | Entrada inerte + linha de explicação + **ação alternativa em destaque** |

⚠️ **`bloqueado com explicação` não é `desabilitado`.** É o composer com a janela fechada (§1.3 das
telas): o campo não aceita digitação, diz *por quê* em uma linha e oferece `Escolher template`.
Campo cinza mudo é o comportamento que o produto existe para não ter.

**Validação:** erro aparece **no blur**, some **na digitação**; validação síncrona no submit. ⚠️
Validar a cada tecla acusa o usuário de errar antes de ele terminar. O schema é o mesmo Zod de
`packages/shared` que a API usa.

**Acessibilidade:** `<label for>` real; `aria-describedby` liga dica e erro; ⚠️ **placeholder nunca
substitui rótulo** (some ao digitar, falha em contraste, quebra tradução).

> ⚠️ **Armadilha: `borda` (`neutro.200`) sobre branco não passa 3:1.** É o token natural, e é
> errado — a borda de campo é elemento de interface e precisa de 3:1 (§6 de `direcao-visual.md`).
> **O repouso do campo usa `borda-forte`.** Consequência aceita: campos ficam mais presentes que
> painéis, o que é correto — campo é alvo, painel é continente.

### 2.3 Select / combobox — `gc-select`

**Variantes:**

| Variante | Quando |
|---|---|
| **Select simples** | ≤ 7 opções fixas (funil, papel, período) |
| **Combobox com busca** | > 7 opções, ou lista que vem do servidor (cliente, produto, número) |
| **Agrupado** | Opções com cabeçalho de grupo (filial → números daquela filial) |
| **Múltipla** | Resultado vira **chips de filtro** (§2.7), não texto concatenado no gatilho |

**Anatomia:** gatilho (valor + `▾`) · painel em overlay (elevação `dropdown`) · [campo de busca] ·
lista · [rodapé com contagem] · [estado vazio próprio].

**Estados:** fechado · aberto · buscando · com resultado · **vazio de busca** ("nenhum item para
`vest`" + limpar) · erro de carga (item único "não foi possível carregar · tentar de novo") ·
desabilitado · **valor único → não é select** (vira rótulo estático, §5.6).

**Acessibilidade:** padrão WAI-ARIA combobox — vem do **Angular Aria** / CDK, não se reimplementa
(§6). Setas navegam, Home/End, digitação salta, Escape fecha **uma** camada, foco volta ao gatilho.

> ⚠️ **Armadilha: busca no cliente sobre lista paginada mente.** Toda lista é paginada server-side
> (ADR-011). Se o combobox carregou 50 de 1.204 clientes e filtra no cliente, ele responde "nenhum
> resultado" para um cliente que existe — e o usuário conclui que o cadastro sumiu.
>
> **Regra:** lista paginada → **busca no servidor**, debounce 250ms, e o rodapé do painel diz sempre
> `mostrando 50 de 1.204`. Busca no cliente só é permitida quando o conjunto **inteiro** está em
> memória, e isso precisa ser verdade por contrato, não por sorte.

### 2.4 Checkbox — `gc-checkbox`

**Anatomia:** caixa 16px (console) / 22px (app) + rótulo clicável. Alvo total conforme §1.6.

**Estados:** desmarcado · marcado · **indeterminado** · foco · desabilitado · erro (grupo obrigatório).

**Acessibilidade:** `<input type="checkbox">` real; grupo em `<fieldset>` com `<legend>`; o
indeterminado é `.indeterminate` + `aria-checked="mixed"`.

> ⚠️ **Armadilha: "selecionar todos" numa lista paginada seleciona a página, e o usuário acha que
> selecionou tudo.** Marcar o cabeçalho de uma tabela com 1.204 linhas carregadas de 50 em 50
> seleciona **50**. Se a ação seguinte for exportar ou disparar campanha, o dano é silencioso.
>
> **Regra:** ao marcar o cabeçalho, aparece uma faixa acima da tabela: *"50 selecionados nesta
> página · **Selecionar todos os 1.204**"*. A seleção total é **explícita**, vira um predicado
> (o filtro atual), não uma lista de ids, e toda ação em lote mostra a contagem no botão de
> confirmação: `Exportar 1.204 contatos`.

### 2.5 Toggle — `gc-toggle`

**Anatomia:** trilho 32×18 (console) / 44×26 (app) + botão + rótulo à esquerda + [descrição de efeito].

**Estados:** ligado (`acao`) · desligado (`borda-forte`) · foco · desabilitado · **aplicando** (o
botão vai para a posição nova, opacidade 0.6, `aria-busy`) · **revertido** (volta + toast de erro).

**Comportamento:** aplicação **imediata e otimista**, com reversão visível e toast nomeado em caso
de falha. ⚠️ **Toggle não tem botão "Salvar".** Se a mudança precisa de confirmação, **não é um
toggle** — é botão + modal.

> ⚠️ **Armadilha: o toggle de preferência do contato tem efeito global e o rótulo não diz isso.**
> `Campanhas` e `Automações` na ficha do cliente (§3.2 das telas) bloqueiam envio em **todos** os
> módulos, inclusive disparo manual em lote. Um toggle chamado "Campanhas" parece um filtro de
> visualização.
>
> **Regra:** todo toggle de efeito não-local carrega uma linha de descrição abaixo do rótulo,
> dizendo o efeito no presente: *"Não recebe nenhum disparo em massa, nem manual"*. E o texto do
> toast de confirmação repete o efeito, não o nome do campo.

### 2.6 Badge — `gc-badge`

**Anatomia:** `[ponto|ícone] rótulo` · altura 20px · texto `rotulo` 11px/500/+0.02em · raio
`completo` · padding 8px. **Não é clicável** — badge clicável é chip (§2.7) ou botão.

| Variante | Aparência | Uso |
|---|---|---|
| **Neutro** | `superficie` + borda + `texto-secundario` | Estágio, tipo, canal, tabela de preço |
| **Estado** | Cor de estado a 12% + texto na cor `700` (claro) / `300` (escuro) | `Ativo`, `Perdido`, `Pagamento ✗` |
| **Contador** | Fundo `acao`, texto `acao-texto`, mín. 20px de largura, tabular | Não lidas, itens por aba |
| **Cadeado (upsell)** | Neutro + `🔒`, opacidade 0.7 | Recurso **não contratado** (PLT-06) — o único caso em que "não disponível" aparece em vez de sumir |
| **Segmento RFV** | §5.2 | Componente próprio, não uma variante |

**Estados:** só repouso. Badge não tem hover, foco nem desabilitado — se precisou, virou outro
componente.

**Acessibilidade:** ⚠️ **badge de contador > 99 mostra `99+` e o `aria-label` traz o número real**
(`143 tarefas vencidas`). Badge de estado nunca depende só de cor — o rótulo **é** a informação, a
cor acelera.

> ⚠️ **Armadilha: badge vira depósito.** Toda tela nova quer "só mais um badge", e a fileira de 5
> vira 9 — o momento exato em que a leitura periférica (§1.4) para de funcionar e a vendedora volta
> a ler item por item. **Teto: 5 badges por item de lista, 4 por card de kanban.** Passou do teto,
> o badge novo entra **substituindo** um, e a substituição é decisão de produto registrada na
> especificação da tela — não do desenvolvedor no momento da implementação.

### 2.7 Chip de filtro — `gc-chip`

**Anatomia:** `campo: valor ✕` · altura 24px · raio `controle` · fundo `superficie` + borda.

⚠️ **Chip representa filtro APLICADO, nunca filtro disponível.** Escolher entre opções é grupo de
botões ou select; o chip é o rastro do que já está valendo, e por isso ele **sempre carrega o
valor**: `Filial: Caruaru`, nunca `Filial`.

**Estados:** aplicado · hover (o `✕` ganha fundo) · foco (o chip inteiro e o `✕` são focáveis
separadamente) · **removendo** (opacidade 0.6 até a busca voltar) · **inválido** (filtro sobre valor
que sumiu — ex.: filial que o usuário perdeu acesso: chip em `atencao` com tooltip e remoção sugerida).

**Comportamento:** remover chip **refaz a consulta no servidor** e reinicia o cursor. Há sempre um
`Limpar filtros` quando há ≥ 2 chips. O conjunto de chips é a fonte da verdade do filtro — e é
serializado na URL no console (⚠️ filtro que não sobrevive ao F5 e ao link colado no WhatsApp da
equipe não serve).

**Acessibilidade:** Backspace/Delete no chip focado remove; foco vai para o chip seguinte, ou para
a barra se era o último. ⚠️ Foco que cai no `<body>` após remover é o defeito clássico.

### 2.8 Avatar — `gc-avatar`

**Anatomia:** círculo · iniciais (2 letras, `rotulo`, peso 600) **ou** foto **ou** ícone de grupo ·
[anel de janela, §5.1] · [ponto de presença].

**Tamanhos:** 24 (tabela, card) · **32 (item de lista — o tamanho do anel)** · 40 (header de
conversa) · 56 (ficha).

**Variantes:** iniciais · foto · **empilhado** (`+3`: até 3 avatares sobrepostos 8px + badge de
contagem).

**Cor das iniciais:** derivada determinística do id do contato sobre uma paleta **neutra e azulada**.
⚠️ **Nunca as cores de estado, de RFV ou de janela.** Um avatar coral ao lado de um anel coral cria
dois significados para a mesma cor no mesmo elemento.

**Acessibilidade:** avatar é `aria-hidden` quando o nome está ao lado (o caso comum). Empilhado leva
`aria-label` com os nomes completos: `Eduarda, Sandy e mais 3`. ⚠️ Foto de contato **não** tem `alt`
descritivo — o nome adjacente já é a informação; `alt=""` evita leitura duplicada.

### 2.9 Tooltip — `gc-tooltip`

**Anatomia:** caixa `superficie-elevada` + borda + elevação `dropdown` · texto `denso` · máx. 280px ·
seta opcional · atraso de entrada **400ms**, saída **0ms**.

**Estados:** oculto · visível por hover · visível por foco (⚠️ **obrigatório** — teclado precisa
alcançar) · fixado (clique no gatilho mantém aberto até Escape).

**Acessibilidade:** `aria-describedby` quando é complemento; `aria-labelledby` quando é o único nome
(ícone-só). Escape fecha. ⚠️ Não fecha ao mover o ponteiro **para dentro** do tooltip.

> ⚠️ **Armadilha: tooltip não existe no app.** Não há hover no toque, e long-press é um gesto que
> ninguém descobre. Toda informação que no console vive em tooltip precisa de **outra casa no app**:
> linha de texto abaixo do controle, folha deslizante, ou o valor exposto direto.
>
> Concretamente: o saldo da célula desabilitada na grade cor × tamanho (§5.7) é tooltip no console e
> **número impresso na célula** no app. ⚠️ E, nas duas superfícies, o tooltip **nunca contém a única
> fonte** de uma informação necessária, nem ação clicável.

---

## 3. Estrutura

### 3.1 Painel — `gc-painel`

**Anatomia:** cabeçalho (`título` · [contador] · [ações à direita]) · [barra de ferramentas] · corpo ·
[rodapé]. Raio `painel` 10px · **borda 1px, sem sombra** — sombra só quando o painel **sobrepõe** algo
(painel de pedido sobre a coluna de contexto).

**Variantes:** fixo · **retrátil** (coluna de contexto do inbox) · rolável com cabeçalho fixo ·
aninhado (blocos da ficha do cliente — ⚠️ **um nível só**; painel dentro de painel dentro de painel
vira caixa russa e come 24px de largura por nível).

**Estados:** os cinco da §1.1 aplicados **ao corpo**, com o cabeçalho **sempre visível** — ⚠️ painel
que some inteiro no erro faz o usuário achar que o bloco não existe.

**Retração:** estado persistido **por usuário no servidor**, não no navegador (ela usa dois
computadores — mesma regra do escopo ativo em `especificacao-telas-entrada.md` §4). Retraído = faixa
de 32px com o título na vertical ou o ícone, e o contador continua visível.

### 3.2 Abas — `gc-abas`

**Anatomia:** trilha horizontal · aba (`rótulo` + `(contador)`) · indicador de 2px na aba ativa ·
painel abaixo.

**Estados:** ativa · inativa · hover · foco · desabilitada (⚠️ raro — aba sem conteúdo mostra estado
vazio, não desabilita) · **contador desconhecido**.

**Comportamento:** a aba ativa vai para a **URL** no console (deep link e F5 preservam). Teclado:
roving tabindex, setas trocam, Home/End; ativação **automática** ao navegar com setas quando o
conteúdo já está carregado, **manual** (Enter) quando a troca dispara consulta.

> ⚠️ **Armadilha: o contador da aba inativa custa uma consulta — e mostrar `0` por preguiça mente.**
> `Agendadas (12) · Vencidas (143) · Concluídas (8)` (§5 das telas) são três agregações. Se a tela
> só carrega a aba ativa, as outras não sabem o número.
>
> **Regra:** os contadores vêm **juntos**, num único agregado, na mesma resposta que abre a tela.
> Se não vierem, a aba mostra `—`, nunca `0` nem o vazio: `Vencidas (0)` esconde exatamente as 143
> tarefas atrasadas que a tela existe para mostrar.

### 3.3 Tabela com cursor — `gc-tabela`

**Anatomia:** cabeçalho fixo (`sticky`) · [coluna de seleção] · [coluna congelada à esquerda] ·
linhas de **32px** · rodapé com contagem carregada e `Carregar mais`.

**Colunas:** texto (esquerda) · **número (direita, tabular)** · **identificador (mono)** · data
(largura fixa) · badge · ações (largura fixa, à direita, aparecem no hover **e no foco**).

**Estados:** os cinco da §1.1 · linha em hover · linha selecionada · linha focada (`outline-offset:
-2px`, §1.5) · **linha nova** (chegou por SSE) · **linha carregando** (ação em andamento naquela
linha, não na tabela).

**Paginação:** **cursor, sempre** (ADR-011). Consequências que o componente precisa assumir:

| ⚠️ | Regra |
|---|---|
| **Não existe "página 3 de 24"** | Cursor não conhece o total. O rodapé diz `243 carregados · Carregar mais` |
| **Ordenar reinicia o cursor** | Ordenação é **server-side** e descarta o que já foi carregado. O componente rola para o topo e avisa se havia seleção |
| **Total exato é caro** | Quando exibido, vem de agregação separada e é rotulado (`~1.200`) ou omitido. Total que discorda da lista é pior que total ausente |

> ⚠️ **Armadilha: a linha se reordena sozinha embaixo do cursor do mouse.** A tabela recebe eventos
> por SSE o dia inteiro. Se a ordenação é "última mensagem" e uma mensagem chega, a linha que a
> vendedora ia clicar pula de posição — e ela clica na errada. Em tela de 8 horas, isso acontece
> várias vezes por dia.
>
> **Regra:** dado que chega por evento **atualiza o conteúdo da linha in-place**; **não reordena e
> não insere** enquanto a lista está com foco ou com o ponteiro dentro dela. Item novo entra numa
> faixa no topo — *"3 novas conversas · mostrar"* — e a reordenação acontece no clique, ao sair da
> tela, ou após 10s sem interação. E `track` por id é obrigatório em toda lista.

### 3.4 Barra lateral — `gc-menu-lateral`

**Anatomia:** logo/tenant · [seletor de filial] · itens de nível 1 (ícone 18px + rótulo + [badge]) ·
subitens de nível 2 (recuo 12px, sem ícone) · rodapé (usuário, tema, sair).

**Tamanhos:** 240px expandida · **56px colapsada** (só ícones + tooltip). Estado persistido por
usuário no servidor.

**Estados do item:** repouso · hover · **ativo** (fundo `superficie-selecionada` + barra de 2px em
`acao` à esquerda) · **ativo-pai** (subitem ativo → o pai fica marcado, não some) · foco · com badge.

**Regras:** ⚠️ **item sem permissão não aparece** (§1.1); item de recurso não contratado aparece com
cadeado. Máximo **dois níveis** — o terceiro nível é a tela, não o menu. **Link "pular para o
conteúdo"** antes do menu (⚠️ a vendedora não deve tabular 20 itens para chegar na lista de conversas).

### 3.5 Cabeçalho de tela — `gc-cabecalho-tela`

**Anatomia (duas faixas):**

```
┌──────────────────────────────────────────────────────────────────┐
│ Título da tela   [contador]        [escopo ▾]  [ação sec.] [AÇÃO] │  48px
├──────────────────────────────────────────────────────────────────┤
│ [busca]  [filtro ▾] [filtro ▾]   · chips aplicados ·   [exportar] │  40px (opcional)
└──────────────────────────────────────────────────────────────────┘
```

**Estados:** normal · carregando (⚠️ **a altura não muda** — o título vira esqueleto no mesmo espaço;
cabeçalho que cresce ao carregar faz a tela inteira pular) · com filtros aplicados (segunda faixa
sempre visível enquanto houver chip) · rolado (sombra `dropdown` aparece só quando há conteúdo por
baixo).

⚠️ **Uma ação primária, à direita, sempre no mesmo lugar em todas as telas.** É o único elemento do
produto cuja posição a vendedora aprende em minutos.

---

## 4. Feedback

### 4.1 Toast — `gc-toast`

**Anatomia:** ícone de tipo · mensagem (1–2 linhas) · [ação] · [✕] · [trilho de tempo de 2px].

**Posição:** console — canto **inferior direito**, empilhando para cima; app — **acima** da tab bar,
com gesto de descarte.

| Tipo | Duração | Ação |
|---|---|---|
| Sucesso | 4s | — |
| **Com desfazer** | **5s exatos** | `Desfazer` + atalho `Ctrl+Z` (⚠️ §6.1 de `direcao-visual.md`) |
| Aviso | 6s | opcional |
| Erro recuperável | **não fecha sozinho** | `Tentar de novo` |

**Regras:** máximo **3** empilhados; o 4º substitui o mais antigo. Toasts idênticos **agregam**
(`3 mensagens não enviadas`), não empilham. Hover/foco **pausa** o cronômetro.

**Acessibilidade:** `role="status"` (`aria-live="polite"`) para sucesso e informação; `role="alert"`
só para erro. ⚠️ `alert` interrompe a leitura em curso — usar em confirmação de rotina treina a
vendedora a ignorar o leitor de tela.

> ⚠️ **Armadilha: erro que exige decisão não cabe em toast.** O toast some, e a decisão vai embora
> com ele. Falha de envio de pedido, crédito bloqueado, queda de qualidade do número — nada disso é
> toast. **Erro que exige ação é inline (no campo), banner (no bloco) ou modal (bloqueante).** Toast
> é para o que já aconteceu e deu certo, ou para o que pode ser desfeito.

### 4.2 Modal e folha — `gc-modal` · `gc-folha`

**Anatomia:** véu (`rgba(13,24,48,0.5)`) · caixa (elevação `modal`, raio `painel`) · cabeçalho
(título + ✕) · corpo rolável · rodapé (ações à direita, primária por último).

**Tamanhos:** `sm` 400px (confirmação) · `md` 560px (formulário) · `lg` 800px (drill-down de
categorias). App: **folha deslizante** de baixo para cima, com pontos de parada (50% / 90%) e alça.

**Variantes:** informativo · **de confirmação** · de formulário · **bloqueante** (não fecha por véu
nem Escape) · **em passos** (pedido no mobile, §2.6 das telas — indicador de passo no cabeçalho).

**Estados:** entrando (200ms) · aberto · corpo carregando (esqueleto **dentro** do modal, com o
cabeçalho e o rodapé já presentes) · enviando (ações desabilitadas, primária em `carregando`) · erro
(inline no corpo, ⚠️ **o modal não fecha**) · saindo.

**Acessibilidade:** foco preso (`cdkTrapFocus`), foco inicial no primeiro campo ou na caixa,
**retorno ao elemento de origem** ao fechar, `role="dialog"` + `aria-modal`, Escape fecha **uma
camada, nunca duas** (§6.1 de `direcao-visual.md`), rolagem do fundo travada.

> ⚠️ **Armadilha: bloquear por reflexo.** A §4.2 das telas é explícita — **o motivo de descarte é o
> único caso de modal bloqueante justificado do produto**. Confirmação bloqueante para ação
> reversível é imposto de atenção cobrado dezenas de vezes por dia; ação reversível usa **toast com
> desfazer de 5s**.
>
> **Teste:** se existe desfazer, não existe confirmação. ⚠️ E o "descartar alterações?" só aparece
> quando o formulário **está realmente sujo** — comparar valores, não confiar em "o usuário tocou
> no campo".

### 4.3 Esqueleto de carregamento — `gc-esqueleto`

**Anatomia:** blocos de `superficie-hover` com o raio do elemento real. **Um esqueleto por forma**,
não um genérico:

| Forma | Composição |
|---|---|
| Item de conversa | Círculo 32 + linha 60% + linha 40% + 3 retângulos de badge · **repetido 10×** |
| Linha de tabela | Retângulos com as **larguras reais das colunas**, altura 32px · 12× |
| Card de kanban | Acento lateral + 4 linhas + fileira de badges · 5× |
| KPI | Rótulo 40% + bloco 32px |
| Balão de mensagem | Balões alternados esquerda/direita, larguras variadas · 6× |

**Regras:** a **contagem** importa tanto quanto a forma — 3 esqueletos onde vêm 10 itens produz um
salto de layout. O container leva `aria-busy="true"` e o esqueleto é `aria-hidden`.

> ⚠️ **Armadilha: o esqueleto do GeraCRM é ESTÁTICO — e isso exige compensação.** O brilho animado
> é o padrão de mercado e é um **loop**; a regra da identidade (§6) é que nada anima em loop exceto
> o anel de janela. Mantemos a regra: sem shimmer, sem pulso.
>
> Compensações obrigatórias, porque esqueleto parado pode ser confundido com conteúdo real:
> - Cor `superficie-hover` — visivelmente distinta de superfície **e** nunca contendo texto;
> - `aria-busy="true"` no container, sempre;
> - **acima de 2s**, o esqueleto ganha uma linha de texto discreta (`carregando…`);
> - ⚠️ **acima de 10s isso deixa de ser carregamento e vira erro** — o bloco troca para estado de
>   erro com `Tentar de novo`. Esqueleto eterno é a falha que ninguém reporta e todos xingam.

### 4.4 Estado vazio — `gc-vazio`

**Anatomia:** ícone 24px (opcional, neutro) · título que **diz o motivo** · uma linha de contexto ·
**ação primária**. ⚠️ **Sem ilustração** (identidade §9): ela ocupa o espaço onde deveria estar a
ação seguinte.

**Variantes — e o motivo é o que as separa:**

| Variante | Título | Ação |
|---|---|---|
| **Primeira vez** | "Nenhuma campanha criada ainda" | `Criar campanha` |
| **Vazio por filtro** | "Nenhuma conversa com os filtros aplicados" | `Limpar filtros` (⚠️ **listando quais**) |
| **Vazio por recorte** | "Nenhuma conversa neste número nos últimos 30 dias" | `Buscar por nome ou protocolo` |
| **Vazio comemorativo** | "Nenhuma tarefa agendada 🎉" | `Ver 143 vencidas` — ⚠️ a fila vazia **não é o fim**; há trabalho atrasado |
| **Vazio por escopo sem acesso** | "Seu acesso ainda não foi liberado" | Nomeia o administrador |

⚠️ **"Nenhum resultado" isolado é proibido** e deve ser barrado na revisão. O estado vazio é o único
momento em que o produto tem 100% da atenção do usuário sem competição — desperdiçá-lo com uma frase
neutra é escolha, não descuido.

### 4.5 Estado de erro — `gc-erro`

**Três escalas, e a escolha entre elas é a decisão principal:**

| Escala | Quando | Forma |
|---|---|---|
| **Campo** | Validação de entrada | Mensagem sob o campo, borda `borda-erro` |
| **Bloco (parcial/degradado)** | O principal carregou, o secundário falhou | Faixa **dentro** do painel; o resto da tela funciona |
| **Tela** | Nada carregou | Bloco centrado com ação; ⚠️ **o cabeçalho permanece** — a navegação nunca desaparece |

**Anatomia:** ícone `erro` · título que **nomeia a origem** · uma linha sobre recuperabilidade ·
ação(ões) · rodapé com **id de correlação copiável**.

| ⚠️ | Regra |
|---|---|
| Nomear a origem | *"A conexão **{nome da conexão ativa}** não respondeu"* — vindo de **`detalhe.origem.nome`** (o rótulo que o tenant deu: *"ERP da matriz"*), **nunca** `origem.conector` nem o nome do ERP escrito no código (§2.1 das telas) |
| Nunca mostrar o cru | Mensagem do ERP e código HTTP não vão para a tela; vão para o id de correlação e para o Sentry |
| Recuperável ≠ retentável | ⚠️ **`502` oferece `Tentar de novo`; `504` NÃO oferece** (§2.4 das telas). Em timeout o pedido pode existir no ERP, e o botão de retentar produz pedido duplicado. O componente aceita `retentavel: boolean` **vindo do servidor** — a tela não decide isso |
| Erro de permissão | Não é estado de erro. O elemento **não existe** (§1.1) |

### 4.6 Progresso — `gc-progresso`

**Variantes:** barra determinada · barra indeterminada · **passos nomeados** · circular pequeno
(dentro de botão).

**Anatomia:** trilho 4px · preenchimento `acao` · [rótulo `12 de 47`] · [detalhe] · [ação `Pausar`].

**Estados:** ocioso · em andamento · **pausado** (throttle de número, §12 das exigências) · concluído
(mantém 100% por 1s e some) · **falhou parcialmente** (⚠️ barra em `atencao` com `43 enviadas · 4
falharam · Ver falhas` — nunca some sem prestar contas) · cancelado.

| ⚠️ | Regra |
|---|---|
| **Indeterminado tem prazo** | Só até 2s. Acima disso vira determinado ou **passo nomeado** (`Lote 3 de 7`) — carga histórica de anos não pode ser uma barra girando |
| **Progresso não anda para trás** | Se o total muda (mais lotes descobertos), o **rótulo muda junto** e explica. Barra que recua destrói a confiança no número |
| **Pausa por throttle não é erro** | Disparo de campanha pausado pelo limite do número mostra `retomando em 4min`, em `atencao` — não em `erro` |

**Acessibilidade:** `role="progressbar"` com `aria-valuenow/min/max`; para processos longos, um
`role="status"` anuncia **marcos** (25/50/75/100%), ⚠️ nunca cada incremento.

### 4.7 Banner — `gc-banner`

Persistente, **dentro do bloco afetado**, com ação. É o que o toast não pode ser.

**Casos canônicos:** erro de conexão do número (**no topo da lista de conversas, não em modal** —
§1.2 das telas) · saldo do ERP em modo degradado com horário (§5.7) · saúde do número desatualizada ·
recurso não contratado.

**Variantes:** informação · atenção · erro · **degradado** (a mais usada: fundo `superficie`, ícone
`atencao`, com o **horário da última apuração** — ⚠️ *"saúde desatualizada rotulada é útil; saúde em
branco é inútil"*, §6.4 de `especificacao-telas-entrada.md`).

**Estados:** visível · dispensável (✕, e a dispensa é lembrada por sessão) · **não dispensável**
(enquanto a condição existir).

---

## 5. Domínio

Os componentes que só existem neste produto. ⚠️ Cada um existe **duas vezes** (ADR-010) — a ficha é
o contrato entre as duas.

### 5.1 ⚠️ Anel de janela — `gc-anel-janela`

**O elemento assinatura** (identidade §5, ADR-012). Toda conversa de WhatsApp tem uma janela de 24h;
passou, só template aprovado. É a regra que mais afeta o trabalho da vendedora — e a que ela mais
precisa perceber **sem parar para ler**.

#### 5.1.1 Três formas, uma lógica

| Forma | Onde | Geometria |
|---|---|---|
| **Anel** | Ao redor do avatar de 32px na lista de conversas | Traço 2px, drena no **sentido horário** a partir das 12h |
| **Barra** | Topo do painel de conversa | Altura 2px, largura total, drena da **direita para a esquerda** |
| **Ponto** | Card de kanban, item de fila, qualquer lugar com < 24px | Círculo cheio de 6px, **sem fração** — só a faixa de cor |

Todas leem a mesma entrada: `janelaExpiraEm` (ISO, do servidor) → fração restante `f ∈ [0,1]` sobre
as 24h.

#### 5.1.2 Faixas

| Condição | Token | Anel | Texto de apoio |
|---|---|---|---|
| Restam > 2h | `janela.aberta` (turquesa) | Arco turquesa sobre trilho | `Janela aberta · faltam 6h40` |
| Restam ≤ 2h (`janela.limite-atencao-horas`) | `janela.terminando` (âmbar) | Arco âmbar | `Janela aberta · faltam 1h12` |
| Expirou | `janela.fechada` (coral) | **Sem arco** — o trilho inteiro fica coral | `Janela fechada` |

Trilho: `janela.trilho-claro` / `janela.trilho-escuro`, **sempre visível** — é ele que faz o arco
significar "quanto falta" em vez de "quanto tem".

A troca de faixa é **corte de 120ms**, não interpolação de cor. ⚠️ Interpolar turquesa→âmbar produz
um verde-amarelado sem significado durante minutos.

#### 5.1.3 Geometria do anel (as duas superfícies desenham igual)

Círculo de raio `r = (32 − 2)/2 = 15`, circunferência `C = 2πr`, traço 2px, `stroke-linecap: butt`,
girado −90° para começar às 12h:

```
stroke-dasharray  = "{C·f} {C}"
stroke-dashoffset = "{-C·(1-f)}"
```

Assim o **vazio** nasce às 12h e cresce no sentido horário; o arco restante termina sempre às 12h.
⚠️ `linecap: round` é proibido: com `f` pequeno, a ponta arredondada desenha mais arco do que existe
— o indicador passa a mentir exatamente quando mais importa.

#### 5.1.4 ⚠️ Um relógio, não trezentos

**A armadilha de implementação nº 1.** Uma lista com 300 conversas visíveis, cada uma com o próprio
`setInterval`, é o que trava a aba na terceira hora de uso.

**Regra:** existe **um único relógio compartilhado** por aplicação (signal no console, store no app).
Ele emite e todos os anéis derivam. Cadência:

| Superfície | Tick | Por quê |
|---|---|---|
| Lista (anel) | **60s** | Em 24h o arco anda 0,25°/min — abaixo do perceptível |
| Header (barra + texto) | **30s** | O texto em minutos precisa parecer vivo |
| Últimos 5 minutos | **5s** | E só aí o texto mostra segundos |

#### 5.1.5 ⚠️ O relógio do cliente está errado

Máquina de escritório com hora dessincronizada é comum, e um desvio de 20 minutos faz o produto
dizer "janela aberta" quando a Meta já recusa a mensagem.

**Regra:** no boot, guardar `offset = Date do header da resposta − Date.now()` e aplicá-lo em todo
cálculo. ⚠️ E, na dúvida, **o componente é conservador**: se o cliente calcula "aberta" e o servidor
recusa o envio, o composer bloqueia imediatamente com o motivo do servidor — o anel corrige em
seguida. O contrário (cliente diz "fechada" e havia janela) é resolvido pela próxima mensagem
recebida, que reabre a janela por definição.

#### 5.1.6 A transição para "fechada" é um evento, não um redesenho

Quando `f` cruza zero com a conversa aberta na tela: o composer troca de modo **sem recarregar** e
**sem perder o rascunho** (§1.3 das telas e skill do console). ⚠️ O anel **não é a fonte do evento** —
ele e o composer leem o mesmo relógio; o anel que "avisa" o composer é acoplamento de apresentação
com regra.

#### 5.1.7 `prefers-reduced-motion`

Aqui há uma sutileza que costuma ser mal implementada: **o anel não anima — ele redesenha a cada
tick**. Não há transição CSS entre valores de `dashoffset` (com 60s de tick, animar seria pior).

Sob `prefers-reduced-motion`:

| Continua | Para |
|---|---|
| A **faixa de cor** (turquesa → âmbar → coral) — é informação, não movimento | O **tick**: o arco vira estático, atualizado só quando o componente re-renderiza por outro motivo (nova mensagem, troca de tela) |
| O **texto** de tempo restante, atualizado nos mesmos momentos | Toda transição de 120ms |

#### 5.1.8 ⚠️ Nunca a única fonte

| Superfície | Fonte textual obrigatória |
|---|---|
| Header da conversa | Texto sempre visível: `Janela aberta · faltam 4h12` / `Janela fechada` |
| Lista de conversas | O anel + o `aria-label` do item (`janela aberta, faltam 4 horas e 12 minutos`). ⚠️ E, **nas últimas 2h, o tempo aparece em texto** ao lado do horário — porque é quando a distinção turquesa/âmbar precisa parar de ser a única |
| Card / item com ponto | Sempre acompanhado de badge textual `Janela fechada` quando fechada |

**Acessibilidade:** o desenho é `aria-hidden` (SVG decorativo). A mudança de faixa é anunciada
**uma vez por faixa** via `role="status"` no header (`Janela entrando nas últimas 2 horas`) —
⚠️ nunca a cada tick.

#### 5.1.9 Custo de render

O anel é o componente mais instanciado do produto. Console: um `<svg>` com dois `<circle>`, sem
filtro, sem sombra; o `dashoffset` sai de um `computed` do signal do relógio, e o item de conversa
**não** re-renderiza inteiro por causa dele. App: `react-native-svg` com o mesmo desenho, memoizado,
assinando o relógio **dentro** do anel — ⚠️ passar `f` por prop desde a lista re-renderiza a lista
inteira a cada minuto.

### 5.2 Badge de segmento RFV — `gc-badge-rfv`

**Anatomia:** ponto de 6px na cor da faixa + rótulo. Altura 20px, texto `rotulo`.

**As 11 faixas, na ordem da rampa** (a ordem **é** informação — `tokens.json → rfv`):

| # | Token | Rótulo padrão (perfil Moda Atacado) |
|---|---|---|
| 1 | `rfv.campeao` | Campeão |
| 2 | `rfv.cliente-fiel` | Cliente Fiel |
| 3 | `rfv.potencial-fiel` | Potencial Fiel |
| 4 | `rfv.cliente-promissor` | Cliente Promissor |
| 5 | `rfv.cliente-recente` | Cliente Recente |
| 6 | `rfv.nao-perder` | Não Perder |
| 7 | `rfv.em-risco` | Em Risco |
| 8 | `rfv.precisa-atencao` | Precisa de Atenção |
| 9 | `rfv.semi-perdido` | Semi-Perdido |
| 10 | `rfv.hibernando` | Hibernando |
| 11 | `rfv.perdido` | Perdido |

**Três apresentações — e nenhuma delas é abreviação:**

| Apresentação | Quando | Conteúdo |
|---|---|---|
| **Completa** | Ficha, fila do dia, coluna de tabela | Ponto + rótulo inteiro |
| **Compacta** | Card de kanban, item de lista | Ponto + rótulo truncado com `…` + `title` completo |
| **Mínima** | Onde não cabe rótulo nenhum | Ponto de 8px + `aria-label` completo — ⚠️ **só onde outro texto já identifica o cliente** |

> ⚠️ **Armadilha: a tentação de abreviar em duas letras.** `CA · CF · CP · CR` — quatro faixas
> começando com "C" numa rampa de 11. Abreviação de 2 letras é **pior que ponto sem texto**: o ponto
> não promete significado, a sigla promete e entrega ambiguidade. **Não abreviamos.** Se não cabe o
> rótulo, cabe menos informação, não informação errada.

**Outras regras:**

- ⚠️ **Nunca só cor** (identidade §3): 8% dos homens têm alguma deficiência de percepção de cor, e a
  rampa tem 11 passos — nem quem enxerga bem distingue `Semi-Perdido` de `Hibernando` por cor.
- O **rótulo é configurável pelo perfil de vertical** (ADR-004); a **posição na rampa não é**. O
  componente recebe a faixa canônica e busca o rótulo do perfil.
- ⚠️ **Faixa desconhecida degrada, não quebra** (mesma filosofia do ADR-008): faixa que a API mandou
  e o front não conhece renderiza **neutra, com o rótulo cru**. Nunca "sem segmento", nunca vazio.
- No **escuro**, a rampa inteira é reverificada (§5.3 de `direcao-visual.md`) — as 11 precisam
  continuar distinguíveis, e o texto do badge muda para o degrau `300`.

### 5.3 Card de kanban — `gc-card-kanban`

**Anatomia** (§4.1 das telas — leitura em três segundos):

```
┃ CIRLANEIDE                        ⭐    ← acento lateral 3px = cor RFV
┃ +55 (88) 99965-3875                      (mono)
┃ 📅 Última compra: 17/07/2026
┃ Responsável: [EDUARDA] · 0 min           ← tempo sem toque: o dado mais acionável
┃ Está no telefone: Eduarda, Sandy +3
┃ [CE] [Campeão] [R$ 70.238] [Ativo]  ⧉    ← fileira de badges, SEMPRE a última linha
```

**Tamanhos:** largura da coluna − 16px · altura mín. 112px, variável (⚠️ o kanban **não virtualiza**,
ADR-010 §5 — altura fixa não é requisito, mas a **fileira de badges na última linha** é, porque é
ela que o gestor varre verticalmente).

**Estados:** repouso · hover (elevação `dropdown`) · foco · selecionado · **arrastando** (elevação
`modal`, opacidade 0.9, rotação 0°) · **destino** (placeholder tracejado na coluna alvo) ·
**soltando** (otimista + toast de desfazer 5s) · **revertendo** (volta com toast de erro nomeado) ·
**não arrastável**.

> ⚠️ **Armadilha 1: o card do Funil de Relacionamento NÃO pode aceitar o gesto.** `1 pedido`,
> `2 pedidos`, `3+ pedidos` são **derivadas do histórico de compras** (§4.3 das telas). Se o card
> aceita o arrasto e volta sozinho, o usuário conclui que o produto está quebrado.
>
> **Regra:** ausência de arrasto é **estrutural, não visual** — o card não recebe a diretiva de
> arrasto, não muda o cursor, não mostra alça e não responde ao gesto de toque. As ações vivem no
> próprio card (`Trabalhar`, `Descartar`, `Qualificar`). Mover para `Representantes` e `Descartados`
> — que são **estados atribuídos** — continua permitido.

> ⚠️ **Armadilha 2: dois canais de cor concorrentes no mesmo card.** O acento lateral de 3px é a cor
> RFV, e é a única coisa que o gestor lê ao varrer uma coluna de 200 cards. Se "selecionado" ou
> "urgente" também pintar a borda, a coluna deixa de ser gráfico.
>
> **Regra: o acento lateral é EXCLUSIVO do RFV.** Seleção = fundo `superficie-selecionada` + borda
> 1px `borda-foco`. Urgência = badge, não cor de borda. Janela = **ponto** (§5.1), não acento.

### 5.4 Balão de mensagem — `gc-balao`

**Anatomia:** [autor, quando o número é compartilhado] · [citação da mensagem respondida] · corpo
(texto / mídia / documento) · rodapé (`hora` + **status**, só em enviadas) · [marca de campanha] ·
[marca de IA].

**Ancoragem:** recebida à esquerda (`superficie`), enviada à direita (`superficie-elevada` + borda).
Largura máx. 560px ou 78% da coluna, o que for menor. Agrupamento por autor (cauda só no último) e
separador de dia fixo (`sticky`).

**Marcas:**

| Marca | Aparência | Regra |
|---|---|---|
| **Campanha** | Faixa superior fina + nome da campanha | Toda mensagem nascida de disparo |
| **IA** | Ponto/borda `violeta` + `IA` | ⚠️ Decisão de produto (identidade §3): a vendedora precisa saber num relance quem conduziu |
| **Template** | Rótulo com o nome do template | Enviadas fora da janela |

**Status de entrega (só em enviadas):**

| Estado | Ícone | Cor |
|---|---|---|
| Enfileirada | 🕐 | `texto-suave` |
| Enviada | ✓ | `texto-secundario` |
| Entregue | ✓✓ | `texto-secundario` |
| Lida | ✓✓ | `acao` (⚠️ token, não "azul do WhatsApp") |
| **Falha** | ⚠ | `erro` — clicável, abre o motivo |

> ⚠️ **Armadilha 1: o status regride.** Os webhooks de status da Meta chegam **fora de ordem** — o
> `read` pode chegar antes do `delivered`. Aplicar o último recebido faz o ✓✓ azul virar ✓✓ cinza na
> frente da vendedora, e ela reporta como bug de entrega.
>
> **Regra:** o status é **monotônico**. Ordem canônica `enfileirada < enviada < entregue < lida`, e
> o cliente aplica `max(atual, recebido)`. **Falha é o único estado que quebra a monotonicidade** —
> e só a partir de `enfileirada`/`enviada`.

> ⚠️ **Armadilha 2: o balão com falha some ou muda de lugar.** Ele **nunca some** (§1.5 das telas) e
> **nunca reordena**: mantém a posição temporal em que foi criado, com `⚠` e `Tentar de novo`. Se
> ele fosse para o fim da lista a cada tentativa, a vendedora perderia o rastro da conversa. A
> ordenação é `(timestamp, id)` — desempate estável, porque duas mensagens no mesmo segundo são
> rotina.

**Acessibilidade:** o corpo de mensagens é `role="log"` com `aria-live="polite"` — anuncia a
**mensagem nova recebida**, ⚠️ nunca a atualização de status (senão o leitor fala o dia inteiro).
O status vai no texto acessível do balão: `enviada 09:13, lida`.

### 5.5 Player de áudio com transcrição — `gc-audio`

**Anatomia:** `▶` 28px · barra de progresso com posição arrastável · `0:12 / 0:47` (tabular) ·
`1×` (velocidade) · `⌄ Transcrição` · [bloco de transcrição].

**Estados do áudio:** **não carregado** (só duração — ⚠️ ver armadilha) · carregando · tocando ·
pausado · concluído (volta a 0) · **erro de mídia** (`Áudio indisponível · Tentar de novo`).

**Estados da transcrição** (IA-03) — quatro, e são diferentes:

| Estado | Exibição |
|---|---|
| **Indisponível** (recurso não contratado) | Nada. O botão não existe (§1.1) |
| **Em processamento** | `Transcrevendo…` com o botão inerte |
| **Falhou** | `Não foi possível transcrever` + `Tentar de novo` |
| **Pronta** | Botão expande o texto, marcado como **gerado por IA** (`violeta`) |

**Comportamento:** velocidade persiste **por usuário**; posição não persiste. Teclado: Espaço
alterna, setas ±5s, `M` silencia.

> ⚠️ **Armadilha 1: 200 áudios pré-carregados estouram a memória da aba.** Uma conversa de atacado
> tem centenas de áudios; `preload="auto"` num histórico rolado para trás consome centenas de MB.
> **Regra:** `preload="none"`; a duração vem dos **metadados da mensagem** (do servidor), não do
> arquivo. O áudio só é buscado no primeiro `play`.

> ⚠️ **Armadilha 2: dois áudios tocando juntos.** Regra: **barramento global de reprodução** — um
> áudio por aplicação; dar `play` pausa o anterior, em qualquer conversa, e sair da conversa pausa.

> ⚠️ **Armadilha 3: a transcrição vira "o que o cliente disse".** É saída de modelo, e ela erra em
> número, em nome próprio e em referência de produto — exatamente o que vira pedido. **Regra:** a
> transcrição é sempre **rotulada como IA**, o áudio permanece a fonte, e o texto transcrito
> **nunca** é copiado para o pedido sem passar pela vendedora. Para leitor de tela, a transcrição é
> a alternativa textual — e por isso o botão de expandir é `<button aria-expanded>` real, não um
> `div` com clique.

### 5.6 Seletor de número da frota — `gc-seletor-numero`

**Anatomia do gatilho:** `● (Janaina) · 55 81 91400-9000 ▾` — ponto de saúde + nome amigável +
número em **mono**.
**Item do painel:** ponto · nome · número · filial · responsável · **estado compacto**.

**Estados do ponto** (agrega as **cinco condições independentes** da §6.1 de
`especificacao-telas-entrada.md`):

| Ponto | Significa | O item mostra |
|---|---|---|
| `●` turquesa | Pronto para enviar | — |
| `⚠` âmbar | Envia, com restrição | A condição pelo nome: `verificação`, `qualidade` |
| `✗` coral | **Não envia** | A condição pelo nome: `pagamento`, `desconectado`, `disparo pausado` |
| `○` neutro | Saúde desconhecida | `estado não apurado · há 12min` |

> ⚠️ **Armadilha 1: um selo único esconde o que resolve o problema.** São cinco condições com cinco
> reparos diferentes. O ponto **agrega para a varredura**; o item **nomeia a condição que falhou**,
> porque "pagamento ausente na conta Meta" e "qualidade baixa" não têm nada em comum além da cor.

> ⚠️ **Armadilha 2: ponto verde otimista quando a saúde não carregou.** Estado parcial (§4.2 de
> `especificacao-telas-entrada.md`): a lista de números carregou e a saúde não. **O item aparece sem
> ponto**, com aviso localizado — nunca com o ponto verde por omissão. Verde falso faz a vendedora
> descobrir que o número não envia só depois de tentar.

**Outras regras:**

- ⚠️ **Um número só → rótulo estático**, não seletor desabilitado (§1.1).
- ⚠️ **Não é fronteira de segurança** — filtra o que já é permitido; a autorização é do caso de uso.
- **Trocar de número** cancela as assinaturas SSE do anterior, assina o novo, e **preserva rascunho
  de pedido e texto do composer** (eles pertencem à conversa, não ao recorte).
- **Mudança vinda da Meta** (qualidade, tier, pagamento) chega por SSE e **atualiza o item ao vivo**.
- **App:** folha deslizante de baixo para cima, alvos de 44px, saúde visível — é no celular que ela
  descobre que o envio parou.

### 5.7 Grade cor × tamanho — `gc-grade`

**A peça mais complexa do produto.** Matriz de quantidade por SKU-cor-tamanho dentro do painel de
pedido (§2.2 das telas).

#### 5.7.1 Anatomia

```
┌──────────────────────────────────────────────────────────┐
│ [foto] 22625  CONJUNTO LAILA          R$ 146,00 un       │  ← ref. em mono
├───────┬──────┬──────┬──────┬──────┬──────────────────────┤
│       │ P38  │ M40  │ G42  │ GG44 │  total da cor        │
│ ROSA  │  1   │  2   │  2   │  ▨   │        5             │
│ VERDE │      │  1   │  3⚠  │  ▨   │        4             │
│ PRETO │  ▨   │  ▨   │  ▨   │  ▨   │        —             │
├───────┼──────┼──────┼──────┼──────┼──────────────────────┤
│ total │  1   │  3   │  5   │  —   │  9 peças · R$ 1.314  │
└───────┴──────┴──────┴──────┴──────┴──────────────────────┘
  ⚠ VERDE G42: pedido 3, disponível 1
```

Linhas = cor · colunas = tamanho · **coluna de cor congelada** · totais por linha, por coluna e do
item · rodapé com preço e subtotal.

#### 5.7.2 Estados da célula — cinco, e três deles são confundidos

| Estado | Aparência | Significado | Ação da vendedora |
|---|---|---|---|
| **Vazia** | Em branco (⚠️ **não** `0` — zero em 40 células é ruído) | Não pedido | Digitar |
| **Preenchida** | Número, tabular, centrado | Pedido | — |
| **Sem saldo** | Fundo `superficie`, inerte, tooltip `0 disponível` | O SKU existe, o estoque acabou | **Esperar ou substituir** |
| **Saldo insuficiente** | Borda `atencao` + `⚠` + disponível | Pediu mais do que há | **Ajustar a quantidade** |
| **Inexistente** | Hachura `▨`, sem campo | Essa combinação cor × tamanho **não é fabricada** | **Nunca vai existir** |

> ⚠️ **Armadilha 1: "esgotado" e "não existe" desenhados igual.** São informações opostas, e a
> vendedora age de forma diferente em cada uma: uma ela promete para a próxima semana, a outra ela
> substitui na hora. Se as duas forem "célula cinza desabilitada", ela promete o que nunca vai
> existir. **Regra: hachura para inexistente, fundo liso + tooltip de saldo para esgotado.** E, no
> app, onde não há tooltip, **o saldo é impresso na célula** (§2.9).

#### 5.7.3 ⚠️ Armadilha 2: saldo ao vivo é uma **capacidade**, não um dado garantido

O ADR-008 é explícito: cada conector **declara** suas capacidades e o produto **degrada em vez de
quebrar**. O GeraCloud tem `saldoSincrono`; Bling, Tiny e ERPs de polo podem não ter.

| Capacidade | Comportamento da grade |
|---|---|
| `saldoSincrono: true` | Saldo consultado durante a montagem; célula sem saldo **desabilitada** |
| `saldoSincrono: false` | ⚠️ **Nenhuma célula é desabilitada.** A grade mostra o saldo da **última sincronização com o horário**, banner degradado (§4.7) no topo do item, e a validação **migra para a efetivação** |

⚠️ **Desabilitar célula por dado velho impede a venda de peça que existe** — o oposto do que o
produto quer. Grade cinza por sincronização de ontem é um bug de negócio com aparência de cuidado.

#### 5.7.4 ⚠️ Armadilha 3: o saldo muda enquanto ela monta

O estoque cai durante a montagem (outra vendedora, outro canal). **A quantidade digitada NUNCA é
alterada pelo sistema.** A célula passa a `saldo insuficiente`, o bloco de validação ganha a linha
(`VERDE G42: pedido 3, disponível 1`), e a decisão é dela. Corrigir sozinho o número que a vendedora
digitou depois de combinar com o cliente é o comportamento que faz o módulo ser abandonado.

#### 5.7.5 Teclado — a grade é **um** ponto de tabulação

⚠️ Uma matriz de 6 cores × 8 tamanhos são **48 células**. Tabular célula a célula significa 48 `Tab`
para atravessar um item, e um pedido tem vários itens.

**Regra: padrão WAI-ARIA `grid` com roving tabindex.** `Tab` entra na grade e sai dela; **as setas
navegam por dentro**; `Enter` desce, `Shift+Enter` sobe, `Home`/`End` vão ao extremo da linha,
`Ctrl+Home`/`Ctrl+End` à primeira/última célula. Digitar **substitui** o valor (não concatena);
`Delete` limpa. Células inexistentes e sem saldo são **puladas** na navegação.

#### 5.7.6 Grade fechada

Produto vendido em grade fechada (`P38+M40+G42`) não desabilita células individuais — a validação é
que diz o que falta (`falta 1 P38`). O componente oferece **`Completar grade`** por linha de cor, que
preenche o mínimo faltante. ⚠️ **A regra de grade fechada vem do servidor** (`packages/shared` /
perfil de vertical), nunca de uma lista no front.

#### 5.7.7 Tamanhos, mobile e desempenho

| | Console | App |
|---|---|---|
| Célula | 44 × 36px | **44 × 44px** (§1.6) |
| Rolagem | Vertical no painel | **Horizontal**, com a coluna de cor congelada |
| Total por cor | Coluna à direita | ⚠️ **Junto do nome da cor, à esquerda** — em rolagem horizontal a coluna da direita some, e a soma por cor é o que ela confere |
| Teclado | Numérico do sistema | `keyboardType="number-pad"`, `returnKeyType="next"` |

**Desempenho:** 12 cores × 10 tamanhos = 120 campos. ⚠️ Recalcular o pedido inteiro a cada tecla
trava a digitação. **Total do item = soma local, imediata. Revalidação do pedido (mínimo, mix,
crédito, saldo) = debounce de 200ms.** O estado da grade é local ao componente; o rascunho é
sincronizado com o servidor por debounce maior (PED-06 — rascunho é estado do servidor, não do
navegador).

**Acessibilidade:** `role="grid"` com `rowheader` (cor) e `columnheader` (tamanho); cada célula
anuncia `ROSA, G42, quantidade 2, disponível 7`. ⚠️ Célula inexistente anuncia `não disponível nesta
grade` — não "desabilitado".

### 5.8 Card de tarefa da Fila do Dia — `gc-card-tarefa`

**Anatomia** (§5 das telas):

```
┌────────────────────────────────────────────────────┐
│ [○]  SATURNO E ALVES                    R$ 21.817  │  ← valor tabular, direita
│      ● Em Risco · 267 dias sem comprar             │  ← motivo: badge RFV + fato
│      Oferecer reposição · Follow-up · WhatsApp     │  ← o que fazer · tipo · canal
│      ┌──────────────────────────────────────────┐  │
│      │ 💡 "Tava olhando aqui e senti falta…"    │  │  ← sugestão de IA (violeta)
│      │              [ Editar ]  [ Abrir conversa ]│ │
│      └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

**Estados:** agendada · **vencida** · concluída (colapsa, mostrando o registro do que foi feito) ·
adiada (com a nova data) · **em conclusão** (formulário de registro aberto) · **sem sugestão**
(Onda 2 — ⚠️ o bloco **não existe**, não aparece vazio nem com esqueleto eterno).

> ⚠️ **Armadilha 1: 143 tarefas vencidas em coral pintam a tela de vermelho e o sinal morre.**
> Vencida é **`atencao` (âmbar)**, não `erro`. Coral fica reservado para falha do sistema — se tudo
> é urgente, nada é.

> ⚠️ **Armadilha 2: a caixa de conclusão não é um checkbox.** Concluir exige **registro do que foi
> feito**, que vira histórico do cliente (§5 das telas). Um checkbox que abre um formulário é um
> checkbox que mente: o usuário espera marcar e seguir. **É um botão `Concluir`** que abre o registro
> (inline no card no console, folha no app), e a tarefa só muda de estado ao salvar. Marcar por
> engano numa fila de 143 itens e não conseguir desmarcar é o pior desfecho possível.

> ⚠️ **Armadilha 3: a sugestão de IA parece pronta para enviar.** Ela **nunca envia sozinha**
> (§5 das telas). O botão principal é **`Abrir conversa`**, que leva o texto para o composer **como
> rascunho editável**, e não como mensagem enfileirada. A sugestão é marcada como IA (`violeta`),
> como toda saída de modelo no produto.

**Acessibilidade:** o card é `<article>` com `aria-labelledby` no nome do cliente; a linha de motivo
entra no rótulo acessível (`Em Risco, 267 dias sem comprar`) porque é ela que justifica a ordenação.

### 5.9 Linha do tempo de segmento — `gc-linha-rfv`

Bloco da ficha do cliente que **explica por que ele está onde está** (§3.2 das telas).

**Anatomia:** eixo Y = faixas de RFV na **ordem da rampa** (campeão em cima) · eixo X = tempo
(apurações) · pontos ligados por segmentos **em escada** · rótulo da faixa à esquerda.

**Regras de desenho:**

| Regra | Por quê |
|---|---|
| **Escada, nunca curva suave** | ⚠️ O RFV é recalculado em **apurações discretas**. Interpolar entre duas apurações desenha um estado que nunca existiu — o cliente não passou por `Em Risco` a caminho de `Perdido`, ele foi reclassificado |
| **Mostrar as faixas entre a máxima e a mínima visitadas**, as demais colapsadas em `…` | 11 linhas vazias é ruído; só as visitadas some com a noção de subir/descer |
| Ponto com **tooltip**: data da apuração + **o que mudou** (recência, frequência ou valor) | É a informação acionável — "caiu por recência" e "caiu por valor" pedem conversas diferentes |
| Marcadores de evento na base (pedido, campanha, tarefa) | Correlacionar a mudança de faixa com o que a equipe fez |

**Estados:** com histórico · **histórico insuficiente** (< 2 apurações → vazio com *"Primeira
apuração em 01/09 — a trajetória aparece a partir da segunda"*) · **analítico indisponível** (bloco
degradado, ⚠️ o resto da ficha continua funcionando — §1.1) · carregando (esqueleto do gráfico).

> ⚠️ **Armadilha: gráfico não é lido por leitor de tela, e este bloco é o mais informativo da ficha.**
> **Regra:** a alternativa em tabela (`data → faixa → o que mudou`) é **sempre presente no DOM**,
> alcançável por um botão `Ver como tabela` — não gerada sob demanda, não escondida atrás de
> configuração de acessibilidade. O SVG é `aria-hidden`; a tabela é a fonte.

### 5.10 Composer de dois modos — `gc-composer`

Incluído aqui porque a §7.4 de `direcao-visual.md` o chama de **o componente mais difícil do
produto** e ele é pré-requisito da Onda 1.

| Modo | Composição |
|---|---|
| **Janela aberta** | Campo livre · `+` (anexo, catálogo, pedido) · `🎤` gravar · `➤` enviar · dica `Ctrl+Enter` |
| **Janela fechada** | Campo **bloqueado com explicação** (§2.2) + `Escolher template` em destaque |
| **Somente-leitura** | Número removido da frota, ou conversa na fila ainda não assumida (§7 das telas) — com a razão visível |

> ⚠️ **Armadilha: perder o que a vendedora digitou.** A troca de modo acontece **sem recarregar** e
> **preserva o rascunho**, oferecendo o texto para colar no template (§1.3 das telas, skill do
> console). É, nas palavras da própria especificação, *"o defeito mais caro do inbox"*. O rascunho
> por conversa sobrevive à troca de conversa, à troca de filial e ao F5.

---

## 6. O que NÃO construir

⚠️ Reimplementar qualquer linha desta tabela é retrabalho garantido **e** regressão de
acessibilidade — os padrões WAI-ARIA de teclado, foco e anúncio são onde implementações caseiras
falham.

### 6.1 Console (Angular)

| Não construir | Usar | ⚠️ |
|---|---|---|
| Virtual scroll | **CDK `cdk-virtual-scroll-viewport`** | Lista de conversas, tabelas, contatos. **Nunca no kanban** (ADR-010 §5) |
| Arrastar e soltar | **CDK `DragDrop`** | Só no Funil de Leads |
| Posicionamento de overlay (dropdown, tooltip, popover) | **CDK `Overlay`** | Cálculo de flip/shift/colisão é onde se perde uma semana |
| Armadilha de foco, `LiveAnnouncer`, `FocusMonitor` | **CDK `a11y`** | — |
| Comportamento de combobox, listbox, tabs, menu, roving tabindex | **Angular Aria** (preview no 21, ADR-010 §7) | Headless: o comportamento vem pronto, o visual é nosso |
| Seletor de data | `<input type="date">` + máscara | ⚠️ Calendário próprio é um projeto, não um componente |
| Formulário e validação | Signal Forms / ReactiveForms + **Zod de `packages/shared`** | Duplicar regra de validação garante divergência com a API |
| Roteamento, lazy loading, título de página | Angular Router | — |
| Diálogo modal | `<dialog>` ou CDK `Dialog` | Foco, véu e Escape de graça |
| Grid de dados de terceiro (AG Grid e similares) | **`gc-tabela`** (§3.3) | ⚠️ Trazem paginação numérica e virtualização que brigam com cursor + densidade fixa. Configurar para desligar tudo custa mais que escrever |
| Editor de texto rico | Nada | ⚠️ WhatsApp não tem rich text. Um editor no composer produz formatação que se perde no envio |
| Biblioteca de UI pronta (Material, PrimeNG) | Nossos componentes sobre CDK | ⚠️ Material traz uma identidade visual inteira que teríamos de desfazer token a token |

### 6.2 App (Expo)

| Não construir | Usar |
|---|---|
| Lista performática | `FlashList` / `FlatList` com `keyExtractor` |
| Folha deslizante | Bottom sheet da plataforma / `@gorhom/bottom-sheet` |
| Animação e gesto | `react-native-reanimated` + `react-native-gesture-handler` |
| Teclado e safe area | `KeyboardAvoidingView`, `react-native-safe-area-context` |
| Toque, ripple, háptico | `Pressable` + `expo-haptics` |
| Seletor de data, câmera, arquivo, áudio | Módulos do Expo |
| Tema | `colorScheme` do NativeWind sobre os tokens |

### 6.3 O que não deve existir em componente nenhum

| ⚠️ Proibido no componente | Onde mora |
|---|---|
| Cálculo de faixa de RFV | API / analítico |
| Decisão de janela aberta/fechada | Servidor; o componente **apresenta** o `janelaExpiraEm` |
| Validação de pedido mínimo, mix e grade fechada | `packages/shared` + API |
| Nome literal do ERP | `detalhe.origem.nome` da resposta |
| Cor literal (`#3F6FBE`, `rgb(…)`) | Token semântico — barrado por lint |
| `enum` do TypeScript | União de literais + `z.enum` (ADR-011) |
| Chamada de rede direta | Serviço de dados da funcionalidade |

---

## 7. Ordem de construção e o que ainda falta decidir

**Ordem** — segue as telas, não o alfabeto. ⚠️ **E a onda de cada bloco é a onda da primeira tela
que o consome, não "pré-Onda 1" genérico:**

| Bloco | Onda | Componentes | Bloqueia | Tarefa e semana |
|---|---|---|---|---|
| **1 — Fundação** | 🔴 **Onda 0** | tokens no build · botão · campo · badge · esqueleto · vazio · erro · toast · painel · cabeçalho de tela | Tudo | **R-12** de `plano-onda-0.md` §3.1, **S1–S2** |
| **2 — Inbox** | **Onda 1** | avatar · **anel de janela** · balão · composer · player de áudio · seletor de número · abas · banner | Telas §1 e §7 | Pré-onda de `plano-ondas-1-4.md` §3.1, ordem 0 |
| **3 — Frota e entrada** | **Onda 0 / 1** | tabela (com cursor) · modal · toggle · checkbox · chip · select | `especificacao-telas-entrada` §4–6 | Parte em **S3–S4 da Onda 0** (ver abaixo); o restante na pré-onda da Onda 1 |
| **4 — CRM e pedido** | **Onda 2** | card de kanban · badge RFV · **grade cor × tamanho** · card de tarefa · linha do tempo de segmento · progresso | Telas §2–5 | Abertura da Onda 2 |

🔴 **O bloco 1 é Onda 0, com tarefa, dono e semana — não "paralelo".** O `plano-onda-0.md` §7 declara
**cinco telas de console na Onda 0**: login, recuperação de senha, convite/aceite, onboarding do
tenant (Meta + ERP) e lista de contatos em leitura. Essas cinco consomem o bloco 1 **inteiro** e
uma parte concreta do bloco 3 — **tabela com cursor** (lista de contatos), **modal**, **select** e
**checkbox** (onboarding e convite). Elas serão construídas de qualquer jeito; a única escolha é se
serão construídas **sobre a biblioteca** ou com `#hex` no meio do componente, para a Onda 1 refazer.

⚠️ **`especificacao-telas-entrada` §4–6 (equipe, frota, onboarding) é Onda 0 — E1-07 e E3-01.** É por
isso que o bloco 3 tem duas ondas: o subconjunto que essas telas usam nasce em **S3–S4 da Onda 0**,
e o restante (chip, toggle nas telas de conversa) fica para a pré-onda da Onda 1.

⚠️ **"Paralelo" não tem semana, não tem dono e não entra em checklist.** Era assim que esta
biblioteca aparecia no plano da Onda 0 — e é exatamente o estado em que um pré-requisito de tudo
chega atrasado sem que ninguém tenha decidido atrasá-lo.

⚠️ **O protótipo de alta fidelidade do inbox vem antes do bloco 2 inteiro** (§9 de
`direcao-visual.md`) — é onde a densidade quebra, e é mais barato descobrir isso num protótipo do
que em oito componentes já escritos duas vezes.

**Pendências com dono, não resolvidas aqui:**

| # | Pendência | Por que não é decisão desta biblioteca |
|---|---|---|
| 1 | **Conjunto de ícones** (qual, licença) | §11 de `identidade-visual.md` — precisa de escolha e verificação de licença, como as fontes |
| 2 | **Atalhos de tecla única** (`/`, `j`, `k`, `e`) | §8 de `direcao-visual.md`, item 14. ⚠️ Não podem disparar com foco no composer — a regra existe, o conjunto não |
| 3 | **Som de mensagem nova** e notificação de desktop | Itens 13 e 15 de `direcao-visual.md` §8 |
| 4 | **Card de atribuição** e **donut de categorias** (Home, §6 das telas) | Onda 2. ⚠️ O card de atribuição carrega a regra mais delicada do produto — receita **exata** e **estimada** exibidas separadas, jamais somadas — e merece ficha própria quando a tela for detalhada |
| 5 | **Gráfico de barras + linha** (vendas no período) | Onda 2; depende da escolha da biblioteca de gráficos, que precisa consumir tokens |
| 6 | **Indicador de presença** ("Eduarda está nesta conversa") | Onda 1, comportamento já definido em `geracrm-tempo-real`; a ficha visual sai com o protótipo do inbox |
