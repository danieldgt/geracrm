-- 0046_automacao.sql
--
-- Automações (motor de gatilhos) — Onda 2. Decisão de arquitetura (com o dono do
-- produto, 2026-08-10), documentada em docs/automacoes.md:
--   • MOTOR: varredura AGENDADA (determinística, testável) — não dirigido por
--     evento. Um job periódico casa contatos por condição e age.
--   • AÇÕES: só INTERNAS (criar tarefa, aplicar sequência, adicionar à lista) —
--     nada dispara para o cliente sozinho. Envio automático fica para depois.
--   • GATILHOS: rfv_segmento, dias_sem_comprar, lead_frio, nps_detrator.
--
-- ⚠️ Aditiva, sob RLS, chaves compostas com tenant_id.

CREATE TABLE automacao (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    nome          text        NOT NULL,
    ativa         boolean     NOT NULL DEFAULT true,
    gatilho       text        NOT NULL,
    gatilho_param jsonb       NOT NULL DEFAULT '{}'::jsonb,
    acao          text        NOT NULL,
    acao_param    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    criado_por    uuid,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    ultima_execucao_em timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, criado_por) REFERENCES usuario (tenant_id, id),
    CONSTRAINT automacao_gatilho_valido CHECK (gatilho IN ('rfv_segmento','dias_sem_comprar','lead_frio','nps_detrator')),
    CONSTRAINT automacao_acao_valida    CHECK (acao IN ('criar_tarefa','aplicar_sequencia','adicionar_lista'))
);
SELECT aplicar_rls('automacao');
CREATE INDEX automacao_ativas ON automacao (tenant_id) WHERE ativa;

-- ⚠️ Dedup: cada automação age no MESMO contato UMA vez (não re-dispara). Sem
-- isto, toda varredura recriaria a tarefa/adição para quem ainda casa a condição.
-- (Limitação v1 documentada: não re-dispara se o cliente sair e voltar à condição.)
CREATE TABLE automacao_execucao (
    tenant_id    uuid        NOT NULL,
    automacao_id uuid        NOT NULL,
    contato_id   uuid        NOT NULL,
    executado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, automacao_id, contato_id),
    FOREIGN KEY (tenant_id, automacao_id) REFERENCES automacao (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contato_id)   REFERENCES contato   (tenant_id, id) ON DELETE CASCADE
);
SELECT aplicar_rls('automacao_execucao');

COMMENT ON TABLE automacao IS
    'Motor de gatilhos por VARREDURA AGENDADA, ações INTERNAS. Ver docs/automacoes.md '
    'e automacao-motor.ts.';
