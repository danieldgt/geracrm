-- 0042_retencao_config.sql
--
-- Configuração do funil de recompra (ciclo de vida) — Onda 2. ⚠️ A fronteira
-- Ativo/Inativo/Perdido é POR DIAS SEM COMPRAR e precisa ser configurável pelo
-- DONO DO NEGÓCIO: o que é "inativo" para uma confecção (compra toda semana) não
-- é para uma revenda de máquinas (compra a cada semestre). Decisão de negócio,
-- não do desenvolvedor (skill funil-de-vendas).
--
-- Uma linha por tenant. Sem linha = usa os defaults no endpoint. ⚠️ Aditiva,
-- sob RLS, PK = tenant_id (config é única por tenant).

CREATE TABLE retencao_config (
    tenant_id     uuid        NOT NULL,
    -- Comprou nos últimos N dias → Ativo.
    dias_ativo    integer     NOT NULL DEFAULT 30,
    -- Entre dias_ativo e dias_inativo → Inativo; acima → Perdido.
    dias_inativo  integer     NOT NULL DEFAULT 90,
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_por uuid,

    PRIMARY KEY (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, atualizado_por) REFERENCES usuario (tenant_id, id),
    -- Ativo tem de vir antes de Inativo, senão a fronteira não faz sentido.
    CONSTRAINT retencao_faixas_coerentes CHECK (dias_ativo > 0 AND dias_inativo > dias_ativo)
);
SELECT aplicar_rls('retencao_config');

COMMENT ON TABLE retencao_config IS
    'Limiar do ciclo de vida (Ativo/Inativo/Perdido) por dias sem comprar. '
    'Configurável pelo dono do negócio. Uma linha por tenant; sem linha = default '
    '(30/90). Ver rotas-retencao.ts.';
