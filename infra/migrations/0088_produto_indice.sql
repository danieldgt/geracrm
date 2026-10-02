-- 0088_produto_indice.sql
--
-- ÍNDICE DE BUSCA DO CATÁLOGO — retrieval híbrido dentro do Postgres (ADR-026).
--
-- Uma linha por produto com o TEXTO que o descreve (referência, nome, categoria,
-- descrição longa e os valores de atributos dos SKUs — ver `textoParaIndice` em
-- packages/shared). ⚠️ NUNCA preço nem estoque: mudam sozinhos e variam por
-- tabela do cliente — o agente obtém os dois por ferramenta, no turno.
--
-- Três pernas, fundidas por RRF no código (catalogo/busca.ts):
--   1. FTS   — `fts` com a configuração `pt_sem_acento` (portuguese + unaccent):
--              "camiseta verde G" acha o produto por significado de palavra.
--   2. trgm  — `texto_sem_acento` com pg_trgm: "camisetta" (erro de digitação)
--              ainda encontra "camiseta".
--   3. vetor — `embedding` (voyage-4, 1024 dims) SÓ SE a extensão `vector`
--              existir no servidor. O bloco guardado no fim é o que faz esta
--              migration passar num Postgres sem pgvector (o local, por exemplo)
--              e o produto declarar a capacidade `buscaSemantica` em vez de
--              quebrar — degradação visível, nunca silenciosa (ADR-008).

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Configuração de busca em português que ignora acento. Guardada: reaplicar a
-- migration num banco onde ela já exista (restore, ambiente antigo) não pode
-- falhar.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pt_sem_acento') THEN
        CREATE TEXT SEARCH CONFIGURATION pt_sem_acento (COPY = portuguese);
        ALTER TEXT SEARCH CONFIGURATION pt_sem_acento
            ALTER MAPPING FOR hword, hword_part, word
            WITH unaccent, portuguese_stem;
    END IF;
END
$$;

CREATE TABLE produto_indice (
    tenant_id        uuid        NOT NULL,
    produto_id       uuid        NOT NULL,
    texto            text        NOT NULL,
    -- ⚠️ `unaccent()` é STABLE, não IMMUTABLE — não cabe em coluna gerada nem
    --    em índice de expressão. O indexador grava esta coluna (lower + unaccent)
    --    na mesma escrita de `texto`; é sobre ela que o trgm trabalha, para que
    --    "calca" encontre "calça".
    texto_sem_acento text        NOT NULL,
    -- `to_tsvector(regconfig, text)` é IMMUTABLE, então a coluna pode ser gerada.
    fts              tsvector    GENERATED ALWAYS AS (to_tsvector('pt_sem_acento'::regconfig, texto)) STORED,
    -- Hash do texto: reindexar só grava quando o texto mudou (e só aí o
    -- embedding precisa ser refeito — é o que `modelo_embedding` NULL sinaliza).
    texto_hash       text        NOT NULL,
    modelo_embedding text,
    atualizado_em    timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, produto_id),
    FOREIGN KEY (tenant_id, produto_id) REFERENCES produto (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('produto_indice');

CREATE INDEX produto_indice_fts  ON produto_indice USING gin (fts);
CREATE INDEX produto_indice_trgm ON produto_indice USING gin (texto_sem_acento gin_trgm_ops);

COMMENT ON TABLE produto_indice IS
    'Texto de busca por produto (ADR-026): FTS pt_sem_acento + trgm, e embedding '
    'quando pgvector existe. Nunca contém preço nem estoque.';

-- ---------------------------------------------------------------------------
-- pgvector é OPCIONAL. Sem a extensão disponível no servidor, nada daqui roda
-- e a busca fica lexical; o código detecta a coluna por pg_attribute.
-- ⚠️ EXECUTE, não SQL direto: o tipo `vector` só existe depois do CREATE
--    EXTENSION, e o plpgsql resolveria o tipo ao preparar o comando.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
        EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
        EXECUTE 'ALTER TABLE produto_indice ADD COLUMN embedding vector(1024)';
        EXECUTE 'CREATE INDEX produto_indice_hnsw ON produto_indice '
             || 'USING hnsw (embedding vector_cosine_ops)';
        EXECUTE $c$COMMENT ON COLUMN produto_indice.embedding IS
            'voyage-4 (1024 dims), cosseno. NULL = ainda não embutido ou texto mudou.'$c$;
    ELSE
        RAISE NOTICE 'pgvector indisponível neste servidor — busca semântica desligada (ADR-026)';
    END IF;
END
$$;
