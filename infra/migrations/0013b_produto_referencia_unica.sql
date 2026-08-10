-- 0013b_produto_referencia_unica.sql
--
-- ⚠️ Faltava a garantia que torna a ingestão de catálogo idempotente.
--
--    Sem unicidade em (tenant_id, referencia), reimportar o catálogo cria um
--    segundo "CONJUNTO LAILA". Os SKUs se dividem entre os dois, e o histórico
--    de venda do produto passa a mostrar metade — sem nenhum erro aparecer.
--
--    A falha é silenciosa e só aparece semanas depois, quando alguém pergunta
--    por que o produto mais vendido sumiu do ranking.

CREATE UNIQUE INDEX produto_referencia_unica ON produto (tenant_id, referencia);

-- O índice antigo vira redundante: o único já serve as mesmas buscas.
DROP INDEX produto_por_referencia;

COMMENT ON INDEX produto_referencia_unica IS
    'A referência identifica o produto dentro do tenant. ⚠️ Se dois ERPs da '
    'mesma empresa usarem a mesma referência para produtos diferentes, a '
    'ingestão rejeita com motivo visível — melhor que unir dois produtos '
    'distintos em um só, que não tem conserto depois.';
