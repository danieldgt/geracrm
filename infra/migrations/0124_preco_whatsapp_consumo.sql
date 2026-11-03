-- 0124_preco_whatsapp_consumo.sql
--
-- PREÇOS DO WHATSAPP, MAPEAMENTO DE VARIÁVEIS DO TEMPLATE E CONSUMO (F2, #79-#81).
--
--   preco_whatsapp          — preço por mensagem por categoria da Meta, por tenant.
--   template.mapeamento_variaveis — {{n}} -> campo do contato (lista fechada validada na API).
--   consumo_base()          — a regra de agregação diária (whatsapp | ia | transcricao).
--   mv_consumo_diario       — a mesma regra, materializada (13 meses) para a tela de Consumo.
--   consumo_diario          — a ÚNICA porta de leitura da MV para a aplicação (filtra o tenant).
--
-- ⚠️ Dinheiro em centavos inteiros. O câmbio é inteiro em MILÉSIMOS (5500 = R$ 5,500 por US$ 1):
--    nada de ponto flutuante em dinheiro. Ele é referência de conversão da tabela em US$ da Meta;
--    o preço efetivo é o `centavos_por_mensagem`.
-- ⚠️ A MV guarda QUANTIDADE para whatsapp e transcricao (segundos) e CUSTO FATO só para IA
--    (`agente_decisao.custo_centavos`). WhatsApp e transcricao são precificados na LEITURA com o
--    preço vigente: editar o preço reflete na hora, sem esperar o refresh e sem reescrever histórico.
-- ⚠️ Aditiva: tabela, coluna com default, função, MV e view novas. A versão anterior não as conhece.
-- ⚠️ MV não tem RLS. A aplicação NUNCA lê a MV: lê a view `consumo_diario`, que filtra por
--    `tenant_atual()`; o SELECT direto na MV é revogado do papel de aplicação.

-- ---------------------------------------------------------------------------
-- Preços
-- ---------------------------------------------------------------------------
CREATE TABLE preco_whatsapp (
    tenant_id               uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    categoria               text        NOT NULL,
    centavos_por_mensagem   integer     NOT NULL,
    -- Milésimos de R$ por US$ 1 (5500 = R$ 5,50). Gravado igual nas quatro linhas.
    cambio_usd_brl_milesimos integer    NOT NULL DEFAULT 5500,
    atualizado_em           timestamptz NOT NULL DEFAULT now(),
    atualizado_por          uuid,

    PRIMARY KEY (tenant_id, categoria),
    CONSTRAINT preco_whatsapp_categoria_valida CHECK (categoria IN ('marketing', 'utility', 'authentication', 'service')),
    CONSTRAINT preco_whatsapp_preco_valido CHECK (centavos_por_mensagem >= 0),
    CONSTRAINT preco_whatsapp_cambio_valido CHECK (cambio_usd_brl_milesimos > 0)
);

SELECT aplicar_rls('preco_whatsapp');

COMMENT ON TABLE preco_whatsapp IS
    'Preço por mensagem do WhatsApp Oficial por categoria (centavos de R$). Sem linha = padrão da API.';

-- ---------------------------------------------------------------------------
-- Mapeamento {{n}} -> campo do contato
-- ---------------------------------------------------------------------------
ALTER TABLE template
    ADD COLUMN mapeamento_variaveis jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT template_mapeamento_objeto CHECK (jsonb_typeof(mapeamento_variaveis) = 'object');

COMMENT ON COLUMN template.mapeamento_variaveis IS
    '{"1":"contato.nome","2":"contato.nome_fantasia"}: de onde sai cada {{n}} do corpo no envio. '
    'Campos válidos: lista fechada na API (rotas-template.ts).';

-- ---------------------------------------------------------------------------
-- A regra de agregação diária. Dia no FUSO do tenant (fuso inválido cai em São Paulo,
-- como fuso.ts) — a fronteira do mês é a do tenant, não a do servidor.
--
-- Colunas sem NULL (categoria/modelo '' e campanha_id nulo = uuid zero) porque o índice
-- único da REFRESH CONCURRENTLY não aceita expressão.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consumo_base(p_desde timestamptz)
RETURNS TABLE (tenant_id uuid, dia date, fonte text, categoria text, modelo text,
               campanha_id uuid, quantidade bigint, custo_centavos bigint)
LANGUAGE sql STABLE
SET search_path = public, pg_catalog   -- ⚠️ a MV e o REFRESH rodam com search_path restrito
AS $$
    WITH fuso AS (
        SELECT t.id AS tenant_id,
               coalesce((SELECT n.name FROM pg_timezone_names n WHERE n.name = t.fuso LIMIT 1),
                        'America/Sao_Paulo') AS fuso
          FROM tenant t),
    wa AS (
        -- Só o número OFICIAL custa. Mensagem de template = categoria do template; o resto é
        -- "service" (resposta dentro da janela de 24h). Falha/pendente não é cobrada.
        SELECT m.tenant_id,
               (m.criado_em AT TIME ZONE f.fuso)::date AS dia,
               'whatsapp'::text AS fonte,
               coalesce(lower(tp.categoria), 'service') AS categoria,
               ''::text AS modelo,
               coalesce(m.campanha_id, '00000000-0000-0000-0000-000000000000'::uuid) AS campanha_id,
               count(*)::bigint AS quantidade,
               0::bigint AS custo_centavos
          FROM mensagem m
          JOIN fuso f ON f.tenant_id = m.tenant_id
          JOIN conversa cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversa_id
          JOIN canal_conectado c ON c.tenant_id = cv.tenant_id AND c.id = cv.canal_id
          LEFT JOIN template tp ON tp.tenant_id = m.tenant_id AND tp.id = m.template_id
         WHERE m.criado_em >= p_desde
           AND m.direcao = 'saliente'
           AND m.status IN ('enviada', 'entregue', 'lida')
           AND c.tipo = 'whatsapp_oficial'
         GROUP BY 1, 2, 3, 4, 5, 6),
    ia AS (
        SELECT d.tenant_id,
               (d.criado_em AT TIME ZONE f.fuso)::date,
               'ia'::text,
               CASE d.modo WHEN 'simulacao' THEN 'simulacao'
                           WHEN 'sombra' THEN 'agente_sombra'
                           ELSE 'agente_vendedor' END,
               coalesce(d.modelo, ''),
               '00000000-0000-0000-0000-000000000000'::uuid,
               count(*)::bigint,
               coalesce(sum(d.custo_centavos), 0)::bigint
          FROM agente_decisao d
          JOIN fuso f ON f.tenant_id = d.tenant_id
         WHERE d.criado_em >= p_desde
         GROUP BY 1, 2, 3, 4, 5),
    juiz AS (
        SELECT a.tenant_id,
               (a.criado_em AT TIME ZONE f.fuso)::date,
               'ia'::text,
               'qualidade'::text,
               coalesce(a.modelo, ''),
               '00000000-0000-0000-0000-000000000000'::uuid,
               count(*)::bigint,
               coalesce(sum(a.custo_centavos), 0)::bigint
          FROM agente_avaliacao a
          JOIN fuso f ON f.tenant_id = a.tenant_id
         WHERE a.criado_em >= p_desde AND a.tipo = 'juiz'
         GROUP BY 1, 2, 3, 4, 5),
    tr AS (
        -- quantidade = SEGUNDOS de áudio transcrito (o worker grava transcricao_duracao_s).
        SELECT m.tenant_id,
               (m.criado_em AT TIME ZONE f.fuso)::date,
               'transcricao'::text,
               ''::text,
               ''::text,
               '00000000-0000-0000-0000-000000000000'::uuid,
               coalesce(sum((m.conteudo->>'transcricao_duracao_s')::numeric), 0)::bigint,
               0::bigint
          FROM mensagem m
          JOIN fuso f ON f.tenant_id = m.tenant_id
         WHERE m.criado_em >= p_desde
           AND m.direcao = 'entrante' AND m.tipo = 'audio'
           AND m.conteudo ? 'transcricao_duracao_s'
         GROUP BY 1, 2, 3, 4, 5, 6)
    SELECT * FROM wa
    UNION ALL SELECT * FROM ia
    UNION ALL SELECT * FROM juiz
    UNION ALL SELECT * FROM tr;
$$;

COMMENT ON FUNCTION consumo_base(timestamptz) IS
    'Agregação diária de consumo (whatsapp/ia/transcricao) desde o instante. SECURITY INVOKER: '
    'sob o papel de aplicação a RLS das tabelas de origem limita ao tenant; a MV a roda como dono.';

CREATE MATERIALIZED VIEW mv_consumo_diario AS
    SELECT * FROM consumo_base((date_trunc('month', now()) - interval '13 months'));

CREATE UNIQUE INDEX mv_consumo_diario_pk
    ON mv_consumo_diario (tenant_id, dia, fonte, categoria, modelo, campanha_id);

COMMENT ON MATERIALIZED VIEW mv_consumo_diario IS
    'Consumo diário por tenant (13 meses). Atualizada a cada 15 min pelo worker; o dia de hoje é '
    'completado ao vivo pela API. Whatsapp/transcricao: quantidade (custo na leitura); ia: custo fato.';

-- ⚠️ A MV não tem RLS: o papel de aplicação lê só pela view, que filtra o tenant.
REVOKE ALL ON mv_consumo_diario FROM geracrm_app;

CREATE VIEW consumo_diario WITH (security_barrier = true) AS
    SELECT * FROM mv_consumo_diario WHERE tenant_id = tenant_atual();

REVOKE ALL ON consumo_diario FROM geracrm_app;
GRANT SELECT ON consumo_diario TO geracrm_app;

CREATE OR REPLACE FUNCTION atualizar_consumo_diario()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_consumo_diario;
END;
$$;

COMMENT ON FUNCTION atualizar_consumo_diario() IS
    'Chamada pelo worker (workers/consumo.ts) como dono. CONCURRENTLY: não bloqueia a leitura.';
