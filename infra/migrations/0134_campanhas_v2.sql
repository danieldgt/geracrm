-- 0134_campanhas_v2.sql
--
-- CAMPANHAS V2 (raia F1a, plano-paridade-am #74-#78, #109): template obrigatorio no
-- oficial, publico composto com exclusoes, lote diario dentro da janela, pausa
-- automatica e destinatario por destinatario com o status da Meta.
--
--   campanha              ganha template, publico, lote diario, inicio, janela, pausa
--                         (motivo e quando), quem iniciou e o modelo (1 = legado, 2 = v2).
--   campanha_destinatario o snapshot do publico no "iniciar", com as exclusoes por
--                         motivo, e o estado de cada envio (pendente ate respondeu).
--
-- Legado x v2: a campanha antiga (segmento RFV + texto livre + campanha_envio) continua
-- exatamente como estava, inclusive o ROI. So a v2 (modelo_versao = 2) usa
-- campanha_destinatario e exige template no oficial.
--
-- Aditiva: colunas novas nulas ou com DEFAULT constante (sem reescrita), uma relaxacao
-- de NOT NULL (mensagem: a v2 no oficial manda template, nao texto; a versao anterior
-- nunca grava nulo) e CHECKs recriados NOT VALID + VALIDATE. O CHECK de estado so
-- ACRESCENTA valores: tudo o que a versao anterior grava continua aceito.

-- ---------------------------------------------------------------------------
-- campanha
-- ---------------------------------------------------------------------------
ALTER TABLE campanha
    ADD COLUMN modelo_versao   smallint    NOT NULL DEFAULT 1,
    ADD COLUMN template_id     uuid,
    ADD COLUMN publico         jsonb,
    ADD COLUMN lote_diario     integer,
    ADD COLUMN inicio_em       timestamptz,
    ADD COLUMN janela          jsonb,
    ADD COLUMN pausa_motivo    text,
    ADD COLUMN pausada_em      timestamptz,
    ADD COLUMN contagem_desde  timestamptz,
    ADD COLUMN confirma_risco_banimento boolean NOT NULL DEFAULT false,
    ADD COLUMN criado_por      uuid,
    ADD COLUMN iniciada_por    uuid,
    ADD COLUMN iniciada_em     timestamptz,
    ADD COLUMN concluida_em    timestamptz,
    ADD COLUMN atualizado_em   timestamptz;

ALTER TABLE campanha ALTER COLUMN mensagem DROP NOT NULL;

COMMENT ON COLUMN campanha.modelo_versao IS
    '1 = legado (segmento RFV + campanha_envio, despacho antigo). 2 = v2 (publico composto + '
    'campanha_destinatario, template obrigatorio no oficial, lote diario, pausa automatica).';
COMMENT ON COLUMN campanha.publico IS
    'Publico da v2: {segmentos, listas, etapas, origens, etiquetas, qualificacao, semInteracaoDias, '
    'criadoDe, criadoAte, exclusoes}. AND entre tipos, OR dentro do tipo (campanha-publico.ts).';
COMMENT ON COLUMN campanha.janela IS
    'Horario de envio no formato do expediente ({seg: {de, ate}, ...}). NULL = expediente do canal '
    '(canal_configuracao.horario_atendimento + feriados), no fuso do tenant.';
COMMENT ON COLUMN campanha.contagem_desde IS
    'Base das taxas da pausa automatica (opt-out e falha): envios desde o inicio ou desde a ultima '
    'retomada. Sem isto, retomar uma campanha pausada por taxa a pausaria de novo no mesmo segundo.';
COMMENT ON COLUMN campanha.confirma_risco_banimento IS
    'Texto livre no numero NAO oficial exige confirmar o risco de banimento (ADR-021). Gravado para '
    'a auditoria responder quem aceitou o risco.';

ALTER TABLE campanha
    ADD CONSTRAINT campanha_template_fk
        FOREIGN KEY (tenant_id, template_id) REFERENCES template (tenant_id, id) NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_template_fk;

ALTER TABLE campanha
    ADD CONSTRAINT campanha_criado_por_fk
        FOREIGN KEY (tenant_id, criado_por) REFERENCES usuario (tenant_id, id) NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_criado_por_fk;

ALTER TABLE campanha
    ADD CONSTRAINT campanha_iniciada_por_fk
        FOREIGN KEY (tenant_id, iniciada_por) REFERENCES usuario (tenant_id, id) NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_iniciada_por_fk;

ALTER TABLE campanha DROP CONSTRAINT campanha_estado_valido;
ALTER TABLE campanha ADD CONSTRAINT campanha_estado_valido
    CHECK (estado IN ('rascunho', 'agendada', 'enviando', 'disparando', 'pausada', 'concluida', 'cancelada')) NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_estado_valido;

ALTER TABLE campanha ADD CONSTRAINT campanha_modelo_valido
    CHECK (modelo_versao IN (1, 2)) NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_modelo_valido;

-- Sem conteudo nao ha o que enviar: template (oficial) ou texto (nao oficial).
ALTER TABLE campanha ADD CONSTRAINT campanha_tem_conteudo
    CHECK (mensagem IS NOT NULL OR template_id IS NOT NULL) NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_tem_conteudo;

ALTER TABLE campanha ADD CONSTRAINT campanha_lote_diario_valido
    CHECK (lote_diario IS NULL OR lote_diario BETWEEN 1 AND 10000) NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_lote_diario_valido;

ALTER TABLE campanha ADD CONSTRAINT campanha_publico_objeto
    CHECK (publico IS NULL OR jsonb_typeof(publico) = 'object') NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_publico_objeto;

ALTER TABLE campanha ADD CONSTRAINT campanha_janela_objeto
    CHECK (janela IS NULL OR jsonb_typeof(janela) = 'object') NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_janela_objeto;

-- Pausa sem motivo vira misterio na semana seguinte (mesma regra de canal_configuracao).
ALTER TABLE campanha ADD CONSTRAINT campanha_pausa_explicada
    CHECK (estado <> 'pausada' OR pausa_motivo IS NOT NULL) NOT VALID;
ALTER TABLE campanha VALIDATE CONSTRAINT campanha_pausa_explicada;

-- O despachante procura, como dono, os tenants com campanha em curso.
CREATE INDEX campanha_em_curso ON campanha (estado, tenant_id)
    WHERE estado IN ('agendada', 'enviando', 'disparando');

-- ---------------------------------------------------------------------------
-- campanha_destinatario
-- ---------------------------------------------------------------------------
CREATE TABLE campanha_destinatario (
    tenant_id       uuid        NOT NULL,
    id              uuid        NOT NULL,
    campanha_id     uuid        NOT NULL,
    contato_id      uuid        NOT NULL,
    -- Chave de bloqueio (55 + DDD + 8, INV-50) do telefone principal no snapshot.
    -- O opt-out e conferido de novo NO ENVIO; esta coluna e o elo com lista_bloqueio
    -- para a contagem de opt-out depois do envio.
    telefone_chave  text,
    estado          text        NOT NULL DEFAULT 'pendente',
    motivo_exclusao text,
    -- wamid (id externo da mensagem no provedor): o elo com os status do webhook.
    wamid           text,
    mensagem_id     uuid,
    conversa_id     uuid,
    erro_codigo     text,
    tentativas      smallint    NOT NULL DEFAULT 0,
    -- Quando a linha foi REIVINDICADA por um worker (estado enviando). Linha presa em
    -- enviando vira falhou/envio_interrompido, nunca volta a pendente: reenviar sem saber
    -- se a primeira saiu e mandar duas vezes.
    enviando_desde  timestamptz,
    enviado_em      timestamptz,
    entregue_em     timestamptz,
    lido_em         timestamptz,
    respondeu_em    timestamptz,
    optout_em       timestamptz,
    criado_em       timestamptz NOT NULL DEFAULT now(),
    atualizado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, campanha_id) REFERENCES campanha (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato  (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT campanha_destinatario_estado_valido CHECK (estado IN (
        'pendente', 'enviando', 'enviada', 'entregue', 'lida', 'respondeu', 'falhou', 'excluida', 'optout'
    )),
    CONSTRAINT campanha_destinatario_exclusao_explicada CHECK (estado <> 'excluida' OR motivo_exclusao IS NOT NULL)
);

-- Idempotencia do snapshot: um contato entra uma vez por campanha (iniciar duas vezes
-- nao duplica, e ninguem recebe a mesma campanha duas vezes).
CREATE UNIQUE INDEX campanha_destinatario_unico ON campanha_destinatario (tenant_id, campanha_id, contato_id);
-- Lista por estado com cursor (tela de destinatarios) e a fila do despachante.
CREATE INDEX campanha_destinatario_por_estado ON campanha_destinatario (tenant_id, campanha_id, estado, id);
-- Lista sem filtro de estado, com cursor.
CREATE INDEX campanha_destinatario_por_campanha ON campanha_destinatario (tenant_id, campanha_id, id);
-- Status do webhook: o wamid acha o destinatario. Unico: um envio, um wamid.
CREATE UNIQUE INDEX campanha_destinatario_por_wamid ON campanha_destinatario (tenant_id, wamid)
    WHERE wamid IS NOT NULL;
-- Resposta do cliente (7 dias) e exclusao "campanha recente": por contato, envios recentes.
CREATE INDEX campanha_destinatario_por_contato ON campanha_destinatario (tenant_id, contato_id, enviado_em DESC)
    WHERE enviado_em IS NOT NULL;
-- Lote diario e aquecimento: enviados hoje por campanha.
CREATE INDEX campanha_destinatario_enviados ON campanha_destinatario (tenant_id, campanha_id, enviado_em)
    WHERE enviado_em IS NOT NULL;

SELECT aplicar_rls('campanha_destinatario');

COMMENT ON TABLE campanha_destinatario IS
    'Destinatarios da campanha v2: snapshot do publico no iniciar (com as exclusoes por motivo) e o '
    'estado de cada envio. pendente -> enviando -> enviada -> entregue -> lida -> respondeu; '
    'falhou (transporte ou webhook), excluida (snapshot ou recusa no envio), optout (recebeu e pediu para sair).';
