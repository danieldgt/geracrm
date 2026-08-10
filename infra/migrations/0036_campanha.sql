-- 0036_campanha.sql
--
-- Campanhas com ROI (Onda 3). ⚠️ Atribuição de receita é onde quase todo CRM
-- mente (skill funil-de-vendas):
--   • EXATA: o pedido nasceu vinculado à campanha (fato). → pedido.campanha_id.
--   • ESTIMADA por janela: quem comprou em N dias após receber (correlação).
--   NUNCA somar as duas sem distinção. A janela é CONFIGURÁVEL e DECLARADA.
--
-- Audiência por segmento RFV (classificarRfv). Envio respeita o gateway único
-- (E5-13: opt-out/janela) — a campanha não fura o bloqueio.

CREATE TABLE campanha (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    nome          text        NOT NULL,
    -- Código do segmento RFV alvo (ex.: 'em_risco') ou 'todos'.
    segmento_alvo text        NOT NULL DEFAULT 'todos',
    canal_id      uuid,       -- por qual número dispara
    mensagem      text        NOT NULL,
    -- ⚠️ Janela de atribuição DECLARADA (dias). Sem isto, "vendas 7d" não
    --    significa nada. Configurável por campanha.
    janela_atribuicao_dias int NOT NULL DEFAULT 7,
    estado        text        NOT NULL DEFAULT 'rascunho',
    criado_em     timestamptz NOT NULL DEFAULT now(),
    disparada_em  timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id),
    CONSTRAINT campanha_estado_valido CHECK (estado IN ('rascunho','disparando','concluida','cancelada')),
    CONSTRAINT campanha_janela_positiva CHECK (janela_atribuicao_dias BETWEEN 1 AND 90)
);
CREATE INDEX campanha_recente ON campanha (tenant_id, criado_em DESC);
SELECT aplicar_rls('campanha');

-- Um envio por destinatário por campanha (o disparo é idempotente).
CREATE TABLE campanha_envio (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    campanha_id uuid        NOT NULL,
    contato_id  uuid        NOT NULL,
    mensagem_id uuid,                      -- a mensagem enviada (quando enviada)
    estado      text        NOT NULL DEFAULT 'pendente', -- pendente|enviado|falhou|bloqueado
    enviado_em  timestamptz,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, campanha_id) REFERENCES campanha (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato  (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT campanha_envio_estado_valido CHECK (estado IN ('pendente','enviado','falhou','bloqueado'))
);
-- ⚠️ Idempotência do disparo: um destinatário não recebe a campanha duas vezes.
CREATE UNIQUE INDEX campanha_envio_unico ON campanha_envio (tenant_id, campanha_id, contato_id);
CREATE INDEX campanha_envio_por_campanha ON campanha_envio (tenant_id, campanha_id, estado);
SELECT aplicar_rls('campanha_envio');

-- ⚠️ Atribuição EXATA: o pedido que nasceu da campanha. Aditiva, NULL = avulso.
ALTER TABLE pedido ADD COLUMN IF NOT EXISTS campanha_id uuid;
COMMENT ON COLUMN pedido.campanha_id IS
    'Campanha que originou o pedido (atribuição EXATA de receita). NULL = pedido '
    'não veio de campanha. A estimada (por janela) NÃO usa esta coluna.';
