-- P0d — concessão com TTL do julgamento de uma sessão (worker de qualidade, P12).
--
-- Antes: o worker segurava `pg_try_advisory_lock` (de SESSÃO) pelo pool. Com pool > 1 o
-- unlock podia cair noutra conexão e a trava vazava presa numa conexão viva — o worker
-- parava em todas as instâncias. Segurar uma conexão reservada durante o juiz (até 45 s
-- por sessão) prenderia a única conexão do pool de aquisição, compartilhado por ~13 workers.
--
-- Agora: sob `pg_try_advisory_xact_lock` numa transação CURTA o worker só escolhe o lote e
-- grava uma linha por sessão aqui (dono do julgamento até `expira_em`). O juiz roda fora de
-- qualquer transação ou conexão presa; ao terminar, a linha sai pelo token. Instância que
-- morreu no meio: a linha expira e a sessão volta a ser escolhida. Mesmo padrão de
-- `copiloto_geracao` (0103).
--
-- Aditiva: tabela nova, nada que a versão anterior leia.

CREATE TABLE qualidade_juiz_concessao (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    sessao_id   uuid        NOT NULL,
    token       uuid        NOT NULL,
    expira_em   timestamptz NOT NULL,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, sessao_id),
    FOREIGN KEY (tenant_id, sessao_id) REFERENCES agente_sessao (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('qualidade_juiz_concessao');

COMMENT ON TABLE qualidade_juiz_concessao IS
    'P0d: concessão com TTL do julgamento de uma sessão pelo worker de qualidade (entre instâncias). Linha some ao terminar.';
