-- 0144_notificacao_email_reserva_usuario_por_email.sql
--
-- D4 (correções da revisão). ADITIVA: a versão anterior do código ignora tudo isto.
--
-- 1) `notificacao.email_reservado_ate` / `email_tentativas` — o worker de e-mail RESERVA a linha antes de
--    enviar (duas instâncias, ou uma passada que cai no meio, não mandam o mesmo e-mail duas vezes) e
--    para de insistir depois de N tentativas.
-- 2) `usuario_por_email(text)` — descoberta de tenant para a REDEFINIÇÃO de senha por código, que chega
--    SEM sessão (a pessoa esqueceu a senha). SECURITY DEFINER porque `usuario` tem RLS FORCE; devolve só
--    tenant, id e sub — o mínimo para auditar e encerrar sessões. Mesmo desenho de `tenant_do_canal`.

SET LOCAL lock_timeout = '3s';

ALTER TABLE notificacao ADD COLUMN email_reservado_ate timestamptz;
ALTER TABLE notificacao ADD COLUMN email_tentativas integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION usuario_por_email(p_email text)
RETURNS TABLE (tenant_id uuid, usuario_id uuid, cognito_sub text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT u.tenant_id, u.id, u.cognito_sub FROM usuario u WHERE lower(u.email) = lower(p_email) LIMIT 2;
$$;

GRANT EXECUTE ON FUNCTION usuario_por_email(text) TO geracrm_app;

COMMENT ON FUNCTION usuario_por_email(text) IS
    '⚠️ Descoberta de tenant para a redefinição de senha (sem sessão). SECURITY DEFINER porque usuario '
    'tem RLS FORCE. Devolve até 2 linhas (o chamador só age quando é exatamente 1) e nunca dado pessoal.';
