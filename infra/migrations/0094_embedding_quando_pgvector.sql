-- 0094_embedding_quando_pgvector.sql
--
-- PERNA SEMÂNTICA EM BANCO QUE GANHOU pgvector DEPOIS (ADR-026, ADR-008).
--
-- 0088 e 0089 criam `embedding vector(1024)` + HNSW em `produto_indice` e
-- `conhecimento_trecho` SOMENTE se a extensão `vector` estiver disponível no
-- momento em que rodam. Num servidor que não tinha a extensão naquele dia (o
-- Postgres local antes da troca de imagem; um Railway migrado depois), as
-- tabelas ficaram sem a coluna e a busca ficou lexical para sempre.
--
-- Esta migration é a mesma guarda, reaplicável: se a extensão existe e a
-- coluna não, cria; se já existe, não faz nada; se a extensão não existe,
-- só avisa. Aditiva: nenhuma coluna é removida ou renomeada.
--
-- ⚠️ EXECUTE, não SQL direto: o tipo `vector` só existe depois do CREATE
--    EXTENSION, e o plpgsql resolveria o tipo ao preparar o comando.

DO $$
DECLARE
    tabela text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
        RAISE NOTICE 'pgvector indisponível neste servidor — busca semântica continua desligada (ADR-026)';
        RETURN;
    END IF;

    EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';

    FOREACH tabela IN ARRAY ARRAY['produto_indice', 'conhecimento_trecho'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_attribute
             WHERE attrelid = tabela::regclass AND attname = 'embedding' AND NOT attisdropped
        ) THEN
            EXECUTE format('ALTER TABLE %I ADD COLUMN embedding vector(1024)', tabela);
            EXECUTE format('COMMENT ON COLUMN %I.embedding IS %L', tabela,
                           'voyage-4 (1024 dims), cosseno. NULL = ainda não embutido ou texto mudou.');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = tabela || '_hnsw') THEN
            EXECUTE format('CREATE INDEX %I ON %I USING hnsw (embedding vector_cosine_ops)',
                           tabela || '_hnsw', tabela);
        END IF;
    END LOOP;
END
$$;
