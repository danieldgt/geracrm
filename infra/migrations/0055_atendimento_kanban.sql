-- 0055_atendimento_kanban.sql
--
-- Kanban de ATENDIMENTOS com etapas CONFIGURÁVEIS por empresa (tenant) — a visão
-- do gestor. Espelha o funil (0034): etapas por tenant + histórico (tempo em
-- etapa) + mover com concorrência otimista.
--
-- ⚠️ A "Fila" é DERIVADA da conversa (entrante sem atendimento aberto), não uma
--    etapa — por isso `tipo` só tem 'atendimento' e 'encerrado'. O board mostra a
--    fila como 1ª coluna derivada, e as etapas configuráveis depois.
-- ⚠️ O `estado` coarse do atendimento ('na_fila'/'em_atendimento'/'encerrado')
--    continua existindo e é MANTIDO em sincronia pela `tipo` da etapa no mover
--    (é assim que o "encerrar", que não existia, passa a existir).
-- Tudo aditivo e sob RLS.

-- ─── Etapas do kanban (configuráveis por tenant) ───
CREATE TABLE atendimento_etapa (
    tenant_id uuid    NOT NULL,
    id        uuid    NOT NULL,
    ordem     integer NOT NULL,
    chave     text    NOT NULL,   -- 'em_atendimento' | 'aguardando_cliente' | ...
    nome      text    NOT NULL,
    tipo      text    NOT NULL,   -- 'atendimento' (aberto) | 'encerrado' (terminal)
    ativo     boolean NOT NULL DEFAULT true,

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT atendimento_etapa_tipo_valido CHECK (tipo IN ('atendimento','encerrado')),
    UNIQUE (tenant_id, chave)
);
CREATE INDEX atendimento_etapa_ordem ON atendimento_etapa (tenant_id, ordem);
SELECT aplicar_rls('atendimento_etapa');

-- ─── Atendimento aponta para a etapa (aditivo) ───
ALTER TABLE atendimento ADD COLUMN etapa_id        uuid;
ALTER TABLE atendimento ADD COLUMN entrou_etapa_em timestamptz;      -- base do aging
ALTER TABLE atendimento ADD COLUMN versao          bigint NOT NULL DEFAULT 0; -- concorrência otimista no mover
ALTER TABLE atendimento ADD CONSTRAINT atendimento_etapa_fk
    FOREIGN KEY (tenant_id, etapa_id) REFERENCES atendimento_etapa (tenant_id, id);
-- Paginação por COLUNA: cursor (entrou_etapa_em, id) dentro de (tenant, etapa).
CREATE INDEX atendimento_por_etapa
    ON atendimento (tenant_id, etapa_id, entrou_etapa_em, id)
    WHERE etapa_id IS NOT NULL;

-- ─── Histórico de etapa (tempo-em-etapa / aging) ───
CREATE TABLE atendimento_etapa_historico (
    tenant_id      uuid        NOT NULL,
    id             uuid        NOT NULL,
    atendimento_id uuid        NOT NULL,
    etapa_id       uuid        NOT NULL,
    entrou_em      timestamptz NOT NULL DEFAULT now(),
    saiu_em        timestamptz,
    ator_id        uuid,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, atendimento_id) REFERENCES atendimento (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX atendimento_hist_por_at ON atendimento_etapa_historico (tenant_id, atendimento_id, entrou_em);
SELECT aplicar_rls('atendimento_etapa_historico');

-- ─── Seed do fluxo padrão (rico) para os tenants existentes ───
-- ⚠️ Tenants novos recebem no primeiro acesso (garantirEtapasAtendimento, lazy),
--    já que não há bootstrap central de tenant.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    INSERT INTO atendimento_etapa (tenant_id, id, ordem, chave, nome, tipo) VALUES
      (t.id, gen_random_uuid(), 1, 'em_atendimento',     'Em atendimento',     'atendimento'),
      (t.id, gen_random_uuid(), 2, 'aguardando_cliente', 'Aguardando cliente', 'atendimento'),
      (t.id, gen_random_uuid(), 9, 'resolvido',          'Resolvido',          'encerrado')
    ON CONFLICT (tenant_id, chave) DO NOTHING;
  END LOOP;
END $$;

-- ─── Backfill: atendimentos existentes ganham etapa pela coarse `estado` ───
UPDATE atendimento a SET
    etapa_id = e.id,
    entrou_etapa_em = coalesce(a.assumido_em, a.encerrado_em, a.criado_em)
  FROM atendimento_etapa e
 WHERE e.tenant_id = a.tenant_id
   AND a.etapa_id IS NULL
   AND ( (a.estado = 'encerrado' AND e.chave = 'resolvido')
      OR (a.estado <> 'encerrado' AND e.chave = 'em_atendimento') );

-- Uma linha de histórico p/ os backfilados (aging conta a partir daqui).
INSERT INTO atendimento_etapa_historico (tenant_id, id, atendimento_id, etapa_id, entrou_em)
SELECT a.tenant_id, gen_random_uuid(), a.id, a.etapa_id, a.entrou_etapa_em
  FROM atendimento a WHERE a.etapa_id IS NOT NULL;
