-- 0116_tenant_contato_lgpd_modulos.sql
--
-- CONFIGURAÇÕES GERAIS (raia D5): contato da empresa, parâmetros de LGPD e
-- chaves de módulo por tenant.
--
--   tenant ADD contato (cnpj, telefone, whatsapp, email, site, endereco) e LGPD
--   (dpo_nome, dpo_email, retencao_meses, texto_consentimento,
--   exigir_consentimento_whatsapp).
--   tenant_modulo — chave de módulo opcional por tenant. Sem linha = DESLIGADO.
--
-- ⚠️ DECISÃO: a URL da política de privacidade NÃO ganha coluna aqui. O aviso já
--    mora em `tenant_privacidade.url` (0098); duplicar criaria duas fontes de
--    verdade. A tela de LGPD edita essa URL por PUT /v1/privacidade.
-- ⚠️ Aditiva: só colunas anuláveis/com default e tabela nova — a versão
--    anterior da API segue atendendo. cnpj/telefone/whatsapp guardam só dígitos.

ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS cnpj                          text,
    ADD COLUMN IF NOT EXISTS telefone                      text,
    ADD COLUMN IF NOT EXISTS whatsapp                      text,
    ADD COLUMN IF NOT EXISTS email                         text,
    ADD COLUMN IF NOT EXISTS site                          text,
    ADD COLUMN IF NOT EXISTS endereco                      jsonb,
    ADD COLUMN IF NOT EXISTS dpo_nome                      text,
    ADD COLUMN IF NOT EXISTS dpo_email                     text,
    ADD COLUMN IF NOT EXISTS retencao_meses                integer NOT NULL DEFAULT 12,
    ADD COLUMN IF NOT EXISTS texto_consentimento           text,
    ADD COLUMN IF NOT EXISTS exigir_consentimento_whatsapp boolean NOT NULL DEFAULT false;

ALTER TABLE tenant
    ADD CONSTRAINT tenant_retencao_meses_faixa CHECK (retencao_meses BETWEEN 6 AND 120),
    ADD CONSTRAINT tenant_cnpj_digitos CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
    ADD CONSTRAINT tenant_texto_consentimento_curto CHECK (texto_consentimento IS NULL OR length(texto_consentimento) <= 1000);

COMMENT ON COLUMN tenant.retencao_meses IS
    'Depois deste prazo os dados pessoais de contatos descartados são anonimizados (job H2). 6 a 120.';

CREATE TABLE tenant_modulo (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    modulo        text        NOT NULL,
    ativo         boolean     NOT NULL DEFAULT false,
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_por uuid,

    PRIMARY KEY (tenant_id, modulo),
    CONSTRAINT tenant_modulo_valido CHECK (modulo IN ('agenda'))
);

COMMENT ON TABLE tenant_modulo IS
    'Chave de módulo opcional por tenant. Sem linha = desligado (agenda é opt-in).';

SELECT aplicar_rls('tenant_modulo');
