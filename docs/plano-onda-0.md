# GeraCRM — Plano de execução da Onda 0 (Fundação)

> Deriva de [`backlog-epicos-geracrm.md`](./backlog-epicos-geracrm.md) §3,
> [`modelo-de-dados.md`](./modelo-de-dados.md), [`decisoes.md`](./decisoes.md),
> [`stack-arquitetura.md`](./stack-arquitetura.md) e [`prontidao-para-inicio.md`](./prontidao-para-inicio.md).
>
> **Objetivo da onda:** dado entrando e canal em pé. Nada de tela bonita — se a sincronização não
> funcionar, todo o resto é fachada.

**Entrega:** EP-01 (tenancy e usuários) · EP-02 (conector GeraCloud + API pública + carga histórica +
idempotência) · EP-03 (frota de números via Embedded Signup) · EP-04 (cadastro unificado).

**Critério de saída** (os quatro, simultaneamente):

| # | Critério | Como se prova |
|---|---|---|
| 1 | Base histórica do GeraCloud carregada **e reconciliada** | `conexao_erp_cobertura` com `carga_historica_estado='completa'` nos três fluxos; `mv_metricas_contato` batendo com contagem direta em `venda` |
| 2 | Pelo menos 3 números conectados **recebendo e enviando** | Mensagem entrante do número real cria conversa e contato-lead; resposta dentro da janela chega ao aparelho |
| 3 | Contato do ERP aparece no CRM com telefone e histórico corretos | Um CNPJ escolhido à mão: nomes, telefones, documentos, endereços e vendas conferidos linha a linha contra o ERP |
| 4 | Isolamento provado | Suíte de RLS com dois tenants verde em **todo** repositório, e o varredor de schema sem achado |

**Duração estimada:** 8 semanas de desenvolvimento — ⚠️ **desde que o registro na Meta comece na
semana 0**. O prazo da Meta não é nosso e não paraleliza depois.

---

## 0. Como ler este documento

Quatro frentes correm em paralelo, com donos diferentes:

| Frente | Bloco de tarefas | Depende de |
|---|---|---|
| **M** — Meta | §1 | Documentação societária da Gera3. **Começa hoje** |
| **I** — Infra | §2 | Cartão corporativo e conta AWS |
| **R** — Repositório | §3 | Nada |
| **D** — Migrations | §4 | R (esqueleto) + decisão nº 10 do modelo |
| **E1…E4** — Épicos | §5 | D, I, e (só para o piloto) M |

⚠️ **Sequenciar M depois de tudo é o único erro desta onda que não tem correção.** Business
Verification + Tech Provider + App Review somam semanas de espera de terceiro. Enquanto isso, todo o
resto é desenvolvível com a WABA da própria Gera3 em modo de desenvolvimento.

---

## 1. ⚠️ CAMINHO CRÍTICO EXTERNO — registro na Meta

**Comece por aqui. Hoje. Antes da primeira linha de código.**

### 1.1 A ordem, e por que ela é essa

| # | Etapa | Quem executa | Pré-requisito | Espera típica |
|---|---|---|---|---|
| **M-01** | Conta Meta Business (Business Manager) da Gera3 | Nós | CNPJ ativo | minutos |
| **M-02** | **Verificação de domínio** (`geracrm.com.br` ou o que for) por TXT no DNS | Nós | Domínio comprado e DNS acessível | horas |
| **M-03** | App no `developers.facebook.com`, tipo **Business**, com os produtos **WhatsApp** e **Instagram** adicionados | Nós | M-01 | minutos |
| **M-04** | **Business Verification** — envio de documentação | **Meta** | M-01, M-02 | **dias a semanas** |
| **M-05** | **Enrollment no Tech Provider Program** | **Meta** | M-04 aprovada | **dias a semanas** |
| **M-06** | Configuração do **Embedded Signup** (`config_id`, permissões, redirect URIs) | Nós | M-05 | horas |
| **M-07** | **App Review** — `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`, `instagram_business_manage_messages`, `instagram_business_basic` | **Meta** | M-06 **e o fluxo funcionando em URL pública** | **dias a semanas, com reprovações** |
| **M-08** | Número de teste da Cloud API + WABA da Gera3 em modo dev | Nós | M-03 | minutos |

### 1.2 ⚠️ O ciclo que trava quem não percebe

**App Review exige screencast do Embedded Signup funcionando de ponta a ponta, em URL pública.**
Ou seja: M-07 depende de código pronto e implantado em homologação. Quem planeja "primeiro o registro,
depois o código" descobre isso na semana 6.

**Consequência prática, e é ela que define a ordem desta onda:**

```
M-01…M-04  →  correm em paralelo ao código, sem bloquear nada
M-08       →  destrava 100% do desenvolvimento do EP-03 (número de teste, WABA nossa)
M-05, M-06 →  precisam estar prontos ANTES de M-07
M-07       →  agendar para a semana em que o Embedded Signup estiver em homologação (≈ S5)
```

### 1.3 Documentação de M-04 — reunir antes de abrir o processo

Cartão CNPJ · contrato social ou estatuto · comprovante de endereço em nome da empresa (conta de
serviço público recente) · telefone comercial que atenda · site no **domínio verificado em M-02**,
com o nome legal e o endereço visíveis.

⚠️ **O nome legal enviado à Meta precisa ser byte a byte o do cartão CNPJ.** "Gera3 Ltda" contra
"GERA 3 TECNOLOGIA LTDA" é reprovação com recomeço do ciclo.
⚠️ **Site e e-mail no mesmo domínio verificado.** Gmail corporativo reprova.

### 1.4 O que fica bloqueado enquanto não sai

| Bloqueado por | O que trava | O que **não** trava |
|---|---|---|
| **M-04/M-05** (verificação + Tech Provider) | Onboarding de **cliente real** via Embedded Signup | Toda a implementação: usamos a WABA da Gera3 |
| **M-07** (App Review) | App em modo dev só alcança **usuários com papel no app** (admin/dev/tester) e **até 5 destinatários de teste** | Webhooks, envio, recebimento, templates, throttling, custo — tudo exercitável na WABA própria |
| **M-07** (permissões de Instagram) | Instagram Direct em escala | Nada da Onda 0 — Instagram é Onda 2/3 (EP-20). Pedir as permissões **junto** só para não fazer dois ciclos |
| Método de pagamento do **cliente** na conta Meta dele | O número **do cliente** enviar | Nada nosso. É passo obrigatório do onboarding (ADR-002) e campo do painel de saúde |

**Regra da onda:** o **piloto com cliente real** é o único item que fica atrás da Meta. Se M-05 não
sair até a S6, o critério de saída nº 2 é atendido com **números da Gera3** e o piloto escorrega
para a Onda 1 — sem escorregar mais nada.

### 1.5 Segundo caminho externo — acesso ao GeraCloud

Menor, mas com dono fora do time. Encaminhar na mesma semana:

| # | Item | Bloqueia |
|---|---|---|
| **M-09** | Documentação da API do GeraCloud (clientes, produtos/estoque, pedidos, saldo, tabela de preço, crédito, escrita de pedido) | EP-02 inteiro |
| **M-10** | Credenciais de **homologação** do GeraCloud, isoladas das de produção | EP-02 |
| **M-11** | **Cópia de base real anonimizada** do cliente piloto, ou acesso de leitura à base dele | Dimensionamento da carga histórica e o risco nº 1 da §6 |
| **M-12** | Resposta ao **volume real** (nº de contatos, anos de histórico, vendas/ano, mensagens/dia, nº de números) | Granularidade de partição — decisão aberta nº 1 do modelo. ⚠️ Barato agora, caro depois |

---

## 2. Provisionamento de infraestrutura

**Três ambientes, credenciais distintas em tudo** (ADR-006, `geracrm-monorepo-deploy`).

| Ambiente | Onde | Meta | ERP | IA |
|---|---|---|---|---|
| **dev** | Local (Docker Compose: Postgres, MinIO) | Dublê | Dublê | Dublê |
| **hom** | Railway, projeto `geracrm-hom` | WABA de teste da Gera3 | GeraCloud de homologação | Chave própria com teto |
| **prod** | Railway, projeto `geracrm-prod` | WABA do cliente (Embedded Signup) | GeraCloud do cliente | Chave de produção |

⚠️ **Dois projetos Railway separados, não dois environments do mesmo projeto.** Environment do
Railway compartilha o mesmo `PROJECT_ID` e o mesmo blast radius de permissão; a separação por projeto
é o que impede um `railway link` errado apontar o console de homologação para o banco de produção.

### 2.1 Tarefas

| # | Tarefa | Detalhe | Pronto quando |
|---|---|---|---|
| **I-01** | **Cognito user pool** (uma pool por ambiente: `geracrm-hom`, `geracrm-prod`) | Atributo customizado **`custom:tenant_id`** (string, mutável=false); MFA TOTP opcional-por-usuário (PLT-04); verificação de e-mail; políticas de senha; **app client sem Hosted UI**, com `USER_PASSWORD_AUTH`/`SRP` e refresh token | `GET /.well-known/jwks.json` responde e a API valida um JWT emitido localmente |
| **I-02** | ⚠️ **Decidir o que o token carrega** | Ver §2.2 | ADR escrito em `decisoes.md` |
| **I-03** | Railway: projeto por ambiente, com serviços `api`, `webhooks`, `workers`, `console`, `catalogo` | `catalogo` pode nascer como stub — o serviço existe para reservar o watch path | `railway status` lista os cinco |
| **I-04** | Postgres gerenciado (Railway) + **réplica de leitura** | ⚠️ A réplica precisa da **mesma** configuração de RLS e do mesmo `SET app.tenant_id` (§7.3 do modelo). Conexão analítica **não** é "a conexão que vê tudo" | Teste de isolamento roda **também** contra a réplica |
| **I-05** | Bucket de object storage (mídia de conversa) por ambiente | URLs assinadas com expiração curta; **nunca URL pública adivinhável**; política de ciclo de vida desde o dia 1 (custo nº 2 da stack) | Upload + download por URL assinada, e a URL expira |
| **I-06** | Sentry: **um projeto por app por ambiente** | `api-hom`, `api-prod`, `console-hom`… Release atrelado ao SHA do commit; ⚠️ `beforeSend` que remove telefone, CNPJ, corpo de mensagem e credencial | Erro proposital em hom cai no projeto certo, sem PII |
| **I-07** | Cofre de variáveis por ambiente | Segredo da Meta, credencial do GeraCloud, chave de cifra das credenciais de tenant, `DATABASE_URL`, `DATABASE_REPLICA_URL`, Cognito, S3, Sentry DSN | Nenhum segredo em `.env` versionado; `.gitignore` cobre |
| **I-08** | Domínios: `api.` / `app.` / `hom-api.` / `hom-app.` | Necessário para M-02 e para o webhook da Meta (HTTPS público) | Certificado válido e webhook da Meta verificado |
| **I-09** | **Chave de cifra de credenciais de tenant** (INV-41) | Chave por ambiente, fora do banco, com procedimento de rotação escrito | Credencial de ERP gravada e lida cifrada; `SELECT` cru devolve bytes |
| **I-10** | Alertas mínimos | Deploy falho, `preDeployCommand` falho, erro 5xx acima do limiar, fila de outbox parada, webhook da Meta com timeout | Alerta chega ao canal certo, com o ambiente no título |

### 2.2 ⚠️ A contradição do papel no Cognito, decidida aqui

`geracrm-identidade-acesso` diz "papéis por **groups** do Cognito". O modelo de dados diz o oposto:
**INV-59 — papel é atribuído por filial**, em `usuario_filial`, e `usuario.papel` escalar não existe,
porque um supervisor é gestor na matriz e vendedor no showroom.

Grupo do Cognito é escalar e global por usuário. **Ele não consegue representar o papel.**

**Decisão da Onda 0:**

| O que | Onde mora |
|---|---|
| `tenant_id` | Claim `custom:tenant_id` — **fonte única**, nunca parâmetro (INV-02) |
| Identidade do usuário | `sub` → `usuario.cognito_sub` |
| **Papel por filial** | **Nosso banco** (`usuario_filial`), lido a cada request sob RLS |
| Staff da Gera3 (cross-tenant) | **Group** do Cognito — é o único recorte global, e todo acesso dele é auditado (PLT-05) |

⚠️ Se o papel fosse claim, revogar permissão exigiria esperar o refresh do token — e
`geracrm-identidade-acesso` exige revogação **imediata** durante a sessão.

### 2.3 Armadilhas de infra que custam caro depois

| ⚠️ Armadilha | Tratamento |
|---|---|
| **A role da aplicação ser dona das tabelas** | Dono ignora RLS a menos que `FORCE`, e mesmo com `FORCE` pode alterar policy. Migrations rodam com a role dona; a API conecta com `geracrm_app`, **sem** `BYPASSRLS` e **sem** ownership |
| **`SET app.tenant_id` vazando entre requests** | Pool reutiliza conexão. **Sempre** `set_config('app.tenant_id', $1, true)` — o `true` é `LOCAL`, morre no fim da transação. Um `SET` sem `LOCAL` entrega o tenant anterior à próxima request |
| **Migration rodando em dois serviços ao mesmo tempo** | `preDeployCommand` **só no serviço `api`**. O runner ainda assim toma `pg_advisory_lock` antes de aplicar |
| **Réplica com lag durante a carga histórica** | A carga escreve na primária em lotes curtos; leitura analítica na réplica pode atrasar. O painel declara a hora de apuração — nunca finge tempo real |
| **Bucket sem retenção** | Áudio e imagem acumulam rápido. Política de ciclo de vida configurada junto com o bucket, não depois |

---

## 3. Esqueleto do monorepo

Estado atual: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` e as pastas
com `README.md` já existem. Falta o conteúdo.

```
apps/
  api/          Fastify · src/contexts/{identidade,contato,atendimento,integracao,catalogo,pedido,crm,campanha,analitico}
                          src/db/schema/ (espelho Drizzle do SQL) · src/plataforma/ (fastify plugins)
                          src/entradas/{http.ts, webhooks.ts, workers.ts}  ← três pontos de entrada, um código
  console/      Angular 21+ (zoneless, signals, standalone)
  app/          Expo
  catalogo/     stub na Onda 0 — existe para reservar o serviço e o watch path
packages/
  shared/         ⚠️ TypeScript PURO — tipos, Zod, constantes, regras puras
  design-tokens/  tokens.json (já existe) → CSS custom properties + preset NativeWind
  conectores/     geracloud/ · api-publica/ (o conector universal) · conformidade/ (a suíte compartilhada)
infra/
  migrations/     SQL numerado, à mão
  runner/         aplicador de migrations (usado no CI e no preDeploy)
  railway/        watch-paths.json — declaração conferida pelo CI
```

### 3.1 Tarefas

| # | Tarefa | Pronto quando |
|---|---|---|
| **R-01** | `apps/api` com Fastify, Zod nas bordas, plugin de tenant, health check, `fastify.inject()` no teste | `pnpm test` verde com um teste de rota |
| **R-02** | Três pontos de entrada compartilhando `src/`: `http`, `webhooks` (gateway), `workers` | Os três sobem com o mesmo build; `webhooks` responde em < 50 ms sem tocar o domínio |
| **R-03** | `packages/shared` com os primeiros habitantes: `Dinheiro`, normalizador de telefone (§6.5), `janelaDeAtendimento()` (INV-18), uniões de literais de estado, schemas Zod de paginação por cursor | Importado pela API **e** por um teste do console sem puxar dependência de framework |
| **R-04** | `apps/console` Angular 21+ com login funcionando contra o Cognito | Login real em hom; Hosted UI **nunca** aparece |
| **R-05** | `packages/conectores` com a **porta** (definida pelo nosso domínio) e a suíte de conformidade `describe.each` | Suíte roda contra um conector dublê e os `skip` são os esperados |
| **R-06** | **Contrato de API** — lacuna 2.4 de `prontidao-para-inicio` | Documento curto: versionamento de rota, `{ itens, cursorProximo, temMais }`, formato de erro tipificado, contrato do canal SSE. ⚠️ Escrever **antes** da primeira rota, não depois de vinte |
| **R-07** | `infra/runner` — aplicador de migrations com `pg_advisory_lock` e `schema_migrations` | Roda no CI a cada PR e é **o mesmo** binário do `preDeployCommand` |
| **R-08** | CI: `pnpm lint typecheck test` + runner de migrations + **os varredores de schema** (§5.6) | Nenhum merge em `main` sem os checks |
| **R-09** | `infra/railway/watch-paths.json` + verificador no CI | Ver §3.3 |
| **R-10** | Versão exibida no rodapé, com rótulo de ambiente que **nunca** aparece em produção | `hom` mostra "hom"; `prod` não mostra nada |

### 3.2 ⚠️ `packages/shared` é TypeScript puro — sem exceção

Consumido por Angular, Expo e API **ao mesmo tempo**. Um `import` de React, de Angular ou de qualquer
runtime específico quebra dois dos três consumidores.

**Entra:** tipo, schema Zod, constante, função pura de domínio.
**Não entra:** componente, hook, `signal`, serviço, `window`, `fetch`.

Regra de bolso: **na dúvida entre `shared` e o app, comece no app.** Subir depois é fácil; descer é
quebra em cascata.

### 3.3 ⚠️ A armadilha do watch path — registrada, com verificação automática

Cada app tem serviço e watch path próprios no Railway:

| Serviço | Watch path |
|---|---|
| `api` | `apps/api/**` + `packages/**` + `infra/migrations/**` |
| `webhooks` | `apps/api/**` + `packages/**` |
| `workers` | `apps/api/**` + `packages/**` |
| `console` | `apps/console/**` + **`packages/shared/**`** + **`packages/design-tokens/**`** |
| `app` (Expo) | `apps/app/**` + **`packages/shared/**`** + **`packages/design-tokens/**`** |
| `catalogo` | `apps/catalogo/**` + `packages/shared/**` |

⚠️ **É a armadilha que o drezz documentou e que custa caro:** se um front passa a importar
`packages/shared` e o watch path não inclui `packages/shared/**`, **o tipo muda na API e não muda na
tela**. O deploy fica verde, a API responde outra coisa, e ninguém entende por quê. O sintoma
("deploy verde, tela desatualizada") demora dias para virar diagnóstico.

**Regra:** ao adicionar um import de `shared` num app, confira o watch path **no mesmo commit**.

**Mecanismo (R-09), porque disciplina não é dono de nada:** `infra/railway/watch-paths.json` declara o
watch path de cada serviço; um check de CI varre os imports reais de cada app e **falha** se algum app
importa um pacote que não está no watch path declarado. A conferência com o Railway continua manual —
mas o esquecimento passa a ser vermelho no PR, não mistério em produção.

### 3.4 Turborepo e migrations no pre-deploy

Alvos padronizados em todos os apps: `build`, `dev`, `test`, `lint`, `typecheck`. `build` depende de
`^build`; `dev` sem cache e persistente. O Angular CLI e o Expo entram como qualquer outro alvo.

`preDeployCommand` no serviço `api` aplica `infra/migrations/*.sql`. ⚠️ **Falhou, o deploy não
prossegue** e a versão anterior continua servindo.

⚠️ **Consequência que muda como se escreve migration: ela roda com a versão anterior ainda atendendo
tráfego.** Portanto **toda migration é aditiva**. Remover ou renomear coluna são **dois ou três
deploys** (adicionar → migrar leitura/escrita → remover). Na Onda 0 isso parece teoria porque o banco
está vazio; a hora de criar o hábito é agora, porque na Onda 1 já não dá.

---

## 4. Sequência de migrations iniciais

Derivadas de `modelo-de-dados.md` §8. **Toda migration é aditiva.** Cada arquivo roda em transação —
⚠️ `CREATE INDEX CONCURRENTLY` não entra; na Onda 0 as tabelas estão vazias e `CREATE INDEX` comum
resolve, mas o hábito de índice em migration própria começa aqui.

⚠️ **Decisão nº 10 do modelo precisa ser fechada ANTES do arquivo `0001`:** PK composta
`(tenant_id, id)` versus `id` PK + `UNIQUE(tenant_id, id)`. Este plano assume **PK composta
`(tenant_id, id)`** — é o que a §7.1 do modelo prescreve e o que torna a FK composta natural. A
tarefa **D-00** é uma prova de conceito de meio dia com Drizzle + uma rota do console; se a ergonomia
for insuportável, a alternativa é registrada como ADR **antes** de `0001`, não depois de `0012`.

| # | Arquivo | O que cria | ⚠️ Ponto de atenção |
|---|---|---|---|
| **D-01** | `0001_base.sql` | Extensões `btree_gist`, `pg_trgm` · role `geracrm_app` (sem `BYPASSRLS`, sem ownership) · função `app_tenant_atual()` · procedure `aplicar_rls_padrao(regclass)` · `schema_migrations` · `outbox` | `app_tenant_atual()` usa `current_setting('app.tenant_id', true)` — sem tenant setado devolve `NULL` e a policy **não devolve linha nenhuma**. Job sem tenant não roda, em vez de ler tudo |
| **D-02** | `0002_catalogos_globais.sql` | `plano`, `perfil_vertical_modelo`, `tarifa_meta` | Três das seis tabelas **sem `tenant_id`** (§7.2). Só `GRANT SELECT` para `geracrm_app`. Qualquer tabela nova fora da lista das seis sem `tenant_id` é **bug de revisão de migration** |
| **D-03** | `0003_tenant.sql` | `tenant` (com `tenant_pai_id` nulo, para PLT-10 na Onda 4) · `perfil_vertical` · RLS em ambas | ⚠️ **Dependência circular real:** `tenant.perfil_vertical_id → perfil_vertical` e `perfil_vertical.tenant_id → tenant`. Cria-se `tenant` sem a FK, depois `perfil_vertical`, e a FK entra por `ALTER TABLE` no fim do mesmo arquivo |
| **D-03b** | `0003b_onboarding.sql` | `onboarding_passo` (PK `(tenant_id, passo)`, com `estado`, `dados jsonb`, `concluido_em`, `concluido_por`) + RLS | ⚠️ **Entra antes de E3-01 (Embedded Signup).** O estado do assistente é do **servidor**, não do navegador: o admin fecha a aba no meio do fluxo da Meta e precisa retomar de onde parou — inclusive com a conexão que já existe do lado da Meta. `aceite_capacidades` registra a data em que ele foi informado do que aquele ERP habilita (ADR-008) |
| **D-04** | `0004_organizacao.sql` | `filial`, `setor`, `contador_por_tenant`, `auditoria` (particionada mensal por `criado_em`) + 12 partições | Protocolo e numeração usam `contador_por_tenant` com `UPDATE … RETURNING`. ⚠️ `SEQUENCE` do Postgres é global — não serve (§7.1, regra 5) |
| **D-05** | `0005_usuario.sql` | `usuario` (`cognito_sub UNIQUE` global), `usuario_filial` (PK `(tenant_id, usuario_id, filial_id)`, `filial_id NULL` = escopo tenant), `token_integracao` | ⚠️ **`usuario` não tem coluna `papel`** (INV-59). Quem adicionar "só para simplificar" reintroduz o bug que INV-59 fecha |
| **D-06** | `0006_integracao.sql` | `conexao_erp` (+ `UNIQUE (tenant_id) WHERE papel='fiscal'`, + `UNIQUE (tenant_id) WHERE fonte_de_venda`), `conexao_erp_cobertura`, `evento_externo`, `operacao_ingestao`, `chave_idempotencia` | ⚠️ `evento_externo` é **não particionada de propósito** (INV-37): a única `(tenant_id, canal, id_externo_evento)` é a base de toda a idempotência de webhook, e em tabela particionada ela não existiria |
| **D-07** | `0007_identidades_externas_org.sql` | `usuario_identidade_externa`, `filial_identidade_externa` | Sem elas, `venda.vendedor_externo` (string do ERP) nunca vira ranking (GES-02/03). Nascem na Onda 0 porque a **ingestão** já as preenche |
| **D-08** | `0008_contato_nucleo.sql` | `grupo_economico`, `contato`, `contato_nome`, `contato_telefone`, `contato_documento`, `contato_endereco` | ⚠️ A única de telefone é **parcial**: `UNIQUE (tenant_id, telefone_e164) WHERE principal` (INV-07/49). Única total quebra a ingestão do ERP. `contato_documento`/`contato_endereco` com **chave local `seq`** — não UUID (§5.3) |
| **D-09** | `0009_contato_satelites.sql` | `contato_identidade_externa`, `contato_campo_origem`, `contato_mesclagem`, `conflito_identidade`, `consentimento_contato`, `pessoa`, `pessoa_contato`, `comentario`, `lista_bloqueio` | `lista_bloqueio` nasce agora, chaveada por **`chave_bloqueio`** (55+DDD+8 dígitos, INV-50), não pela E.164 completa — porque o gateway de envio da Onda 0 já revalida contra ela |
| **D-10** | `0010_carteira.sql` | `carteira_atribuicao` com coluna gerada `periodo tstzrange` e `EXCLUDE USING gist` | ⚠️ Exige `btree_gist` (D-01) e a coluna **gerada** — o operador `&&` não existe sobre `de`/`ate` soltas. `usuario_id NULL` é a linha explícita de "sem dono" (INV-58) |
| **D-11** | `0011_canal.sql` | `canal_conectado` (raiz genérica) + `numero_whatsapp` + `perfil_instagram` + `canal_saude_evento` + `usuario_canal` + `numero_throttle` + `numero_conversa_iniciada` + `numero_quota_hora` | ⚠️ A raiz é **genérica** desde já (§1.2). Criar `numero` como raiz e "adaptar para Instagram depois" é o retrofit que degrada a chave natural `(canal, contato)` |
| **D-11b** | `0011b_template.sql` | `template` e `template_versao` (corpo, categoria, status na Meta, `id_externo`, variáveis) | ⚠️ **Sem isto a Onda 0 não consegue falar com ninguém no dia do corte.** No minuto em que o número é conectado, **todas as janelas de 24h estão fechadas** — a janela é por número e nasce zerada. Sem template aprovado, a vendedora não inicia nenhuma conversa. O contrato de API já previa o caminho; faltavam a tabela e a tarefa |
| **D-12** | `0012_conversa_mensagem.sql` | `conversa` (+ `UNIQUE(tenant_id, canal_id, contato_id)`), `conversa_leitura`, `mensagem` **particionada mensal** + partições, `mensagem_id_externo` (guardiã, não particionada), `midia`, `atendimento` (+ única parcial INV-51), `atendimento_evento` | ⚠️ `atendimento` **nasce completo** e vazio (decisão aberta nº 9 — fechada aqui): criá-lo depois obriga a reprocessar histórico. ⚠️ `midia` carrega `mensagem_criado_em` para a FK composta ser possível (INV-04/60) |
| **D-13** | `0013_catalogo.sql` | `produto`, `produto_identidade_externa`, `produto_variante`, `variante_identidade_externa`, `tabela_preco`, `tabela_preco_identidade_externa`, `tabela_preco_item`, `saldo_cache` | ⚠️ Identidade externa em **tabela própria**, nunca `conexao_id` embutido no produto (§6.7) — com dois ERPs, o embutido duplica produto e quebra `UNIQUE(tenant_id, referencia)`. `saldo_cache` tem PK `(tenant_id, conexao_id, variante_id)` |
| **D-14** | `0014_venda.sql` | `venda` **particionada anual por `data`**, `venda_chave_externa` (guardiã, não particionada), `venda_item` (carregando `venda_data`) | ⚠️ A única de reconciliação **não pode morar em `venda`** (§6.6): incluir `data` destruiria a garantia — a mesma venda reingerida com data corrigida entraria duas vezes sem erro. Partições **retroativas** conforme os anos da carga histórica |
| **D-15** | `0015_indices_onda0.sql` | Índices da §8.6 usados nesta onda: ingestão por id externo, dedup por `wamid`, idempotência de webhook, reconciliação pedido↔venda, `venda (tenant_id, contato_id, data DESC)`, `contato_telefone (tenant_id, telefone_e164)` e `chave_busca`, GIN trigram em `contato.nome_preferido`, `outbox (id) WHERE processado_em IS NULL`, expurgo de `evento_externo` | ⚠️ Índice não usado custa escrita em toda inserção. Índice de tela do inbox e do kanban **não entra agora** — entra na onda que tem a tela |
| **D-16** | `0016_mv_metricas_contato.sql` | `mv_metricas_contato` com `tenant_id`, `confiavel` e `apurado_desde` + índice único (para `REFRESH CONCURRENTLY`) + **policy própria** | ⚠️ **View materializada não herda RLS** da tabela base (§7.3). MV sem policy própria é o dashboard vazando tudo |

### 4.1 Regras que valem para todas elas

| Regra | Origem |
|---|---|
| RLS `ENABLE` + **`FORCE`** + policy com `USING` **e** `WITH CHECK` idênticos, na **mesma migration** que cria a tabela | INV-01, §7.1 regra 6. Sem `WITH CHECK`, dá para *escrever* em outro tenant |
| Toda única composta com `tenant_id`; todo índice de consulta começando por `tenant_id` | INV-03 |
| FK composta `(tenant_id, pai_id) → pai(tenant_id, id)`; filho de particionada carrega a chave de partição do pai | INV-04, INV-60 |
| Dinheiro em `*_centavos **bigint**` | INV-46. ⚠️ **Nunca** `numeric(14,2)` numa coluna chamada `_centavos` — a discrepância é de fator 100 e é silenciosa |
| Estado em `text` com união de literais | INV-48. ⚠️ Nunca `enum` do Postgres; nunca status numérico |
| UUID **v7 gerado na aplicação** (`packages/shared`), não no banco | Portabilidade entre versões do Postgres, e o id existe antes do `INSERT` |
| Sem partição `DEFAULT` | Partição default aceita linha com data errada em silêncio e faz o `ATTACH` seguinte varrer a tabela inteira |
| Partições criadas **12 meses à frente**, por job semanal com alerta abaixo de 3 meses | ⚠️ Partição faltante = `INSERT` falhando em produção às 00h00 do dia 1 |
| Schema TS em `apps/api/src/db/schema/` é **espelho** do SQL, atualizado no mesmo PR | ADR-006. Não usar `drizzle-kit generate` |

---

## 5. Tarefas por épico

Notação: **dep.** = de quem depende · **DoD** = o teste que precisa passar (BDD pragmático em Vitest,
`geracrm-testes`).

### 5.1 EP-01 — Fundação da plataforma e tenancy (PLT-01…04)

| # | Tarefa | Dep. | Definição de pronto |
|---|---|---|---|
| **E1-01** | Plugin Fastify de contexto: valida JWT via JWKS local, extrai `custom:tenant_id`, abre transação e faz `set_config('app.tenant_id', …, true)` | D-03, I-01 | `dado token do tenant A, quando consulta contato do tenant B, então devolve vazio` — não 403: **vazio**, porque quem filtra é o RLS |
| **E1-02** | Cadastro de tenant, filial e setor (PLT-01) | D-04 | `dado tenant sem filial, quando cria usuário, então o vínculo nasce com filial_id NULL (escopo tenant)` |
| **E1-03** | Usuários, convite, aceite e vínculo `(filial, papel)` (PLT-02) | E1-02, I-01 | `dado usuário gestor na matriz e vendedor no showroom, quando lista contatos, então vê tudo da matriz e só a carteira dele no showroom` (INV-59) |
| **E1-04** | **Função central de autorização** com o predicado por papel de INV-34 | E1-03 | `dado vendedor, quando a conversa chegou no canal dele sobre cliente da carteira da colega, então ele vê` (é **disjunção**, e é decisão). ⚠️ Chamada pelo **caso de uso**, nunca pelo controller |
| **E1-05** | Login, sessão, recuperação de senha e **2FA TOTP** (PLT-04), com UI própria | R-04, I-01 | Fluxo completo em hom; ⚠️ Hosted UI do Cognito não aparece em momento nenhum |
| **E1-06** | Auditoria (PLT-05, esqueleto): login, criação de usuário, mudança de papel, acesso cross-tenant do staff | D-04 | `dado staff da Gera3 acessando dado de cliente, então existe registro de auditoria com ator, ação e alvo` |
| **E1-07** | ⚠️ **Especificação das telas de entrada** — lacuna 2.2 de `prontidao-para-inicio` | — | Login, recuperação, convite/aceite, **onboarding do tenant** (Meta + ERP + o que aquele ERP habilita) e seleção de filial/número, com os cinco estados obrigatórios. **É pré-requisito de E1-05 e E3-01, não item paralelo** |
| **E1-08** | Varredores de schema no CI | D-15 | Ver §5.6 |

### 5.2 EP-02 — Espinha dorsal de dados (INT-01…05)

⚠️ **É o épico mais pesado da onda e o que a Onda 2 inteira depende.**

| # | Tarefa | Dep. | Definição de pronto |
|---|---|---|---|
| **E2-01** | **Porta do domínio** e declaração de capacidades (ADR-008) | R-05 | A interface não tem **nenhum** método com nome de endpoint de ERP. Se tiver, é SDK copiado, e o segundo conector prova isso da pior forma |
| **E2-02** | **Suíte de conformidade** compartilhada (`describe.each`) | E2-01 | Roda contra GeraCloud **e** contra a API pública; capacidade ausente é `skip`, nunca falha; a **degradação também é testada** |
| **E2-03** | Adaptador GeraCloud — ingestão em lote: `customers`, `products`, `orders` (INT-01) | E2-01, M-09, M-10, D-13, D-14 | `dado o mesmo lote reenviado, quando processa, então o número de linhas não muda` |
| **E2-04** | **Serviço de reconciliação** — o **único** ponto de escrita de dado vindo de fora (INV-10), com precedência por campo (§6.3) e `contato_campo_origem` | D-08, D-09 | `dado nome vindo do WhatsApp e nome vindo do ERP fiscal, quando ingere, então o do canal entra como alternativo e não sobrescreve` |
| **E2-05** | Chaves de reconciliação com precedência declarada (§6.2) | E2-04 | `dado contato novo cujo telefone já é principal de outro, quando ingere, então cria contato, grava o telefone como secundário e abre conflito_identidade` — ⚠️ **e o lote não falha** (INV-49) |
| **E2-06** | **Idempotência** por chave de operação (INT-04) | D-06 | `dado a mesma chave de operação reenviada, quando processa, então devolve o resultado gravado sem reexecutar` |
| **E2-07** | **Carga histórica** com lotes, retomada e cobertura (INT-05, INV-56) | E2-03, D-14 | `dado o worker morto no meio do lote, quando reinicia, então retoma do cursor, não duplica nada e a cobertura reflete o que de fato entrou`. ⚠️ Milhões de linhas em uma transação só é `WAL` estourado e lock prolongado |
| **E2-08** | **Reconciliação obrigatória ao fim de toda `operacao_ingestao`** (INV-57) | E2-07, D-16 | `dada carga histórica concluída, quando a reconciliação roda, então contato.qtd_vendas bate com mv_metricas_contato para 100% da base`. ⚠️ Sem isso, a base inteira nasce na coluna "Lead" |
| **E2-09** | `conexao_erp_cobertura` alimentada e **exposta** (INV-56) | E2-07 | `dado contato cuja janela de recência excede a cobertura, quando o RFV avalia, então ele NÃO é classificado` — "não sabemos" nunca vira "Perdido" |
| **E2-10** | **INV-55** — uma só conexão é fonte de venda por tenant | D-06 | `dadas duas conexões ingerindo a mesma venda física, quando a segunda processa, então não grava e abre conflito` |
| **E2-11** | **API pública de ingestão** com os três fluxos (INT-02) + Bearer Token e painel (INT-03) | E2-01, D-05 | ⚠️ **Passa na mesma suíte de conformidade do adaptador nativo.** É o conector universal — se for menos capaz, amarramos o produto aos ERPs da casa |
| **E2-12** | Leitura síncrona: saldo por SKU, tabela de preço do cliente, crédito (INT-01b) | E2-03, D-13 | `dado ERP sem resposta em 2s, quando o painel abre, então avisa e bloqueia o envio` — nunca deixa montar às cegas para falhar depois. ⚠️ Contrato definido **agora**, embora o pedido só apareça na Onda 2 |
| **E2-13** | Escrita idempotente de pedido — **só o contrato e o dublê** (INT-01c) | E2-01 | `dada falha de comunicação, quando reenvia com a mesma chave de efetivação, então o ERP não cria segundo pedido`. Erros **tipificados**, nunca string crua do ERP |
| **E2-14** | Circuit breaker por integração | E2-03 | `dado ERP fora do ar, quando o inbox carrega, então o histórico aparece e só o bloco do ERP degrada` |
| **E2-15** | Normalização de telefone na escrita, com o nono dígito (§6.5) | R-03 | Tabela de casos: `+55 81 99861-7049`, `5581998617049`, `81998617049`, `(81) 9861-7049` colidem na mesma canônica; `wa_id` de 12 dígitos vai para `telefone_e164_meta`, **não** vira o canônico |

⚠️ **E2-12 e E2-13 entram na Onda 0 mesmo sem tela.** É a dependência nº 4 do backlog: o pedido
assistido exige do conector três capacidades de **leitura síncrona** que a carga em lote não atende.
Descobrir isso na Onda 2 significa renegociar o contrato de integração com a Onda 2 já começada.

### 5.3 EP-03 — Conectividade WhatsApp e frota de números (CAN-01…03)

| # | Tarefa | Dep. | Definição de pronto |
|---|---|---|---|
| **E3-01** | **Embedded Signup** embutido no onboarding (CAN-01) | M-06, E1-07, D-11 | Fluxo completo em hom, gravando `waba_id`, `phone_number_id` e credencial **cifrada** por tenant. ⚠️ Nunca mandar o cliente para o Business Manager |
| **E3-02** | Registro de **senders adicionais** (multi-número) sem repetir o fluxo completo | E3-01 | Segundo número conectado no mesmo tenant, com nome amigável e filial (CAN-02) |
| **E3-03** | **Gateway de webhooks** — processo separado (`webhooks`) | R-02, D-06 | Faz **apenas**: valida assinatura → grava `evento_externo` → publica no outbox → responde. Responde em < 50 ms |
| **E3-04** | Idempotência de webhook (INV-37) | E3-03 | `dado o mesmo evento reentregue, quando processa, então o handler roda uma vez` — `INSERT … ON CONFLICT DO NOTHING` e só processa quem inseriu |
| **E3-05** | ⚠️ **Falha permanente responde 200** | E3-03 | `dado evento que falha sempre (401/403/404), quando chega, então responde 200 e vai para o log`. Com entrega sequencial, um evento que falha trava a fila de **todos** os clientes |
| **E3-06** | Ingestão de mensagem entrante (INV-12, §3.4) | E3-04, D-12, E2-04 | `dado número desconhecido, quando a mensagem chega, então contato-lead + conversa + mensagem nascem na MESMA transação`. `dado rollback, então não sobra lead fantasma` |
| **E3-07** | Dedup por `wamid` (INV-38) | E3-06 | `dado wamid repetido, quando ingere, então existe uma mensagem` — a única mora em `mensagem_id_externo`, gravada no mesmo commit |
| **E3-08** | Status de entrega monotônico (INV-39) | E3-04 | `dado 'lido' chegando antes de 'entregue', quando processa, então o status não regride` |
| **E3-09** | Envio de mensagem — gateway único de saída | E3-06, D-11 | Revalida, **antes de chamar a Meta**: janela (INV-17/18), canal conectado + pagamento OK (INV-21), opt-out (INV-13), lista de bloqueio por **chave reduzida** (INV-15/50) |
| **E3-15** | **Template: sincronizar da Meta e enviar** (CMP-03/04) | E3-01, D-11b, E3-09 | ⚠️ **Pré-requisito do corte, não item de campanha.** Sincroniza o catálogo aprovado na WABA (nome, categoria, variáveis, status) e permite enviar 1-a-1 pelo gateway. `dada janela fechada, quando envia template aprovado, então passa; quando envia texto livre, então recusa com motivo`. `dado template rejeitado pela Meta, então some da lista e o motivo aparece`. **O construtor de campanha continua na Onda 3** — aqui é só o envio individual |
| **E3-10** | Janela de atendimento **derivada**, função pura em `shared` (INV-18) | R-03 | Testes de fronteira em **23h e 24h** — as bordas é que quebram. A mesma função serve a contagem regressiva da tela e o bloqueio do servidor |
| **E3-11** | Throttling por canal (INV-23) e limite de tier (INV-22) | D-11 | `dadas 50 reservas concorrentes com limite 10, quando disparam, então exatamente 10 passam`. ⚠️ Reserva **antes** da chamada à Meta; proibido ler-incrementar-gravar |
| **E3-12** | Custo por mensagem (§5.5) | E3-08, D-02 | `dada mensagem de serviço dentro da janela, quando entregue, então grava linha com centavos = 0` — omitir a linha impede provar que o toque foi barato. `dado webhook reentregue, então não há segunda linha de custo` (INV-54) |
| **E3-13** | Estado do número e reconexão com alerta (CAN-03) | E3-01 | `dado token expirado, quando o envio falha, então o canal muda de estado e o alerta diz exatamente isso` — não "erro ao enviar" |
| **E3-14** | Outbox pós-commit + worker `NOTIFY` (INV-40, ADR-007) | D-01 | `dado rollback da transação, então nenhum evento é publicado`. Payload restrito a `{tipo, id, versao}` |

⚠️ **Meta sempre mockada por contrato, com fixtures reais de webhook. Nunca chamar a API da Meta em
teste automatizado.**

### 5.4 EP-04 — Cadastro unificado de cliente (CTT-01…04)

| # | Tarefa | Dep. | Definição de pronto |
|---|---|---|---|
| **E4-01** | Contato com **múltiplos nomes** por fonte, um preferido (CTT-01) | D-08 | `dado o mesmo CNPJ chegando com grafia diferente de duas fontes, quando ingere, então há dois nomes e um preferido` |
| **E4-02** | **Múltiplos telefones**, um principal (CTT-02) | D-08, E2-15 | `dado telefone principal já usado por outro contato, quando cadastra, então entra como secundário` (INV-07/49) |
| **E4-03** | **Múltiplos documentos** com `seq`, um fiscal padrão (CTT-03) | D-08 | `dado contato com três CNPJs, quando escolhe o de faturamento, então o snapshot registra qual seq originou` (§5.3) |
| **E4-04** | **Múltiplos endereços** com `seq`, um de entrega padrão (CTT-04) | D-08 | `dado lojista com matriz e duas filiais, quando escolhe o endereço, então cada um é endereçável` |
| **E4-05** | Grupo econômico (§4.1) | D-08 | `dados matriz e filial com CNPJs distintos, quando agrupa, então são contatos separados e o RFV NÃO soma` |
| **E4-06** | Contato-lead na primeira mensagem (INV-12) | E3-06 | Coberto por E3-06 — registrado aqui porque **é EP-04 quem herda o problema** se ele estiver errado |
| **E4-07** | `conflito_identidade` visível + fila de deduplicação (esqueleto, §6.4) | E2-05 | `dadas duas chaves discordando, quando ingere, então mantém os dois contatos, mantém o vínculo mais antigo, aplica só os campos não conflitantes e registra o conflito` |
| **E4-08** | Mesclagem manual, **reversível**, agregado por agregado (§6.4.1, INV-11) | E4-07, D-10, D-12 | `dada mesclagem de contatos com conversa no mesmo canal, quando funde, então as duas conversas permanecem fisicamente e a UI apresenta thread único`. `dado desfazer, então o estado anterior volta` |
| **E4-09** | Carteira com histórico sem sobreposição **e sem lacuna** (INV-32/33/58) | D-10 | `dada transferência, quando executa, então fecha uma linha e abre outra na mesma transação`. `dada vendedora removida, então abre linha com usuario_id NULL`. `quem era o dono em março?` nunca devolve vazio |

### 5.5 Sequência sugerida — 8 semanas

| Semana | M (Meta) | I (Infra) | R + D | Épicos |
|---|---|---|---|---|
| **S0** | M-01…M-03, M-08, **abrir M-04** · M-09…M-12 | I-01, I-03, I-04 | D-00 (PoC de PK), R-01, R-03, R-07 | E1-07 (spec das telas de entrada) |
| **S1** | aguarda M-04 | I-05…I-09 | D-01…D-05, R-02, R-06 | E1-01, E1-02 |
| **S2** | aguarda M-04 | I-10 | D-06…D-10, R-08, R-09 | E1-03, E1-04, E2-01, E2-02 |
| **S3** | M-05 assim que M-04 sair | — | D-11, D-12 | E1-05, E2-03, E2-04, E2-15, E3-03…E3-05 |
| **S4** | M-06 | — | D-13, D-14 | E2-05, E2-06, E3-06…E3-08, E4-01…E4-05 |
| **S5** | **M-07 (App Review)** — exige E3-01 em hom | — | D-15 | **E3-01**, E3-02, E3-09…E3-12, E2-11 |
| **S6** | acompanhar M-07 | — | D-16 | E2-07, E2-08, E2-09, E2-10, E3-13, E3-14 |
| **S7** | piloto real (se M-05/M-07 saíram) | — | — | E2-12, E2-13, E2-14, E4-07…E4-09, E1-06, E1-08 |

### 5.6 Os varredores de schema (E1-08) — invariantes que testes de unidade não pegam

Cada um é um teste que **falha o CI**, não um checklist:

| Varredor | Falha quando |
|---|---|
| **Tenancy** | Tabela fora das seis exceções (§7.2) sem `tenant_id`, ou sem RLS `FORCE`, ou com policy sem `WITH CHECK` |
| **INV-02** | Qualquer schema Zod de borda contém `tenantId` |
| **INV-04** | FK para tabela com PK composta que não é composta, ou filho de particionada sem a chave de partição |
| **INV-60** | Índice único em tabela particionada que não contém a chave de partição |
| **INV-46** | Coluna com sufixo `_centavos` que não é `bigint` |
| **INV-48** | Existe algum tipo `enum` no banco |
| **Partições** | Falta partição para os próximos 3 meses em qualquer tabela particionada |
| **Watch path** (R-09) | App importa pacote que não está no watch path declarado |

⚠️ **Cada um destes existe porque a alternativa é "todo mundo lembra de checar" — e invariante
protegida por disciplina é invariante violada.**

---

## 6. Riscos da onda

| # | Risco | Probabilidade × impacto | Sinal antecipado | Mitigação |
|---|---|---|---|---|
| **1** | ⚠️ **Qualidade da base do ERP.** Nas telas do Tailor, **40% da base estava sem CPF/CNPJ** | Alta × Alto — sem documento, a chave forte de reconciliação (§6.2, nível 2) não existe e sobra o telefone, que é chave **média** e não casa automaticamente | M-11: rodar o perfilamento na cópia anonimizada **na S1**, não na S6 | (a) Ingerir tudo, casando o que dá; (b) o resto vira contato próprio com `conflito_identidade` e entra na fila de deduplicação — **nunca fusão por chave média**; (c) a tela de qualidade cadastral (RFV-08) nasce como número honesto, não como surpresa. ⚠️ Fundir errado é irreversível na prática: mistura histórico de compra e corrompe o RFV dos dois |
| **2** | **Volume da carga histórica** derruba a primária, ou não cabe na janela | Média × Alto | M-12 sem resposta até a S2 | Lotes de 1.000–5.000 com transação curta e `cursor_retomada`; worker com pool próprio e `statement_timeout`; execução **fora do horário comercial**; partições anuais de `venda` criadas antes do lote. ⚠️ Milhões de linhas em uma transação só é `WAL` estourado e lock prolongado |
| **3** | ⚠️ **Prazo da Meta.** M-04/M-05/M-07 são de terceiro, com reprovação possível | Alta × Alto | Qualquer etapa parada > 10 dias | Começar na S0; desenvolver 100% na WABA da Gera3 (M-08); documentação de M-04 conferida contra o cartão CNPJ **antes** de enviar; App Review agendado só quando o fluxo estiver em hom. **Plano B:** critério de saída nº 2 atendido com números da Gera3 e piloto real escorregando para a Onda 1 — sem escorregar mais nada |
| **4** | **PK composta `(tenant_id, id)`** se mostra hostil ao Drizzle e ao console | Média × Alto (se descoberto tarde) | PoC D-00 | Fechar na S0, com ADR. A alternativa (`id` PK + `UNIQUE(tenant_id, id)`) preserva as FKs compostas. ⚠️ Depois da migration `0012` a troca é reescrita de schema |
| **5** | **Volume real desconhecido** (decisão aberta nº 1) leva a partição mal dimensionada | Média × Médio | M-12 | Mensal para `mensagem` é o default seguro; anual para `venda`. Repartir depois é caro mas possível — **o que não é possível é não particionar desde o dia 1** |
| **6** | **Janela de reentrega de webhook da Meta** desconhecida (decisão aberta nº 15) define a retenção de `evento_externo` | Média × Médio | — | ⚠️ **Errar para o lado longo.** Retenção curta reabre o furo de custo em dobro (INV-54); longa é só storage barato. A linha-chave permanece mesmo com o `corpo` expurgado |
| **7** | **Regra do nono dígito por faixa de DDD** (decisão aberta nº 16) errada | Média × Alto | Duplicidade aparecendo na S4 | Tabela de faixas por DDD versionada em `packages/shared`, com suíte de casos. Errar produz duplicidade de cadastro (recuperável) ou **falha de bloqueio** (não recuperável) — daí a assimetria de INV-50 |
| **8** | **Escopo crescendo** — inbox "só um pouquinho" para demonstrar | Alta × Alto | Card de tela fora da §7 | §7 é a lista fechada. Demonstração da Onda 0 é feita com **API + logs + SQL**, não com tela |
| **9** | Instagram entra "de graça" porque a permissão foi pedida no mesmo App Review | Média × Médio | Card de Instagram no board | A permissão é pedida junto (economiza um ciclo de review); **a implementação é Onda 2 (EP-20)**. As tabelas já suportam — `perfil_instagram` existe e fica vazia |

---

## 7. O que **NÃO** entra na Onda 0

> Lista fechada. Card fora dela precisa de justificativa escrita e de um item removido em troca.

| Não entra | Onda | Por quê |
|---|---|---|
| **Inbox, conversa, janela na tela, protocolo, busca** (INB-01…11) | 1 | A onda entrega ingestão e envio pela **API**, não a tela de atendimento |
| Fila e "Assumir atendimento" (INB-09/10) | 1 | A tabela `atendimento` nasce completa e **vazia** |
| Painel de saúde do número e contadores (CAN-04/05) | 1 | Estado e reconexão (CAN-03) bastam para provar que o canal está em pé |
| Painel de sincronização com erros e reprocessamento (INT-08) | 1 | `operacao_ingestao` grava tudo; a **tela** é Onda 1 |
| Documentação pública da API (INT-06), webhooks de saída (INT-07), CSV (INT-09) | 1 | A API pública existe e é testada; a documentação navegável é produto |
| Atacado/Varejo, qualificação, campos personalizados, "está no telefone", opt-out na tela, comentários (CTT-05…08, CTT-10) | 1 | ⚠️ As **colunas e tabelas existem** desde a Onda 0 (`recebe_campanhas`, `consentimento_contato`, `lista_bloqueio`, `contato_canal`) porque o gateway de envio já revalida. A **superfície** é Onda 1 |
| Kanban, funis, carteirização na tela (CRM-01…09) | 2 | `carteira_atribuicao` existe e é escrita por caso de uso; kanban não |
| **RFV, matriz de 11 faixas, ciclo de vida** (RFV-01…06) | 2 | Depende da carga histórica, que **é** a Onda 0. `rfv_evento` nem tabela precisa ter agora |
| Pedido assistido (PED-01…16, EP-27) | 2 | ⚠️ **Exceção deliberada:** o **contrato** de leitura síncrona (E2-12) e escrita idempotente (E2-13) entra agora. A tela, o rascunho e a efetivação, não |
| Catálogo conversacional, link, rastreio (CAT-01…04) | 2 | As tabelas de produto existem porque a ingestão as preenche; o catálogo como produto, não |
| Copiloto, transcrição, resumo, agente autônomo (IA-*) | 2–3 | Nada de IA nesta onda |
| Campanhas, templates HSM, disparo, atribuição de receita (CMP-*) | 3 | ⚠️ **Menos** `lista_bloqueio` e `consentimento_contato`, que nascem agora por serem invariante de envio (INV-13/15/50) |
| App mobile (MOB-*) | 2 | `apps/app` existe como esqueleto e watch path. Sem tela |
| Instagram Direct (CAN-07…09) | 2–3 | Só a permissão no App Review e a tabela `perfil_instagram` vazia |
| Metas, ranking, BI, home executiva (GES-*, BI-*) | 2 | `usuario_identidade_externa` nasce agora **só** porque a ingestão a preenche |
| Design system completo, alta fidelidade, modo escuro | Paralelo | `packages/design-tokens/tokens.json` já existe (ADR-012). O console da Onda 0 tem **cinco telas**: login, recuperação, convite, onboarding (Meta + ERP) e lista de contatos em leitura |
| SSE no console | 1 | O **outbox e o `NOTIFY` existem** (E3-14) porque INV-40 é invariante de escrita. O consumo na tela é Onda 1 |
| Planos, limites e cadeado de upsell (PLT-06) | **2** | `plano` nasce na `0002` e o cadeado atravessa `GET /eu` desde a Onda 0 — a resposta já distingue *sem permissão* de *não contratado*. A **tela** de planos é Onda 2 |
| White-label e revenda (PLT-09/10) | 4 | `tenant.tenant_pai_id` nasce agora, vazio e sem policy |

⚠️ **A tentação real desta onda é construir o inbox "só para demonstrar".** Ele consome quatro
semanas, adianta a Onda 1 em nada (porque será refeito sobre a especificação de telas) e atrasa a
carga histórica — que é a dependência nº 1 de todo o valor analítico do produto.

---

## 8. Checklist de fechamento da Onda 0

- ☐ Meta: Business Verification aprovada · Tech Provider ativo · App Review submetido ou aprovado
- ☐ Três ambientes com credenciais **distintas em tudo** — Meta, ERP, IA, banco, storage
- ☐ Migrations `0001`…`0016` aplicadas nos três ambientes pelo **mesmo** runner
- ☐ Os oito varredores de schema verdes no CI
- ☐ Teste de RLS com dois tenants em **todo** repositório — incluindo contra a **réplica**
- ☐ Suíte de conformidade verde para **GeraCloud e API pública**, com os `skip` esperados
- ☐ Carga histórica completa, com retomada testada por `kill -9` no meio do lote
- ☐ `conexao_erp_cobertura` = `completa` nos três fluxos, e a reconciliação (INV-57) batendo 100%
- ☐ Três números conectados, recebendo e enviando, com custo gravado por mensagem
- ☐ Um CNPJ conferido linha a linha contra o ERP: nomes, telefones, documentos, endereços, vendas
- ☐ Nenhuma tabela nova fora das seis exceções sem `tenant_id`
- ☐ Decisões abertas nº 1 (volume) e nº 10 (PK composta) **fechadas**, com ADR
