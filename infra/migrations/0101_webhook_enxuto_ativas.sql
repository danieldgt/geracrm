-- 0101_webhook_enxuto_ativas.sql
--
-- WEBHOOK ENXUTO E MENSAGENS ATIVAS (plano-port-playbook-am, raia P11).
--
-- 1. tarefa_pos_ingestao — o que o webhook fazia DEPOIS do commit e antes do
--    200 (resposta de ausência = envio pelo provedor; cópia/baixa de mídia =
--    dois GETs na Graph API ou no provedor não-oficial). Era rede dentro do
--    request: com a entrega sequencial da Meta, um provedor lento segurava a
--    fila de TODOS os clientes. Agora a ingestão AGENDA aqui, na MESMA
--    transação da mensagem, e o worker de pós-ingestão executa com retry.
--
-- 2. Suspensão das ATIVAS por qualidade do número: o webhook
--    phone_number_quality_update (FLAGGED/DOWNGRADE/RED) e account_update
--    (restrição/banimento) param as mensagens que NÓS iniciamos (retorno do
--    agente) até a qualidade voltar. Resposta a quem escreveu continua.
--
-- 3. Roteamento dos eventos POR WABA: qualidade, conta e status de template
--    chegam com o WABA id (entry.id) e o telefone de exibição, não com o
--    phone_number_id. A credencial é cifrada; os dois ids de roteamento
--    ficam em claro (como identificador_externo, 0057) — não são segredo.
--
-- 4. agente_config.ativas — limites por dia/semana e o template de retorno
--    usado no OFICIAL fora da janela de 24h. canal_configuracao.feriados —
--    datas em que o expediente não abre (ativas adiam para a próxima abertura).
--
-- ⚠️ Aditiva: só tabela nova, ADD COLUMN com DEFAULT constante (sem reescrita
--    no PG >= 11), função nova e índices. A versão anterior continua servindo:
--    não conhece as colunas e não grava na tabela nova.

CREATE TABLE tarefa_pos_ingestao (
    tenant_id          uuid        NOT NULL,
    id                 uuid        NOT NULL,
    -- 'automatica': resposta automática (ausência) à mensagem entrante.
    -- 'midia': baixar/copiar a mídia de entrada para o nosso bucket.
    tipo               text        NOT NULL,
    conversa_id        uuid        NOT NULL,
    canal_id           uuid        NOT NULL,
    mensagem_id        uuid        NOT NULL,
    mensagem_criado_em timestamptz NOT NULL,
    -- Dados do passo (mídia: tipo, url/placeholder, mime). Nunca texto do cliente.
    dados              jsonb       NOT NULL DEFAULT '{}'::jsonb,
    estado             text        NOT NULL DEFAULT 'pendente',
    tentativas         smallint    NOT NULL DEFAULT 0,
    executar_em        timestamptz NOT NULL DEFAULT now(),
    detalhe            text,
    criado_em          timestamptz NOT NULL DEFAULT now(),
    concluido_em       timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT tarefa_pos_ingestao_tipo_valido   CHECK (tipo IN ('automatica', 'midia')),
    CONSTRAINT tarefa_pos_ingestao_estado_valido CHECK (estado IN ('pendente', 'feita', 'falhou', 'descartada'))
);

SELECT aplicar_rls('tarefa_pos_ingestao');

-- ⚠️ Idempotência: UMA tarefa por (mensagem, tipo). A ingestão já deduplica
--    pelo id externo, mas a guarda fica no banco — reprocessar a mesma
--    mensagem nunca manda duas ausências nem baixa a mídia duas vezes.
CREATE UNIQUE INDEX tarefa_pos_ingestao_unica
    ON tarefa_pos_ingestao (tenant_id, mensagem_id, tipo);

-- A consulta do worker: as vencidas, em ordem. Parcial porque a tabela fica
-- dominada por concluídas.
CREATE INDEX tarefa_pos_ingestao_vencidas
    ON tarefa_pos_ingestao (executar_em) WHERE estado = 'pendente';

-- Retenção: o worker purga as concluídas com mais de 30 dias, em lote, por aqui.
CREATE INDEX tarefa_pos_ingestao_concluidas
    ON tarefa_pos_ingestao (concluido_em) WHERE estado <> 'pendente';

COMMENT ON TABLE tarefa_pos_ingestao IS
    'Passos pós-ingestão que fazem REDE (ausência, mídia), agendados na mesma transação '
    'da mensagem e executados pelo worker com retry. O webhook só grava, agenda e responde 200.';

-- ---------------------------------------------------------------------------
-- Suspensão das ativas e roteamento por WABA.
-- ---------------------------------------------------------------------------

ALTER TABLE canal_conectado
    ADD COLUMN ativas_suspensas_em     timestamptz,
    ADD COLUMN ativas_suspensas_motivo text,
    ADD COLUMN meta_waba_id            text,
    ADD COLUMN meta_telefone           text,
    -- Última vez que o worker conferiu o roteamento na credencial (e o erro, se
    -- houve): é o rodízio — cada canal é decifrado no máximo a cada 10 min.
    ADD COLUMN meta_roteamento_em      timestamptz,
    ADD COLUMN meta_roteamento_erro    text;

ALTER TABLE canal_conectado ADD CONSTRAINT canal_ativas_suspensas_coerente
    CHECK (ativas_suspensas_em IS NULL OR ativas_suspensas_motivo IS NOT NULL) NOT VALID;
ALTER TABLE canal_conectado VALIDATE CONSTRAINT canal_ativas_suspensas_coerente;

COMMENT ON COLUMN canal_conectado.ativas_suspensas_em IS
    'Quando as mensagens ATIVAS (iniciadas por nós: retorno do agente) foram suspensas por '
    'qualidade do número ou restrição da conta. NULL = liberadas. Respostas não são afetadas.';
COMMENT ON COLUMN canal_conectado.meta_waba_id IS
    'WABA id (em claro) para rotear webhooks por conta: qualidade, account_update, template. '
    'Preenchido a partir da credencial pelo worker de pós-ingestão. Nunca credencial.';
COMMENT ON COLUMN canal_conectado.meta_telefone IS
    'Telefone de exibição do número (só dígitos), para casar o display_phone_number do webhook.';

CREATE INDEX canal_por_meta_waba
    ON canal_conectado (meta_waba_id) WHERE meta_waba_id IS NOT NULL;

-- Descoberta de tenant/canal para os eventos POR WABA (sem sessão), espelho de
-- canal_por_identificador_externo (0057). SECURITY DEFINER porque
-- canal_conectado tem RLS FORCE. Devolve só o mínimo para rotear.
-- p_telefone NULL = todos os números da WABA (account_update, template).
CREATE OR REPLACE FUNCTION canais_meta_por_waba(p_waba text, p_telefone text)
RETURNS TABLE (tenant_id uuid, canal_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT tenant_id, id AS canal_id
      FROM canal_conectado
     WHERE meta_waba_id = p_waba
       AND arquivado_em IS NULL
       AND (p_telefone IS NULL OR meta_telefone = regexp_replace(p_telefone, '\D', '', 'g'))
     LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION canais_meta_por_waba(text, text) TO geracrm_app;

COMMENT ON FUNCTION canais_meta_por_waba(text, text) IS
    'Roteamento dos webhooks da Meta por WABA (qualidade, conta, template). SECURITY DEFINER '
    '(RLS FORCE). Devolve só tenant/canal; arquivados ficam de fora.';

-- ---------------------------------------------------------------------------
-- Configuração das ativas e feriados.
-- ---------------------------------------------------------------------------

ALTER TABLE agente_config
    ADD COLUMN ativas jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Falhas de TRANSPORTE seguidas de um retorno (provedor fora). Distinto de
-- `tentativa`, que é o passo da cadência: com teto, a mesma linha não fica
-- reagendando para sempre.
ALTER TABLE agente_retorno
    ADD COLUMN falhas_transporte smallint NOT NULL DEFAULT 0;

COMMENT ON COLUMN agente_config.ativas IS
    'Mensagens ativas do agente: {limiteDia, limiteSemana, templateRetorno (id do template)}. '
    'Vazio = padrões do código (2 por dia, 4 por semana, sem template).';

ALTER TABLE canal_configuracao
    ADD COLUMN feriados jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN canal_configuracao.feriados IS
    'Datas sem expediente: "AAAA-MM-DD" (só aquele ano) ou "MM-DD" (todo ano). '
    'Mensagem ativa que venceria no feriado espera a próxima abertura.';

-- Status de template vindo do webhook: o evento cru e quando chegou. O status
-- normalizado continua em status_meta (CHECK de 0011b).
ALTER TABLE template_versao
    ADD COLUMN status_evento_meta   text,
    ADD COLUMN status_atualizado_em timestamptz;
