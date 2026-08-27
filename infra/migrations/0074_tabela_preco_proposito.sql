-- 0074_tabela_preco_proposito.sql
--
-- O ERP DIZ QUAL TABELA É DE CUSTO — E NÓS JOGÁVAMOS FORA.
--
-- ⚠️ `tabela_preco` guardava só nome e `padrao`. O `tipo` (0 = custo, 1 = venda)
--    e o `status` (0 = ativa) do GeraCloud eram descartados na ingestão. Sem
--    eles, a escolha do preço no pedido assistido virou casamento de NOME:
--
--        WHERE tp.descricao ILIKE '%varejo%'
--          AND tp.descricao NOT ILIKE '%cfe%' AND tp.descricao NOT ILIKE '%teste%'
--
--    Os dois NOT ILIKE são remendos contra dados reais. E o buraco que eles não
--    tapam é o caro: basta existir uma tabela chamada "Custo Varejo" para o
--    produto cotar o CUSTO a um cliente, numa conversa de WhatsApp, expondo
--    margem. O ERP sabia a diferença o tempo todo.
--
-- ⚠️ Medido ao vivo em 2026-08-27 no ERP de produção: das 24 tabelas, 6 estão
--    ativas e 3 delas são de CUSTO. Nenhuma ativa casa com '%atacado%' — ou
--    seja, o perfil atacado hoje não acha preço nenhum e mostra "sem preço".
--
-- Aditiva, com default seguro: o que já está lá é tratado como VENDA e ATIVA,
-- que é o comportamento de hoje. A próxima sincronização corrige com a verdade.

ALTER TABLE tabela_preco ADD COLUMN proposito text    NOT NULL DEFAULT 'venda';
ALTER TABLE tabela_preco ADD COLUMN ativa     boolean NOT NULL DEFAULT true;

ALTER TABLE tabela_preco ADD CONSTRAINT tabela_preco_proposito_valido
    CHECK (proposito IN ('venda', 'custo'));

COMMENT ON COLUMN tabela_preco.proposito IS
    '⚠️ venda | custo — vem do ERP. Tabela de CUSTO nunca pode ser cotada a um '
    'cliente: é a margem da loja. Separar por nome já falhou.';

CREATE INDEX tabela_preco_cotavel
    ON tabela_preco (tenant_id, sistema) WHERE proposito = 'venda' AND ativa;
