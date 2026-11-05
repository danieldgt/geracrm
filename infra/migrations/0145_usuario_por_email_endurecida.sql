-- 0145_usuario_por_email_endurecida.sql
--
-- `usuario_por_email` (0144) é SECURITY DEFINER e atravessa tenants (descoberta para a redefinição de senha).
-- Mesmo endurecimento da `formulario_por_chave` (0127, revisão de segurança da F3):
--   * função nasce executável por PUBLIC no Postgres → revoga e deixa só o papel da aplicação;
--   * `search_path` fixo com `pg_temp` por último, para um objeto temporário não sombrear `usuario`.
SET LOCAL lock_timeout = '3s';

ALTER FUNCTION usuario_por_email(text) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION usuario_por_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usuario_por_email(text) TO geracrm_app;
