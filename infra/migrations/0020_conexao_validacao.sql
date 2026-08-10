-- 0020_conexao_validacao.sql
--
-- Quando a credencial foi validada pela última vez, e o que o ERP respondeu.
--
-- ⚠️ O contrato (§5.8) promete `{ configurada: true, ultimaValidacaoEm }` e a
--    coluna não existia. Sem ela, a tela só consegue dizer "configurada" —
--    e "configurada" não é a pergunta que a pessoa tem. A pergunta é
--    "está funcionando AGORA?", que é outra coisa: credencial revogada no ERP
--    continua configurada aqui, e continuaria parecendo saudável para sempre.

ALTER TABLE conexao_erp ADD COLUMN ultima_validacao_em timestamptz;

-- ⚠️ Sucesso e tentativa são datas DIFERENTES. Com uma coluna só, uma conexão
--    que quebrou ontem e é testada de hora em hora mostra "validada há 5
--    minutos" — exatamente quando está fora do ar. A distância entre as duas é
--    o sinal: `ultima_validacao_em` velha com `ultima_tentativa_em` recente
--    significa "está tentando e falhando".
ALTER TABLE conexao_erp ADD COLUMN ultima_tentativa_em timestamptz;

-- O que o ERP disse que é. ⚠️ Sem isso não há como a pessoa perceber que
-- conectou na loja errada — e conectar na filial errada é o erro de
-- configuração que só aparece semanas depois, no relatório.
ALTER TABLE conexao_erp ADD COLUMN identificacao_remota text;

-- Motivo tipificado da última falha, separado de `ultimo_erro` (texto livre do
-- ERP). ⚠️ "Senha errada" e "ERP fora do ar" pedem ações OPOSTAS de quem lê:
-- corrigir o que digitou, ou esperar. Texto livre do fornecedor não permite à
-- tela escolher qual das duas mostrar.
ALTER TABLE conexao_erp ADD COLUMN ultimo_erro_motivo text;

ALTER TABLE conexao_erp ADD CONSTRAINT conexao_erp_motivo_valido
    CHECK (ultimo_erro_motivo IS NULL OR ultimo_erro_motivo IN (
        'credencial_invalida', 'sem_permissao', 'indisponivel', 'resposta_inesperada'
    ));

COMMENT ON COLUMN conexao_erp.ultima_validacao_em IS
    'Último teste BEM-SUCEDIDO. ⚠️ Diferente de ultima_tentativa_em: a distância '
    'entre as duas é o que revela "está tentando e falhando".';
COMMENT ON COLUMN conexao_erp.identificacao_remota IS
    'O que o ERP respondeu que é (razão social, CNPJ, nome da filial). ⚠️ É o '
    'único jeito de a pessoa perceber que conectou na loja errada — erro que, '
    'sem isto, só aparece semanas depois no relatório.';
