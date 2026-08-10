#!/bin/sh
# Pre-deploy (ADR-006): a migração sobe ANTES do código novo, UMA vez, com a
# versão anterior ainda servindo. Por isso toda migration é ADITIVA — remover/
# renomear coluna são dois deploys. Se isto falhar, o Railway TRAVA o deploy:
# código novo não sobe sobre schema não-migrado.
set -e
cd /app/apps/api
echo "[pre-deploy] migrate -> bootstrap -> seed"
node dist/db/migrate.js
node dist/db/bootstrap-app-role.js
node dist/db/seed-dogfooding.js
echo "[pre-deploy] ok"
