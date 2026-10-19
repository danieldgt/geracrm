-- 0110_particoes_horizonte.sql
--
-- HORIZONTE DAS PARTIÇÕES MENSAIS. As tabelas particionadas por mês
-- (auditoria — 0004, mensagem — 0012, venda e item_venda — 0014) só tinham as
-- partições criadas DENTRO das migrations: cada uma acaba ~12 meses depois do
-- dia em que a migration rodou, e nada criava as seguintes. No dia 1º do mês
-- descoberto, o INSERT falha com "no partition of relation found for row" — o
-- inbox para de receber mensagem e a ingestão de venda para no meio.
--
--   tabelas_particionadas_por_mes() — o registro das tabelas mantidas. Um teste
--       confere que TODA tabela particionada por RANGE do schema está nele: a
--       próxima tabela particionada não pode ser esquecida.
--   particoes_mensais_da_tabela()   — as partições e os limites [de, ate) de uma
--       tabela, lidos do catálogo (pg_inherits + relpartbound).
--   horizonte_particoes()           — até onde a cobertura é CONTÍNUA a partir de
--       um instante. Buraco no meio conta como fim: um INSERT ali falha igual.
--   garantir_particoes_mensais()    — ampliada (abaixo).
--   manter_particoes_mensais()      — garante N meses à frente em todas as
--       tabelas do registro e devolve o horizonte de cada uma. É o que o worker
--       diário (`apps/api/src/workers/particoes.ts`) chama, e o que esta
--       migration chama uma vez com 24 meses.
--
-- garantir_particoes_mensais AMPLIADA, retrocompatível:
--   • ganha `referencia timestamptz DEFAULT now()` — chamadas de 3 argumentos
--     seguem iguais; o worker e os testes passam o próprio relógio.
--     ⚠️ DROP + CREATE em vez de CREATE OR REPLACE: com as duas assinaturas
--        convivendo, a chamada de 3 argumentos ficaria AMBÍGUA. Só migration
--        chama a função (nenhum código da versão anterior a usa).
--   • pula o mês que JÁ ESTÁ COBERTO por qualquer partição (pelo limite, não
--     pelo nome): `venda_anterior`, `mensagem_anterior` ou uma partição de nome
--     diferente não fazem mais o CREATE falhar por sobreposição;
--   • limites e nomes calculados em UTC (`SET timezone`), como as partições
--     existentes — uma sessão em outro fuso não cria limites às 03:00.
--
-- ⚠️ Aditiva: funções novas e partições novas. A versão anterior da API não
--    conhece nenhuma delas e continua funcionando — só para de falhar no mês 13.
-- ⚠️ CREATE TABLE … PARTITION OF pega ACCESS EXCLUSIVE na tabela-mãe até o fim
--    da transação. lock_timeout curto: se a mensagem estiver ocupada demais, a
--    migration falha, o deploy não prossegue e a versão anterior segue servindo
--    — melhor que enfileirar o inbox atrás de nós.

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION tabelas_particionadas_por_mes()
RETURNS SETOF text
LANGUAGE sql IMMUTABLE
AS $$
    VALUES ('auditoria'), ('mensagem'), ('venda'), ('item_venda')
$$;

COMMENT ON FUNCTION tabelas_particionadas_por_mes() IS
    'Tabelas particionadas por MÊS mantidas pelo worker de partições. ⚠️ Tabela '
    'particionada nova entra aqui na mesma migration que a cria — o teste '
    '`particoes.test.ts` falha se alguma tabela particionada ficar de fora.';

-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION particoes_mensais_da_tabela(nome_tabela text)
RETURNS TABLE (particao text, de timestamptz, ate timestamptz)
LANGUAGE sql STABLE
SET timezone TO 'UTC'
AS $$
    WITH b AS (
        SELECT c.relname::text AS particao,
               regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \((.+)\) TO \((.+)\)') AS m
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = to_regclass(nome_tabela)
    )
    SELECT particao,
           CASE m[1] WHEN 'MINVALUE' THEN '-infinity'::timestamptz ELSE btrim(m[1], '''')::timestamptz END,
           CASE m[2] WHEN 'MAXVALUE' THEN 'infinity'::timestamptz  ELSE btrim(m[2], '''')::timestamptz END
      FROM b
     WHERE m IS NOT NULL   -- partição DEFAULT não tem limite (nenhuma tabela do registro usa)
$$;

-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION horizonte_particoes(nome_tabela text, referencia timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE plpgsql STABLE
SET timezone TO 'UTC'
AS $$
DECLARE
    cursor_ timestamptz := referencia;
    proximo timestamptz;
BEGIN
    -- Anda de partição em partição enquanto o limite de cima de uma é coberto
    -- pela seguinte. Devolve `referencia` quando nem o instante dela é coberto.
    LOOP
        SELECT max(p.ate) INTO proximo
          FROM particoes_mensais_da_tabela(nome_tabela) p
         WHERE p.de <= cursor_ AND p.ate > cursor_;
        EXIT WHEN proximo IS NULL;
        cursor_ := proximo;
        EXIT WHEN cursor_ = 'infinity'::timestamptz;
    END LOOP;
    RETURN cursor_;
END;
$$;

COMMENT ON FUNCTION horizonte_particoes(text, timestamptz) IS
    'Fim da cobertura CONTÍNUA de partições a partir de `referencia`. Lido pelo '
    'worker de partições e pelo /saude/detalhada (componente "particoes").';

-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION garantir_particoes_mensais(text, int, int);

CREATE FUNCTION garantir_particoes_mensais(
    nome_tabela text,
    meses_a_frente int DEFAULT 12,
    meses_atras int DEFAULT 1,
    referencia timestamptz DEFAULT now()
)
RETURNS int
LANGUAGE plpgsql
SET timezone TO 'UTC'
AS $$
DECLARE
    criadas int := 0;
    inicio timestamptz := date_trunc('month', referencia) - make_interval(months => meses_atras);
    i int; mes_de timestamptz; mes_ate timestamptz; nome text;
BEGIN
    IF to_regclass(nome_tabela) IS NULL THEN
        RAISE EXCEPTION 'tabela % não existe', nome_tabela;
    END IF;
    FOR i IN 0 .. (meses_atras + meses_a_frente) LOOP
        mes_de  := inicio + make_interval(months => i);
        mes_ate := inicio + make_interval(months => i + 1);
        -- Coberto (no todo ou em parte) por qualquer partição: não mexe. Pelo
        -- LIMITE, não pelo nome — a partição de escape (`*_anterior`) e uma
        -- partição de nome diferente fariam o CREATE falhar por sobreposição.
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM particoes_mensais_da_tabela(nome_tabela) p
             WHERE p.de < mes_ate AND p.ate > mes_de);
        nome := format('%s_%s', nome_tabela, to_char(mes_de, 'YYYY_MM'));
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            nome, nome_tabela, mes_de, mes_ate);
        criadas := criadas + 1;
    END LOOP;
    RETURN criadas;
END;
$$;

COMMENT ON FUNCTION garantir_particoes_mensais(text, int, int, timestamptz) IS
    '⚠️ Chamada pelo worker diário de partições. Sem partição do mês seguinte o '
    'INSERT falha no dia 1º e o inbox para de receber mensagem — falha total, no '
    'pior horário, e o erro ("no partition of relation found") não sugere a causa. '
    'Idempotente: mês já coberto (por limite, não por nome) é pulado.';

-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION manter_particoes_mensais(meses_a_frente int DEFAULT 12, referencia timestamptz DEFAULT now())
RETURNS TABLE (tabela text, criadas int, horizonte timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE t text;
BEGIN
    FOR t IN SELECT * FROM tabelas_particionadas_por_mes() LOOP
        tabela := t;
        criadas := garantir_particoes_mensais(t, meses_a_frente, 0, referencia);
        horizonte := horizonte_particoes(t, referencia);
        RETURN NEXT;
    END LOOP;
END;
$$;

-- 24 meses à frente agora; o worker mantém ≥ 12 daqui em diante.
SELECT manter_particoes_mensais(24);
