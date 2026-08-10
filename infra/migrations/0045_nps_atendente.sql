-- 0045_nps_atendente.sql
--
-- NPS é pós-conversa: a nota avalia o ATENDIMENTO de um vendedor. Adiciona o
-- atendente avaliado à resposta, para o painel mostrar o NPS POR ATENDENTE.
--
-- ⚠️ Aditiva: coluna nova, nullable (respostas antigas/avulsas não têm dono do
-- atendimento). FK ao usuario do mesmo tenant. Índice para o agrupamento.

ALTER TABLE nps_resposta ADD COLUMN atendente_id uuid;

ALTER TABLE nps_resposta
    ADD CONSTRAINT nps_resposta_atendente_fk
    FOREIGN KEY (tenant_id, atendente_id) REFERENCES usuario (tenant_id, id) ON DELETE SET NULL;

-- "NPS deste atendente no período".
CREATE INDEX nps_por_atendente ON nps_resposta (tenant_id, atendente_id, respondido_em DESC)
    WHERE atendente_id IS NOT NULL;

COMMENT ON COLUMN nps_resposta.atendente_id IS
    'Vendedor avaliado (a conversa que originou a nota). NULL = resposta avulsa '
    'sem atendimento associado. Base do painel de NPS por atendente.';
