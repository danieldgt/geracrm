-- 0019_outbox.sql
--
-- ⚠️ Fecha uma lacuna da D-01: a `outbox` estava listada no plano dentro da
--    `0001_base.sql` e não foi criada. A falta não apareceu em teste nenhum
--    porque nada a consome ainda — o consumo é da Onda 1. Mas a ESCRITA é
--    invariante desta onda (INV-40): todo evento que a tela vai precisar
--    receber tem de ser gravado no mesmo commit do fato que o gerou.
--
--    É o coração do ADR-007: sem Redis e sem broker, o empurrão para a tela é
--    SSE + LISTEN/NOTIFY, e o NOTIFY sozinho NÃO BASTA — ele não é
--    transacional em relação a quem está ouvindo. Se ninguém estiver escutando
--    no instante do NOTIFY, a notificação some para sempre. A outbox é o que
--    torna a entrega recuperável: o evento fica gravado, e quem reconecta lê o
--    que perdeu a partir do último id que viu.

CREATE TABLE outbox (
    -- ⚠️ bigint sequencial GLOBAL, não uuid e não por tenant: o consumidor
    --    avança por "id > último que li", e isso exige ordem total. UUID v7 é
    --    ordenável por tempo, mas dois eventos no mesmo microssegundo não têm
    --    ordem definida — e é justamente em rajada que a ordem importa.
    id            bigint      GENERATED ALWAYS AS IDENTITY,
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,

    tipo          text        NOT NULL,
    -- Para o consumidor filtrar sem abrir o payload: conversa, contato, canal.
    agregado      text        NOT NULL,
    agregado_id   uuid,
    payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,

    criado_em     timestamptz NOT NULL DEFAULT now(),
    processado_em timestamptz,
    -- Erro da última tentativa. ⚠️ Sem isto, evento que falha some da fila sem
    --    deixar rastro, e o sintoma é "a tela às vezes não atualiza".
    tentativas    integer     NOT NULL DEFAULT 0,
    ultimo_erro   text,

    PRIMARY KEY (id)
);

SELECT aplicar_rls('outbox');

-- ⚠️ A consulta do worker é sempre a mesma: os não processados, em ordem.
--    Índice parcial porque a tabela fica dominada por linhas já processadas —
--    índice completo cresceria para sempre servindo uma consulta que só olha a
--    ponta.
CREATE INDEX outbox_pendentes ON outbox (id) WHERE processado_em IS NULL;

-- Reconexão do SSE: "o que aconteceu neste tenant depois do id X".
CREATE INDEX outbox_por_tenant ON outbox (tenant_id, id);

-- Expurgo do que já foi entregue.
CREATE INDEX outbox_expurgo ON outbox (processado_em) WHERE processado_em IS NOT NULL;

COMMENT ON TABLE outbox IS
    'Eventos gravados no MESMO commit do fato que os gerou (INV-40). ⚠️ O NOTIFY '
    'sozinho não basta: ele não é transacional em relação a quem escuta, e some '
    'para sempre se ninguém estiver ouvindo. A outbox é o que deixa a entrega '
    'recuperável na reconexão.';
COMMENT ON COLUMN outbox.id IS
    '⚠️ bigint sequencial global: o consumidor avança por "id > último lido", o '
    'que exige ordem TOTAL. UUID v7 empata dentro do mesmo microssegundo — e é '
    'em rajada que a ordem importa.';

-- ---------------------------------------------------------------------------
-- O gatilho do NOTIFY.
--
-- ⚠️ AFTER INSERT, não no código da aplicação: o NOTIFY tem de ser disparado
--    pela mesma transação que gravou a linha. Chamar do código depois do commit
--    abre a janela em que a linha existe e o aviso não saiu — e o aviso perdido
--    não é reemitido por ninguém.
--
--    O payload carrega só o tenant: quem acorda vai LER a outbox. Mandar o
--    evento inteiro no NOTIFY esbarra no limite de 8000 bytes do Postgres, e o
--    estouro derruba o INSERT — a mensagem do cliente deixaria de ser gravada
--    por causa do aviso sobre ela.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION outbox_notificar()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('outbox', NEW.tenant_id::text);
    RETURN NULL;
END;
$$;

CREATE TRIGGER outbox_apos_insercao
    AFTER INSERT ON outbox
    FOR EACH ROW EXECUTE FUNCTION outbox_notificar();

COMMENT ON FUNCTION outbox_notificar() IS
    '⚠️ Envia só o tenant_id. O NOTIFY do Postgres tem limite de 8000 bytes e o '
    'estouro derruba o INSERT — mandar o evento inteiro faria a mensagem do '
    'cliente deixar de ser gravada por causa do aviso sobre ela.';
