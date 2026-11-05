-- 0140_importacao_simulada_em.sql
--
-- Marca de SIMULAÇÃO COMPLETA (revisão da H1). A simulação é síncrona e grava itens em pedaços; se a requisição
-- morre no meio, a importação fica `simulada` com itens parciais. `simulada_em` só é preenchida no FIM da
-- simulação, e `executar` exige que esteja preenchida (409 `importacao.simulacao_incompleta`).
--
-- ⚠️ Aditiva: coluna anulável sem DEFAULT. A versão anterior da API ignora. Importações já simuladas antes
--    desta migration ficam NULL e precisam ser simuladas de novo (expiram em 24 h de qualquer forma).

ALTER TABLE importacao ADD COLUMN IF NOT EXISTS simulada_em timestamptz;

COMMENT ON COLUMN importacao.simulada_em IS 'Fim da simulação (itens completos). NULL = simulação incompleta: não executa.';
