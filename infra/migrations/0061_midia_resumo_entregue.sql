-- 0061_midia_resumo_entregue.sql
--
-- O RECIBO DO RESUMO DIÁRIO (agencia-mkt, AQ-08).
--
-- O resumo já era montado (`resumo-diario.ts`) e a entrega era injetada, porque
-- o canal estava em aberto. O canal foi decidido com o dono do produto
-- (`agencia-mkt/../docs/fluxo-conexao-numero.md`): **webhook de saída** (0033) —
-- já existe, é assinado, tem retry e dead-letter, e não gasta número nem
-- aquecimento da frota.
--
-- ⚠️ Esta tabela existe por UM motivo: **uma entrega por tenant por dia**.
--    A varredura roda de 15 em 15 minutos (e o processo reinicia a deploy), então
--    "já mandei hoje?" precisa de resposta persistida. A PK composta
--    `(tenant_id, dia)` é a própria trava: a segunda tentativa do mesmo dia
--    esbarra no ON CONFLICT e não emite evento nenhum.
--
-- ⚠️ E o recibo é gravado no MESMO COMMIT do evento na outbox (INV-40). Gravar
--    depois abriria a janela em que o processo cai entre uma coisa e outra — e o
--    cliente receberia o resumo duas vezes, que é como um relatório perde
--    credibilidade.
--
-- ⚠️ Linha só existe quando REALMENTE saiu. Dia sem gasto, sem lead e sem alerta
--    não gera linha: "sem dado" ≠ "tudo zero" (a regra está no `montarResumo`),
--    e a ausência de linha é a resposta honesta a "por que não recebi ontem?".
--
-- Aditiva. Sob RLS como toda tabela de domínio (ADR-001).

CREATE TABLE midia_resumo_entregue (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    -- ⚠️ Dia LOCAL do tenant, não UTC: o resumo das 20h de Manaus (UTC-4) cairia
    --    no dia seguinte se a data viesse do relógio do servidor.
    dia         date        NOT NULL,
    entregue_em timestamptz NOT NULL DEFAULT now(),
    -- Id do evento na outbox — o rastro de qual entrega foi esta.
    outbox_id   bigint,

    PRIMARY KEY (tenant_id, dia)
);

SELECT aplicar_rls('midia_resumo_entregue');

COMMENT ON TABLE midia_resumo_entregue IS
    'Recibo do resumo diário de mídia (AQ-08). ⚠️ A PK (tenant_id, dia) É a trava '
    'de "uma vez por dia" — gravada no mesmo commit do evento na outbox.';
COMMENT ON COLUMN midia_resumo_entregue.dia IS
    '⚠️ Dia LOCAL do tenant (tenant.fuso), não UTC.';
