-- 0084_agente_vendedor.sql
--
-- O AGENTE PASSA A VENDER (ADR-023). Plano em docs/plano-mestre-vendedor-autonomo.md.
--
-- ⚠️ Aditiva: colunas novas com DEFAULT, nenhuma removida. A versão anterior da
--    API continua lendo `ativo`; a nova lê `modo` e mantém `ativo` coerente ao
--    gravar. Os dois convivem durante o deploy.

-- ---------------------------------------------------------------------------
-- agente_config: modo, persona, alçada, qualificação, limites
-- ---------------------------------------------------------------------------
ALTER TABLE agente_config
    ADD COLUMN modo               text        NOT NULL DEFAULT 'desligado',
    ADD COLUMN persona            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN objetivo           text        NOT NULL DEFAULT 'vender',
    ADD COLUMN alcada             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN qualificacao       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN modelo             text,
    ADD COLUMN limiar_confianca   numeric(3,2) NOT NULL DEFAULT 0.60,
    ADD COLUMN max_rodadas        smallint    NOT NULL DEFAULT 6,
    ADD COLUMN prazo_turno_ms     integer     NOT NULL DEFAULT 20000,
    ADD COLUMN orcamento_dia_centavos bigint;

ALTER TABLE agente_config
    ADD CONSTRAINT agente_modo_valido
        CHECK (modo IN ('desligado', 'sombra', 'assistido', 'autonomo')),
    ADD CONSTRAINT agente_objetivo_valido
        CHECK (objetivo IN ('vender', 'qualificar')),
    ADD CONSTRAINT agente_limiar_sensato
        CHECK (limiar_confianca BETWEEN 0 AND 1),
    ADD CONSTRAINT agente_rodadas_sensatas
        CHECK (max_rodadas BETWEEN 1 AND 12),
    ADD CONSTRAINT agente_prazo_sensato
        CHECK (prazo_turno_ms BETWEEN 3000 AND 60000);

-- ⚠️ A trava antiga exigia políticas para QUALQUER ativação. Em modo sombra o
--    agente não fala com ninguém — exigir texto curado ali impede justamente o
--    jeito seguro de começar. Só o modo AUTÔNOMO exige base (a rede de
--    segurança continua no banco, só mudou de alvo). Dropar um CHECK é seguro
--    com a versão anterior ainda servindo: ela só fica menos restrita.
ALTER TABLE agente_config DROP CONSTRAINT IF EXISTS agente_ativo_exige_politicas;
ALTER TABLE agente_config
    ADD CONSTRAINT agente_autonomo_exige_politicas CHECK (
        modo <> 'autonomo' OR (politicas IS NOT NULL AND length(btrim(politicas)) > 0));

-- ⚠️ Quem tinha o SDR ligado entra em SOMBRA, não em autônomo (ADR-023 §4: todo
--    canal nasce em sombra). O SDR só qualificava; o vendedor monta pedido e
--    propõe — ligar isso num cliente por migration seria decidir por ele. A
--    tela avisa e o dono religa em autônomo quando quiser.
UPDATE agente_config SET modo = 'sombra' WHERE ativo AND modo = 'desligado';

COMMENT ON COLUMN agente_config.modo IS
    'desligado | sombra (decide e registra, não envia) | assistido (sugere ao vendedor) | '
    'autonomo (envia). ⚠️ Lido a cada turno — tem efeito na próxima mensagem.';
COMMENT ON COLUMN agente_config.persona IS
    'Persona (shared: persona): nome, loja, tom, usaEmojis, saudacao, identificaComoRobo.';
COMMENT ON COLUMN agente_config.alcada IS
    'Alçada (shared: alcadaAgente): valorMaxAutonomoCentavos, descontoMaxPct, efetivaSozinho. '
    '⚠️ Vazio = ALCADA_PADRAO: nunca efetiva sozinho, desconto zero.';
COMMENT ON COLUMN agente_config.qualificacao IS
    'Slots de qualificação que o agente tenta preencher (shared: SLOTS_QUALIFICACAO).';
COMMENT ON COLUMN agente_config.modelo IS
    'Modelo por canal (sobrepõe IA_MODELO). NULL = o do ambiente.';
COMMENT ON COLUMN agente_config.orcamento_dia_centavos IS
    'Teto diário de custo estimado de IA neste canal. NULL = sem teto. Estourou → handoff, nunca silêncio.';

-- ---------------------------------------------------------------------------
-- agente_sessao: memória de curto prazo da venda
-- ---------------------------------------------------------------------------
ALTER TABLE agente_sessao
    ADD COLUMN modo                   text,
    ADD COLUMN fase                   text        NOT NULL DEFAULT 'descoberta',
    ADD COLUMN slots                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN resumo                 text,
    ADD COLUMN resumo_ate_mensagem_id uuid,
    ADD COLUMN pedido_id              uuid,
    ADD COLUMN custo_centavos         bigint      NOT NULL DEFAULT 0;

ALTER TABLE agente_sessao
    ADD CONSTRAINT agente_sessao_fase_valida CHECK (
        fase IN ('descoberta', 'recomendacao', 'proposta', 'fechamento', 'handoff', 'encerrada'));

COMMENT ON COLUMN agente_sessao.slots IS
    'Slots de qualificação já preenchidos (acumulados, nunca sobrescritos). O turno '
    'anterior sobrescrevia `extraido` inteiro — e o modelo re-perguntava o que já sabia.';
COMMENT ON COLUMN agente_sessao.resumo IS
    'Resumo da conversa até `resumo_ate_mensagem_id`, regenerado a cada N turnos. É o '
    'que permite retomar amanhã sem reler tudo.';
