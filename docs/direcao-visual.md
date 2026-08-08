# Direção visual e design tokens — PROPOSTA

> **⚠️ Este documento não decide nada. Ele propõe.**
>
> A identidade visual do GeraCRM é **decisão do dono do produto**. O que está aqui são três direções
> fundamentadas, uma estrutura de tokens com **valores de exemplo** e uma lista de perguntas objetivas
> (§8). Nenhum hex, nenhuma fonte e nenhum raio deste documento deve ser tratado como fechado até que
> a §8 esteja respondida.
>
> **Estado no repositório:** já existe `docs/identidade-visual.md` e `packages/design-tokens/tokens.json`
> registrando a **Direção B** (§3.2) como escolhida, via ADR-012. Este documento é a **fundamentação
> que faltava debaixo daquela decisão**: se o dono confirmar, ADR-012 fica ratificado e este arquivo
> vira o histórico do porquê; se quiser reabrir, as outras duas direções estão aqui inteiras, com
> custo de troca estimado (§3.5). Enquanto §8 não for respondida, ADR-012 deve ser lido como
> **proposta em vigor**, não como decisão do dono.

Deriva de [`especificacao-telas.md`](./especificacao-telas.md) (as 6 telas de operação),
[`inventario-funcionalidades-referencia.md`](./inventario-funcionalidades-referencia.md) (o Tailor) e
[`prontidao-para-inicio.md`](./prontidao-para-inicio.md) §2.3, que registrou esta lacuna.

---

## 1. Quem usa, e por quê isso muda tudo

| Fato da operação | Consequência de design |
|---|---|
| A vendedora fica **8h/dia** com o inbox aberto | O visual precisa ser **suportável**, não impressionante. Impacto é custo diário aqui |
| A tela do inbox tem **4 colunas** (240 · 320 · flex · 360) num monitor que muitas vezes é 13" | Densidade não é preferência estética, é **requisito de caber** |
| Ela **varre**, não lê. Passa por 40 conversas procurando "quem não respondi" | Leitura periférica é a métrica real. Se ela precisa focar item a item, o design falhou |
| Kanban com **11.358 cards** numa coluna | O card precisa ser legível em 3 segundos e a coluna precisa virar gráfico |
| Ela também usa **celular no campo** (feira, showroom), às vezes com uma mão | Dois regimes de densidade e de alvo, não um |
| A informação mais cara é **temporal**: janela de 24h, dias sem comprar, tempo desde o último toque | Tempo precisa ter forma visual, não só número |
| Metade da base começa cedo e termina tarde | Modo escuro é funcional, não moda |

⚠️ **A armadilha central:** todo brief de "identidade marcante" empurra para saturação, contraste alto,
gradiente e sombra. Todos esses recursos **funcionam numa landing page e falham numa ferramenta de
jornada longa** — porque a landing é vista por 40 segundos e o inbox por 8 horas. O que é "vivo" na
primeira vez é "cansativo" na quinquagésima.

---

## 2. Princípios de design para ferramenta de uso intensivo

### 2.1 Densidade é respeito

| Elemento | Proposta | Referência confortável | Por quê |
|---|---|---|---|
| Linha de tabela | **32px** | 48px | 15 linhas visíveis vs. 10. Em tabela de vendas, é a diferença entre rolar e não rolar |
| Item da lista de conversas | **56px** | 72px | Cabe nome + badges + prévia sem esticar |
| Corpo de interface densa | **13px** | 16px | 13px com fonte de boa altura-de-x lê melhor que 14px numa coluna de 320px |
| Espaçamento interno de card | **8–12px** | 16–24px | O ar sobra quando o dado é curto e mata quando o card tem 6 informações |

⚠️ Densidade **não é apertar**. É reduzir o que não carrega informação (padding, borda decorativa,
ícone redundante) para preservar o que carrega. Densidade errada é ilegível e volta como erro de
digitação em pedido.

### 2.2 Leitura periférica é a métrica

A vendedora não olha a lista de conversas: ela olha **para o lado dela** enquanto responde outra. O que
precisa chegar pela visão periférica:

- Há mensagem nova? → mudança de peso/marca no item, não cor sozinha
- Esta janela vai fechar? → forma que **encolhe**, não número que ela precisa ler
- Este cliente é grande ou pequeno? → posição na rampa de cor do segmento
- Este lead está parado há quanto tempo? → o dado mais acionável do card de kanban (§4.1 das telas)

⚠️ Visão periférica enxerga **movimento, contraste de luminância e posição**. Ela é péssima com matiz e
com texto pequeno. Um badge verde escrito `Janela Aberta` **não é lido perifericamente** — é exatamente
o que o Tailor faz, e é uma oportunidade.

### 2.3 Consistência de posição vale mais que cor

Os badges do item de conversa têm **ordem fixa**, definida na especificação de telas:

```
estágio → vendedora dona → histórico → quem conduz (IA/humano) → tipo do último conteúdo
```

⚠️ **Se a ordem varia conforme o que existe, a varredura periférica quebra** e o usuário volta a ler
item por item. A regra: slot ausente **colapsa sem reordenar os outros**; nunca "empurra" o vizinho para
a esquerda de forma que mude o significado da posição 2. O mesmo vale para colunas de tabela, posição do
botão primário no modal e canto do contador no kanban.

### 2.4 Hierarquia por três camadas, nunca por cor sozinha

| Camada | Recurso | Exemplo no produto |
|---|---|---|
| **Estrutura** | superfície + borda de 1px | separar as 4 colunas do inbox |
| **Ênfase** | peso tipográfico + tamanho | nome do contato vs. prévia da mensagem |
| **Estado** | cor + ícone + rótulo | falha de envio, janela fechada, crédito bloqueado |

Cor é a **última** camada e serve a **um** trabalho por matiz. Se o mesmo azul é marca, ação e informação,
ele deixa de significar qualquer coisa — e o botão primário some no meio da tela.

### 2.5 Redução de ruído — o que se corta

| Cortado | Motivo |
|---|---|
| Sombra empilhada em cards de lista | 40 sombras numa coluna produzem uma paisagem borrada; borda de 1px lê mais rápido e renderiza mais barato |
| Gradiente em superfície | Ruído em tela densa, envelhece rápido, quebra contraste de texto de forma imprevisível |
| Ilustração em estado vazio | Ocupa o espaço onde deveria estar a próxima ação |
| Animação de entrada em lista | A lista atualiza por SSE o dia inteiro — animar entrada vira tremor permanente |
| Ícone ao lado de todo rótulo | Ícone que não desambigua é decoração cara em 13px |
| Cantos muito arredondados (16px+) | Faz ferramenta de trabalho parecer aplicativo de lazer |

### 2.6 Movimento tem orçamento

- **120ms** para estado (hover, foco, pressionado) — abaixo disso parece quebrado, acima parece lento
- **200ms** para entrada de painel/folha
- **Zero** loop, com **uma** exceção deliberada: a contagem da janela de 24h, que leva 24h por volta
- `prefers-reduced-motion` desliga tudo e transforma qualquer indicador animado em estático

---

## 3. Três direções propostas

Todas as três **respeitam a §2 inteira**. Elas divergem em personalidade, não em disciplina. Os hexes
abaixo são **âncoras para conversa**, não paleta final.

### 3.1 Direção A — "Casa Gera3" (deriva do drezz)

**Personalidade:** quente, artesanal, brasileira. Papel creme com tinta quente e um laranja que só
aparece na ação principal.

| Papel | Exemplo |
|---|---|
| Fundo (claro) | `#FFF8EC` creme — o "papel" do drezz |
| Superfície elevada | `#FFFFFF` |
| Texto | `#1F1A16` marrom-preto quente (nunca preto puro) |
| Ação primária | `#FF6732` |
| Escuro | fundo `#17130F`, superfícies `#221C16` |

**O que comunica:** "isto é da mesma casa que o drezz". Continuidade de fornecedor, sensação de suíte.

**Quando faz sentido:** se a estratégia comercial é **vender GeraCRM e drezz juntos** para o mesmo
lojista, com login e visual reconhecíveis entre si; se a Gera3 quer construir marca guarda-chuva.

**Custos reais:**

| ⚠️ Risco | Detalhe |
|---|---|
| Laranja é a cor de alerta natural | `#FF6732` fica a poucos graus do âmbar de "atenção". Se laranja é marca **e** ação, o produto perde a faixa quente para sinalizar risco — justo num CRM cheio de "janela fechando", "crédito bloqueado", "cliente em risco" |
| Creme cansa em 4 colunas | `#FFF8EC` funciona bem numa tela de PDV com poucos blocos; em tela densa com muitas bordas, o amarelado reduz a percepção de branco de contraste e "amarela" fotos de produto do catálogo |
| Fotos de produto | O catálogo mostra roupa. Fundo creme desloca a percepção de cor da peça — problema real em atacado de moda |
| Amarra o preço | Um CRM que parece o PDV do drezz tende a ser percebido como módulo do drezz, não produto próprio com preço próprio |

**Mitigação possível:** herdar apenas a **família tipográfica e os princípios**, e trocar o creme por
branco puro no CRM, mantendo o laranja só no logotipo e no botão primário. Vira uma direção A′, mais
segura, mas que entrega pouco da continuidade que justificava a escolha.

---

### 3.2 Direção B — "Azul de operação" (identidade própria) ← **proposta recomendada**

**Personalidade:** quieta, técnica, confiável. Azul **dessaturado** como ambiente, uma única cor viva
de alta energia reservada para "está vivo, está no prazo", e o resto neutro.

| Papel | Exemplo |
|---|---|
| Fundo (claro) | `#FFFFFF` |
| Superfície | `#F4F7FC` |
| Ação primária | `#3F6FBE` — deliberadamente **menos saturado** que o azul-SaaS de prateleira |
| Sinal vivo | `#0FB5AE` turquesa — janela aberta, atendente online, conexão em pé |
| Estados | âmbar `#E8A317` · coral `#E5484D` · verde `#2E9E5B` · violeta `#7C5CD6` (conduzido por IA) |
| Escuro | fundo `#0D1830` (azul profundo, **não preto**) |

**O que comunica:** "isto é infraestrutura de trabalho". Não pede atenção, sustenta atenção.

**Quando faz sentido:** quando o produto é vendido como **ferramenta de operação diária** e a jornada
longa é o critério dominante — que é exatamente o caso aqui.

**A tensão que ela resolve:** "marcante" e "8 horas por dia" puxam para lados opostos. A saída é gastar
ousadia em **um** lugar só:

| | Onde |
|---|---|
| Ambiente quieto | 95% da tela |
| Sinal (cor viva, movimento) | Só onde há informação urgente |
| Assinatura | Um elemento, e ele precisa **trabalhar** |

**Assinatura proposta — o anel/barra de janela.** A janela de 24h da Meta é a regra que mais afeta o
trabalho da vendedora. O mercado inteiro (incluindo o Tailor) mostra um badge de texto
`Janela Aberta`/`Janela Fechada`. A proposta é **desenhar o tempo**: anel fino ao redor do avatar na
lista, drenando ao longo das 24h; barra de 2px no topo do chat. Turquesa com folga → âmbar nas últimas
2h → coral ao fechar. Movimento contínuo e lentíssimo, sem piscar.

Ela qualifica como assinatura porque: nasce do domínio (só existe pela regra da Meta), é funcional
(troca leitura de número por percepção periférica, §2.2), é onipresente, ninguém tem, e não cansa.
⚠️ **Nunca é a única fonte** — o tempo em texto permanece no header e o estado é anunciado a leitor de tela.

**Custos reais:**

| ⚠️ Risco | Detalhe |
|---|---|
| Azul é o default do B2B | Sem a assinatura e sem a decisão tipográfica, esta direção vira "mais um SaaS azul" |
| Exige disciplina no turquesa | Se o turquesa vazar para botão comum, perde o significado e a paleta fica ruidosa |
| Não capitaliza a marca da casa | Zero continuidade visual com o drezz |

---

### 3.3 Direção C — "Grafite" (quase-monocromática, acento único)

**Personalidade:** máxima sobriedade. Neutros quentes de grafite, **um** acento, tipografia fazendo
todo o trabalho de hierarquia. A linhagem visual de ferramentas de time técnico.

| Papel | Exemplo |
|---|---|
| Fundo (claro) | `#FCFCFD` |
| Superfície / borda | `#F2F3F5` / `#E4E6EA` |
| Texto | `#16181D` / secundário `#60646C` |
| Acento único | `#5B5BD6` (ou o que a marca definir) — **só** ação primária e foco |
| Estados | uma família de 4, dessaturada em relação à B |
| Escuro | fundo `#111113`, superfícies `#18191B` |

**O que comunica:** "ferramenta séria, sem enfeite". Envelhece muito bem e é a mais barata de manter
consistente, porque quase não há decisão de cor a tomar.

**Quando faz sentido:** se a prioridade absoluta é densidade e neutralidade, e se o produto for
caminhar para **white-label** — uma base cinza aceita a cor de qualquer revenda sem brigar. (O
`geracrm-identidade-acesso` já registra white-label multi-tenant como caminho futuro; esta direção é a
que menos custa para chegar lá.)

**Custos reais:**

| ⚠️ Risco | Detalhe |
|---|---|
| Não é "marcante" | Se o dono quer que o produto seja lembrado visualmente, esta direção entrega o oposto |
| Cinza puro parece template | Sem calibrar a temperatura dos neutros, lê como bootstrap não terminado |
| Um acento só é pouco para 11 segmentos RFV | A rampa de RFV precisa de faixa cromática; ela vira a exceção da paleta e destoa |

---

### 3.4 Comparação direta

| Critério | A · Casa Gera3 | B · Azul de operação | C · Grafite |
|---|---|---|---|
| Suporta 8h/dia | Médio (creme + laranja) | **Alto** | **Alto** |
| Densidade de 4 colunas | Médio | **Alto** | **Alto** |
| "Marcante" | Alto | Médio-alto (via assinatura) | Baixo |
| Sinalização de risco livre (âmbar/vermelho) | **Conflita com a marca** | Livre | Livre |
| Fotos de produto no catálogo | Ruim (fundo quente) | Bom | **Muito bom** |
| Continuidade com o drezz | **Alta** | Nenhuma | Nenhuma |
| Caminho para white-label | Ruim | Médio | **Bom** |
| Custo de manter consistente | Médio | Médio | **Baixo** |
| Risco de parecer genérico | Baixo | Médio | Alto |

### 3.5 Custo de trocar de direção depois

Se os tokens forem **semânticos desde o primeiro componente** (§4), a troca é barata; se cor literal
vazar para componente, é cara. Estimativa com a estrutura proposta:

| Momento da troca | Custo |
|---|---|
| Antes do primeiro componente | Horas — editar um JSON |
| Depois da Onda 1 (inbox pronto) | Dias — revalidar contraste de todos os pares e reajustar a rampa RFV |
| Depois da Onda 3 | Semanas, **se** cor literal tiver vazado. ⚠️ É o único cenário caro, e é evitável por lint |

---

## 4. Estrutura de design tokens

⚠️ **A estrutura abaixo é a proposta que precisa de aprovação. Os valores são exemplo** (usam a Direção B
para ficar concreto; trocar de direção troca só a camada de primitivos).

### 4.1 Três camadas, e a regra que as separa

```
primitivo          →  semântico            →  componente (opcional)
azul.500 #3F6FBE      cor.acao                botao.primario.fundo
neutro.200 #DFE6EF    cor.borda               tabela.linha.borda
```

| Camada | O que é | Quem pode usar |
|---|---|---|
| **Primitivo** | A escala crua. Sem opinião sobre uso | **Só** a camada semântica |
| **Semântico** | O papel: `superficie`, `texto-secundario`, `acao-hover`, `erro` | Componentes e telas |
| **Componente** | Só quando um componente precisa de um valor que não é papel geral | Aquele componente |

⚠️ **A regra que faz o modo escuro funcionar:** componente **nunca** referencia primitivo. Se um botão
escreve `#3F6FBE`, o tema escuro precisa editar o botão. Se escreve `cor.acao`, o tema escuro edita
**um** token. Isso deve ser garantido por lint, não por disciplina — mesma lógica do ADR sobre RLS:
garantido pela camada, não pelo desenvolvedor.

### 4.2 Cor — os papéis semânticos

| Grupo | Tokens |
|---|---|
| **Superfície** | `fundo` · `superficie` · `superficie-elevada` · `superficie-hover` · `superficie-selecionada` |
| **Texto** | `texto` · `texto-secundario` · `texto-suave` · `texto-invertido` · `texto-desabilitado` |
| **Borda** | `borda` · `borda-forte` · `borda-foco` · `borda-erro` |
| **Ação** | `acao` · `acao-hover` · `acao-pressionada` · `acao-texto` · `acao-suave` (fundo de ação secundária) |
| **Estado** | `sucesso` · `atencao` · `erro` · `informacao` — cada um com `-fundo` e `-borda` |
| **Marca** | `marca` (só logotipo e superfícies de marca — **não** é `acao`) |

Além dos genéricos, o domínio exige três famílias próprias — e é melhor que sejam tokens explícitos do
que cor escolhida ad hoc dentro do componente:

| Família | Por quê é token e não improviso |
|---|---|
| `janela.*` (aberta / terminando / fechada / trilho) | Aparece em avatar, header, card de kanban e app. Cinco lugares, um valor |
| `rfv.*` (11 faixas) | Rampa contínua campeão→perdido. A **posição na rampa já informa**. ⚠️ Nunca usada sem rótulo textual |
| `ia` | Distinguir conversa conduzida por robô de conversa conduzida por humano é decisão de produto, não estética |

**⚠️ Contraste é propriedade do par, não do token.** `texto-secundario` sozinho não tem contraste;
`texto-secundario` sobre `superficie` tem. A verificação precisa ser dos **pares realmente usados** (§6).

### 4.3 Tipografia

| Papel | Proposta | Justificativa |
|---|---|---|
| Interface | uma sans desenhada para produto, com boa altura-de-x e formas abertas em 13px | Candidatas: Geist Sans, IBM Plex Sans, Inter. ⚠️ Testar em 13px numa coluna de 320px **antes** de fixar |
| Dados | uma monoespaçada da mesma família | Ver abaixo |
| Números | a sans com `tabular-nums`, peso 600, tracking −0.02em | Colunas de valor precisam alinhar |

**⚠️ Proposta com opinião: monoespaçada para identificadores.** SKU `22625-VERDE-G42`, telefone
`+55 81 99861-7049`, CNPJ `60.631.000/0014-30`, protocolo `#000318`. São valores **comparados,
conferidos e digitados** o dia inteiro. Em mono eles alinham em coluna, o olho acha a diferença entre
dois SKUs parecidos, e o dado se distingue do texto sem gastar cor nem negrito. Nenhum concorrente faz
isso. É a decisão tipográfica mais barata e mais visível do projeto — **e é decisão do dono** (§8).

Escala (7 degraus, deliberadamente poucos):

| Nome | Tamanho / altura | Peso | Uso |
|---|---|---|---|
| `kpi` | 32 / 36 | 600 tabular | Home |
| `titulo` | 20 / 28 | 600 | Título de tela |
| `secao` | 15 / 20 | 600 | Cabeçalho de bloco |
| `corpo` | 14 / 20 | 400 | Texto corrido, modal |
| **`denso`** | **13 / 18** | 400 | **Lista, tabela, card — o tamanho mais usado do produto** |
| `rotulo` | 11 / 14 | 500, +0.02em | Badge, cabeçalho de coluna |
| `dados` | 13 / 18 | 400 mono tabular | Identificadores |

Pesos: **400 · 500 · 600**. Três. ⚠️ Peso 700 em 13px empasta na maioria das telas de escritório.

### 4.4 Espaçamento, raio, elevação, movimento

**Espaçamento** — grade de 4px, com nomes numéricos: `1`=4 · `2`=8 · `3`=12 · `4`=16 · `6`=24 · `8`=32 · `12`=48.
⚠️ Sem valores intermediários. Sete degraus resolvem tudo; quinze produzem inconsistência.

**Raio** — três: `controle` 6px · `painel` 10px · `completo` 999px (só badge e avatar).

**Elevação** — três: `nenhuma` · `dropdown` · `modal`. ⚠️ **Borda antes de sombra**; sombra existe só onde
há sobreposição real (dropdown, modal, folha mobile, painel de pedido).

**Movimento** — `estado` 120ms · `painel` 200ms · `janela` 24h linear. Curvas junto do token.

**Densidade** — proposta como token, porque é decisão de produto e não CSS solto: `linha-tabela` 32px ·
`item-lista` 56px · `card-kanban-min` 112px · `acento-lateral-card` 3px · `alvo-toque-app` 44px ·
`alvo-clique-console` 28px.

### 4.5 ⚠️ A fonte da verdade é neutra — como Angular e Expo consomem a mesma coisa

O ADR-010 aceitou uma consequência: **console (Angular) e app (Expo) não compartilham componente.**
O que eles compartilham é isto:

> **Componente se duplica. Token, não.**

```
                  packages/design-tokens/tokens.json
                      (JSON neutro, zero dependência,
                       zero sintaxe de framework)
                                 │
                     script de build (Node, sem framework)
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
   tokens.css                              tokens.preset.ts
   :root { --cor-acao: #3F6FBE }           export default { theme: { extend: {
   [data-tema="escuro"] {                    colors: { acao: 'var(--cor-acao)' … }
     --cor-acao: #6B94D1 }                 }}}
              │                                     │
              ▼                                     ▼
   apps/console (Angular)                  apps/app (Expo + NativeWind)
   var(--cor-acao) no CSS                  className="bg-acao"
```

Por que **JSON neutro** e não "um preset Tailwind que o Angular também importa":

| ⚠️ Armadilha | Consequência |
|---|---|
| Fonte da verdade em JS/TS com sintaxe de framework | Amarra o Angular ao ecossistema Tailwind e o app à build do console |
| Fonte da verdade em CSS | O Expo não lê CSS custom property nativamente em todos os caminhos; o React Native precisa de valores resolvidos |
| Fonte da verdade em dois lugares "espelhados à mão" | Diverge em três meses e aparece como "o app está com uma cor diferente" que ninguém sabe resolver, porque a cor está literal em vinte arquivos |

Regras do pacote:

1. `tokens.json` é **dado**, não código. TypeScript puro no restante de `packages/`, como manda o
   `geracrm-monorepo-deploy` — nenhuma dependência de framework aqui.
2. Os artefatos gerados (`tokens.css`, `tokens.preset.ts`, `tokens.d.ts`) são **build**, não fonte —
   gerados no `build` do pacote e consumidos por console e app como dependência de workspace.
3. `tokens.d.ts` dá **autocomplete e erro de compilação** ao usar um token que não existe. É o que faz a
   regra da §4.1 ser barata de seguir.
4. O verificador de contraste (§6) roda **no CI**, sobre os pares declarados — token novo sem par
   verificado quebra o build.

⚠️ **Referência (`{azul.500}`) resolvida no build, não em runtime.** Cadeia de referência em runtime é
onde nasce a custom property indefinida que vira texto invisível em produção.

---

## 5. Modo claro e escuro — desde o início

Modo escuro definido depois é sempre uma inversão automática que produz cinza sujo. A proposta é os dois
temas nascerem juntos, no mesmo arquivo.

### 5.1 A regra de inversão

> **O que inverte é o papel, não o valor.**

```
claro:  fundo é o mais claro  →  superfície um passo mais escura  →  elevada volta ao mais claro
escuro: fundo é o mais escuro →  superfície um passo mais clara   →  elevada mais clara ainda
```

| Papel | Claro | Escuro | Regra |
|---|---|---|---|
| `fundo` | `#FFFFFF` | `#0D1830` | ⚠️ Fundo escuro **não é preto** — preto puro contra texto branco produz halo e cansa em jornada longa |
| `superficie` | `#F4F7FC` | `#142442` | Claro: superfície é mais **escura** que o fundo. Escuro: mais **clara** |
| `superficie-elevada` | `#FFFFFF` + borda | `#1B3260` | Elevação no escuro é **luz**, não sombra — sombra não aparece sobre fundo escuro |
| `texto` | `#0F1B2D` | `#E8EEF7` | ⚠️ Nem preto puro, nem branco puro |
| `acao` | `azul.500` | `azul.400` (um passo mais **claro**) | Cor saturada sobre fundo escuro precisa subir em luminosidade para manter contraste |
| `erro`/`atencao`/`sucesso` | `.500` | `.300` | ⚠️ Coral `#E5484D` sobre fundo escuro fica agressivo **e** perde contraste. As cores de estado **clareiam e dessaturam** no escuro |
| `borda` | `neutro.200` | azul mais claro que a superfície | No escuro, borda é mais **clara** que o que ela separa |

**Consequência prática:** no escuro, um token de estado não é o mesmo hex do claro. Por isso cada família
de estado precisa de **pelo menos três degraus** (`300`/`500`/`700`) nos primitivos, mesmo que o tema
claro use só um.

### 5.2 Mecânica

| | Console (Angular) | App (Expo) |
|---|---|---|
| Seletor | `[data-tema="escuro"]` no `<html>` | `colorScheme` do NativeWind |
| Padrão | segue o sistema (`prefers-color-scheme`) | segue o sistema |
| Override | preferência do usuário, persistida no perfil (não só no navegador — ela usa dois computadores) | idem |
| Transição | ⚠️ **sem transição** ao trocar de tema — animar 200 propriedades de cor produz um flash pior que o corte |

### 5.3 O que precisa ser reverificado no escuro

Contraste de **todos** os pares · a rampa RFV inteira (11 faixas precisam continuar distinguíveis) ·
sombra (some, vira borda) · foto de produto do catálogo (⚠️ fundo escuro atrás de foto com fundo branco
recortado fica horrível — exige um `superficie-midia` neutro).

---

## 6. Acessibilidade

Não como conformidade, como funcionamento: vendedora cansada às 18h **é** um usuário com acuidade reduzida.

| Requisito | Alvo | Onde dói neste produto |
|---|---|---|
| **Contraste de texto** | **4.5:1** (WCAG AA); 3:1 para ≥18.66px bold | ⚠️ `texto-secundario` em 13px é onde quase todo design system falha. A prévia da mensagem na lista de conversas é texto secundário em 13px — precisa passar |
| **Contraste de interface** | **3:1** para borda de campo, ícone que carrega significado, limite de badge | Borda de input em `neutro.200` sobre branco **não passa** — precisa de `borda-forte` no estado de repouso do campo |
| **Verificação** | Por **par**, no CI | Par novo sem verificação quebra o build |
| **Foco visível** | Anel de 2px + deslocamento de 2px, contraste 3:1 contra o fundo **e** contra o elemento | ⚠️ `outline: none` é proibido. Em tabela densa, foco precisa ser visível **dentro** da linha de 32px — usar `outline-offset` negativo em vez de sumir |
| **Alvo de toque (app)** | **44×44px** | A grade cor × tamanho do pedido mobile é o pior caso: célula de matriz precisa caber o polegar (§2.6 das telas) |
| **Alvo de clique (console)** | 28px visual com **área estendida** para 32px | Densidade e alvo brigam; a saída é pseudo-elemento de hit area, não botão maior |
| **Estado nunca só por cor** | Sempre cor **+** (ícone ou rótulo ou posição) | ⚠️ As 11 faixas de RFV são o caso crítico: 8% dos homens têm alguma deficiência de percepção de cor. **Toda faixa carrega rótulo** |
| **Movimento** | `prefers-reduced-motion` respeitado | O indicador de janela vira arco estático; nada de transição |
| **Leitor de tela** | Estado anunciado, região viva para mensagem nova | O indicador de janela é decorativo para o leitor — o **texto** de tempo restante é a fonte |
| **Zoom** | 200% sem perda de função | ⚠️ 4 colunas em 200% não cabem: a coluna de contexto colapsa (já é retrátil) e a lista vira overlay |

### 6.1 Navegação por teclado

A vendedora que domina o produto quer sair do mouse. Proposta de contrato mínimo:

| Requisito | Regra |
|---|---|
| **Ordem de tabulação** | Segue a ordem visual das colunas: lista → conversa → composer → contexto |
| **Armadilha de foco** | Modal e folha capturam foco e devolvem ao elemento de origem ao fechar |
| **Escape** | Fecha a camada mais superficial, sempre. Nunca fecha duas |
| **Enter em lista** | Abre o item focado; setas navegam entre itens sem sair da coluna |
| **`Ctrl+Enter`** | Envia a mensagem (já está na especificação de telas) |
| **Atalhos globais** | ⚠️ Precisam de decisão (§8): `/` para buscar, `j`/`k` para navegar conversa, `e` para arquivar. Atalho de uma tecla **não pode** disparar com foco no composer |
| **Pular para o conteúdo** | Link de skip antes do menu lateral — a vendedora não deve tabular 20 itens de menu para chegar na lista |
| **Desfazer** | As ações com desfazer de 5s (mudar etapa, arrastar no kanban) precisam de atalho de teclado, não só do toast |

---

## 7. Inventário de componentes

Derivado das telas já especificadas. A coluna **origem** aponta a seção de `especificacao-telas.md` que
o exige — nenhum componente aqui é especulativo.

### 7.1 Base

| Componente | Variantes / estados | Origem |
|---|---|---|
| **Botão** | primário · secundário · sutil · destrutivo × repouso/hover/pressionado/foco/desabilitado/carregando | Todas. ⚠️ Desabilitado **precisa** carregar o motivo no hover (§2.2: "Enviar ao GeraCloud" desabilitado com validação pendente) |
| **Campo de texto** | normal · com prefixo/sufixo · com erro · desabilitado · **bloqueado com explicação** | §1.3 — composer com janela fechada é campo bloqueado com explicação e ação alternativa, não campo desabilitado mudo |
| **Campo numérico de célula** | compacto, dentro de matriz, com alerta inline | §2.2 — grade cor × tamanho |
| **Select / combobox** | com busca · sem busca · agrupado | §1.2 seletor de número, §1.3 seletor de funil e etapa |
| **Checkbox / toggle** | | §1.2 filtros, §3.2 preferências de campanha e automação |
| **Avatar** | com iniciais · com foto · **com anel de janela** · empilhado (+3) | §1.2, §4.1 "Está no telefone" |
| **Badge** | neutro · estado · segmento RFV · contador · **com cadeado (upsell)** | §0.1, §0.2, §1.2, §4.1 |
| **Chip de filtro** | aplicado, removível | §4.2 |
| **Tooltip** | | §2.2 saldo em célula desabilitada; motivo de botão desabilitado |
| **Ícone** | um só conjunto, dois tamanhos (14 e 18) | Transversal |

### 7.2 Estrutura

| Componente | Regras | Origem |
|---|---|---|
| **Painel / coluna** | Retrátil com estado lembrado por usuário | §1.4 |
| **Menu lateral** | Dois níveis, colapsável, item ativo, badge no item | §0.2 |
| **Abas** | Com contador por aba | §5 (Agendadas 12 · Vencidas 143 · Concluídas 8), §7 (Meus · Fila) |
| **Tabela** | Cabeçalho fixo · coluna ordenável · linha de 32px · **paginação por cursor** · densidade única | §6, ADR-011 (⚠️ toda lista paginada server-side) |
| **Lista virtualizada** | Carregamento sob demanda | §4.2 — coluna com 11.358 cards |
| **Card de kanban** | Barra de acento lateral de 3px na cor do segmento · 6 informações em 3 segundos | §4.1 |
| **Folha deslizante (mobile)** | Em passos | §2.6 |
| **Modal** | Bloqueante só quando justificado | §4.2 — motivo de descarte é o **único** caso bloqueante justificado |
| **Barra de ferramentas de filtro** | Chips + exportação | §4.2 |
| **Seletor de período** | Presets + personalizado | §6 |

### 7.3 Feedback — os cinco estados obrigatórios viram componentes

A §0.1 da especificação de telas exige cinco estados de **toda** tela. Isso significa cinco componentes,
não cinco improvisos:

| Estado | Componente | ⚠️ Regra |
|---|---|---|
| Carregando | **Esqueleto** com a forma do conteúdo real | Nunca spinner solto no centro. Um esqueleto por forma: item de lista, linha de tabela, card, KPI |
| Vazio | **Estado vazio** = motivo + ação seguinte | Nunca "nenhum resultado" isolado. Sem ilustração (§2.5) |
| Erro | **Estado de erro** tipificado | Nomeia o sistema de origem ("GeraCloud não respondeu") e oferece ação |
| Sem permissão | **Ausência** | O elemento não aparece. Exceção: recurso não contratado → badge de cadeado (upsell) |
| Parcial / degradado | **Aviso localizado** | Dado principal carregou, secundário falhou. Aviso no bloco, não na tela |

Mais: **toast** (com ação de desfazer de 5s) · **banner** (erro de conexão do número, no topo da lista,
não modal) · **barra de progresso** (upload, disparo de campanha).

### 7.4 Domínio — os que só existem neste produto

| Componente | Por quê é próprio |
|---|---|
| **Indicador de janela de 24h** | Anel no avatar + barra no header. A assinatura proposta na Direção B |
| **Balão de mensagem** | Recebida/enviada · status ✓/✓✓/✓✓ lido/⚠ falha com motivo ao clicar · marca de campanha de origem · ⚠️ balão com falha **nunca some** |
| **Player de áudio** | Play, duração, velocidade e **transcrição abaixo** quando disponível |
| **Composer de dois modos** | ⚠️ O componente mais difícil do produto: troca de modo **sem recarregar** ao fechar a janela e **preserva o rascunho** para colar no template |
| **Grade cor × tamanho** | Matriz com quantidade por célula, célula sem saldo desabilitada com tooltip, célula com saldo insuficiente com ⚠️ |
| **Bloco de validação de pedido** | Cada regra violada vira uma linha dizendo **o que falta** |
| **Badge de segmento RFV** | 11 faixas, rampa contínua, sempre com rótulo |
| **Linha do tempo de RFV** | Trajetória do cliente entre faixas |
| **Item da fila do dia** | Cliente + motivo + **mensagem sugerida editável** embutida |
| **Card de atribuição (Home)** | ⚠️ Receita **exata** e **estimada** exibidas separadas, com legenda — jamais somadas |
| **Seletor de número da frota** | Vira rótulo estático quando o usuário tem um número só |
| **Indicador de presença** | "Eduarda está nesta conversa", em tempo real |
| **Gráfico de barras + linha** | Vendas no período com comparação de ano anterior |
| **Donut de categorias** | Fatia clicável abre modal com drill-down até SKU-cor-tamanho |

⚠️ **Cada componente destes existe duas vezes** — uma em Angular, uma em Expo (ADR-010). O que garante
que não divirjam são os tokens (§4.5) e uma **especificação de comportamento escrita**, não a memória de
quem implementou o primeiro.

---

## 8. O que precisa ser decidido pelo dono do produto

Perguntas objetivas, com a recomendação deste documento ao lado. **Nada abaixo está decidido.**

### Bloqueiam a primeira linha de front-end

| # | Pergunta | Recomendação | Se não decidir |
|---|---|---|---|
| **1** | **Direção A, B ou C?** (§3) | **B — Azul de operação** | Nada de front começa sem isso |
| **2** | O GeraCRM é vendido como **produto próprio** ou como **módulo da suíte Gera3/drezz**? | Produto próprio, com preço próprio | Esta responde a #1 sozinha. É pergunta comercial, não estética |
| **3** | "Marcante" significa **cor forte** ou **um elemento memorável num ambiente quieto**? | O segundo | Sem isso, o time entrega saturação e o dono reprova depois de duas semanas |
| **4** | O **indicador de janela de 24h** (§3.2) é aprovado como elemento assinatura? | Sim | É o que separa a Direção B de "mais um SaaS azul" |
| **5** | **Monoespaçada para identificadores** (SKU, CNPJ, telefone, protocolo)? | Sim | Decisão barata, muito visível, difícil de reverter depois |
| **6** | Existe **logotipo e nome definitivo**? Existe arquivo vetorial? | — | ⚠️ Este documento cobre o sistema visual, **não a marca gráfica**. São trabalhos diferentes |

### Bloqueiam o fechamento dos tokens

| # | Pergunta | Recomendação |
|---|---|---|
| **7** | Fonte: comprada, Google Fonts ou do sistema? Há **orçamento** para licença? | Licença livre (OFL). ⚠️ Confirmar a licença **antes** de fixar |
| **8** | **Densidade** — linha de tabela de 32px é aceitável, ou o dono prefere mais folga? | 32px. ⚠️ Decidir **agora**: densidade não é ajuste de CSS depois, muda o que cabe na tela |
| **9** | Densidade é **fixa** ou vira preferência do usuário (confortável/compacta)? | Fixa na v1 | Preferência dobra o teste de toda tela |
| **10** | **Modo escuro** entra na v1 ou fica para depois? | v1 — os tokens já nascem com os dois; adiar custa mais | |
| **11** | O produto vai precisar de **white-label** (revenda com marca do cliente) e quando? | Se a resposta for "sim, em 12 meses", isso **puxa para a Direção C** |
| **12** | O **nível de acessibilidade** é AA (4.5:1) ou há exigência de cliente/licitação para AAA (7:1)? | AA. ⚠️ AAA muda a paleta inteira e é decisão de negócio |

### Ficam para o protótipo, mas precisam de dono

| # | Pergunta |
|---|---|
| **13** | Som de mensagem nova: liga por padrão? É configurável por usuário? |
| **14** | **Atalhos de teclado** de uma tecla (`/`, `j`, `k`, `e`) entram? Quem define o conjunto? |
| **15** | Notificação de desktop no console: entra na v1? |
| **16** | A vendedora pode escolher o tema, ou o tenant fixa um para toda a equipe? |

---

## 9. O que fazer com a resposta

| # respondido | Próximo passo |
|---|---|
| 1–6 | Ratificar ou reescrever o ADR-012 em `decisoes.md`, e alinhar `docs/identidade-visual.md` |
| 7–12 | Fechar `packages/design-tokens/tokens.json` com os valores definitivos e ligar o verificador de contraste no CI |
| Todos | Protótipo em alta fidelidade de **uma** tela — o inbox, porque é onde a vendedora passa o dia e onde a densidade quebra. Só depois dele os demais componentes |

⚠️ **A ordem importa.** Protótipo antes de token produz token retroajustado; token antes de direção
produz retrabalho de paleta; componente antes de token produz cor literal espalhada — que é o único
cenário caro da §3.5.
