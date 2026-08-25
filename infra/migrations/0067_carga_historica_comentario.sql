-- 0067_carga_historica_comentario.sql
--
-- Corrige a DOCUMENTAÇÃO das colunas de `carga_historica` (0064).
--
-- ⚠️ Por que uma migration só para comentário: o runner valida o HASH do arquivo
--    e RECUSA migration aplicada que foi alterada depois ("migration aplicada é
--    imutável: escreva uma nova, aditiva"). Editar a 0064 para arrumar um
--    comentário derrubaria o próximo preDeploy — a guarda está certa, e ela
--    vale também para comentário.
--
-- O que mudou de entendimento: a 0064 dizia "o que entrou, para a conciliação
-- ter contra o que comparar", e o código gravava `importadas` — o número de
-- linhas INSERIDAS naquela execução. Como a ingestão é UPSERT, a segunda carga
-- reportou `importadas=0` e o recibo passou a afirmar que a carga histórica
-- trouxe zero vendas e R$ 0,00, com 739 vendas e R$ 81 mil na base.
--
-- ⚠️ Numa coluna que é a REFERÊNCIA DA CONCILIAÇÃO, número plausível e falso é
--    pior do que número ausente: ninguém confere o que parece ter vindo do
--    sistema. O código passou a gravar o ESTADO DA BASE ao fim da carga.

COMMENT ON COLUMN carga_historica.vendas IS
    '⚠️ ESTADO da base ao fim da carga (vendas não canceladas desde `desde`), '
    'NÃO o delta da execução. A ingestão é upsert: a segunda carga insere zero, '
    'e gravar o delta faria o recibo dizer que a base está vazia.';
COMMENT ON COLUMN carga_historica.valor_centavos IS
    '⚠️ ESTADO da base, não delta — ver o comentário de `vendas`. É contra este '
    'número que a conciliação compara o relatório do ERP.';
COMMENT ON COLUMN carga_historica.clientes IS
    '⚠️ ESTADO da base (contatos do tenant) ao fim da carga.';
COMMENT ON COLUMN carga_historica.produtos IS
    '⚠️ ESTADO da base (SKUs do tenant) ao fim da carga.';
