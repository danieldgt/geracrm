-- 0106_agente_playbook.sql
--
-- PLAYBOOK COMERCIAL VERSIONADO (plano-port-playbook-am, raia P17; ADR-029, ADR-033).
--
--   agente_playbook_versao — "como vender" (estilo, persona, roteiro de
--       qualificação, mensagens prontas, compliance extra, ações habilitáveis)
--       por tenant (canal_id NULL = padrão da conta) ou por número. Ciclo:
--         rascunho  (publicada_em NULL)                  — editável, descartável;
--         publicada (publicada_em NOT NULL, arquivada_em NULL) — imutável;
--         arquivada (arquivada_em NOT NULL)              — imutável.
--       No máximo UM rascunho e UMA publicada por (tenant, coalesce(canal)).
--       O número da versão (v1, v2…) nasce na publicação, sequencial por escopo.
--   agente_config.playbook — ESPELHO da versão publicada que vale para o número
--       ({versaoId, numero, escopo, publicadaEm, conteudo}). É o que o turno lê
--       (`to_jsonb(ac.*)`, leitura tolerante): publicar muda a próxima mensagem
--       sem consulta extra no caminho quente. A publicação também espelha a
--       persona e os slots ativos em `agente_config.persona`/`qualificacao`.
--   agente_simulacao_trava — uma simulação por tenant de cada vez (lease curto;
--       nada fica preso se o processo cair).
--
-- ⚠️ Imutabilidade modelada em COLUNAS de estado, não num campo `estado`: a única
--    transição permitida numa versão publicada é preencher `arquivada_em` (uma
--    vez). Trigger BEFORE UPDATE recusa qualquer outra mudança — inclusive para o
--    dono — e BEFORE DELETE recusa apagar versão publicada/arquivada (descartar
--    é só para rascunho).
-- ⚠️ Aditiva: tabelas novas e coluna anulável. A versão anterior da API não as
--    conhece e segue igual (sem espelho = comportamento de hoje). Os triggers
--    só agem em INSERT de agente_config (preenchem o espelho a partir do
--    playbook publicado) — inofensivos para a versão anterior.

CREATE TABLE agente_playbook_versao (
    tenant_id        uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id               uuid        NOT NULL,
    -- NULL = playbook da conta (vale para os números sem playbook próprio).
    canal_id         uuid        NULL,
    -- Sequencial por (tenant, escopo); NULL enquanto rascunho.
    numero           integer     NULL CHECK (numero IS NULL OR numero >= 1),
    conteudo         jsonb       NOT NULL CHECK (jsonb_typeof(conteudo) = 'object'),
    -- importada  — v1 a partir de agente_config (idempotente)
    -- manual     — editada na tela
    -- documento  — rascunho sugerido pelo LLM a partir de um documento
    -- restaurada — cópia de uma versão antiga publicada como nova
    origem           text        NOT NULL CHECK (origem IN ('importada', 'manual', 'documento', 'restaurada')),
    -- Versão de onde o rascunho partiu (a publicada da hora, ou a restaurada).
    baseada_em       uuid        NULL,
    resumo_mudancas  jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(resumo_mudancas) = 'array'),
    documento_nome   text        NULL CHECK (documento_nome IS NULL OR length(documento_nome) <= 200),
    -- Custo do LLM que sugeriu o rascunho (origem documento), em centavos.
    custo_centavos   bigint      NOT NULL DEFAULT 0 CHECK (custo_centavos >= 0),
    criado_por       uuid        NULL,
    criado_em        timestamptz NOT NULL DEFAULT now(),
    atualizado_em    timestamptz NOT NULL DEFAULT now(),
    observacao       text        NULL CHECK (observacao IS NULL OR length(observacao) BETWEEN 10 AND 500),
    publicada_por    uuid        NULL,
    publicada_em     timestamptz NULL,
    arquivada_em     timestamptz NULL,

    PRIMARY KEY (tenant_id, id),
    -- Publicada exige número e observação; arquivada exige ter sido publicada.
    CONSTRAINT agente_playbook_publicacao_coerente CHECK (
        (publicada_em IS NULL AND numero IS NULL AND observacao IS NULL AND arquivada_em IS NULL)
        OR (publicada_em IS NOT NULL AND numero IS NOT NULL AND observacao IS NOT NULL)),
    CONSTRAINT agente_playbook_arquivada_depois CHECK (arquivada_em IS NULL OR arquivada_em >= publicada_em)
);

SELECT aplicar_rls('agente_playbook_versao');

-- Um rascunho e uma publicada por (tenant, coalesce(canal)).
CREATE UNIQUE INDEX agente_playbook_um_rascunho
    ON agente_playbook_versao (tenant_id, coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE publicada_em IS NULL;
CREATE UNIQUE INDEX agente_playbook_uma_publicada
    ON agente_playbook_versao (tenant_id, coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE publicada_em IS NOT NULL AND arquivada_em IS NULL;
-- Número único por escopo; é também o índice do histórico (cursor por número DESC).
CREATE UNIQUE INDEX agente_playbook_numero
    ON agente_playbook_versao (tenant_id, coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid), numero DESC)
    WHERE numero IS NOT NULL;

COMMENT ON TABLE agente_playbook_versao IS
    'Playbook comercial versionado (P17, ADR-033): rascunho → publicada (imutável, com observação) → arquivada. '
    'canal_id NULL = padrão da conta. Restaurar publica uma cópia como versão nova.';

-- ---------------------------------------------------------------------------
-- Imutabilidade: rascunho muda à vontade; publicada só pode ser ARQUIVADA.
-- ---------------------------------------------------------------------------
CREATE FUNCTION agente_playbook_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.publicada_em IS NOT NULL THEN
            RAISE EXCEPTION 'agente_playbook_versao publicada é imutável: não se apaga'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id
       OR NEW.canal_id IS DISTINCT FROM OLD.canal_id OR NEW.criado_em <> OLD.criado_em THEN
        RAISE EXCEPTION 'agente_playbook_versao: identidade e escopo não mudam'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.publicada_em IS NULL THEN
        RETURN NEW;   -- rascunho: editar e publicar (preencher publicada_em/numero/observação)
    END IF;
    -- Publicada: a única mudança aceita é arquivar uma vez.
    IF OLD.arquivada_em IS NULL AND NEW.arquivada_em IS NOT NULL
       AND (to_jsonb(NEW) - 'arquivada_em') = (to_jsonb(OLD) - 'arquivada_em') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'agente_playbook_versao publicada é imutável: restaurar cria versão nova'
        USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER agente_playbook_sem_update
    BEFORE UPDATE OR DELETE ON agente_playbook_versao
    FOR EACH ROW EXECUTE FUNCTION agente_playbook_imutavel();

-- ---------------------------------------------------------------------------
-- Espelho no agente_config.
-- ---------------------------------------------------------------------------
ALTER TABLE agente_config
    ADD COLUMN playbook jsonb NULL;
ALTER TABLE agente_config ADD CONSTRAINT agente_config_playbook_objeto
    CHECK (playbook IS NULL OR jsonb_typeof(playbook) = 'object') NOT VALID;
ALTER TABLE agente_config VALIDATE CONSTRAINT agente_config_playbook_objeto;

COMMENT ON COLUMN agente_config.playbook IS
    'Espelho da versão PUBLICADA do playbook que vale para o número (P17): {versaoId, numero, escopo numero|tenant, '
    'publicadaEm, conteudo}. NULL = sem playbook (o padrão do código vale). Escrito na publicação e no INSERT.';

-- Número configurado DEPOIS da publicação (qualquer caminho de INSERT: tela do
-- agente, compliance, custo): nasce com o playbook do número ou, sem ele, o da
-- conta — persona e slots inclusive. Quem insere com espelho próprio manda.
CREATE FUNCTION agente_config_playbook_inicial() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v record;
BEGIN
    IF NEW.playbook IS NOT NULL THEN
        RETURN NEW;
    END IF;
    -- A MESMA trava por tenant da publicação (playbook/repositorio.ts): um número
    -- nascendo enquanto a conta publica espera e vê a versão final.
    PERFORM pg_advisory_xact_lock(hashtext('agente_playbook'), hashtext(NEW.tenant_id::text));
    SELECT p.id, p.numero, p.conteudo, p.publicada_em, p.canal_id INTO v
      FROM agente_playbook_versao p
     WHERE p.tenant_id = NEW.tenant_id
       AND (p.canal_id = NEW.canal_id OR p.canal_id IS NULL)
       AND p.publicada_em IS NOT NULL AND p.arquivada_em IS NULL
     ORDER BY (p.canal_id IS NULL)   -- o do número antes do da conta
     LIMIT 1;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    NEW.playbook := jsonb_build_object(
        'versaoId', v.id, 'numero', v.numero,
        'escopo', CASE WHEN v.canal_id IS NULL THEN 'tenant' ELSE 'numero' END,
        'publicadaEm', to_jsonb(v.publicada_em), 'conteudo', v.conteudo);
    NEW.persona := (v.conteudo -> 'persona') || '{"idioma": "pt-BR", "identificaComoRobo": true}'::jsonb;
    NEW.qualificacao := coalesce((
        SELECT jsonb_agg(q -> 'slot' ORDER BY ord)
          FROM jsonb_array_elements(v.conteudo -> 'qualificacao') WITH ORDINALITY AS t(q, ord)
         WHERE (q ->> 'ativo')::boolean), '[]'::jsonb);
    RETURN NEW;
END
$$;

CREATE TRIGGER agente_config_playbook_no_insert
    BEFORE INSERT ON agente_config
    FOR EACH ROW EXECUTE FUNCTION agente_config_playbook_inicial();

-- ---------------------------------------------------------------------------
-- Uma simulação por tenant de cada vez (sandbox do playbook / playground).
-- ---------------------------------------------------------------------------
CREATE TABLE agente_simulacao_trava (
    tenant_id  uuid        NOT NULL PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
    token      uuid        NOT NULL,
    ate        timestamptz NOT NULL
);

SELECT aplicar_rls('agente_simulacao_trava');

COMMENT ON TABLE agente_simulacao_trava IS
    'Lease da simulação do agente (P17): uma por tenant; expira sozinha em `ate` se o processo cair.';
