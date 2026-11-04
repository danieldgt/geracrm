-- 0141_pos_venda_reagendavel.sql
--
-- Revisão da G3 (M1): impedimento PASSAGEIRO não pode virar perda permanente.
-- Na 0130 o índice único do pós-venda valia em QUALQUER estado: uma ativa
-- cancelada (cliente escreveu, humano atendendo, fora do recorte) ou recusada
-- (template em análise) queimava o pedido + roteiro para sempre.
--
-- Agora a unicidade vale só para o que ESTÁ EM CURSO ou JÁ SAIU (`pendente`,
-- `enviado`): nunca duas na fila, nunca reenviar o que saiu. O motor pode
-- reagendar um pedido + roteiro encerrado sem envio, com teto de tentativas e
-- intervalo mínimo (`MAX_TENTATIVAS_POS_VENDA`, `RETENTATIVA_POS_VENDA_MS`) e só
-- dentro de `JANELA_POS_VENDA_DIAS`.
--
-- ⚠️ Ordem: cria o índice novo ANTES de remover o antigo — nunca há janela sem
--    unicidade. Remover o antigo é seguro com a versão anterior no ar: o código
--    dela insere com `ON CONFLICT DO NOTHING` SEM alvo (não nomeia o índice) e o
--    candidato exclui qualquer linha do pedido + roteiro, então com o índice
--    novo ela apenas não reagenda — nunca duplica (o índice novo cobre
--    pendente/enviado). Aditiva no comportamento.
-- ⚠️ `lock_timeout`: o CREATE/DROP INDEX pede lock na tabela; com o worker de
--    retornos escrevendo, esperar indefinidamente travaria o deploy. 5 s e falha
--    (o runner tenta de novo no próximo deploy).

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS agente_retorno_pos_venda_em_curso
    ON agente_retorno (tenant_id, pedido_id, roteiro)
    WHERE pedido_id IS NOT NULL AND estado IN ('pendente', 'enviado');

DROP INDEX IF EXISTS agente_retorno_pos_venda_unico;

-- O candidato do motor conta as tentativas do pedido + roteiro (qualquer estado).
CREATE INDEX IF NOT EXISTS agente_retorno_pos_venda_tentativas
    ON agente_retorno (tenant_id, pedido_id, roteiro)
    WHERE pedido_id IS NOT NULL;

COMMENT ON INDEX agente_retorno_pos_venda_em_curso IS
    'Pós-venda: no máximo UMA ativa em curso ou enviada por (pedido, roteiro). Encerrada sem envio '
    '(cancelada/recusada) pode ser reagendada pelo motor, com teto de tentativas.';
