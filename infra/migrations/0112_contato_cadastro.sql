-- 0112_contato_cadastro.sql
--
-- Cadastro completo do contato (raia A1). Aditiva: só ADD COLUMN nullable,
-- seguro com a versão anterior ainda atendendo.
--
-- `modalidade` já existe (0008) e o endereço mora em `contato_endereco` (0009);
-- ambos são reutilizados. `origem_id` fica SEM FK de propósito: a tabela
-- `origem` nasce na raia A4, que cria a FK composta depois.

ALTER TABLE contato ADD COLUMN IF NOT EXISTS razao_social            text;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS nome_fantasia           text;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS email                   text;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS prioridade              text;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS temperatura             text;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS origem_id               uuid;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS valor_estimado_centavos bigint;
ALTER TABLE contato ADD COLUMN IF NOT EXISTS observacoes             text;

DO $$ BEGIN
  ALTER TABLE contato ADD CONSTRAINT contato_prioridade_valida
    CHECK (prioridade IS NULL OR prioridade IN ('baixa','media','alta','urgente'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE contato ADD CONSTRAINT contato_temperatura_valida
    CHECK (temperatura IS NULL OR temperatura IN ('frio','morno','quente'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE contato ADD CONSTRAINT contato_valor_estimado_nao_negativo
    CHECK (valor_estimado_centavos IS NULL OR valor_estimado_centavos >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN contato.origem_id IS
    'Origem do lead (raia A4 cria a tabela e a FK composta). Até lá, só guarda o id.';
