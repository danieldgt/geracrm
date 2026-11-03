-- 0133_importacao.sql
--
-- IMPORTADOR COM SIMULAÇÃO, DE-PARA E CONFERÊNCIA (plano de paridade, raia H1 — #99).
--
--   importacao       — uma tentativa de importar um arquivo (contatos | vendas | tarefas). Nasce `simulada`
--                      (nada foi gravado no domínio), vira `executando` quando o gestor confirma com o MESMO
--                      arquivo (mesmo hash) e termina `concluida`.
--   importacao_item  — o resultado POR LINHA (previsto na simulação; real na execução). ⚠️ `motivo` é um
--                      CÓDIGO ('telefone_invalido', 'duplicada_no_arquivo'…), nunca texto do arquivo: o
--                      relatório que o gestor baixa e o log não carregam dado pessoal.
--
-- ⚠️ Aditiva: duas tabelas novas. A versão anterior da API ignora.
-- ⚠️ `conteudo` guarda o CSV só enquanto a execução roda (o worker retoma de onde parou se o processo
--    cair); é zerado ao concluir/falhar/cancelar. `arrendado_ate` é o arrendamento do worker (ver
--    workers/importacao.ts). `importacao_item` não é particionada: no máximo 50 mil linhas por importação.

CREATE TABLE importacao (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id            uuid        NOT NULL,
    tipo          text        NOT NULL,
    arquivo_nome  text        NOT NULL,
    arquivo_hash  text        NOT NULL,
    estado        text        NOT NULL DEFAULT 'simulada',
    de_para       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    opcoes        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    contagens     jsonb       NOT NULL DEFAULT '{"linhas":0,"criados":0,"atualizados":0,"ignorados":0,"rejeitados":0}'::jsonb,
    conteudo      text,
    arrendado_ate timestamptz,
    tentativas    integer     NOT NULL DEFAULT 0,
    erro          text,
    criado_por    uuid,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    concluido_em  timestamptz,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, criado_por) REFERENCES usuario (tenant_id, id),
    CONSTRAINT importacao_tipo   CHECK (tipo IN ('contatos', 'vendas', 'tarefas')),
    CONSTRAINT importacao_estado CHECK (estado IN ('simulada', 'executando', 'concluida', 'falhou', 'cancelada')),
    CONSTRAINT importacao_hash   CHECK (arquivo_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT importacao_nome   CHECK (char_length(arquivo_nome) BETWEEN 1 AND 255)
);
CREATE INDEX importacao_por_criacao ON importacao (tenant_id, criado_em DESC, id DESC);
-- Trabalho do worker: só as que estão executando.
CREATE INDEX importacao_executando ON importacao (arrendado_ate) WHERE estado = 'executando';
SELECT aplicar_rls('importacao');

CREATE TABLE importacao_item (
    tenant_id      uuid    NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    importacao_id  uuid    NOT NULL,
    linha          integer NOT NULL,
    resultado      text    NOT NULL,
    motivo         text,
    referencia_id  uuid,
    PRIMARY KEY (tenant_id, importacao_id, linha),
    FOREIGN KEY (tenant_id, importacao_id) REFERENCES importacao (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT importacao_item_resultado CHECK (resultado IN ('criado', 'atualizado', 'ignorado', 'rejeitado')),
    CONSTRAINT importacao_item_motivo    CHECK (motivo IS NULL OR motivo ~ '^[a-z0-9_]{1,60}$')
);
-- Listagem por resultado (cursor pela linha) e conferência por contato criado/atualizado.
CREATE INDEX importacao_item_por_resultado ON importacao_item (tenant_id, importacao_id, resultado, linha);
CREATE INDEX importacao_item_por_referencia ON importacao_item (tenant_id, referencia_id) WHERE referencia_id IS NOT NULL;
SELECT aplicar_rls('importacao_item');

-- A descrição da venda importada (a do ERP não tem). Nullable: metadado, partições herdam.
ALTER TABLE venda ADD COLUMN IF NOT EXISTS descricao text;

COMMENT ON TABLE importacao IS
    'Importação por planilha (H1). Simulada → executando → concluída. Executa só com o MESMO arquivo (hash) simulado.';
COMMENT ON COLUMN importacao.conteudo IS 'CSV guardado só durante a execução (retomada do worker); zerado ao terminar.';
COMMENT ON TABLE importacao_item IS 'Resultado por linha. ⚠️ `motivo` é código, nunca dado pessoal.';
