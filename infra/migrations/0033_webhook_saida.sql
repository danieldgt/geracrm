-- 0033_webhook_saida.sql
--
-- Webhooks de SAÍDA (INT-07): o cliente registra uma URL e nós entregamos os
-- eventos do outbox nela. ⚠️ Entrega por CURSOR no outbox (id bigint global,
-- ordem total): cada webhook guarda o último id entregue e avança por
-- "id > cursor". At-least-once e ordenado — o receptor idempotente por
-- X-GeraCRM-Delivery (o id do outbox).
--
-- ⚠️ Payload é o do outbox: mínimo, SEM conteúdo (ADR-007). O receptor busca
--    detalhe pela nossa API se precisar. Assinado com HMAC-SHA256 do segredo.
--
-- Tabela nova e aditiva; sob RLS (a gestão é por tenant). O despachante roda
-- como DONO (worker) e filtra por tenant_id explícito.

CREATE TABLE webhook_saida (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    url           text        NOT NULL,
    -- Tipos de evento a entregar (ex.: {'mensagem.recebida','mensagem.status'}).
    -- Vazio = todos.
    eventos       text[]      NOT NULL DEFAULT '{}',
    segredo       text        NOT NULL,   -- chave do HMAC (mostrada uma vez ao criar)
    ativo         boolean     NOT NULL DEFAULT true,

    -- Estado de entrega (por webhook):
    cursor            bigint      NOT NULL DEFAULT 0,  -- último outbox.id entregue
    tentativas        integer     NOT NULL DEFAULT 0,  -- do evento na cabeça da fila
    proxima_em        timestamptz,                     -- backoff: não tentar antes
    ultimo_erro       text,
    entregue_em       timestamptz,                     -- última entrega OK
    criado_em         timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)
);

-- O despachante varre os ATIVOS e devidos; índice para esse filtro.
CREATE INDEX webhook_saida_devidos ON webhook_saida (ativo, proxima_em);

SELECT aplicar_rls('webhook_saida');

COMMENT ON TABLE webhook_saida IS
    'Webhooks de saída (INT-07). Entrega por cursor no outbox, assinada com '
    'HMAC. Payload mínimo (ADR-007). Gestão sob RLS; despacho como dono.';
