-- 0048_pedido_contexto.sql
--
-- Contexto de venda no pedido montado pelo chat: forma de pagamento. (observacao
-- já existe desde 0021.) Entra no resumo que vai ao cliente pelo WhatsApp.
-- ⚠️ Aditiva, nullable. forma_pagamento é texto (o leque varia por negócio); a
-- tela sugere as comuns mas não engessa.

ALTER TABLE pedido ADD COLUMN IF NOT EXISTS forma_pagamento text;

COMMENT ON COLUMN pedido.forma_pagamento IS
    'Forma de pagamento combinada (texto livre; a tela sugere as comuns). Entra no '
    'resumo enviado ao cliente.';
