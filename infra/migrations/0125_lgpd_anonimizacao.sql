-- 0125_lgpd_anonimizacao.sql
--
-- RETENÇÃO E ANONIMIZAÇÃO LGPD (raia H2).
--
--   contato.anonimizado_em      — quando os dados pessoais foram apagados (NULL = não anonimizado).
--   contato.anonimizacao_modo   — 'completa' (sem compra) | 'canais' (com compra: só canais de contato
--                                 e conteúdo de conversa; o vínculo fiscal mínimo fica).
--   índice parcial              — o seletor de candidatos olha só quem ainda NÃO foi anonimizado.
--   lista_bloqueio.motivo       — ganha 'lgpd' (a chave do telefone anonimizado nunca volta a receber).
--   lgpd_midia_pendente         — fila de remoção de mídia do bucket: a transação só ANOTA; a rede
--                                 (apagar o objeto) acontece fora dela, em worker próprio.
--
-- ⚠️ Aditiva: colunas anuláveis, tabela nova, índice parcial. O CHECK do motivo entra NOT VALID e
--    é validado em seguida (os motivos já gravados são os que a tela de bloqueios aceita).

ALTER TABLE contato ADD COLUMN IF NOT EXISTS anonimizado_em    timestamptz NULL;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS anonimizacao_modo text        NULL;

DO $$ BEGIN
  ALTER TABLE contato ADD CONSTRAINT contato_anonimizacao_coerente
    CHECK ((anonimizado_em IS NULL AND anonimizacao_modo IS NULL)
        OR (anonimizado_em IS NOT NULL AND anonimizacao_modo IN ('completa', 'canais'))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE contato VALIDATE CONSTRAINT contato_anonimizacao_coerente;

COMMENT ON COLUMN contato.anonimizado_em IS
    'LGPD (H2): quando os dados pessoais foram apagados. Contato anonimizado não recebe mensagem e '
    'some das buscas (modo completa). Ids, contagens e agregados permanecem.';

-- Candidatos da retenção: descartados ainda não anonimizados, mais antigos primeiro.
CREATE INDEX IF NOT EXISTS contato_candidato_anonimizacao
    ON contato (tenant_id, qualificado_em)
    WHERE anonimizado_em IS NULL AND qualificado = false;

ALTER TABLE lista_bloqueio DROP CONSTRAINT IF EXISTS lista_bloqueio_motivo_valido;
ALTER TABLE lista_bloqueio ADD CONSTRAINT lista_bloqueio_motivo_valido
    CHECK (motivo IN ('opt_out', 'denuncia', 'manual', 'invalido', 'lgpd')) NOT VALID;
ALTER TABLE lista_bloqueio VALIDATE CONSTRAINT lista_bloqueio_motivo_valido;

CREATE TABLE lgpd_midia_pendente (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id          uuid        NOT NULL,
    contato_id  uuid        NOT NULL,
    -- Referência do objeto no bucket (URL/chave que estava no conteúdo da mensagem). Não é dado
    -- pessoal em si; é o que o worker precisa para apagar o arquivo.
    referencia  text        NOT NULL,
    criado_em   timestamptz NOT NULL DEFAULT now(),
    removido_em timestamptz NULL,
    tentativas  smallint    NOT NULL DEFAULT 0,

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT lgpd_midia_referencia_unica UNIQUE (tenant_id, contato_id, referencia)
);

SELECT aplicar_rls('lgpd_midia_pendente');

CREATE INDEX lgpd_midia_pendente_abertas
    ON lgpd_midia_pendente (tenant_id, criado_em) WHERE removido_em IS NULL;

COMMENT ON TABLE lgpd_midia_pendente IS
    'Mídias de conversas anonimizadas a remover do bucket (H2). A anonimização só anota aqui, na mesma '
    'transação; o objeto é apagado fora dela (rede nunca dentro de transação).';

-- Candidatos do opt-out: o seletor parte do consentimento (poucas linhas), nao da base de contatos.
CREATE INDEX IF NOT EXISTS consentimento_opt_out_candidato
    ON consentimento_contato (tenant_id, registrado_em)
    WHERE tipo = 'whatsapp' AND NOT concedido AND origem = 'opt_out_mensagem';
