-- 0103_agente_sugestao.sql
--
-- SUGESTÃO DO ASSISTIDO, COPILOTO E MÉTRICA DE EDIÇÃO (plano-port-playbook-am, raia P13;
-- ADR-028 "assistido sugere", ADR-031 critérios de fase).
--
-- A sugestão NÃO é tabela nova: é a própria `agente_decisao` do turno (modo `assistido`) ou do
-- pedido do vendedor (modo `copiloto`). Aqui entra o que o vendedor fez com ela:
--
--   sugestao_estado       — NULL = pendente; 'enviada' (sem edição) | 'editada' | 'descartada' |
--                           'superada' (o vendedor respondeu outra coisa sem usá-la).
--   sugestao_mensagem_id  — a mensagem saliente que o vendedor mandou a partir da sugestão.
--   sugestao_usada_em     — quando o vendedor decidiu (enviou ou descartou).
--   sugestao_similaridade — similaridade sugerido × enviado (shared `similaridadeTextos`, [0,1]).
--   sombra_similaridade   — em modo SOMBRA: o que o robô diria × a 1ª mensagem que o humano mandou
--                           depois (critério de fase "sombra ≥ 0,6", ADR-031 — proposta).
--
-- ⚠️ Aditiva: colunas novas NULL, sem DEFAULT — a versão anterior não as conhece e continua
--    inserindo sem elas; nada é reescrito.
-- ⚠️ CHECK em duas etapas (NOT VALID + VALIDATE), como na 0096: as colunas nascem NULL, a
--    validação é trivial e não segura a varredura junto do ALTER.
-- ⚠️ `sugestao_mensagem_id` sem FK: `mensagem` é particionada e tem chave composta (mesma razão
--    de aviso_privacidade.mensagem_id).
-- ⚠️ RLS: coluna nova herda a policy da linha (0086) — nada a fazer além de não recriar a tabela.

ALTER TABLE agente_decisao
    ADD COLUMN sugestao_estado       text          NULL,
    ADD COLUMN sugestao_mensagem_id  uuid          NULL,
    ADD COLUMN sugestao_usada_em     timestamptz   NULL,
    ADD COLUMN sugestao_similaridade numeric(4,3)  NULL,
    ADD COLUMN sombra_similaridade   numeric(4,3)  NULL,
    -- Copiloto: quem pediu ("Sugestão pedida por Ana"). usuario.id; sem FK — `usuario` tem chave
    -- composta e ON DELETE SET NULL anularia também o tenant_id da linha.
    ADD COLUMN sugestao_pedida_por   uuid          NULL;

ALTER TABLE agente_decisao ADD CONSTRAINT agente_decisao_sugestao_estado_valido
    CHECK (sugestao_estado IN ('enviada', 'editada', 'descartada', 'superada')) NOT VALID;
ALTER TABLE agente_decisao VALIDATE CONSTRAINT agente_decisao_sugestao_estado_valido;

ALTER TABLE agente_decisao ADD CONSTRAINT agente_decisao_sugestao_similaridade_faixa
    CHECK (sugestao_similaridade BETWEEN 0 AND 1) NOT VALID;
ALTER TABLE agente_decisao VALIDATE CONSTRAINT agente_decisao_sugestao_similaridade_faixa;

ALTER TABLE agente_decisao ADD CONSTRAINT agente_decisao_sombra_similaridade_faixa
    CHECK (sombra_similaridade BETWEEN 0 AND 1) NOT VALID;
ALTER TABLE agente_decisao VALIDATE CONSTRAINT agente_decisao_sombra_similaridade_faixa;

-- Desfecho só junto do instante da decisão (e a mensagem só com envio).
ALTER TABLE agente_decisao ADD CONSTRAINT agente_decisao_sugestao_coerente
    CHECK ((sugestao_estado IS NULL) = (sugestao_usada_em IS NULL)
           AND (sugestao_mensagem_id IS NULL OR sugestao_estado IN ('enviada', 'editada'))) NOT VALID;
ALTER TABLE agente_decisao VALIDATE CONSTRAINT agente_decisao_sugestao_coerente;

-- Índice PARCIAL da consulta quente do inbox: "a sugestão pendente desta conversa" — só as
-- decisões que são sugestão (assistido/copiloto) e ainda não foram decididas. Pequeno por desenho:
-- toda sugestão sai dele quando o vendedor envia, descarta ou responde por cima ('superada').
-- (Tabela ainda pequena no dogfooding; com volume, recriar CONCURRENTLY em migration própria.)
CREATE INDEX agente_decisao_sugestao_pendente
    ON agente_decisao (tenant_id, conversa_id, criado_em DESC)
    WHERE modo IN ('assistido', 'copiloto') AND sugestao_estado IS NULL;

COMMENT ON COLUMN agente_decisao.sugestao_estado IS
    'P13: o que o vendedor fez com a sugestão (assistido/copiloto). NULL = pendente; enviada | editada | descartada | superada.';
COMMENT ON COLUMN agente_decisao.sugestao_similaridade IS
    'P13: similaridade sugerido × enviado, Jaccard de palavras significativas (shared similaridadeTextos).';
COMMENT ON COLUMN agente_decisao.sombra_similaridade IS
    'P13: em sombra, similaridade entre a resposta que o robô daria e a 1ª mensagem humana seguinte.';

-- CONCESSÃO DO COPILOTO: uma geração por conversa, entre INSTÂNCIAS, sem conexão presa.
-- Quem pega a concessão grava `expira_em` (prazo do turno + folga) e um `token`; a próxima
-- geração só entra se a linha não existe ou já expirou (INSERT … ON CONFLICT DO UPDATE WHERE
-- expira_em < now()). Soltar = DELETE pelo token. Processo que morreu: a concessão expira sozinha.
-- ⚠️ Não é advisory lock de sessão: segurar uma conexão do pool por geração esgotava o pool
--    com N copilotos simultâneos (revisão P13).
CREATE TABLE copiloto_geracao (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    conversa_id uuid        NOT NULL,
    token       uuid        NOT NULL,
    expira_em   timestamptz NOT NULL,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, conversa_id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('copiloto_geracao');

COMMENT ON TABLE copiloto_geracao IS
    'P13: concessão com TTL de uma geração de copiloto por conversa (entre instâncias). Linha some ao terminar.';
