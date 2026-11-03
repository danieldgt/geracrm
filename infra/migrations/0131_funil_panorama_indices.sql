-- 0131_funil_panorama_indices.sql
--
-- Raia B1 (panorama do funil). ADITIVA: só índices novos; a versão anterior da API segue atendendo.
--
-- O panorama agrega oportunidades por responsável (e, via usuario_filial, por filial):
--   * abertas por responsável e etapa  -> índice parcial das ABERTAS (a carteira viva, pequena);
--   * ganhas/perdidas do mês           -> índice parcial das FECHADAS por data de fechamento.
-- Sem eles, cada abertura do panorama varreria todas as oportunidades do tenant (coluna com 11 mil cards).

CREATE INDEX IF NOT EXISTS oportunidade_abertas_por_responsavel
    ON oportunidade (tenant_id, responsavel_id, etapa_id)
    WHERE estado = 'aberta';

CREATE INDEX IF NOT EXISTS oportunidade_fechadas_por_data
    ON oportunidade (tenant_id, fechada_em, responsavel_id)
    WHERE estado IN ('ganha', 'perdida');

-- Filtro "etiqueta" do board parte da etiqueta e chega ao contato: contato_etiqueta_por_etiqueta (0113) já cobre.
-- Filtro "origem": contatos de uma origem.
CREATE INDEX IF NOT EXISTS contato_por_origem ON contato (tenant_id, origem_id) WHERE origem_id IS NOT NULL;
