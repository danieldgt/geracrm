-- 0113_etiqueta_origem.sql
--
-- CATÁLOGOS DO CRM — etiquetas e origens (plano de paridade, raia A4).
--
--   etiqueta         — rótulo colorido do tenant. `cor` é o NOME de um token de uma paleta
--                      fixa (nunca hex): a tela traduz para var(--<token>).
--   contato_etiqueta — N:N contato × etiqueta (PK composta, FKs compostas com o tenant).
--   origem           — de onde o contato veio (cadastrada pelo tenant, ordenável).
--   contato.origem_id — FK composta para `origem`.
--
-- ⚠️ Aditiva: tabelas novas e coluna anulável. A versão anterior ignora tudo isto.
-- ⚠️ Sem semente: o tenant cadastra as suas.

CREATE TABLE etiqueta (
    tenant_id uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id        uuid        NOT NULL,
    nome      text        NOT NULL,
    cor       text        NOT NULL DEFAULT 'neutro',
    ativa     boolean     NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT etiqueta_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 40),
    CONSTRAINT etiqueta_cor  CHECK (cor IN ('acao', 'sucesso', 'atencao', 'erro', 'ia', 'neutro'))
);
CREATE UNIQUE INDEX etiqueta_nome_unico ON etiqueta (tenant_id, lower(nome));
SELECT aplicar_rls('etiqueta');

CREATE TABLE origem (
    tenant_id uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id        uuid        NOT NULL,
    nome      text        NOT NULL,
    ativa     boolean     NOT NULL DEFAULT true,
    ordem     integer     NOT NULL DEFAULT 0,
    criado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT origem_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 60),
    CONSTRAINT origem_ordem CHECK (ordem BETWEEN 0 AND 9999)
);
CREATE UNIQUE INDEX origem_nome_unico ON origem (tenant_id, lower(nome));
SELECT aplicar_rls('origem');

CREATE TABLE contato_etiqueta (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    contato_id  uuid        NOT NULL,
    etiqueta_id uuid        NOT NULL,
    criado_em   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, contato_id, etiqueta_id),
    FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato  (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, etiqueta_id) REFERENCES etiqueta (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX contato_etiqueta_por_etiqueta ON contato_etiqueta (tenant_id, etiqueta_id);
SELECT aplicar_rls('contato_etiqueta');

-- A raia A1 pode criar a coluna antes; IF NOT EXISTS evita o conflito.
ALTER TABLE contato ADD COLUMN IF NOT EXISTS origem_id uuid NULL;
ALTER TABLE contato
    ADD CONSTRAINT contato_origem_fk FOREIGN KEY (tenant_id, origem_id)
    REFERENCES origem (tenant_id, id) NOT VALID;
ALTER TABLE contato VALIDATE CONSTRAINT contato_origem_fk;

COMMENT ON TABLE etiqueta IS
    'Etiquetas do tenant (A4). cor = nome de token da paleta fixa, nunca hex. Nome único sem caixa.';
COMMENT ON TABLE origem IS
    'Origens de contato cadastradas pelo tenant (A4). Desativar não apaga: contatos antigos mantêm a origem.';
