-- 0040_meta.sql
--
-- Metas de venda (Onda 1 — gestão). Uma meta é um ALVO para um período mensal:
-- da equipe inteira (usuario_id NULL) ou de um vendedor específico. O REALIZADO
-- nunca é gravado aqui — é derivado das vendas do período (venda.usuario_id,
-- venda_por_usuario já indexa isso), senão nasceria uma segunda verdade sobre
-- faturamento, divergente da tabela de vendas na primeira venda cancelada.
--
-- Começa só com tipo 'faturamento' (o dado que temos, em centavos). O CHECK
-- deixa espaço para 'pedidos'/'novos_clientes' depois, sem migration de tipo.
--
-- ⚠️ Aditiva: tabela nova sob RLS, chave composta com tenant_id.

CREATE TABLE meta (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    usuario_id  uuid,       -- NULL = meta da EQUIPE (o tenant todo)
    ano         smallint    NOT NULL,
    mes         smallint    NOT NULL,
    tipo        text        NOT NULL DEFAULT 'faturamento',
    -- Alvo na unidade do tipo: centavos para 'faturamento', unidades para os demais.
    alvo        bigint      NOT NULL,
    criado_por  uuid,
    criado_em   timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, criado_por) REFERENCES usuario (tenant_id, id),
    CONSTRAINT meta_mes_valido  CHECK (mes BETWEEN 1 AND 12),
    CONSTRAINT meta_ano_valido  CHECK (ano BETWEEN 2000 AND 2100),
    CONSTRAINT meta_alvo_positivo CHECK (alvo > 0),
    CONSTRAINT meta_tipo_valido CHECK (tipo IN ('faturamento','pedidos','novos_clientes'))
);
SELECT aplicar_rls('meta');

-- Uma meta por vendedor, período e tipo. ⚠️ NULL não colide em UNIQUE comum, então
-- a meta da equipe precisa do seu PRÓPRIO índice parcial — senão daria para criar
-- duas metas de equipe para o mesmo mês.
CREATE UNIQUE INDEX meta_por_vendedor
    ON meta (tenant_id, usuario_id, ano, mes, tipo)
    WHERE usuario_id IS NOT NULL;
CREATE UNIQUE INDEX meta_da_equipe
    ON meta (tenant_id, ano, mes, tipo)
    WHERE usuario_id IS NULL;
-- Leitura quente: "as metas deste mês".
CREATE INDEX meta_por_periodo ON meta (tenant_id, ano, mes);

COMMENT ON TABLE meta IS
    'Alvo mensal de venda (equipe ou por vendedor). Realizado é derivado das '
    'vendas do período, nunca gravado. Ver rotas-meta.ts.';
COMMENT ON COLUMN meta.usuario_id IS 'NULL = meta da equipe inteira (o tenant).';
COMMENT ON COLUMN meta.alvo IS 'Centavos para tipo=faturamento; unidades para os demais.';
