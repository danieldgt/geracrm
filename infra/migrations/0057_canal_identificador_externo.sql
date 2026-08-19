-- Roteamento do webhook da Meta por identificador EM CLARO.
--
-- ⚠️ A credencial do canal é CIFRADA (`credenciais_cifradas`, entra e nunca sai),
--    então não dá para buscar o `phone_number_id` dentro dela. O webhook da Meta
--    chega numa URL única com o `phone_number_id` no corpo — precisamos casá-lo
--    com o canal/tenant por uma coluna em claro. É só um id de ROTEAMENTO
--    (público na prática), nunca credencial.
--
-- Para WhatsApp Oficial guarda o `phoneNumberId`; para Instagram, o id da conta/
-- página por onde o webhook identifica. Aditiva: só ADD COLUMN + índice + função.
ALTER TABLE canal_conectado ADD COLUMN identificador_externo text;

COMMENT ON COLUMN canal_conectado.identificador_externo IS
    'Id de roteamento do webhook (phone_number_id do WhatsApp / id da conta do '
    'Instagram). EM CLARO de propósito — o webhook casa por ele. Nunca credencial.';

-- ⚠️ Único GLOBAL (não por tenant): um phone_number_id pertence a um só canal no
--    mundo. Duas lojas com o mesmo id seria erro de cadastro — e o webhook não
--    saberia para quem rotear.
CREATE UNIQUE INDEX canal_por_identificador
    ON canal_conectado (identificador_externo)
    WHERE identificador_externo IS NOT NULL;

-- Descoberta de tenant/canal para o WEBHOOK (sem sessão), espelho de
-- `tenant_do_canal`. SECURITY DEFINER porque canal_conectado tem RLS FORCE.
-- Devolve só o mínimo para rotear — nunca credencial.
CREATE OR REPLACE FUNCTION canal_por_identificador_externo(p_ident text)
RETURNS TABLE (tenant_id uuid, canal_id uuid, provedor text, estado text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT tenant_id, id AS canal_id, provedor, estado
      FROM canal_conectado
     WHERE identificador_externo = p_ident
     LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION canal_por_identificador_externo(text) TO geracrm_app;

COMMENT ON FUNCTION canal_por_identificador_externo(text) IS
    '⚠️ Roteamento do webhook da Meta por phone_number_id/conta (sem sessão). '
    'SECURITY DEFINER (RLS FORCE). Devolve só tenant/canal/provedor/estado.';
