-- 0014_venda.sql
--
-- A venda — a fonte de verdade do RFV, da recompra e da atribuição de receita.
--
-- ⚠️ Ela vem do ERP e é IMUTÁVEL aqui. Nada no GeraCRM altera venda; o que
--    fazemos é ler, atribuir origem e derivar métrica. Um UPDATE em venda seria
--    o CRM discordando do faturamento do cliente.

CREATE TABLE venda (
    tenant_id      uuid        NOT NULL,
    id             uuid        NOT NULL,
    contato_id     uuid,       -- ⚠️ NULL: venda de balcão sem cliente identificado
    ocorrida_em    timestamptz NOT NULL,
    valor_centavos bigint      NOT NULL,
    -- Quem vendeu, já resolvido para o usuário daqui. NULL quando o vendedor do
    -- ERP não correspondeu (fica em correspondencia_pendente).
    usuario_id     uuid,
    filial_id      uuid,
    -- ⚠️ Guardados como vieram, além do resolvido: quando a correspondência
    --    for criada depois, dá para reprocessar sem reimportar do ERP.
    vendedor_externo text,
    filial_externa   text,
    cancelada_em   timestamptz,
    criado_em      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, ocorrida_em, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE SET NULL,
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id),
    FOREIGN KEY (tenant_id, filial_id)  REFERENCES filial  (tenant_id, id)
) PARTITION BY RANGE (ocorrida_em);

SELECT aplicar_rls('venda');

-- ⚠️ Particionada por período porque a carga histórica traz ANOS de venda de uma
--    vez — é a tabela que mais cresce depois de mensagem. Partições de 12 meses
--    para trás e 12 para frente: o histórico entra sem falha de partição
--    ausente, e o futuro cobre o primeiro ano de operação.
DO $$
DECLARE
    inicio date := (date_trunc('month', now()) - interval '12 months')::date;
    i int; de date; ate date;
BEGIN
    FOR i IN 0..23 LOOP
        de  := inicio + (i     || ' month')::interval;
        ate := inicio + (i + 1 || ' month')::interval;
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS venda_%s PARTITION OF venda FOR VALUES FROM (%L) TO (%L)',
            to_char(de, 'YYYY_MM'), de, ate);
    END LOOP;
    -- ⚠️ Partição de escape para venda anterior à janela. Sem ela, a carga
    --    histórica de um cliente com 5 anos de base falha na primeira linha
    --    antiga — e falha no meio da importação, não no começo.
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS venda_anterior PARTITION OF venda FOR VALUES FROM (%L) TO (%L)',
        '1900-01-01'::date, inicio);
END
$$;

CREATE INDEX venda_por_contato ON venda (tenant_id, contato_id, ocorrida_em DESC);
CREATE INDEX venda_por_usuario ON venda (tenant_id, usuario_id, ocorrida_em DESC);

COMMENT ON TABLE venda IS
    'Venda vinda do ERP. IMUTÁVEL aqui — o CRM lê, atribui origem e deriva '
    'métrica, mas nunca altera. Alterar seria discordar do faturamento do cliente.';
COMMENT ON COLUMN venda.contato_id IS
    '⚠️ NULL é legítimo: venda de balcão sem cliente identificado. No varejo é '
    'boa parte do movimento, e ela conta para o faturamento mesmo sem entrar no RFV.';
COMMENT ON COLUMN venda.vendedor_externo IS
    'Como veio do ERP, além do resolvido. Permite reprocessar quando a '
    'correspondência for criada depois, sem reimportar.';

-- ---------------------------------------------------------------------------
-- item_venda
-- ---------------------------------------------------------------------------
-- Alimenta "categorias mais compradas" e o drill-down até SKU-cor-tamanho.

CREATE TABLE item_venda (
    tenant_id            uuid        NOT NULL,
    venda_id             uuid        NOT NULL,
    venda_ocorrida_em    timestamptz NOT NULL,
    seq                  smallint    NOT NULL,
    sku_id               uuid,
    -- ⚠️ Guardado mesmo quando o SKU não corresponde: item de venda de produto
    --    já excluído do catálogo continua sendo faturamento.
    sku_externo          text,
    quantidade           numeric(12,3) NOT NULL,
    valor_unitario_centavos bigint   NOT NULL,

    PRIMARY KEY (tenant_id, venda_ocorrida_em, venda_id, seq),
    FOREIGN KEY (tenant_id, sku_id) REFERENCES sku (tenant_id, id) ON DELETE SET NULL
) PARTITION BY RANGE (venda_ocorrida_em);

SELECT aplicar_rls('item_venda');

DO $$
DECLARE
    inicio date := (date_trunc('month', now()) - interval '12 months')::date;
    i int; de date; ate date;
BEGIN
    FOR i IN 0..23 LOOP
        de  := inicio + (i     || ' month')::interval;
        ate := inicio + (i + 1 || ' month')::interval;
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS item_venda_%s PARTITION OF item_venda FOR VALUES FROM (%L) TO (%L)',
            to_char(de, 'YYYY_MM'), de, ate);
    END LOOP;
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS item_venda_anterior PARTITION OF item_venda FOR VALUES FROM (%L) TO (%L)',
        '1900-01-01'::date, inicio);
END
$$;

CREATE INDEX item_venda_por_sku ON item_venda (tenant_id, sku_id, venda_ocorrida_em DESC);

-- ---------------------------------------------------------------------------
-- venda_identidade_externa
-- ---------------------------------------------------------------------------

CREATE TABLE venda_identidade_externa (
    tenant_id         uuid        NOT NULL,
    sistema           text        NOT NULL,
    id_externo        text        NOT NULL,
    venda_id          uuid        NOT NULL,
    venda_ocorrida_em timestamptz NOT NULL,
    visto_em          timestamptz NOT NULL DEFAULT now(),

    -- ⚠️ NÃO particionada, pelo mesmo motivo de evento_externo: a unicidade
    --    precisa valer para SEMPRE. Em tabela particionada, reimportar um mês
    --    antigo duplicaria a venda.
    PRIMARY KEY (tenant_id, sistema, id_externo)
);

SELECT aplicar_rls('venda_identidade_externa');

COMMENT ON TABLE venda_identidade_externa IS
    'Guardiã da idempotência da ingestão de vendas. NÃO particionar: a unicidade '
    'vale para sempre, não por período — senão reimportar mês antigo duplica.';
