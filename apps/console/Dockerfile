# syntax=docker/dockerfile:1
#
# Imagem do console (apps/console) para o Railway: build Angular no monorepo,
# servido por nginx como SPA. Contexto de build = RAIZ do repo (o console
# depende de @geracrm/design-tokens, um pacote do workspace).

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# ⚠️ `...` = console + suas dependências de workspace (design-tokens gera o
#    tokens.css que o Angular referencia). Sem isso o build não resolve o CSS.
RUN pnpm --filter @geracrm/console... build

# ---- runtime: nginx servindo o SPA ----
FROM nginx:alpine AS runtime
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/console/dist/browser /usr/share/nginx/html
EXPOSE 8080
