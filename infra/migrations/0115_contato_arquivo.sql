-- 0115_contato_arquivo.sql
--
-- ARQUIVOS DO CONTATO (plano de paridade, raia A3) — contrato, proposta, planilha, foto.
-- O banco guarda só METADADOS e a CHAVE do objeto; os bytes vivem no bucket (mesmo
-- armazenamento da mídia do chat), com o tenant no prefixo da chave.
--
-- ⚠️ Aditiva: tabela nova. A versão anterior ignora.

CREATE TABLE contato_arquivo (
    tenant_id      uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id             uuid        NOT NULL,
    contato_id     uuid        NOT NULL,
    nome           text        NOT NULL,
    tipo_mime      text        NOT NULL,
    tamanho_bytes  bigint      NOT NULL,
    chave_bucket   text        NOT NULL,
    legenda        text,
    enviado_por    uuid,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, enviado_por) REFERENCES usuario (tenant_id, id) ON DELETE SET NULL (enviado_por),
    CONSTRAINT contato_arquivo_nome    CHECK (char_length(btrim(nome)) BETWEEN 1 AND 200),
    CONSTRAINT contato_arquivo_tamanho CHECK (tamanho_bytes BETWEEN 0 AND 15728640),
    CONSTRAINT contato_arquivo_legenda CHECK (legenda IS NULL OR char_length(legenda) <= 300),
    CONSTRAINT contato_arquivo_chave   CHECK (chave_bucket LIKE 'tenant/' || tenant_id::text || '/%')
);
CREATE INDEX contato_arquivo_por_contato ON contato_arquivo (tenant_id, contato_id, criado_em DESC, id DESC);
SELECT aplicar_rls('contato_arquivo');

COMMENT ON TABLE contato_arquivo IS
    'Arquivos anexados à ficha do contato. Bytes no bucket (chave com prefixo tenant/{T}/); aqui só metadados.';
