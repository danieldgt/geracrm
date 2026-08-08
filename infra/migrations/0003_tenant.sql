-- 0003_tenant.sql
--
-- A primeira tabela de domínio, e a raiz de todas as outras.
--
-- ⚠️ DEPENDÊNCIA CIRCULAR REAL, e é por isso que esta migration tem três atos:
--
--      tenant.perfil_vertical_id ──► perfil_vertical
--      perfil_vertical.tenant_id ──► tenant
--
--    Nenhuma das duas pode nascer com a FK completa. A ordem é:
--      ① cria `tenant` SEM a FK de perfil
--      ② cria `perfil_vertical`, que já pode apontar para `tenant`
--      ③ ALTER TABLE acrescenta a FK que faltava
--
--    Tentar resolver isso "criando as duas juntas" não funciona: Postgres
--    valida a FK na criação.

-- ---------------------------------------------------------------------------
-- ① tenant — sem a FK de perfil_vertical, ainda
-- ---------------------------------------------------------------------------

CREATE TABLE tenant (
    id                 uuid        PRIMARY KEY,
    nome               text        NOT NULL,
    -- Hierarquia para o painel de revenda (PLT-10, Onda 4). Nasce NULL e vazio:
    -- criar a coluna agora é gratuito; acrescentá-la depois, com base cheia,
    -- é migration de dado (ADR-001).
    tenant_pai_id      uuid        REFERENCES tenant(id),
    plano_id           uuid        NOT NULL REFERENCES plano(id),
    perfil_vertical_id uuid,       -- FK acrescentada no ato ③
    -- Fuso do tenant. ⚠️ Necessário para "conversas sem resposta às 18h" e para
    -- o corte diário do throttling significarem a mesma coisa que o cliente vê.
    fuso               text        NOT NULL DEFAULT 'America/Sao_Paulo',
    config             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ativo              boolean     NOT NULL DEFAULT true,
    criado_em          timestamptz NOT NULL DEFAULT now(),

    -- Um tenant não pode ser pai de si mesmo.
    CONSTRAINT tenant_nao_e_pai_de_si CHECK (tenant_pai_id IS DISTINCT FROM id)
);

COMMENT ON TABLE  tenant IS 'A empresa cliente. Raiz de todo dado de domínio.';
COMMENT ON COLUMN tenant.tenant_pai_id IS
    'Revenda (PLT-10, Onda 4). Nasce vazio — a coluna existe para não exigir '
    'migration de dado depois.';
COMMENT ON COLUMN tenant.fuso IS
    'Fuso do cliente. Sem isto, "sem resposta às 18h" e o corte diário do '
    'throttling significam horários diferentes do que o cliente enxerga.';

-- ⚠️ `tenant` é a única tabela de domínio cuja PK NÃO é composta.
--    Ela é o próprio tenant — não existe "tenant do tenant". A policy compara
--    id (não tenant_id) com tenant_atual().
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE  ROW LEVEL SECURITY;

CREATE POLICY isolamento_tenant ON tenant
    USING      (id = tenant_atual())
    WITH CHECK (id = tenant_atual());

-- ---------------------------------------------------------------------------
-- ② perfil_vertical — o perfil ativo deste tenant (ADR-004)
-- ---------------------------------------------------------------------------
-- Instância do molde de 0002, com os ajustes do cliente. Vive dentro do tenant,
-- então segue a chave composta padrão (ADR-016).

CREATE TABLE perfil_vertical (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id            uuid        NOT NULL,
    modelo_id     uuid        NOT NULL REFERENCES perfil_vertical_modelo(id),
    nome          text        NOT NULL,
    -- Os quatro blocos vêm do modelo e podem ser ajustados pelo cliente.
    rotulos       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    atributos     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    regras_pedido jsonb       NOT NULL DEFAULT '{}'::jsonb,
    faixas_rfv    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    criado_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)                    -- ADR-016
);

SELECT aplicar_rls('perfil_vertical');

COMMENT ON TABLE perfil_vertical IS
    'Perfil de vertical ativo do tenant (ADR-004). Instancia um modelo global '
    'e permite ajuste — regras de pedido mínimo e faixas de RFV variam por cliente.';

-- ---------------------------------------------------------------------------
-- ③ A FK que faltava
-- ---------------------------------------------------------------------------
-- ⚠️ FK COMPOSTA, não simples. `perfil_vertical` tem PK (tenant_id, id), então
--    a referência precisa carregar as duas colunas. Aqui a origem das duas é a
--    mesma linha de `tenant`: id serve como tenant_id.
--
--    É exatamente o custo que o ADR-016 aceitou — e o benefício aparece na
--    linha seguinte: é impossível apontar para o perfil de OUTRO tenant, porque
--    a FK não fecharia.

ALTER TABLE tenant
    ADD CONSTRAINT tenant_perfil_vertical_fk
    FOREIGN KEY (id, perfil_vertical_id)
    REFERENCES perfil_vertical (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED;

COMMENT ON CONSTRAINT tenant_perfil_vertical_fk ON tenant IS
    'FK composta: garante que o perfil apontado pertence ao próprio tenant. '
    'DEFERRABLE porque tenant e perfil nascem na mesma transação de onboarding.';

-- ---------------------------------------------------------------------------
-- assinatura_tenant — o que ESTE cliente paga (PLT-14)
-- ---------------------------------------------------------------------------
-- Distinto de `plano` (0002): plano é o cardápio, assinatura é a conta.
-- ⚠️ É o DENOMINADOR do ROI da ferramenta (BI-11). Sem ela, "o GeraCRM gerou
--    R$ X e custou R$ Y" não tem o Y.

CREATE TABLE assinatura_tenant (
    tenant_id      uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id             uuid        NOT NULL,
    plano_id       uuid        NOT NULL REFERENCES plano(id),
    valor_centavos bigint      NOT NULL,           -- inteiro, sempre
    ciclo          text        NOT NULL,           -- mensal | anual
    vigencia_de    date        NOT NULL,
    vigencia_ate   date,                           -- NULL = vigente
    criado_em      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT assinatura_ciclo_valido CHECK (ciclo IN ('mensal','anual')),
    CONSTRAINT assinatura_vigencia_coerente
        CHECK (vigencia_ate IS NULL OR vigencia_ate >= vigencia_de),
    -- ⚠️ Duas assinaturas vigentes ao mesmo tempo tornam o ROI ambíguo.
    --    daterange fechado-aberto: 20/jan–01/fev e 01/fev–01/mar não colidem.
    EXCLUDE USING gist (
        tenant_id WITH =,
        daterange(vigencia_de, vigencia_ate, '[)') WITH &&
    )
);

SELECT aplicar_rls('assinatura_tenant');

COMMENT ON TABLE assinatura_tenant IS
    'O que este cliente paga. Denominador do ROI da ferramenta (BI-11) e base do MRR. '
    'A restrição de exclusão impede vigências sobrepostas — sem ela o ROI fica ambíguo.';
