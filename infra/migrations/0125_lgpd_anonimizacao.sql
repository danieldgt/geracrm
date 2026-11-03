-- 0125_lgpd_anonimizacao.sql
--
-- RETENÇÃO E ANONIMIZAÇÃO LGPD (raia H2).
--
-- ⚠️ EDITADA NO LUGAR na correção da revisão (H2b, 2026-11-03): esta migration ainda não tinha ido
--    para produção. Mudou: chave `tenant.lgpd_auto` (automática desligada por padrão), bloqueio LGPD
--    à parte do motivo original (`lista_bloqueio.lgpd_em`), pré-checagem explicativa do CHECK do
--    motivo, fila de mídia só com a CHAVE do objeto (com tentativas/backoff) e `lgpd_falha` (contato
--    que falhou vai para o fim da fila).
--
--   tenant.lgpd_auto            — anonimização AUTOMÁTICA (retenção + opt-out) por tenant. DEFAULT
--                                 false: o admin liga em Configurações › Privacidade depois de ver a
--                                 prévia e confirmar (auditado). Desligada, o worker não toca o tenant.
--   contato.anonimizado_em      — quando os dados pessoais foram apagados (NULL = não anonimizado).
--   contato.anonimizacao_modo   — 'completa' (sem compra) | 'canais' (com compra ou identidade de ERP:
--                                 só canais de contato e conteúdo; o vínculo fiscal mínimo fica).
--   lista_bloqueio.lgpd_em      — o número pertence a titular que pediu para ser esquecido (opt-out
--                                 anonimizado ou pedido do titular). O MOTIVO original (denuncia,
--                                 invalido, opt_out…) é preservado; linha nova nasce com motivo 'lgpd'.
--                                 Só sai pelo caminho de novo consentimento auditado.
--   lgpd_midia_pendente         — fila de remoção de objeto do bucket: a transação só ANOTA a chave;
--                                 a rede (apagar o objeto) acontece fora dela, no worker de mídia.
--   lgpd_falha                  — contato cuja anonimização automática falhou (código, tentativas):
--                                 vai para o fim da fila, não trava os outros.
--
-- ⚠️ Aditiva: colunas anuláveis ou com DEFAULT constante, tabelas novas, índices parciais.

ALTER TABLE tenant ADD COLUMN IF NOT EXISTS lgpd_auto boolean NOT NULL DEFAULT false;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS lgpd_auto_alterada_em timestamptz NULL;
COMMENT ON COLUMN tenant.lgpd_auto IS
    'LGPD (H2): anonimização automática (retenção e opt-out) ligada. Padrão false; liga o admin, '
    'depois da prévia e de confirmação explícita (auditoria lgpd.automatica_alterada).';

ALTER TABLE contato ADD COLUMN IF NOT EXISTS anonimizado_em    timestamptz NULL;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS anonimizacao_modo text        NULL;

DO $$ BEGIN
  ALTER TABLE contato ADD CONSTRAINT contato_anonimizacao_coerente
    CHECK ((anonimizado_em IS NULL AND anonimizacao_modo IS NULL)
        OR (anonimizado_em IS NOT NULL AND anonimizacao_modo IN ('completa', 'canais'))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE contato VALIDATE CONSTRAINT contato_anonimizacao_coerente;

COMMENT ON COLUMN contato.anonimizado_em IS
    'LGPD (H2): quando os dados pessoais foram apagados. Contato anonimizado não recebe mensagem, '
    'some das buscas (modo completa) e a ingestão do ERP não o reescreve. Ids e agregados permanecem.';

-- Candidatos da retenção: descartados ainda não anonimizados, mais antigos primeiro.
CREATE INDEX IF NOT EXISTS contato_candidato_anonimizacao
    ON contato (tenant_id, qualificado_em)
    WHERE anonimizado_em IS NULL AND qualificado = false;

-- Bloqueio LGPD À PARTE do motivo: um número já bloqueado por denúncia continua "denúncia".
ALTER TABLE lista_bloqueio ADD COLUMN IF NOT EXISTS lgpd_em timestamptz NULL;
COMMENT ON COLUMN lista_bloqueio.lgpd_em IS
    'LGPD (H2): o titular deste número pediu para ser esquecido. Não sai pela tela de Bloqueios; só '
    'por novo consentimento auditado (POST /v1/bloqueios/:chave/novo-consentimento).';

-- ⚠️ Pré-checagem do CHECK: motivo fora da lista faria o VALIDATE falhar com mensagem genérica no
--    meio do deploy. Aqui o erro diz QUAL motivo e o que fazer.
DO $$
DECLARE fora text;
BEGIN
  SELECT string_agg(DISTINCT motivo, ', ') INTO fora
    FROM lista_bloqueio
   WHERE motivo NOT IN ('opt_out', 'denuncia', 'manual', 'invalido', 'lgpd');
  IF fora IS NOT NULL THEN
    RAISE EXCEPTION '0125: lista_bloqueio tem motivo fora da lista aceita (%). Mapeie esses valores para '
                    'opt_out|denuncia|manual|invalido antes de aplicar esta migration.', fora;
  END IF;
END $$;

ALTER TABLE lista_bloqueio DROP CONSTRAINT IF EXISTS lista_bloqueio_motivo_valido;
ALTER TABLE lista_bloqueio ADD CONSTRAINT lista_bloqueio_motivo_valido
    CHECK (motivo IN ('opt_out', 'denuncia', 'manual', 'invalido', 'lgpd')) NOT VALID;
ALTER TABLE lista_bloqueio VALIDATE CONSTRAINT lista_bloqueio_motivo_valido;

CREATE TABLE lgpd_midia_pendente (
    tenant_id            uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id                   uuid        NOT NULL,
    contato_id           uuid        NOT NULL,
    -- SÓ a chave do objeto no NOSSO bucket (`tenant/{T}/...`) — nunca URL de provedor, legenda ou
    -- nome de arquivo. É o mínimo que o worker precisa para apagar.
    chave_objeto         text        NOT NULL,
    origem               text        NOT NULL,
    criado_em            timestamptz NOT NULL DEFAULT now(),
    removido_em          timestamptz NULL,
    tentativas           smallint    NOT NULL DEFAULT 0,
    proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
    -- Código do último erro (nunca a mensagem crua do provedor).
    ultimo_erro          text        NULL,

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT lgpd_midia_chave_unica UNIQUE (tenant_id, chave_objeto),
    CONSTRAINT lgpd_midia_chave_do_tenant CHECK (chave_objeto LIKE 'tenant/' || tenant_id::text || '/%'),
    CONSTRAINT lgpd_midia_origem_valida CHECK (origem IN ('mensagem', 'midia', 'arquivo')),
    CONSTRAINT lgpd_midia_erro_curto CHECK (ultimo_erro IS NULL OR char_length(ultimo_erro) <= 80)
);

SELECT aplicar_rls('lgpd_midia_pendente');

CREATE INDEX lgpd_midia_pendente_abertas
    ON lgpd_midia_pendente (tenant_id, proxima_tentativa_em) WHERE removido_em IS NULL;

COMMENT ON TABLE lgpd_midia_pendente IS
    'Objetos do bucket (mídia de conversa, arquivo do contato) de contatos anonimizados, a remover '
    '(H2). A anonimização só anota a chave, na mesma transação; o worker apaga fora dela, com backoff.';

CREATE TABLE lgpd_falha (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    contato_id  uuid        NOT NULL,
    codigo      text        NOT NULL,
    tentativas  integer     NOT NULL DEFAULT 1,
    ultima_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, contato_id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT lgpd_falha_codigo_curto CHECK (char_length(codigo) <= 80)
);

SELECT aplicar_rls('lgpd_falha');

COMMENT ON TABLE lgpd_falha IS
    'Anonimização automática que falhou para o contato (só código, sem dado pessoal). O seletor põe '
    'estes no fim da fila; sucesso apaga a linha.';

-- Candidatos do opt-out: o seletor parte do consentimento (poucas linhas), nao da base de contatos.
CREATE INDEX IF NOT EXISTS consentimento_opt_out_candidato
    ON consentimento_contato (tenant_id, registrado_em)
    WHERE tipo = 'whatsapp' AND NOT concedido AND origem = 'opt_out_mensagem';
