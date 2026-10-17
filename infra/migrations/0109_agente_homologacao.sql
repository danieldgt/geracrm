-- 0109_agente_homologacao.sql
--
-- CONFERÊNCIAS DE HOMOLOGAÇÃO do agente (plano-port-playbook-am, raia P19; ADR-031).
--
--   agente_homologacao — o que a fase de homologação mede e o banco não tinha:
--     douradas   — a última rodada das conversas douradas (evals P15), DIGITADA
--                  por um admin no painel: {cenarios, criticas};
--     smoke      — o último smoke do provedor, digitado: {ok};
--     playground — gravado pelo sistema a cada "Reiniciar" da simulação
--                  (DELETE /v1/canais/:id/agente/simular): UMA ENTRADA por
--                  reinício, {entradas: [{em, turnos, criticas}]}, contada das
--                  decisões que o próprio reinício apaga (DELETE … RETURNING).
--                  A CRÍTICA vem das marcas do turno pela régua da P12
--                  (`avaliacaoDasMarcas`). A soma usa só os últimos 30 dias depois
--                  da última publicação de playbook ou mudança de configuração
--                  do número, e só conversa com ≥ 3 decisões.
--     Uma linha por (tenant, número, item). douradas/smoke: a conferência
--     VIGENTE (vale 30 dias); a trilha de quem registrou o quê fica na
--     `auditoria` (`agente.go_live_conferencia`).
--
--   Índice parcial em `pedido` por conversa, só dos pedidos que contam como
--   conversão (confirmado ou efetivado): o painel testa EXISTS por conversa da
--   coorte e `pedido` não tinha índice por conversa fora do rascunho.
--
-- ⚠️ Aditiva: tabela nova e índice novo. A versão anterior da API não os conhece.
-- ⚠️ `pedido` ainda é pequena (dogfooding): o índice cabe na transação da
--    migration. Com volume, recriar CONCURRENTLY em migration própria.

CREATE TABLE agente_homologacao (
    tenant_id      uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    canal_id       uuid        NOT NULL,
    item           text        NOT NULL,
    resultado      jsonb       NOT NULL,
    -- Quem registrou (douradas/smoke) ou reiniciou o playground. NULL = sistema.
    -- Sem FK: `usuario` tem chave composta e ON DELETE SET NULL anularia o tenant_id.
    ator_id        uuid,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, canal_id, item),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_homologacao_item_valido CHECK (item IN ('douradas', 'smoke', 'playground')),
    CONSTRAINT agente_homologacao_resultado_objeto CHECK (jsonb_typeof(resultado) = 'object')
);

SELECT aplicar_rls('agente_homologacao');

COMMENT ON TABLE agente_homologacao IS
    'Homologação do agente por número (P19): douradas e smoke digitadas por admin (valem 30 dias); '
    'playground com uma entrada por reinício da simulação.';

CREATE INDEX pedido_conversao_por_conversa
    ON pedido (tenant_id, conversa_id)
    WHERE conversa_id IS NOT NULL AND (confirmado_em IS NOT NULL OR estado = 'efetivado');
