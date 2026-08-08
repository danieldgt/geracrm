# Revisão final — o que sobrou depois das correções

> Varredura de todo o `docs/` depois de ADR-013, ADR-014, **ADR-015**, da migration D-11b, da tarefa
> E3-15, da renumeração `0018` e da correção de `tokens.json`. Cruza `plano-onda-0.md`,
> **`plano-onda-1.md`** (novo), `plano-ondas-1-4.md`, `modelo-de-dados.md`, `contrato-api.md`,
> `cenarios-bdd.md`, `escopo-funcional-geracrm.md`, `backlog-epicos-geracrm.md`,
> `entrada-do-primeiro-cliente.md`, `metricas-de-sucesso.md`, `processo-de-trabalho.md`,
> `biblioteca-componentes.md`, `especificacao-telas*.md`, `decisoes.md`, `prontidao-para-inicio.md`
> e `packages/design-tokens/tokens.json`.
>
> **Só lista problema.** O que fechou não aparece. Cada achado traz o arquivo e o texto que entra.

---

## 0. Veredito em seis linhas

| | |
|---|---|
| **O que fechou de verdade** | Migrations sem colisão (`0001`…`0023`) · 60/60 invariantes com cenário · modelo atualizado com as 6 colunas/4 tabelas novas · `retentavel` e `origem: {conexaoId, nome, conector}` no contrato · os 7 IDs de requisito novos existem no escopo e no backlog · ADR-013/014/015 escritos |
| **O que ADR-015 quebrou e ninguém consertou** | 🔴 **O eixo de tempo.** `entrada` §7 continua ancorado em `T` como se `T` estivesse na Onda 0. Três documentos agora discordam de **quando a janela de sombra roda** — e a distância entre as leituras é de ~14 semanas (§1.1) |
| **O achado mais caro** | 🔴 **O critério de saída nº 5 da Onda 0 é insatisfazível como está escrito**: MN-01 exige LB-01…**LB-15** congeladas, e **LB-07 é uma foto do dia do `primeiro_corte`** — evento da Onda 1, sobre RFV que é Onda 2 (§1.3) |
| **O segundo mais caro** | ⚠️ **Duas tarefas do plano da Onda 0 já estão feitas** (`E1-07` e `R-06`) e continuam agendadas com dependentes. Quem executar o plano ao pé da letra reescreve `especificacao-telas-entrada.md` e `contrato-api.md` (§2.3) |
| **Rastreabilidade** | 1 tarefa nova sem ID de requisito (**E3-21**), 1 marginal (**E5-12**). O resto está amarrado (§2) |
| **Falta para a 1ª linha de produção** | **Nada.** `R-01` e `R-03` são desbloqueáveis hoje. O que está bloqueado é a **primeira migration** e a **primeira semana útil** — §7 |

---

## 1. ⚠️ Contradições que sobraram

### 1.1 🔴 A janela de sombra tem duas datas, e elas estão a ~14 semanas uma da outra

É o item que ADR-015 mexeu sem terminar. `entrada` §7 foi escrito quando `T` (corte do piloto)
morava dentro da Onda 0. ADR-015 mudou `T` para a **Onda 1** — e o eixo `T-8 … T+6` ficou onde
estava, agora ancorado em outro lugar.

| Documento | O que diz | Onde isso cai no calendário real |
|---|---|---|
| `plano-onda-0.md` §5.5 | *"começa 2 semanas **ANTES** da ficha de entrada — ou seja, **antes da S0**"*, com a ficha de entrada na **S0 da Onda 0** | ≈ **T-22** |
| `plano-onda-1.md` §2.1 (TX-02) | *"**T-8**, na Onda 0"* | Com `T` = **S7 da Onda 1** (§7 do próprio arquivo), T-8 é a **última semana da Onda 0** |
| `entrada` §7 e `metricas` §1.3 | *"**T-8**, duas semanas antes da ficha de entrada"* | ⚠️ Amarra sombra **e** ficha ao mesmo eixo — e a ficha está na S0 da Onda 0 |

⚠️ **As três não podem ser verdade juntas.** Pior: as duas leituras têm defeitos **opostos**, e
escolher errado custa exatamente o dado que a §1.1 de `metricas` chama de irrecuperável.

| Se rodar antes da S0 da Onda 0 (≈T-22) | Se rodar em T-8 |
|---|---|
| A equipe ainda não sabe de nada ✅ | ⚠️ A ficha de entrada foi assinada há ~14 semanas (`entrada` §1.C: conversa com o gestor sobre carteira, vendedoras e turnover). **A equipe sabe.** O tempo de resposta já melhorou sozinho — que é exatamente o que a §1.3 de `metricas` manda evitar |
| ⚠️ LB-11/LB-12 medidos ~5 meses antes do `primeiro_corte`; MO-07 × LB-11 atravessa uma coleção inteira — a **armadilha nº 1** de `metricas` §1.5 (sazonalidade) aplicada à própria régua | A defasagem é de 8 semanas ✅ |

| Onde muda | O que escrever |
|---|---|
| `entrada-do-primeiro-cliente.md` §7 | ⚠️ **Quebrar o eixo em dois.** Cabeçalho novo antes da tabela: *"Este cronograma tem **duas âncoras**, não uma. As linhas **T-8 (sombra)** e **T-6 (ficha + M-13)** são ancoradas na **S0 da Onda 0** e correm ali (ADR-015). De **ENS-1** em diante, a âncora é `T` = **S7 da Onda 1** (`plano-onda-1` §7). Ler a tabela inteira como um único `T` é o que ADR-015 tornou impossível."* Renomear as duas primeiras linhas para **`S0-2`** e **`S0`** |
| `plano-onda-1.md` §2.1 | Em TX-02 e TX-01, trocar *"T-8, na Onda 0"* / *"T-6, na Onda 0"* por **"S0-2 da Onda 0"** e **"S0 da Onda 0"** |
| `metricas-de-sucesso.md` §1.3 | Substituir *"A sombra tem semana no cronograma: `T-8`"* por *"A sombra roda na **S0-2 da Onda 0**, duas semanas antes da ficha de entrada. ⚠️ Entre ela e o `primeiro_corte` há ~5 meses: LB-11 e LB-12 gravam `apurado_em` e a comparação de MO-07 declara a defasagem — a régua é honesta sobre a própria idade"* |
| `metricas-de-sucesso.md` §1.2 | LB-10…LB-12: acrescentar coluna/observação **"defasagem até o corte"**, porque ela deixou de ser de 8 semanas |

### 1.2 🔴 `entrada` §7 ainda fecha a Onda 0 dentro da Onda 1

Linha **T+1** da tabela (`entrada-do-primeiro-cliente.md:557`):

> `| **T+1** | Gate D+7 do piloto → lote 2 | ✅ Fecha o critério de saída nº 2 da Onda 0 |`

⚠️ **T+1 é a S8 da Onda 1.** É resíduo literal do texto anterior ao ADR-015 — que a §7.✅ do mesmo
arquivo já declara superado três parágrafos abaixo. Um leitor que abre a tabela e não lê a seção
seguinte conclui que a Onda 0 fecha depois do segundo lote do cliente.

| Onde muda | O que escrever |
|---|---|
| `entrada-do-primeiro-cliente.md` §7, linha T+1 | *"Gate D+7 do piloto → **lote 2 (+2 números)**. ⚠️ **Nada da Onda 0 fecha aqui** — o critério de saída nº 2 da Onda 0 foi atendido com números da Gera3 (ADR-015). O que fecha aqui é o **gate do lote 1** da Onda 1"* |

### 1.3 🔴 O critério de saída nº 5 da Onda 0 não é satisfazível — LB-07 depende da Onda 1

`plano-onda-0.md` critério 5 e `metricas` MN-01 exigem **LB-01…LB-15 gravadas e congeladas** ainda
na Onda 0. Mas `metricas` §1.2 define:

> **LB-07** — *"Distribuição RFV da base **no dia do `primeiro_corte`**"* · fonte: *"job de RFV sobre `venda`"* · *"(RFV é **Onda 2**; a foto se reconstrói)"*

⚠️ **Uma métrica cuja data de apuração é um evento da Onda 1, calculada por um job da Onda 2, não
pode estar num conjunto congelado na Onda 0.** E `metricas` §1.4 é categórico: *congelada é
imutável, correção entra como linha nova*. Congelar LB-07 vazia agora obriga uma segunda linha
depois — no exato mecanismo que a regra existe para evitar.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md`, critério nº 5 | *"`linha_base_metrica` com **LB-01…LB-06 e LB-08…LB-15** gravadas, `congelado_em` preenchido e conferido com o cliente. ⚠️ **LB-07 fica de fora por definição**: é foto do dia do `primeiro_corte` (Onda 1) e depende do job de RFV (Onda 2) — e é **reconstituível**, ao contrário de LB-10…LB-12"* |
| `metricas-de-sucesso.md` §1.2, LB-07 | Acrescentar: *"⚠️ **LB-07 não entra em MN-01.** Ela é capturada na Onda 1, no dia do `primeiro_corte`, e como é reconstituível pode entrar até na Onda 2, quando o job existir"* |
| `metricas-de-sucesso.md` MN-01 (§linha 159) | *"LB-01…LB-06 e LB-08…LB-15 gravadas ✅"* |

### 1.4 RFV-08 tem três ondas em três documentos, e a fonte de ID continua na errada

| Documento | Onda | Papel do documento |
|---|---|---|
| `escopo-funcional-geracrm.md:255` | **3** | ⚠️ **É a fonte dos IDs de requisito** (`processo-de-trabalho` §2.1) |
| `backlog-epicos-geracrm.md:304` | **1** | mitigação do risco nº 1 |
| `plano-onda-1.md` §9 / E4-16 | **1** | *"Divergência resolvida aqui"* |
| `plano-ondas-1-4.md` §3.6 e §7.3 | **aberta** | ainda pede *"resolver na abertura"* — a onda já abriu |

⚠️ **A decisão foi tomada no plano e não desceu para o escopo.** Quem consultar o ID vai ler
"Onda 3" e cortar o card.

| Onde muda | O que escrever |
|---|---|
| `escopo-funcional-geracrm.md` linha RFV-08 | Onda **1**, com a nota: *"⚠️ **Onda 1 por decisão**: durante a transição ela é ferramenta de higienização (40% da base sem documento na referência), não relatório — E4-16"* |
| `plano-ondas-1-4.md` §3.6 e §7.3 item 1 | Trocar as duas *"divergência a resolver"* por **✅ resolvida — RFV-08 Onda 1, PLT-11 Onda 2** |

### 1.5 PLT-11 idem, com o backlog na ponta errada

`escopo` diz Onda 2 · `plano-onda-1` §9 diz Onda 2 · **`backlog-epicos-geracrm.md:46` lista PLT-11
dentro de EP-07, que é Onda 1**. E `plano-onda-1` §5.3 entrega EP-07 com PLT-05 e PLT-07 apenas.

| Onde muda | O que escrever |
|---|---|
| `backlog-epicos-geracrm.md` §3, linha EP-07 | `PLT-05, PLT-07` — e **PLT-11 desce para o épico de plataforma da Onda 2** |

### 1.6 Indicador de presença: a biblioteca diz Onda 1, o plano da onda diz que não entra

`biblioteca-componentes.md` §7, pendência nº 6: *"Indicador de presença — **Onda 1**, comportamento
já definido em `geracrm-tempo-real`"*. `plano-onda-1.md` §3 e §9: fica **fora** (INB-18 é Onda 2, e
*"implementar 'só o aviso' sem presence é mostrar informação errada na tela mais sensível do produto"*).

| Onde muda | O que escrever |
|---|---|
| `biblioteca-componentes.md` §7, pendência 6 | *"**Onda 2** com INB-18. ⚠️ A ficha visual não sai antes do presence com heartbeat (ADR-007) — aviso de colisão sem presence declarado mostra informação errada"* |

### 1.7 Duas dependências do plano da Onda 1 vencem depois da tarefa que as consome

| Tarefa | Dep. declarada (§5) | Semana da tarefa (§7) | Semana da dep. (§7) |
|---|---|---|---|
| **E5-03** lista de conversas | `E5-02, `**`D-23`** | **S2** | **S5** ⚠️ |
| **E5-08** triagem · **E4-13** preferências | **`BC-04`** | S5 · S4 | ⚠️ **BC-04 não aparece no cronograma §7** |

⚠️ Não é detalhe de sequência: a lista de conversas **é** a tela que os índices da D-23 existem para
servir. Construí-la três semanas antes do índice é medir desempenho na tela errada e "otimizar" o
que já ia ficar rápido.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-1.md` §7 | **D-23 desce para a S2** (ou E5-03 declara só o índice de `ultima_mensagem_em`, e o resto da D-23 fica em S5). **BC-04 entra na S1**, junto de BC-03 — E4-13 é S4 e não pode depender de item sem semana |

### 1.8 `0011c` é reserva de número escrita em prosa — o erro que o processo acabou de proibir

`plano-onda-1.md` D-19: *"Se a Onda 0 ainda estiver aberta, ela desce para uma **`0011c`**"*.
`processo-de-trabalho` §3.2, regra 4 (escrita **por causa** da colisão do `0017`): *"a reserva vive
na **tabela §4 do plano da onda**, não na cabeça de quem escreveu"*.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §4, após D-11b | Linha **D-11c / `0011c_canal_configuracao.sql` — ⚠️ condicional**: *"`canal_configuracao` (`disparo_pausado`, motivo, `pausado_em`). Só existe **se a Onda 0 ainda estiver aberta** quando I-11/MT-01 forem ligados; caso contrário o conteúdo vai para D-19 e **este número é queimado, não reciclado**"* |

### 1.9 `prontidao-para-inicio.md` está datado de hoje e descreve o estado de anteontem

É o primeiro documento que alguém abre para responder *"dá para começar?"*.

| O que ele diz | O que é verdade hoje |
|---|---|
| *"Ondas 1–4: plano de execução **ausente**"* | `plano-ondas-1-4.md` (macro) + `plano-onda-1.md` (detalhado) existem |
| *"🔴 **Três lacunas** que ninguém mapeou"* | As três viraram `entrada`, `processo-de-trabalho` e `metricas-de-sucesso` |
| *"12 ADRs"* · *"64 entidades"* · *"migrations `0001`–`0010`"* | **15 ADRs** · **70 entidades** · **`0001`–`0023`** |
| *"Biblioteca de componentes — **antes da Onda 1**"* | **Bloco 1 é Onda 0** (R-12, S1–S2) |
| §6: *"⑥ Migrations 0001–0010 · ⑦ Conector GeraCloud"* | A ordem real está em `plano-onda-0` §5.5 |

⚠️ Mesmo defeito, menor, em `processo-de-trabalho` §11: ainda lista *"métrica de produto por onda"*
e *"processo de virada do cliente"* como lacunas — os dois documentos existem.

| Onde muda | O que escrever |
|---|---|
| `prontidao-para-inicio.md` | Reescrever §1–§5 contra o estado atual, **ou** marcar o arquivo como **histórico** no cabeçalho e apontar para `revisao-final.md` §7. ⚠️ Documento de prontidão desatualizado é pior que ausente: ele responde com confiança |
| `processo-de-trabalho.md` §11 | Remover as duas linhas cobertas; manter runbook e post-mortem |

---

## 2. Rastreabilidade — toda tarefa tem ID de requisito?

**Quase.** As tarefas de infra (`I-*`, `R-*`, `D-*`, `BC-*`) e as de transição (`TX-*`) não precisam
— não são requisito de produto. Entre as de épico, sobram três casos.

| # | Tarefa | Problema | O que escrever |
|---|---|---|---|
| **2.1** 🔴 | **E3-21** — *conciliação painel Meta × `mensagem`, como comando executável* (`plano-onda-1` §5.4) | ⚠️ **É a prova dos critérios de saída nº 1 e nº 2 da Onda 1** e não tem ID. É o **gêmeo exato** de E2-16, que recebeu `INT-14` justamente por isso. Sem ID, ninguém sabe o que se perde ao cortá-lo — e ele é o primeiro candidato a virar "a gente confere na mão" | `escopo-funcional-geracrm.md` §Integrações: **INT-18 — Conciliação de faturamento do canal**: *"comando que compara o painel da Meta com `mensagem`, por número e por dia, e lista toda conversa faturada sem linha correspondente. ⚠️ Divergência = alguém está usando o WhatsApp Web"* · onda **1**. Anotar `E3-21 · INT-18` |
| **2.2** | **E5-12** — *marcar não lido / `conversa_leitura`* | INB-06 cita o **badge** de não lido, não a ação de marcar. Requisito implícito | `escopo-funcional` INB-06: acrescentar *"…e **marcar como não lido**, por usuário — duas vendedoras no mesmo número têm não-lidos diferentes"* |
| **2.3** ⚠️ | **E1-07** e **R-06** (`plano-onda-0` §3.1 e §5.1) | 🔴 **Os dois entregáveis já existem**: `especificacao-telas-entrada.md` (964 linhas — login, convite/aceite, onboarding do tenant, seleção de filial/número, equipe, frota, perfil, planos, com os cinco estados) e `contrato-api.md` (1199 linhas). O plano ainda os agenda em S0/S1, **e E3-01 declara dependência de E1-07** | `plano-onda-0.md` §3.1 e §5.1: marcar **✅ concluído**, apontando o arquivo. §5.5: liberar a S0 e a S1. ⚠️ Quem executar o plano ao pé da letra reescreve os dois documentos — e a segunda versão vira a segunda fonte de verdade |

⚠️ **Os sete IDs criados na revisão anterior (INT-14…17, CTT-16/17, PLT-12…14) estão corretos e
completos** em `escopo-funcional` e `backlog`, e as tarefas E2-16…E2-21 os citam. Isso fechou.

---

## 3. Migrations — ✅ sem colisão, com um mecanismo faltando

| Verificação | Resultado |
|---|---|
| Arquivos citados em tarefa × tabela numerada | ✅ `0001`…`0023`, mais `0003b` e `0011b`. **Nenhum número duplicado** |
| `0017` (métricas) × `0018` (conciliação) | ✅ Renumeração aplicada em `plano-onda-0` §4, `entrada` §9.2, `metricas` §6.2/§10 e `modelo-de-dados` §8 |
| Migration citada em tarefa e ausente da tabela | ✅ Nenhuma. `D-00` é PoC, não arquivo |
| Tabelas criadas por migration e ausentes do modelo | ✅ Todas presentes, inclusive `importacao_arquivo`/`importacao_linha_erro` — que `plano-onda-1` D-22 manda entrar *"no mesmo PR"* |
| `0011c` | ⚠️ §1.8 acima |
| **Mecanismo automático contra colisão** | 🔴 **Não existe** — abaixo |

### 3.1 🔴 O nono varredor não foi criado, e a regra ficou sendo disciplina

`plano-onda-0` §5.6 continua com **oito** varredores (Tenancy, INV-02, INV-04, INV-60, INV-46,
INV-48, Partições, Watch path). O preâmbulo da própria seção diz: *"cada um destes existe porque a
alternativa é 'todo mundo lembra de checar' — e **invariante protegida por disciplina é invariante
violada**"*. E `processo-de-trabalho` §3.2 registra, com nome e data, que a colisão do `0017`
*"só apareceu numa revisão cruzada"*, porque *"as regras 1 a 3 — todas sobre PR e branch — não
tinham como pegar"*.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §5.6 | Nono varredor — **Numeração**: *"falha quando (a) existem dois arquivos com o mesmo prefixo em `infra/migrations`, (b) um número presente na tabela §4 do plano da onda não tem arquivo correspondente depois da semana declarada, ou (c) um arquivo existe sem linha na tabela §4"* |
| `plano-onda-0.md` R-08 e §8 | Trocar *"os oito varredores"* por **"os nove varredores"** nos três lugares |

---

## 4. Invariantes × BDD — ✅ 60/60, com três comportamentos novos descobertos

| Verificação | Resultado |
|---|---|
| INV-01…INV-60 com cenário mapeado (`cenarios-bdd` §14) | ✅ **60/60**, sem lacuna |
| Cobertura das exigências transversais (isolamento, janela, PED-08, opt-out, throttling, fila) | ✅ Completa |
| Comportamentos **novos** das Ondas 0–1, entrados depois da escrita do BDD | 🔴 **Três sem cenário** |

⚠️ `cenarios-bdd.md` é do dia anterior às correções. Ele não errou; ele não foi reaberto.

| # | Comportamento | Onde nasceu | Por que precisa de cenário |
|---|---|---|---|
| **4.1** 🔴 | **`primeira_resposta_em` × `primeira_resposta_humana_em`** — a mensagem de ausência automática preenche a primeira e **não** a segunda | D-12, E6-05, MC-05 | ⚠️ É **regra de negócio com consequência de métrica**: auto > 30% ⇒ *"MO-07 deixa de ser lida"*. Hoje ela vive só como DoD de uma tarefa. Escrever em §6: *"Dado atendimento sem resposta, quando a mensagem de ausência é enviada, então `primeira_resposta_em` é gravada e `primeira_resposta_humana_em` continua vazia"* |
| **4.2** | **`canal.destino_fora_da_allowlist`** (E3-09) | `processo` §8.3 | O documento insiste que é **código, não configuração**. Regra que só existe em DoD de tarefa é regra que some no refactor. §5: *"Dado ambiente ≠ prod e destino fora da allowlist, quando envia, então recusa **antes** de chamar a Meta, com código tipificado"* |
| **4.3** | **`contato.origem_carga` gravada no `INSERT`** (CTT-17/E2-21) e **opt-out importado com `origem='migracao'`** (CTT-16/E2-19) | D-08, D-09 | §3 cobre a reconciliação e §4 cobre a **chave reduzida**, mas nenhum cenário cobre a **importação**. ⚠️ E2-19 é *"pré-requisito do go-live, não do cancelamento"* — o cenário é o que impede que ele vire tarefa de última hora |

⚠️ **Nenhum dos sete IDs novos (INT-14…17, CTT-16/17, PLT-12…14) aparece em `cenarios-bdd.md`.**
Três deles são comandos executáveis (RC, perfilamento, recarga) e cabem em TDD; **CTT-16, CTT-17 e
INT-17** são regra de negócio e cabem em BDD.

---

## 5. Componente × token — T-01 e T-04 fechados, quatro furos abertos

✅ **Resolvidos:** `acao-pressionada`, `superficie-selecionada`, `borda-erro` existem nos dois temas;
`claro.fundo` aponta para `{branco}`; os cinco degraus da rampa RFV viraram primitivos nomeados
(`rampa.fiel`, `rampa.potencial`, `rampa.atencao`, `rampa.semi`, `rampa.hibernando`).

⚠️ Os itens abaixo quebram o mecanismo nº 1 da §0.1 da biblioteca — *"`tokens.json` como fonte única,
garantido por build + `tokens.d.ts` + lint que proíbe literal de cor"* — **antes de ele existir**.

| # | Achado | Onde muda / o que escrever |
|---|---|---|
| **5.1** ⚠️ | **O véu do modal continua sendo cor literal, na ficha que proíbe cor literal.** `biblioteca` §4.2 (l.561) escreve `rgba(13,24,48,0.5)`; §6.3 (l.1223) lista *"Cor literal (`#3F6FBE`, `rgb(…)`) → barrado por lint"*. O lint de **R-12** barraria a própria ficha | `tokens.json`, bloco novo: `"veu": { "claro": "rgba(13, 24, 48, 0.50)", "escuro": "rgba(6, 12, 26, 0.65)" }`. `biblioteca` §4.2: citar o token |
| **5.2** ⚠️ | **A rampa RFV tem cor, não tem degrau — e a ficha exige degrau.** `biblioteca` §5.2 (l.847): *"no escuro… o texto do badge muda para o degrau `300`"*. Nenhuma das **11** faixas de `tokens.json → rfv` tem `300`/`700`. E o badge de estado (§2.6) pede *"cor de estado a 12% + texto na cor 700/300"* — **não existe token de fundo a 12%** | `tokens.json → rfv`: cada faixa vira `{ "500": …, "300": …, "700": …, "fundo": … }`, **as onze**, verificadas nos dois temas por **par** de tokens (`identidade-visual` §8). Sem isso a rampa de 11 passos não é reverificável no escuro, que é o que `direcao-visual` §5.3 exige |
| **5.3** | **Doze medidas fixadas na ficha e ausentes de `densidade`**: controle `sm` 24 / `md` 28-44 / `lg` 36-52 · item de lista do app 64px · célula de grade 44×36 e 44×44 · checkbox 16/22 · trilho do toggle 32×18 e 44×26 · avatar 24/32/40/56 · tooltip máx. 280px · badge 20px · chip 24px. ⚠️ **E um token que mente**: `alvo-clique-console: 28px`, enquanto §1.6 manda *"28px visual, **32px de área de clique** via hit area"* | `tokens.json → densidade`: acrescentar as medidas; **renomear** `alvo-clique-console` → `controle-md-console: 28px` **+** `hit-area-console: 32px` |
| **5.4** | **Três estados de interface prometidos "no servidor" e sem casa.** `biblioteca` §3.1 (l.440), §3.4 (l.499-500) e §5.5 (l.950): retração do painel, colapso do menu e velocidade do player *"persistidos por usuário no servidor — ela usa dois computadores"*. `contrato-api` `/eu/preferencias` declara aparência, notificações, assinatura e escopo ativo; `usuario_preferencia` (D-21) tem as mesmas quatro | `contrato-api.md` §5.1 e `modelo-de-dados` `usuario_preferencia`: acrescentar `interface: { menuColapsado, paineisRetraidos[], velocidadeAudio }`. ⚠️ *"Saco de **interface**, nunca de regra: nada que o servidor precise ler para decidir"* |
| **5.5** | **`janelaExpiraEm` não existe na API.** `biblioteca` §5.1.1 (l.710) e §6.3 (l.1220) leem `janelaExpiraEm`; `GET /conversas/{id}` entrega `janela: { aberta, expiraEm, duracaoH, reabrePor }` | `biblioteca-componentes.md`: trocar por **`janela.expiraEm`** e citar o objeto inteiro — `aberta` é o que o composer usa, `reabrePor` é o que o modo-template mostra |

---

## 6. Erro em tela × catálogo do contrato

| Verificação | Resultado |
|---|---|
| Os cinco erros de PED-08 (`especificacao-telas` §2.4) | ✅ Todos no catálogo, com `502` e `504` **separados** e a proibição do botão de retentar no `504` |
| Erros de canal, atendimento, contato e campanha | ✅ Presentes, com `retentavel` e `origem: { conexaoId, nome, conector }` |
| `canal.destino_fora_da_allowlist` e `canal.template_nao_aprovado` | ✅ No catálogo |
| **Erros citados em rota e ausentes do catálogo** | ⚠️ **Um** — abaixo |
| **Erros que a tela distingue e não têm código** | 🔴 **Três** — abaixo |

### 6.1 ⚠️ `onboarding.passo_anterior_pendente` é citado numa rota e não está no catálogo

`contrato-api.md:458` — `POST /onboarding/passos/{passo}/concluir` declara o erro; a §4.3 não o
lista. É o único caso em todo o contrato.

### 6.2 🔴 As três falhas do Embedded Signup têm tela e não têm código

`especificacao-telas-entrada.md` §3.5 especifica **três tratamentos diferentes**, e a única rota do
signup (`POST /canais/whatsapp/signup`) declara apenas `plano.limite_excedido`:

| O que a tela faz hoje | Código que falta |
|---|---|
| *"Este número já está registrado em outra conta WhatsApp Business"* + as duas saídas (migrar ou usar outro) | `canal.numero_em_outra_waba` |
| ⚠️ *"conecta e funciona, com limite de 250 contatos novos por 24 h"* — **é estado, não erro**: passo fica `✓ com ressalva` | `canal.verificacao_de_negocio_pendente` (`200` com aviso, ou `detalhe` do estado) |
| ⚠️ *"Ainda estamos concluindo a habilitação junto à Meta"* — **falha nossa**, não do cliente | `canal.habilitacao_do_provedor_pendente` |

⚠️ Pelo critério do próprio §4.3 — *"todo código existe porque **uma tela precisa distinguir** aquele
caso de outro"* — os três são obrigatórios: cada um leva a uma ação diferente do admin, e o terceiro
**não pode culpar o cliente por processo nosso**.

### 6.3 Referência cruzada errada

`plano-onda-1.md` E3-19 aponta *"tela Meus Telefones (`especificacao-telas` §9)"*. A §9 daquele
arquivo é *"o que **ainda não** está especificado"*; a tela está em **`especificacao-telas-entrada`
§6**. Corrigir o ponteiro nos dois lugares — e remover *"Meus Telefones · configurações de número"*
da lista de pendências da §9 de `especificacao-telas.md`, porque ela já foi escrita.

---

## 7. 🔴 O que falta para escrever a primeira linha de código de produção

**Resposta curta: nada.** `R-01` (Fastify com Zod, plugin de tenant, health check e
`fastify.inject()`) e `R-03` (`packages/shared`: `Dinheiro`, normalizador de telefone,
`janelaDeAtendimento()`, uniões de literais, schemas de cursor) não dependem de decisão aberta, de
infraestrutura provisionada nem de terceiro. **Podem começar hoje.**

O que está bloqueado é outra coisa, e a distinção importa:

| Bloco | O que ele libera | Bloqueado por |
|---|---|---|
| A primeira **linha** | `R-01`, `R-03`, `R-11` | ✅ nada |
| A primeira **migration** (`0001`) | D-01…D-18 | Decisão nº 10 (PK composta) + Postgres provisionado |
| A primeira **semana útil** de épico | E1-01, E2-03, E3-01 | Cognito (I-01), GeraCloud (M-09/M-10), Meta (M-06) |
| A primeira **medida irrecuperável** | LB-10…LB-12, M-13 | Cliente — e **decisão nossa sobre a data** (§1.1) |

### (a) O que depende de nós

| # | Item | Bloqueia | ⚠️ Se ficar aberto |
|---|---|---|---|
| **a1** 🔴 | **D-00 — PoC de meio dia da PK composta `(tenant_id, id)`** com Drizzle + uma rota do console, e **ADR-016 escrito** | **`0001` e tudo depois** | É a única decisão desta onda que, revista depois da `0012`, é **reescrita de schema**. `plano-onda-0` §4 já a declara pré-requisito de `0001` |
| **a2** 🔴 | **Decidir a data da janela de sombra** (§1.1) e comunicar ao cliente | LB-10…LB-12, MN-01, critério nº 7 da Onda 1 | ⚠️ É o **único item cuja perda é definitiva**. E o conflito é nosso, não do cliente: dois planos nossos dão datas com 14 semanas de diferença. Enquanto não decidirmos, o cliente não pode começar a medir |
| **a3** 🔴 | **Corrigir §1.2, §1.3 e §1.4 desta revisão** — o T+1 de `entrada` §7, o LB-07 dentro de MN-01, e a onda de RFV-08 no escopo | O critério de saída nº 5 da Onda 0 e a leitura do cronograma | O critério nº 5 é hoje **insatisfazível**; o cronograma diz que a Onda 0 fecha na Onda 1 |
| **a4** ⚠️ | **Marcar E1-07 e R-06 como concluídos** e liberar a S0/S1 do plano | Duas semanas de calendário | Executar o plano ao pé da letra reescreve `especificacao-telas-entrada.md` e `contrato-api.md` — e a segunda versão vira a segunda fonte de verdade |
| **a5** | **Provisionar I-01…I-09**: Cognito por ambiente · **dois projetos Railway separados** · Postgres + réplica · bucket com ciclo de vida · Sentry com `beforeSend` sem PII · cofre · chave de cifra (INV-41) · domínios | `0001`, E1-01, e o webhook público da Meta | Nada é código, mas nenhuma migration roda sem banco e nenhum teste de RLS roda sem réplica |
| **a6** | **I-11 — decidir o destino de série temporal** (tabelas de agregação no Postgres × serviço gerenciado) | I-10, MT-01…MT-05, E3-18, MO-05/MO-11 | ⚠️ `plano-onda-1` §6 avisa: *"se ficou como 'decidir depois', ele vence em S1"*. Sem ele, MT-01 alerta e **não pausa** — que é `metricas` §4 sendo violado |
| **a7** | **I-02 — ADR do que o token carrega.** A §2.2 do plano já decidiu de fato (tenant no claim, papel por filial no nosso banco, staff por group) | Nada, tecnicamente | A tarefa I-02 diz *"pronto quando: **ADR escrito em `decisoes.md`**"*, e `decisoes.md` não o tem. Decisão fechada fora do lugar onde time e agentes procuram |
| **a8** | **R-11 — script de anonimização determinístico por tenant** | E2-17 na **S1**, e o uso de M-11 | ⚠️ Anonimização aleatória **destrói B-03 e B-04** (duplicidade e cardinalidade são o que o perfilamento mede). E `processo` §8.3 proíbe fazer à mão |
| **a9** | **Os furos pequenos**: INT-18 para E3-21 (§2.1) · nono varredor de numeração (§3.1) · D-11c na tabela (§1.8) · 3 cenários BDD (§4) · 4 blocos de token (§5) · 4 códigos de erro (§6) · sequência de D-23/BC-04 (§1.7) · `prontidao-para-inicio.md` (§1.9) | Nada isoladamente | ⚠️ Todos são **horas**, e todos ficam caros no dia em que o código os alcança: token inventado na primeira tela é copiado na segunda; erro sem código vira `string.includes()` |
| **a10** | **Política de privacidade, termos e base legal** (E7-07) | ⚠️ **M-07 (App Review)** — a Meta exige a URL da política | É jurídico nosso, e está no caminho crítico externo sem estar na tabela dele |
| **a11** | **Precificação concreta** e a cláusula de desistência no meio do corte (risco nº 2 da Onda 1) | Onda 2 (cobrar); o corte da Onda 1 | *"Sem essa cláusula, desistir no meio vira negociação durante um incidente"* |

### (b) O que depende de terceiro

| # | Item | Dono | Espera | ⚠️ |
|---|---|---|---|---|
| **b1** 🔴 | **M-13 — situação dos números do cliente na Meta.** Número novo? WhatsApp Business App? Ou **API Oficial dentro da WABA da ferramenta atual**? | **Cliente** (dono do BM) — e, no pior caso, o **concorrente** | **até 3 semanas** | ⚠️ **Pode ser o caminho crítico real, acima da própria Meta.** Se for portabilidade entre WABAs, depende de ação do detentor — *"o concorrente que está perdendo o cliente"* — e **não tem plano B**: número novo perde o reconhecimento da base. Abrir **por escrito**, pelo cliente, na S0 |
| **b2** 🔴 | **M-04 Business Verification → M-05 Tech Provider → M-07 App Review** | **Meta** | dias a **semanas**, com reprovação possível | Por ADR-015 **não bloqueia a Onda 0** — bloqueia o corte, na Onda 1. ⚠️ Mas M-07 exige screencast do Embedded Signup **em URL pública**: ele só pode ser agendado quando E3-01 estiver em hom (≈S5). E o nome legal precisa ser **byte a byte** o do cartão CNPJ |
| **b3** 🔴 | **M-09 documentação da API do GeraCloud** + **M-10 credenciais de homologação isoladas** | **Time do ERP** | dias | Bloqueiam **EP-02 inteiro** — o épico mais pesado da onda, o critério de saída nº 1 e a dependência de toda a Onda 2 |
| **b4** 🔴 | **A janela de sombra** — 2 semanas, uma pessoa, ~1 h/dia: contagem diária de conversas, 30 conversas por vendedora, sem resposta às 18h | **Cliente** | 2 semanas de calendário | ⚠️ **O único item de todo o projeto que não tem remédio.** A janela fecha no `primeiro_corte` e não reabre. E ela precisa rodar **antes de a equipe saber da mudança** — depois do anúncio o tempo de resposta melhora sozinho e a Onda 1 perde o crédito. Depende de **a2** para ter data |
| **b5** | **M-11 — cópia da base real** (anonimizada pelo nosso script, sob o contrato de G-04) | **Cliente** + ERP | dias | Sem ela, E2-17 não roda na S1 e o **risco nº 1** (40% da base sem CPF/CNPJ na referência) só aparece na S6, com a carga pronta |
| **b6** | **M-12 — volume real**: contatos, anos de histórico, vendas/ano, mensagens/dia, nº de números | **Cliente** | dias | Dimensiona a partição (decisão aberta nº 1) e a janela do go-live. ⚠️ *"Barato agora, caro depois"* — sem resposta até a **S2** é o sinal antecipado do risco nº 2 |
| **b7** | **Ficha de entrada assinada** (§1.A/C/E/F/G) + **decisor nomeado (C-07)** + **autorização formal de anonimização (G-04)** + definição de *"valor da venda"* (D-07) e regra de cancelamento (D-06) | **Cliente** | 1 semana | Sem ficha não há data de go-live, e o dimensionamento do corte (filiais, vendedoras, números) é chute. ⚠️ Sem D-07 fechado, o RC compara duas definições diferentes de faturamento e "acha" divergência que não existe |
| **b8** | **Exportação do opt-out histórico** do sistema antigo | **Cliente** | — | ⚠️ **Pré-requisito do go-live, não do cancelamento** (CTT-16, RC-10, TR-06). Depois que o sistema antigo desliga, o dado **não existe em lugar nenhum** — e o primeiro disparo para quem pediu para sair é o tipo de erro que não se explica |
| **b9** | **LB-13/LB-14** — faturas do BSP/disparador e custo das ferramentas atuais | **Cliente** | horas | 🔴 Não reconstituíveis: são contrato e fatura, e somem no cancelamento. É o denominador do "quanto o GeraCRM economizou" |
| **b10** | **Método de pagamento na conta Meta do cliente** (F-04) + PIN de 2 etapas (F-03) + display name (F-05) + admin do BM (F-01) | **Cliente** | horas, se cobrado cedo | ⚠️ Sem método de pagamento **o número não envia**, e a falha aparece como *"erro ao enviar"* até E3-16 existir (ADR-002). É a falha mais comum do dia D |

---

## 8. O que esta revisão **não** achou

Registrado porque ausência de achado também é informação, e porque a próxima revisão não precisa
refazer o caminho.

| Área | Estado |
|---|---|
| Numeração de migrations | ✅ `0001`…`0023` sem colisão; a renumeração do `0018` desceu para os quatro documentos |
| Invariantes × BDD | ✅ 60/60 com cenário mapeado, mais 11 exigências transversais cobertas |
| Modelo × migrations | ✅ As 6 colunas e as 6 tabelas novas (template, template_versao, conciliação ×2, régua ×4) estão no modelo, com RLS, PK e união de literais |
| `retentavel` e `detalhe.origem` | ✅ Aplicados, com a nota de que `conector` **nunca** chega à tela |
| Precedência de atribuição, corte seco, ponto de não retorno | ✅ ADR-013 e ADR-014 escritos, e INV-43 aponta para eles |
| Linguagem ubíqua (U-01…U-05) | ✅ *"piloto paralelo"* × *"janela de sombra"*, `ENS-1`/`ENS-2` × `E1`/`E2`, `primeiro_corte`/`ultimo_corte`/`abandono_sistema_antigo` — todos separados e com nota explicando por quê |
| Rotas da API para as Ondas 0–1 | ✅ Onboarding, canais, conversas, mídia, lista de bloqueio, importação CSV, webhooks de saída, notificações, auditoria, preferências — todas presentes |
| Ordem `C-08` de `decisoes.md` | ⚠️ ADR-011 continua depois do ADR-015. Cosmético e conhecido; não vale linha de correção própria |

---

⚠️ **O padrão desta revisão, e o que ele diz sobre a próxima.** A anterior achava *"documento novo
exige da Onda 0 sem editar a Onda 0"*. Esta acha algo mais estreito e mais insidioso: **ADR-015
moveu o marco `T` de uma onda para outra, e os documentos que se ancoravam nele não foram
reancorados**. §1.1, §1.2 e §1.3 são o mesmo defeito visto de três ângulos — um eixo de tempo que
mudou de origem sem que ninguém percorresse quem apontava para ele. É o custo previsível de uma
decisão boa tomada tarde, e ele se paga em horas agora e em semanas depois do primeiro corte.
