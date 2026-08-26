-- 0071_agente_sdr.sql
--
-- O AGENTE SDR (AQ-19 / EP-18) — fatia 1. Escopo em `docs/agente-sdr-escopo.md`.
--
-- ⚠️ Esta é a única parte do produto que fala com o cliente final em nome da
--    marca SEM ninguém revisando. O schema é desenhado em torno disso: tudo que
--    o agente faz é registrado, contável e desligável.
--
-- Aditiva: duas tabelas novas, nada alterado.

-- ---------------------------------------------------------------------------
-- Configuração por canal — inclusive o botão de desligar
-- ---------------------------------------------------------------------------
CREATE TABLE agente_config (
    tenant_id     uuid        NOT NULL,
    canal_id      uuid        NOT NULL,
    -- ⚠️ O botão de desligar do invariante 7. Tem efeito na PRÓXIMA mensagem,
    --    porque é lido a cada decisão — não em cache, não no deploy.
    ativo         boolean     NOT NULL DEFAULT false,
    -- O lado curado da base híbrida (§4.2): políticas de prazo, pagamento,
    -- entrega e troca. O lado automático (produto, estoque) vem do ERP.
    politicas     text,
    -- ⚠️ Teto de idas e vindas (§3). Sem ele, um cliente confuso conversa com o
    --    robô por vinte mensagens e vai embora achando que foi atendido.
    max_turnos    smallint    NOT NULL DEFAULT 6,
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, canal_id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_turnos_sensatos CHECK (max_turnos BETWEEN 1 AND 20),
    -- ⚠️ Não liga com a base de políticas vazia. Agente ligado sem base responde
    --    "não sei" a tudo, o que é PIOR que não ter agente: gasta a paciência do
    --    cliente e o dinheiro do dono para não informar nada.
    CONSTRAINT agente_ativo_exige_politicas CHECK (
        NOT ativo OR (politicas IS NOT NULL AND length(btrim(politicas)) > 0))
);

SELECT aplicar_rls('agente_config');

COMMENT ON COLUMN agente_config.ativo IS
    '⚠️ Desligar tem efeito na PRÓXIMA mensagem — a decisão relê esta linha a '
    'cada entrada. Desligamento que espera deploy não é desligamento.';

-- ---------------------------------------------------------------------------
-- A sessão do agente numa conversa — o registro auditável
-- ---------------------------------------------------------------------------
CREATE TABLE agente_sessao (
    tenant_id    uuid        NOT NULL,
    id           uuid        NOT NULL,
    conversa_id  uuid        NOT NULL,
    canal_id     uuid        NOT NULL,
    -- 'ativa' → conversando | 'entregue' → handoff | 'encerrada' → parou sozinho
    estado       text        NOT NULL DEFAULT 'ativa',
    turnos       smallint    NOT NULL DEFAULT 0,
    -- ⚠️ SEMPRE preenchido ao sair. "Desqualificado" sem razão auditável é ruído
    --    que ninguém consegue contestar (skill geracrm-ia).
    motivo_saida text,
    iniciada_em  timestamptz NOT NULL DEFAULT now(),
    encerrada_em timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_estado_valido CHECK (estado IN ('ativa', 'entregue', 'encerrada')),
    -- Saiu tem de dizer por quê e quando; ativa não tem nem um nem outro.
    CONSTRAINT agente_saida_coerente CHECK (
        (estado = 'ativa'  AND encerrada_em IS NULL AND motivo_saida IS NULL) OR
        (estado <> 'ativa' AND encerrada_em IS NOT NULL AND motivo_saida IS NOT NULL))
);

SELECT aplicar_rls('agente_sessao');

-- ⚠️ UMA sessão ativa por conversa. Duas seriam dois agentes falando no mesmo
--    lugar — e o cliente vendo o produto discutir consigo mesmo.
CREATE UNIQUE INDEX agente_sessao_uma_ativa
    ON agente_sessao (tenant_id, conversa_id) WHERE estado = 'ativa';

CREATE INDEX agente_sessao_por_conversa
    ON agente_sessao (tenant_id, conversa_id, iniciada_em DESC);

COMMENT ON TABLE agente_sessao IS
    'Registro auditável de toda conversa conduzida pelo agente (invariante 6). '
    'Existe para responder "o que o robô falou com meu cliente" sem depender de '
    'log do provedor de IA.';
