-- 0097_agente_compliance.sql
--
-- COMPLIANCE EXTRA DO NÚMERO (plano-port-playbook-am, raia P2; ADR-029 §5).
--
-- Frases proibidas e gatilhos de handoff EXTRAS por número, em texto literal
-- (nunca regex): o filtro de saída do agente aplica a lista BASE do código
-- (que não tem chave de desligar) e ACRESCENTA estas. Os gatilhos são lidos
-- pela etapa de gatilhos de entrada (raia P4).
--
--   {"frasesProibidas": [...≤50 × ≤80], "gatilhosHandoff": [...≤50 × ≤80]}
--
-- Os limites de tamanho são validados na borda (Zod em `@geracrm/shared`,
-- `complianceExtra`); aqui só garantimos que é um objeto — leitura tolerante
-- no turno descarta item inválido sem derrubar nada.
--
-- ⚠️ Aditiva: coluna nova com DEFAULT constante (PG ≥ 11 não reescreve a
--    tabela); a versão anterior não a conhece e continua inserindo sem ela.
-- ⚠️ RLS: `agente_config` já tem policy por tenant; coluna nova herda.

ALTER TABLE agente_config
    ADD COLUMN compliance jsonb NOT NULL DEFAULT '{"frasesProibidas":[],"gatilhosHandoff":[]}'::jsonb;

ALTER TABLE agente_config ADD CONSTRAINT agente_compliance_objeto
    CHECK (jsonb_typeof(compliance) = 'object') NOT VALID;
ALTER TABLE agente_config VALIDATE CONSTRAINT agente_compliance_objeto;

COMMENT ON COLUMN agente_config.compliance IS
    'Compliance EXTRA do número (só acrescenta à base do código): {frasesProibidas[], gatilhosHandoff[]}, '
    'literais, ≤50 itens de ≤80 caracteres cada (validado na API).';
