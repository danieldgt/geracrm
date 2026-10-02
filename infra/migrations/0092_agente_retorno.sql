-- 0092_agente_retorno.sql
--
-- O RETORNO DO AGENTE (follow-up, plano-mestre §3.3 / R5): a cutucada
-- programada quando o cliente some depois de uma proposta ou deixa o carrinho.
--
-- ⚠️ Uma linha por TENTATIVA: enviar a primeira (1h) agenda a segunda (24h), e
--    a segunda agenda a terceira (72h). Fica o histórico de cada envio, e o
--    índice parcial garante UMA pendente por (conversa, motivo) — propor de
--    novo REAGENDA em vez de empilhar.
--
-- ⚠️ O envio passa pelo GATEWAY único (opt-out, pausa de disparo, janela de
--    24h). No oficial fora da janela o gateway recusa e a linha fica
--    `recusado` com o motivo — nunca forçamos template daqui.
--
-- ⚠️ Cliente escreveu → os pendentes da conversa viram `cancelado` na mesma
--    transação da ingestão: quem responde é o turno do agente, não a cutucada.

CREATE TABLE agente_retorno (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    conversa_id   uuid        NOT NULL,
    canal_id      uuid        NOT NULL,
    motivo        text        NOT NULL,
    executar_em   timestamptz NOT NULL,
    estado        text        NOT NULL DEFAULT 'pendente',
    -- 1, 2 ou 3: qual passo da cadência (1h → 24h → 72h) esta linha é.
    tentativa     smallint    NOT NULL DEFAULT 1,
    -- Texto fixo por motivo/tentativa; `combinado` pode trazer o texto do agente.
    texto         text,
    -- Por que terminou como terminou (recusa do gateway, modo do agente, etc.).
    detalhe       text,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    concluido_em  timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_retorno_motivo_valido
        CHECK (motivo IN ('proposta_sem_resposta', 'carrinho_abandonado', 'combinado')),
    CONSTRAINT agente_retorno_estado_valido
        CHECK (estado IN ('pendente', 'enviado', 'cancelado', 'recusado')),
    CONSTRAINT agente_retorno_tentativa_valida
        CHECK (tentativa BETWEEN 1 AND 3)
);

SELECT aplicar_rls('agente_retorno');

-- ⚠️ UMA pendente por (conversa, motivo): é o que permite o ON CONFLICT reagendar.
CREATE UNIQUE INDEX agente_retorno_um_pendente
    ON agente_retorno (tenant_id, conversa_id, motivo) WHERE estado = 'pendente';

-- A consulta do worker: os vencidos, em ordem. Parcial porque a tabela fica
-- dominada por concluídos.
CREATE INDEX agente_retorno_vencidos
    ON agente_retorno (executar_em) WHERE estado = 'pendente';

-- Histórico por conversa (tela "o que o robô fez").
CREATE INDEX agente_retorno_por_conversa
    ON agente_retorno (tenant_id, conversa_id, criado_em DESC);

COMMENT ON TABLE agente_retorno IS
    'Retorno programado do agente (follow-up): proposta sem resposta, carrinho '
    'abandonado ou combinado na conversa. Uma linha por tentativa (1h/24h/72h); '
    'enviado pelo gateway único; cancelado quando o cliente escreve de novo.';

COMMENT ON COLUMN agente_retorno.detalhe IS
    'Desfecho explicado: motivo da recusa do gateway (janela_fechada, bloqueado…), '
    'modo do agente que impediu, ou por que o motivo deixou de existir.';
