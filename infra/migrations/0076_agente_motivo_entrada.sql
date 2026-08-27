-- 0076_agente_motivo_entrada.sql
--
-- POR QUE O AGENTE ASSUMIU AQUELA CONVERSA.
--
-- ⚠️ A `agente_sessao` já registrava o motivo de SAÍDA. Faltava o de ENTRADA — e
--    ele passou a importar quando a regra deixou de ser "fora do expediente" e
--    virou "não há ninguém disponível" (0075): agora o agente pode assumir às
--    14h de uma terça, e "por que o robô falou com o meu cliente?" precisa de
--    resposta sem reconstruir o estado da equipe naquele minuto, que já passou.
--
-- Aditiva.

ALTER TABLE agente_sessao ADD COLUMN motivo_entrada text;

COMMENT ON COLUMN agente_sessao.motivo_entrada IS
    'Por que não havia ninguém para atender: fora do expediente, ninguém logado, '
    'todos ausentes. Fica ao lado do motivo de SAÍDA — juntos contam a história.';
