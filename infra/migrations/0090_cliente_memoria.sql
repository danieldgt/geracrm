-- 0090_cliente_memoria.sql
--
-- MEMÓRIA DE LONGO PRAZO DO CLIENTE (raia R3, ADR-023).
--
-- O que o agente aprende numa conversa e vale na próxima: "prefere tamanho G",
-- "achou o frete caro", "compra para revender", "não aceita boleto". Um fato
-- por linha, com tipo, confiança, validade e a mensagem de origem — para que
-- cada lembrança seja contestável e revogável pelo vendedor na tela do contato.
--
-- ⚠️ NUNCA PII sensível. CPF, CNPJ, telefone, e-mail e endereço são recusados
--    pelo código (`memoria.ts`, com teste) ANTES de chegar aqui: o modelo não
--    tem como gravar documento do cliente nem por engano. A tabela guarda
--    preferência e contexto de VENDA, não cadastro — cadastro é `contato`.
--
-- Revogar é marcar `revogado_em`, não apagar: a trilha do que o agente sabia
-- quando decidiu continua existindo (agente_decisao aponta para o turno).

CREATE TABLE cliente_memoria (
    tenant_id           uuid         NOT NULL,
    id                  uuid         NOT NULL,
    contato_id          uuid         NOT NULL,
    tipo                text         NOT NULL,
    fato                text         NOT NULL,
    -- Forma normalizada (minúsculas, sem acento, sem pontuação): é a chave de
    -- deduplicação. "Prefere tamanho G." e "prefere tamanho g" são o mesmo fato.
    fato_normalizado    text         NOT NULL,
    -- Mensagem que originou o fato. Sem FK: `mensagem` é particionada por
    -- criado_em e a chave é composta (mesma razão de agente_sessao.resumo_ate_mensagem_id).
    origem_mensagem_id  uuid,
    confianca           numeric(3,2) NOT NULL DEFAULT 0.80,
    -- NULL = não expira. "Quer receber antes do dia 20" expira no dia 20.
    valido_ate          timestamptz,
    criado_em           timestamptz  NOT NULL DEFAULT now(),
    revogado_em         timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT cliente_memoria_tipo_valido CHECK (
        tipo IN ('preferencia', 'objecao', 'contexto', 'restricao')),
    CONSTRAINT cliente_memoria_fato_curto CHECK (length(fato) BETWEEN 1 AND 300),
    CONSTRAINT cliente_memoria_confianca_valida CHECK (confianca BETWEEN 0 AND 1)
);

SELECT aplicar_rls('cliente_memoria');

-- Leitura do turno: os N fatos mais recentes e vigentes de um contato.
CREATE INDEX cliente_memoria_vigente
    ON cliente_memoria (tenant_id, contato_id, criado_em DESC)
    WHERE revogado_em IS NULL;

-- ⚠️ Deduplicação ATÔMICA: dois turnos anotando o mesmo fato ao mesmo tempo
--    não geram duas linhas — o segundo INSERT cai no ON CONFLICT e vira
--    'duplicado'. Só entre fatos vigentes: revogar e anotar de novo é permitido.
CREATE UNIQUE INDEX cliente_memoria_sem_repeticao
    ON cliente_memoria (tenant_id, contato_id, fato_normalizado)
    WHERE revogado_em IS NULL;

COMMENT ON TABLE cliente_memoria IS
    'Fatos que o agente aprendeu sobre o contato (ADR-023). Nunca CPF/CNPJ/telefone/e-mail/endereço '
    '— recusados em memoria.ts. Revogar marca revogado_em; o vendedor faz isso na tela do contato.';
