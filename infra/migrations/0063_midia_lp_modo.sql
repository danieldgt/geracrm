-- 0063_midia_lp_modo.sql
--
-- O MODO DE ENTRADA CHEGA À LANDING PAGE (agencia-mkt, AQ-12 + AQ-36/AMK-016).
--
-- `midia_campanha.modo_entrada` existe desde a 0058 e `midia_lead_origem` já
-- guarda o modo do lead (0059). Faltava o meio do caminho: a LP, que é o lugar
-- onde a escolha vira CONSEQUÊNCIA — um botão de WhatsApp ou um formulário.
--
-- ⚠️ **Os dois modos não são a mesma coisa com pele diferente:**
--
-- | Modo | Quem começa a conversa | Consequência |
-- |---|---|---|
-- | `inbound_wa` | o LEAD | janela de 24h nasce ABERTA; o agente pode atender (AMK-014) |
-- | `outbound_formulario` | NÓS | precisa de template pago para falar; quem fala é uma pessoa |
--
-- A regra de roteamento já conhece a diferença (`roteamento-lead.ts`, regra
-- `campanha_outbound`). O que faltava era o dado real chegar até ela em vez de
-- ser suposto.
--
-- Aditiva.

ALTER TABLE midia_lp ADD COLUMN modo text NOT NULL DEFAULT 'inbound_wa';

ALTER TABLE midia_lp ADD CONSTRAINT midia_lp_modo_valido
    CHECK (modo IN ('inbound_wa','outbound_formulario'));

-- ⚠️ Formulário não precisa de número de destino — ninguém vai para o WhatsApp.
--    Exigir um só para preencher a coluna criaria número de mentira no cadastro.
ALTER TABLE midia_lp ALTER COLUMN telefone_destino DROP NOT NULL;

-- Mas no modo WhatsApp ele é obrigatório: LP `inbound_wa` sem destino é um botão
-- que não leva a lugar nenhum.
ALTER TABLE midia_lp ADD CONSTRAINT midia_lp_destino_coerente CHECK (
    modo <> 'inbound_wa' OR telefone_destino IS NOT NULL);

COMMENT ON COLUMN midia_lp.modo IS
    '⚠️ inbound_wa (o lead escreve primeiro; janela de 24h nasce aberta) × '
    'outbound_formulario (nós iniciamos; exige template e pessoa). É copiado para '
    'midia_lead_origem.modo_entrada na entrada do lead.';

-- ---------------------------------------------------------------------------
-- O lead que chega pelo formulário
-- ---------------------------------------------------------------------------
-- ⚠️ O formulário guarda o que a pessoa DIGITOU, e o que ela digitou não é a
--    mesma coisa que o contato criado a partir dele: o telefone pode estar
--    errado, o nome pode ser apelido, e a reconciliação pode ter juntado com um
--    contato que já existia. Guardar a submissão crua é o que permite responder
--    "foi isto que ele preencheu" — inclusive quando o contato foi mesclado.
CREATE TABLE midia_lp_submissao (
    tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id         uuid        NOT NULL,
    lp_id      uuid        NOT NULL,
    sessao_id  uuid,
    -- O contato resolvido (novo ou reconciliado pelo telefone, ADR-019).
    contato_id uuid,

    nome       text        NOT NULL,
    telefone   text        NOT NULL,
    email      text,
    mensagem   text,

    -- ⚠️ Carimbo do SERVIDOR, nunca do navegador.
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, lp_id)     REFERENCES midia_lp        (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, sessao_id) REFERENCES midia_sessao_lp (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato        (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX midia_lp_submissao_por_data ON midia_lp_submissao (tenant_id, criado_em DESC);

SELECT aplicar_rls('midia_lp_submissao');

COMMENT ON TABLE midia_lp_submissao IS
    '⚠️ O que a pessoa DIGITOU no formulário, cru. Diferente do contato criado a '
    'partir dele: o telefone pode estar errado e a reconciliação pode ter juntado '
    'com um contato existente. É o registro de "foi isto que ele preencheu".';
