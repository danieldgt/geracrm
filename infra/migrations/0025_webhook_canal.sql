-- 0025_webhook_canal.sql
--
-- ⚠️ O webhook chega SEM tenant (o fornecedor não tem nosso JWT) e precisa
--    descobrir o tenant a partir do canalId. Mas canal_conectado tem RLS FORCE:
--    sem tenant setado, a busca devolve zero — e o webhook nunca acha o canal.
--
--    Esta função SECURITY DEFINER é a única porta autorizada para essa descoberta:
--    roda com o dono (vê todos os tenants) mas devolve APENAS o tenant e o
--    provedor daquele canal — nada mais. É o mínimo para rotear o webhook, e
--    não vaza credencial nem outro dado.

CREATE OR REPLACE FUNCTION tenant_do_canal(p_canal_id uuid)
RETURNS TABLE (tenant_id uuid, provedor text, estado text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT tenant_id, provedor, estado FROM canal_conectado WHERE id = p_canal_id;
$$;

-- ⚠️ Executável pelo papel da aplicação; a definição roda como dono.
GRANT EXECUTE ON FUNCTION tenant_do_canal(uuid) TO geracrm_app;

COMMENT ON FUNCTION tenant_do_canal(uuid) IS
    '⚠️ Descoberta de tenant para o WEBHOOK (sem sessão). SECURITY DEFINER porque '
    'canal_conectado tem RLS FORCE. Devolve só tenant/provedor/estado — o mínimo '
    'para rotear, nunca credencial.';
