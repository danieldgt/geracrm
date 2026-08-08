# Revisão de lacunas — os cinco documentos novos contra o planejamento existente

> Revisão adversarial de `entrada-do-primeiro-cliente.md`, `processo-de-trabalho.md`,
> `metricas-de-sucesso.md`, `plano-ondas-1-4.md` e `biblioteca-componentes.md`, cruzados com
> `plano-onda-0.md`, `decisoes.md`, `modelo-de-dados.md`, `contrato-api.md`,
> `escopo-funcional-geracrm.md`, `especificacao-telas*.md`, `identidade-visual.md` e
> `packages/design-tokens/tokens.json`.
>
> **Este documento só lista problemas.** O que está consistente não aparece. Cada achado tem o
> arquivo que deve mudar e o texto que deve entrar. Segue a disciplina de `revisao-consistencia.md`.

---

## 0. Veredito em cinco linhas

| | |
|---|---|
| **O que os cinco documentos resolveram** | As três lacunas da §4 de `prontidao-para-inicio` deixaram de ser assuntos ausentes. O planejamento agora descreve a transição, o processo e a régua |
| **O que eles criaram** | 🔴 **14 exigências novas sobre a Onda 0** — e `plano-onda-0.md` não mudou uma linha. Dois deles (`entrada`, `metricas`) escreveram a própria lista de correções e ninguém as aplicou |
| **O achado mais caro** | ⚠️ **O critério de saída nº 2 da Onda 0, relido por `entrada` §5.4, exige a Onda 1 inteira** (inbox, busca, áudio, ficha, comentário). Ou a Onda 0 muda de critério, ou muda de escopo — §1.1 |
| **O segundo mais caro** | ⚠️ **Envio de template não existe na Onda 0** e, no minuto do corte, *todas* as janelas estão fechadas. A vendedora não tem como responder — §1.2 |
| **Falta para começar a Onda 0** | Quatro decisões, não código — §6 |

---

## 1. 🔴 O que estes documentos EXIGEM DA ONDA 0 e o plano não prevê

> Ordenado por custo de descobrir tarde. Cada item termina com **o que escrever**, não com "revisar".

### 1.1 ⚠️ O critério de saída nº 2 passou a exigir a Onda 1 inteira

`entrada` §5.4 torna a **certificação prática** pré-requisito de conectar o número de uma vendedora
(§3.4, item D-2): ela precisa *responder dentro da janela · reconhecer janela fechada e enviar
template · localizar um cliente pela busca · ouvir um áudio · abrir a ficha e ler o histórico de
compra · registrar um comentário*.

Cinco dessas seis ações são **Onda 1** pela lista fechada de `plano-onda-0.md` §7 (INB-01…11
inclusive busca, CTT-05…08/CTT-10 inclusive comentário). O critério de saída nº 2 da Onda 0 é
"3 números **recebendo e enviando**" — e `entrada` §3.1 fecha esse critério com **números de cliente
real** no lote 2 (T+1).

⚠️ **Conectar número de cliente real sem inbox é pedir que a vendedora atenda por API.** Não é
exagero de leitura: `entrada` §7 já calcula que isso empurra o corte para S10 e oferece as saídas
(a) e (b) — e avisa que *não escolher é escolher (b) por omissão*.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §**Critério de saída**, linha 2 | Substituir por: *"Pelo menos 3 números **da Gera3** conectados, recebendo e enviando, exercitados por API e por log. ⚠️ **Nenhum número de cliente real é conectado na Onda 0** — o corte do piloto é o primeiro bloco da Onda 1, e depende do inbox (EP-05) e da certificação de `entrada-do-primeiro-cliente` §5.4."* |
| `plano-onda-0.md` §**Duração** | *"8 semanas até o código pronto. **A Onda 0 não termina com o cliente dentro** — ver `entrada-do-primeiro-cliente` §7."* |
| `plano-ondas-1-4.md` §3 | Acrescentar, antes de 3.1: *"A Onda 1 começa com a transição do primeiro cliente (`entrada-do-primeiro-cliente` §7, cronograma T-6…T+6) e **ela é escopo da onda**, não overhead."* — o documento já diz isso em prosa; falta virar linha de plano com semanas |
| `entrada-do-primeiro-cliente.md` §7 | Registrar a escolha: **(b)**, com a consequência escrita |

### 1.2 ⚠️ Envio de template não existe na Onda 0 — e sem ele o corte é inoperante

`entrada` §3.3 é explícito: *"no minuto do corte, **todas** as conversas estão fechadas"*, e
*"só template aprovado"*. §3.4 exige, em D-2, **templates de reabertura aprovados**; §2.6 manda
recriar e submeter em T-2; §5.3 pede biblioteca pré-aprovada antes do corte.

`plano-onda-0.md` §7 manda *"templates HSM"* para a **Onda 3**. Consequências concretas:

- Nenhuma migration de `0001`…`0016` cria `template` / `template_versao` (existem no modelo,
  linha 1334 de `modelo-de-dados.md`).
- E3-09 (gateway único de saída) revalida janela, pagamento, opt-out e bloqueio — **não envia
  template**.
- `contrato-api.md` já prevê o caminho: `POST /conversas/{id}/mensagens` aceita template e devolve
  `canal.template_nao_aprovado`. A API está escrita; o plano não a constrói.

⚠️ **É o item que decide se (b) é sequer possível.** Mesmo com números da Gera3, testar reabertura
fora da janela exige um template aprovado.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §4 | Nova linha **D-11b / `0011b_template.sql`** — `template`, `template_versao` (`status_meta`, `id_externo`, `revisado_em`) + RLS. ⚠️ *"Entra na Onda 0 porque o corte do primeiro número acontece com todas as janelas fechadas."* |
| `plano-onda-0.md` §5.3 | Nova tarefa **E3-15 — submissão, sincronização de status e envio de template unitário**. Dep. E3-09, D-11b. DoD: `dado template aprovado, quando envia fora da janela, então a Meta aceita e o custo grava linha de categoria utility`; `dado template não aprovado, então erro canal.template_nao_aprovado — nunca "erro ao enviar"` |
| `plano-onda-0.md` §7 | Corrigir a linha de CMP-*: *"Campanhas, disparo em massa e atribuição → Onda 3. ⚠️ **Menos** `lista_bloqueio`, `consentimento_contato` **e o envio unitário de template (E3-15)**, que é invariante de reabertura de janela"* |

### 1.3 ⚠️ Colisão do número `0017` — entre dois documentos escritos no mesmo dia

`entrada` §9.2 reserva **`0017`** para `conciliacao_execucao` + `conciliacao_divergencia`.
`metricas` §6.2 reserva **`0017_metricas_produto.sql`**.

⚠️ É exatamente o recurso que `processo-de-trabalho` §3.2 chama de *"o mais serializado do
repositório"* — e a colisão nasceu no planejamento, antes de existir um PR para reservar número.

| Onde muda | O que escrever |
|---|---|
| `metricas-de-sucesso.md` §6.2 e §10 | Mantém **`0017_metricas_produto.sql`** |
| `entrada-do-primeiro-cliente.md` §9.2 | Renumerar para **D-18 / `0018_conciliacao.sql`** |
| `plano-onda-0.md` §4 | Acrescentar as duas linhas à tabela de migrations (D-17 métricas, D-18 conciliação), com o mesmo formato das demais |
| `processo-de-trabalho.md` §3.2 | Acrescentar item 4: *"⚠️ Migration prevista em documento de planejamento também reserva número — e a reserva vive na tabela §4 do plano da onda, não na cabeça de quem escreveu"* |

### 1.4 Colunas que as novas tarefas exigem e nenhuma migration cria

Todas são baratas **agora** (tabela vazia) e caras depois (reprocessar a carga). É o mesmo
raciocínio que fez `atendimento` nascer completo na `0012`.

| Coluna / tabela | Quem exige | Onde deveria nascer | ⚠️ |
|---|---|---|---|
| `contato.origem_carga` (`'sem_chave_forte'`…) | `entrada` §2.4 e E2-21 | **D-08** (`0008_contato_nucleo.sql`) | Não existe em `modelo-de-dados.md`. Derivar depois é impossível: a informação é *como o contato entrou*, e ela some no instante do `INSERT` |
| `atendimento.primeira_entrante_em`, `primeira_resposta_em`, `primeira_resposta_humana_em`, `primeira_resposta_por_id` | `metricas` §6.2 item 1 | **D-12**, não `0017` | D-12 promete que `atendimento` *"nasce completo"*. Com quatro colunas fora, ele nasce incompleto — e derivá-las depois é varrer `mensagem` **particionada** conversa a conversa |
| `lista_bloqueio` — origem `migracao` | E2-19 | **D-09** | A tabela tem `motivo`, não `origem` (`modelo-de-dados.md` l.1433). Decidir e escrever: `motivo = 'migracao_opt_out'`, ou coluna nova |
| `onboarding_passo` — marca de intervenção da Gera3 | `metricas` MO-06 | **D-03b** | MO-06 (*"passos que exigiram intervenção manual"*) **não é calculável**: `concluido_por` não distingue staff da Gera3 de usuário do tenant. Acrescentar `concluido_por_staff bool` |
| `linha_base_metrica`, `tenant_marco`, `assinatura_tenant`, `uso_diario_usuario` | `metricas` §6.2 itens 2–5 | **D-17** | Nenhuma existe no modelo. `modelo-de-dados.md` §8 precisa das quatro, com RLS `FORCE`, `USING`+`WITH CHECK` e dinheiro em `_centavos bigint` |

⚠️ **`modelo-de-dados.md` não foi atualizado por nenhum dos cinco documentos.** Ele continua com 64
entidades; passaram a ser 70. Um varredor de schema (§5.6 do plano) vai reclamar de tabela que o
modelo não conhece — ou pior, não vai reclamar de nada porque ninguém escreveu a policy.

### 1.5 Trabalho novo sem ID de requisito — contra a regra nº 1 do próprio processo

`processo-de-trabalho` §0 regra 1 e §2.1: *"Trabalho sem ID de requisito não entra. Nem tarefa, nem
branch, nem commit"*, e requisito novo *"entra primeiro em `escopo-funcional`, com ID"*.

`escopo-funcional-geracrm.md` tem `INT-01…INT-05` na Onda 0. **Nada ali cobre**: relatório de
conciliação, perfilamento de base, recarga por janela de data, importação de opt-out histórico,
de-para de vendedoras, linha de base, marcos do tenant, assinatura, telemetria de uso.

⚠️ Sem ID, o plano da Onda 0 ganha nove tarefas que **ninguém consegue cortar**, porque não dá para
saber o que se perde ao cortá-las. E o primeiro PR nasce fora do processo escrito na véspera.

| Onde muda | O que escrever |
|---|---|
| `escopo-funcional-geracrm.md` §Integrações e §Plataforma | Criar, com onda 0: **INT-14** relatório de conciliação · **INT-15** perfilamento de base · **INT-16** recarga por janela de data · **CTT-16** importação de opt-out histórico · **PLT-12** linha de base e marcos do tenant · **PLT-13** telemetria de uso agregada · **PLT-14** assinatura do tenant (denominador de BI-11) |
| `entrada-do-primeiro-cliente.md` §9.1 | Anotar o ID em cada uma das seis tarefas (`E2-16 · INT-14`, `E2-17 · INT-15`…) |
| `metricas-de-sucesso.md` §6.2 | Idem, nas sete lacunas |
| `backlog-epicos-geracrm.md` §3 | Somar os IDs novos a EP-02 e EP-01 |

### 1.6 A biblioteca de componentes não tem tarefa, dono nem semana em lugar nenhum

`plano-ondas-1-4.md` §2 cadeia 5 e §3.1 ordem 0 a declaram **pré-onda que bloqueia tudo**.
`prontidao` §5 diz "antes da Onda 1". `plano-onda-0.md` §7 a manda para *"Paralelo"* — e paralelo
não tem semana, não tem dono e não entra em checklist.

⚠️ Pior: **parte dela é Onda 0, não pré-Onda 1.** O plano (§7) declara cinco telas de console na
Onda 0 — login, recuperação, convite, onboarding (Meta + ERP) e lista de contatos em leitura. Essas
cinco consomem o **bloco 1** inteiro de `biblioteca-componentes` §7 (botão, campo, badge, esqueleto,
vazio, erro, toast, painel, cabeçalho) **e boa parte do bloco 3** (tabela com cursor, modal, select,
checkbox) — que a própria biblioteca rotula "Onda 1".

| Onde muda | O que escrever |
|---|---|
| `biblioteca-componentes.md` §7 | Reetiquetar: **Bloco 1 — Onda 0** (as cinco telas de console do plano §7) · **Bloco 3 — Onda 0/1**, com a nota: *"`especificacao-telas-entrada` §4–6 (equipe, frota, onboarding) é Onda 0 — E1-07 e E3-01"* |
| `plano-onda-0.md` §3.1 | Nova tarefa **R-12 — bloco 1 da biblioteca de componentes + pipeline de tokens** (`tokens.json` → custom properties + preset NativeWind + `tokens.d.ts` + lint que proíbe cor literal). Pronto quando: as cinco telas da §7 são construídas **sem** um `#hex` no código |
| `plano-onda-0.md` §5.5 | R-12 em **S1–S2**; bloco 3 em S3–S4 |
| `plano-onda-0.md` §7 | Corrigir a linha do design system: *"**Design system completo**, alta fidelidade e modo escuro seguem paralelos. **O bloco 1 da biblioteca é Onda 0** — sem ele as cinco telas nascem com cor literal e a Onda 1 as refaz"* |

### 1.7 A allowlist de envio em homologação é código, e não está em DoD nenhuma

`processo-de-trabalho` §8.3: *"Em homologação, o gateway de envio só alcança uma allowlist de
números — e isso é **código**, não configuração: envio para número fora da allowlist é erro
tipificado, não aviso."* E §8.2 explica o custo: token de produção em ambiente de teste entrega
"Teste 123" a lojistas reais às 3h da manhã, **e mensagem entregue não se desfaz**.

E3-09 (gateway único de saída) lista quatro revalidações — janela, canal+pagamento, opt-out,
lista de bloqueio. A allowlist não está lá.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §5.3, tarefa **E3-09** | Acrescentar à DoD: *"⚠️ Em ambiente ≠ `prod`, o gateway revalida contra a **allowlist de números de teste** e recusa com erro tipificado `canal.destino_fora_da_allowlist`. É código, não variável — `dado ambiente hom e destino fora da allowlist, quando envia, então recusa antes de chamar a Meta`"* |
| `contrato-api.md` §4.3 | Registrar o código `canal.destino_fora_da_allowlist` no catálogo de erros |

### 1.8 O CI do plano é menor que o CI que o processo declara obrigatório

| `processo-de-trabalho` §6.1 exige | `plano-onda-0.md` R-08 prevê |
|---|---|
| Runner de migrations de banco vazio **e a partir do schema em produção** | Só "runner de migrations" |
| Isolamento de canal SSE (dois tenants, permissão revogada, payload sem conteúdo) — **todo PR** | Ausente |
| Suíte de conformidade dos conectores como gate | Ausente (existe como E2-02, não como gate) |
| `build` de todos os apps (Turborepo) | Ausente |
| Testcontainers com RLS de dois tenants | Coberto por "test" |

⚠️ *"O runner rodar só contra banco vazio é armadilha"* — o próprio processo o diz. Mas rodar "a
partir do schema em produção" exige um **artefato que não existe**: um dump versionado do schema,
produzido pelo runner e commitado a cada release.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §3.1, **R-07** | Acrescentar: *"o runner também **emite** `infra/migrations/schema-atual.sql` (dump só de estrutura), versionado a cada migration aplicada — é ele que o CI usa como base do segundo cenário"* |
| `plano-onda-0.md` §3.1, **R-08** | Reescrever a lista: `lint typecheck test build` + runner (vazio **e** a partir de `schema-atual.sql`) + os oito varredores + **isolamento de canal SSE** + **suíte de conformidade** + verificador de watch path. ⚠️ *"Alvo: bloco obrigatório em < 8 min (`processo-de-trabalho` §6.2)"* |

### 1.9 O script de anonimização não tem dono, e é pré-requisito da S1

Três documentos o exigem e nenhum o constrói: `plano-onda-0` M-11 (*cópia de base real
anonimizada*), `processo-de-trabalho` §8.3 (*"por script versionado — nunca à mão"*),
`entrada` §1.G G-04 (*autorização formal com anonimização definida*).

E2-17 (perfilamento) roda **na S1** sobre essa cópia. Sem o script, ou a S1 não roda, ou alguém
anonimiza à mão — que é exatamente o que o processo proíbe.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §3.1 | Nova tarefa **R-11 — script de anonimização versionado** (telefone, CNPJ/CPF, nome, endereço, corpo de mensagem), determinístico por tenant para preservar cardinalidade e duplicidade. Dep.: nada. **S0**. ⚠️ *"Anonimização não-determinística destrói B-03 e B-04 do perfilamento — o mesmo CNPJ em N cadastros precisa continuar sendo o mesmo N"* |
| `plano-onda-0.md` §1.5 | Em **M-11**, acrescentar: *"a anonimização é nossa (R-11), executada na infraestrutura do cliente ou sob o contrato de G-04 — nunca 'eles mandam anonimizado'"* |

### 1.10 As métricas técnicas não têm onde morar — a infra provisiona Sentry, não série temporal

`metricas` §5 define **MT-01…MT-10** com limiar e ação automática (pausar disparo, escalar worker,
avisar o cliente). **MO-05** (latência p95 do ERP) declara fonte *"métrica de aplicação"*.
`plano-onda-0` §2.1 provisiona Cognito, Railway, Postgres+réplica, bucket, **Sentry**, cofre,
domínios, chave de cifra e alertas. Sentry é rastreamento de erro; ele não guarda p95 por 15
minutos nem dispara MT-03.

⚠️ Sem isso, MT-01 (*"taxa de entrega < 95% em 1 h ⇒ pausar disparo naquele número"*) vira
disciplina humana — e `metricas` §4 é categórico: *"contra-métrica que depende de alguém olhar o
gráfico não protege nada"*.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §2.1 | Nova tarefa **I-11 — destino de métrica de aplicação**, um por ambiente. Decidir entre (a) tabelas de agregação no próprio Postgres com job de janela, (b) serviço gerenciado. ⚠️ *"MT-01…MT-05 têm consequência automática no produto; sem série temporal, a consequência é uma pessoa lembrando"*. Pronto quando MO-05 responde p95 dos últimos 15 min por tenant |
| `plano-onda-0.md` §2.1, **I-10** | Acrescentar aos alertas mínimos: latência p95 do ERP > 2 s por 15 min · taxa de entrega por número < 95% em 1 h · outbox não processado > 2 min |
| `metricas-de-sucesso.md` §5 | Nota de rodapé: *"o destino destas métricas é I-11 do plano da Onda 0"* |

### 1.11 A janela de sombra é o único dado irrecuperável e não tem semana em cronograma nenhum

`metricas` §1.2 marca **LB-10…LB-15** com 🔴 *"não reconstituível"* e §1.1 avisa que *"a janela fecha
no dia da virada e não reabre"*. §1.3 exige 2 semanas de medição manual e **antes de anunciar a
ferramenta à equipe**.

O único calendário que existe — `entrada` §7, T-6…T+6 — **não tem linha de sombra**. E T-6 já é
uma conversa com o gestor sobre carteira, vendedoras e turnover (§1.C): a equipe já sabe.

| Onde muda | O que escrever |
|---|---|
| `entrada-do-primeiro-cliente.md` §7 | Nova linha **T-8 · Janela de sombra**: *"2 semanas medindo o sistema antigo (LB-10, LB-11, LB-12), **antes** da ficha de entrada. Nós: instrumento e planilha. Cliente: uma pessoa, ~1 h/dia. ⚠️ Depois de T-6 a equipe já sabe da mudança e o tempo de resposta melhora sozinho"* |
| `entrada-do-primeiro-cliente.md` §6.1 | Substituir a linha *"amostra manual de 3 dias"* pelo instrumento de `metricas` §1.3: **2 semanas de contagem diária + 30 conversas por vendedora** |
| `plano-onda-0.md` §5.5 | Ficha de entrada em S0 já está prevista por `entrada` §9.3; acrescentar **sombra iniciando 2 semanas antes da ficha** |
| `metricas-de-sucesso.md` §1.3 | Nomear o artefato: a sombra produz `linha-de-base.md` e alimenta `linha_base_metrica` — não uma planilha solta |

### 1.12 M-13 (portabilidade entre WABAs) pode ser o caminho crítico real, e não está na §1

`entrada` §1.F F-02 e TR-01: se os números do cliente já estão em API Oficial **dentro da WABA da
ferramenta atual**, não é Embedded Signup — é **portabilidade entre WABAs**, dependente de ação do
detentor, *"que é o concorrente que está perdendo o cliente"*. O próprio documento diz:
*"pode ser mais lento que o Business Verification e não está em nenhum documento do projeto"*.

| Onde muda | O que escrever |
|---|---|
| `plano-onda-0.md` §1.1 | Nova linha **M-13 — situação atual dos números na Meta** (F-02). Quem executa: **cliente** (dono do BM). Pré-requisito: ficha de entrada. Espera típica: **até 3 semanas, com terceiro não cooperativo**. ⚠️ *"Levantar em T-6 (= S0). Descobrir na semana do corte que o número está preso na WABA do concorrente é o único atraso desta onda pior que o da Meta"* |
| `plano-onda-0.md` §6 | Novo risco **nº 10**, com o texto de TR-01, probabilidade Alta × Alto |

### 1.13 As correções que os dois documentos escreveram para si mesmos e ninguém aplicou

`entrada` §9.3 e `metricas` §10 já listam o que muda no plano. **Nenhuma linha foi aplicada.**
Registro aqui para que o achado não se perca por já ter dono:

| `plano-onda-0.md`, onde | O que escrever |
|---|---|
| **Critério de saída nº 1** | *"Carregada, reconciliada **e conciliada com RC assinado pelo gestor comercial**. ⚠️ INV-57 e `cobertura='completa'` são **consistência interna** — fecham perfeitamente numa carga que trouxe 60% das vendas"* |
| **Checklist §8** | Trocar *"um CNPJ conferido linha a linha"* por **RC-09 (10 CNPJs estratificados)**; acrescentar ☐ RC assinado · ☐ opt-out histórico importado (RC-10) · ☐ **linha de base congelada e conferida (MN-01)** · ☐ `tenant_marco` com `carga_historica_completa` e `linha_base_congelada` · ☐ consultas `.sql` versionadas das métricas das Ondas 0 e 1 |
| **§5.2 (EP-02)** | As seis tarefas **E2-16…E2-21** de `entrada` §9.1, com os IDs de requisito da §1.5 acima |
| **§5.5 (sequência)** | Ficha de entrada em S0 · perfilamento (E2-17) em S1 · E2-16/18/19/20/21 em S6 |
| **§6 (riscos)** | Incorporar TR-01, TR-05, TR-06, TR-07 e TR-11 — nenhum é risco de código |

### 1.14 Quatro decisões que os documentos declaram fechadas sem escrever ADR

`processo-de-trabalho` §10.2 é explícito: *decisão que vira ADR nunca se delega*, e resolver
contradição entre documentos é o item onde o agente *"escolhe uma leitura e segue"*. `decisoes.md`
continua com 12 ADRs.

| Decisão fechada | Onde foi fechada | Onde deveria estar |
|---|---|---|
| Precedência de atribuição de receita: **campanha > tarefa > conversa > vendedora** | `metricas` §3.1 | **ADR-013** + linha em **INV-43** de `modelo-de-dados.md`. ⚠️ É regra de modelo fechada num documento de métrica; INV-43 garante *uma* atribuição exata por venda e **não** diz qual |
| Corte seco por número + convivência ≤ 4 semanas | `entrada` §9.4 | **ADR-014**, com a consequência contratual da §6.4 (*antigo não se cancela antes de D+30 do último lote*) |
| Volume real medido, nunca estimado (pendente nº 5 da stack) | `entrada` §9.4 | `stack-arquitetura.md` §14, linha 5 → ✅ **Resolvida**, apontando para `entrada` §1.A/§1.B |
| Ponto de não retorno = frota conectada + carga concluída | `entrada` §9.4 | **ADR-014**, mesmo bloco |

---

## 2. Contradições com os ADRs e com o planejamento anterior

| # | Contradição | Onde muda | O que escrever |
|---|---|---|---|
| **C-01** | ⚠️ **A linha de base tem duas definições incompatíveis.** `entrada` §6.1: *"média das 8 semanas anteriores"*, *"tempo **médio** de primeira resposta"*, *"amostra manual de 3 dias"*. `metricas` §1.2/§1.5: **mediana e p90**, 2 semanas, 30 conversas/vendedora, e comparação **YoY sazonalizada** — declarando que comparar contra as semanas anteriores é a **armadilha nº 1** (sazonalidade de coleção domina o atacado de moda) | `entrada-do-primeiro-cliente.md` §6.1 e §6.2 | Substituir a tabela §6.1 por referência a `metricas` §1.2 (LB-01…LB-15) e reescrever o critério D+30: *"Faturamento da vendedora/filial ≥ 95% do **mesmo mês do ano anterior, sazonalizado** (LB-01) — ⚠️ **nunca** contra as 8 semanas anteriores: virada em janeiro contra dezembro 'prova' queda de 40%"* |
| **C-02** | **Quando a linha de base é congelada.** `metricas` MN-01 = critério de produto da **Onda 0**. `plano-ondas-1-4` §3.3 critério 5 = critério de saída da **Onda 1**. Se for Onda 1, LB-10…LB-12 já não existem — a janela fechou na virada | `plano-ondas-1-4.md` §3.3 | Trocar o critério 5 por: *"Linha de base **já congelada na Onda 0** (MN-01) e **conferida com o cliente**. Na Onda 1 ela é **usada**, não capturada — LB-10…LB-12 não são reconstituíveis (`metricas` §1.1)"* |
| **C-03** | **Templates HSM em três datas.** `plano-onda-0` §7 → Onda 3 · `entrada` §3.4/§7 → T-2 (fim da Onda 0) · `plano-ondas-1-4` §5.4 → *"submeter os 5 mais usados **na Onda 2**"* | Os três | Convenção única: **envio unitário de template = Onda 0 (E3-15, §1.2 acima)** · **submissão dos 5 mais usados = na abertura da onda em que o cliente é cortado** · **disparo em massa = Onda 3**. Escrever a frase nos três documentos, idêntica |
| **C-04** | ⚠️ **`entrada` §6.2 usa RFV como critério de sucesso do cliente em D+30** (*"base classificada ≥ 80%"*, fonte `mv_rfv_segmento_atual`). RFV é **Onda 2** por `plano-onda-0` §7 (*"`rfv_evento` nem tabela precisa ter agora"*), e `mv_rfv_segmento_atual` não existe em migration nenhuma | `entrada-do-primeiro-cliente.md` §6.2 | Trocar por: *"**Cobertura** declarada e conferida: `conexao_erp_cobertura` cobrindo ≥ 24 meses, e a fração da base fora da cobertura **nomeada** (INV-56). ⚠️ A classificação RFV é **Onda 2** — prometê-la em D+30 do primeiro lote é prometer a onda seguinte"* |
| **C-05** | **`entrada` §7 demonstra que a Onda 0 dura 10–11 semanas e `plano-onda-0` continua dizendo 8** | `plano-onda-0.md` §Duração | Ver §1.1. A contradição é interna e agora está documentada — deixá-la é escolher (b) por omissão |
| **C-06** | **Caminho do analítico.** `metricas` §6.5 manda os `.sql` para `apps/api/src/analitico/`; `plano-onda-0` §3 declara `src/contexts/{…,analitico}` | `metricas-de-sucesso.md` §6.5 | `apps/api/src/contexts/analitico/consultas/` — e o nome do arquivo carrega o ID da métrica (`MN-04-recompra-90d.sql`) |
| **C-07** | **`processo-de-trabalho` §3.2 exige "no máximo um agente por vez criando migration" e reserva de número na abertura do PR — sem mecanismo.** Os oito varredores de §5.6 do plano não incluem "número de migration duplicado", e a §1.3 acima prova que a colisão acontece | `plano-onda-0.md` §5.6 | Nono varredor — **Numeração**: *"falha quando existem dois arquivos com o mesmo prefixo em `infra/migrations`, ou quando um número reservado na tabela §4 do plano não corresponde ao arquivo"* |
| **C-08** | **`decisoes.md` lista ADR-012 antes de ADR-011.** Cosmético, mas o documento é a fonte de decisões fechadas e a ordem é o índice | `decisoes.md` | Reordenar |

---

## 3. Linguagem ubíqua quebrada

⚠️ Cada linha abaixo é uma palavra que significa duas coisas em dois documentos escritos na mesma
semana. É o defeito mais barato de corrigir hoje e o mais caro depois, porque ele entra no código.

| # | Termo | Significado A | Significado B | Onde muda / o que escrever |
|---|---|---|---|---|
| **U-01** | ⚠️ **"sombra"** | `metricas` §1.3: **janela de sombra** = 2 semanas medindo **o sistema antigo**, à mão, antes do anúncio | `plano-ondas-1-4` §3.2 M1.6: **piloto sombra** = 2 vendedoras usando **o GeraCRM** em paralelo por 1 semana | São operações **opostas** (medir o velho × usar o novo). `plano-ondas-1-4.md` §3.2: renomear M1.6 para **"piloto paralelo"**. `metricas` mantém "janela de sombra" |
| **U-02** | ⚠️ **"E1" / "E2"** | `entrada` §2.5: **ensaios de carga** (E1 em T-4, E2 em T-1) | `plano-onda-0` §5: **prefixo de tarefa por épico** (E1-01 = EP-01, E2-16 = EP-02) | Colisão **dentro do mesmo documento**: `entrada` usa os dois sentidos (§2.5 e §9.1). Renomear os ensaios para **ENS-1** e **ENS-2** em `entrada` §2.5, §3.4 e §7 |
| **U-03** | ⚠️ **"virada"** | `metricas` §6.2: marco `virada_onda1` = *"primeiro dia de operação real"*, e é o instante em que a linha de base congela | `entrada`: `T` / `D-0` = corte do **primeiro** número. `plano-ondas-1-4` M1.7: *"operação inteira sem a ferramenta antiga"* = corte do **último** | Três eventos, uma palavra — e a régua de "antes e depois" pendura nela. `metricas` §6.2 item 3: renomear os marcos para **`primeiro_corte`**, **`ultimo_corte`** e **`abandono_sistema_antigo`**, e amarrar `linha_base_congelada` a **antes de `primeiro_corte`** |
| **U-04** | **"conciliação" × "reconciliação"** | `entrada` §2: conciliação = comparar CRM **contra o ERP** (RC-01…RC-10) | INV-57 e o critério de saída nº 1 do plano: reconciliação = **contadores internos batendo** | `entrada` §2.2 já diz *"RC-07 é teste, não conciliação"*. Falta o plano assumir: em `plano-onda-0.md`, todo *"reconciliada"* do critério nº 1 vira *"reconciliada (INV-57) **e conciliada (RC)**"* — as duas palavras, sempre juntas |
| **U-05** | **Qualidade cadastral medida três vezes com três nomes** | `entrada` B-01…B-10 (perfilamento, sobre a **cópia anonimizada em hom**) | `metricas` LB-08 (sobre a **carga**) e MO-03 (métrica de operação da Onda 0) | Sem relação declarada, o cliente recebe **dois percentuais diferentes** para "% sem documento". `metricas` §1.2 LB-08: acrescentar *"LB-08 é B-01…B-04 recalculados **sobre a base carregada**; a divergência entre eles é ela própria um achado do RC-05"* |
| **U-06** | **`janelaExpiraEm`** | `biblioteca` §5.1.1 e §6.3: o anel lê `janelaExpiraEm` | `contrato-api` `GET /conversas/{id}`: `janela: { aberta, expiraEm, duracaoH, reabrePor }` | `biblioteca-componentes.md` §5.1.1 e §6.3: trocar por **`janela.expiraEm`**, e citar o objeto inteiro — `aberta` é o que o composer usa, `reabrePor` é o que o modo-template mostra |

---

## 4. Promessa sem sustentação — a tela ou a métrica pede o que a API/modelo não entrega

| # | Promessa | Quem sustentaria | ⚠️ | Onde muda / o que escrever |
|---|---|---|---|---|
| **P-01** | `biblioteca` §4.5: *"o componente aceita `retentavel: boolean` **vindo do servidor** — a tela não decide isso"* | `contrato-api` §4.1: o envelope de erro tem `codigo`, `mensagem`, `detalhe`, `campos`, `requestId`. **Não tem `retentavel`** | A retentabilidade hoje é inferida do status (502 sim, 504 não) — exatamente a decisão na tela que a ficha proíbe | `contrato-api.md` §4.1: acrescentar **`retentavel: boolean`** ao envelope, obrigatório em `4xx/5xx`, com a nota *"o cliente **nunca** deriva de status; `502` retentável e `504` não são a regra do servidor, não da tela"* |
| **P-02** | ⚠️ `biblioteca` §1.8 e §4.5 (e `especificacao-telas` §2.1): *"nunca o nome literal do ERP — o nome da **conexão ativa do tenant**, vindo de `detalhe.origem`"* | `contrato-api` §4.3 mostra `detalhe: { origem: 'geracloud', tentativaId }` | **`detalhe.origem` É o nome literal do ERP.** O componente que existe para nunca escrever "GeraCloud" recebe `'geracloud'` | `contrato-api.md` §4.3: trocar por `origem: { conexaoId, nome, conector }` — `nome` é o rótulo do tenant (*"ERP da matriz"*), `conector` é o slug e **não vai para a tela** |
| **P-03** | `metricas` MO-06: *"passos do onboarding que exigiram intervenção manual da Gera3 ÷ total"*, fonte `onboarding_passo` | `modelo-de-dados` l.1162: `onboarding_passo(tenant_id, passo, estado, dados jsonb, concluido_em, concluido_por)` | `concluido_por` é um `usuario_id`; staff da Gera3 é **group do Cognito**, não linha de `usuario` do tenant (plano §2.2). **A métrica não é calculável** | Ver §1.4 — `concluido_por_staff bool` em **D-03b** |
| **P-04** | `metricas` MO-05 e MT-01…MT-10, com limiar e ação automática | Nenhuma infraestrutura de série temporal em `plano-onda-0` §2.1 | Ver §1.10 | I-11 |
| **P-05** | `entrada` §6.2 D+30: base classificada pelo RFV ≥ 80%, fonte `mv_rfv_segmento_atual` | RFV é Onda 2; a MV não existe | Ver C-04 | — |
| **P-06** | `biblioteca` §3.1, §3.4, §5.5: retração do painel, colapso do menu e velocidade do player *"persistidos por usuário **no servidor**"* | `contrato-api` `GET/PUT /eu/preferencias` declara: aparência, notificações, assinatura da atendente, escopo ativo | Três estados de interface sem casa. Guardá-los no `localStorage` contraria a justificativa da própria ficha (*"ela usa dois computadores"*) | `contrato-api.md` §`/eu/preferencias`: acrescentar um saco `interface: { menuColapsado, paineisRetraidos[], velocidadeAudio }` — ⚠️ *"saco de interface, **nunca** de regra: nada que o servidor precise ler para decidir"* |
| **P-07** | `entrada` §6.2 D+1: *"**zero** mensagem entrante perdida — contagem de eventos do gateway = conversas visíveis"* | Nenhuma tarefa produz essa contagem. `plano-ondas-1-4` §3.3 critério 1 pede o equivalente contra o painel da Meta, na Onda 1 | O critério mais importante do dia D não tem comando que o responda | `plano-onda-0.md` §5.3: nova tarefa **E3-16 — auditoria de entrada**, comando que compara `evento_externo` × `mensagem` × `conversa` numa janela, e nomeia cada evento sem mensagem. DoD: *"dado um evento descartado por falha permanente (E3-05), quando roda, então ele aparece **classificado**, não some"* |

---

## 5. Componente × token

⚠️ `biblioteca-componentes` §0.1 declara que o mecanismo nº 1 contra divergência é *"`tokens.json`
como fonte única, garantido por build + `tokens.d.ts` + lint que proíbe literal de cor"*. Os itens
abaixo **quebram esse mecanismo antes de ele existir**: são valores que a ficha usa e o arquivo não
tem — logo, a primeira implementação os inventa, e a segunda copia da primeira.

| # | Achado | Onde muda / o que escrever |
|---|---|---|
| **T-01** | ⚠️ **Três tokens semânticos usados nas fichas e ausentes de `tokens.json`**: `acao-pressionada` (§1.2, §2.1), `superficie-selecionada` (§1.2, §3.4, §5.3), `borda-erro` (§1.2, §2.2, §4.5) | `tokens.json → semantico.claro/escuro`: `"acao-pressionada": "{azul.600}"` / escuro `"{azul.500}"` · `"superficie-selecionada": "{azul.100}"` / escuro `"{azul.800}"` · `"borda-erro": "{coral.500}"` / escuro `"{coral.300}"` |
| **T-02** | ⚠️ **O véu do modal é cor literal — no documento que proíbe cor literal.** `biblioteca` §4.2 escreve `rgba(13,24,48,0.5)`; §6.3 lista *"Cor literal (`#3F6FBE`, `rgb(…)`) → barrado por lint"*. O lint da §0.1 barraria a própria ficha | `tokens.json → elevacao` (ou bloco novo `veu`): `"veu": "rgba(13, 24, 48, 0.50)"` para o claro e `"rgba(6, 12, 26, 0.65)"` para o escuro. `biblioteca` §4.2: citar o token |
| **T-03** | ⚠️ **A rampa RFV não tem degraus, e a ficha exige degrau.** `biblioteca` §5.2: *"no escuro… o texto do badge muda para o degrau `300`"*. Em `tokens.json → rfv`, **5 das 11 faixas são hex literal sem escala** (`cliente-fiel #2AA79E`, `potencial-fiel #3F92BE`, `precisa-atencao #DE8E2A`, `semi-perdido #D9703C`, `hibernando #D4544A`). E o badge de estado (§2.6) pede *"cor de estado a 12% + texto na cor 700/300"* — não há token de fundo a 12% | `tokens.json → rfv`: cada faixa vira objeto `{ "500": …, "300": …, "700": …, "fundo": … }`, **as onze**, verificadas nos dois temas (identidade §8: contraste por **par** de tokens). Sem isso, a rampa de 11 passos não é reverificável no escuro — que é o que `direcao-visual` §5.3 exige |
| **T-04** | ⚠️ **`tokens.json` tem uma referência quebrada**: `semantico.claro.fundo = "{azul.branco}"`. `branco` é irmão de `azul` dentro de `primitivos`, não filho — o correto é `{branco}`, como já faz `superficie-elevada` | `packages/design-tokens/tokens.json` l.41: `"fundo": "{branco}"`. ⚠️ O fundo do tema claro é o token mais usado do produto; o build de R-12 (§1.6) falharia — ou pior, resolveria para vazio |
| **T-05** | **Doze medidas fixadas na ficha e ausentes de `densidade`**: controle `sm` 24 / `md` 28-44 / `lg` 36-52, item de lista no app 64px, célula da grade 44×36 e 44×44, checkbox 16/22, trilho do toggle 32×18 e 44×26, avatar 24/32/40/56, tooltip máx. 280px, badge 20px, chip 24px. ⚠️ E uma **divergência**: §1.6 manda *"28px visual, **32px de área de clique**"*, enquanto `tokens.json → densidade.alvo-clique-console` diz **28px** — o token descreve o visual e tem nome de alvo | `tokens.json → densidade`: acrescentar as medidas como `controle-sm/md/lg` (console e app), `celula-grade`, `avatar-*`; e **renomear** `alvo-clique-console` → `controle-md-console: 28px` + `hit-area-console: 32px`, para o nome parar de mentir |
| **T-06** | **O inventário da identidade não conhece dois componentes que a Onda 1 exige.** `identidade-visual` §10 lista, em Feedback: toast, modal, esqueleto, vazio, erro, progresso. `biblioteca` especifica também **`gc-banner`** (§4.7, *"é o que o toast não pode ser"*) e **`gc-composer`** (§5.10, *"o componente mais difícil do produto"*, pré-requisito da Onda 1) | `identidade-visual.md` §10: acrescentar **banner** em Feedback e **composer de dois modos** em Domínio. Inventário que não lista o componente mais difícil do produto não serve de inventário |

---

## 6. Veredito — o que ainda falta para começar a Onda 0

**Nada de planejamento estrutural.** Os cinco documentos fecharam as três lacunas que
`prontidao-para-inicio` §4 declarava abertas, e a qualidade deles é o motivo de esta revisão ter
achados tão específicos: eles são precisos o bastante para colidir.

Falta **aplicar o que eles pedem** e **decidir quatro coisas**. Nada disso é código.

| # | O que falta | Quem decide | ⚠️ Se não decidir |
|---|---|---|---|
| **1** | 🔴 **(a) Onda 0 de 10–11 semanas com o cliente dentro, ou (b) critério nº 2 com números da Gera3 e o cliente entrando na Onda 1** | Dono do produto | (b) por omissão, **sem o plano da Onda 1 existir** — e a certificação da §5.4 vira surpresa na semana do corte (§1.1) |
| **2** | **Aplicar as 14 mudanças da §1 em `plano-onda-0.md`, `modelo-de-dados.md` e `escopo-funcional-geracrm.md`** | Quem orquestra | O primeiro PR nasce fora do processo escrito na véspera: sem ID de requisito (§1.5), com `0017` duplicado (§1.3) e com `contato` já carregado sem `origem_carga` (§1.4) |
| **3** | **Escrever ADR-013 (precedência de atribuição) e ADR-014 (corte seco, convivência, ponto de não retorno)** | Dono do produto | Quatro decisões fechadas fora de `decisoes.md` — o lugar onde o time e os agentes vão procurá-las (§1.14) |
| **4** | **Iniciar a janela de sombra** (LB-10…LB-12) e **M-13** (situação dos números na Meta) | Cliente + nós | São os dois únicos itens **irrecuperáveis** do conjunto: a sombra fecha na virada e não reabre; a portabilidade entre WABAs depende de um terceiro hostil e pode ser mais lenta que a Meta (§1.11, §1.12) |

E os dois itens do `prontidao` §3 que continuam parados e continuam sendo o caminho crítico:
**o registro na Meta (M-01…M-04)** e **o acesso ao GeraCloud (M-09…M-12)**. Nenhum dos cinco
documentos os fez avançar um dia.

> ⚠️ **O padrão desta revisão é diferente do da anterior.** Lá o defeito dominante era *"uma tela
> promete o que o modelo torna impossível"*. Aqui é **documento novo que exige da Onda 0 sem editar
> a Onda 0** — dois deles até escreveram a própria lista de correções (§1.13) e a deixaram no fim do
> próprio arquivo, onde ninguém que planeja a semana vai ler.
