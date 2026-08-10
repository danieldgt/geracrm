-- 0026_outbox_notify.sql
--
-- Tempo real (ADR-007): UM único caminho de evento, sem redundância.
--
--   INSERT na outbox (mesmo commit do dado) → TRIGGER → NOTIFY 'geracrm_evento'
--   com o payload MÍNIMO (ids) → barramento (1 LISTEN por instância) → SSE.
--
-- ⚠️ Substitui o mecanismo genérico do 0019 (NOTIFY 'outbox' só com tenant_id,
--    que exigiria um worker ACORDAR e LER a outbox — um SELECT a mais no caminho
--    quente). Aqui o NOTIFY já leva os ids necessários; o cliente busca o
--    conteúdo pela API sob RLS. São dezenas de bytes, muito abaixo dos 8 KB do
--    NOTIFY. Um canal só atende todos os consumidores (filtram por `tipo`).
--
-- ⚠️ Idempotente: pode rodar sobre um banco que já tem o trigger do 0019.

-- Remove o mecanismo antigo (0019) e quaisquer versões anteriores deste arquivo.
DROP TRIGGER IF EXISTS outbox_apos_insercao ON outbox;
DROP TRIGGER IF EXISTS outbox_notifica ON outbox;
DROP TRIGGER IF EXISTS outbox_notifica_sse ON outbox;
DROP TRIGGER IF EXISTS outbox_emite_evento ON outbox;
DROP FUNCTION IF EXISTS outbox_notificar();
DROP FUNCTION IF EXISTS outbox_notificar_sse();

CREATE OR REPLACE FUNCTION outbox_emitir_evento()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- ⚠️ tenant_id vai só para o roteamento no servidor; o barramento o remove
    --    ao despachar. O cliente NUNCA recebe tenant_id nem conteúdo.
    PERFORM pg_notify('geracrm_evento', json_build_object(
        'tenantId',   NEW.tenant_id,
        'id',         NEW.id,
        'tipo',       NEW.tipo,
        'conversaId', NEW.payload->>'conversaId',
        'versao',     (NEW.payload->>'versao')::int
    )::text);
    RETURN NULL; -- AFTER trigger: retorno ignorado.
END;
$$;

CREATE TRIGGER outbox_emite_evento
    AFTER INSERT ON outbox
    FOR EACH ROW
    EXECUTE FUNCTION outbox_emitir_evento();

COMMENT ON FUNCTION outbox_emitir_evento() IS
    'Único emissor de eventos de tempo real (ADR-007): pg_notify(geracrm_evento) '
    'no COMMIT de cada linha da outbox, com payload mínimo (ids). Transacional '
    'por construção; sem worker intermediário e sem canal redundante.';
