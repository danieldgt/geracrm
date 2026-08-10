-- 0037_aquecimento.sql
--
-- Aquecimento de frota (Onda 3). ⚠️ Um número NÃO-OFICIAL que dispara 1000
-- mensagens de campanha no primeiro dia é banido (ADR-021: risco de banimento).
-- O aquecimento sobe o TETO DIÁRIO de disparo proativo aos poucos — a campanha
-- respeita o teto do número, não fura.
--
-- Aditiva. O teto por dia é função pura do nº de dias desde o início (aquecimento.ts);
-- aqui guardamos só QUANDO começou por número.

CREATE TABLE canal_aquecimento (
    tenant_id    uuid        NOT NULL,
    canal_id     uuid        NOT NULL,
    iniciado_em  timestamptz NOT NULL DEFAULT now(),
    ativo        boolean     NOT NULL DEFAULT true,

    PRIMARY KEY (tenant_id, canal_id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE
);
SELECT aplicar_rls('canal_aquecimento');

COMMENT ON TABLE canal_aquecimento IS
    'Início do aquecimento por número. O teto diário de disparo proativo cresce '
    'com os dias desde iniciado_em (função pura em aquecimento.ts). Protege o '
    'não-oficial do banimento (ADR-021).';
