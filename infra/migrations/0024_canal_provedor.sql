-- 0024_canal_provedor.sql
--
-- O canal ganha PROVEDOR — qual integração o opera (ADR-021, canal dual).
--
-- ⚠️ Aditiva: `canal_conectado` já existe (0011) com `tipo` (whatsapp|instagram)
--    e `credenciais_cifradas`. Agora distingue oficial × não-oficial e QUAL
--    provedor não-oficial (PlugZapi hoje; a coluna aceita o próximo sem migration).

ALTER TABLE canal_conectado ADD COLUMN provedor text;

-- ⚠️ Amplia o tipo para o modelo dual. Alterar CHECK é drop+add — seguro aqui
--    porque não há linha de canal ainda (a frota nasce com o cadastro).
ALTER TABLE canal_conectado DROP CONSTRAINT canal_tipo_valido;
ALTER TABLE canal_conectado ADD CONSTRAINT canal_tipo_valido CHECK (tipo IN (
    'whatsapp_oficial',      -- Meta Cloud API — prioridade (ADR-002)
    'whatsapp_nao_oficial',  -- PlugZapi/Z-API e afins — opção, com risco
    'instagram'
));

-- Rótulo do provedor para a interface (nunca decide comportamento — isso é o
-- adaptador). Ex.: 'meta_oficial', 'plugzapi'.
COMMENT ON COLUMN canal_conectado.provedor IS
    '⚠️ Qual integração opera o canal (meta_oficial | plugzapi | …). O TIPO diz '
    'oficial/não-oficial; o provedor diz por qual biblioteca. Um não-oficial novo '
    'entra como novo valor, sem migration.';
