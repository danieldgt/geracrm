-- 0030_notificacao.sql
--
-- Notificações pessoais (PLT-07) — o canal do usuário (tenant:{T}:usuario:{U}).
-- Primeiro gatilho real: mensagem entrante numa conversa que VOCÊ assumiu.
--
-- ⚠️ Persistida (não só evento efêmero): o sino precisa sobreviver a recarga e
--    reconexão. O evento de tempo real só AVISA; o conteúdo vem por API sob RLS
--    (ADR-007). Tabela nova e aditiva.
--
-- ⚠️ Dedup por índice único PARCIAL: no máximo UMA notificação NÃO-LIDA por
--    (usuário, conversa). Sem isso, 50 mensagens seguidas viram 50 avisos e o
--    sino perde o sentido — queremos "1 conversa com novidade", não 50 linhas.

CREATE TABLE notificacao (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    usuario_id  uuid        NOT NULL,   -- destinatário
    tipo        text        NOT NULL,   -- 'mensagem.nova' | ...
    titulo      text        NOT NULL,
    conversa_id uuid,                   -- NULL = notificação sem conversa
    lida_em     timestamptz,            -- NULL = não lida
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, usuario_id)  REFERENCES usuario  (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE
);

-- Lista pessoal, mais recente primeiro (cursor por criado_em, id).
CREATE INDEX notificacao_por_usuario ON notificacao (tenant_id, usuario_id, criado_em DESC, id DESC);

-- Contador de não-lidas — leitura quente, resolvida pelo índice parcial.
CREATE INDEX notificacao_nao_lida ON notificacao (tenant_id, usuario_id) WHERE lida_em IS NULL;

-- ⚠️ Dedup: uma pendência por conversa/usuário. Chave composta com tenant_id.
CREATE UNIQUE INDEX notificacao_pendente_unica
    ON notificacao (tenant_id, usuario_id, conversa_id)
    WHERE lida_em IS NULL AND conversa_id IS NOT NULL;

SELECT aplicar_rls('notificacao');

COMMENT ON TABLE notificacao IS
    'Notificações pessoais (PLT-07). Persistidas; o evento de tempo real só '
    'avisa e o conteúdo vem por API sob RLS. Dedup por índice parcial: no '
    'máximo uma não-lida por (usuário, conversa).';
