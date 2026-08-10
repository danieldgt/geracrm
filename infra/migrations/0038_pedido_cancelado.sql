-- 0038_pedido_cancelado.sql
--
-- Estado 'cancelado' no pedido — encerrar um rascunho sem efetivar. Aditivo:
-- troca o CHECK por um que ACEITA um valor a mais (nenhuma linha existente
-- viola). Recriar o CHECK é seguro porque só amplia o conjunto permitido.

ALTER TABLE pedido DROP CONSTRAINT pedido_estado_valido;
ALTER TABLE pedido ADD CONSTRAINT pedido_estado_valido CHECK (estado IN (
    'rascunho', 'validando', 'enviando', 'efetivado', 'falhou',
    'aguardando_conferencia', 'cancelado'
));
