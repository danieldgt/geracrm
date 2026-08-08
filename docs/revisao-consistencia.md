# Revisão de consistência cruzada — GeraCRM

> Revisão adversarial de **11 documentos** (`modelo-de-dados`, `contrato-api`,
> `especificacao-telas-entrada`, `cenarios-bdd`, `plano-onda-0`, `direcao-visual` contra
> `escopo-funcional`, `especificacao-telas`, `decisoes`, `stack-arquitetura`, `backlog-epicos`),
> mais `arquitetura-visual`, `identidade-visual`, `prontidao-para-inicio` e o estado real do
> repositório.
>
> **Este documento só lista problemas.** O que está consistente não aparece — e é a maior parte:
> 60 invariantes com dono, 60 com cenário BDD marcado, 27 épicos e 194 IDs de requisito sem
> referência quebrada (varredura automática), `tenant_id` fora de parâmetro em toda a superfície,
> dinheiro em centavos sem divergência, e o par particionamento × unicidade conferido tabela a tabela.
>
> **Como ler a gravidade:**
>
> | Nível | Significado |
> |---|---|
> | 🔴 **Bloqueante** | Duas fontes de verdade em conflito, ou lacuna que **para** uma entrega já planejada da Onda 0/1. Resolver antes de escrever a linha correspondente |
> | 🟠 **Alta** | Um artefato promete o que outro não sustenta. Não trava hoje; vira retrabalho ou migration na Onda 1–2 |
> | 🟡 **Média** | Documento desatualizado, contagem errada, regra sem dono declarado. Custa confiança e tempo de leitura |
> | ⚪ **Baixa** | Referência solta, exemplo divergente, item cosmético |

---

## Sumário

| # | Achado | Gravidade | Documento que muda |
|---|---|---|---|
| **B-01** | Redis: `stack-arquitetura` mantém o componente que o ADR-007 eliminou | 🔴 | `stack-arquitetura.md` |
| **B-02** | Onboarding do tenant não existe em modelo, API nem migrations | 🔴 | `modelo-de-dados.md`, `contrato-api.md`, `plano-onda-0.md` |
| **B-03** | Painel de Pedido oferece "tentar novamente" no timeout — contradiz INV-53 | 🔴 | `especificacao-telas.md` |
| **B-04** | Kanban de Relacionamento promete arrastar coluna derivada | 🔴 | `especificacao-telas.md` |
| **A-01** | PLT-06 é Onda 2 no escopo e Onda 4 no backlog e no plano | 🟠 | `backlog-epicos-geracrm.md`, `plano-onda-0.md` |
| **A-02** | Protocolo tem três formatos incompatíveis | 🟠 | `cenarios-bdd.md`, `direcao-visual.md`/`identidade-visual.md` |
| **A-03** | Perfil, sessões, 2FA e cobrança: tela sem endpoint e sem coluna | 🟠 | `contrato-api.md`, `modelo-de-dados.md` |
| **A-04** | Configuração e reparo de número: tela sem endpoint e sem coluna | 🟠 | `contrato-api.md`, `modelo-de-dados.md` |
| **A-05** | "Rascunho exportável" prometido em 4 documentos, sem endpoint | 🟠 | `contrato-api.md` |
| **A-06** | Exigências técnicas 13–26 não têm resposta arquitetural | 🟠 | `stack-arquitetura.md` |
| **A-07** | "GeraCloud" hard-coded onde o ADR-008 exige ERP genérico | 🟠 | `escopo-funcional-geracrm.md`, `especificacao-telas.md` |
| **M-01** | `prontidao-para-inicio` descreve um estado que não existe mais | 🟡 | `prontidao-para-inicio.md` |
| **M-02** | `plano-onda-0` lista como tarefa dois artefatos já entregues | 🟡 | `plano-onda-0.md` |
| **M-03** | ADR-012 fora de ordem e contagem de ADRs errada | 🟡 | `decisoes.md`, `prontidao-para-inicio.md`, `CLAUDE.md` |
| **M-04** | `direcao-visual` declara o ADR-012 provisório; o resto o trata como fechado | 🟡 | `direcao-visual.md` **ou** `decisoes.md` |
| **M-05** | "Janela de 24h" × "janela de atendimento" — linguagem ubíqua quebrada | 🟡 | `cenarios-bdd.md` §0.2 e os demais |
| **M-06** | Catálogo de erros da API incompleto e sem o código de CNPJ duplicado | 🟡 | `contrato-api.md` |
| **M-07** | "Quem está só olhando não responde" é regra sem invariante e sem erro | 🟡 | `modelo-de-dados.md`, `contrato-api.md` |
| **M-08** | INB-14, INB-17 e presença sem lugar no modelo | 🟡 | `modelo-de-dados.md` |
| **M-09** | Backlog diz "vinte e um épicos" com 22 linhas e 27 no total | 🟡 | `backlog-epicos-geracrm.md` |
| **M-10** | PLT-11 é Onda 2 no escopo e entregável da Onda 1 no backlog | 🟡 | `backlog-epicos-geracrm.md` |
| **M-11** | PLT-05 entra na Onda 0 pelo plano, sem estar no escopo da onda | 🟡 | `plano-onda-0.md` ou `escopo-funcional-geracrm.md` |
| **L-01** | `FDV-04` não existe | ⚪ | `escopo-funcional-geracrm.md` |
| **L-02** | Referência a "ADR-012 §9", que não existe | ⚪ | `especificacao-telas-entrada.md` |
| **L-03** | Mapa de documentos omite `identidade-visual` | ⚪ | `arquitetura-visual.md` |
| **L-04** | `?desdeVersao=` usado na §6.5 e ausente da §5.2 | ⚪ | `contrato-api.md` |
| **L-05** | CTT-09 (Pessoas) tem modelo e API, mas nenhuma região de tela | ⚪ | `especificacao-telas.md` |
| **L-06** | `GET /negocios/contagem` promete `exato: true` sem fonte declarada | ⚪ | `contrato-api.md` ou `modelo-de-dados.md` |

---

## 🔴 Bloqueantes

### B-01 — Redis: o componente que o ADR-007 eliminou continua na arquitetura

| Onde | O que diz |
|---|---|
| `decisoes.md` ADR-007 (título) | "Push server→client: SSE + LISTEN/NOTIFY + outbox, **sem Redis e sem broker**" · "throttling por número em tabela com `UPDATE` atômico; presence por heartbeat com TTL lógico" · "Infraestrutura fica em Postgres + S3 + Railway" |
| `aproveitamento-drezz.md` §4.2 | "❌ **Eu errei: Redis**" · "**Sem Redis nas Ondas 0–2**" |
| `modelo-de-dados.md` §2.5, §3.6, §8.3 | Throttling e quota em **tabelas** (`numero_throttle`, `numero_conversa_iniciada`, `numero_quota_hora`) |
| `stack-arquitetura.md` §3 (diagrama), §4, §5 (título da escolha), §5.6, §9.1, §11, §13 | **Redis** como cache/fila/presence · "SSE sobre HTTP/2 + **Redis Pub/Sub**" · presence "gravado no Redis com TTL" · "Redis com contador por chave `numero:{N}:dia:{D}`" |

**A inconsistência.** O `stack-arquitetura.md` é anterior ao ADR-007 e nunca foi reconciliado. Não é
divergência de estilo: ele descreve **três mecanismos concretos** (fan-out, throttling, presence) sobre
uma infraestrutura que a decisão fechada removeu. Pior, o contador que ele propõe —
`numero:{N}:dia:{D}` — é exatamente a modelagem que o modelo de dados condena por escrito na §2.5
("chave `dia` (calendário)… dava para enviar o limite inteiro às 23h e de novo às 00h05").

⚠️ **O dano concreto não é o Redis, é a presença.** Ao remover o Redis, o único lugar onde a presence
estava especificada some — e ela não foi remodelada em lugar nenhum:

| Artefato | Presença (INB-18) |
|---|---|
| `contrato-api.md` §5.2 | `POST /conversas/{id}/presenca` — "Heartbeat de presença (TTL lógico)" ✅ existe |
| `contrato-api.md` §6.4 | evento `presenca.alterada` ✅ existe |
| `modelo-de-dados.md` §8 | ❌ **nenhuma tabela**. Não há `conversa_presenca`, e "TTL lógico" no Postgres exige coluna `expira_em` + varredura |
| `especificacao-telas.md` §1.5 | "Eduarda está nesta conversa" — tela depende disso |

**O que muda:** `stack-arquitetura.md`. Reescrever §4 (linha "Cache / fila / presence"), §5 (título e
§5.6), §9.1, §11 e §13 para Postgres + outbox + `LISTEN/NOTIFY`, apontando para
`modelo-de-dados.md` §2.5/§3.6. E **`modelo-de-dados.md` §8.3 ganha a tabela de presença** — hoje é a
única exigência de tela (INB-18, Onda 2) cujo mecanismo desapareceu junto com o componente.

---

### B-02 — O onboarding do tenant não existe em modelo, API nem migrations

`especificacao-telas-entrada.md` abre com: *"⚠️ A tela mais importante deste documento é a §3
(onboarding do tenant). Se falhar ali, não existe operação"*. E `plano-onda-0.md` §7 lista o onboarding
como **uma das cinco telas do console na Onda 0**.

O que a §3 exige, e onde isso mora:

| Exigência da tela | Documento que a declara | Onde ela mora |
|---|---|---|
| **Progresso do assistente por passo, no servidor, retomável** (⚠️ "estado em `localStorage` é o erro clássico aqui") | telas-entrada §3.1 + exigência **13** | ❌ Nenhuma entidade em `modelo-de-dados` §1.2; nenhuma coluna em `tenant`; nenhuma tabela nas migrations **D-01…D-16** |
| **Conclusão do Embedded Signup confirmada por polling no nosso servidor** | telas-entrada §3.3 + exigência **14** | ⚠️ Existe `POST /canais/whatsapp/signup` (conclui), mas **não existe o `GET` de estado** que a tela consulta em loop |
| **Verificar método de pagamento na Meta ("Verificar de novo")** | telas-entrada §3.4 e §6 + exigência **15** | ⚠️ `numero_whatsapp.pagamento_ok` existe; **nenhum endpoint** dispara a reconsulta |
| **Aceite registrado do passo ⑤** ("existe a data em que o admin foi informado") | telas-entrada §3.6 | ❌ Nem tabela, nem campo, nem endpoint |
| **Banner de configuração pendente com o passo que falta nomeado** | telas-entrada §3.1 | ❌ Depende do estado acima; `GET /v1/eu` não devolve nada de onboarding |

⚠️ **Por que é bloqueante e não "detalhe de implementação".** A migration `0003_tenant.sql` é a
terceira da onda (semana S1 do plano) e é onde a coluna/tabela nasceria. Descobrir na semana 5 —
quando E3-01 (Embedded Signup) roda — que o estado do onboarding precisa de tabela significa uma
migration aditiva no meio da onda **e** um endpoint fora do contrato já congelado. É barato agora,
caro em três semanas.

**O que muda:** três documentos, na ordem:
1. `modelo-de-dados.md` §1.2 (`identidade`) e §8.1 — entidade `OnboardingDoTenant` (ou
   `tenant_onboarding_passo`), com passo, estado, `concluido_em`, `aceite_capacidades_em`.
2. `contrato-api.md` §5.1 — `GET /v1/onboarding`, `POST /v1/onboarding/passos/{passo}/concluir`,
   `POST /v1/canais/{id}/pagamento/verificar`.
3. `plano-onda-0.md` §4 — a tabela entra em `0003` ou numa `0004b`, **antes** de E3-01.

---

### B-03 — O Painel de Pedido oferece "tentar novamente" no timeout

| Onde | O que diz |
|---|---|
| `especificacao-telas.md` §2.4 | \| Erro de comunicação \| "GeraCloud não respondeu" \| **Tentar novamente** — com idempotência garantida (PED-07), reenviar não duplica \| |
| `contrato-api.md` §4.4 | `pedido.erp_timeout` (`504`) → **"Botão na tela: ⚠️ Não existe"** · exige `POST /pedidos/{id}/reconciliacao` antes de qualquer retentativa |
| `modelo-de-dados.md` INV-53 | "Depois de **timeout** (resposta perdida), a retentativa só ocorre após **reconciliação por consulta ao ERP**" |
| `cenarios-bdd.md` §8 @INV-53 | Dois cenários: reconciliação automática, ou `aguardando conferência` com confirmação humana |

**A inconsistência.** A tela colapsa em uma linha ("erro de comunicação") os dois casos que o contrato
separa deliberadamente — `502` (a chamada não chegou; retentar é seguro) e `504` (a resposta se
perdeu; **o pedido pode existir no ERP**). Implementar a tela como está escrita produz exatamente o
bug que INV-29/INV-53 existem para impedir: **pedido duplicado no ERP do cliente**.

Além disso, o diagrama de estados da §2.4 é `rascunho → validando → enviando → EFETIVADO / falhou` —
falta o estado **`aguardando_conferencia`**, que o modelo declara em `pedido.estado` e que tem tela
própria (`POST /pedidos/{id}/conferencia`).

**O que muda:** `especificacao-telas.md` §2.4 — separar as duas linhas na tabela de erros, remover o
botão no caso de timeout, acrescentar `aguardando_conferencia` ao diagrama e a ação "confirmar no ERP".

---

### B-04 — O Kanban de Relacionamento promete arrastar uma coluna derivada

| Onde | O que diz |
|---|---|
| `especificacao-telas.md` §4 | "Dois kanbans com **a mesma mecânica**"; §4.2: "**Arrastar entre colunas** dispara automação da etapa (CRM-10), com desfazer por 5s" |
| `modelo-de-dados.md` §1.2 | ⚠️ "**O Funil de Relacionamento (CRM-02) não tem posição gravada.** Suas colunas — Lead · 1 pedido · 2 pedidos · 3+ pedidos — são **derivadas do contador de vendas**" |
| `contrato-api.md` §5.5 | `GET /contatos-relacionamento` — "⚠️ Rota separada de propósito: as colunas são derivadas de `qtd_vendas`, **não etapas gravadas**". Só `GET`. `POST /negocios/{id}/etapa` existe apenas para o funil de leads |

**A inconsistência.** Arrastar um card de "1 pedido" para "3+ pedidos" é uma operação **sem
significado**: o destino é uma função da quantidade de vendas ingeridas do ERP. A tela promete uma
interação que o modelo torna impossível e que a API corretamente não oferece. Se a promessa ficar,
alguém implementa gravando posição — que é a "segunda verdade" que o modelo diz estar evitando, e ela
diverge no primeiro pedido importado em lote.

**O que muda:** `especificacao-telas.md` §4 — declarar as duas mecânicas separadamente:
o **Funil de Leads** arrasta; o **Funil de Relacionamento** é leitura, com as duas únicas ações que
existem (`Representantes` e `Descartados`, que são **flags do Contato**, não etapas).

---

## 🟠 Alta

### A-01 — PLT-06 é Onda 2 no escopo e Onda 4 no backlog e no plano

| Documento | Onda de PLT-06 (planos, limites, cadeado de upsell) |
|---|---|
| `escopo-funcional-geracrm.md` §3 | **2** |
| `especificacao-telas-entrada.md` §8 | **2** ("Épico: EP-26 · Funcionalidade: PLT-06 · Onda: 2") |
| `backlog-epicos-geracrm.md` §2 | EP-26 está na tabela de **"épicos exclusivos da Onda 4"**, com PLT-06 dentro |
| `plano-onda-0.md` §7 | "White-label, planos, revenda (**PLT-06**/09/10) \| **4**" |

⚠️ **Não é detalhe de calendário.** O cadeado de upsell (`plano.limite_excedido`, `403`) já está no
contrato de API, a tabela `plano` nasce na migration `0002`, e `especificacao-telas-entrada.md` §8.1
declara que **"a mesma resposta da API precisa distinguir sem permissão de não contratado"** — o que
significa que PLT-06 atravessa o `GET /v1/eu` desde a Onda 0. Ou o backlog separa PLT-06 (Onda 2) de
PLT-09/10 (Onda 4), ou o escopo desce PLT-06 para a Onda 4 e a tela de planos sai da Onda 2.

**O que muda:** `backlog-epicos-geracrm.md` §2 (partir EP-26) e `plano-onda-0.md` §7.

---

### A-02 — Protocolo tem três formatos incompatíveis

| Onde | Formato |
|---|---|
| `modelo-de-dados.md` §1.3, §8.3 | `Protocolo` = "inteiro sequencial por tenant"; coluna `protocolo bigint`; `contador_por_tenant` com `UPDATE … RETURNING` |
| `cenarios-bdd.md` §6 | `"2026-04-000318"` → `"2026-04-000319"` — **ano-mês + sequência**, e a sequência reinicia por mês |
| `direcao-visual.md` §4.3 e `identidade-visual.md` §4 | `#72372.2` — numérico com sufixo decimal |

**A inconsistência.** `bigint` não representa `2026-04-000318`, e uma sequência que reinicia por mês
quebra `UNIQUE(tenant_id, protocolo)` no ano seguinte. O `#72372.2` do documento visual é herança do
Tailor (aparece no `inventario-funcionalidades-referencia`) e não é decisão nossa.

⚠️ **É a chave natural de busca do inbox** (INB-07, MOB-03) e ela aparece em três telas. Escolher
depois obriga a reescrever o histórico ou a conviver com dois formatos.

**O que muda:** decidir o formato no `modelo-de-dados.md` (a proposta natural é `bigint` sequencial e
**formatação só na apresentação**), e corrigir os exemplos de `cenarios-bdd.md` §6 e dos dois documentos
visuais.

---

### A-03 — Perfil, sessões, 2FA e cobrança: tela especificada, endpoint e coluna inexistentes

`especificacao-telas-entrada.md` §5, §7 e §8 são Onda 0–2 e especificam blocos que nenhum outro
artefato sustenta:

| Bloco de tela | Onde está especificado | Endpoint no `contrato-api` | Coluna/tabela no `modelo-de-dados` |
|---|---|---|---|
| **Notificações por evento × canal** (app/push/e-mail, som) | §7 | ❌ | ❌ (só `notificacao` e `dispositivo_push`) |
| **Aparência** (claro/escuro/sistema), ⚠️ "preferência do usuário, **no servidor**" | §7, ADR-012 | ❌ | ❌ |
| **Escopo ativo (filial/número) persistido por usuário** | §4 + exigência **23** | ❌ | ❌ |
| **Dispositivos e sessões**, com "encerrar" e "encerrar todas as outras" | §7; §5.2 "Desativar **encerra sessões**" | ❌ | ❌ |
| **Configurar/resetar 2FA** (QR, chave manual, códigos de recuperação, contador "3 de 10") | §1.3, §1.4, §5.2 | ⚠️ só `POST /v1/auth/mfa` (conclui desafio) | — (Cognito) |
| **Foto e assinatura da atendente** | §7 | ❌ | ❌ (`usuario` tem só `nome`, `email`, `ativo`) |
| **Faturas e forma de pagamento** | §8 | ❌ (`GET /plano` devolve só limites × uso) | ❌ |
| **Estado do usuário** `🔒 bloqueada por tentativas` e selo `2FA ✓/✗` | §5.1 | ❌ | ❌ |

⚠️ **A exigência 23 é a que mais dói**, porque é explicitamente *"a única forma de o app e o console
concordarem"* — e não tem onde ser gravada. O `modelo-de-dados.md` §10 fecha com
"☑ Toda funcionalidade de **Onda 1–2** tem onde morar"; este bloco desmente o checklist.

**O que muda:** `modelo-de-dados.md` §8.1 (`usuario_preferencia`, `usuario_sessao` ou decisão explícita
de delegar sessão ao Cognito) e `contrato-api.md` §5.1 (`/eu/preferencias`, `/eu/sessoes`, `/eu/2fa`,
`/usuarios/{id}/2fa/resetar`, `/plano/faturas`).

---

### A-04 — Configuração e reparo de número: tela especificada, endpoint e coluna inexistentes

`especificacao-telas-entrada.md` §6.3 (Onda 0 para frota, Onda 1 para saúde):

| Ação da tela | Endpoint | Coluna |
|---|---|---|
| **Reconectar** ("reabre o Embedded Signup só na etapa necessária") | ❌ | — |
| **Remover da frota** ("187 conversas deixarão de receber mensagem") | ❌ (`/canais/{id}` só `GET` e `PATCH`) | — |
| **Verificar pagamento de novo** | ❌ | `pagamento_ok` ✅ |
| **Retomar disparo** (número pausado por qualidade) | ❌ | ❌ (não há `disparo_pausado`) |
| **Horário de atendimento · mensagem de ausência · assinatura da atendente** | ❌ | ❌ (`canal_conectado` tem `nome_amigavel`, `estado`, `capacidades`) |

⚠️ Três destes são **ações de reparo**: são o motivo de a tela existir ("dizer quais números podem
enviar agora — e, quando não podem, o que fazer"). Uma tela de monitoramento sem as ações de reparo é
um relatório.

**O que muda:** `contrato-api.md` §5.2 e `modelo-de-dados.md` §8.3.

---

### A-05 — "Rascunho exportável" é prometido em quatro documentos e não tem endpoint

| Onde | O que promete |
|---|---|
| `decisoes.md` ADR-008 | "ERP sem escrita de pedido transforma o tira-pedidos em **rascunho exportável**" |
| `contrato-api.md` §8.8 | `escritaPedido` ausente ⇒ "Tira-pedidos vira **rascunho exportável**" |
| `especificacao-telas-entrada.md` §3.6 | "o tira-pedidos vira rascunho exportável; o lançamento é manual" |
| `cenarios-bdd.md` §11 | "Então nenhuma efetivação é oferecida / **E é oferecido exportar o pedido**" |
| `contrato-api.md` §5.4 | ❌ Não existe rota de exportação. Há `GET /pedidos/{id}/resumo`, que é **texto para colar na conversa**, não arquivo para lançar no ERP |

⚠️ É o **contrato de degradação do ADR-008 no caso mais severo** — o ERP que não recebe pedido. Sem a
rota, "degrada em vez de quebrar" vira "quebra com uma frase bonita".

**O que muda:** `contrato-api.md` §5.4 — `POST /pedidos/{id}/exportacoes` (`202` + job + URL assinada,
igual a `/analitico/exportacoes`), ou declarar explicitamente que `/resumo` **é** a exportação e
corrigir os outros três textos.

---

### A-06 — As exigências técnicas 13–26 não têm resposta arquitetural

`especificacao-telas.md` §8 lista 12 exigências e `stack-arquitetura.md` §13 responde às 12, uma a uma
— o ciclo fecha. `especificacao-telas-entrada.md` §9 acrescenta as exigências **13 a 26**
("continuação direta da §8") e **nenhuma delas foi respondida**: a §13 da stack continua parando no 12.

Sete das catorze pedem mecanismo que não existe em lugar nenhum:

| # | Exigência | Situação |
|---|---|---|
| 13, 14 | Estado de onboarding no servidor; conclusão confirmada via Graph API | ver **B-02** |
| 17 | Capacidades por conexão com **texto de consequência versionado** ("a frase *o saldo terá horário* é conteúdo do domínio, não string de front") | ❌ Sem lugar: `conexao_erp.capacidades jsonb` guarda o booleano, não o texto |
| 20 | "O que eu posso" distinguindo **sem permissão** × **não contratado** × **capacidade ausente** | ⚠️ Parcial: `GET /v1/eu` cobre os três, mas nada declara que a resposta os separa |
| 23 | Escopo ativo no servidor | ver **A-03** |
| 24 | Limites do plano avaliados **no servidor** | ⚠️ `GET /plano` existe; a contagem de uso não tem fonte declarada |
| 25 | Segredos write-only, mascarados na leitura | ✅ coberto (INV-41, `contrato-api` §5.8) |

**O que muda:** `stack-arquitetura.md` §13 — estender a tabela até 26. É o documento cuja regra de
abertura é *"escolha sem exigência apontada é preferência disfarçada"*; o inverso também vale:
**exigência sem escolha apontada é lacuna disfarçada**.

---

### A-07 — "GeraCloud" hard-coded onde o ADR-008 exige ERP genérico

| Onde | Texto |
|---|---|
| `escopo-funcional-geracrm.md` §1.2 | "a **efetivação acontece no GeraCloud**" · "O pedido efetivado, o estoque e o fiscal são **do GeraCloud**" |
| `escopo-funcional-geracrm.md` PED-07 | "**Envio ao GeraCloud** para efetivação" |
| `especificacao-telas.md` §2.1, §2.2, §2.4 | Botão `[ Enviar ao GeraCloud ]` · "GeraCloud não respondeu" |
| `decisoes.md` ADR-005/ADR-008 | "a efetivação é **do ERP**" · "modelo canônico nosso; **portas definidas pelo domínio, nunca pela API do fornecedor**" |
| `contrato-api.md` §9.1 | "Existe **teste que varre os nomes de método** da interface e falha se aparecer nome de fornecedor" |

**A inconsistência.** O escopo e a spec de telas são anteriores ao ADR-008 (multi-ERP) e ficaram com o
ERP da casa no texto do produto. Um botão que diz "Enviar ao GeraCloud" para um cliente de Bling é bug
visível; e o exemplo de erro `pedido.erp_indisponivel` do contrato já usa `detalhe.origem` justamente
para a tela nomear o ERP certo.

**O que muda:** `especificacao-telas.md` §2 (botão e mensagens passam a usar o **nome da conexão
ativa**) e uma nota em `escopo-funcional-geracrm.md` §1.2/§14 registrando que GeraCloud é o **primeiro**
conector, não o único — a "regra de ouro" da §4 já diz isso, mas as duas seções a contradizem.

---

## 🟡 Média

### M-01 — `prontidao-para-inicio.md` descreve um estado que não existe mais

| O que o documento afirma | Realidade |
|---|---|
| §2.1 "Modelo de dados — a etapa 3 **nunca foi executada**" | `modelo-de-dados.md`, 1.605 linhas, 60 invariantes |
| §2.2 "Telas de entrada **não foram especificadas**" | `especificacao-telas-entrada.md`, 965 linhas |
| §2.3 "Design visual **não existe**" · "pergunta em aberto: identidade própria?" | ADR-012 + `identidade-visual.md` + `direcao-visual.md` + `packages/design-tokens/tokens.json` |
| §2.4 "Contrato de API **não definido**" | `contrato-api.md`, 1.140 linhas |
| §2.5 "Cenários BDD **não escritos**" | `cenarios-bdd.md`, 1.493 linhas |
| §3.3 "**Não existe** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, nem nenhuma das quatro apps" | Existem, com `apps/{api,console,app,catalogo}`, `packages/{shared,conectores,design-tokens}` e `infra/migrations` |
| §6 "Modelo de domínio, design e telas de entrada: **não existem**" | Todos existem |

⚠️ Ele é citado como fonte por `contrato-api`, `plano-onda-0`, `direcao-visual` e `modelo-de-dados`.
Documento de estado desatualizado **mente com autoridade** — a mesma regra que
`arquitetura-visual.md` aplica aos diagramas.

**O que muda:** `prontidao-para-inicio.md` §1, §2, §3.3 e §6 — as cinco lacunas fecham e o que sobra é
**infraestrutura provisionada** e **registro na Meta**, que continuam válidos e continuam sendo o
caminho crítico.

---

### M-02 — `plano-onda-0.md` lista como tarefa dois artefatos já entregues

| Tarefa | Texto | Estado real |
|---|---|---|
| **R-06** | "Contrato de API — lacuna 2.4 de `prontidao-para-inicio`… ⚠️ Escrever **antes** da primeira rota" | `contrato-api.md` entregue |
| **E1-07** | "⚠️ Especificação das telas de entrada — lacuna 2.2… **É pré-requisito de E1-05 e E3-01**" | `especificacao-telas-entrada.md` entregue |

Também: §3 abre com "Estado atual: … as pastas com `README.md` já existem. Falta o conteúdo" — correto —
mas a sequência da §5.5 ainda aloca E1-07 na semana S0 e R-06 na S1, ocupando duas semanas de
capacidade que já não existem.

**O que muda:** `plano-onda-0.md` §5.1/§3.1 (marcar como concluídas) e §5.5 (recuperar as semanas).

---

### M-03 — ADR-012 fora de ordem e contagem de ADRs errada

| Sintoma | Onde |
|---|---|
| ADR-012 aparece **antes** de ADR-011 no arquivo | `decisoes.md` linhas 187 e 216 |
| "✅ **11 ADRs**" | `prontidao-para-inicio.md` §1 |
| "`docs/decisoes.md` — **11 ADRs** (decisões fechadas, NÃO reabra)" | `CLAUDE.md` (instruções do projeto) |
| ADRs existentes | **12** (ADR-001…ADR-012) |

⚠️ O risco real não é a contagem: é a instrução de projeto dizer "11 ADRs" e o ADR-012 (identidade
visual) ser justamente o mais novo. Um agente que confie na contagem para saber se leu tudo para no 11.

**O que muda:** `decisoes.md` (reordenar), `prontidao-para-inicio.md` e `CLAUDE.md` (12 ADRs).

---

### M-04 — `direcao-visual.md` declara o ADR-012 provisório; o resto do repositório o trata como fechado

| Onde | O que diz |
|---|---|
| `direcao-visual.md` cabeçalho | "⚠️ **Este documento não decide nada.** … Enquanto §8 não for respondida, **ADR-012 deve ser lido como proposta em vigor, não como decisão do dono**" |
| `decisoes.md` ADR-012 | Escrito como decisão fechada, sem marcador de provisoriedade |
| `CLAUDE.md` | "DECISÕES JÁ FECHADAS (respeite, não reabra)" |
| `plano-onda-0.md` §7 | "`packages/design-tokens/tokens.json` **já existe** (ADR-012)" |
| `identidade-visual.md` | "Decisão registrada no ADR-012" |

O `direcao-visual.md` está sendo honesto — e é exatamente por isso que a contradição precisa ser
resolvida num lado só. Hoje um leitor tem duas respostas para "a identidade está decidida?".

⚠️ As paletas **não divergem** (conferidas hex a hex: `#3F6FBE`, `#0FB5AE`, `#E8A317`, `#E5484D`,
`#2E9E5B`, `#7C5CD6`, `#0D1830`) — o conflito é só de **status**, o que o torna barato de resolver.

**O que muda:** ou `decisoes.md` ganha "⚠️ ratificação pendente das 6 perguntas da §8 de
`direcao-visual.md`", ou o dono responde a §8 e `direcao-visual.md` perde o cabeçalho. Enquanto os
dois convivem, ninguém sabe se pode escrever componente.

---

### M-05 — "Janela de 24h" × "janela de atendimento": linguagem ubíqua quebrada

O `modelo-de-dados.md` §1.3 renomeia o conceito **de propósito**:

> **JanelaDeAtendimento** … ⚠️ Antes chamado `JanelaDe24h`: a duração e a política de reabertura são
> **propriedade declarada do canal**, lidas de `canal_conectado.capacidades` — não constante no código.

E INV-18 diz "duração **declarada pelo canal**". Mas:

| Documento | Termo |
|---|---|
| `cenarios-bdd.md` §0.2 (glossário — "os termos do cenário são os termos do código") | "**Janela de atendimento** \| **As 24 h** contadas da última mensagem do cliente" — a constante volta pela porta do glossário |
| `escopo-funcional` INB-04, `backlog` EP-05, `especificacao-telas` §1.3, `identidade-visual` §5, `direcao-visual` §3.2/§7.4 | "janela de **24h**" / "anel de janela de **24h**" |
| `contrato-api` §5.2 | `{ aberta, expiraEm, duracaoH, reabrePor }` ✅ correto |

⚠️ O próprio BDD tem o cenário *"a duração vem do canal, não de constante do produto"* (§5) — que
**contradiz o glossário do mesmo arquivo** três páginas antes.

**O que muda:** `cenarios-bdd.md` §0.2 (a definição vira "a janela declarada pelo canal — 24 h no
WhatsApp e no Instagram hoje") e, com menos urgência, o vocabulário dos documentos de produto e visual.

---

### M-06 — Catálogo de erros da API incompleto, e falta o código de CNPJ duplicado

**(a) Códigos usados na §5 e ausentes do catálogo da §4.3:**
`crm.motivo_de_perda_obrigatorio` · `crm.registro_obrigatorio` · `integracao.papel_fiscal_ja_definido` ·
`integracao.fonte_de_venda_ja_definida`. A §4.3 abre dizendo que **todo** código existe porque uma tela
precisa distinguir aquele caso — então ela deveria ser a lista completa, e o leitor a usa como tal.

**(b) Código que falta de verdade.** `cenarios-bdd.md` §1 (@INV-03) exige:

> Então o cadastro é **recusado por duplicidade** / E a **ficha existente é oferecida para edição**

Oferecer a ficha existente exige `detalhe: { contatoId }`. Não há código para isso —
`contato.telefone_principal_em_uso` cobre telefone, `contato.conflito_de_identidade` cobre discordância
entre chaves, e o modelo tem `UNIQUE(tenant_id, tipo, digitos)` em `contato_documento`. Sem
`contato.documento_em_uso` (`409`), a tela cai no genérico e o cenário BDD não passa.

**O que muda:** `contrato-api.md` §4.3.

---

### M-07 — "Quem está só olhando não responde" é regra sem invariante e sem código de erro

`cenarios-bdd.md` §6 encerra com uma `Regra:` sem tag `@INV`:

> Cenário: atendente sem assumir não consegue enviar → o envio é bloqueado / é oferecida a assunção

| Artefato | Cobertura |
|---|---|
| `modelo-de-dados.md` | ❌ INV-51 garante **um** atendimento aberto; **nada** garante que só o dono envia |
| `contrato-api.md` §5.2 | ❌ `POST /conversas/{id}/mensagens` não lista erro para isso |
| `especificacao-telas.md` §7 | ✅ "Visualizando da fila. Assuma para responder" — a tela depende da regra |

⚠️ É o padrão que o próprio modelo condena: regra de negócio cujo dono, na prática, é o front-end
("esperança com CSS", nas palavras de INV-51). Com fila em modo *pull* e API pública no mesmo produto,
o bloqueio precisa estar no caso de uso de envio.

**O que muda:** `modelo-de-dados.md` §2.4 (invariante nova) e `contrato-api.md` §4.3
(`atendimento.nao_assumido`, `409`, com `detalhe { atendimentoId, atendenteId }`).

---

### M-08 — INB-14, INB-17 e presença sem lugar no modelo

`modelo-de-dados.md` §10 fecha com "☑ Toda funcionalidade de **Onda 1–2** tem onde morar". Três
exceções:

| Requisito | Onda | Situação |
|---|---|---|
| **INB-14** — notas internas **na conversa** e menção a colega | 2 | `comentario` é **do contato** (CTT-10), não da conversa; menção não existe em lugar nenhum. Sem endpoint |
| **INB-17** — reply/quote, encaminhar, **reagir** | 2 | Reply cabe em `mensagem.conteudo jsonb`; **reação** não tem onde morar (é N:1 por usuário sobre a mensagem) |
| **INB-18** — presença / aviso de colisão | 2 | Endpoint e evento existem; **armazenamento não** (ver **B-01**) |

**O que muda:** `modelo-de-dados.md` §1.2/§8.3, ou o checklist §10 passa a listar as exceções
conscientes com a onda em que entram.

---

### M-09 — Backlog diz "vinte e um épicos" com 22 linhas e 27 no total

`backlog-epicos-geracrm.md` §2: *"**Vinte e um épicos.**"* — a tabela seguinte tem **22 linhas**
(EP-01…EP-19 + EP-27 + EP-20 + EP-21), e a segunda tabela acrescenta EP-22…EP-26. Total: **27**, que é
o número usado por `CLAUDE.md` e por `prontidao-para-inicio.md`.

⚠️ A causa é visível no arquivo: **EP-27 foi inserido entre EP-19 e EP-20** (quando o tira-pedidos
virou épico próprio) e a contagem não foi refeita. Nenhuma referência a EP-xx está quebrada — o
problema é só a frase e a ordem.

**O que muda:** `backlog-epicos-geracrm.md` §2.

---

### M-10 — PLT-11 é Onda 2 no escopo e entregável da Onda 1 no backlog

| Documento | PLT-11 (suporte embutido / base de conhecimento) |
|---|---|
| `escopo-funcional-geracrm.md` §3 | Onda **2** |
| `backlog-epicos-geracrm.md` §2 | EP-07 = PLT-05, PLT-07, **PLT-11**, Onda **1** |
| `backlog-epicos-geracrm.md` §3 (Onda 1) | "EP-07 \| Log de auditoria · notificações e push · **central de ajuda**" |

O backlog declara que a coluna Onda indica onde o épico **começa** — o que resolve INT-06…09 e
CAN-04/05, mas não este caso: "central de ajuda" está listada como **entregável da Onda 1**.

**O que muda:** `backlog-epicos-geracrm.md` §3 (mover para Onda 2) ou o escopo.

---

### M-11 — PLT-05 entra na Onda 0 pelo plano, sem estar no escopo da onda

`escopo-funcional-geracrm.md` §19: Onda 0 = **PLT-01…04**. `plano-onda-0.md` §5.1 tem cabeçalho
"EP-01 — Fundação da plataforma e tenancy (**PLT-01…04**)" e, dentro dele, **E1-06 — Auditoria (PLT-05,
esqueleto)**.

A justificativa é boa (acesso cross-tenant do staff precisa de auditoria desde o dia 1, §2.2 do próprio
plano), mas ela contradiz a §7 do plano, que é declarada **lista fechada** — e PLT-05 não aparece nem
como exceção deliberada, ao contrário de PED (E2-12/E2-13), que está lá com o ⚠️ explicando por quê.

**O que muda:** `plano-onda-0.md` §5.1/§7 (registrar como exceção deliberada, no mesmo formato do
pedido) ou `escopo-funcional-geracrm.md` §19 (PLT-05 sobe para a Onda 0).

---

## ⚪ Baixa

| # | Achado | Onde | O que muda |
|---|---|---|---|
| **L-01** | `FDV-04` é citado ("CAT-01, **FDV-04** e RFV-01 passam a ser configuráveis por perfil") e **não existe** na tabela FDV (que tem 01, 02, 03, 06, 07, 11). Único ID quebrado em 194 verificados | `escopo-funcional-geracrm.md` §20.4 | `escopo-funcional-geracrm.md` |
| **L-02** | O layout do login remete a "(ADR-012 §9)" para justificar o painel de marca sem ilustração. O ADR-012 não tem seções; o conteúdo está em `identidade-visual.md` §9 ("O que decidimos NÃO fazer") | `especificacao-telas-entrada.md` §1.1 | `especificacao-telas-entrada.md` |
| **L-03** | O mapa de documentos lista `direcao-visual` mas **não** `identidade-visual`, que é o que ADR-012 declara como detalhamento normativo | `arquitetura-visual.md` §11 | `arquitetura-visual.md` |
| **L-04** | `GET /v1/conversas?desdeVersao=…` é usado na reconexão SSE e **não** está entre os filtros declarados do endpoint | `contrato-api.md` §6.5 × §5.2 | `contrato-api.md` §5.2 |
| **L-05** | CTT-09 (Pessoas) tem entidade, agregado próprio, cardinalidade N:N e endpoints — e **nenhuma região** na Ficha do Cliente, nem no web nem no mobile | `especificacao-telas.md` §3 | `especificacao-telas.md` §3 |
| **L-06** | `GET /negocios/contagem` devolve `exato: true` para uma coluna de 11.358 cards, mas a §3.2 diz que contador exato "só vem de contador denormalizado ou view materializada" — e não há nenhum dos dois para `negocio_funil` | `contrato-api.md` §3.2 × `modelo-de-dados.md` §8.7 | `contrato-api.md` (usar teto) ou `modelo-de-dados.md` (MV de contagem por etapa) |

---

## Verificações que passaram (para não serem refeitas)

Registro do que foi checado com ferramenta e **não** produziu achado — para a próxima revisão não
gastar o tempo de novo:

| Verificação | Método | Resultado |
|---|---|---|
| IDs de requisito (`PLT-`, `INT-`, `CAN-`, `INB-`, `CTT-`, `CRM-`, `RFV-`, `TSK-`, `CMP-`, `IA-`, `CAT-`, `PED-`, `FDV-`, `GES-`, `BI-`, `MOB-`) | Varredura de todos os `.md` contra os 194 IDs definidos no escopo | **1 quebrado** (L-01) |
| Referências `EP-xx` | Varredura contra os 27 definidos no backlog | **0 quebradas** |
| Referências `INV-xx` | Varredura contra as 60 definidas no modelo | **0 quebradas**, **0 buracos** na sequência INV-01…INV-60 |
| Cobertura BDD das invariantes | Tags `@INV-xx` presentes em `cenarios-bdd.md` | **60 de 60** — o mapa da §14 confere com o corpo |
| Paletas de `identidade-visual` × `direcao-visual` | Comparação hex a hex | **Idênticas** |
| Erros `pedido.*` do PED-08 | Contagem contra "os 11 códigos" citados na §5.4 | **11**, confere |
| Estrutura do monorepo × `plano-onda-0` §3 | `ls` do repositório | **Confere** (a divergência é com `prontidao`, M-01) |

---

## Veredito

**O planejamento não está pronto para começar a implementação de ponta a ponta — mas está pronto para
começar hoje nas frentes que importam.** A distinção é operacional, não retórica:

### Pode começar agora, sem risco de retrabalho

| Frente | Por quê |
|---|---|
| **M — Registro na Meta** (`plano-onda-0` §1) | Não depende de nenhum achado desta revisão. ⚠️ Continua sendo o **único prazo que não controlamos**, e o plano está certo ao dizer que deveria ter começado ontem |
| **I — Infraestrutura** (§2) | Cognito, Railway, Postgres + réplica, S3, Sentry. Nenhum achado toca aqui. ⚠️ Com **uma** correção antes de I-03: a lista de serviços não inclui Redis, e o `stack-arquitetura` ainda o pede (B-01) |
| **R — Monorepo** (§3) | Esqueleto já existe; as tarefas R-01…R-10 são independentes dos achados. R-06 já está feita (M-02) |
| **D — Migrations D-01…D-10** | `0001` a `0010` (base, catálogos globais, tenant, organização, usuário, integração, identidades externas, contato, satélites, carteira) não são tocadas por nenhum 🔴. **B-02 entra em `0003` ou logo depois** — decidir antes de aplicar `0003`, não depois |

### Precisa de decisão antes de virar código

| # | Bloqueio | Quem decide | Custo se ficar aberto |
|---|---|---|---|
| **B-01** | Presence sem mecanismo, depois da saída do Redis | Time (é reconciliação de documento, não decisão nova) | INB-18 chega na Onda 2 sem onde morar |
| **B-02** | Onde vive o estado do onboarding | Time | Migration aditiva no meio da onda + endpoint fora do contrato |
| **B-03**, **B-04** | Duas telas descrevem comportamento que o modelo proíbe | Time | **B-03 duplica pedido no ERP do cliente**; B-04 cria a segunda verdade que o modelo evita |
| **A-01** | PLT-06 é Onda 2 ou Onda 4 | Dono do produto | Muda o conteúdo do `GET /v1/eu` e da tela de planos |
| **A-02** | Formato do protocolo | Dono do produto | Chave natural de busca em 3 telas; trocar depois reescreve histórico |
| **A-03**, **A-04**, **A-05** | Endpoints e colunas que as telas de entrada exigem | Time | As telas de Onda 0 (login, convite, **onboarding**) não são implementáveis como especificadas |

### O que sobra, e é o essencial

As **quatro decisões abertas de verdade** continuam sendo as que o modelo e a stack já nomearam, e
nenhuma delas apareceu nesta revisão como nova: volume real do primeiro cliente (nº 1 do modelo, nº 5
da stack, **M-12** do plano), PK composta `(tenant_id, id)` (nº 10, com PoC D-00 na S0), janela de
atribuição estimada (nº 4) e ordem dos próximos conectores (nº 13). Todas com dono e com data.

⚠️ **O achado mais importante desta revisão não é nenhum item individual — é o padrão.** Os quatro
🔴 e cinco dos sete 🟠 têm a mesma forma: **uma tela promete um comportamento que o modelo torna
impossível ou que a API não oferece**. É o mesmo padrão que produziu a contradição original do projeto
("o pedido vive no ERP" convivendo com "montar pedido no app") e que o ADR-005 fechou. A causa é
mecânica e conhecida: `especificacao-telas.md` é anterior ao modelo, ao contrato e ao ADR-008, e
`especificacao-telas-entrada.md` é **posterior** ao modelo e ao contrato — as duas direções produziram
o mesmo desencontro.

**A correção estrutural, e ela cabe em uma linha de processo:** a especificação de telas e o contrato
de API precisam fechar o ciclo como `especificacao-telas.md` §8 e `stack-arquitetura.md` §13 fecham
hoje — **toda região de tela aponta um endpoint, e todo endpoint aponta uma região de tela**. Enquanto
esse ciclo não fecha, achados como A-03 e A-04 vão aparecer um a um, dentro de cada sprint, no pior
momento possível: com a tela já em implementação.

**Recomendação:** liberar M, I, R e D-01…D-10 imediatamente; reservar **dois dias** para fechar
B-01…B-04 e A-03…A-05 (são reconciliações de documento, não decisões de produto); levar **A-01 e A-02**
ao dono junto com as seis perguntas da §8 de `direcao-visual.md`, que estão paradas pelo mesmo motivo.
Os 🟡 e ⚪ são meia hora de edição e podem ir junto do primeiro PR de documentação.

---

## Correções aplicadas — 07/08/2026

Os **quatro bloqueantes** foram corrigidos na mesma sessão em que a revisão foi produzida.

| # | O que mudou |
|---|---|
| **B-01** | `stack-arquitetura.md` reconciliado com o ADR-007: Redis removido do diagrama §3, da tabela §4, da §5.6 (presence), §9.1 (throttling), §11 (custo) e §13 (exigências 1 e 12). O contador por `dia` de calendário — que o modelo condena por escrito — foi substituído pela remissão a `modelo-de-dados.md` §2.5. E a lacuna real que o achado expôs foi fechada: **`conversa_presenca` entrou em `modelo-de-dados.md` §8.3**, com `expira_em` e a advertência de que o vencimento é lógico — leitura sempre filtra por tempo, varredura só limpa |
| **B-02** | Onboarding do tenant ganhou as três pernas: **`onboarding_passo`** em `modelo-de-dados.md` §8.1 · **`GET /onboarding`**, `POST /onboarding/passos/{passo}/concluir`, `POST /onboarding/aceite-capacidades`, `GET /canais/whatsapp/signup/estado` e `POST /canais/{id}/pagamento/verificar` em `contrato-api.md` §5.1/§5.2 · **migration `D-03b`** em `plano-onda-0.md`, posicionada **antes de E3-01** |
| **B-03** | `especificacao-telas.md` §2.4 separa agora `502` (não chegou — retentar é seguro) de `504` (resposta perdida — **o pedido pode existir no ERP**). O botão "tentar novamente" saiu do caso de timeout, e `aguardando_conferencia` entrou no diagrama de estados |
| **B-04** | `especificacao-telas.md` §4 passa a distinguir os dois kanbans: o **Funil de Leads arrasta** (a etapa é decisão humana), o **Funil de Relacionamento não arrasta entre colunas de contagem** (elas são derivadas de `qtd_vendas`). Ninguém move um cliente para "3 pedidos" — ele compra pela terceira vez |

### O padrão vale ser registrado

A revisão observou que **9 dos 11 itens graves têm a mesma forma**: *uma tela promete o que o modelo
torna impossível ou a API não oferece*. É a mesma classe de contradição que o ADR-005 fechou quando
"o pedido vive no ERP" convivia com "montar pedido no app".

⚠️ **A correção estrutural não é revisar mais — é fechar o ciclo.** `especificacao-telas.md` §8 e
`stack-arquitetura.md` §13 já fazem isso: toda exigência de tela aponta para a resposta técnica, e
toda resposta técnica aponta para a exigência que a originou. Onde esse ciclo existe, a contradição
não sobrevive à escrita. Onde não existe, ela só aparece numa revisão como esta — ou em produção.

**Pendentes:** as 7 altas, 11 médias e 6 baixas seguem abertas e estão listadas acima, cada uma com
o documento que deveria mudar.

## Correções aplicadas — altas (08/08/2026)

| # | O que mudou |
|---|---|
| **A-01** | **EP-26 partido em dois.** `PLT-06` (planos, limites, cadeado) fica na **Onda 2** — o cadeado atravessa `GET /eu` desde a Onda 0 e a tabela `plano` nasce na `0002`. `PLT-09/10` (white-label, revenda) viram **EP-28**, Onda 4. Corrigidos `backlog-epicos` §2/§18/§4 e `plano-onda-0` §7. De quebra, a contagem de épicos passou de "vinte e um" para 28 (M-09) |
| **A-02** | **Formato do protocolo decidido:** `bigint` sequencial por tenant, **nunca reinicia**; apresentação zero-padded a 6 com prefixo (`#000318`), **só na camada de exibição**; busca aceita com ou sem `#` e com ou sem zeros. Descartados `2026-04-000318` (reinício mensal quebra `UNIQUE(tenant_id, protocolo)` no ano seguinte) e `#72372.2` (herança visual do Tailor). Exemplos corrigidos em `cenarios-bdd`, `identidade-visual` e `direcao-visual` |
| **A-03** | Entraram `usuario_preferencia` (aparência, notificações, assinatura e **`escopo_ativo`** — exigência 23), `usuario_sessao` e `usuario_perfil` no modelo §8.1; e `/eu/preferencias`, `/eu/sessoes`, `/eu/2fa`, `/usuarios/{id}/2fa/resetar`, `/eu/foto` e `/plano/faturas` no contrato §5.1 |
| **A-04** | Entrou `canal_configuracao` (horário, ausência, assinatura, **`disparo_pausado`**) no modelo §8.3; e `/canais/{id}/configuracao`, `/reconectar`, `/disparo/retomar` e `DELETE /canais/{id}` no contrato §5.2. ⚠️ Sem `disparo_pausado` não havia onde registrar a pausa automática por queda de qualidade (CAN-06) |
| **A-05** | `POST /pedidos/{id}/exportacoes` — `202` + job + URL assinada. Distinto de `/resumo`, que é texto para a conversa. É o contrato de degradação do ADR-008 no caso mais severo |
| **A-06** | `stack-arquitetura.md` §13 estendida de 12 para **26 exigências** |
| **A-07** | O ERP deixou de ser nomeado literalmente na interface: botão vira `Enviar pedido`, mensagens usam **o nome da conexão ativa** via `detalhe.origem`. Corrigidos `especificacao-telas` §2 e `escopo-funcional` §1.2/PED-07/INT-01c |

### Duas observações que sobreviveram às correções

⚠️ **A-06 revelou uma assimetria no processo.** `stack-arquitetura.md` abre com *"escolha sem
exigência apontada é preferência disfarçada"* — mas o inverso não estava escrito. **Exigência sem
escolha apontada é lacuna disfarçada**, e foi assim que 14 exigências ficaram sem resposta: a §8 da
primeira spec de telas estava mapeada, a §9 da segunda não. A regra inversa agora está no documento.

⚠️ **A-03 desmentiu um checklist.** O `modelo-de-dados.md` §10 fechava com "☑ Toda funcionalidade de
Onda 1–2 tem onde morar". Não tinha — faltavam preferências, sessões e perfil. Checklist que se
autoavalia é a forma mais convincente de esconder lacuna.

**Estado:** 4 bloqueantes e 7 altas corrigidos. Seguem abertas **11 médias e 6 baixas**, listadas
acima, cada uma com o documento que deveria mudar.
