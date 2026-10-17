-- 0096_agente_guardrails_estado.sql
--
-- COSTURA DO PIPELINE DO AGENTE (plano-port-playbook-am, raia P0).
--
-- O turno do vendedor vira um pipeline com etapas de nome fixo (gatilhos de
-- entrada, slots, teto, números, filtro de saída, pergunta repetida,
-- qualidade, política de falha). Cada raia seguinte preenche a SUA etapa sem
-- migration própria para o que é estado de turno ou de sessão:
--
--   agente_decisao.guardrails   — o que cada etapa fez com a resposta deste
--                                  turno: [{etapa, codigo, gravidade, acao,
--                                  trecho?}] (trecho ≤160, mascarado). É o
--                                  "por que o robô NÃO disse isso".
--   agente_decisao.falha_tipo   — classe da falha do provedor de IA quando o
--                                  turno falhou: decide aviso, reagendamento ou
--                                  entrega (ADR-030, raia P5).
--   agente_sessao.estado_agente — estado entre turnos, UMA CHAVE POR RAIA
--                                  (perguntas já feitas, avisos exibidos,
--                                  contagem de "é robô?"…). Merge raso por chave.
--
-- ⚠️ Aditiva: roda com a versão anterior servindo. Colunas novas com DEFAULT
--    (a versão anterior não as conhece e continua inserindo sem elas); o CHECK
--    de modo só AMPLIA o conjunto (todo valor válido antes continua válido).
-- ⚠️ RLS: as duas tabelas já têm policy por tenant (0071, 0086); coluna nova
--    herda a policy da linha — nada a fazer aqui além de não recriar a tabela.

ALTER TABLE agente_decisao
    ADD COLUMN guardrails jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN falha_tipo text NULL
        CONSTRAINT agente_decisao_falha_tipo_valida
        CHECK (falha_tipo IN ('fatal', 'transitoria', 'requisicao', 'formato'));

-- 'copiloto': o vendedor HUMANO pede uma sugestão sob demanda (raia P13). Só
-- leitura — nunca envia, nunca abre sessão —, mas a decisão fica auditada.
ALTER TABLE agente_decisao DROP CONSTRAINT agente_decisao_modo_valido;
ALTER TABLE agente_decisao ADD CONSTRAINT agente_decisao_modo_valido
    CHECK (modo IN ('desligado', 'sombra', 'assistido', 'autonomo', 'simulacao', 'copiloto'));

ALTER TABLE agente_sessao
    ADD COLUMN estado_agente jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN agente_decisao.guardrails IS
    'Marcas das etapas do pipeline neste turno: [{etapa, codigo, gravidade CRITICA|ALTA|MEDIA|INFO, '
    'acao, trecho? (≤160, mascarado)}]. Vazio = nenhuma etapa mexeu na resposta.';
COMMENT ON COLUMN agente_decisao.falha_tipo IS
    'Classe da falha do provedor de IA: fatal | transitoria | requisicao | formato. NULL quando não falhou.';
COMMENT ON COLUMN agente_sessao.estado_agente IS
    'Estado entre turnos do pipeline, uma chave por raia (merge raso). Nunca PII crua.';
