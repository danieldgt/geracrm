-- 0032_canal_ultimo_erro.sql
--
-- ⚠️ Correção: `canal_conectado` nunca teve `ultimo_erro`, mas o endpoint
--    `GET /v1/canais` a seleciona — a tela "Meus Números" respondia 500. A
--    coluna existe em `conexao_erp` (0006); faltava a análoga no canal.
--
-- Aditiva (NULL = sem erro registrado). O fluxo de teste do canal pode gravar
-- aqui o motivo da última falha, como a conexão de ERP já faz.

ALTER TABLE canal_conectado ADD COLUMN IF NOT EXISTS ultimo_erro text;

COMMENT ON COLUMN canal_conectado.ultimo_erro IS
    'Texto livre do último erro do canal (NULL = sem erro). A tela mostra quando '
    'o estado é desconectado. Análogo a conexao_erp.ultimo_erro.';
