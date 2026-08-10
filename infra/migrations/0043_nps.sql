-- 0043_nps.sql
--
-- NPS — satisfação do cliente (Onda 3). Uma resposta é uma nota 0–10 de um
-- contato, com comentário opcional. O SCORE (%promotores − %detratores) e as
-- faixas (detrator 0–6, neutro 7–8, promotor 9–10) NÃO são gravados: são
-- derivados na leitura, senão a definição de faixa viraria dado congelado e
-- divergente do padrão NPS.
--
-- ⚠️ A COLETA (mandar a pergunta pela conversa/campanha) é outra história e vem
-- depois; aqui registramos e apuramos o que já foi respondido — inclusive o que
-- a vendedora ouviu no telefone e lança à mão (origem='manual').
--
-- ⚠️ Aditiva, sob RLS, chave composta com tenant_id.

CREATE TABLE nps_resposta (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    contato_id    uuid,       -- NULL: resposta anônima/avulsa
    nota          smallint    NOT NULL,
    comentario    text,
    origem        text        NOT NULL DEFAULT 'manual',
    respondido_em timestamptz NOT NULL DEFAULT now(),
    criado_por    uuid,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE SET NULL,
    FOREIGN KEY (tenant_id, criado_por) REFERENCES usuario (tenant_id, id),
    CONSTRAINT nps_nota_valida   CHECK (nota BETWEEN 0 AND 10),
    CONSTRAINT nps_origem_valida CHECK (origem IN ('manual','campanha','conversa','importacao'))
);
SELECT aplicar_rls('nps_resposta');

-- Leitura quente: "as respostas do período" (score + comentários recentes).
CREATE INDEX nps_por_periodo ON nps_resposta (tenant_id, respondido_em DESC);
-- "O histórico de NPS deste contato" — para a ficha.
CREATE INDEX nps_por_contato ON nps_resposta (tenant_id, contato_id, respondido_em DESC)
    WHERE contato_id IS NOT NULL;

COMMENT ON TABLE nps_resposta IS
    'Respostas de NPS (nota 0–10 + comentário). Score e faixas são DERIVADOS na '
    'leitura (padrão NPS), nunca gravados. Ver rotas-nps.ts.';
