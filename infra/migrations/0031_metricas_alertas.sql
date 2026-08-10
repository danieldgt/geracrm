-- 0031_metricas_alertas.sql
--
-- Série temporal técnica (I-11) + alertas (I-10). Decisão de 2026-08-09: fica no
-- Postgres (tabelas de agregação), sem serviço gerenciado.
--
-- ⚠️ AGREGAÇÃO, não evento cru: uma linha por (métrica, janela de 1h). O envio
--    incrementa o balde da hora — não grava um registro por mensagem, senão a
--    própria telemetria vira o problema de escala que ela deveria vigiar.
--
-- Tabelas novas e aditivas; sob RLS como toda tabela de domínio (ADR-001).

CREATE TABLE metrica_janela (
    tenant_id  uuid        NOT NULL,
    metrica    text        NOT NULL,   -- 'envio_ok' | 'envio_falha' | ...
    bucket     timestamptz NOT NULL,   -- início da janela (date_trunc('hour'))
    valor      bigint      NOT NULL DEFAULT 0,

    PRIMARY KEY (tenant_id, metrica, bucket)
);
-- Leitura é sempre "esta métrica, janela recente": por (tenant, metrica, bucket).
CREATE INDEX metrica_janela_por_metrica ON metrica_janela (tenant_id, metrica, bucket DESC);

SELECT aplicar_rls('metrica_janela');

COMMENT ON TABLE metrica_janela IS
    'Série temporal técnica agregada por hora (I-11). Uma linha por (métrica, '
    'bucket); o envio incrementa o balde da hora. Sem evento cru.';

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE alerta (
    tenant_id    uuid        NOT NULL,
    id           uuid        NOT NULL,
    tipo         text        NOT NULL,   -- 'entrega_baixa' | ...
    severidade   text        NOT NULL,   -- 'aviso' | 'critico'
    mensagem     text        NOT NULL,
    criado_em    timestamptz NOT NULL DEFAULT now(),
    resolvido_em timestamptz,            -- NULL = aberto

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT alerta_severidade_valida CHECK (severidade IN ('aviso','critico'))
);
-- Lista, mais recente primeiro.
CREATE INDEX alerta_recente ON alerta (tenant_id, criado_em DESC);
-- ⚠️ Dedup: no máximo UM alerta ABERTO por tipo. Sem isso, uma queda de entrega
--    que dura 3 horas vira 3 alertas iguais e o operador para de olhar.
CREATE UNIQUE INDEX alerta_aberto_unico ON alerta (tenant_id, tipo) WHERE resolvido_em IS NULL;

SELECT aplicar_rls('alerta');

COMMENT ON TABLE alerta IS
    'Alertas técnicos (I-10). Índice parcial garante um aberto por tipo. '
    'A ação (avisar/pausar frota, MT-01) é decidida por quem lê a regra.';
