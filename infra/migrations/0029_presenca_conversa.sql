-- 0029_presenca_conversa.sql
--
-- Presença na conversa (INB-18): "Eduarda está nesta conversa". Evita a colisão
-- de dois atendentes trabalhando o mesmo cliente sem saber.
--
-- ⚠️ Estado EFÊMERO com TTL LÓGICO: a linha vale enquanto `visto_em` for recente
--    (heartbeat por POST enquanto a conversa está aberta). Não há conexão viva
--    aqui — quem fecha a aba simplesmente para de bater o coração e a linha
--    "expira" pela leitura (filtrada por janela), sem depender de limpeza.
--    Tabela nova e aditiva; a versão anterior segue servindo sem ela.
--
-- Sem partição (tabela minúscula: no máximo um punhado de atendentes por
-- conversa aberta). Sob RLS como toda tabela de domínio (ADR-001).

CREATE TABLE presenca_conversa (
    tenant_id    uuid        NOT NULL,
    conversa_id  uuid        NOT NULL,
    usuario_id   uuid        NOT NULL,
    -- Último heartbeat. A leitura só considera "presente" quem bateu dentro da
    -- janela de TTL; a limpeza física é oportunista, não crítica.
    visto_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, conversa_id, usuario_id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, usuario_id)  REFERENCES usuario  (tenant_id, id) ON DELETE CASCADE
);

-- Leitura é sempre "quem está nesta conversa agora" → por (tenant, conversa).
CREATE INDEX presenca_por_conversa ON presenca_conversa (tenant_id, conversa_id, visto_em);

SELECT aplicar_rls('presenca_conversa');

COMMENT ON TABLE presenca_conversa IS
    'Presença efêmera por conversa (INB-18). Uma linha por atendente com a '
    'conversa aberta; vale enquanto visto_em está dentro do TTL lógico. Sem '
    'conteúdo — só quem está onde.';
