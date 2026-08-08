-- infra/dev/setup-dev.sql
--
-- ⚠️ SÓ DESENVOLVIMENTO. Não é migration e não roda em produção.
--
-- Por que existe: o container do Postgres cria o usuário POSTGRES_USER como
-- SUPERUSUÁRIO, e superusuário IGNORA RLS — com ou sem FORCE ROW LEVEL SECURITY.
--
-- Se a API se conectar com ele, o isolamento entre empresas simplesmente não
-- acontece, e nenhum teste percebe: as consultas voltam com dados de todos os
-- tenants e a suíte fica verde.
--
-- Isto foi detectado rodando, no primeiro dia: /v1/eu devolveu o tenant errado
-- porque a conexão era a de superusuário.
--
-- Em produção o Railway provisiona um usuário comum, e este arquivo não é usado.
--
--   docker exec -i geracrm-postgres psql -U geracrm -d geracrm < infra/dev/setup-dev.sql

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geracrm_api') THEN
        CREATE ROLE geracrm_api LOGIN PASSWORD 'geracrm_dev';
    END IF;
END
$$;

-- Herda as permissões do papel de aplicação criado na migration 0001.
GRANT geracrm_app TO geracrm_api;

-- ⚠️ Sem BYPASSRLS e sem SUPERUSER. É esse o ponto.
ALTER ROLE geracrm_api NOBYPASSRLS NOSUPERUSER;

-- Confere e falha ruidosamente se alguém mexer nisso depois.
DO $$
DECLARE r record;
BEGIN
    SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'geracrm_api';
    IF r.rolsuper OR r.rolbypassrls THEN
        RAISE EXCEPTION 'geracrm_api não pode ser superusuário nem ter BYPASSRLS — o RLS seria ignorado';
    END IF;
    RAISE NOTICE 'geracrm_api pronto: sem superusuário, sem BYPASSRLS. RLS vale para ele.';
END
$$;
