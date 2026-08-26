-- 0072_agente_extracao.sql
--
-- O QUE O AGENTE EXTRAIU — e o que ele tentou extrair e foi RECUSADO.
--
-- ⚠️ Na fatia 1 o agente não escreve no cadastro: ele PROPÕE, e uma pessoa
--    aprova de manhã. A proposta precisa morar em algum lugar, e é aqui.
--
-- ⚠️ `descartados` não é log de erro — é a MEDIDA da alucinação. É a lista do
--    que o modelo mandou e o produto recusou (CNPJ com dígito errado, campo
--    fora do esquema, cidade que era endereço). Sem ela não há como decidir se
--    a extração já é confiável o bastante para a fatia 2, onde ela passa a
--    escrever sozinha — e essa decisão viraria opinião.
--
-- Aditiva, com default.

ALTER TABLE agente_sessao ADD COLUMN extraido     jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agente_sessao ADD COLUMN descartados  jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Custo por sessão: sem medir por tenant não há como precificar plano nem
-- detectar abuso (skill geracrm-ia).
ALTER TABLE agente_sessao ADD COLUMN tokens_entrada integer NOT NULL DEFAULT 0;
ALTER TABLE agente_sessao ADD COLUMN tokens_saida   integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN agente_sessao.descartados IS
    '⚠️ A medida da alucinação: o que o modelo afirmou e a validação recusou, '
    'com motivo. É o número que decide se a extração pode virar escrita '
    'automática na fatia 2.';
