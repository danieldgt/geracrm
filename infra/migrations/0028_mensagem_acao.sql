-- 0028_mensagem_acao.sql
--
-- Habilita mensagens do tipo `acao` — o "card" interativo do chat (pedido,
-- orçamento, cobrança…). O conteúdo (titulo, resumo, dados, opcoes, estado)
-- mora no `conteudo` jsonb, seguindo o contrato de packages/shared.
--
-- ⚠️ Aditivo: só ADICIONA um valor permitido ao CHECK. A versão anterior segue
--    servindo (nunca insere 'acao'). Recriar o CHECK valida as linhas
--    existentes — todas têm tipo válido, então passa.

ALTER TABLE mensagem DROP CONSTRAINT mensagem_tipo_valido;
ALTER TABLE mensagem ADD CONSTRAINT mensagem_tipo_valido CHECK (tipo IN (
    'texto','imagem','audio','video','documento','localizacao','contato','sticker','sistema','acao'
));
