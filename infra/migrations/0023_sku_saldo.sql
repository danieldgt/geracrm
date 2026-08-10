-- 0023_sku_saldo.sql
--
-- Saldo por SKU — espelhado do ERP na sincronização.
--
-- ⚠️ NÃO é saldo ao vivo: é o da última apuração, com `apurado_em`. O painel de
--    pedido mostra a data junto — saldo cacheado exibido como vivo vira venda de
--    peça que não existe (ADR-008: degrada VISÍVEL). Saldo síncrono verdadeiro
--    (tela-venda por tabela) é etapa futura; até lá, este com carimbo de hora.
--
-- ⚠️ Somado entre lojas: a mesma CodigoBarra tem estoque em várias lojas; o
--    saldo do SKU é a soma. A carga agrega antes de gravar.

CREATE TABLE sku_saldo (
    tenant_id   uuid        NOT NULL,
    sku_id      uuid        NOT NULL,
    quantidade  numeric(14,3) NOT NULL,
    apurado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, sku_id),
    FOREIGN KEY (tenant_id, sku_id) REFERENCES sku (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('sku_saldo');

COMMENT ON TABLE sku_saldo IS
    'Saldo por SKU da última sincronização (soma entre lojas). ⚠️ Com apurado_em '
    'porque NÃO é ao vivo — o painel mostra a data. Saldo síncrono é etapa futura.';
