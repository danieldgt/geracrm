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
# Template: o entrypoint do nginx:alpine roda envsubst (so nas variaveis definidas no ambiente, entao
# `$remote_addr` e afins ficam intactos) e grava /etc/nginx/conf.d/default.conf. PROXY_SEGREDO e o
# segredo compartilhado com a API (ver apps/console/README.md).
COPY apps/console/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/console/dist/browser /usr/share/nginx/html
EXPOSE 8080
# Sem PROXY_SEGREDO no Railway o envsubst deixaria o placeholder literal e o nginx nao subiria; o default
# vazio faz o nginx omitir o cabecalho (a API entao ignora o IP e usa o do nginx).
ENV PROXY_SEGREDO=""
