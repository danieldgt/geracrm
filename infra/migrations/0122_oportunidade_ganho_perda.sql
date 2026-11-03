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

-- NOT VALID + VALIDATE (padrão da 0113/0114). ⚠️ FK simples (NO ACTION): `ON DELETE SET NULL (col)` exige
-- PostgreSQL 15+ e a versão de produção não foi confirmada; pedido não é apagado (mesma decisão da 0114).
-- ⚠️ Revisada antes de ir para produção: o hash do arquivo mudou — bancos de dev que já aplicaram a
-- versão anterior precisam recriar o banco.
ALTER TABLE oportunidade
    ADD CONSTRAINT oportunidade_pedido_fk
        FOREIGN KEY (tenant_id, pedido_id) REFERENCES pedido (tenant_id, id) NOT VALID;
ALTER TABLE oportunidade VALIDATE CONSTRAINT oportunidade_pedido_fk;

COMMENT ON COLUMN oportunidade.pedido_id IS 'Pedido do mesmo contato vinculado ao ganho; NULL = sem vínculo.';
COMMENT ON COLUMN oportunidade.perda_descricao IS 'Descrição livre da perda (opcional), ao lado de motivo_perda_codigo.';
