-- 0089_conhecimento.sql
--
-- BASE DE CONHECIMENTO VERSIONADA (raia R3, ADR-023/026).
--
-- Até aqui a "base" do agente era um campo de texto por canal
-- (`agente_config.politicas`), fatiado em parágrafos na hora da pergunta. Agora
-- o conhecimento é DOCUMENTO com versão — políticas, FAQ, frete, pagamento,
-- troca, produto — e cada trecho citado pelo agente carrega documento + versão,
-- para que "por que o robô disse isso?" tenha resposta auditável.
--
-- Duas tabelas:
--   conhecimento_documento — o que o dono escreve (título, tipo, conteúdo,
--                            versão, publicado). `canal_id` NULL = vale para
--                            todos os canais do tenant.
--   conhecimento_trecho    — o que o retrieval lê: pedaços do documento com
--                            FTS (`pt_sem_acento`, de 0088), trgm e, SÓ SE o
--                            servidor tiver pgvector, embedding (bloco guardado
--                            no fim — mesma degradação visível de 0088).
--
-- Migração de dados: toda `agente_config.politicas` não vazia vira um documento
-- 'politicas' do canal, com os parágrafos como trechos. Nada se perde. A coluna
-- `politicas` CONTINUA existindo e sendo editada pelo console; a rota do agente
-- passa a sincronizá-la no documento (aditivo: a versão anterior da API segue
-- lendo a coluna, a nova lê as duas).

CREATE TABLE conhecimento_documento (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    -- NULL = vale para todos os canais do tenant.
    canal_id      uuid,
    titulo        text        NOT NULL,
    tipo          text        NOT NULL,
    conteudo      text        NOT NULL,
    -- Sobe a cada mudança de conteúdo. É o que o trecho citado carrega.
    versao        integer     NOT NULL DEFAULT 1,
    -- Despublicado = fora do retrieval, mas guardado (apagar é dois deploys).
    publicado     boolean     NOT NULL DEFAULT true,
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    criado_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT conhecimento_tipo_valido CHECK (
        tipo IN ('politicas', 'faq', 'frete', 'pagamento', 'troca', 'produto', 'outro')),
    CONSTRAINT conhecimento_versao_positiva CHECK (versao >= 1),
    CONSTRAINT conhecimento_titulo_nao_vazio CHECK (length(btrim(titulo)) > 0)
);

SELECT aplicar_rls('conhecimento_documento');

-- Listagem do console: por cursor (atualizado_em, id), filtrando por canal.
CREATE INDEX conhecimento_documento_lista
    ON conhecimento_documento (tenant_id, atualizado_em DESC, id DESC);

-- ⚠️ UM documento 'politicas' por canal: é o alvo do sincronismo com
--    `agente_config.politicas` (upsert). Documentos 'politicas' GLOBAIS
--    (canal_id NULL) podem ser vários — NULL não colide em índice único.
CREATE UNIQUE INDEX conhecimento_politicas_por_canal
    ON conhecimento_documento (tenant_id, canal_id)
    WHERE tipo = 'politicas' AND canal_id IS NOT NULL;

COMMENT ON TABLE conhecimento_documento IS
    'Documento da base de conhecimento do agente (ADR-023). canal_id NULL = todos os canais. '
    'O documento politicas de um canal espelha agente_config.politicas (sincronizado pela rota).';

CREATE TABLE conhecimento_trecho (
    tenant_id        uuid        NOT NULL,
    id               uuid        NOT NULL,
    documento_id     uuid        NOT NULL,
    ordem            integer     NOT NULL,
    -- O texto como o modelo recebe: título do documento na primeira linha.
    texto            text        NOT NULL,
    -- ⚠️ unaccent() é STABLE, não cabe em coluna gerada — gravado pelo
    --    indexador (lower + unaccent). É sobre ela que o trgm trabalha.
    texto_sem_acento text        NOT NULL,
    fts              tsvector    GENERATED ALWAYS AS (to_tsvector('pt_sem_acento'::regconfig, texto)) STORED,
    -- Hash do texto: reindexar só regrava o trecho que mudou — e só aí o
    -- embedding dele precisa ser refeito (modelo_embedding volta a NULL).
    texto_hash       text        NOT NULL,
    modelo_embedding text,
    criado_em        timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, documento_id) REFERENCES conhecimento_documento (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT conhecimento_trecho_ordem_valida CHECK (ordem >= 0),
    -- Upsert por posição: o indexador regrava trecho a trecho e apaga a cauda.
    UNIQUE (tenant_id, documento_id, ordem)
);

SELECT aplicar_rls('conhecimento_trecho');

CREATE INDEX conhecimento_trecho_fts  ON conhecimento_trecho USING gin (fts);
CREATE INDEX conhecimento_trecho_trgm ON conhecimento_trecho USING gin (texto_sem_acento gin_trgm_ops);

COMMENT ON TABLE conhecimento_trecho IS
    'Pedaços indexados de conhecimento_documento (ADR-026): FTS pt_sem_acento + trgm, '
    'e embedding quando pgvector existe. Reescrito pelo indexador a cada versão.';

-- ---------------------------------------------------------------------------
-- pgvector é OPCIONAL (mesma guarda de 0088). Sem a extensão, nada daqui roda
-- e a busca fica lexical; o código detecta a coluna por pg_attribute.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
        EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
        EXECUTE 'ALTER TABLE conhecimento_trecho ADD COLUMN embedding vector(1024)';
        EXECUTE 'CREATE INDEX conhecimento_trecho_hnsw ON conhecimento_trecho '
             || 'USING hnsw (embedding vector_cosine_ops)';
        EXECUTE $c$COMMENT ON COLUMN conhecimento_trecho.embedding IS
            'voyage-4 (1024 dims), cosseno. NULL = ainda não embutido ou texto mudou.'$c$;
    ELSE
        RAISE NOTICE 'pgvector indisponível neste servidor — busca semântica de conhecimento desligada (ADR-026)';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Migração de dados: as políticas de cada canal viram o documento 'politicas'
-- daquele canal, parágrafo a parágrafo. Idempotente pelo índice único parcial:
-- reaplicar num banco que já tem o documento não duplica nada.
-- ---------------------------------------------------------------------------
INSERT INTO conhecimento_documento (tenant_id, id, canal_id, titulo, tipo, conteudo, versao, publicado)
SELECT c.tenant_id, gen_random_uuid(), c.canal_id, 'Políticas da loja', 'politicas',
       btrim(c.politicas), 1, true
  FROM agente_config c
 WHERE c.politicas IS NOT NULL AND length(btrim(c.politicas)) > 0
   AND NOT EXISTS (SELECT 1 FROM conhecimento_documento d
                    WHERE d.tenant_id = c.tenant_id AND d.canal_id = c.canal_id AND d.tipo = 'politicas');

-- Trechos: um por parágrafo (separado por linha em branco), com o título na
-- primeira linha — o mesmo formato que o indexador produz. A próxima
-- sincronização reindexa com o fatiamento definitivo; o hash decide o que mudou.
INSERT INTO conhecimento_trecho (tenant_id, id, documento_id, ordem, texto, texto_sem_acento, texto_hash)
SELECT d.tenant_id, gen_random_uuid(), d.id, p.ordem - 1,
       d.titulo || E'\n' || p.paragrafo,
       unaccent(lower(d.titulo || E'\n' || p.paragrafo)),
       encode(sha256(convert_to(d.titulo || E'\n' || p.paragrafo, 'UTF8')), 'hex')
  FROM conhecimento_documento d
  CROSS JOIN LATERAL (
      -- row_number, não a ordinalidade crua: parágrafos vazios são descartados
      -- e a ordem precisa ficar contígua (0, 1, 2…), como o indexador grava.
      SELECT paragrafo, row_number() OVER (ORDER BY ord) AS ordem
        FROM (SELECT btrim(t) AS paragrafo, ord
                FROM regexp_split_to_table(d.conteudo, E'\\n\\s*\\n') WITH ORDINALITY AS s(t, ord)) x
       WHERE length(paragrafo) > 0) p
 WHERE d.tipo = 'politicas' AND d.canal_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM conhecimento_trecho t WHERE t.tenant_id = d.tenant_id AND t.documento_id = d.id);
