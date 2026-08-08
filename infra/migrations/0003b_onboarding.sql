-- 0003b_onboarding.sql
--
-- O estado do assistente de configuração inicial (B-02 da revisão).
--
-- ⚠️ Entra ANTES de E3-01 (Embedded Signup) de propósito. Descobrir na semana 5
--    que o onboarding precisa de tabela significaria migration no meio da onda
--    e endpoint fora de um contrato já congelado.
--
-- ⚠️ O estado é DO SERVIDOR, não do navegador. `localStorage` é o erro clássico:
--    o admin abre o popup da Meta, fecha a aba por engano, e sem estado no
--    servidor perde tudo — inclusive uma conexão que JÁ EXISTE do lado da Meta.

CREATE TABLE onboarding_passo (
    tenant_id            uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    passo                text        NOT NULL,
    estado               text        NOT NULL DEFAULT 'pendente',
    -- Dados do passo: id da conexão criada, telefone informado, capacidades
    -- apresentadas. Varia por passo, por isso jsonb.
    dados                jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Motivo da falha, quando estado = 'falhou'. ⚠️ Texto para a tela nomear o
    -- problema, não string crua de terceiro.
    falha_motivo         text,
    concluido_em         timestamptz,
    concluido_por        uuid,       -- usuário; FK entra em 0005
    -- ⚠️ Staff da Gera3 concluindo passo pelo cliente é acesso cross-tenant e
    --    precisa aparecer na auditoria. Sem esta coluna, "quem configurou?"
    --    não tem resposta.
    concluido_por_staff  boolean     NOT NULL DEFAULT false,
    atualizado_em        timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, passo),

    CONSTRAINT onboarding_passo_valido CHECK (passo IN (
        'empresa',            -- dados da empresa
        'canal_whatsapp',     -- Embedded Signup concluído
        'pagamento_meta',     -- ⚠️ sem isto o número NÃO envia (ADR-002)
        'erp',                -- conexão do ERP autenticada
        'aceite_capacidades', -- ⚠️ a data em que o admin foi informado (ADR-008)
        'carga_historica'     -- importação inicial concluída
    )),
    CONSTRAINT onboarding_estado_valido CHECK (estado IN (
        'pendente', 'em_andamento', 'concluido', 'falhou', 'dispensado'
    )),
    -- Coerência: concluído tem data; não concluído não tem.
    CONSTRAINT onboarding_conclusao_coerente CHECK (
        (estado = 'concluido' AND concluido_em IS NOT NULL) OR
        (estado <> 'concluido' AND concluido_em IS NULL)
    )
);

SELECT aplicar_rls('onboarding_passo');

-- O banner de "configuração pendente" pergunta: qual é o próximo passo aberto?
CREATE INDEX onboarding_passo_pendentes
    ON onboarding_passo (tenant_id)
    WHERE estado IN ('pendente', 'em_andamento', 'falhou');

COMMENT ON TABLE onboarding_passo IS
    'Estado retomável do assistente de configuração. É do servidor porque o '
    'admin fecha a aba no meio do fluxo da Meta e precisa continuar de onde parou.';
COMMENT ON COLUMN onboarding_passo.passo IS
    'aceite_capacidades guarda A DATA em que o admin foi informado do que aquele '
    'ERP habilita (ADR-008). Sem esse registro, quando ele reclamar que "o saldo '
    'está errado", não há como mostrar que a limitação foi apresentada.';
COMMENT ON COLUMN onboarding_passo.concluido_por_staff IS
    'Passo concluído pelo staff da Gera3, não pelo cliente. Acesso cross-tenant '
    'é sempre auditado.';
