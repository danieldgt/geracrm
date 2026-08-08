---
name: geracrm-monorepo-deploy
description: >
  Estrutura do monorepo e caminho até produção no GeraCRM: pnpm + Turborepo com quatro apps
  (api, console Angular, app Expo, catálogo), packages/shared em TypeScript puro, deploy no Railway
  por watch path, migrations no pre-deploy, ambientes e versionamento. Usar ao criar app ou pacote,
  configurar build/CI, decidir onde um arquivo mora, ou ao investigar deploy que subiu incompleto.
---

# Monorepo e deploy

pnpm + Turborepo, no mesmo formato do drezz (ADR-006). Hospedagem no Railway (ADR-006).

## Estrutura

```
apps/
  api/          Fastify · contexts/ por capacidade de negócio
  console/      Angular 21+ · o console de operação
  app/          Expo · o app do vendedor
  catalogo/     renderizado no servidor · link público
packages/
  shared/       ⚠️ TypeScript PURO — tipos, Zod, constantes, regras puras
  conectores/   adaptadores de ERP
infra/
  migrations/   SQL numerado, à mão
docs/
  decisoes.md   ADRs
```

## ⚠️ `packages/shared` é TypeScript puro — sem exceção

É consumido por **Angular, Expo e API ao mesmo tempo**. Um `import` de React, de Angular ou de
qualquer runtime específico quebra dois dos três consumidores.

Pode entrar: tipos, schemas Zod, constantes, funções puras de domínio (cálculo de RFV, regras de
janela, validação de pedido mínimo).
Não pode entrar: componente, hook, `signal`, serviço, acesso a `window`, `fetch`, ou qualquer
dependência de framework.

**Por que isso é valioso:** a regra de negócio fica escrita uma vez e vale nos três lugares. É o
que sobrou de compartilhamento depois da decisão de ter dois front-ends (ADR-010), e é justamente
a parte que mais importa.

## Turborepo

Alvos padronizados em todos os apps: `build`, `dev`, `test`, `lint`, `typecheck`.
`build` depende de `^build`; `dev` não tem cache e é persistente.

O Angular CLI e o Expo entram como qualquer outro alvo — o Turbo orquestra, não substitui.

## Deploy por watch path — a armadilha herdada

Cada app tem seu próprio serviço e seu próprio watch path no Railway:

| Serviço | Reage a |
|---|---|
| `api` | `apps/api/**` + `packages/**` |
| `console` | `apps/console/**` + **`packages/shared/**`** |
| `app` (Expo) | `apps/app/**` + **`packages/shared/**`** |
| `catalogo` | `apps/catalogo/**` + `packages/shared/**` |

⚠️ **Esta é a armadilha que o drezz documentou e que custa caro:** se um front passa a importar
`packages/shared` e o watch path não inclui `packages/shared/**`, **o tipo muda na API e não muda
na tela**. O deploy fica verde, a API responde outra coisa, e ninguém entende por quê.

Regra: ao adicionar um import de `shared` num app, **confira o watch path no mesmo commit**.

## Migrations no pre-deploy

O runner aplica `infra/migrations/*.sql` como `preDeployCommand`. ⚠️ **Falhou, o deploy não
prossegue** e a versão anterior continua servindo.

Consequência que muda como se escreve migration: ela roda **com a versão anterior ainda atendendo
tráfego**. Portanto **toda migration é aditiva** — remover ou renomear coluna são dois ou três
deploys. Detalhes em `geracrm-dados-postgres`.

## Processos separados

Além dos quatro apps, dois processos com perfil de carga diferente:

| Processo | Por quê |
|---|---|
| **Gateway de webhooks** | A Meta exige resposta em milissegundos e reenvia se demorar. Não pode competir com consulta pesada |
| **Workers** | Disparo com throttling roda por horas; carga histórica processa milhões de linhas |

Ambos compartilham o código de `apps/api` — são pontos de entrada diferentes, não repositórios
diferentes.

## Ambientes

| Ambiente | Integrações |
|---|---|
| **Desenvolvimento** | Local, com dublês de Meta, ERP e IA |
| **Homologação** | Sandbox da Meta, ERP de teste, credenciais próprias |
| **Produção** | Real |

⚠️ **Credenciais de homologação e produção são distintas em tudo** — Meta, ERP, IA. Misturar é
disparar campanha de teste para cliente real.

## Versionamento

Mudou comportamento, sobe a versão do app. Ela é o que o rodapé mostra e o que o suporte pergunta.
⚠️ **Versão parada responde errado com cara de certa.** E o rótulo de ambiente ("dev", "hom") nunca
aparece em produção.

## CI

`pnpm lint typecheck test` verdes antes de merge. ⚠️ Não commitar em `main` sem os checks.

O CI usa **o mesmo runner de migrations** que sobe produção — assim o caminho é exercitado a cada
PR, em vez de só falhar no deploy.

## Onde um arquivo mora

| O quê | Onde |
|---|---|
| Tipo ou schema usado por mais de um app | `packages/shared` |
| Regra de negócio pura (cálculo, validação) | `packages/shared` |
| Regra que precisa de banco ou rede | `apps/api/src/contexts/<contexto>` |
| Adaptador de ERP | `packages/conectores/<erp>` |
| Componente de UI do console | `apps/console/src/app/compartilhado` |
| Componente de UI do app | `apps/app` |
| Design token | pacote próprio, consumido por console e app |

⚠️ **Na dúvida entre `shared` e o app: comece no app.** Subir depois é fácil; descer é quebra em
cascata.

## Depuração de deploy

| Sintoma | Causa provável |
|---|---|
| Deploy verde, tela desatualizada | ⚠️ Watch path sem `packages/shared/**` |
| Deploy falhou no pre-deploy | Migration com erro — a versão anterior continua servindo (correto) |
| API espera coluna que não existe | Migration não subiu, ou não é aditiva |
| Funciona em hom e não em prod | Credencial ou variável de ambiente divergente |
| Build lento sem motivo | Cache do Turbo invalidado por arquivo que muda sempre |
