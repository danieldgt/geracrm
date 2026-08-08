-- 0010_carteira.sql
--
-- Quem é o dono do cliente, e desde quando.
--
-- ⚠️ A decisão que estrutura esta tabela: carteira é HISTÓRICO, não campo.
--
--    Um `contato.vendedor_id` responderia "quem é o dono hoje" e perderia
--    "quem era o dono em março" — que é justamente a pergunta que aparece
--    quando se discute comissão, ou quando a vendedora pergunta por que o
--    cliente dela sumiu da lista.
--
--    E o pdv-core traz `usernameVendedor` em cada cliente, como texto. É daqui
--    que ele desemboca, depois de passar pela correspondência da 0007.

CREATE TABLE carteira_atribuicao (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    contato_id  uuid        NOT NULL,
    -- ⚠️ NULL é valor legítimo: "sem dono". O cliente que ninguém atende
    --    precisa aparecer como órfão, não sumir da consulta. É o estado em que
    --    todo contato nasce quando vem da carga e o vendedor não corresponde.
    usuario_id  uuid,
    de          timestamptz NOT NULL DEFAULT now(),
    ate         timestamptz,
    -- Como esta atribuição aconteceu.
    origem      text        NOT NULL DEFAULT 'manual',
    atribuido_por uuid,
    motivo      text,

    -- Coluna GERADA. ⚠️ O operador de sobreposição (&&) não existe sobre `de`
    --    e `ate` soltas — precisa de um range de verdade, e ele precisa ser
    --    materializado para o índice gist funcionar.
    periodo     tstzrange   GENERATED ALWAYS AS (tstzrange(de, ate, '[)')) STORED,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id)    REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, usuario_id)    REFERENCES usuario (tenant_id, id),
    FOREIGN KEY (tenant_id, atribuido_por) REFERENCES usuario (tenant_id, id),

    CONSTRAINT carteira_periodo_coerente CHECK (ate IS NULL OR ate > de),
    CONSTRAINT carteira_origem_valida CHECK (origem IN (
        'manual',      -- alguém atribuiu na tela
        'carga',       -- veio do ERP, via correspondência (0007)
        'automatica',  -- regra de distribuição
        'remocao'      -- tirou o dono, sem colocar outro
    )),

    -- ⚠️ A restrição que faz a tabela valer: nunca dois donos ao mesmo tempo.
    --    Sem ela, uma transferência mal feita cria dois períodos abertos e o
    --    cliente aparece na lista de duas vendedoras — que é exatamente o tipo
    --    de coisa que vira discussão de comissão.
    --
    --    EXCLUDE precisa de btree_gist (migration 0001) para combinar igualdade
    --    de uuid com sobreposição de range no mesmo índice.
    EXCLUDE USING gist (
        tenant_id  WITH =,
        contato_id WITH =,
        periodo    WITH &&
    )
);

SELECT aplicar_rls('carteira_atribuicao');

-- A consulta do kanban e da Fila do Dia: "os clientes DESTA vendedora, agora".
CREATE INDEX carteira_atual_por_usuario
    ON carteira_atribuicao (tenant_id, usuario_id)
    WHERE ate IS NULL;

-- "Quem é o dono deste cliente?" — uma linha, sempre.
CREATE UNIQUE INDEX carteira_atual_por_contato
    ON carteira_atribuicao (tenant_id, contato_id)
    WHERE ate IS NULL;

-- Histórico do cliente, para a ficha.
CREATE INDEX carteira_historico
    ON carteira_atribuicao (tenant_id, contato_id, de DESC);

COMMENT ON TABLE carteira_atribuicao IS
    'Histórico de posse do cliente. A restrição de exclusão impede dois donos '
    'simultâneos — sem ela, transferência mal feita coloca o cliente na lista de '
    'duas vendedoras, e isso vira discussão de comissão.';
COMMENT ON COLUMN carteira_atribuicao.usuario_id IS
    '⚠️ NULL é legítimo: "sem dono". É o estado de todo contato que vem da carga '
    'histórica cujo vendedor não correspondeu (0007). Órfão precisa aparecer, não sumir.';
COMMENT ON COLUMN carteira_atribuicao.periodo IS
    'Coluna gerada. O operador && não existe sobre `de`/`ate` soltas, e o índice '
    'gist precisa do range materializado.';

-- ---------------------------------------------------------------------------
-- Transferir carteira, sem deixar buraco nem sobreposição
-- ---------------------------------------------------------------------------
-- ⚠️ Fechar o período anterior e abrir o novo em duas instruções separadas
--    permite, entre elas, um instante sem dono — e uma consulta que caia ali
--    devolve o cliente como órfão. Uma função, uma transação.

CREATE OR REPLACE FUNCTION transferir_carteira(
    p_tenant     uuid,
    p_contato    uuid,
    p_novo_dono  uuid,          -- NULL = remover o dono
    p_por        uuid   DEFAULT NULL,
    p_origem     text   DEFAULT 'manual',
    p_motivo     text   DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    v_agora timestamptz := now();
    v_id    uuid;
    v_atual uuid;
BEGIN
    SELECT usuario_id INTO v_atual
      FROM carteira_atribuicao
     WHERE tenant_id = p_tenant AND contato_id = p_contato AND ate IS NULL;

    -- Transferir para quem já é o dono não cria linha nova: o histórico
    -- registraria uma mudança que não aconteceu.
    IF FOUND AND v_atual IS NOT DISTINCT FROM p_novo_dono THEN
        RETURN NULL;
    END IF;

    UPDATE carteira_atribuicao
       SET ate = v_agora
     WHERE tenant_id = p_tenant AND contato_id = p_contato AND ate IS NULL;

    v_id := gen_random_uuid();
    INSERT INTO carteira_atribuicao
           (tenant_id, id, contato_id, usuario_id, de, origem, atribuido_por, motivo)
    VALUES (p_tenant, v_id, p_contato, p_novo_dono, v_agora,
            CASE WHEN p_novo_dono IS NULL THEN 'remocao' ELSE p_origem END,
            p_por, p_motivo);

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION transferir_carteira IS
    'Fecha o período anterior e abre o novo na MESMA transação. Em duas '
    'instruções separadas existe um instante sem dono, e a consulta que cair '
    'ali devolve o cliente como órfão.';
