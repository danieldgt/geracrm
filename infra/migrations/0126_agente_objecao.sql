-- 0126_agente_objecao.sql
--
-- OBJEÇÕES REGISTRADAS PELO AGENTE (plano de paridade AM, raia G2; #93, #104).
--
--   agente_objecao — um FATO por chamada da ferramenta `registrar_objecao`: o
--     cliente levantou a objeção OBJ-xx do playbook do número e o agente a
--     reverteu (ou não). É a fonte do relatório "Objeções" (vezes, % revertida)
--     da aba Métricas — `GET /v1/agente/objecoes/resumo`.
--
--     ⚠️ O que DECIDE a entrega ao humano na 3ª objeção não revertida seguida é a
--        etapa do pipeline `objecoes-seguidas`, lendo `agente_sessao.estado_agente`
--        (chave `objecoes`). Esta tabela é só relatório.
--     ⚠️ Só o modo AUTÔNOMO e o ASSISTIDO gravam aqui: sombra, simulação e copiloto
--        não são a conversa real do agente (a ferramenta responde em modo seco e o
--        estado da sessão guarda o registro).
--     sessao_id é NULL quando a objeção veio no 1º turno da sessão: a sessão nasce
--     no fim do turno, depois da ferramenta (sem FK por isso).
--     `objecao` é o texto da objeção no playbook NAQUELE momento (relatório estável
--     quando o playbook muda depois). `observacao` vem do modelo, mascarada.
--
-- ⚠️ Aditiva: tabela nova. A versão anterior não a conhece.
-- ⚠️ Sem PII: código, booleano, o texto do negócio e uma observação curta mascarada.

CREATE TABLE agente_objecao (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    canal_id    uuid        NOT NULL,
    conversa_id uuid        NOT NULL,
    contato_id  uuid        NOT NULL,
    sessao_id   uuid,
    codigo      text        NOT NULL,
    objecao     text        NOT NULL,
    revertida   boolean     NOT NULL,
    observacao  text,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT agente_objecao_codigo     CHECK (codigo ~ '^OBJ-[0-9]{2}$'),
    CONSTRAINT agente_objecao_objecao    CHECK (char_length(objecao) BETWEEN 1 AND 200),
    CONSTRAINT agente_objecao_observacao CHECK (observacao IS NULL OR char_length(observacao) <= 200)
);

-- O resumo lê uma janela por número (ou da conta inteira) e agrupa por código.
CREATE INDEX agente_objecao_por_canal ON agente_objecao (tenant_id, canal_id, criado_em DESC);
CREATE INDEX agente_objecao_por_data  ON agente_objecao (tenant_id, criado_em DESC);

SELECT aplicar_rls('agente_objecao');

COMMENT ON TABLE agente_objecao IS
    'Objeções do playbook registradas pelo agente (registrar_objecao), com se foram revertidas. '
    'Só relatório: a entrega na 3ª seguida é decidida pela etapa objecoes-seguidas sobre o estado da sessão.';
