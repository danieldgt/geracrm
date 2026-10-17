-- 0100_conhecimento_versao.sql
--
-- HISTÓRICO IMUTÁVEL DAS VERSÕES DO CONHECIMENTO (plano-port-playbook-am, raia P9; ADR-033).
--
-- Até aqui `conhecimento_documento.versao` era um CONTADOR que sobrescrevia o
-- texto: a decisão do agente citava "Frete v3", mas o texto da v3 deixava de
-- existir na edição seguinte — "por que o robô disse isso?" não tinha resposta.
-- Agora cada versão é uma linha imutável com o texto exato daquela versão:
--
--   conhecimento_documento_versao (tenant_id, documento_id, versao) — título,
--   tipo, canal e conteúdo da versão, de onde ela veio (criação, edição,
--   restauração, sincronismo das políticas, backfill, automática), quem fez,
--   observação e, quando restaurada, de qual versão.
--
-- Quem escreve: a API, na MESMA transação do INSERT/UPDATE do documento (com
-- origem, autor e observação). Rede de segurança: um CONSTRAINT TRIGGER
-- DEFERRABLE, no commit, grava a versão que ainda não tiver linha — origem
-- 'automatica'. É ele que cobre a VERSÃO ANTERIOR DA API, que continua
-- atendendo enquanto esta migration roda e não sabe da tabela nova: uma edição
-- feita por ela no meio do deploy não fica sem histórico.
--
-- ⚠️ Aditiva: tabela nova, função e trigger novos. Nada da versão anterior
--    muda de comportamento — o trigger só INSERE na tabela nova. A API nova
--    grava com INSERT simples (conflito = erro e rollback: duas escritas da
--    mesma versão são bug, não caso normal); só o trigger e o backfill usam
--    `ON CONFLICT DO NOTHING`, porque rodam depois de quem já registrou.
-- ⚠️ Imutável: UPDATE é recusado por trigger (inclusive para o dono) e o
--    privilégio de UPDATE é retirado do papel da aplicação.
-- ⚠️ DELETE continua PERMITIDO, de propósito (decisão da revisão da P9, opção
--    "a"): é o caminho da exclusão a pedido do titular (LGPD, raia R10d) — um
--    documento pode conter dado pessoal, e "imutável" não pode significar
--    "impossível de apagar". Além da cascata do documento, uma versão pode ser
--    removida isoladamente; a API então responde `conhecimento.versao_removida`
--    (versão entre a primeira registrada e a atual, sem linha) — distinto de
--    `versao_anterior_ao_historico` — e nunca mostra outro texto no lugar.
-- ⚠️ Backfill: só a versão ATUAL de cada documento existe para copiar. As
--    versões anteriores a esta migration foram sobrescritas e não voltam; a API
--    responde `conhecimento.versao_anterior_ao_historico` para elas, em vez de
--    fingir que a atual é a antiga.

CREATE TABLE conhecimento_documento_versao (
    tenant_id     uuid        NOT NULL,
    documento_id  uuid        NOT NULL,
    versao        integer     NOT NULL,
    titulo        text        NOT NULL,
    tipo          text        NOT NULL,
    -- Alcance no momento da versão (NULL = todos os canais).
    canal_id      uuid,
    conteudo      text        NOT NULL,
    -- De onde veio a versão:
    --   criacao      — POST do documento
    --   edicao       — PATCH que mudou título/conteúdo
    --   restauracao  — POST .../restaurar (cópia de `restaurada_de`)
    --   sincronismo  — `agente_config.politicas` espelhado no documento
    --   backfill     — versão vigente quando o histórico nasceu (esta migration)
    --   automatica   — gravada pelo trigger no commit (escritor que não registrou)
    origem        text        NOT NULL,
    restaurada_de integer,
    observacao    text,
    -- `usuario.id` de quem fez; NULL = sistema ou sessão de staff.
    autor_id      uuid,
    autor_staff   boolean     NOT NULL DEFAULT false,
    criado_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, documento_id, versao),
    FOREIGN KEY (tenant_id, documento_id) REFERENCES conhecimento_documento (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT conhecimento_versao_origem_valida CHECK (
        origem IN ('criacao', 'edicao', 'restauracao', 'sincronismo', 'backfill', 'automatica')),
    CONSTRAINT conhecimento_versao_numero_positivo CHECK (versao >= 1),
    CONSTRAINT conhecimento_versao_restaurada_coerente CHECK (
        (origem = 'restauracao') = (restaurada_de IS NOT NULL) AND (restaurada_de IS NULL OR restaurada_de < versao)),
    CONSTRAINT conhecimento_versao_observacao_curta CHECK (observacao IS NULL OR length(observacao) <= 280)
);

SELECT aplicar_rls('conhecimento_documento_versao');

-- A PK já é o índice da tela: (tenant, documento, versao DESC) por cursor.

COMMENT ON TABLE conhecimento_documento_versao IS
    'Histórico IMUTÁVEL de conhecimento_documento (P9, ADR-033): o texto exato de cada versão citada '
    'pelo agente. Escrita pela API na transação da edição; trigger deferido cobre quem não registrar.';

-- ---------------------------------------------------------------------------
-- Imutabilidade.
-- ---------------------------------------------------------------------------
CREATE FUNCTION conhecimento_versao_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'conhecimento_documento_versao é imutável: restaurar cria versão nova'
        USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER conhecimento_versao_sem_update
    BEFORE UPDATE ON conhecimento_documento_versao
    FOR EACH ROW EXECUTE FUNCTION conhecimento_versao_imutavel();

REVOKE UPDATE ON conhecimento_documento_versao FROM geracrm_app;

-- ---------------------------------------------------------------------------
-- Rede de segurança: toda versão do documento tem linha no histórico.
--
-- CONSTRAINT TRIGGER deferido: roda no COMMIT, depois de a API nova ter gravado
-- a sua linha (com origem/autor) — aí o ON CONFLICT não faz nada. Para a API
-- antiga (ou qualquer escritor que não registre), grava a versão com origem
-- 'automatica'. Roda com o papel e o `tenant_atual()` da própria transação:
-- RLS vale (o NEW.tenant_id é o do tenant da transação).
-- ---------------------------------------------------------------------------
CREATE FUNCTION conhecimento_versao_garantir() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.versao = OLD.versao THEN
        RETURN NULL;
    END IF;
    -- O documento pode ter sido apagado depois, na mesma transação.
    IF NOT EXISTS (SELECT 1 FROM conhecimento_documento d
                    WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.id) THEN
        RETURN NULL;
    END IF;
    INSERT INTO conhecimento_documento_versao
        (tenant_id, documento_id, versao, titulo, tipo, canal_id, conteudo, origem, criado_em)
    VALUES (NEW.tenant_id, NEW.id, NEW.versao, NEW.titulo, NEW.tipo, NEW.canal_id, NEW.conteudo,
            'automatica', NEW.atualizado_em)
    ON CONFLICT (tenant_id, documento_id, versao) DO NOTHING;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER conhecimento_documento_registra_versao
    AFTER INSERT OR UPDATE ON conhecimento_documento
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION conhecimento_versao_garantir();

-- ---------------------------------------------------------------------------
-- Backfill: a versão vigente de cada documento. Idempotente pela PK.
-- ---------------------------------------------------------------------------
INSERT INTO conhecimento_documento_versao
    (tenant_id, documento_id, versao, titulo, tipo, canal_id, conteudo, origem, criado_em)
SELECT d.tenant_id, d.id, d.versao, d.titulo, d.tipo, d.canal_id, d.conteudo, 'backfill', d.atualizado_em
  FROM conhecimento_documento d
ON CONFLICT (tenant_id, documento_id, versao) DO NOTHING;

-- Conferência do backfill: TODO documento tem a sua versão vigente no
-- histórico. Faltou alguma (RLS no papel do runner, por exemplo) → a migration
-- falha e o deploy não prossegue, em vez de nascer um histórico furado.
DO $$
DECLARE
    documentos integer;
    vigentes   integer;
BEGIN
    SELECT count(*) INTO documentos FROM conhecimento_documento;
    SELECT count(*) INTO vigentes
      FROM conhecimento_documento d
      JOIN conhecimento_documento_versao v
        ON v.tenant_id = d.tenant_id AND v.documento_id = d.id AND v.versao = d.versao;
    IF documentos <> vigentes THEN
        RAISE EXCEPTION 'backfill de conhecimento_documento_versao incompleto: % documentos, % versões vigentes',
            documentos, vigentes;
    END IF;
END
$$;
