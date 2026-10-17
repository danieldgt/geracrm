-- 0107_atendimento_sla_handoff.sql
--
-- SLA DO HANDOFF — fatia mínima de INB-22 (plano-port-playbook-am, raia P18; ADR-034).
--
--   atendimento_sla_config — por NÚMERO (canal): minutos ÚTEIS até o SLA e até
--       liberar a reatribuição, e se a mensagem única de espera sai. Sem linha =
--       padrão do código (30 / 60 / aviso ligado — shared `SLA_PADRAO`).
--   atendimento — os marcos do SLA do handoff, gravados na linha (sem varrer
--       `mensagem` para medir):
--         sla_inicio_em            quando o agente transferiu (relógio de parede);
--         sla_vence_em             início + N minutos ÚTEIS (expediente, feriado,
--                                  fuso do tenant). Fora do expediente conta da
--                                  próxima abertura;
--         reatribuicao_vence_em    início + M minutos úteis (2º limiar);
--         aviso_espera_previsto_em quando a mensagem de espera é devida (o menor
--                                  entre o SLA e N minutos de parede — fora do
--                                  expediente ela diz "no próximo horário");
--         sla_estourado_em         o worker viu o SLA vencer sem resposta humana
--                                  (gestor notificado + alerta);
--         reatribuicao_liberada_em o 2º limiar passou: qualquer um do número assume;
--         aviso_espera_em          o worker DECIDIU a mensagem de espera (uma vez só);
--         aviso_espera_resultado   o que aconteceu com ela (enviada, ou por que não);
--         sla_respondido_em        1ª mensagem de GENTE depois do início (mede o SLA);
--         responsavel_id           para quem o handoff foi roteado (dono da
--                                  carteira → pool do número em rodízio → gestor).
--
-- ⚠️ Aditiva: tabela nova e colunas anuláveis. A versão anterior não as conhece
--    e segue funcionando (atendimento sem SLA armado = como hoje).

CREATE TABLE atendimento_sla_config (
    tenant_id            uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    canal_id             uuid        NOT NULL,
    sla_minutos          integer     NOT NULL DEFAULT 30,
    reatribuicao_minutos integer     NOT NULL DEFAULT 60,
    aviso_espera         boolean     NOT NULL DEFAULT true,
    atualizado_em        timestamptz NOT NULL DEFAULT now(),
    -- usuario.id de quem mudou. A trilha completa fica em `auditoria`.
    atualizado_por       uuid        NULL,

    PRIMARY KEY (tenant_id, canal_id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT atendimento_sla_config_minutos CHECK (sla_minutos BETWEEN 5 AND 480),
    CONSTRAINT atendimento_sla_config_reatribuicao CHECK (
        reatribuicao_minutos > sla_minutos AND reatribuicao_minutos <= 1440)
);

SELECT aplicar_rls('atendimento_sla_config');

COMMENT ON TABLE atendimento_sla_config IS
    'SLA do handoff por número (ADR-034, P18): minutos ÚTEIS até notificar o gestor e até liberar a '
    'reatribuição; aviso_espera = a mensagem única de espera ao cliente. Sem linha = padrão (30/60/ligado).';

ALTER TABLE atendimento
    ADD COLUMN sla_inicio_em            timestamptz NULL,
    ADD COLUMN sla_vence_em             timestamptz NULL,
    ADD COLUMN reatribuicao_vence_em    timestamptz NULL,
    ADD COLUMN aviso_espera_previsto_em timestamptz NULL,
    ADD COLUMN sla_estourado_em         timestamptz NULL,
    ADD COLUMN reatribuicao_liberada_em timestamptz NULL,
    ADD COLUMN aviso_espera_em          timestamptz NULL,
    ADD COLUMN aviso_espera_resultado   text        NULL,
    ADD COLUMN sla_respondido_em        timestamptz NULL,
    ADD COLUMN responsavel_id           uuid        NULL;

ALTER TABLE atendimento ADD CONSTRAINT atendimento_responsavel_fk
    FOREIGN KEY (tenant_id, responsavel_id) REFERENCES usuario (tenant_id, id) NOT VALID;
ALTER TABLE atendimento VALIDATE CONSTRAINT atendimento_responsavel_fk;

ALTER TABLE atendimento ADD CONSTRAINT atendimento_aviso_espera_resultado_valido CHECK (
    aviso_espera_resultado IS NULL OR aviso_espera_resultado IN (
        'pendente',            -- decidido e reservado; o envio está em curso (nunca repete)
        'enviada',
        'desligado',           -- aviso_espera = false no número
        'humano_respondeu',
        'conversa_com_agente', -- a conversa voltou para o agente
        'opt_out',
        'janela_fechada',      -- oficial fora das 24h: não envia, registra
        'texto_bloqueado',     -- nem o texto do playbook nem o fixo passaram na rede/filtro
        'falhou'               -- o gateway recusou ou o transporte falhou
    )) NOT VALID;
ALTER TABLE atendimento VALIDATE CONSTRAINT atendimento_aviso_espera_resultado_valido;

ALTER TABLE atendimento ADD CONSTRAINT atendimento_sla_coerente CHECK (
    sla_vence_em IS NULL OR (sla_inicio_em IS NOT NULL AND sla_vence_em >= sla_inicio_em)) NOT VALID;
ALTER TABLE atendimento VALIDATE CONSTRAINT atendimento_sla_coerente;

-- O worker procura SLA pendente em TODOS os tenants (como dono): índice parcial,
-- pequeno — só os handoffs armados e ainda sem resposta humana.
CREATE INDEX atendimento_sla_pendente
    ON atendimento (sla_vence_em)
    WHERE sla_vence_em IS NOT NULL AND sla_respondido_em IS NULL AND estado <> 'encerrado';

-- Rodízio do pool: o último responsável roteado no número.
CREATE INDEX atendimento_sla_rodizio
    ON atendimento (tenant_id, canal_id, sla_inicio_em DESC)
    WHERE responsavel_id IS NOT NULL;

COMMENT ON COLUMN atendimento.sla_vence_em IS
    'SLA do handoff (P18): início + minutos ÚTEIS (expediente/feriado/fuso do tenant). Fora do expediente conta '
    'da próxima abertura. NULL = atendimento sem SLA armado (não nasceu de handoff).';
COMMENT ON COLUMN atendimento.aviso_espera_resultado IS
    'O que aconteceu com a mensagem ÚNICA de espera: enviada, ou por que não (humano já respondeu, opt-out, '
    'janela fechada, desligado...). pendente = reservada e em envio; nunca repete.';
COMMENT ON COLUMN atendimento.responsavel_id IS
    'Para quem o handoff foi roteado (rotearHandoff: dono da carteira → pool do número em rodízio → gestor). '
    'Até a reatribuição ser liberada, só ele (ou admin/gestor/supervisor) assume.';
