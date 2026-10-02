-- 0091_pedido_proposta.sql
--
-- PROPOR-E-CONFIRMAR COM ALÇADA (ADR-025, ADR-027) — o lado do banco.
--
-- ⚠️ Incidente de 27/08: um "sim" confirmou o pedido errado. O 0073 fechou a
--    pilha de pendentes e a janela de 24h; esta migration fecha o que faltava
--    para o AGENTE propor pedido sem repetir o incidente: o "sim" só confirma a
--    proposta cuja VERSÃO DE CONTEÚDO ainda é a atual. Mudou um item depois de
--    enviar o resumo, o "sim" não vale — e o vendedor é avisado.
--
-- Três blocos, todos aditivos:
--   ① contato.perfil_preco — o perfil DECLARADO do cliente (varejo/atacado).
--   ② pedido.origem e pedido.desconto_pct — quem montou e com que desconto.
--   ③ pedido_proposta — cada resumo enviado, com versão, expiração e quem
--      confirmou.
--
-- ⚠️ `contato.perfil_preco` também consta do plano da 0087 (catálogo manual).
--    As duas raias correm em paralelo contra o MESMO banco, então o bloco é
--    idempotente (IF NOT EXISTS + constraint guardada): qualquer uma das duas
--    pode chegar primeiro e a outra não quebra o deploy.

-- ---------------------------------------------------------------------------
-- ① Perfil de preço do contato
-- ---------------------------------------------------------------------------
ALTER TABLE contato ADD COLUMN IF NOT EXISTS perfil_preco text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contato_perfil_preco_valido') THEN
        ALTER TABLE contato ADD CONSTRAINT contato_perfil_preco_valido
            CHECK (perfil_preco IS NULL OR perfil_preco IN ('varejo', 'atacado'));
    END IF;
END
$$;

COMMENT ON COLUMN contato.perfil_preco IS
    'Perfil de preço DECLARADO do cliente (ADR-019/ADR-025): varejo ou atacado. '
    'NULL = não declarado, e aí vale PERFIL_PRECO_PADRAO (atacado). É por ele '
    'que a montagem de pedido e o agente cotam — o corpo da requisição nunca '
    'carrega preço.';

-- ---------------------------------------------------------------------------
-- ② Origem e desconto do pedido
-- ---------------------------------------------------------------------------
-- ⚠️ DEFAULT 'humano': tudo que existe hoje foi montado por gente. O agente
--    grava 'agente' ao criar o rascunho — e a lista mostra a diferença.
ALTER TABLE pedido ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'humano';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_origem_valida') THEN
        ALTER TABLE pedido ADD CONSTRAINT pedido_origem_valida
            CHECK (origem IN ('humano', 'agente'));
    END IF;
END
$$;

COMMENT ON COLUMN pedido.origem IS
    'Quem montou o rascunho: humano (console/app) ou agente (ADR-027). Decide se '
    'a alçada se aplica e aparece na lista para o vendedor saber o que o robô fez.';

-- ⚠️ Desconto é ZERO por padrão. A alçada do agente (ADR-027) compara este
--    número com `desconto_max_pct` — que também nasce zero. Um robô que "dá um
--    desconto para fechar" às 23h não acontece se o número não existir.
ALTER TABLE pedido ADD COLUMN IF NOT EXISTS desconto_pct numeric(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_desconto_pct_valido') THEN
        ALTER TABLE pedido ADD CONSTRAINT pedido_desconto_pct_valido
            CHECK (desconto_pct >= 0 AND desconto_pct <= 100);
    END IF;
END
$$;

COMMENT ON COLUMN pedido.desconto_pct IS
    'Desconto percentual aplicado ao pedido (0 a 100). Zero por padrão; acima do '
    'desconto_max_pct da alçada, o pedido confirmado espera um vendedor efetivar.';

-- ---------------------------------------------------------------------------
-- ③ A proposta enviada ao cliente
-- ---------------------------------------------------------------------------
-- Uma linha por resumo enviado. O "sim" confirma a proposta VIGENTE do pedido,
-- e só se `versao_conteudo` ainda for a do pedido.
--
-- ⚠️ `vigente` é booleano mantido pelo código, não derivado de `expira_em`:
--    índice parcial com `now()` não existe (a função não é IMMUTABLE), e a
--    unicidade "uma proposta viva por pedido" precisa de índice para valer sob
--    concorrência — duas propostas enviadas ao mesmo tempo não podem conviver.
CREATE TABLE pedido_proposta (
    tenant_id       uuid        NOT NULL,
    id              uuid        NOT NULL,
    pedido_id       uuid        NOT NULL,
    -- ⚠️ A versão do pedido NO MOMENTO do envio. Mudou um item depois, o "sim"
    --    do cliente é para outro conteúdo — não confirma (ADR-027).
    versao_conteudo integer     NOT NULL,
    resumo          text        NOT NULL,
    total_centavos  bigint      NOT NULL,
    enviada_em      timestamptz NOT NULL,
    expira_em       timestamptz NOT NULL,
    confirmada_em   timestamptz,
    confirmada_por  text,
    -- A mensagem saliente que levou o resumo (para auditoria e para o botão).
    mensagem_id     uuid,
    vigente         boolean     NOT NULL DEFAULT true,
    criado_em       timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, pedido_id) REFERENCES pedido (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT pedido_proposta_confirmada_por_valido CHECK (
        confirmada_por IS NULL OR confirmada_por IN ('cliente', 'vendedor')),
    -- Confirmada tem quem; não confirmada não tem.
    CONSTRAINT pedido_proposta_confirmacao_coerente CHECK (
        (confirmada_em IS NULL) = (confirmada_por IS NULL)),
    CONSTRAINT pedido_proposta_expira_depois CHECK (expira_em > enviada_em)
);

SELECT aplicar_rls('pedido_proposta');

-- ⚠️ UMA proposta vigente por pedido. Propor de novo invalida a anterior na
--    mesma transação; o índice é o que garante isso sob concorrência.
CREATE UNIQUE INDEX pedido_proposta_vigente_por_pedido
    ON pedido_proposta (tenant_id, pedido_id)
    WHERE vigente;

CREATE INDEX pedido_proposta_por_pedido
    ON pedido_proposta (tenant_id, pedido_id, criado_em DESC);

COMMENT ON TABLE pedido_proposta IS
    'Cada resumo de pedido enviado ao cliente (ADR-027). O "sim" confirma a '
    'proposta vigente, e só se versao_conteudo ainda for a do pedido. Expira em '
    '24h (mesma janela do 0073). Auditável junto de agente_decisao.';

COMMENT ON COLUMN pedido_proposta.vigente IS
    'A proposta atual do pedido. Propor de novo desliga a anterior. Mantido pelo '
    'código; o índice parcial garante no máximo uma por pedido.';
