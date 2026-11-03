-- 0121_cadencia_descarte_reativacao.sql
--
-- DESCARTE APÓS A CADÊNCIA E REATIVAÇÃO 30/90 (raia G5, paridade com a AM).
--
-- Reaproveita `agente_retorno`: o descarte e a reativação são dois MOTIVOS novos
-- da mesma fila (mesmo worker, mesma política das ativas, mesma idempotência).
--   descarte_sem_resposta — último retorno enviado sem resposta + prazo → contato
--                           vai para Descartado, motivo `sem_resposta`. NÃO envia.
--   reativacao            — 30 e 90 dias depois do descarte, por template/texto.
--
-- `contato.descarte_motivo` registra POR QUE o contato foi descartado: só o
-- `sem_resposta` do sistema é reativável e reabre sozinho quando o cliente volta;
-- descarte manual (motivo NULL) nunca é reaberto pelo robô.
--
-- ⚠️ Aditiva: coluna nula nova e CHECK relaxado (a versão anterior só grava os
--    motivos antigos, todos aceitos). O CHECK é recriado NOT VALID + VALIDATE.

ALTER TABLE contato ADD COLUMN descarte_motivo text;

COMMENT ON COLUMN contato.descarte_motivo IS
    'Por que o contato está Descartado (qualificado = false): "sem_resposta" = fim da cadência '
    'de retornos sem resposta (sistema). NULL = descarte manual ou contato não descartado.';

ALTER TABLE agente_retorno DROP CONSTRAINT agente_retorno_motivo_valido;
ALTER TABLE agente_retorno ADD CONSTRAINT agente_retorno_motivo_valido
    CHECK (motivo IN ('proposta_sem_resposta', 'carrinho_abandonado', 'combinado',
                      'descarte_sem_resposta', 'reativacao')) NOT VALID;
ALTER TABLE agente_retorno VALIDATE CONSTRAINT agente_retorno_motivo_valido;
