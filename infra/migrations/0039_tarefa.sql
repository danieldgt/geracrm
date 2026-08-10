-- 0039_tarefa.sql
--
-- Tarefas de follow-up (Onda 1 — agenda do vendedor). ⚠️ "Vencida" é DERIVADA do
-- vencimento vs. agora, não um estado gravado — senão precisaria de um job para
-- virar o estado à meia-noite. O estado armazenado é só o ciclo de vida real:
-- aberta → concluída | cancelada.
--
-- Tabela nova, sob RLS. Pode ou não ter contato (tarefa avulsa) e responsável.

CREATE TABLE tarefa (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    contato_id    uuid,       -- NULL = tarefa avulsa
    responsavel_id uuid,      -- NULL = de ninguém (aparece para todos)
    titulo        text        NOT NULL,
    descricao     text,
    vence_em      timestamptz NOT NULL,
    estado        text        NOT NULL DEFAULT 'aberta',
    concluida_em  timestamptz,
    criado_por    uuid,
    criado_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id)     REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, responsavel_id) REFERENCES usuario (tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT tarefa_estado_valido CHECK (estado IN ('aberta','concluida','cancelada'))
);
-- Leitura quente: "minhas abertas por vencimento" e "as deste contato".
CREATE INDEX tarefa_agenda   ON tarefa (tenant_id, estado, vence_em);
CREATE INDEX tarefa_por_contato ON tarefa (tenant_id, contato_id, vence_em) WHERE contato_id IS NOT NULL;
SELECT aplicar_rls('tarefa');

COMMENT ON TABLE tarefa IS
    'Follow-up do vendedor. "Vencida" é derivada (vence_em < now e estado=aberta), '
    'não gravada. Ver rotas-tarefa.ts.';
