# Implementação — as decisões técnicas da camada

> O que foi construído, e **por quê assim**. Decisões que o código sozinho não
> explica: as que evitaram um bug, as que recusaram uma opção mais óbvia, e as que
> deixam pistas para quem mexer depois.
>
> Estado e progresso ficam em [`backlog-tecnico.md`](backlog-tecnico.md).

## O que existe

```
infra/migrations/0058_midia_estrutura.sql     conta · campanha · conjunto · anúncio · métrica
infra/migrations/0059_midia_lead_origem.sql   sessão da LP · origem do lead
packages/shared/src/dominio/midia-custo.ts    conversão de dinheiro na borda
packages/shared/src/dominio/midia-origem.ts   o código que liga anúncio ↔ conversa
apps/api/src/contexts/aquisicao/plataformas/porta.ts   a porta, com capacidades declaradas
```

⚠️ **Tudo agnóstico de plataforma, de propósito.** AMK-012/015 estão em reexame
(ver a revisão em [`decisoes.md`](decisoes.md)); nada aqui depende do desfecho.
Quando a resposta vier, entra um adaptador — não uma reescrita.

---

## 1. As armadilhas de dinheiro, e onde elas foram fechadas

### O float que erra em alguns valores e não em outros

A Meta devolve gasto como decimal em texto (`"8.29"`). O caminho natural —
`parseFloat(v) * 100` — funciona em `"12.34"` e **falha** em `"8.29"`:

```
12.34 * 100 → 1234                  ✅
 8.29 * 100 → 828.9999999999999     ⚠️ Math.floor → 828, um centavo a menos
 0.29 * 100 →  28.999999999999996   ⚠️
 4.35 * 100 → 434.99999999999994    ⚠️
```

⚠️ **O que torna isso perigoso é ser intermitente.** Um teste com `"12.34"` passa e
dá confiança falsa. `decimalParaCentavos` converte pelo **texto** — separa a parte
inteira da decimal, nunca multiplica float — o que remove a categoria inteira do
problema em vez de tapar um caso.

> Encontrei isso escrevendo o próprio teste: eu tinha afirmado que `12.34` quebrava,
> rodei, e não quebrava. Os valores acima são os que quebram de verdade, verificados.

### Arredondar, nunca truncar

Google devolve `cost_micros` (1 centavo = 10.000 micros), e a divisão raramente cai
em centavo exato. Truncar tem erro **sempre no mesmo sentido**: numa sincronização
diária por anúncio, ao longo de um ano, o desvio vira dinheiro visível no relatório.
Arredondar tem erro simétrico, que se cancela na soma.

### `"2" + "3" === "23"`

O driver devolve `bigint` como **string** (é o comportamento correto — `bigint`
excede `MAX_SAFE_INTEGER`), e somar duas colunas de custo em JavaScript concatena
sem erro e sem aviso. `somarCentavos` existe para que esse acidente não tenha onde
acontecer.

### ROAS com custo zero

Devolve `null`, nunca `Infinity`. ⚠️ `Infinity` numa tela vira "∞" e numa soma
contamina todo o agregado.

---

## 2. O código de origem — desenhado para ser perdido

Sem CTWA, a origem viaja num código dentro da mensagem pronta do `wa.me`. **O lead
pode apagá-lo.** Todo o módulo assume a perda em vez de fingir que ela não acontece.

### Alfabeto sem ambiguidade

`ABCDEFGHJKMNPQRSTUVWXYZ23456789` — sem `O`/`0`, sem `I`/`1`/`L`. O código aparece
numa conversa: pode ser lido em voz alta, redigitado, ou passado por telefone.
`A7K2Q` e `A7KZQ` não podem depender da fonte da tela para se distinguir.

### O marcador vai no fim

`Olá, vi o anúncio [ref: A7K2QX]`. Quem apaga costuma apagar **a linha inteira** —
o que produz ausência limpa, não código corrompido pela metade. Ausência dá para
detectar; código truncado vira atribuição errada.

### Extração tolerante, com um limite

Aceita em qualquer posição, com ou sem colchetes, em minúsculas (o autocorretor do
celular rebaixa maiúsculas). Mas:

⚠️ **Duas candidatas soltas → `null`, não chute.** Atribuir a venda ao anúncio errado
é pior que não atribuir: o número fica **plausível**, e ninguém desconfia. Errar de
forma visível é melhor que errar de forma convincente.

### A ausência é métrica, não exceção

A razão entre sessões consumidas e criadas mede a saúde da atribuição. ⚠️ Se ela
despenca, o ROAS está furando **em silêncio** — o lead entra, a conversa acontece, a
venda acontece, e o anúncio nunca recebe o crédito.

---

## 3. O schema — o que foi decidido contra o óbvio

| Decisão | O óbvio seria | Por que não |
|---|---|---|
| **Só métrica aditiva** em `midia_metrica_dia` | guardar alcance e frequência junto | ⚠️ Elas deduplicam **pessoas**. Somar alcance de 5 anúncios devolve mais que a verdade — e o número parece certo |
| **Grão = anúncio × dia** | guardar totais por campanha também | Duas verdades nascendo. Total de campanha é `SUM` |
| **PK `(tenant, anuncio, dia)`** | `id` sintético | ⚠️ A PK existe para o **UPSERT**: as plataformas reescrevem dias fechados por até ~28 dias enquanto a atribuição assenta |
| **`conversoes_plataforma`** com sufixo | `conversoes` | O sufixo impede confundir o que a plataforma **reivindica** com o pedido efetivado no ERP |
| **`moeda` na conta** | assumir BRL | Somar custo de contas em moedas diferentes dá número sem significado |
| **IDs externos em texto, FK depois** | só FK para `midia_anuncio` | ⚠️ O lead chega em **segundos** pelo webhook; a estrutura só na sincronização seguinte. Um desenho só-FK perderia os leads mais recentes |
| **`midia_lead_origem` 1:N** | 1:1 com contato | O mesmo contato pode voltar por outro anúncio. O toque novo **não apaga** o primeiro; o modelo de atribuição é declarado na consulta |
| **Criativo fora** | modelar junto | É Fase 3. Modelar antes da fábrica existir arrisca rename (2–3 deploys); adicionar depois é 1 |

### INV-61 — um só primeiro toque por contato

```sql
CREATE UNIQUE INDEX midia_origem_primeira_unica
    ON midia_lead_origem (tenant_id, contato_id) WHERE primeira;
```

⚠️ Sem isso, dois webhooks concorrentes marcam os dois toques como `primeira`, e a
atribuição de primeiro toque passa a depender de qual linha o `ORDER BY` escolher —
bug silencioso e **irreprodutível**. Mesmo padrão do INV-51 (`atendimento_aberto_unico`).

### Consentimento é par, não booleano

`CHECK` obriga texto **e** data juntos. ⚠️ LGPD: "aceitou os termos" sem dizer **qual
texto** é indefensável em auditoria.

---

## 4. A porta — onde a decisão vira código

`CapacidadesPlataforma` declara o que cada plataforma faz. É onde a consequência de
AMK-012/015 fica registrada **em código, não só em documento**:

```ts
readonly cliqueParaConversa: boolean   // só a Meta tem
```

⚠️ `false` no Google é exatamente o motivo de a LP com `wa.me` existir. Se a Meta
voltar, a capacidade vira `true`, o `modo_entrada` ganha um terceiro valor, e o resto
não muda. É o padrão do ADR-008: **o produto degrada em vez de quebrar, e a
degradação é visível**.

### Falha tipificada, com a ação embutida no nome

`credencial_invalida` (reconectar) · `sem_permissao` (revisar vínculo) ·
`limite_de_taxa` (⚠️ **recuar** — insistir derruba a sincronização de todos os
clientes que dividem o app) · `conta_indisponivel` (falar com o cliente) ·
`indisponivel` (esperar) · `resposta_inesperada` (a API mudou; olhar o log).

⚠️ Custo atravessa a porta **já em centavos inteiros**. Micros e float ficam dentro do
adaptador — se atravessassem, cada consumidor arredondaria do seu jeito.

---

## 5. A coerência que o compilador não garante

INV-48 proíbe `enum` no banco, então `Plataforma` (TypeScript) e o CHECK
`midia_conta_plataforma_valida` (SQL) são **duas listas escritas à mão**.

⚠️ Sem teste, acrescentar uma plataforma no TypeScript compila, passa em tudo, e só
falha em produção no primeiro `INSERT`. O teste percorre `PLATAFORMAS` e insere cada
uma no banco real — e prova que uma de fora é recusada.

É a mesma disciplina dos 9 varredores de schema do CI: *invariante protegida por
disciplina é invariante violada*.

---

## O próximo passo

Depende da resposta à pergunta nº 0 de [`perguntas-em-aberto.md`](perguntas-em-aberto.md)
— se o padrão "App do cliente" serve para a Marketing API:

- **Serve** → adaptador Meta primeiro, CTWA volta, `ctwa_clid` substitui o código na
  mensagem (mais robusto), e AMK-012/015 são revistas.
- **Não serve** → adaptador Google (AQ-04) + LP com `wa.me` (AQ-44), como planejado.

⚠️ Em qualquer dos dois, **o que foi construído continua valendo** — foi por isso que
a fundação veio antes do adaptador.

---

## 6. O roteamento — provado por exaustão, não por amostra

`rotearLead` (`packages/shared/src/dominio/roteamento-lead.ts`) decide quem atende: agente ou
pessoa. Nove regras em ordem, a primeira que casa decide.

### "Rede A/B" virou política do tenant

AMK-014 falava em Rede A × Rede B. Na implementação virou `politicaAgente`:
`autonomo` | `copiloto` | `desligado`.

⚠️ **O domínio não precisa saber quem é a Gera3 e quem é a loja.** "Rede A" é o nosso organograma,
e organograma dentro de regra de negócio envelhece mal. De quebra, um cliente também pode preferir
copiloto — o que a formulação original não permitia — e o kill switch passa a caber na mesma
dimensão em vez de virar flag paralela.

### A explicação mora junto da regra

`EXPLICACAO` mapeia cada motivo para o texto que a tela mostra ao gestor. ⚠️ Se a explicação
morasse no console, ela divergiria do comportamento no primeiro ajuste — e o gestor leria uma razão
que não foi a razão.

### Prova por exaustão

O teste enumera as **288 combinações** possíveis de entrada e verifica propriedades sobre **todas**,
não sobre os casos que alguém lembrou de escrever:

| Propriedade | Por que importa |
|---|---|
| A função é **total** | Toda entrada produz decisão; não existe estado sem resposta |
| Com `desligado`, **nada** chega ao agente | ⚠️ É o que faz o kill switch ser um kill switch |
| Em campanha outbound, **nada** chega ao agente | AMK-016 aplicado, não confiado ao operador |
| Cliente de alto valor **nunca** cai no agente | A regra inegociável, provada |
| Quem tem dono de carteira **nunca** cai no agente | A relação não é interrompida |
| A **maioria** das combinações termina em fila humana | O padrão é humano, e isso é mensurável |

⚠️ Testar os caminhos que se imagina prova que eles funcionam. Enumerar o espaço prova que **não há
caminho que escape** — e é a diferença entre um kill switch que parece funcionar e um que funciona.

---

## 7. O ROI — e por que aqui não existe "atribuição exata"

`roiDaVeiculacao` (`apps/api/src/contexts/aquisicao/roi.ts`) responde a pergunta que sustenta a
oferta: **quanto este anúncio custou e quanto ele fez faturar no ERP.**

### A distinção que eu tinha errado nos documentos

`AMK-009` herdou de `0036` a régua "exata × estimada". ⚠️ **Ela não transfere para mídia.**

Um pedido de disparo de WhatsApp **nasce vinculado** à campanha — `pedido.campanha_id` é um fato
registrado no instante da criação. A venda de um lead de anúncio acontece semanas depois, num pedido
que não carrega referência nenhuma ao anúncio. Ligar os dois é **sempre um modelo**.

Chamar isso de "exata" seria pegar emprestada uma credibilidade que o dado não tem. O que a função
devolve, separado e rotulado:

| Número | Natureza |
|---|---|
| custo · impressões · cliques | **fato** — veio da plataforma |
| leads | **fato** — a origem foi registrada na entrada |
| custo por lead | fato ÷ fato |
| receita atribuída | ⚠️ **modelo declarado** (primeiro × último toque) + janela |
| receita **sem ambiguidade** | o subconjunto onde os dois modelos concordam |

### `semAmbiguidade` — a medida de quanto o número é escolha nossa

O subconjunto de vendas cujo contato teve **um único toque de mídia**. Para eles, primeiro e último
toque são o mesmo, então o número **não depende do modelo**.

⚠️ **A distância entre o atribuído e o sem-ambiguidade mede quanto do ROAS é artefato de
modelagem.** Perto: o número se sustenta. Longe: ele é uma escolha nossa — e o cliente merece saber
disso **antes** de assinar performance em cima.

Não conheço nenhuma agência que reporte isso. É barato de calcular e é o que separa um número
auditável de um número convincente.

### Detalhes que o SQL esconde

- ⚠️ **`venda` é particionada por `ocorrida_em`.** As consultas carregam limites **absolutos** de
  data além da comparação relativa ao toque — sem constante, o planejador não poda partição e varre
  a tabela inteira.
- ⚠️ **`cancelada_em IS NULL`** em toda receita. É a convenção da casa (BI, painel, funil, ficha do
  contato) e o teste prova que a venda cancelada não entra em modelo nenhum.
- **Janela empurra o limite superior**: um lead captado no último dia do período ainda pode comprar
  dentro da janela, então a busca de vendas vai até `ate + janela`.
- `null` em vez de `Infinity` no custo-por-lead e no ROAS quando o denominador é zero.

### O teste prova a divergência, não a concordância

O cenário tem um contato tocado por **A e depois por B**. Primeiro toque credita a venda ao A;
último credita ao B. ⚠️ Um teste com um toque por contato passaria com qualquer modelo e não
provaria nada sobre o que o módulo existe para dizer.

---

## ⚠️ Achado fora do escopo: `campanha-analise.ts` conta venda cancelada

Ao conferir a convenção, encontrei que `apps/api/src/contexts/crm/campanha-analise.ts` (o ROI de
campanha de WhatsApp, `0036`) **não filtra `cancelada_em`** na receita estimada — enquanto BI,
painel, funil e ficha do contato filtram (14 usos no repositório).

**Efeito:** a receita estimada de campanha inclui vendas canceladas, inflando o ROI **na direção que
agrada** — que é o tipo de erro que ninguém reporta.

**Correção:** uma linha (`AND v.cancelada_em IS NULL`) na consulta da estimada.

✅ **Corrigido em 2026-08-21**, em commit separado, com autorização.

O bug foi **provado antes de corrigido**: acrescentei uma venda cancelada de R$ 777,77 dentro da
janela ao teste existente e rodei — o ROI devolveu **R$ 1.277,77 em vez de R$ 500,00**, inflando a
receita em 155%. Só então entrou o `AND v.cancelada_em IS NULL`.

⚠️ A **exata** não precisava do filtro: `cancelado` é *estado* do pedido (`0038`), mutuamente
exclusivo com `efetivado` — o `estado = 'efetivado'` já bastava. Conferir isso evitou uma "correção"
redundante do outro lado da conta.

---

## 8. Resolução tardia da origem — o descompasso é estrutural

O lead entra pelo webhook em **segundos**; a estrutura de veiculação só chega na sincronização
seguinte, **horas depois**. Por isso `midia_lead_origem` guarda `anuncio_externo_id` sempre e as FKs
nascem nulas (migration `0059`).

`resolverOrigensPendentes` roda depois de cada sincronização e preenche a hierarquia inteira —
anúncio, campanha e conta —, em modo dono, com `tenant_id` explícito.

### Nunca adivinha

⚠️ `midia_anuncio.id_externo` é único por **conjunto**, não por tenant. Dois candidatos para o mesmo
id externo → a linha **fica pendente**. Atribuir ao primeiro creditaria a venda ao anúncio errado, e
o número ficaria plausível. É a mesma regra de `extrairCodigoOrigem`, pelo mesmo motivo: **errar de
forma visível é melhor que errar de forma convincente.**

O retorno separa `resolvidas`, `ambiguas` e `pendentes` — ambiguidade é um estado que alguém precisa
ver, não um silêncio.

### A janela de 30 dias existe para a varredura terminar

⚠️ Se o anúncio não apareceu em 30 dias, ele não vai aparecer — foi apagado, veio de outra conta, ou
o id chegou errado. Sem o corte, cada passada arrasta para sempre um resíduo que nunca resolve.

A origem antiga **não é perdida**: continua com `anuncio_externo_id` e vale como **origem parcial** —
sabemos que veio de anúncio, não de qual.

### Idempotente por construção

Só toca linhas com `anuncio_id IS NULL`. Rodar duas vezes seguidas não muda nada na segunda — o que
importa porque ela roda a cada sincronização.

---

## 9. `midia_conversao` — a devolução do sinal

`0060`. É o que fecha o loop: sem ela, a plataforma otimiza pelo que enxerga (lead barato); com ela,
recebe de volta a venda efetivada no ERP **com o valor real** e passa a procurar quem compra.

### Entidade separada de `venda`, de propósito

⚠️ A devolução é um **fato com entrega própria**: falha, precisa de retry, dead-letter e registro.
Colapsá-la em `venda` esconderia a falha de entrega — e o painel continuaria bonito com o loop
aberto. Mesma forma do despachante de `webhook_saida` (`0033`).

### Os CHECKs que carregam a tese do produto

| Invariante | Por quê |
|---|---|
| **compra exige `valor_centavos > 0`** | ⚠️ É o ponto inteiro da tabela. Devolver compra **sem valor** faz a plataforma voltar a otimizar por volume de lead |
| compra exige `venda_id` | Sem a venda de origem, não há o que auditar |
| **INV-62** — uma venda por plataforma por tipo | ⚠️ Reprocessar duplicaria a receita no painel da plataforma — e o número ficaria **maior**, então ninguém reclamaria |
| **`event_id` único** | É a chave de dedup **da plataforma**, compartilhada com o pixel. Repetir faz a plataforma descartar um evento em silêncio |

### `descartada` ≠ `falhou`

⚠️ Dois estados porque são **causas diferentes com ações diferentes**:

- **`falhou`** — tentamos e a plataforma recusou até esgotar as tentativas. Ação: investigar.
- **`descartada`** — **nós** decidimos não enviar (fora da janela de importação, origem sem
  `click_id`). Ação: nenhuma; é esperado.

Juntá-las num só estado esconderia qual é qual no painel, e a operação passaria a tratar o normal
como incidente — ou, pior, o incidente como normal.

### Sem FK para `venda`

⚠️ `venda` é particionada e a PK é composta com a chave de partição. O precedente da casa é
`item_venda` (`0014`): carrega `venda_id` + `venda_ocorrida_em` e dispensa a FK. Seguimos o mesmo,
com CHECK garantindo que as duas colunas andam juntas.

---

## 10. O despachante de conversões — três decisões que protegem receita

`despachante-conversao.ts` segue a forma do despachante de `webhook_saida` (`0033`): varredura com
advisory lock, backoff e dead-letter. As diferenças são deliberadas.

### ⚠️ `limite_de_taxa` NÃO consome tentativa

A regra mais importante do módulo. Estourar cota **não é defeito da conversão** — é do nosso ritmo.
Se consumisse tentativa, uma rajada de rate limit mandaria ao dead-letter um lote inteiro de
conversões **válidas**, e a receita sumiria do painel da plataforma sem ninguém entender por quê.

Reagenda, não pune.

### ⚠️ Falha permanente vai direto ao dead-letter

`credencial_invalida`, `sem_permissao` e `conta_indisponivel` não melhoram com repetição — o
problema é humano. Gastar oito tentativas contra uma parede só atrasa em horas a descoberta de algo
que alguém precisa resolver. `ehFalhaPermanente` decide isso na porta, junto do motivo.

### ⚠️ O descarte acontece ANTES de chamar

Origem sem `click_id`, fato fora da janela de importação, plataforma sem a capacidade — tudo isso é
decidido sem tocar na rede. Não gasta cota, não gasta tentativa, e vira `descartada` com motivo
nomeado. Tentar o que já nasceu recusado é desperdício que aparece na cota da sincronização.

### O backoff é mais lento que o do webhook, de propósito

Webhook começa em 30s e para em 1h. Aqui começa em **5 min** e para em **6h**, porque o problema é
outro: **conversão não é notificação**. A plataforma aceita o fato dentro de uma janela de **dias**,
então correr não traz benefício — e insistir rápido contra API de anúncio gasta a cota de que a
sincronização precisa.

⚠️ Não reusei o `backoffSegundos` de `integracao/webhook-saida.ts`: importar entre contextos os
acoplaria, e a curva certa aqui é genuinamente diferente. Duas curvas com o mesmo nome em contextos
distintos é menos ruim que um contexto dependendo do outro por uma constante.

### O advisory lock não é zelo

⚠️ Conversão entregue duas vezes **infla a receita no painel da plataforma** — e o número fica
*maior*, então ninguém reclama. Duas instâncias da API despachando em paralelo produziriam
exatamente isso.

### Uma nota sobre o teste

O caso montava `proxima_tentativa_em` com o default `now()` do banco e comparava com um `AGORA`
fixo. ⚠️ Isso faz o teste depender do **relógio de parede**: com a máquina à frente do `AGORA`, a
fila vem vazia e o teste falha sem explicar por quê. Agora a coluna é explícita e o teste é
determinístico — a mesma disciplina de injetar o relógio na função.

---

## 11. O enfileirador — e a distinção que ele obriga a fazer

`enfileirar-conversao.ts` transforma venda efetivada no ERP em conversão a devolver. É o elo que
fecha o loop: a venda existe porque o conector a importou, a origem existe porque o lead entrou por
um anúncio, e aqui os dois se encontram.

### ⚠️ Aqui o modelo de atribuição do ROI NÃO se aplica

Foi a decisão que mais me fez parar. `roi.ts` escolhe entre primeiro e último toque porque responde
**ao cliente** com um número nosso. O enfileirador **não escolhe crédito nenhum**: ele entrega o
fato com o `click_id`, e **a atribuição final é da plataforma** — ela casa o clique, aplica a
própria janela e decide.

Confundir os dois faria a plataforma receber a **nossa opinião** em vez do dado. Por isso:

> **Uma conversão por plataforma por venda**, cada uma com o `click_id` do último toque *daquela*
> plataforma antes da venda.

⚠️ O `DISTINCT ON (plataforma)` é o que garante isso. Sem ele, um contato tocado por Google e Meta
geraria conversão para **um só** — e metade do sinal se perderia em silêncio, com o painel de cada
plataforma mostrando menos do que deveria.

### `event_id` determinístico

`v-{venda_id}-{plataforma}-compra`. ⚠️ Um id aleatório faria cada reprocessamento parecer um evento
**novo** para a plataforma — e receita duplicada no painel dela é o erro que ninguém reclama, porque
o número fica *maior*.

### Idempotente porque a importação repete

`ON CONFLICT DO NOTHING` sobre `midia_conversao_venda_unica` (INV-62). Roda a cada importação do ERP,
e importação repetida é o caso normal, não a exceção.

### O que fica de fora, e por quê

| Situação | Decisão |
|---|---|
| Origem sem `click_id` | Não enfileira — não haveria como a plataforma casar |
| Toque **posterior** à venda | Não credita: não pode ter causado |
| Venda cancelada | Não é receita (convenção do repositório) |
| Venda fora da janela de importação | Não enfileira — nasceria para ser descartada |

⚠️ O último é uma escolha discutível: enfileirar e deixar o despachante descartar documentaria "esta
receita não pôde voltar". Preferi não criar linha destinada ao lixo — mas **a atribuição do ROI
continua contando essas vendas**. Devolver sinal e medir receita são coisas separadas, e só uma
delas tem prazo.

### Uma armadilha de sintaxe que custou uma rodada

⚠️ Escrevi comentários SQL com **crases** (`` `event_id` ``) dentro de um template literal — e a
crase **fecha a string**. O erro do TypeScript apontava para linhas que pareciam inocentes. Dentro
de `sql\`...\``, comentário usa aspas.
