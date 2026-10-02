-- 0086_agente_decisao.sql
--
-- UMA LINHA POR TURNO — a auditoria do vendedor (ADR-023, invariante 6).
--
-- ⚠️ O agente fala em nome da marca sem ninguém revisando. Sem isto, "por que o
--    robô disse isso ao meu cliente?" não tem resposta: o log do provedor de IA
--    não é nosso, e `agente_sessao` só tem totais. Aqui fica o que foi
--    perguntado, quais ferramentas rodaram com que argumentos, o que o modelo
--    respondeu, se foi enviado, quanto custou e quanto demorou.
--
-- ⚠️ PII mínima: argumentos e resultados de ferramenta são RESUMIDOS e passam
--    por mascaramento antes de gravar (CPF/CNPJ/telefone). Retenção por tenant.

CREATE TABLE agente_decisao (
    tenant_id          uuid        NOT NULL,
    id                 uuid        NOT NULL,
    conversa_id        uuid        NOT NULL,
    canal_id           uuid        NOT NULL,
    sessao_id          uuid,
    tarefa_id          uuid,
    -- Mensagens entrantes que este turno respondeu.
    mensagens_ids      uuid[]      NOT NULL DEFAULT '{}',
    modo               text        NOT NULL,
    -- 'respondeu' | 'handoff' | 'silencio' (portão barrou) | 'falha' | 'superada'
    desfecho           text        NOT NULL,
    portao_motivo      text,
    modelo             text,
    effort             text,
    -- [{nome, entrada, saida (resumida), ms, erro?}]
    ferramentas        jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- A resposta estruturada do modelo (mensagens, confiança, fase, handoff, slots).
    resposta           jsonb,
    confianca          numeric(3,2),
    handoff_motivo     text,
    -- Números bloqueados pelo guardrail (centavos citados sem origem em ferramenta).
    numeros_bloqueados jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- {entrada, saida, cacheLeitura, cacheEscrita}
    uso                jsonb       NOT NULL DEFAULT '{}'::jsonb,
    custo_centavos     bigint      NOT NULL DEFAULT 0,
    latencia_ms        integer,
    rodadas            smallint    NOT NULL DEFAULT 0,
    enviada            boolean     NOT NULL DEFAULT false,
    -- Ids das mensagens salientes geradas (quando enviada).
    mensagens_saida_ids uuid[]     NOT NULL DEFAULT '{}',
    erro               text,
    criado_em          timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_decisao_desfecho_valido
        CHECK (desfecho IN ('respondeu', 'sugeriu', 'handoff', 'silencio', 'falha', 'superada')),
    CONSTRAINT agente_decisao_modo_valido
        CHECK (modo IN ('desligado', 'sombra', 'assistido', 'autonomo', 'simulacao'))
);

SELECT aplicar_rls('agente_decisao');

CREATE INDEX agente_decisao_por_conversa ON agente_decisao (tenant_id, conversa_id, criado_em DESC);
CREATE INDEX agente_decisao_por_canal    ON agente_decisao (tenant_id, canal_id, criado_em DESC);
-- Custo do dia por canal (teto diário) e painel de métricas.
CREATE INDEX agente_decisao_custo_dia    ON agente_decisao (tenant_id, canal_id, criado_em) INCLUDE (custo_centavos);

COMMENT ON TABLE agente_decisao IS
    'Uma linha por turno do agente: ferramentas, resposta, custo, latência, desfecho. '
    'É o que torna cada decisão contestável (ADR-023).';
