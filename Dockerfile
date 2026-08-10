# syntax=docker/dockerfile:1
#
# Imagem da API (apps/api) para o Railway.
# ⚠️ Monorepo pnpm+Turborepo: a API depende de @geracrm/shared e
#    @geracrm/conectores (compilados). O build instala o workspace inteiro e
#    compila só a subárvore da API (`--filter @geracrm/api...`, que arrasta as
#    dependências). O runtime herda os node_modules do workspace (symlinks pnpm),
#    então @geracrm/shared resolve para packages/shared/dist em runtime.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---- build: instala tudo e compila shared + conectores + api ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @geracrm/api... build

# ---- runtime: imagem única; o papel (api|integrador) é escolhido no start ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
# ⚠️ O entrypoint ramifica por SERVICE_ROLE: 'api' roda migrate→bootstrap→seed→
#    servidor (idempotente; ADR-006 ideal é preDeploy, aqui start p/ dogfooding);
#    'integrador' roda o worker GeraCloud. Mesma imagem provada para os dois.
CMD ["sh", "/app/apps/api/docker-start.sh"]
