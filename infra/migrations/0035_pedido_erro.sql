-- 0035_pedido_erro.sql
--
-- Falha de efetivação NOMEADA no pedido (PED-08). ⚠️ Falha de negócio é retorno
-- tipificado, não exceção — a tela precisa do motivo (estoque insuficiente ×
-- crédito bloqueado × item inativo …) com a ação corretiva. Guardamos o último
-- resultado tipificado para a tela mostrar sem re-consultar o ERP.
--
-- Aditiva (NULL = sem falha). O rascunho NUNCA se perde: a falha muda o estado
-- para 'falhou' mas mantém os itens (ADR-005).

ALTER TABLE pedido ADD COLUMN IF NOT EXISTS ultimo_erro jsonb;

COMMENT ON COLUMN pedido.ultimo_erro IS
    'Última falha de efetivação tipificada (PED-08): {tipo, ...}. NULL quando '
    'efetivado ou nunca tentado. A tela mostra o motivo nomeado + ação.';
