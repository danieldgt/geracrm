-- 0098_aviso_privacidade.sql
--
-- AVISO DE PRIVACIDADE EXIBIDO + CONFIGURAÇÃO DO TENANT (plano-port-playbook-am,
-- raia P4; ADR-029).
--
--   tenant_privacidade — o que o tenant exibe: link, versão e texto padrão. Uma
--                        linha por tenant; sem linha = texto padrão do código
--                        ("Esta conversa fica registrada…"), versão 'padrao'.
--   aviso_privacidade  — PROVA de que o aviso foi exibido a um contato: qual
--                        texto, qual versão, em qual mensagem, por quem (agente
--                        ou humano) e quando. É o que a LGPD pede ("ciência do
--                        aviso"), e não pode ser escrito sem o envio ter dado
--                        certo — `registrarAvisoSeExibido` só aceita envio ok.
--
-- ⚠️ Aviso é FATO histórico: imutável, nunca editado. Mudou a versão? A
--    próxima exibição grava outra linha; as antigas continuam provando o que o
--    contato viu na época.
-- ⚠️ `mensagem_id` sem FK: `mensagem` tem chave composta e é particionada por
--    criado_em (mesma razão de cliente_memoria.origem_mensagem_id). O UNIQUE
--    por mensagem torna o registro idempotente (retentativa não duplica).
-- ⚠️ Aditiva: só tabelas novas, nada que a versão anterior leia.

CREATE TABLE tenant_privacidade (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    url           text,
    versao        text        NOT NULL DEFAULT 'padrao',
    texto_padrao  text,
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id),
    CONSTRAINT tenant_privacidade_url_http CHECK (url IS NULL OR url ~ '^https?://'),
    CONSTRAINT tenant_privacidade_url_curta CHECK (url IS NULL OR length(url) <= 300),
    CONSTRAINT tenant_privacidade_versao_curta CHECK (length(versao) BETWEEN 1 AND 40),
    CONSTRAINT tenant_privacidade_texto_curto CHECK (texto_padrao IS NULL OR length(texto_padrao) <= 500)
);

SELECT aplicar_rls('tenant_privacidade');

CREATE TABLE aviso_privacidade (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    contato_id  uuid        NOT NULL,
    conversa_id uuid        NOT NULL,
    canal_id    uuid        NOT NULL,
    mensagem_id uuid        NOT NULL,
    texto       text        NOT NULL,
    versao      text        NOT NULL,
    origem      text        NOT NULL,
    exibido_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT aviso_privacidade_origem_valida CHECK (origem IN ('agente', 'humano')),
    CONSTRAINT aviso_privacidade_texto_curto CHECK (length(texto) BETWEEN 1 AND 2000)
);

SELECT aplicar_rls('aviso_privacidade');

-- Idempotência: uma exibição por mensagem.
CREATE UNIQUE INDEX aviso_privacidade_por_mensagem
    ON aviso_privacidade (tenant_id, mensagem_id);

-- Lista por contato, paginada por cursor (exibido_em DESC, id DESC).
CREATE INDEX aviso_privacidade_por_contato
    ON aviso_privacidade (tenant_id, contato_id, exibido_em DESC, id DESC);

-- ⚠️ IMUTÁVEL DE VERDADE: prova não se edita. O trigger barra UPDATE de
--    qualquer papel (inclusive o dono); o REVOKE tira UPDATE e DELETE do papel
--    da aplicação. Apagar só acontece por CASCATA (contato/conversa/canal
--    excluídos — a ação referencial roda com o dono da tabela) ou pela rotina
--    de exclusão LGPD do titular (R10d), executada pelo dono.
CREATE FUNCTION aviso_privacidade_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'aviso_privacidade é imutável: registre uma nova exibição em vez de alterar esta'
        USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER aviso_privacidade_sem_update
    BEFORE UPDATE ON aviso_privacidade
    FOR EACH ROW EXECUTE FUNCTION aviso_privacidade_imutavel();

REVOKE UPDATE, DELETE ON aviso_privacidade FROM geracrm_app;

COMMENT ON TABLE tenant_privacidade IS
    'Aviso de privacidade que o tenant exibe (link, versão, texto padrão). Sem linha = padrão do código.';
COMMENT ON TABLE aviso_privacidade IS
    'Prova de exibição do aviso de privacidade a um contato. Imutável; só gravada após envio ok '
    '(registrarAvisoSeExibido). origem agente = abertura do agente; humano = envio do vendedor (P13).';
