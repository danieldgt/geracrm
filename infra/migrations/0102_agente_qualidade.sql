-- 0102_agente_qualidade.sql
--
-- QUALIDADE EM PRODUÇÃO (ADR-031, raia P12).
--
--   agente_avaliacao — uma avaliação por (decisão, tipo):
--       tipo 'regras' — as regras determinísticas do turno (100% das decisões
--                       com resposta), lidas das marcas `agente_decisao.guardrails`;
--       tipo 'juiz'   — o juiz com rubrica (5 critérios 0–5 + justificativa ≤ 280),
--                       só na amostra estável, no fim da sessão e a cada 10 turnos.
--     UNIQUE (tenant_id, decisao_id, tipo): o worker é idempotente — rodar a
--     passada duas vezes não avalia (nem cobra) duas vezes.
--   agente_config.qualidade_amostra — fração 0..1 das conversas que o juiz vê.
--       NULL = padrão do modo (sombra 1,0 · assistido 0,2 · autônomo 0,05).
--   agente_config.qualidade_teto_mes_centavos — teto MENSAL do custo do juiz no
--       número. NULL = padrão do ambiente (IA_QUALIDADE_TETO_MES_CENTAVOS); 0 = juiz desligado.
--
-- ⚠️ Aditiva: tabela nova e colunas anuláveis; a versão anterior não as conhece.
-- ⚠️ CHECK das colunas novas em duas etapas (NOT VALID + VALIDATE).
-- ⚠️ Sem PII: violações e justificativas chegam MASCARADAS (shared
--    `mascararTextoQualidade`); nada de telefone/CPF/CNPJ/e-mail aqui.

CREATE TABLE agente_avaliacao (
    tenant_id       uuid        NOT NULL,
    id              uuid        NOT NULL,
    decisao_id      uuid        NOT NULL,
    conversa_id     uuid        NOT NULL,
    canal_id        uuid        NOT NULL,
    sessao_id       uuid,
    -- 'agente' = o agente falou com o cliente (autônomo); 'sugestao' = sombra/assistido/copiloto.
    origem          text        NOT NULL,
    tipo            text        NOT NULL,
    gatilho         text        NOT NULL,
    -- [{regra, gravidade, trecho (≤160, mascarado), detalhe?, corrigida?}]
    violacoes       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- Pior gravidade do que ESCAPOU (as marcas corrigidas pelo pipeline não contam).
    pior_gravidade  text,
    -- {criterio: nota 0..5}
    notas           jsonb,
    -- {criterio: justificativa ≤280, mascarada}
    justificativas  jsonb,
    nota_media      numeric(3,2),
    acao            text,
    modelo          text,
    custo_centavos  bigint      NOT NULL DEFAULT 0,
    -- Turnos da sessão quando o juiz avaliou (decide o próximo "a cada 10").
    turnos          integer,
    -- O juiz falhou (fornecedor, formato): fica registrado, sem nota; POST /avaliar refaz.
    erro            text,
    criado_em       timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, decisao_id)  REFERENCES agente_decisao (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_avaliacao_uma_por_tipo UNIQUE (tenant_id, decisao_id, tipo),
    CONSTRAINT agente_avaliacao_origem_valida CHECK (origem IN ('agente', 'sugestao')),
    CONSTRAINT agente_avaliacao_tipo_valido CHECK (tipo IN ('regras', 'juiz')),
    CONSTRAINT agente_avaliacao_gatilho_valido CHECK (gatilho IN ('turno', 'fim_sessao', 'turnos', 'manual')),
    CONSTRAINT agente_avaliacao_gravidade_valida CHECK (pior_gravidade IS NULL OR pior_gravidade IN ('CRITICA', 'ALTA', 'MEDIA')),
    CONSTRAINT agente_avaliacao_acao_valida CHECK (acao IS NULL OR acao IN ('pausa_humano', 'nao_envie', 'registrado')),
    CONSTRAINT agente_avaliacao_nota_valida CHECK (nota_media IS NULL OR nota_media BETWEEN 0 AND 5),
    CONSTRAINT agente_avaliacao_custo_valido CHECK (custo_centavos >= 0),
    CONSTRAINT agente_avaliacao_violacoes_lista CHECK (jsonb_typeof(violacoes) = 'array'),
    -- Juiz tem nota OU erro; regras não têm nota.
    CONSTRAINT agente_avaliacao_coerente CHECK (
        (tipo = 'regras' AND nota_media IS NULL AND notas IS NULL) OR
        (tipo = 'juiz' AND ((nota_media IS NOT NULL AND notas IS NOT NULL) OR erro IS NOT NULL)))
);

SELECT aplicar_rls('agente_avaliacao');

-- Lista da tela (cursor por criado_em, id) e por número.
CREATE INDEX agente_avaliacao_recente   ON agente_avaliacao (tenant_id, criado_em DESC, id DESC);
CREATE INDEX agente_avaliacao_por_canal ON agente_avaliacao (tenant_id, canal_id, criado_em DESC, id DESC);
CREATE INDEX agente_avaliacao_por_sessao ON agente_avaliacao (tenant_id, sessao_id, tipo) WHERE sessao_id IS NOT NULL;
-- Gasto do juiz no mês por número (teto).
CREATE INDEX agente_avaliacao_custo_juiz ON agente_avaliacao (tenant_id, canal_id, criado_em) INCLUDE (custo_centavos) WHERE tipo = 'juiz';

-- O worker varre agente_decisao e agente_sessao de TODOS os tenants a cada minuto:
--   regras pendentes → decisões recentes com resposta (parcial, sem tenant na frente);
--   última decisão da sessão e transcrição → por (tenant, sessão, criado_em);
--   candidatas ao juiz → sessões recentes por iniciada_em.
CREATE INDEX agente_decisao_com_resposta ON agente_decisao (criado_em) WHERE resposta IS NOT NULL;
CREATE INDEX agente_decisao_por_sessao   ON agente_decisao (tenant_id, sessao_id, criado_em DESC);
CREATE INDEX agente_sessao_recente       ON agente_sessao (iniciada_em);

COMMENT ON TABLE agente_avaliacao IS
    'Qualidade em produção (ADR-031): regras em 100% das decisões e juiz com rubrica na amostra estável. '
    'Idempotente por (decisão, tipo). Trechos e justificativas mascarados.';

-- A MESMA fração estável do shared (`fracaoEstavel`, FNV-1a 32 bits → [0,1)),
-- para o worker escolher no SQL só as sessões da amostra — sem isso, as fora
-- da amostra voltariam a cada passada e ocupariam o lote. Igualdade com o
-- TypeScript conferida em teste. ⚠️ Bytes UTF-8 = unidades UTF-16 só em ASCII:
-- serve para ids (UUID), não para texto livre.
CREATE FUNCTION qualidade_fracao_estavel(chave text) RETURNS double precision
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    h bigint := 2166136261;
    b bytea := convert_to(chave, 'UTF8');
BEGIN
    FOR i IN 0 .. length(b) - 1 LOOP
        h := ((h # get_byte(b, i)) * 16777619) % 4294967296;
    END LOOP;
    RETURN h::double precision / 4294967296;
END $$;

COMMENT ON FUNCTION qualidade_fracao_estavel(text) IS
    'FNV-1a 32 bits do texto (ASCII) → [0,1). Igual a fracaoEstavel do @geracrm/shared: amostra estável do juiz (ADR-031).';

ALTER TABLE agente_config
    ADD COLUMN qualidade_amostra numeric(4,3) NULL,
    ADD COLUMN qualidade_teto_mes_centavos bigint NULL;
ALTER TABLE agente_config ADD CONSTRAINT agente_config_qualidade_amostra_valida
    CHECK (qualidade_amostra IS NULL OR qualidade_amostra BETWEEN 0 AND 1) NOT VALID;
ALTER TABLE agente_config VALIDATE CONSTRAINT agente_config_qualidade_amostra_valida;
ALTER TABLE agente_config ADD CONSTRAINT agente_config_qualidade_teto_valido
    CHECK (qualidade_teto_mes_centavos IS NULL OR qualidade_teto_mes_centavos >= 0) NOT VALID;
ALTER TABLE agente_config VALIDATE CONSTRAINT agente_config_qualidade_teto_valido;

COMMENT ON COLUMN agente_config.qualidade_amostra IS
    'Fração 0..1 das conversas que o juiz de qualidade avalia (hash estável do id). NULL = padrão do modo.';
COMMENT ON COLUMN agente_config.qualidade_teto_mes_centavos IS
    'Teto mensal (centavos de R$) do custo do juiz de qualidade neste número. NULL = IA_QUALIDADE_TETO_MES_CENTAVOS; 0 = juiz desligado.';
