# Identidade visual do GeraCRM

> Decisão registrada no ADR-012. Os valores vivem em
> [`packages/design-tokens/tokens.json`](../packages/design-tokens/tokens.json).

**Direção:** identidade própria — não deriva da Gera3 nem do drezz. Tons suaves de azul, tema claro
com fundo branco e tema escuro completo. Marcante e moderno.

---

## 1. A tensão que define tudo

> **"Marcante" e "oito horas por dia" puxam para lados opostos.**

Um visual marcante que cansa é um fracasso funcional. A vendedora não olha o produto — ela **mora**
nele. Design de landing page recompensa impacto; design de ferramenta de operação recompensa
**silêncio com um ponto de energia bem colocado**.

A resolução:

| | Onde |
|---|---|
| **Ambiente** — quieto, azul suave, sem ruído | 95% da tela |
| **Sinal** — cor viva, movimento, contraste | Só onde há informação urgente |
| **Assinatura** — o elemento memorável | Um só, e ele trabalha (§5) |

⚠️ **Nada é decorativo.** Em ferramenta densa, ornamento vira ruído e ruído vira erro de leitura.

---

## 2. Princípios

**Densidade é respeito.** Quem usa o dia inteiro **varre, não lê**. Linha de tabela de 32px, não 48.
Padding generoso é hospitalidade em site e obstáculo em ferramenta.

**Posição fixa vale mais que cor.** Badges sempre na mesma ordem, colunas sempre no mesmo lugar. Se
a posição muda entre cards, a varredura periférica quebra e o usuário volta a ler item por item.

**Separação por superfície e borda, não por sombra.** Sombra empilhada em tela densa cria uma
paisagem borrada. Uma borda de 1px é mais rápida de ler e mais barata de renderizar.

**Cor comunica estado, nunca hierarquia.** Se azul significa "ação" e também "informação" e também
"marca", ele deixa de significar qualquer coisa. Cada cor tem um trabalho.

**O escuro é primeira classe.** Metade da operação começa cedo e termina tarde. Modo escuro não é
inversão automática — é uma segunda leitura da mesma paleta.

---

## 3. Paleta

### O azul

Uma escala única, matiz constante em ~217°, com leve deslocamento para o violeta nos tons profundos
— é o que dá riqueza ao escuro em vez do "azul lavado" que aparece quando se escurece um azul puro.

| Token | Hex | Onde |
|---|---|---|
| `azul-50` | `#F4F7FC` | Superfície de painel no tema claro |
| `azul-100` | `#E6EDF8` | Hover suave, faixa alternada de tabela |
| `azul-200` | `#C9D9EF` | Borda de destaque |
| `azul-300` | `#9DBAE2` | Texto secundário no escuro |
| `azul-400` | `#6B94D1` | Ação no escuro |
| **`azul-500`** | **`#3F6FBE`** | **Ação primária no claro** |
| `azul-600` | `#2C56A0` | Ação pressionada |
| `azul-700` | `#234380` | Texto de marca |
| `azul-800` | `#1B3260` | Superfície elevada no escuro |
| `azul-900` | `#142442` | Superfície no escuro |
| `azul-950` | `#0D1830` | Fundo do tema escuro |

⚠️ **`#3F6FBE` é deliberadamente menos saturado que o azul-SaaS de prateleira.** O azul vibrante
funciona num botão isolado e vibra quando aparece duzentas vezes na mesma tela.

### O sinal vivo

| Token | Hex | Significa |
|---|---|---|
| **`turquesa`** | **`#0FB5AE`** | **Ativo, vivo, dentro do prazo** — janela aberta, atendente online, conexão em pé |

Uma única cor de alta energia, complementar ao azul sem brigar com ele. É o que dá o "moderno" à
paleta. ⚠️ Usada com parcimônia: se aparecer em botão comum, perde o significado.

### Estados

| Token | Hex | Uso |
|---|---|---|
| `ambar` | `#E8A317` | Atenção — janela nas últimas 2h, saldo insuficiente, meta em risco |
| `coral` | `#E5484D` | Erro, falha de envio, janela fechada, crédito bloqueado |
| `verde` | `#2E9E5B` | Confirmação — pedido efetivado, mensagem entregue |
| `violeta` | `#7C5CD6` | Conduzido por IA — distingue o robô do humano sem julgamento de valor |

⚠️ **Violeta para IA é decisão de produto**, não estética: a vendedora precisa saber num relance
quem está conduzindo a conversa.

### Segmentos RFV

Onze faixas precisam ser distinguíveis num card de kanban de 4mm de altura. Uma rampa contínua do
turquesa (campeão) ao coral (perdido), passando pelo neutro — a **posição na rampa já informa**,
antes de qualquer leitura.

```
Campeão ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━● Perdido
turquesa    azul    cinza    âmbar    coral
```

⚠️ **Nunca só cor.** Toda faixa carrega rótulo. Cor acelera quem já conhece; texto atende quem não
conhece e quem não distingue cores.

### Neutros

Não são cinzas puros — carregam traço de azul (matiz 217°, saturação 8–12%). É o que faz o produto
parecer coeso em vez de "azul aplicado sobre um template cinza".

---

## 4. Tipografia

| Papel | Família | Por quê |
|---|---|---|
| **Interface** | **Geist Sans** | Desenhada para produto, ótima em 13px, formas abertas que sobrevivem à densidade |
| **Dados** | **Geist Mono** | SKU, telefone, protocolo, CNPJ, referência |
| **Números** | Geist Sans, `tabular-nums`, peso 600, tracking −0.02em | KPI e colunas de valor |

*Alternativa segura, se Geist não servir: IBM Plex Sans + IBM Plex Mono — mesmo caráter técnico-humanista.*

### ⚠️ Monoespaçada para identificadores é escolha funcional que virou identidade

`22625-VERDE-G42`, `+55 81 99861-7049`, `60.631.000/0014-30`, protocolo `#72372.2`.

Esses valores são **comparados, conferidos e digitados** o dia inteiro. Em monoespaçada eles
alinham em coluna, o olho acha a diferença entre dois SKUs parecidos, e o dado se distingue do
texto sem precisar de cor ou negrito.

Nenhum concorrente faz isso. É a decisão tipográfica mais barata e mais visível do projeto.

### Escala

| Uso | Tamanho / peso |
|---|---|
| KPI | 32px / 600 / tabular |
| Título de tela | 20px / 600 |
| Título de seção | 15px / 600 |
| Corpo | 14px / 400 |
| **Interface densa** (lista, tabela, card) | **13px / 400** |
| Rótulo e badge | 11px / 500 / +0.02em |

---

## 5. O elemento assinatura: o anel de janela

**A única peça onde gastamos boldness.**

Toda conversa de WhatsApp tem uma janela de 24 horas. Passou, só template aprovado — é a regra que
mais afeta o trabalho da vendedora, e a que ela mais precisa perceber sem parar para ler.

Os concorrentes mostram um badge de texto: `Janela Aberta` / `Janela Fechada`.

**Nós desenhamos o tempo.**

```
   lista de conversas              header da conversa

    ╭───╮                    ┌──────────────────────────────┐
   ╱ ▓▓▓ ╲   Marília         │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░ │ ← barra drena
  │ ▓ MC  │  1 pedido        │ VEST FACIL MODAS · 4h12      │
   ╲ ▓▓▓ ╱                   └──────────────────────────────┘
    ╰───╯
  anel de 32px               barra de 2px no topo
  drena no sentido horário
```

- **Turquesa** enquanto há folga · **âmbar** nas últimas 2h · **coral** e vazio quando fecha
- Na lista: anel fino ao redor do avatar, esvaziando no sentido horário
- No chat: barra de 2px no topo, drenando da direita para a esquerda
- Movimento **contínuo e lentíssimo** — não pulsa, não pisca, não chama atenção. Só *está lá*

**Por que funciona como assinatura:**

| Critério | |
|---|---|
| Nasce do domínio | Só existe porque a Meta impõe a regra |
| É funcional | Substitui a leitura de um número por percepção periférica |
| Onipresente | Aparece em toda conversa, o dia inteiro — vira a memória visual do produto |
| Ninguém tem | O mercado inteiro usa badge de texto |
| Não cansa | Sem piscar, sem cor forte, sem som |

⚠️ **Acessibilidade:** o anel **nunca é a única fonte.** O tempo restante em texto continua no
header, e o estado é anunciado a leitores de tela. O anel acelera quem enxerga; não exclui ninguém.

---

## 6. Layout

**Raio:** 6px em controles, 10px em painéis, 999px só em badge e avatar. Moderno sem virar
"bolha" — que é o que faz uma ferramenta parecer brinquedo.

**Borda antes de sombra.** Sombra só onde há sobreposição real (modal, dropdown, painel de pedido).

**Barra de acento à esquerda** nos cards de kanban, 3px, na cor do segmento RFV. Uma faixa que o
olho lê antes do texto, e que transforma a coluna inteira em gráfico.

**Grade de 4px.** Espaçamentos em múltiplos: 4, 8, 12, 16, 24, 32.

**Movimento:** 120ms para estado, 200ms para entrada de painel, `prefers-reduced-motion` respeitado
sempre. ⚠️ Nada anima em loop, exceto o anel de janela — e ele leva 24 horas por volta.

---

## 7. Tema escuro

Não é inversão. É a mesma paleta relida.

| | Claro | Escuro |
|---|---|---|
| Fundo | `#FFFFFF` | `azul-950` `#0D1830` |
| Superfície | `azul-50` | `azul-900` |
| Superfície elevada | `#FFFFFF` + borda | `azul-800` |
| Texto primário | `#0F1B2D` | `#E8EEF7` |
| Texto secundário | `#5A6B84` | `azul-300` |
| Ação | `azul-500` | `azul-400` |

⚠️ **Fundo escuro não é preto.** `#0D1830` é azul profundo — mantém a identidade e reduz o contraste
extremo que cansa em jornada longa.

⚠️ **As cores de estado clareiam no escuro.** Coral `#E5484D` sobre fundo escuro fica agressivo e
perde contraste de texto; a versão escura usa um coral mais claro e menos saturado.

---

## 8. Acessibilidade

- **Contraste** — 4.5:1 em texto, 3:1 em elemento de interface, verificado **por par de tokens**
  (texto sobre superfície), não por token isolado
- **Foco visível** — anel de 2px em `turquesa`, com deslocamento de 2px. ⚠️ Nunca `outline: none`
- **Alvo de toque** — 44px no app; no console, 28px com área de clique estendida
- **Estado nunca só por cor** — sempre com rótulo, ícone ou posição
- **`prefers-reduced-motion`** — desliga transições; o anel de janela vira arco estático

---

## 9. O que decidimos NÃO fazer

| Descartado | Por quê |
|---|---|
| Gradientes em superfície | Ruído em tela densa; envelhece rápido |
| Sombras empilhadas | Paisagem borrada; custo de renderização |
| Ilustrações em estado vazio | Ocupam o espaço onde deveria estar a ação seguinte |
| Cantos muito arredondados | Faz ferramenta de trabalho parecer brinquedo |
| Animação de entrada em lista | Em lista que atualiza em tempo real, vira tremor |
| Azul vibrante de prateleira | Vibra quando repetido duzentas vezes na tela |
| Modo escuro por inversão automática | Produz cinza sujo e perde a identidade |

---

## 10. Inventário de componentes

Derivado das telas já especificadas:

**Base** — botão (4 variantes) · campo · select · checkbox · toggle · badge · chip de filtro · avatar · tooltip
**Estrutura** — painel · abas · tabela com cursor · card de kanban · barra lateral · cabeçalho
**Feedback** — toast · modal · esqueleto de carregamento · estado vazio · estado de erro · barra de progresso
**Domínio** — **anel de janela** · balão de mensagem · player de áudio com transcrição · badge de segmento RFV · seletor de número · grade cor × tamanho · card de tarefa · linha do tempo de segmento

---

## 11. O que ainda precisa de decisão

- **Logotipo e nome** — este documento cobre o sistema visual, não a marca gráfica
- **Licença das fontes** — Geist é OFL; confirmar antes de fixar
- **Ilustração de marca** — se haverá, e onde (a recomendação é: em nenhum lugar dentro da ferramenta)
