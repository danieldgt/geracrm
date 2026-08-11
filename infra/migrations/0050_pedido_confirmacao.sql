-- 0050_pedido_confirmacao.sql
--
-- Confirmação do pedido pelo CLIENTE no chat: ao enviar o resumo, o pedido fica
-- "aguardando_confirmacao"; quando o cliente responde SIM, vira "confirmado"
-- (ainda vinculado ao contato). É o primeiro passo da jornada — depois vêm
-- orçamento/cobrança/GeraCloud/nota (futuro).
--
-- ⚠️ Recria o CHECK de estado como SUPERCONJUNTO (aditivo): rows antigas seguem
-- válidas e a versão anterior continua inserindo os estados que já conhecia.

ALTER TABLE pedido DROP CONSTRAINT IF EXISTS pedido_estado_valido;
ALTER TABLE pedido ADD CONSTRAINT pedido_estado_valido CHECK (estado IN (
    'rascunho',
    'aguardando_confirmacao',  -- resumo enviado; esperando o SIM do cliente
    'confirmado',              -- cliente confirmou no chat
    'validando',
    'enviando',
    'efetivado',
    'falhou',
    'aguardando_conferencia',
    'cancelado'
));

ALTER TABLE pedido ADD COLUMN IF NOT EXISTS confirmado_em timestamptz;

COMMENT ON COLUMN pedido.confirmado_em IS
    'Quando o cliente respondeu SIM ao resumo no chat. Ver confirmacao-pedido.ts.';
