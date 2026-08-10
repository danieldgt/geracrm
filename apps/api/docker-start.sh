#!/bin/sh
# Entrypoint único da imagem — o PAPEL do serviço decide o que roda.
# ⚠️ Um Dockerfile só, dois serviços (api e integrador): a diferença é a env
#    SERVICE_ROLE. Assim front/back/worker compartilham a MESMA imagem provada.
set -e
cd /app/apps/api

case "${SERVICE_ROLE:-api}" in
  integrador)
    echo "[start] papel: integrador (worker GeraCloud)"
    exec node dist/workers/integrador.js
    ;;
  *)
    echo "[start] papel: api"
    # ⚠️ Idempotente e nesta ordem: migrate cria o grupo geracrm_app; o bootstrap
    #    cria o papel de app que herda dele; o seed garante tenant+canal.
    node dist/db/migrate.js
    node dist/db/bootstrap-app-role.js
    node dist/db/seed-dogfooding.js
    exec node dist/server.js
    ;;
esac
