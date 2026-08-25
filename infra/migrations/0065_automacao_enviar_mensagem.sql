-- 0065_automacao_enviar_mensagem.sql
--
-- A AÇÃO QUE FALA COM O CLIENTE (docs/automacoes.md §2 — mudança de política).
--
-- Até aqui, automação só organizava trabalho HUMANO: criar tarefa, aplicar
-- sequência, adicionar à lista. A regra era "o vendedor é quem fala com o
-- cliente", e ela existia porque enviar sozinho carrega risco real — opt-out,
-- janela de 24h, banimento no canal não-oficial (ADR-021).
--
-- ⚠️ O que mudou não foi o risco: foi a existência dos guardrails. O envio agora
--    passa pelo gateway único (E5-13), que revalida opt-out, estado do canal,
--    credencial, janela de 24h e — desde a pausa automática (CAN-06) — o
--    `disparo_pausado`. Automação que fala é o CASO MAIS PERIGOSO do produto, e
--    é justamente por isso que ela não pode ter um caminho próprio de envio.
--
-- ⚠️ E há um segundo opt-out, específico: `contato.recebe_automacoes` (0008). Ele
--    NÃO é a mesma coisa que a lista de bloqueio — é o cliente dizendo "pode me
--    mandar campanha, mas não robô". Quem manda por automação tem de honrar os
--    dois.
--
-- Aditiva: só amplia o CHECK.

ALTER TABLE automacao DROP CONSTRAINT automacao_acao_valida;
ALTER TABLE automacao ADD CONSTRAINT automacao_acao_valida
    CHECK (acao IN ('criar_tarefa','aplicar_sequencia','adicionar_lista','enviar_mensagem'));

COMMENT ON COLUMN automacao.acao IS
    '⚠️ `enviar_mensagem` é a única que FALA com o cliente. Sempre pelo gateway '
    'único (opt-out · canal · janela 24h · pausa de disparo) e respeitando '
    'contato.recebe_automacoes. Sem conversa aberta, degrada para tarefa.';
