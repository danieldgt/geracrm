-- 0001_extensoes_e_convencoes.sql
--
-- Primeira migration do GeraCRM. Não cria tabela de domínio: estabelece as
-- extensões, o controle de estado das próprias migrations e as duas funções
-- que toda migration seguinte usa.
--
-- Decisões que esta migration materializa:
--   ADR-001  multi-tenant por tenant_id + RLS
--   ADR-006  SQL à mão, runner no pre-deploy, migration sempre aditiva
--   ADR-016  chave primária composta (tenant_id, id)
--
-- ⚠️ Cada arquivo roda dentro de UMA transação. Nada aqui pode exigir
--    CREATE INDEX CONCURRENTLY nem CREATE DATABASE.

-- ---------------------------------------------------------------------------
-- Extensões
-- ---------------------------------------------------------------------------

-- Necessária para a restrição de exclusão temporal da carteira (0010):
-- EXCLUDE USING gist (tenant_id WITH =, contato_id WITH =, periodo WITH &&)
-- exige o operador de igualdade em btree dentro de um índice gist.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Remoção de acento na busca por nome de contato. A vendedora digita "jose"
-- e precisa achar "JOSÉ".
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Busca por trecho ("mediterr" encontrando "LA MEDITERRANEA") — o padrão de
-- busca da lista de conversas e do catálogo.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Controle de estado das migrations
-- ---------------------------------------------------------------------------
-- Lida pelo runner (apps/api/src/db/migrations.ts), que roda no CI e como
-- preDeployCommand no Railway. ⚠️ Falhou, o deploy não prossegue e a versão
-- anterior continua servindo.
--
-- Sem tenant_id: é tabela de infraestrutura, não de domínio (§7.2 do modelo).

CREATE TABLE IF NOT EXISTS schema_migrations (
    versao        text        PRIMARY KEY,
    aplicada_em   timestamptz NOT NULL DEFAULT now(),
    duracao_ms    integer,
    -- Detecta arquivo editado depois de aplicado — o erro que faz dois
    -- ambientes divergirem em silêncio.
    hash_conteudo text        NOT NULL
);

COMMENT ON TABLE schema_migrations IS
    'Estado das migrations aplicadas. Escrita apenas pelo runner.';
COMMENT ON COLUMN schema_migrations.hash_conteudo IS
    'Hash do arquivo no momento da aplicação. Divergência = arquivo editado após aplicado.';

-- ---------------------------------------------------------------------------
-- O tenant corrente
-- ---------------------------------------------------------------------------
-- Toda policy de RLS compara tenant_id com esta função. O valor é posto na
-- sessão pelo plugin de tenant da API, a partir do claim custom:tenant_id do
-- token — ⚠️ NUNCA de parâmetro do cliente (ADR-001).
--
-- STABLE, não IMMUTABLE: o valor muda entre transações, mas não dentro de uma.
-- Isso permite ao planejador reusar o resultado na mesma query.

CREATE OR REPLACE FUNCTION tenant_atual()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT nullif(current_setting('geracrm.tenant_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION tenant_atual() IS
    'Tenant da sessão, vindo do token autenticado. NULL quando não definido — '
    'e policy que compara com NULL não devolve linha, que é o comportamento seguro.';

-- ---------------------------------------------------------------------------
-- Aplicar RLS de forma uniforme
-- ---------------------------------------------------------------------------
-- Toda tabela de domínio chama esta função. Centralizar evita o erro clássico:
-- policy escrita à mão em 40 tabelas, uma delas com o filtro errado.
--
-- ⚠️ FORCE ROW LEVEL SECURITY é o detalhe que quase todo mundo esquece:
-- sem ele, o DONO da tabela (o usuário das migrations, e frequentemente o
-- mesmo da aplicação) ignora as policies.
--
-- ⚠️ E FORCE NÃO BASTA: superusuário ignora RLS SEMPRE, com ou sem FORCE.
-- Verificado na aplicação desta migration — conectado como o superusuário do
-- container, o tenant A leu e gravou dados do tenant B, com a policy correta
-- e ativa. Consequência prática, registrada em geracrm-testes:
--
--   Todo teste de isolamento faz SET ROLE geracrm_app antes de asserir.
--   Teste de RLS rodando como superusuário passa sempre e não prova nada.

CREATE OR REPLACE FUNCTION aplicar_rls(nome_tabela text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', nome_tabela);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', nome_tabela);

    EXECUTE format($f$
        CREATE POLICY isolamento_tenant ON %I
            USING       (tenant_id = tenant_atual())
            WITH CHECK  (tenant_id = tenant_atual())
    $f$, nome_tabela);
END;
$$;

COMMENT ON FUNCTION aplicar_rls(text) IS
    'Habilita e FORÇA RLS numa tabela de domínio, com a policy padrão de tenant. '
    'FORCE é obrigatório: sem ele o dono da tabela ignora as policies.';

-- ---------------------------------------------------------------------------
-- Papel da aplicação
-- ---------------------------------------------------------------------------
-- A API não se conecta como superusuário nem como dono do schema. Em dev o
-- papel é criado aqui; em produção o Railway já provisiona o usuário e este
-- bloco apenas garante as permissões.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geracrm_app') THEN
        CREATE ROLE geracrm_app NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO geracrm_app;

-- Tabelas futuras já nascem acessíveis ao papel da aplicação, sem GRANT manual
-- a cada migration — outro ponto onde o esquecimento vira bug de produção.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO geracrm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO geracrm_app;

COMMENT ON ROLE geracrm_app IS
    'Papel usado pela API. Sem BYPASSRLS — o isolamento vale para ele.';
