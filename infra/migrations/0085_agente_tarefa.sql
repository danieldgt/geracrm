-- 0085_agente_tarefa.sql
--
-- A FILA DO AGENTE (ADR-024): o turno sai do webhook.
--
-- ⚠️ O webhook passa a fazer só "grava a mensagem + agenda a tarefa + 200". O
--    turno (até 20 s de IA) roda num worker, serial por conversa. Uma pendente
--    por conversa; mensagem nova REAGENDA a mesma tarefa (debounce) em vez de
--    criar outra — é assim que "oi", "tem a camiseta", "em G?" viram UM turno.
--
-- ⚠️ Agendada na MESMA transação da ingestão (INV-40): se a mensagem reverter,
--    a tarefa some junto. NOTIFY sozinho não serviria — some sem ouvinte.

CREATE TABLE agente_tarefa (
    tenant_id      uuid        NOT NULL,
    id             uuid        NOT NULL,
    conversa_id    uuid        NOT NULL,
    canal_id       uuid        NOT NULL,
    -- Ids das mensagens entrantes que este turno vai responder (coalescidas).
    mensagens_ids  uuid[]      NOT NULL DEFAULT '{}',
    estado         text        NOT NULL DEFAULT 'pendente',
    executar_em    timestamptz NOT NULL,
    tentativas     smallint    NOT NULL DEFAULT 0,
    iniciada_em    timestamptz,
    concluida_em   timestamptz,
    ultimo_erro    text,
    criado_em      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_tarefa_estado_valido
        CHECK (estado IN ('pendente', 'executando', 'concluida', 'falhou', 'cancelada'))
);

SELECT aplicar_rls('agente_tarefa');

-- ⚠️ UMA pendente por conversa: é o que permite o ON CONFLICT reagendar.
CREATE UNIQUE INDEX agente_tarefa_uma_pendente
    ON agente_tarefa (tenant_id, conversa_id) WHERE estado = 'pendente';

-- A consulta do worker: as vencidas, em ordem. Parcial porque a tabela fica
-- dominada por concluídas.
CREATE INDEX agente_tarefa_vencidas
    ON agente_tarefa (executar_em) WHERE estado = 'pendente';

-- Serialização por conversa: "há uma executando para esta conversa?"
CREATE INDEX agente_tarefa_executando
    ON agente_tarefa (tenant_id, conversa_id) WHERE estado = 'executando';

-- Expurgo.
CREATE INDEX agente_tarefa_expurgo
    ON agente_tarefa (concluida_em) WHERE concluida_em IS NOT NULL;

COMMENT ON TABLE agente_tarefa IS
    'Fila do turno do agente (ADR-024). Uma pendente por conversa, reagendada a cada '
    'mensagem nova (debounce). O worker pega com FOR UPDATE SKIP LOCKED e nunca duas '
    'da mesma conversa ao mesmo tempo.';
