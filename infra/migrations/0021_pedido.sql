-- 0021_pedido.sql
--
-- O pedido nasce na conversa (ADR-005). Aqui o RASCUNHO e seus itens — o ERP
-- efetiva depois (quando o conector tiver escritaPedido; o GeraCloud não tem
-- ainda, então o rascunho vira exportável, ADR-008).
--
-- ⚠️ O rascunho NUNCA se perde: é onde produtos desse tipo morrem na prática.
--    Falha na efetivação preserva o rascunho para reprocessar.

CREATE TABLE pedido (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id            uuid        NOT NULL,
    contato_id    uuid,       -- venda de balcão pode não ter cliente
    vendedor_id   uuid,       -- quem montou; nulo até atribuir
    -- ⚠️ Onde o pedido nasceu. Nulo = pedido avulso (fora de conversa).
    conversa_id   uuid,
    estado        text        NOT NULL DEFAULT 'rascunho',
    -- Totais desnormalizados, recalculados a cada mutação de item.
    total_centavos bigint     NOT NULL DEFAULT 0,
    total_pecas   numeric(12,3) NOT NULL DEFAULT 0,
    -- ⚠️ Incrementa a cada mutação — base da chave de efetivação idempotente
    --    (INV-29): reenviar a MESMA versão não duplica no ERP.
    versao_conteudo int       NOT NULL DEFAULT 0,
    numero_externo text,      -- preenchido quando o ERP efetiva
    observacao    text,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    efetivado_em  timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato  (tenant_id, id),
    FOREIGN KEY (tenant_id, vendedor_id) REFERENCES usuario  (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id),
    CONSTRAINT pedido_estado_valido CHECK (estado IN (
        'rascunho',              -- montando
        'validando',             -- checando estoque/crédito no ERP
        'enviando',              -- efetivando
        'efetivado',             -- número externo em mãos
        'falhou',                -- falha de negócio nomeada (PED-08)
        'aguardando_conferencia' -- ⚠️ 504: resposta perdida, pode existir no ERP (INV-53)
    ))
);

SELECT aplicar_rls('pedido');

-- ⚠️ INV-52: no máximo UM rascunho por conversa. Sem isto, duas telas abertas na
--    mesma conversa criam dois rascunhos e a vendedora não sabe qual é o "certo".
CREATE UNIQUE INDEX pedido_rascunho_por_conversa
    ON pedido (tenant_id, conversa_id)
    WHERE estado = 'rascunho' AND conversa_id IS NOT NULL;

CREATE INDEX pedido_por_contato ON pedido (tenant_id, contato_id, criado_em DESC)
    WHERE contato_id IS NOT NULL;

CREATE TABLE pedido_item (
    tenant_id     uuid        NOT NULL,
    pedido_id     uuid        NOT NULL,
    seq           integer     NOT NULL,
    sku_id        uuid,       -- pode ser nulo se o SKU não está no nosso catálogo
    -- ⚠️ SNAPSHOTS: o que o SKU era NA HORA. Preço e descrição mudam no ERP; o
    --    pedido tem de mostrar o que foi combinado, não o de hoje (INV-25).
    sku_snapshot       text   NOT NULL,
    descricao_snapshot text   NOT NULL,
    grade_snapshot     jsonb  NOT NULL DEFAULT '{}'::jsonb, -- cor/tamanho na hora
    quantidade    numeric(12,3) NOT NULL,
    valor_unitario_centavos bigint NOT NULL,

    PRIMARY KEY (tenant_id, pedido_id, seq),
    FOREIGN KEY (tenant_id, pedido_id) REFERENCES pedido (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, sku_id)    REFERENCES sku    (tenant_id, id),
    CONSTRAINT pedido_item_qtd_positiva CHECK (quantidade > 0)
);

SELECT aplicar_rls('pedido_item');

CREATE INDEX pedido_item_por_pedido ON pedido_item (tenant_id, pedido_id, seq);

COMMENT ON COLUMN pedido_item.valor_unitario_centavos IS
    'Preço no momento da inclusão (INV-25). ⚠️ Snapshot — o preço de tabela do ERP '
    'muda, mas o que foi combinado com o cliente não. Preço ao vivo do ERP '
    '(tela-venda) reabastece este campo quando a integração de tabela de preço '
    'estiver ligada; até lá, é entrado na tela.';
