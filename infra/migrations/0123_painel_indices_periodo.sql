-- 0123_painel_indices_periodo.sql
--
-- Início v2 e relatórios por dimensão (raia E1). ADITIVA: só índices novos; a versão anterior da API
-- continua atendendo durante a migration.
--
-- As leituras do painel recortam por PERÍODO (contatos criados e pedidos efetivados entre duas datas).
-- Sem estes índices o recorte varre todos os contatos/pedidos do tenant.

-- "Contatos criados entre X e Y" e "os 10 mais recentes".
CREATE INDEX IF NOT EXISTS contato_por_criacao ON contato (tenant_id, criado_em DESC);

-- "Pedidos efetivados entre X e Y": parcial, só o estado que entra nos números.
CREATE INDEX IF NOT EXISTS pedido_efetivados_por_data ON pedido (tenant_id, efetivado_em)
    WHERE estado = 'efetivado';
