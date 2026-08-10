-- 0016_mv_metricas_contato.sql
--
-- As métricas por cliente que alimentam RFV, kanban, ficha e Fila do Dia.
--
-- ⚠️ View materializada, não consulta ao vivo. Calcular "média entre vendas" de
--    30 mil clientes a cada abertura de tela é o caminho para o inbox travar —
--    e o inbox é a tela que não pode piscar.
--
-- ⚠️ E não é view comum: o kanban ORDENA por estes números. Uma view comum
--    recalcularia tudo a cada rolagem de coluna.

CREATE MATERIALIZED VIEW mv_metricas_contato AS
WITH vendas_validas AS (
    SELECT tenant_id, contato_id, ocorrida_em, valor_centavos
      FROM venda
     WHERE contato_id IS NOT NULL
       AND cancelada_em IS NULL          -- ⚠️ venda cancelada não conta para RFV
),
agregado AS (
    SELECT
        tenant_id,
        contato_id,
        count(*)                    AS qtd_vendas,
        sum(valor_centavos)         AS total_centavos,
        min(ocorrida_em)            AS primeira_venda_em,
        max(ocorrida_em)            AS ultima_venda_em,
        -- Ticket médio em centavos, arredondado — o domínio é inteiro.
        round(avg(valor_centavos))  AS ticket_medio_centavos
      FROM vendas_validas
     GROUP BY tenant_id, contato_id
)
SELECT
    a.tenant_id,
    a.contato_id,
    a.qtd_vendas,
    a.total_centavos,
    a.primeira_venda_em,
    a.ultima_venda_em,
    a.ticket_medio_centavos,
    -- Dias desde a última compra. É a Recência do RFV.
    (now()::date - a.ultima_venda_em::date)               AS dias_sem_comprar,
    -- ⚠️ Média entre compras do PRÓPRIO cliente. Só existe com 2+ compras:
    --    com uma só, não há intervalo — e inventar um (usando a data de
    --    cadastro, por exemplo) produziria um "atraso" fictício.
    CASE WHEN a.qtd_vendas > 1
         THEN (a.ultima_venda_em::date - a.primeira_venda_em::date)::numeric
              / (a.qtd_vendas - 1)
    END                                                    AS media_entre_vendas_dias,
    -- ⚠️ A razão que a predição explicável usa (RFV-10). Comparada ao ritmo
    --    DELE, nunca a uma média geral: quem compra a cada 90 dias não está
    --    atrasado aos 60, e uma régua única erraria os dois extremos.
    CASE WHEN a.qtd_vendas > 1
          AND (a.ultima_venda_em::date - a.primeira_venda_em::date) > 0
         THEN (now()::date - a.ultima_venda_em::date)::numeric
              / ((a.ultima_venda_em::date - a.primeira_venda_em::date)::numeric
                 / (a.qtd_vendas - 1))
    END                                                    AS atraso_relativo
  FROM agregado a;

-- ⚠️ Índice ÚNICO é obrigatório para REFRESH CONCURRENTLY. Sem ele, o refresh
--    trava a view inteira — e a atualização acontece em horário comercial.
CREATE UNIQUE INDEX mv_metricas_contato_pk
    ON mv_metricas_contato (tenant_id, contato_id);

-- Ordenações do kanban e da Fila do Dia.
CREATE INDEX mv_metricas_contato_recencia
    ON mv_metricas_contato (tenant_id, dias_sem_comprar DESC);
CREATE INDEX mv_metricas_contato_atraso
    ON mv_metricas_contato (tenant_id, atraso_relativo DESC NULLS LAST);
CREATE INDEX mv_metricas_contato_valor
    ON mv_metricas_contato (tenant_id, total_centavos DESC);

COMMENT ON MATERIALIZED VIEW mv_metricas_contato IS
    'Métricas por cliente para RFV, kanban e Fila do Dia. Materializada porque o '
    'kanban ORDENA por elas — view comum recalcularia a cada rolagem.';

-- ⚠️ RLS não se aplica a view materializada. O isolamento vem de tenant_id
--    estar na chave e TODA consulta filtrar por ele — o que a camada garante.
--    Registrado aqui para quem for consultar direto não presumir proteção.
GRANT SELECT ON mv_metricas_contato TO geracrm_app;

-- Atualização. ⚠️ CONCURRENTLY para não bloquear leitura durante o refresh.
CREATE OR REPLACE FUNCTION atualizar_metricas_contato()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_metricas_contato;
END;
$$;

COMMENT ON FUNCTION atualizar_metricas_contato() IS
    'Chamada por worker agendado. CONCURRENTLY exige o índice único e não '
    'bloqueia leitura — o refresh roda em horário comercial.';
