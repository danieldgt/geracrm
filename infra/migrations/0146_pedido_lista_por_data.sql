-- 0146_pedido_lista_por_data.sql
--
-- Raia X6 (lista de pedidos com busca/período no servidor e contadores). ADITIVA: só um índice novo;
-- a versão anterior da API segue atendendo.
--
-- A lista de pedidos pagina por cursor (criado_em DESC, id DESC) e agora também recorta por período
-- (`?inicio&fim`); os contadores agregam por estado no mesmo recorte. Só existia índice por contato
-- (`pedido_por_contato`), então a lista geral e o período varriam e ordenavam todos os pedidos do tenant.
-- Este índice entrega a ordem do cursor e a faixa de datas direto, sempre sob o `tenant_id`.
--
-- `lock_timeout`: o CREATE INDEX pede SHARE na tabela (bloqueia escrita enquanto constrói). Se não
-- conseguir a trava em 3 s, a migration falha e o deploy para, em vez de enfileirar escritas atrás dela.
SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS pedido_lista_por_data
    ON pedido (tenant_id, criado_em DESC, id DESC);
