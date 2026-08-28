-- 0078_agente_regras.sql
--
-- AS REGRAS DE ENTRADA DO AGENTE viram configuração por canal.
--
-- ⚠️ Até aqui, QUANDO o robô abre a boca era decidido por constantes no código
--    da API (`HORAS_DESDE_A_AUSENCIA`, `MINUTOS_DE_PRESENCA`, `MAX_CARACTERES`,
--    `FALAS_DE_CONTEXTO`) e por dois `if` fixos no portão. Todas foram
--    calibradas para UM cenário — agente de madrugada cobrindo o vácuo — e
--    mudar qualquer uma exigia deploy. O dono da loja, que convive com o
--    resultado, não tinha como opinar.
--
-- ⚠️ **Todo DEFAULT abaixo é o comportamento que já existia.** A migration não
--    muda o que nenhum tenant tem hoje; ela dá o controle. Um default diferente
--    do código anterior mudaria o agente de todo mundo num deploy silencioso —
--    que é exatamente o tipo de mudança que o produto não pode fazer sozinho.
--
-- ⚠️ Aditiva: só colunas novas com NOT NULL DEFAULT, sem tocar em nada. Roda com
--    a versão anterior ainda atendendo (ADR-006) — a API antiga ignora as
--    colunas, a nova as lê.

-- ─── Quando o agente ENTRA ───────────────────────────────────────────────
ALTER TABLE agente_config
    ADD COLUMN so_quando_ninguem_disponivel boolean  NOT NULL DEFAULT true,
    ADD COLUMN exigir_ausencia_antes        boolean  NOT NULL DEFAULT true,
    ADD COLUMN horas_desde_ausencia         smallint NOT NULL DEFAULT 12,
    ADD COLUMN reabrir_apos_encerrada       boolean  NOT NULL DEFAULT false,
    ADD COLUMN minutos_presenca             smallint NOT NULL DEFAULT 60,
-- ─── Como ele RESPONDE ───────────────────────────────────────────────────
    ADD COLUMN max_caracteres               smallint NOT NULL DEFAULT 320,
    ADD COLUMN falas_de_contexto            smallint NOT NULL DEFAULT 10;

-- ⚠️ As faixas são a rede de segurança do que a tela e o `validarRegrasAgente`
--    de packages/shared já recusam. Duas defesas de propósito: a de cima dá a
--    frase com a ação corretiva, esta impede que um script, um teste ou um
--    `UPDATE` à mão gravem algo que o agente não sabe executar.
ALTER TABLE agente_config
    ADD CONSTRAINT agente_horas_ausencia_sensato  CHECK (horas_desde_ausencia BETWEEN 1 AND 72),
    ADD CONSTRAINT agente_presenca_sensata        CHECK (minutos_presenca      BETWEEN 5 AND 480),
    ADD CONSTRAINT agente_caracteres_sensatos     CHECK (max_caracteres        BETWEEN 80 AND 1000),
    ADD CONSTRAINT agente_falas_sensatas          CHECK (falas_de_contexto     BETWEEN 2 AND 40);

COMMENT ON COLUMN agente_config.so_quando_ninguem_disponivel IS
    '⚠️ A regra de maior consequência da tela. `false` faz o agente responder '
    'COM a equipe na mesa, em horário comercial — é o que abre caminho para '
    'entregar uma conversa a ele de propósito. O padrão true preserva o desenho '
    'original: o robô cobre o vácuo, não substitui o time.';

COMMENT ON COLUMN agente_config.exigir_ausencia_antes IS
    '⚠️ O gatilho de §4.3.1: só conversa com quem escreveu DE NOVO depois da '
    'resposta de ausência. É o filtro que separa o lead interessado de quem '
    'mandou "oi" e dormiu — desligar sobe o custo de IA por conversa.';

COMMENT ON COLUMN agente_config.reabrir_apos_encerrada IS
    '⚠️ Padrão false: um robô que ressuscita depois de dizer que ia chamar '
    'alguém destrói a confiança na entrega ao humano. Ligar é útil em conversa '
    'de teste e em loja que usa o agente como triagem permanente.';

COMMENT ON COLUMN agente_config.minutos_presenca IS
    '⚠️ Vale só para o AGENTE. A resposta de ausência continua na régua de '
    'fábrica (60 min): são dois produtos com tolerâncias diferentes ao risco de '
    'falar por cima de um atendente.';
