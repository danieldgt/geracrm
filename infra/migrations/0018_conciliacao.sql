-- 0018_conciliacao.sql
--
-- ⚠️ Importar não é migrar.
--
--    O critério de saída nº 1 da Onda 0 exige a base "carregada E RECONCILIADA".
--    Sem esta tabela, a resposta para "a carga deu certo?" é a contagem de
--    linhas — que não prova nada: linha importada errada também conta.
--
--    Aqui fica a comparação entre o que ENTROU e o que o ERP DIZ, por período.
--    A divergência é o produto desta tabela; o zero é só o caso feliz.

CREATE TABLE conciliacao (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id            uuid        NOT NULL,
    conexao_id    uuid        NOT NULL,
    fluxo         text        NOT NULL,          -- customers | products | orders
    -- Recorte comparado. Mês é o padrão: menor que isso vira ruído, maior
    -- esconde o mês em que a divergência nasceu.
    periodo_de    date        NOT NULL,
    periodo_ate   date        NOT NULL,

    -- Os dois lados da comparação.
    total_erp        bigint,
    total_geracrm    bigint      NOT NULL DEFAULT 0,
    valor_erp_centavos     bigint,
    valor_geracrm_centavos bigint,

    -- ⚠️ Divergência em VALOR importa mais que em contagem: 3 vendas a menos
    --    pode ser cancelamento; R$ 40 mil a menos é erro de importação.
    divergencia_registros bigint GENERATED ALWAYS AS (
        coalesce(total_erp, 0) - total_geracrm
    ) STORED,
    divergencia_valor_centavos bigint GENERATED ALWAYS AS (
        coalesce(valor_erp_centavos, 0) - coalesce(valor_geracrm_centavos, 0)
    ) STORED,

    -- Amostra dos identificadores que estão de um lado e não do outro.
    -- ⚠️ Divergência sem exemplo não se investiga: "faltam 12" não diz quais.
    faltantes     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    excedentes    jsonb       NOT NULL DEFAULT '[]'::jsonb,

    estado        text        NOT NULL DEFAULT 'pendente',
    -- Quem conferiu e aceitou. É a assinatura que fecha o critério de saída.
    aceito_por    uuid,
    aceito_em     timestamptz,
    observacao    text,
    apurado_em    timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conexao_id) REFERENCES conexao_erp (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, aceito_por) REFERENCES usuario     (tenant_id, id),

    CONSTRAINT conciliacao_fluxo_valido CHECK (fluxo IN ('customers','products','orders')),
    CONSTRAINT conciliacao_periodo_coerente CHECK (periodo_ate >= periodo_de),
    CONSTRAINT conciliacao_estado_valido CHECK (estado IN (
        'pendente',      -- apurada, ninguém olhou
        'conferida',     -- bate, ou a divergência foi explicada e aceita
        'divergente'     -- ⚠️ precisa de ação antes de seguir
    )),
    -- ⚠️ Aceitar exige quem aceitou. "Conferida" sem responsável é carimbo.
    CONSTRAINT conciliacao_aceite_coerente CHECK (
        (estado = 'conferida' AND aceito_por IS NOT NULL AND aceito_em IS NOT NULL) OR
        (estado <> 'conferida')
    ),
    -- Uma apuração por período e fluxo; reapurar substitui.
    CONSTRAINT conciliacao_periodo_unico UNIQUE (tenant_id, conexao_id, fluxo, periodo_de)
);

SELECT aplicar_rls('conciliacao');

CREATE INDEX conciliacao_divergentes
    ON conciliacao (tenant_id, periodo_de DESC)
    WHERE estado = 'divergente';

COMMENT ON TABLE conciliacao IS
    'Comparação entre o que entrou e o que o ERP diz, por período. É o que '
    'transforma "importei" em "confiro que está certo" — critério de saída nº 1 '
    'da Onda 0.';
COMMENT ON COLUMN conciliacao.faltantes IS
    'Amostra dos ids presentes no ERP e ausentes aqui. ⚠️ "Faltam 12" não se '
    'investiga; "faltam estes 12" sim.';
COMMENT ON CONSTRAINT conciliacao_aceite_coerente ON conciliacao IS
    'Conferida exige responsável nomeado. Sem isso o aceite é carimbo, e ninguém '
    'responde pela base quando a divergência aparecer depois.';
