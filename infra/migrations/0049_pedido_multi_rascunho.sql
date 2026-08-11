-- 0049_pedido_multi_rascunho.sql
--
-- Vários rascunhos por cliente (decisão de UX com o dono do produto): o cliente
-- pode ter N pedidos em rascunho ao mesmo tempo (ex.: "Reposição", "Natal"),
-- cada um nomeado; finaliza e envia um por um.
--
-- ⚠️ Solta a regra de "um rascunho por conversa" (0021) — agora o rascunho é
-- centrado no CLIENTE. Dropar índice é seguro no deploy aditivo (não perde dado;
-- a versão anterior continua funcionando sem a restrição).

ALTER TABLE pedido ADD COLUMN IF NOT EXISTS nome text;

DROP INDEX IF EXISTS pedido_rascunho_por_conversa;

-- "Os rascunhos deste cliente", leitura quente da tela de montagem.
CREATE INDEX IF NOT EXISTS pedido_rascunhos_por_contato
    ON pedido (tenant_id, contato_id, atualizado_em DESC)
    WHERE estado = 'rascunho' AND contato_id IS NOT NULL;

COMMENT ON COLUMN pedido.nome IS
    'Rótulo do rascunho (ex.: "Reposição"), para o cliente ter vários pedidos em '
    'aberto ao mesmo tempo. Ver rotas-pedido.ts / tela de montagem.';
