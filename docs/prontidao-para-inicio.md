# Prontidão para início

> Estado em 08/08/2026. Substitui a versão de 07/08, que descrevia um estado anterior ao
> planejamento (achado M-01 da revisão de consistência).

---

## 1. Resposta curta

| | |
|---|---|
| **Onda 0** | ✅ **Planejamento completo.** O que falta é execução — e o item mais urgente não depende de código |
| **Ondas 1–4** | ⚠️ Backlog definido (*o quê*), plano de execução ausente (*como e em que ordem*) |
| **Lacunas fora do backlog** | 🔴 Três, e nenhuma estava mapeada — §4 |

⚠️ **O caminho crítico continua sendo o registro na Meta**, e ele não avançou nenhum dia desde que
foi identificado. Business Verification → Tech Provider Program → App Review leva semanas, não
depende de nós e bloqueia a Onda 1 inteira.

---

## 2. O que está pronto

| Artefato | Cobertura |
|---|---|
| `estudo-crms-whatsapp` · `inventario-funcionalidades-referencia` · `concorrentes-tailor` | Descoberta e mercado |
| `escopo-funcional-geracrm` | ~150 funcionalidades, 15 módulos, 5 ondas |
| `backlog-epicos-geracrm` | 28 épicos, backlog por onda, integração Meta e Instagram |
| `modelo-de-dados` | 64 entidades, 60 invariantes com dono, 22 agregados, tabelas e índices |
| `contrato-api` | Rotas por contexto, cursor, erros tipificados, SSE, ingestão pública, porta de conector |
| `especificacao-telas` | 7 telas de operação, com os cinco estados e as transições |
| `especificacao-telas-entrada` | Login, convite, equipe, frota, planos e onboarding do tenant |
| `cenarios-bdd` | Ondas 0–1 completas; 60/60 invariantes com cenário |
| `plano-onda-0` | Caminho crítico, infra, esqueleto, migrations `0001`–`0010`, tarefas por épico |
| `stack-arquitetura` · `decisoes` · `arquitetura-visual` | Stack, 12 ADRs, 11 diagramas |
| `identidade-visual` + `tokens.json` | Paleta, tipografia, elemento assinatura, temas claro e escuro |
| `.claude/skills` | 35 skills: regras de código, metodologia e stack |

---

## 3. O que falta para começar a Onda 0 — tudo é execução

| # | Item | Depende de | Prazo |
|---|---|---|---|
| **1** 🔴 | **Registro na Meta** — Business Verification, Tech Provider Program, App Review | **Meta** | Semanas. **Começar hoje** |
| **2** | Provisionar Cognito, Railway (API + Postgres + réplica), bucket, Sentry, três ambientes | Nós | Dias |
| **3** | Esqueleto do monorepo — `package.json` de cada app, configuração de build e CI | Nós | Horas |
| **4** | Documentação da API do GeraCloud, credenciais e ambiente de teste | Time do ERP | Dias |
| **5** | Definir **volume real do primeiro cliente** — números, mensagens/dia, contatos, anos de histórico | Cliente | Levantar junto com a carga |

⚠️ **Nada aqui é planejamento.** O item 1 deveria estar correndo em paralelo desde a semana passada.

---

## 4. 🔴 As três lacunas que ninguém mapeou

Não estavam no backlog nem na revisão de consistência — não são "itens pendentes", são **assuntos
ausentes**.

### 4.1 Como o primeiro cliente entra

O planejamento inteiro descreve **o produto**, e nenhum documento descreve **a transição**. O
cliente hoje opera em algum lugar — Tailor, planilha, WhatsApp puro. Perguntas sem dono:

- Quem carrega os anos de histórico, e como se **concilia** o que veio com o que o ERP diz?
- O que acontece com as conversas em andamento no dia da virada?
- Há período de **convivência** com a ferramenta antiga, ou corte seco?
- Quem treina as vendedoras, e em quê — o produto muda a rotina delas, não só a tela?
- Qual é o critério para dizer que a migração **falhou** e voltar atrás?

⚠️ Isto define requisitos da **Onda 0**: a carga histórica precisa de relatório de conciliação, não
só de importação. Descobrir isso na semana da virada é tarde.

### 4.2 Como o time trabalha

`CLAUDE.md` diz "não commitar em `main` sem os checks verdes" — e é tudo. Não existe: definição de
pronto, política de branch, quem revisa, o que exige revisão, como uma tarefa entra e sai, o que
acontece quando a suíte quebra em `main`.

⚠️ Com agentes de IA no fluxo (`workflow-agentes-programacao`), a ausência de "definição de pronto"
é mais cara: o agente entrega o que **parece** pronto, e sem critério escrito ninguém discorda.

### 4.3 Como saber se funcionou

Há critério de saída **técnico** por onda ("a equipe operou 2 semanas sem o sistema antigo"). Não há
métrica de **produto**: o que precisa acontecer com o negócio do cliente para a onda ter valido.

⚠️ Isto define o que instrumentar **desde a Onda 0**. Métrica decidida depois é métrica sem
histórico — e o produto que promete provar ROI não pode ser o único sem linha de base.

---

## 5. Lacunas conhecidas, com data para resolver

| Lacuna | Quando planejar | Por que não agora |
|---|---|---|
| Plano de execução das **Ondas 1–4** | Macro agora, detalhe ao entrar em cada uma | Detalhar a Onda 3 hoje é planejar o que vai mudar |
| **Cenários BDD** das Ondas 2–4 | Ao entrar em cada onda | Idem |
| **Telas** de campanha, IA, catálogo, metas, Visão de Mercado, SLA, capacitação | Ao entrar em cada onda | Idem |
| **Biblioteca de componentes** | **Antes da Onda 1** | O front começa na Onda 1; token sem componente não constrói tela |
| **Runbook de operação** | Antes do go-live | Precisa da operação real para ser útil |
| **LGPD formal** — política, termos, DPA com provedores | Antes do primeiro cliente real | Depende de jurídico |
| **Precificação concreta** | Antes de vender | Decisão comercial; a recomendação (por número de WhatsApp) está em `concorrentes-tailor` §9 |
| 11 médias e 6 baixas da revisão de consistência | Contínuo | Nenhuma bloqueia a Onda 0 |

---

## 6. Ordem recomendada

```
HOJE, em paralelo:
  ① Registro na Meta ...................... não depende de nós — começar já
  ② Provisionar infra ..................... dias
  ③ Esqueleto do monorepo ................. horas
  ④ Planejar as três lacunas da §4 ........ define requisitos da Onda 0

DEPOIS:
  ⑤ Biblioteca de componentes ............. antes da Onda 1
  ⑥ Migrations 0001–0010 .................. o plano já as descreve
  ⑦ Conector GeraCloud + carga histórica .. o coração da Onda 0
```

⚠️ **O item ④ não é burocracia.** A conciliação da carga histórica (§4.1) e as métricas de linha de
base (§4.3) **mudam o que a Onda 0 precisa entregar**. Planejar depois significa reabrir a onda.
