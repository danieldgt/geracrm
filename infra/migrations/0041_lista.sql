-- 0041_lista.sql
--
-- Listas (públicos salvos) — Onda 1. Um público CURADO e estático: a vendedora
-- junta à mão os contatos que quer tratar como grupo ("quem visitou a feira",
-- "inadimplentes de março", "top do mês") e reusa depois. É diferente do
-- segmento RFV, que é DERIVADO do comportamento e muda sozinho — a lista é uma
-- escolha humana que só muda quando alguém mexe.
--
-- ⚠️ Aditiva: duas tabelas novas sob RLS, chave composta com tenant_id.

CREATE TABLE lista (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    nome        text        NOT NULL,
    descricao   text,
    criado_por  uuid,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, criado_por) REFERENCES usuario (tenant_id, id)
);
SELECT aplicar_rls('lista');
-- Nome único por tenant — duas "VIP" viram confusão na hora de escolher o alvo.
CREATE UNIQUE INDEX lista_nome_unico ON lista (tenant_id, lower(nome));

CREATE TABLE lista_membro (
    tenant_id   uuid        NOT NULL,
    lista_id    uuid        NOT NULL,
    contato_id  uuid        NOT NULL,
    adicionado_em timestamptz NOT NULL DEFAULT now(),
    adicionado_por uuid,

    -- Um contato entra na lista uma vez só.
    PRIMARY KEY (tenant_id, lista_id, contato_id),
    FOREIGN KEY (tenant_id, lista_id)   REFERENCES lista   (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, adicionado_por) REFERENCES usuario (tenant_id, id)
);
SELECT aplicar_rls('lista_membro');
-- "Quantos e quem nesta lista", e "em que listas está este contato".
CREATE INDEX lista_membro_por_lista   ON lista_membro (tenant_id, lista_id);
CREATE INDEX lista_membro_por_contato ON lista_membro (tenant_id, contato_id);

COMMENT ON TABLE lista IS
    'Público CURADO e estático (escolha humana), distinto do segmento RFV '
    '(derivado do comportamento). Ver rotas-lista.ts.';
