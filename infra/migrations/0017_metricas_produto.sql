-- 0017_metricas_produto.sql
--
-- ⚠️ É A RÉGUA CONTRA A QUAL AS QUATRO ONDAS SEGUINTES SERÃO JULGADAS.
--
--    Sem `linha_base_metrica`, a medição do antes vira slide perdido no Drive e
--    não sobrevive ao primeiro "mas antes era pior mesmo?". Sem `tenant_marco`,
--    todo "antes e depois" é chute: ninguém lembra em que dia o time foi
--    avisado, e a comparação escorrega para o intervalo que favorece a resposta
--    desejada.
--
--    A tabela nasce agora porque a linha de base é medida ANTES do anúncio ao
--    time (ADR-017) — depois disso não existe mais "antes" para medir.

-- ---------------------------------------------------------------------------
-- linha_base_metrica — o número de antes, congelado.
-- ---------------------------------------------------------------------------

CREATE TABLE linha_base_metrica (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    metrica     text        NOT NULL,
    periodo_de  date        NOT NULL,
    periodo_ate date        NOT NULL,
    valor       numeric     NOT NULL,
    unidade     text        NOT NULL,

    -- De onde veio o número. ⚠️ "Planilha da gerente" é fonte legítima e muito
    --    comum; o que não pode é a fonte ficar implícita, porque é ela que
    --    decide quanto peso a comparação aguenta.
    fonte       text        NOT NULL,

    -- ⚠️ Confiabilidade DECLARADA. Uma linha de base fraca é útil — desde que a
    --    fraqueza viaje junto com o número. Sem esta coluna, a estimativa de
    --    hoje vira fato citado em reunião daqui a seis meses.
    confiavel   boolean     NOT NULL,
    ressalva    text,

    apurado_em  timestamptz NOT NULL DEFAULT now(),

    -- ⚠️ Congelamento com responsável. Linha de base que continua editável não
    --    é linha de base: quando o resultado decepciona, o "antes" melhora
    --    sozinho — e ninguém percebe, porque não sobra rastro.
    congelado_em  timestamptz,
    congelado_por uuid,

    PRIMARY KEY (tenant_id, metrica, periodo_de),
    FOREIGN KEY (tenant_id, congelado_por) REFERENCES usuario (tenant_id, id),

    CONSTRAINT linha_base_periodo_coerente CHECK (periodo_ate >= periodo_de),
    CONSTRAINT linha_base_congelamento_coerente CHECK (
        (congelado_em IS NULL AND congelado_por IS NULL) OR
        (congelado_em IS NOT NULL AND congelado_por IS NOT NULL)
    ),
    -- Número não confiável sem ressalva escrita é número não confiável que
    -- vai ser tratado como confiável.
    CONSTRAINT linha_base_ressalva_obrigatoria CHECK (confiavel OR ressalva IS NOT NULL)
);

SELECT aplicar_rls('linha_base_metrica');

COMMENT ON TABLE linha_base_metrica IS
    'O número de ANTES, por métrica e período. ⚠️ Medido antes do anúncio ao time '
    '(ADR-017) — depois disso não existe mais "antes" para medir.';
COMMENT ON COLUMN linha_base_metrica.confiavel IS
    '⚠️ Viaja junto com o número. Linha de base fraca é útil; linha de base fraca '
    'que parece forte é pior que nenhuma.';

-- ---------------------------------------------------------------------------
-- tenant_marco — as datas que separam o antes do depois.
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_marco (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    marco       text        NOT NULL,
    ocorrido_em timestamptz NOT NULL,
    observacao  text,
    registrado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, marco),
    CONSTRAINT tenant_marco_valido CHECK (marco IN (
        'medicao_iniciada',      -- começou a medir o antes
        'medicao_encerrada',     -- ⚠️ TEM de ser antes de 'time_avisado' (ADR-017)
        'time_avisado',
        'primeiro_numero_cortado',
        'base_reconciliada',
        'primeira_venda_atribuida'
    ))
);

SELECT aplicar_rls('tenant_marco');

COMMENT ON TABLE tenant_marco IS
    'As datas que separam o antes do depois. ⚠️ Sem elas todo "antes e depois" é '
    'chute: ninguém lembra em que dia o time foi avisado, e a janela de '
    'comparação escorrega para o intervalo que favorece a resposta desejada.';

-- ---------------------------------------------------------------------------
-- uso_diario_usuario — adoção real, por pessoa e superfície.
--
-- ⚠️ UPSERT por caso de uso de escrita, UMA linha por usuário/dia/superfície.
--    NÃO é pipeline de evento: a tabela genérica de "evento de produto" está
--    explicitamente proibida (§6.3 de `metricas`). Ela cresce sem limite, chega
--    cara antes de responder qualquer pergunta, e a pergunta que importa aqui é
--    simples — "quantas pessoas usaram, em quê, em que dia?".
--
--    A escrita só começa na Onda 1. A tabela nasce agora porque criá-la depois
--    obriga a reprocessar histórico que não foi guardado.
-- ---------------------------------------------------------------------------

CREATE TABLE uso_diario_usuario (
    tenant_id  uuid    NOT NULL,
    usuario_id uuid    NOT NULL,
    dia        date    NOT NULL,
    superficie text    NOT NULL,     -- 'inbox' | 'kanban' | 'fila_dia' | 'pedido' | 'mobile' | ...
    acoes      integer NOT NULL DEFAULT 1,
    primeiro_em timestamptz NOT NULL DEFAULT now(),
    ultimo_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, usuario_id, dia, superficie),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('uso_diario_usuario');

-- "Quantas pessoas usaram o inbox ontem?" sem varrer por usuário.
CREATE INDEX uso_diario_por_dia ON uso_diario_usuario (tenant_id, dia, superficie);

COMMENT ON TABLE uso_diario_usuario IS
    'Adoção real: uma linha por usuário/dia/superfície, via UPSERT. ⚠️ NÃO é '
    'pipeline de evento — a tabela genérica de evento de produto está proibida '
    '(§6.3 de metricas): cresce sem limite e fica cara antes de responder '
    'qualquer pergunta. Escrita começa na Onda 1.';
