# GeraCRM — Processo de trabalho

> Preenche a lacuna **§4.2** de [`prontidao-para-inicio.md`](./prontidao-para-inicio.md) ("como o
> time trabalha"). Deriva de [`decisoes.md`](./decisoes.md),
> [`plano-onda-0.md`](./plano-onda-0.md) §2, [`contrato-api.md`](./contrato-api.md) §1,
> e das skills `workflow-agentes-programacao`, `geracrm-testes`, `geracrm-monorepo-deploy`,
> `codigo-limpo`.
>
> **O que este documento decide:** o que é "pronto", como uma tarefa entra e sai, o que bloqueia
> merge, o que exige olho humano, e o que nunca se delega. Não repete regra de código — essa mora
> nas skills e no `CLAUDE.md`.

---

## 0. As sete regras que não têm exceção

Se você só ler uma seção, leia esta.

| # | Regra | Onde está o detalhe |
|---|---|---|
| 1 | **Trabalho sem ID de requisito não entra.** Nem tarefa, nem branch, nem commit | §2 |
| 2 | **`main` é sempre implantável.** Checks verdes ou não mergeia | §6 |
| 3 | **Pronto é escrito antes de começar**, não julgado depois | §1 |
| 4 | **Migration é aditiva.** Ela roda com a versão anterior atendendo tráfego | §1.3 |
| 5 | **Credencial de hom e prod nunca se encontram.** Nenhuma variável é copiada entre ambientes | §8 |
| 6 | **Agente entrega; pessoa aceita.** Quem escreveu não declara pronto | §10.6 |
| 7 | **`main` quebrada é prioridade zero do time.** Ninguém começa tarefa nova | §7 |

---

## 1. Definição de pronto

⚠️ **Com agentes no fluxo, "pronto" sem critério escrito é caro.** O agente entrega o que *parece*
pronto — código plausível, teste verde, resumo confiante — e sem critério escrito ninguém tem base
para discordar. A discordância vira opinião contra opinião, e ganha quem tem mais paciência.

**A definição de pronto é escrita quando a tarefa entra, não quando ela sai.** Se você está
descobrindo o critério ao revisar, já perdeu.

### 1.1 Base comum — vale para todo tipo de trabalho

- □ **ID do requisito** no título da branch, no commit e no PR (§2)
- □ `pnpm lint typecheck test` verdes **localmente**, e o CI verde no PR
- □ Todo critério de aceite do requisito tem **onde está atendido** apontado no corpo do PR
- □ Teste que exercita a **regra**, não a implementação (`geracrm-testes`)
- □ Nenhuma proibição do `CLAUDE.md` violada (`enum` TS, float para dinheiro, lista sem cursor,
  canal sem tenant, `tenant_id` por parâmetro, regra de negócio em adaptador)
- □ O que **ficou de fora** está escrito — no corpo do PR, com ID ou com "não pedido"

⚠️ O último item é o que separa entrega honesta de entrega otimista. **Escopo reduzido é aceitável;
escopo reduzido em silêncio é o defeito nº 1 da §4.**

### 1.2 Por tipo de trabalho

| Tipo | Pronto quando, **além da base** | ⚠️ O que costuma faltar |
|---|---|---|
| **Funcionalidade** | Cenários BDD do requisito passando (`cenarios-bdd.md`) · caminho feliz + falha de validação + **falha de infraestrutura** (ERP fora, Meta fora, conflito de transação) · toda invariante tocada tem caso que **tenta violá-la e espera falha** · se é lista, cursor no endpoint **e** na tela · se é tela, **os cinco estados** (`especificacao-telas.md`) · se é repositório, caso de **dois tenants** | O estado vazio e o estado de erro da tela. A falha de infraestrutura. O caso de dois tenants |
| **Correção** | **Teste que reproduz o bug, escrito ANTES do fix** e visto vermelho · a issue do Sentry referenciada e fechada · se o bug era violação de regra, o cenário BDD que faltava foi escrito · o corpo do commit diz **por que a suíte deixou passar** | O "por que passou". Sem isso, a mesma classe de bug volta por outro caminho |
| **Migração** (`infra/migrations`) | **Aditiva** — nada de `DROP`/`RENAME` de coluna em uso · RLS habilitada e política escrita na tabela nova · `UNIQUE` sempre composta com `tenant_id` · índice derivado de consulta real, não de palpite · runner do CI verde **a partir do schema que está em produção**, não só de banco vazio · remoção de coluna documentada no PR como **plano de 2–3 deploys**, com o número deles | O teste a partir do schema atual. Migration que só roda em banco vazio passa no CI e quebra no `preDeployCommand` |
| **Contrato de API** | `contrato-api.md` atualizado **no mesmo commit** · mudança aditiva dentro da major, ou `/v2` convivendo com `/v1` (§1.2 do contrato) · tipo/Zod em `packages/shared` **e watch path conferido no mesmo commit** · erro novo entra no **catálogo de erros** com a mensagem que a tela mostra · console e app atualizados, ou provados tolerantes a literal desconhecido · ⚠️ `/ingest/v1` **não ganha literal novo em campo de saída** — cliente de terceiro não temos como obrigar | O watch path. O tipo muda na API, não muda na tela, deploy verde, ninguém entende |
| **Prompt de IA** | Nenhuma **regra de negócio** dentro do prompt (regra é código, validada e testada) · conjunto de casos reais rodado **antes e depois**, com o número no PR — não impressão · entrada no **changelog de prompt**, com data e autor · **reversível**: a versão do prompt fica gravada na auditoria da chamada, senão não dá para explicar uma resposta antiga · custo e latência medidos por tenant · fallback intacto (provedor fora → fila humana, nunca silêncio) | A versão gravada na auditoria. Sem ela, "a IA respondeu isso?" não tem resposta |

---

## 2. Fluxo de uma tarefa

### 2.1 De onde vem — a cadeia do ID

O ID do requisito é o único fio que atravessa o planejamento inteiro. Ele já existe; o processo só
o obriga a aparecer até o fim.

```
escopo-funcional (PED-08)  →  backlog-epicos (EP-12)  →  plano da onda (tarefa)
        ↓                              ↓
modelo-de-dados (INV-27)      contrato-api (rota + erro)      especificacao-telas (estado)
        ↓                              ↓                              ↓
                     cenarios-bdd (@INV-27, Funcionalidade: PED-08)
                                       ↓
             raia / briefing  →  branch  →  commit  →  PR  →  release
```

| Onde o ID aparece | Forma |
|---|---|
| Branch | `feat/PED-08-bloqueio-pedido-minimo` |
| Commit | trailer `Refs: PED-08, INV-27` |
| PR | título + tabela "critério → onde está atendido" |
| Teste | nome do `describe`/`it` narra a regra; tag `@INV-27` no cenário |
| Sentry | `tags: { requisito: 'PED-08' }` quando a falha é de regra |
| CHANGELOG | derivado dos commits (§9) |

⚠️ **Tarefa sem ID não entra.** Se não tem, uma de três coisas é verdade: (a) é bug — recebe
`BUG-xxx` e entra pela §1.2; (b) é requisito novo — entra primeiro em `escopo-funcional`, com ID;
(c) é dívida técnica — recebe `TEC-xxx`. **Trabalho sem ID é trabalho que ninguém consegue cortar
depois**, porque não dá para saber o que se perde ao cortá-lo.

### 2.2 Estados

| Estado | Entra quando | Quem |
|---|---|---|
| **Backlog** | O requisito existe com ID | — |
| **Pronta para pegar** | Tem ID, **cenário BDD escrito**, fronteira de arquivos e contrato das portas que consome | Quem orquestra |
| **Em execução** | Alguém (pessoa ou agente) assumiu, em ambiente isolado | Executor |
| **Em revisão** | PR aberto, CI verde, corpo preenchido | Revisor ≠ autor |
| **Integrada** | Merge em `main`, suíte completa verde | Quem orquestra |
| **Em homologação** | Deploy automático subiu (§8) | — |
| **Em produção** | Promoção manual, com tag | Quem promove |
| **Verificada** | Alguém confirmou o comportamento **em produção**, com dado real | Quem aceita |

⚠️ **"Integrada" não é "pronta".** Entre `main` e produção há dois saltos, e a §9 existe porque um
deles falha em silêncio com frequência.

### 2.3 "Pronta para pegar" e o briefing de agente são o mesmo artefato

O checklist de "pronta para pegar" é literalmente o bloco `RAIA` de `workflow-agentes-programacao`:
objetivo, contexto, fronteira, contrato, definição de pronto. **Se a tarefa não está pronta para
briefar um agente, ela também não está pronta para uma pessoa** — a diferença é só que a pessoa
reclama e o agente inventa.

---

## 3. Branch e PR

### 3.1 Política

- **Trunk-based.** Uma `main` protegida, sempre implantável. Sem `develop`, sem branch de release.
- **Branch curta:** ≤ 3 dias de vida. ⚠️ Branch longa contra uma base que recebe migrations
  numeradas produz o conflito mais chato do repositório (§3.2).
- Nome: `<tipo>/<ID>-<slug-curto>` — `feat/`, `fix/`, `db/`, `refactor/`, `docs/`, `chore/`.
  Migration usa o número: `db/0007-particao-mensagem`.
- **Rebase antes de abrir o PR**, merge commit na integração. O histórico de `main` conta a ordem
  real de integração.

### 3.2 ⚠️ O número da migration é o recurso mais serializado do repositório

Duas branches paralelas criam `0007` e nenhuma das duas percebe até o merge. Regra:

1. O número é **reservado no momento em que o PR abre**, não quando a branch nasce.
2. Quem mergeia primeiro fica com o número; **o segundo renumera antes de mergear**, e roda o
   runner de novo a partir do schema atual.
3. **No máximo um agente por vez** criando migration (§10.4).

### 3.3 Tamanho de PR

| Diff útil (exclui lockfile, gerado, fixture) | Tratamento |
|---|---|
| ≤ 200 linhas | Ideal. Revisão em minutos |
| 200–400 | Normal |
| 400–800 | Justificar no corpo por que não dividiu |
| > 800 | **Dividir**, salvo migração mecânica (varredura, renomeação em N arquivos) declarada no título |

⚠️ **PR grande não recebe revisão melhor, recebe revisão pior.** Acima de ~400 linhas a taxa de
achado despenca e o revisor passa a aprovar por confiança — que é exatamente o que a revisão de
código de agente não pode fazer.

### 3.4 Corpo do PR — o mínimo

```
Requisito: PED-08 (escopo-funcional) · INV-27 (modelo) · cenarios-bdd §8
Onda: 1

Critério → onde está atendido
| Bloqueia abaixo do mínimo e informa quanto falta | pedido/politica-minimo.ts:41 · teste §8.2 |
| Preserva o rascunho quando o ERP recusa          | efetivar-pedido.ts:88 · teste §8.5 |

Ficou de fora: exportação do rascunho (PED-08c) — depende de CAT-04, não pedido aqui.
Risco: nenhum. / Migration: não. / Contrato: aditivo (campo opcional `faltamPecas`).
```

### 3.5 O que exige revisão humana

| Sempre humana — sem exceção | Por quê |
|---|---|
| Migration, política de RLS, índice em tabela grande | Erro aqui não tem `git revert` (§7) |
| Autorização, papel, permissão por número ou carteira | Falha silenciosa: funciona, e funciona para quem não devia |
| Nome de canal SSE, fan-out, payload de evento | Erro de alvo vira incidente de vazamento, não bug |
| Contrato público (`/ingest/v1`), porta de conector | Cliente de terceiro não temos como obrigar a acompanhar |
| Prompt de IA, base de conhecimento | Mudança de comportamento sem diff de comportamento |
| Dinheiro, atribuição de receita, contador de disparo | É a promessa central do produto (ROI provado) |
| Opt-out, consentimento, LGPD | Um caminho esquecido derruba a garantia inteira |
| Segredo, variável de ambiente, watch path, config de deploy | §8 e a armadilha herdada do drezz |
| Qualquer coisa que **envie mensagem para número real** | Não existe desfazer |

| Pode entrar com revisão automática (checks + revisor agente) | Condição |
|---|---|
| Texto de interface, tradução, ajuste dentro de token existente | Não muda comportamento |
| Teste adicional que não altera teste existente | — |
| Documentação | Exceto ADR |
| Bump de dependência **patch** | Suíte completa verde |
| Refatoração sem mudança de comportamento | Coberta por teste que **já existia** |

⚠️ **"Automático" significa "não fica esperando pessoa", não "ninguém olha".** O autor continua
respondendo pelo que subiu, e a §7 vale igual.

---

## 4. Revisão

### 4.1 A ordem importa mais que a lista

**Passo 0 — leia o requisito antes do diff.** Se você abre o diff primeiro, você revisa *o que foi
feito*, não *o que foi pedido*. ⚠️ É exatamente assim que o defeito nº 1 passa.

| # | O que procurar | Como |
|---|---|---|
| **1** | **Requisito silenciosamente reduzido** | Abra `escopo-funcional` + `cenarios-bdd`. Critério por critério: onde está a linha e onde está o teste? Pediu 5 erros tratados, implementou 2, não avisou — o mais comum e o mais invisível |
| **2** | **Caminho de erro** | O caminho feliz costuma estar certo; o de falha, inventado. Falha de negócio é retorno tipificado, não exceção. ERP fora, Meta fora, conflito de transação |
| **3** | **Invenção de contrato** | Método que não existe, assinatura de porta alterada, campo de resposta que o `contrato-api` não descreve |
| **4** | **Teste que não testa** | Passa sem exercitar a regra. ⚠️ Se um teste **existente** foi alterado: reverta a alteração e rode. Se passa sem ela, a alteração era para caber no código |
| **5** | **Camada** | Validação no controller, SQL no caso de uso, regra de negócio em adaptador de ERP |
| **6** | **Escopo excedido** | Refatoração misturada com comportamento no mesmo commit |

### 4.2 Varredura GeraCRM — rápida, mecânica, sempre

`tenant_id` vindo de parâmetro · lista sem cursor (endpoint **ou** tela) · `enum` do TypeScript ·
dinheiro em float · canal montado sem tenant · payload de evento com conteúdo · migration
destrutiva · `UNIQUE` sem `tenant_id` · segredo, telefone, CNPJ ou corpo de mensagem em log ·
import novo de `packages/shared` sem watch path · capacidade de conector assumida sem declarar.

### 4.3 Código humano × código de agente

| | Humano | Agente |
|---|---|---|
| Presunção | Fez o que **entendeu** | Fez o que **parece certo** |
| Primeiro olhar | A decisão de design | A cobertura do requisito, item por item |
| Dúvida se resolve | Perguntando ao autor | **Executando.** ⚠️ Perguntar "está correto?" a um agente produz concordância, não verificação |
| Teste alterado | O autor explica | Reverta e rode |
| Comentário e doc no PR | Razoavelmente confiável | Descreve o que ele **pretendia**; confira contra o código |
| Antes de revisar | — | Pergunte **"o que ficou de fora do que foi pedido?"** — ele responde isso melhor do que "está correto?" |
| Contra o que se revisa | O requisito | **O briefing.** Se o briefing não tinha definição de pronto, a revisão não tem base — e aí o defeito é de quem orquestrou |

**Verificação adversarial** (`workflow-agentes-programacao`): peça para **provar que está errado**,
não para confirmar. Revisores com lentes distintas (correção, isolamento multi-tenant, custo/latência,
"isso reproduz mesmo?"). ⚠️ **Achado de revisor-agente não verificado não é achado** — ele produz
problemas plausíveis inexistentes com a mesma facilidade com que encontra os reais.

---

## 5. Mensagem de commit

### 5.1 Formato

```
<tipo>(<escopo>): <resumo no imperativo, ≤ 72 caracteres>

<corpo: por quê, não o quê — quebra em 80 colunas>

Refs: PED-08, INV-27
Co-Authored-By: <agente, quando houver>
BREAKING CHANGE: <só quando houver>
```

| Tipo | Escopo |
|---|---|
| `feat` `fix` `db` `refactor` `perf` `test` `docs` `chore` | `api` `console` `app` `catalogo` `shared` `conectores` `infra` `planejamento`, ou o contexto (`atendimento`, `pedido`, `integracao`) |

- **Um commit = uma unidade revertível.** Refatoração não entra no mesmo commit de comportamento.
- `db` é tipo próprio porque migration tem regra de reversão diferente de tudo (§7).

### 5.2 Por que o corpo importa

O corpo responde quatro coisas que o diff não responde:

1. **Que problema real** motivou — não "o que o código faz"
2. **Que alternativa foi descartada, e por quê** — senão alguém a reintroduz em seis meses
3. **Que armadilha o próximo vai encontrar** aqui
4. **O que ficou de fora**, com ID

⚠️ **O histórico é a única documentação que não desatualiza**, porque é datada. Um documento pode
mentir sobre o presente; um commit descreve o que era verdade naquele dia — e isso basta para
reconstruir a decisão.

⚠️ **Com agentes no fluxo, o corpo do commit é o que sobra de contexto.** O agente não tem memória
entre sessões; o próximo lê `git log` e os documentos. Um commit `"ajustes"` apaga a única fonte que
ele teria de por que aquele `if` estranho existe — e ele vai remover o `if`.

Os commits `32bedfe` e `6ef8a0b` deste repositório são o padrão: cada achado nomeado, cada decisão
justificada, e o que ficou aberto declarado no fim.

---

## 6. CI

### 6.1 O que roda

| Etapa | Quando | Bloqueia merge |
|---|---|---|
| `lint` · `typecheck` | Todo push | ✅ |
| Testes de domínio (Vitest, sem IO) | Todo push | ✅ |
| Testes de caso de uso com **Testcontainers** (Postgres real, RLS com dois tenants) | Todo PR | ✅ |
| **Runner de migrations** — o mesmo que sobe produção — de banco vazio **e a partir do schema em produção** | PR que toca `infra/migrations` | ✅ |
| Varredor de schema: tabela de domínio sem RLS, `UNIQUE` sem `tenant_id` | Todo PR | ✅ |
| Isolamento de canal SSE (dois tenants, permissão revogada, payload sem conteúdo) | Todo PR | ✅ |
| Suíte de **conformidade dos conectores** | PR que toca `packages/conectores` | ✅ |
| Verificador de **watch path** (import novo de `shared` em app não coberto) | Todo PR | ✅ |
| `build` de todos os apps (Turborepo) | Todo PR | ✅ |
| Auditoria de dependência, tamanho de bundle | Todo PR | ℹ️ informa |
| E2E com Meta, ERP ou IA **reais** | — | ❌ **nunca no CI** |

⚠️ **O runner de migrations rodar só contra banco vazio é armadilha.** Migration que assume tabela
vazia passa verde e quebra no `preDeployCommand`, com a versão anterior servindo e o deploy travado.

⚠️ **CI verde não significa "funciona".** Nenhuma integração externa real foi exercitada — Meta,
ERP e IA estão todos mockados por contrato. É para isso que existe homologação (§8).

### 6.2 Regras de operação

- **Alvo: bloco obrigatório em < 8 minutos.** ⚠️ CI lento é revisão pulada — o revisor aprova para
  não esperar de novo.
- **Teste instável é defeito: conserta ou apaga.** Proibido "re-run" como resposta; o terceiro
  re-run do mesmo teste vira issue com dono. Um flaky tolerado ensina o time a ignorar vermelho, e
  aí a suíte inteira perde valor.
- Testcontainers exige Docker. Rodou só domínio? **Diga isso no resultado** — não afirme que a
  suíte passou.

---

## 7. Quando `main` quebra

**Prioridade zero.** Ninguém começa tarefa nova enquanto `main` está vermelha.

| # | Passo | Teto |
|---|---|---|
| 1 | Anunciar no canal e **congelar merges** | imediato |
| 2 | Tentar `fix-forward` | **10 minutos** |
| 3 | Estourou o teto → `git revert` do merge commit, direto em `main`, com o motivo no corpo | imediato |
| 4 | Confirmar `main` verde, descongelar | — |
| 5 | Teste que **reproduz**, escrito antes do refix | antes de voltar |
| 6 | No corpo do commit do refix: **por que o CI deixou passar** e o que entrou na suíte | — |

⚠️ **Migration já aplicada não se reverte com `git revert`.** O código volta; o schema não. É
exatamente para isso que a regra "toda migration é aditiva" existe: a versão anterior convive com a
coluna nova, então reverter o **código** é seguro. Reverter o **schema** exige uma migration nova,
revisada, com o mesmo rigor da original — nunca `psql` manual em produção.

⚠️ **"Quebrado" inclui deploy verde com comportamento errado.** O caso clássico está em
`geracrm-monorepo-deploy`: watch path sem `packages/shared/**`, deploy verde, tela desatualizada, API
respondendo outra coisa. Sintoma → causa provável: consultar a tabela de depuração de deploy da skill,
não reinvestigar do zero.

---

## 8. Ambientes e promoção

### 8.1 Os três

| | **dev** | **hom** | **prod** |
|---|---|---|---|
| Onde | Local (Docker Compose) | Railway `geracrm-hom` | Railway `geracrm-prod` |
| Meta | Dublê | WABA de teste da Gera3 | WABA do cliente (Embedded Signup) |
| ERP | Dublê | GeraCloud de homologação | GeraCloud do cliente |
| IA | Dublê | Chave própria **com teto** | Chave de produção |
| Banco | Postgres local + Testcontainers | Instância própria | Instância + réplica |
| Dado | Sintético | **Anonimizado**, por script versionado | Real |
| Rótulo na tela | Faixa "DEV" | Faixa "HOM" | **Nenhum** |

Detalhe de provisionamento em `plano-onda-0.md` §2 — inclusive por que são **dois projetos Railway
separados**, e não dois environments do mesmo projeto.

### 8.2 ⚠️ O risco concreto de misturar credencial

Não é abstrato. É o seguinte, em ordem de gravidade:

| Mistura | O que acontece |
|---|---|
| Token da **Meta** de produção num ambiente de teste | Uma campanha de teste é entregue a lojistas reais — clientes **do nosso cliente**. Mensagem entregue não se desfaz: não há delete, não há retratação, e "Teste 123" às 3h da manhã custa a relação comercial da marca, não a nossa. Ainda derruba a **qualidade do número** e pode rebaixar o tier |
| Credencial de **ERP** de produção em homologação | Pedido de teste efetivado no ERP real vira nota fiscal, separação e expedição. O estoque some de verdade |
| Chave de **IA** compartilhada entre ambientes | O custo do teste cai na fatura do tenant errado — e a métrica de custo por tenant, que é o que precifica o plano, passa a mentir sem que ninguém note |
| `DATABASE_URL` de produção em hom | Não precisa de explicação. Foi por isso que os projetos Railway são separados |

### 8.3 Regras duras

- **Nenhuma variável é copiada entre ambientes. Nunca.** Cada cofre é preenchido do zero, à mão,
  por quem tem acesso àquele ambiente. Copiar-e-colar entre painéis é proibido.
- **Em homologação, o gateway de envio só alcança uma allowlist de números** — e isso é **código**,
  não configuração: envio para número fora da allowlist é erro tipificado, não aviso. ⚠️ Confiar em
  "aqui usamos a WABA de teste" é confiar em quem preencheu a variável naquele dia.
- Dado de produção **não desce** para hom sem anonimização de telefone, CNPJ, nome e corpo de
  mensagem, por script versionado — nunca à mão.
- Acesso a produção: **leitura por padrão**; escrita exige motivo e é auditada (PLT-05).
- Nenhum agente recebe credencial de hom ou prod (§10.4).

### 8.4 Promoção

```
merge em main  →  deploy AUTOMÁTICO em hom  →  promoção MANUAL para prod, com tag
```

Antes de promover:

- □ Rodou em hom por pelo menos um ciclo de uso real (não só "subiu")
- □ Migrations da release aplicadas em hom **a partir do schema de produção**
- □ Nada de destrutivo pendente do plano de 2–3 deploys
- □ Alertas do §I-10 do plano da Onda 0 sem ruído novo
- □ Tag `vX.Y.Z` criada **na promoção**, não no merge
- □ Quem promove é pessoa. ⚠️ **Deploy nunca é delegado a agente**

---

## 9. Versionamento

- **Uma versão para o produto inteiro** (`MAJOR.MINOR.PATCH`), não uma por app. Console, app, API e
  catálogo sobem da mesma `main`, e o suporte precisa perguntar **uma** coisa.
- Quando sobe: `PATCH` em correção · `MINOR` em release com comportamento novo · `MAJOR` só em
  quebra de contrato (`/v2` convivendo com `/v1`, §1.2 do contrato).
- **O rodapé mostra:** versão + **SHA curto do build** + ambiente (**só fora de produção**). Também
  em `GET /v1/health`, para o suporte conferir API e tela separadamente.
- ⚠️ **O rodapé lê o SHA do build, nunca uma constante escrita à mão.** Constante manual é como a
  versão para de andar.
- ⚠️ **Exceção do app Expo:** OTA muda o JS sem mudar o binário da loja. O rodapé mostra a versão do
  **bundle**, não a da loja — senão o suporte pergunta a versão errada e recebe a resposta certa
  para o app errado.
- **CHANGELOG derivado dos commits** — mais um motivo de o corpo importar (§5.2). Prompt de IA tem
  changelog próprio (§1.2).

⚠️ **Versão parada responde errado com cara de certa.** O roteiro do desastre é sempre o mesmo: o
suporte pergunta a versão, a vendedora lê o rodapé, o time reproduz naquela versão e conclui "não
reproduz". Duas horas depois descobre-se que o deploy do console falhou e só a API subiu. **A versão
mentirosa custa mais que a ausência de versão**, porque encerra a investigação em vez de abri-la.

---

## 10. Trabalho com agentes

A metodologia está em `workflow-agentes-programacao` — decomposição em raias, briefing de cinco
partes, isolamento, verificação adversarial, integração incremental. Aqui ficam só as decisões
**deste projeto**.

### 10.1 Quando usar

| Usar agente | Não usar |
|---|---|
| Implementar cenário BDD **já escrito**, com fronteira de arquivo clara | Escrever o cenário quando a regra ainda está ambígua |
| Conector novo contra a **suíte de conformidade** existente | Decidir quais capacidades o conector declara |
| Varredura repetitiva: RLS em N tabelas, N telas para o token novo, N testes de fronteira a partir das invariantes | Qualquer coisa que caiba em 20 minutos |
| Revisão sob uma lente específica (isolamento, custo, caminho de erro) | Revisão que substitui a humana nos itens da §3.5 |
| Investigação por ângulos independentes | Cadeia onde cada passo depende do anterior |

### 10.2 O que **nunca** delegar

- **Decisão que vira ADR** — o agente escolhe o que parece comum, não o que serve ao caso
- **Modelagem de domínio e invariante nova** — o modelo tem 60 invariantes com dono; é onde o
  negócio mora, e reconhecer padrão não é entender atacado de moda
- **Escolha de dependência externa** — ele sugere a mais popular, sem avaliar manutenção
- **Resolver contradição entre documentos** — ⚠️ ele escolhe uma leitura e segue, sem avisar que
  havia duas. Foi assim que nasceram as sete inconsistências altas corrigidas em `6ef8a0b`, e elas
  apareceram por revisão adversarial, não por quem as escreveu
- **Promoção para produção, disparo de campanha, carga histórica em base real** — irreversível
- **Preenchimento de cofre e manuseio de credencial** (§8.3)
- **Aceite** — quem escreveu não declara pronto (§10.6)

### 10.3 Briefing

```
RAIA        Bloqueio de pedido abaixo do mínimo
OBJETIVO    A vendedora não consegue enviar pedido que o cliente não pode receber,
            e sabe exatamente quanto falta
CONTEXTO    docs/escopo-funcional-geracrm.md → PED-08
            docs/cenarios-bdd.md → §8
            docs/modelo-de-dados.md → INV-27
            skills obrigatórias: geracrm-arquitetura, geracrm-testes, codigo-limpo
ARQUIVOS    apps/api/src/contexts/pedido/**, packages/shared/pedido/**
NÃO TOCAR   packages/conectores/**  (outra raia)
CONTRATO    consome a porta EstoqueConsultavel — não a implemente, não altere a assinatura
PRONTO      cenários de §8 verdes · caminho de infra (ERP fora) coberto ·
            caso de dois tenants · rascunho preservado na recusa
FORA        exportação do rascunho (PED-08c) — não peça, não invente
```

⚠️ **O briefing aponta o ID e o arquivo; não parafraseia.** Paráfrase cria uma segunda fonte de
verdade — e a segunda é a que o agente segue, porque é a que está no contexto dele.

⚠️ **"Implemente PED-08" não é briefing.** Sem `NÃO TOCAR`, `CONTRATO` e `FORA`, o agente preenche
as lacunas com invenção plausível, e a invenção só aparece na revisão — se aparecer.

⚠️ **Diga qual skill carregar.** `geracrm-arquitetura` é obrigatória em qualquer código; a de área
(`geracrm-tempo-real`, `geracrm-dados-postgres`, `geracrm-whatsapp-meta`…) conforme o arquivo tocado.

### 10.4 Isolamento

- **Um agente, uma raia, um worktree, uma branch.** ⚠️ Nunca dois agentes com escrita no mesmo
  diretório — um sobrescreve o outro sem que ninguém perceba.
- **Se duas raias listam o mesmo arquivo, são uma raia só.**
- ⚠️ **Banco por agente.** Testcontainers já isola por processo; um Postgres compartilhado entre
  agentes produz teste de RLS falhando sem causa — e flaky sem causa ensina a ignorar vermelho.
- ⚠️ **Nenhum agente recebe credencial de hom ou prod.** Dublê é o padrão. Se a tarefa exige
  credencial real, ela não é tarefa de agente.
- **Migration: um agente por vez** (§3.2).

### 10.5 Verificação

1. Antes de olhar o diff: **"o que ficou de fora do que foi pedido?"**
2. Refutação, não confirmação: "encontre o caso onde isso falha".
3. Rodar > opinar. Se dá para executar, execute.
4. Integração **incremental**, uma raia por vez, suíte completa a cada uma. ⚠️ Cinco raias juntas e
   suíte vermelha = você não sabe qual causou.

### 10.6 Aceite

| Papel | Faz | Não faz |
|---|---|---|
| **Agente de raia** | Implementa, testa, declara o que ficou de fora | **Não** declara pronto |
| **Agente revisor** | Aponta achados sob uma lente | **Não** aprova merge |
| **Quem orquestra** | Decompõe, integra, resolve conflito, mantém o modelo mental do todo | Não implementa raia enquanto orquestra |
| **Quem aceita** | Lê o requisito e aponta, critério por critério, onde está atendido | Nunca é quem escreveu |

⚠️ **Aceite não é "o CI está verde".** O CI prova que o código faz o que o teste diz; o aceite prova
que o teste diz o que o requisito pede. São coisas diferentes, e a segunda é a que o agente não faz.

---

## 11. O que este documento ainda não cobre

| Lacuna | Quando | Por que não agora |
|---|---|---|
| **Runbook de operação** e plantão | Antes do go-live | Precisa da operação real para ser útil |
| **Post-mortem formal** | Ao primeiro incidente com cliente real | Hoje o corpo do commit basta (§7, passo 6) |
| **Métrica de produto por onda** (§4.3 da prontidão) | Ao definir a linha de base | Quando existir, vira critério de "Verificada" (§2.2) |
| **Processo de virada do cliente** (§4.1 da prontidão) | Antes da carga histórica | Muda o que a Onda 0 entrega |

---

## 12. Checklists

**Antes de abrir o PR**
□ ID no título, branch e commit · □ base comum da §1.1 · □ tipo específico da §1.2 ·
□ "ficou de fora" escrito · □ corpo do PR com critério → onde está atendido · □ diff ≤ 400 linhas ou
justificado · □ se tocou `shared`, watch path conferido **no mesmo commit** · □ se criou migration,
número reservado e runner rodado a partir do schema atual.

**Antes de revisar**
□ Li o requisito **antes** do diff · □ percorri a ordem da §4.1 · □ rodei a varredura da §4.2 ·
□ se é código de agente, perguntei "o que ficou de fora" antes · □ se um teste existente mudou,
revertí a mudança e rodei · □ o item cai na §3.5 e portanto exige olho humano?

**Antes de promover para produção**
□ Checklist da §8.4 · □ tag criada · □ rodapé mostrando o SHA da release · □ nenhuma variável foi
copiada de outro ambiente · □ quem aperta o botão é pessoa.
