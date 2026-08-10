-- 0022_sku_preco.sql
--
-- Preço por SKU e por TABELA — espelhado do ERP.
--
-- ⚠️ Preço é POR TABELA, não único: o ERP de referência tem 79 tabelas, com uma
--    de ATACADO e uma de VAREJO (bate com nosso escopo, ADR-019). O mesmo SKU
--    custa diferente no atacado e no varejo. Guardar um preço só quebraria o
--    pedido do outro perfil.
--
-- ⚠️ Preço é SNAPSHOT de apuração: `apurado_em` diz de quando é. O pedido copia
--    o preço no momento da inclusão (INV-25); esta tabela é a referência viva
--    que a busca do painel de pedido lê.

CREATE TABLE tabela_preco (
    tenant_id      uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id_externo     text        NOT NULL,
    descricao      text        NOT NULL,
    -- ⚠️ A tabela padrão do ERP: é a que o painel usa quando o cliente não tem
    --    condição comercial específica. Sem marcar, teríamos de adivinhar qual.
    padrao         boolean     NOT NULL DEFAULT false,
    sistema        text        NOT NULL,       -- erp:<conexao_id>
    visto_em       timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, sistema, id_externo)
);

SELECT aplicar_rls('tabela_preco');

CREATE TABLE sku_preco (
    tenant_id       uuid        NOT NULL,
    sku_id          uuid        NOT NULL,
    -- Tabela externa (id do ERP), não FK para tabela_preco por sistema: mantém
    -- simples e a busca junta por (sistema, id_externo) quando precisa do nome.
    tabela_externa  text        NOT NULL,
    preco_centavos  bigint      NOT NULL,
    apurado_em      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, sku_id, tabela_externa),
    FOREIGN KEY (tenant_id, sku_id) REFERENCES sku (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT sku_preco_nao_negativo CHECK (preco_centavos >= 0)
);

SELECT aplicar_rls('sku_preco');

CREATE INDEX sku_preco_por_tabela ON sku_preco (tenant_id, tabela_externa);

COMMENT ON TABLE sku_preco IS
    'Preço por SKU e por tabela, espelhado do ERP (POST /produtos-precos/{tabela}/'
    'busca-preco-por-codigos-barra). ⚠️ Referência viva; o pedido copia o snapshot '
    'na inclusão (INV-25).';
