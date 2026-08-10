-- 0013_catalogo.sql
--
-- Produtos e SKUs espelhados do ERP.
--
-- ⚠️ A distinção que o pdv-core deixou clara: PRODUTO não é o que se vende.
--    Produto é o modelo ("CONJUNTO LAILA"); o SKU é a combinação cor × tamanho
--    (× sub-tamanho), e é ele que tem estoque e preço. Tratar produto como
--    unidade vendável erra saldo, preço e grade ao mesmo tempo.

CREATE TABLE produto (
    tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id         uuid        NOT NULL,
    referencia text        NOT NULL,
    descricao  text        NOT NULL,
    categoria  text,
    ativo      boolean     NOT NULL DEFAULT true,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)
);

SELECT aplicar_rls('produto');

-- Busca do painel de pedido e do catálogo: por referência ou por nome.
CREATE INDEX produto_por_referencia ON produto (tenant_id, referencia);
CREATE INDEX produto_busca_descricao
    ON produto USING gin (descricao gin_trgm_ops);

CREATE TABLE sku (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    produto_id    uuid        NOT NULL,
    -- ⚠️ Atributos ABERTOS (ADR-004). O ERP de referência tem cor, tamanho E
    --    sub-tamanho; colunas fixas já estariam quebradas no primeiro cliente.
    --    No perfil varejo a grade some da tela, mas o dado continua vindo.
    atributos     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    codigo_barras text,
    ativo         boolean     NOT NULL DEFAULT true,
    criado_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, produto_id) REFERENCES produto (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('sku');

CREATE INDEX sku_por_produto       ON sku (tenant_id, produto_id);
CREATE INDEX sku_por_codigo_barras ON sku (tenant_id, codigo_barras) WHERE codigo_barras IS NOT NULL;
-- Filtro por atributo ("todos os tamanho G") sem varrer a tabela.
CREATE INDEX sku_atributos ON sku USING gin (atributos);

COMMENT ON COLUMN sku.atributos IS
    'Variantes abertas (ADR-004): {"cor":"VERDE","tamanho":"G","subTamanho":"42"}. '
    'O ERP de referência tem os três — colunas fixas não sobreviveriam ao primeiro cliente.';

-- Identidade externa, para a ingestão reconhecer o que já importou.
CREATE TABLE sku_identidade_externa (
    tenant_id  uuid        NOT NULL,
    sku_id     uuid        NOT NULL,
    sistema    text        NOT NULL,
    id_externo text        NOT NULL,
    visto_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, sistema, id_externo),
    FOREIGN KEY (tenant_id, sku_id) REFERENCES sku (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('sku_identidade_externa');

CREATE INDEX sku_identidade_externa_por_sku ON sku_identidade_externa (tenant_id, sku_id);
