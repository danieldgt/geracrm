-- 0099_agente_custo_tetos.sql
--
-- CUSTO PELO CATÁLOGO, TETO POR SESSÃO E ORÇAMENTO MENSAL (ADR-032, raia P6).
--
--   modelo_ia.custo_cache_*_usd_milhao — preço de leitura/escrita de cache. NULL
--       = cobra como entrada (errar para cima). Só a Anthropic publica preço de
--       cache diferente da entrada para os modelos do catálogo.
--   agente_config.teto_sessao_centavos — teto de custo de UMA sessão do agente
--       no número. NULL = padrão do ambiente (IA_TETO_SESSAO_CENTAVOS); 0 desliga.
--   agente_orcamento — orçamento MENSAL do tenant: só ALERTA (80% e 100%, uma
--       vez por mês cada); não corta. Quem corta é o teto do número e o da sessão.
--
-- ⚠️ Aditiva: colunas novas anuláveis e tabela nova; a versão anterior não as
--    conhece e segue funcionando.

ALTER TABLE modelo_ia
    ADD COLUMN custo_cache_leitura_usd_milhao numeric(10,4) NULL,
    ADD COLUMN custo_cache_escrita_usd_milhao numeric(10,4) NULL;

-- Claude: leitura de cache = 0,1× a entrada; escrita (TTL 5 min) = 1,25× a entrada.
UPDATE modelo_ia SET custo_cache_leitura_usd_milhao = 0.20, custo_cache_escrita_usd_milhao = 5.00 WHERE codigo = 'claude-opus-5-5';
UPDATE modelo_ia SET custo_cache_leitura_usd_milhao = 0.20, custo_cache_escrita_usd_milhao = 2.50 WHERE codigo = 'claude-sonnet-5-5';
UPDATE modelo_ia SET custo_cache_leitura_usd_milhao = 0.10, custo_cache_escrita_usd_milhao = 1.25 WHERE codigo = 'claude-haiku-4-5';

COMMENT ON COLUMN modelo_ia.custo_cache_leitura_usd_milhao IS
    'US$/milhão de tokens lidos do cache de prompt. NULL = cobra como entrada (estimativa para cima).';
COMMENT ON COLUMN modelo_ia.custo_cache_escrita_usd_milhao IS
    'US$/milhão de tokens escritos no cache de prompt. NULL = cobra como entrada (estimativa para cima).';

ALTER TABLE agente_config
    ADD COLUMN teto_sessao_centavos bigint NULL;
ALTER TABLE agente_config ADD CONSTRAINT agente_config_teto_sessao_valido
    CHECK (teto_sessao_centavos IS NULL OR teto_sessao_centavos >= 0) NOT VALID;
ALTER TABLE agente_config VALIDATE CONSTRAINT agente_config_teto_sessao_valido;

COMMENT ON COLUMN agente_config.teto_sessao_centavos IS
    'Teto de custo (centavos de R$) de UMA sessão do agente neste número. NULL = IA_TETO_SESSAO_CENTAVOS; 0 = sem teto.';

CREATE TABLE agente_orcamento (
    tenant_id        uuid        NOT NULL PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
    -- NULL = sem orçamento mensal (nenhum alerta).
    mensal_centavos  bigint      NULL,
    -- Mês ('YYYY-MM', fuso do tenant) em que o alerta de 80% / 100% já saiu.
    -- ⚠️ É o que garante UM alerta por mês: o UPDATE condicional só vence uma vez.
    alertado_80_mes  text        NULL,
    alertado_100_mes text        NULL,
    atualizado_em    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agente_orcamento_mensal_valido CHECK (mensal_centavos IS NULL OR mensal_centavos > 0),
    CONSTRAINT agente_orcamento_mes_valido CHECK (
        (alertado_80_mes IS NULL OR alertado_80_mes ~ '^\d{4}-\d{2}$') AND
        (alertado_100_mes IS NULL OR alertado_100_mes ~ '^\d{4}-\d{2}$'))
);

SELECT aplicar_rls('agente_orcamento');

COMMENT ON TABLE agente_orcamento IS
    'Orçamento mensal de IA do tenant (ADR-032): só alerta a 80% e 100%, uma vez por mês cada. Não corta.';
