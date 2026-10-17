-- 0105_agente_revisao.sql
--
-- REVISÃO HUMANA E CONCORDÂNCIA (ADR-031 §5, raia P16).
--
--   agente_revisao — o veredito de um revisor (gestor/admin) sobre UMA avaliação
--     de qualidade (agente_avaliacao) da amostra semanal do número:
--       notas humanas por critério da rubrica (0–5), gravidade que o humano viu
--       (CRITICA | ALTA | MEDIA | NULL = nenhuma), veredito (ok | ajustar | grave)
--       e a decisão com responsável e prazo.
--     A CONCORDÂNCIA é calculada na gravação (shared calcularConcordancia) e
--     CONGELADA junto com o que o sistema disse naquele momento (notas_llm,
--     gravidade_sistema): se a avaliação for refeita depois, a revisão continua
--     comparando com o que o revisor viu.
--       concorda = |LLM − humano| <= 1 em cada critério E mesma classe de
--       gravidade. NULL = não comparável (a avaliação não tinha nota do juiz).
--     UNIQUE (tenant_id, avaliacao_id, revisor_id): regravar do mesmo revisor é
--     idempotente, mas a 1ª gravação é IMUTÁVEL no que mede: notas, gravidade,
--     concordância, concorda e falso negativo não mudam depois (a API só atualiza
--     veredito, decisão, responsável, prazo e observação). Sem isso o revisor
--     veria as notas do juiz e "corrigiria" a própria nota para inflar a métrica.
--     A soma conta UMA revisão por (conversa, semana) — a 1ª comparável (shared
--     somarConcordancia): dois revisores na mesma conversa não dobram o peso.
--     semana (IYYY-Www, fuso da loja) e motivo da amostra ficam gravados: a
--     concordância semanal por número é uma soma sobre esta tabela.
--
-- ⚠️ Aditiva: tabela nova. A versão anterior não a conhece.
-- ⚠️ Sem PII: só notas, enums, id do revisor, responsável (texto curto) e observação.

CREATE TABLE agente_revisao (
    tenant_id              uuid        NOT NULL,
    id                     uuid        NOT NULL,
    avaliacao_id           uuid        NOT NULL,
    revisor_id             uuid        NOT NULL,
    conversa_id            uuid        NOT NULL,
    canal_id               uuid        NOT NULL,
    -- Semana ISO da avaliação no fuso da loja ('2026-W42').
    semana                 text        NOT NULL,
    -- Por que a conversa entrou na amostra (shared MOTIVOS_AMOSTRA); NULL = fora da amostra daquela semana.
    motivo                 text,
    -- {criterio: 0..5} — os 5 critérios da rubrica.
    notas                  jsonb       NOT NULL,
    gravidade              text,
    veredito               text        NOT NULL,
    decisao                text        NOT NULL DEFAULT 'nenhuma',
    responsavel            text,
    prazo                  date,
    observacao             text,
    -- Congelado na gravação: o que o juiz e as regras disseram.
    notas_llm              jsonb,
    gravidade_sistema      text,
    -- {criterio: bool | null, gravidade: bool}
    concordancia           jsonb       NOT NULL,
    concorda               boolean,
    falso_negativo_critica boolean     NOT NULL DEFAULT false,
    criado_em              timestamptz NOT NULL DEFAULT now(),
    atualizado_em          timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, avaliacao_id) REFERENCES agente_avaliacao (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, revisor_id)   REFERENCES usuario (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id)  REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)     REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_revisao_uma_por_revisor UNIQUE (tenant_id, avaliacao_id, revisor_id),
    CONSTRAINT agente_revisao_semana_valida CHECK (semana ~ '^[0-9]{4}-W[0-9]{2}$'),
    CONSTRAINT agente_revisao_motivo_valido CHECK (motivo IS NULL OR motivo IN ('critica', 'alta_ou_nota_baixa', 'aleatoria')),
    CONSTRAINT agente_revisao_notas_objeto CHECK (jsonb_typeof(notas) = 'object'),
    CONSTRAINT agente_revisao_gravidade_valida CHECK (gravidade IS NULL OR gravidade IN ('CRITICA', 'ALTA', 'MEDIA')),
    CONSTRAINT agente_revisao_gravidade_sistema_valida CHECK (gravidade_sistema IS NULL OR gravidade_sistema IN ('CRITICA', 'ALTA', 'MEDIA')),
    CONSTRAINT agente_revisao_veredito_valido CHECK (veredito IN ('ok', 'ajustar', 'grave')),
    CONSTRAINT agente_revisao_decisao_valida CHECK (decisao IN (
        'nenhuma', 'ajustar_prompt', 'nova_regra', 'falso_positivo', 'calibrar_juiz', 'orientar_equipe', 'recuar_modo')),
    -- Decisão com ação tem dono e prazo (RN-23 da AM: ocorrência com responsável e prazo).
    CONSTRAINT agente_revisao_decisao_com_dono CHECK (decisao = 'nenhuma' OR (responsavel IS NOT NULL AND prazo IS NOT NULL)),
    CONSTRAINT agente_revisao_responsavel_curto CHECK (responsavel IS NULL OR char_length(responsavel) <= 120),
    CONSTRAINT agente_revisao_observacao_curta CHECK (observacao IS NULL OR char_length(observacao) <= 1000)
);

SELECT aplicar_rls('agente_revisao');

-- Concordância da semana por número e o estado "revisada" da amostra.
CREATE INDEX agente_revisao_por_semana   ON agente_revisao (tenant_id, semana, canal_id);
CREATE INDEX agente_revisao_por_conversa ON agente_revisao (tenant_id, conversa_id, semana);
-- FK do revisor (exclusão/consulta de usuário sem varrer a tabela).
CREATE INDEX agente_revisao_por_revisor  ON agente_revisao (tenant_id, revisor_id);

COMMENT ON TABLE agente_revisao IS
    'Revisão humana semanal das avaliações de qualidade (ADR-031 §5): notas por critério, gravidade, veredito e decisão; '
    'concordância com o juiz congelada na gravação. Uma por (avaliação, revisor).';
