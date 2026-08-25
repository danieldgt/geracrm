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
    # ⚠️ O MIGRATE SAIU DAQUI (ADR-006). Ele roda no preDeployCommand do Railway,
    #    com a versão ANTERIOR ainda atendendo — confirmado nos deploy logs:
    #    "[pre-deploy] migrate -> bootstrap -> seed" antes do start.
    #
    #    Migrar no START é migrar com a versão nova JÁ recebendo tráfego: a
    #    janela entre subir o processo e terminar o DDL é atendida por código que
    #    espera um schema que ainda não existe. E com duas instâncias, as duas
    #    migram ao mesmo tempo.
    #
    #    O bootstrap do papel e o seed continuam aqui de propósito: são
    #    idempotentes, não alteram schema e garantem o ambiente de dogfooding
    #    mesmo em start manual (railway run, container local).
    node dist/db/bootstrap-app-role.js
    node dist/db/seed-dogfooding.js
    exec node dist/server.js
    ;;
esac
