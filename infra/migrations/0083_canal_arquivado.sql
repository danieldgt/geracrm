-- 0083_canal_arquivado.sql
--
-- Tirar um número da frota sem perder o que ele atendeu.
--
-- ⚠️ Origem: um canal cadastrado errado ficava PARA SEMPRE na tela. Não havia
--    remoção nem edição — nem rota, nem botão. Em produção (02/set) um PlugZapi
--    estava com a URL do endpoint colada no campo do Client-Token: desconectado,
--    inútil e impossível de tirar do caminho.
--
-- ⚠️ Apagar de verdade nem sempre é possível, e isso é de propósito: `conversa`,
--    `atendimento` e `campanha` referenciam `canal_conectado` com FK SEM
--    `ON DELETE CASCADE` — apagar um número não pode apagar a conversa que ele
--    atendeu. `arquivado_em` é a saída para o canal que já tem histórico: some
--    de tudo que é operação (lista, vigia, seleção de canal, envio, webhook) e
--    o passado continua de pé. Canal que nunca conversou é apagado de fato.

ALTER TABLE canal_conectado ADD COLUMN arquivado_em timestamptz;

COMMENT ON COLUMN canal_conectado.arquivado_em IS
    'Quando o número saiu da frota. NULL = ativo. Canal arquivado não aparece na '
    'lista, não é vigiado, não recebe envio novo e não ingere webhook — mas as '
    'conversas, mensagens e métricas que ele gerou continuam existindo.';

-- ---------------------------------------------------------------------------
-- O webhook também precisa saber
-- ---------------------------------------------------------------------------
-- ⚠️ Mensagem que chega para um canal arquivado não pode virar conversa: o
--    número sumiu da tela, e a conversa nasceria invisível. Quem decide isso é
--    o webhook, que descobre o canal por esta função (RLS FORCE, sem sessão).
--
-- ⚠️ DROP + CREATE porque `CREATE OR REPLACE` não muda o tipo de retorno. É
--    seguro com a versão anterior servindo: ela faz
--    `SELECT tenant_id, provedor, estado FROM tenant_do_canal(...)`, que
--    continua válido com uma coluna a mais — e o arquivo roda em transação.

DROP FUNCTION IF EXISTS tenant_do_canal(uuid);

CREATE FUNCTION tenant_do_canal(p_canal_id uuid)
RETURNS TABLE (tenant_id uuid, provedor text, estado text, arquivado_em timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT c.tenant_id, c.provedor, c.estado, c.arquivado_em
      FROM canal_conectado c WHERE c.id = p_canal_id;
$$;

GRANT EXECUTE ON FUNCTION tenant_do_canal(uuid) TO geracrm_app;

COMMENT ON FUNCTION tenant_do_canal(uuid) IS
    '⚠️ Descoberta de tenant para o WEBHOOK (sem sessão). SECURITY DEFINER porque '
    'canal_conectado tem RLS FORCE. Devolve só tenant/provedor/estado/arquivado_em — '
    'o mínimo para rotear e para recusar canal arquivado, nunca credencial.';
