-- 0044_sequencia.sql
--
-- Sequências (régua de relacionamento) — Onda 2. Um PLAYBOOK de toques: uma
-- lista ordenada de passos, cada um com um "D+N" (dias após aplicar) e o que
-- fazer. É a régua da skill funil-de-vendas: pós-venda D+7, reposição, etc.
--
-- ⚠️ Enrolamento AUTOMÁTICO (a régua dispara sozinha quando o cliente cruza um
-- gatilho) é do motor de Automações e vem depois. AQUI a régua é definida e
-- APLICADA à mão a um contato — e aplicar MATERIALIZA as tarefas (tabela `tarefa`,
-- 0039), com vencimento = hoje + offset. Sem worker, sem estado novo de execução:
-- reusa o que já existe e já funciona.
--
-- ⚠️ Aditiva, sob RLS, chaves compostas com tenant_id.

CREATE TABLE sequencia (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    nome        text        NOT NULL,
    objetivo    text,
    ativa       boolean     NOT NULL DEFAULT true,
    criado_por  uuid,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, criado_por) REFERENCES usuario (tenant_id, id)
);
SELECT aplicar_rls('sequencia');
CREATE UNIQUE INDEX sequencia_nome_unico ON sequencia (tenant_id, lower(nome));

CREATE TABLE sequencia_passo (
    tenant_id     uuid        NOT NULL,
    sequencia_id  uuid        NOT NULL,
    seq           smallint    NOT NULL,       -- ordem de exibição
    offset_dias   integer     NOT NULL,       -- D+N a partir da aplicação
    titulo        text        NOT NULL,
    descricao     text,

    PRIMARY KEY (tenant_id, sequencia_id, seq),
    FOREIGN KEY (tenant_id, sequencia_id) REFERENCES sequencia (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT passo_offset_nao_negativo CHECK (offset_dias >= 0)
);
SELECT aplicar_rls('sequencia_passo');

COMMENT ON TABLE sequencia IS
    'Régua de relacionamento (playbook de toques). Aplicar a um contato '
    'materializa tarefas (0039). Enrolamento automático = Automações, depois. '
    'Ver rotas-sequencia.ts.';
