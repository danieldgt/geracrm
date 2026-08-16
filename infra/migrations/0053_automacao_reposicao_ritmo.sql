-- 0053_automacao_reposicao_ritmo.sql
--
-- Novo gatilho de automação: 'reposicao_ritmo' — a régua de recompra da skill
-- funil-de-vendas ("Reposição em 0,8 × média entre compras do cliente → oferecer
-- ANTES de ele precisar"). Dispara na JANELA DE ANTECIPAÇÃO (atraso_relativo entre
-- ~0,8 e ~1,0), não depois de já estar atrasado (isso é rfv_segmento/dias_sem_comprar).
--
-- ⚠️ Aditiva e segura: alterar CHECK é drop+add e só AMPLIA o conjunto de valores
--    permitidos — nenhuma linha existente passa a violar.

ALTER TABLE automacao DROP CONSTRAINT automacao_gatilho_valido;
ALTER TABLE automacao ADD CONSTRAINT automacao_gatilho_valido CHECK (gatilho IN (
    'rfv_segmento',
    'dias_sem_comprar',
    'lead_frio',
    'nps_detrator',
    'reposicao_ritmo'
));
