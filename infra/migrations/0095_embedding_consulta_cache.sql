-- 0095_embedding_consulta_cache.sql
--
-- CACHE DO VETOR DA PERGUNTA (ADR-026, adendo de 2026-10-04).
--
-- Toda consulta do agente ao catálogo ou à base de conhecimento embute a
-- PERGUNTA do cliente antes de buscar — e "qual o prazo de entrega" se repete
-- entre clientes e entre tenants. Esta tabela guarda o vetor por hash do texto
-- normalizado + modelo, para a chamada ao fornecedor acontecer uma vez.
--
-- ⚠️ Tabela GLOBAL, sem tenant_id, de propósito: o vetor de uma frase não
--    depende de quem perguntou, e o cache só rende se for compartilhado. Não
--    guarda o texto da pergunta — só o hash — então nada de um tenant é legível
--    por outro. Exceção registrada no varredor de tenancy (scanners.test.ts),
--    como `modelo_ia`.
--
-- `embedding` é float4[] e não `vector`: a tabela precisa existir também no
-- servidor sem pgvector (a busca lexical continua usando o cache para nada,
-- mas a migration não pode depender da extensão). A comparação de similaridade
-- nunca acontece aqui — só leitura do vetor inteiro por chave.

CREATE TABLE embedding_consulta_cache (
    -- sha256 hex de (modelo || '\n' || texto normalizado).
    chave         text        PRIMARY KEY,
    -- `porta.nome` do provedor que gerou o vetor; trocar de modelo invalida pelo hash.
    modelo        text        NOT NULL,
    embedding     real[]      NOT NULL,
    dimensoes     integer     NOT NULL,
    acertos       integer     NOT NULL DEFAULT 0,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    usado_em      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT embedding_consulta_cache_chave_hex CHECK (chave ~ '^[0-9a-f]{64}$'),
    CONSTRAINT embedding_consulta_cache_dimensoes CHECK (dimensoes > 0 AND dimensoes = cardinality(embedding))
);

-- Poda por idade/uso (worker): o índice evita varrer a tabela inteira.
CREATE INDEX embedding_consulta_cache_usado_em ON embedding_consulta_cache (usado_em);

GRANT SELECT, INSERT, UPDATE, DELETE ON embedding_consulta_cache TO geracrm_app;

COMMENT ON TABLE embedding_consulta_cache IS
    'Cache global do vetor de consulta (pergunta do cliente) por hash de texto normalizado + modelo. '
    'Sem tenant_id de propósito: não guarda texto, só o vetor (ADR-026).';
