-- 0016b_mv_metricas_acesso.sql
--
-- Duas correções na `mv_metricas_contato`, que a 0016 deixou pela metade.
--
-- ⚠️ 1. VIEW MATERIALIZADA NÃO ACEITA RLS. Não é que a policy foi esquecida:
--       o Postgres não permite `CREATE POLICY` sobre matview, e o
--       `GRANT SELECT … TO geracrm_app` da 0016 deu ao papel da aplicação
--       leitura irrestrita de TODOS os tenants. O isolamento ficou dependendo
--       de toda consulta lembrar de filtrar — e "lembrar" não é mecanismo. Uma
--       consulta esquecida no dashboard mostra o faturamento de outra loja.
--
--       A correção não é documentar melhor: é tirar o acesso direto e expor a
--       MV por uma view com `security_barrier` que filtra por `tenant_atual()`.
--       Aí o filtro deixa de ser disciplina e volta a ser garantia.
--
-- ⚠️ 2. FALTAVAM `apurado_desde` E `confiavel`. Sem elas a média entre compras
--       mente para quem é cliente há mais tempo que a nossa carga: importados
--       12 meses, um cliente de 5 anos parece cliente de 12 meses, a "primeira
--       compra" é na verdade a primeira que importamos, e o ritmo dele sai
--       errado — justamente para os melhores clientes, que são os que mais
--       aparecem nas telas.
--
-- Recriar a MV é seguro: todo o conteúdo é derivado de `venda`.

DROP MATERIALIZED VIEW mv_metricas_contato;

CREATE MATERIALIZED VIEW mv_metricas_contato AS
WITH vendas_validas AS (
    SELECT tenant_id, contato_id, ocorrida_em, valor_centavos
      FROM venda
     WHERE contato_id IS NOT NULL
       AND cancelada_em IS NULL          -- venda cancelada não conta para RFV
),
-- ⚠️ A borda da carga, por tenant. É o que separa "cliente novo" de "cliente
--    antigo cujo começo não importamos".
borda AS (
    SELECT tenant_id, min(ocorrida_em) AS apurado_desde
      FROM vendas_validas
     GROUP BY tenant_id
),
agregado AS (
    SELECT
        tenant_id,
        contato_id,
        count(*)                    AS qtd_vendas,
        sum(valor_centavos)         AS total_centavos,
        min(ocorrida_em)            AS primeira_venda_em,
        max(ocorrida_em)            AS ultima_venda_em,
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
    b.apurado_desde,

    -- ⚠️ Confiável = dá para VER o começo da história dele. Se a primeira compra
    --    conhecida está colada na borda da carga, o histórico anterior existe e
    --    não está aqui: a média entre compras sai curta e o "atraso" sai
    --    inflado. A coluna viaja com o número para a tela poder dizer
    --    "estimativa" em vez de afirmar.
    (a.primeira_venda_em > b.apurado_desde + interval '1 day') AS confiavel,

    (now()::date - a.ultima_venda_em::date)               AS dias_sem_comprar,
    CASE WHEN a.qtd_vendas > 1
         THEN (a.ultima_venda_em::date - a.primeira_venda_em::date)::numeric
              / (a.qtd_vendas - 1)
    END                                                    AS media_entre_vendas_dias,
    CASE WHEN a.qtd_vendas > 1
          AND (a.ultima_venda_em::date - a.primeira_venda_em::date) > 0
         THEN (now()::date - a.ultima_venda_em::date)::numeric
              / ((a.ultima_venda_em::date - a.primeira_venda_em::date)::numeric
                 / (a.qtd_vendas - 1))
    END                                                    AS atraso_relativo
  FROM agregado a
  JOIN borda b USING (tenant_id);

CREATE UNIQUE INDEX mv_metricas_contato_pk
    ON mv_metricas_contato (tenant_id, contato_id);
CREATE INDEX mv_metricas_contato_recencia
    ON mv_metricas_contato (tenant_id, dias_sem_comprar DESC);
CREATE INDEX mv_metricas_contato_atraso
    ON mv_metricas_contato (tenant_id, atraso_relativo DESC NULLS LAST);
CREATE INDEX mv_metricas_contato_valor
    ON mv_metricas_contato (tenant_id, total_centavos DESC);

-- ⚠️ O papel da aplicação NÃO lê a MV direto. Este é o ponto da migration.
REVOKE ALL ON mv_metricas_contato FROM geracrm_app;

-- ---------------------------------------------------------------------------
-- A porta de entrada da aplicação.
--
-- ⚠️ `security_barrier` impede que o planejador empurre um predicado do
--    chamador para dentro da view antes do filtro de tenant. Sem a barreira,
--    uma função vazadora numa cláusula WHERE pode ser avaliada sobre linhas de
--    outros tenants — e o vazamento sai pela mensagem de erro, não pelo
--    resultado, então não aparece em teste que só confere linhas.
-- ---------------------------------------------------------------------------

CREATE VIEW metricas_contato WITH (security_barrier = true) AS
    SELECT * FROM mv_metricas_contato WHERE tenant_id = tenant_atual();

GRANT SELECT ON metricas_contato TO geracrm_app;

COMMENT ON VIEW metricas_contato IS
    'Única porta da aplicação para mv_metricas_contato. ⚠️ A MV não aceita RLS '
    '(limitação do Postgres, não esquecimento); o acesso direto foi revogado e o '
    'filtro por tenant vive aqui, com security_barrier. Consulta que precise da '
    'MV crua roda como dono, em worker, nunca no papel da API.';
COMMENT ON COLUMN mv_metricas_contato.confiavel IS
    '⚠️ Falso quando a primeira compra conhecida está colada na borda da carga: '
    'o histórico anterior existe e não está aqui, então a média entre compras sai '
    'curta e o atraso sai inflado — justo para os clientes mais antigos.';
