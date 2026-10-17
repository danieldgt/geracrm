-- 0104_agente_modo_recorte.sql
--
-- MODO EFETIVO: RECORTE DO NÚMERO E TETO DO TENANT (ADR-028, raia P14).
--
--   agente_config.recorte — onde o modo do número vale: {horario, segmentosRfv,
--       foraDoRecorte}. NULL = sem recorte (o modo do número vale sempre).
--       Fora do recorte o modo efetivo CAI para `foraDoRecorte` (padrão sombra)
--       — nunca sobe. Formato validado na API (shared `recorteAgente`); o banco
--       só garante que é um objeto.
--   agente_tenant — o teto do tenant (`modo_maximo`): o kill switch geral.
--       Sem linha = sem teto ('autonomo'). "O mais restritivo vence" entre
--       tenant, número e recorte — a decisão é `decidirModoEfetivo` (shared).
--
-- ⚠️ Aditiva: coluna anulável e tabela nova. A versão anterior não as conhece
--    e segue funcionando (sem recorte, sem teto = o comportamento de hoje).

ALTER TABLE agente_config
    ADD COLUMN recorte jsonb NULL;
ALTER TABLE agente_config ADD CONSTRAINT agente_config_recorte_objeto
    CHECK (recorte IS NULL OR jsonb_typeof(recorte) = 'object') NOT VALID;
ALTER TABLE agente_config VALIDATE CONSTRAINT agente_config_recorte_objeto;

COMMENT ON COLUMN agente_config.recorte IS
    'Recorte do modo do número (ADR-028): {horario (mesmo formato do expediente; null = qualquer hora), '
    'segmentosRfv (vazio = todos), foraDoRecorte (desligado|sombra|assistido)}. NULL = sem recorte.';

CREATE TABLE agente_tenant (
    tenant_id      uuid        NOT NULL PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
    -- O modo mais solto que QUALQUER número do tenant pode ter. 'desligado' = kill switch geral.
    modo_maximo    text        NOT NULL DEFAULT 'autonomo',
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    -- usuario.id de quem mudou (NULL = sistema). A trilha completa fica em `auditoria`.
    atualizado_por uuid        NULL,
    CONSTRAINT agente_tenant_modo_valido CHECK (modo_maximo IN ('desligado', 'sombra', 'assistido', 'autonomo'))
);

SELECT aplicar_rls('agente_tenant');

COMMENT ON TABLE agente_tenant IS
    'Teto do modo do agente para o tenant inteiro (ADR-028): o mais restritivo entre tenant, número e recorte vence. '
    'Sem linha = autonomo (sem teto).';
