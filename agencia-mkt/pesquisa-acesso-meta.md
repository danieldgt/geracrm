# O padrão "App do cliente" serve para a Marketing API?

> Pesquisa feita em 2026-08-20 para responder a pergunta nº 0 de
> [`perguntas-em-aberto.md`](perguntas-em-aberto.md) — a que bifurca o roteiro inteiro.
>
> ⚠️ **Fonte: documentação oficial da Meta.** Não foi testado contra a API com credencial real. A
> prova definitiva é criar um App e chamar — o que é barato e deveria ser feito antes de decidir em
> definitivo.

## A resposta curta: sim

A Meta exige App Review **só para gerenciar conta de anúncio de terceiros**. O App criado pelo
próprio cliente, lendo a conta de anúncio **dele**, funciona sem revisão.

Nas palavras da documentação de autorização da Marketing API:

> *"If your app is only managing your ad account, standard access to the `ads_read` and
> `ads_management` permissions are sufficient. If your app is managing other people's ad accounts,
> you need advanced access."*

É **exatamente o mesmo padrão** já aceito para o canal de WhatsApp: o cliente cria o Business
Portfolio, faz a própria verificação de negócio, cria o App, e o `META_APP_SECRET` vem dele
(`../docs/onboarding-meta.md`).

## O limite de taxa — a preocupação que não se confirmou

O tier sem revisão é descrito como "de desenvolvimento", o que soa proibitivo. O número real não é:

> **5.000 chamadas por hora**, mais 40 por público personalizado ativo.

⚠️ Nosso caso de uso é **uma sincronização diária por conta**: ler estrutura (dezenas de chamadas)
e métricas do período (dezenas). Folga de duas ordens de grandeza. O limite só apertaria com
sincronização de minuto em minuto ou com muitas contas **sob o mesmo App** — que é justamente o
cenário que o modelo "App do cliente" evita, porque cada cliente traz o seu.

## O que ISSO custa mesmo assim

O preço não é técnico, é de operação — e é o **mesmo** que o canal de WhatsApp já paga:

| Custo | Detalhe |
|---|---|
| **Onboarding manual por cliente** | Cada um cria Business Portfolio, App, System User e token |
| ⚠️ **Verificação de negócio do cliente** | Dias a semanas, e **não depende de nós** |
| **1 System User** no tier sem revisão (vs. 10) | Suficiente para uma conta; aperta se o cliente tiver muitas |
| **Não escala** | É o atrito que o Embedded Signup existe para remover — e ele exige o nosso Tech Provider |

⚠️ **A terminologia da Meta mudou em maio/2026** ("Standard Access" e "Advanced Access" foram
aposentados no contexto da Marketing API), e as fontes secundárias ainda misturam os nomes antigos.
Os *mecanismos* descritos acima batem entre a documentação oficial e as fontes; os **rótulos** podem
estar desatualizados em qualquer texto sobre o assunto, inclusive neste.

## O que isso reabre

| Decisão | Estado |
|---|---|
| **AMK-012** — deferimento da Meta | ⚠️ **Para reexame.** A premissa ("sem App Review não dá para servir cliente") caiu |
| **AMK-015** — Google primeiro | ⚠️ **Para reexame.** O argumento era o mesmo |
| **CTWA volta a ser possível** | Com ele, o `ctwa_clid` — que chega no protocolo e **não pode ser apagado pelo lead**, ao contrário do nosso código na mensagem (AQ-45) |
| **AMK-014** | Fica mais folgada: tenant no canal oficial tem janela + template, não risco de ban |

## O que NÃO muda, decida-se o que decidir

- **AMK-013** (verba dinâmica) e **AMK-016** (`modo_entrada` configurável) independem de plataforma.
- **AQ-44** (LP com `wa.me`) continua valendo: serve ao Google, serve a tenant no não-oficial, e é
  um dos modos de AMK-016. ⚠️ Deixa de ser *a única* entrada e vira *uma* das entradas.
- **Tudo que já foi construído** (`implementacao.md`) é agnóstico de plataforma por desenho. A
  `CapacidadesPlataforma` já tem `cliqueParaConversa` — Meta entrando, vira `true`.

## Recomendação

**Fazer o teste barato antes de decidir**: criar um App de teste no Business Manager da Gera3,
gerar um System User token e chamar `GET /act_<id>/campaigns`. Uma tarde de trabalho responde com
certeza o que a documentação responde com alta probabilidade — e a decisão passa a se apoiar em
fato, não em leitura de doc.

⚠️ Se confirmar, minha leitura é que **a Meta deveria voltar como plataforma primária**: CTWA
resolve a atribuição de forma muito mais robusta que o código na mensagem, e o mesmo funil de
onboarding já serve ao canal de WhatsApp que vocês acabaram de construir.

## Fontes

- [Marketing API — Authorization](https://developers.facebook.com/docs/marketing-api/overview/authorization)
- [Marketing API — Rate Limiting](https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/)
- [Graph API — Rate Limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)
