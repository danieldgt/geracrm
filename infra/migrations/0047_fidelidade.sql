-- 0047_fidelidade.sql
--
-- Fidelidade / Cashback — Onda 2. ⚠️ ADR-020: o saldo é LIDO do ERP, NUNCA
-- gerido aqui — a alavancagem (mostrar na conversa, segmentar por saldo) é nossa.
-- Por isso esta tabela é um SNAPSHOT de leitura, alimentado pela sincronização
-- do ERP; não há escrita manual de saldo (seria uma segunda verdade).
--
-- ⚠️ Degradação (ADR-008 + capacidade `fidelidade` da porta): sem um conector
-- que declare `fidelidade`, os blocos de saldo SOMEM — a tela explica, não
-- mostra número inventado nem controle desabilitado.
--
-- ⚠️ Aditiva, sob RLS, chave composta com tenant_id.

CREATE TABLE fidelidade_saldo (
    tenant_id     uuid        NOT NULL,
    contato_id    uuid        NOT NULL,
    -- Em centavos p/ cashback; para programas de pontos o mesmo campo guarda o
    -- número de pontos (a unidade é do programa do ERP, exibida como tal).
    saldo         bigint      NOT NULL DEFAULT 0,
    unidade       text        NOT NULL DEFAULT 'centavos',   -- 'centavos' | 'pontos'
    -- ⚠️ Snapshot da última sincronização + a data; NÃO ao vivo (ADR-008).
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    origem        text        NOT NULL DEFAULT 'erp',

    PRIMARY KEY (tenant_id, contato_id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fidelidade_unidade_valida CHECK (unidade IN ('centavos','pontos')),
    CONSTRAINT fidelidade_origem_valida  CHECK (origem  IN ('erp','manual'))
);
SELECT aplicar_rls('fidelidade_saldo');
-- "Top saldos" e "quem tem saldo": leitura quente do painel.
CREATE INDEX fidelidade_por_saldo ON fidelidade_saldo (tenant_id, saldo DESC) WHERE saldo > 0;

COMMENT ON TABLE fidelidade_saldo IS
    'Snapshot do saldo de fidelidade LIDO do ERP (ADR-020). Sem escrita manual de '
    'saldo. Sem conector com a capacidade `fidelidade`, o painel degrada (blocos '
    'somem, com explicação). Ver rotas-fidelidade.ts.';
