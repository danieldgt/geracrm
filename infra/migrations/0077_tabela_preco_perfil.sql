-- 0077_tabela_preco_perfil.sql
--
-- QUAL TABELA É VAREJO E QUAL É ATACADO — dito, não adivinhado.
--
-- ⚠️ A escolha do preço era por semelhança de NOME:
--
--       WHERE tp.descricao ILIKE '%varejo%'
--         AND tp.descricao NOT ILIKE '%cfe%' AND tp.descricao NOT ILIKE '%teste%'
--
--    Os dois NOT ILIKE são remendos contra dados reais, e o mecanismo é frágil
--    por natureza: renomear a tabela no ERP quebra o preço do produto, sem erro
--    nenhum. O `0074` fechou o risco pior (cotar CUSTO ao cliente) usando o que
--    o ERP declara, mas o vínculo perfil→tabela continuou por texto.
--
-- ⚠️ E há um sintoma vivo: no ERP de produção NENHUMA tabela ativa casa com
--    '%atacado%' — as duas de atacado estão inativas. O perfil atacado devolve
--    "sem preço" para tudo, num CRM cujo caso principal é B2B (ADR-019).
--
-- ⚠️ Isto é DECLARAÇÃO do dono da loja, não dedução nossa: só ele sabe qual
--    tabela pratica o preço de atacado. Enquanto ele não declarar, o nome
--    continua valendo como palpite — degradação, não erro.
--
-- Aditiva.

ALTER TABLE tabela_preco ADD COLUMN perfil text;

ALTER TABLE tabela_preco ADD CONSTRAINT tabela_preco_perfil_valido
    CHECK (perfil IS NULL OR perfil IN ('varejo', 'atacado'));

COMMENT ON COLUMN tabela_preco.perfil IS
    '⚠️ Declarado pelo dono da loja: qual tabela pratica varejo e qual pratica '
    'atacado. NULL = não declarado, e aí o nome vale como palpite. Só tabela de '
    'VENDA e ATIVA (0074) pode ser declarada — cotar custo é o risco que aquela '
    'migration fechou.';

-- ⚠️ UMA tabela por perfil, por conexão. Duas declaradas como varejo fariam a
--    escolha voltar a ser arbitrária — que é exatamente o que esta migration
--    existe para eliminar.
CREATE UNIQUE INDEX tabela_preco_um_por_perfil
    ON tabela_preco (tenant_id, sistema, perfil) WHERE perfil IS NOT NULL;
