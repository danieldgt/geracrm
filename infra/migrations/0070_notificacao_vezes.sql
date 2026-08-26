-- 0070_notificacao_vezes.sql
--
-- O AVISO QUE SUBSTITUI O ANTERIOR PRECISA TRAZER NOTÍCIA NOVA.
--
-- ⚠️ Encontrado com o usuário em 2026-08-26: o push apareceu UMA vez e nunca
--    mais. O servidor estava certo o tempo todo (assinatura viva, entrega aceita
--    pelo serviço da Mozilla, `ultimo_erro` nulo) — o problema era que o segundo
--    aviso da MESMA conversa substituía o primeiro em silêncio.
--
--    Duas decisões corretas somadas viraram um defeito:
--      · `notificacao` tem uma pendência por (usuário, conversa) e o `ON CONFLICT`
--        recende a existente — para o sino não virar uma lista de repetições;
--      · o service worker usa `tag` por conversa — para a tela de bloqueio não
--        empilhar dez avisos da mesma pessoa, que é o que faz alguém desligar a
--        permissão.
--    Resultado: a segunda mensagem troca o aviso NO LUGAR, com o mesmo texto. Se
--    o `renotify` não re-alerta (Firefox no desktop não é confiável nisso), nada
--    acontece na tela — e quem atende conclui que o push "parou de funcionar".
--
-- ⚠️ O conserto NÃO é remover a `tag`: empilhar traz de volta o problema que ela
--    resolve. É fazer o aviso substituto DIZER que houve novidade — "3 mensagens
--    novas" em vez de repetir a mesma frase. Aviso que não avisa é pior que aviso
--    nenhum: ensina a confiar no silêncio.
--
-- Aditiva, com default: a versão anterior do código ignora a coluna.

ALTER TABLE notificacao ADD COLUMN vezes integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN notificacao.vezes IS
    '⚠️ Quantas mensagens entraram nesta pendência (o `ON CONFLICT` soma). Vai no '
    'corpo do push para que o aviso que SUBSTITUI o anterior carregue novidade. '
    'Volta a 1 sozinho quando a pendência é lida: o índice único parcial só cobre '
    '`lida_em IS NULL`, então a próxima mensagem cria linha nova.';
