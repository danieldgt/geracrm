-- 0122_oportunidade_ganho_perda.sql
--
-- Raia B2 (modais do funil). ADITIVA: só colunas novas NULL e uma FK composta; a versão anterior
-- da API segue atendendo durante a migration.
--
-- `pedido_id`: pedido existente do contato vinculado ao ganhar o negócio (POST .../ganhar).
-- `perda_descricao`: texto livre que acompanha o motivo do catálogo (POST .../perder).

ALTER TABLE oportunidade
    ADD COLUMN pedido_id       uuid,
    ADD COLUMN perda_descricao text;

ALTER TABLE oportunidade
    ADD CONSTRAINT oportunidade_pedido_fk
        FOREIGN KEY (tenant_id, pedido_id) REFERENCES pedido (tenant_id, id) ON DELETE SET NULL (pedido_id);

COMMENT ON COLUMN oportunidade.pedido_id IS 'Pedido do mesmo contato vinculado ao ganho; NULL = sem vínculo.';
COMMENT ON COLUMN oportunidade.perda_descricao IS 'Descrição livre da perda (opcional), ao lado de motivo_perda_codigo.';
