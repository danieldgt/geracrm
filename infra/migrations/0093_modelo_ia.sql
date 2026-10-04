-- 0093_modelo_ia.sql
--
-- O CATÁLOGO DE MODELOS DE IA e o que cada cliente pode usar (estudo em
-- docs/estudo-modelos-llm.md).
--
-- ⚠️ `modelo_ia` é GLOBAL (sem tenant_id), como `plano`: é a lista que a Gera3
--    mantém dos modelos que o produto sabe operar — fornecedor, id na API,
--    capacidades, custo. Entra na lista fechada de exceções do varredor de
--    tenancy por decisão consciente.
-- ⚠️ `tenant_modelo_ia` é por tenant (RLS): quais entradas do catálogo ESTE
--    cliente pode escolher. Sem linha nenhuma, valem as marcadas
--    `padrao_novos_tenants`. A chave do fornecedor continua sendo NOSSA, no
--    ambiente; o que o cliente escolhe é o modelo, nunca a credencial.

CREATE TABLE modelo_ia (
    codigo                    text        PRIMARY KEY,
    provedor                  text        NOT NULL,
    modelo                    text        NOT NULL,
    nome                      text        NOT NULL,
    descricao                 text        NOT NULL DEFAULT '',
    gratuito                  boolean     NOT NULL DEFAULT false,
    ferramentas               boolean     NOT NULL DEFAULT true,
    saida_estruturada         boolean     NOT NULL DEFAULT true,
    -- 1..5: qualidade observada em pt-BR para VENDA (não é benchmark; é opinião registrada).
    qualidade                 smallint    NOT NULL DEFAULT 3,
    custo_entrada_usd_milhao  numeric(10,4) NOT NULL DEFAULT 0,
    custo_saida_usd_milhao    numeric(10,4) NOT NULL DEFAULT 0,
    janela_contexto           integer     NOT NULL DEFAULT 128000,
    -- Limite gratuito ou observação de operação, em uma frase.
    observacao                text        NOT NULL DEFAULT '',
    ativo                     boolean     NOT NULL DEFAULT true,
    padrao_novos_tenants      boolean     NOT NULL DEFAULT false,
    ordem                     smallint    NOT NULL DEFAULT 100,
    criado_em                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT modelo_ia_provedor_valido CHECK (provedor IN ('claude', 'openrouter', 'groq', 'gemini', 'cerebras', 'maritaca')),
    CONSTRAINT modelo_ia_qualidade_valida CHECK (qualidade BETWEEN 1 AND 5)
);

GRANT SELECT ON modelo_ia TO geracrm_app;

CREATE TABLE tenant_modelo_ia (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    modelo_codigo text        NOT NULL REFERENCES modelo_ia(codigo) ON DELETE CASCADE,
    permitido     boolean     NOT NULL DEFAULT true,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, modelo_codigo)
);

SELECT aplicar_rls('tenant_modelo_ia');

COMMENT ON TABLE modelo_ia IS
    'Catálogo global dos modelos de IA que o produto opera (docs/estudo-modelos-llm.md). '
    'Sem tenant_id por decisão: é mantido pela Gera3, como plano.';
COMMENT ON TABLE tenant_modelo_ia IS
    'Quais modelos do catálogo o tenant pode escolher na tela do agente. Sem linhas = os padrao_novos_tenants.';

-- Catálogo inicial (idempotente). Custos em US$/milhão de tokens, out/2026.
INSERT INTO modelo_ia (codigo, provedor, modelo, nome, descricao, gratuito, ferramentas, saida_estruturada, qualidade,
                       custo_entrada_usd_milhao, custo_saida_usd_milhao, janela_contexto, observacao, padrao_novos_tenants, ordem) VALUES
  ('claude-opus-5-5',   'claude', 'claude-opus-5-5',   'Claude Opus 5.5',   'O melhor vendedor: entende contexto, segue regras, raramente erra ferramenta.', false, true, true, 5, 4.00, 20.00, 1000000, 'Cache de prompt reduz ~60% do custo. Recomendado para autônomo.', true, 10),
  ('claude-sonnet-5-5', 'claude', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Quase a qualidade do Opus, mais rápido e pela metade do preço.', false, true, true, 5, 2.00, 10.00, 1000000, 'Bom equilíbrio para operação diária.', true, 20),
  ('claude-haiku-4-5',  'claude', 'claude-haiku-4-5',  'Claude Haiku 4.5',  'Rápido e barato; serve para triagem e qualificação.', false, true, true, 4, 1.00, 5.00, 200000, 'Retirada anunciada pela Anthropic; não construir sobre ele.', false, 30),
  ('groq-gpt-oss-120b', 'groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 'Modelo aberto da OpenAI servido pelo Groq: boa qualidade, ferramentas, gratuito.', true, true, true, 4, 0.15, 0.60, 131072, 'Grátis: 30 req/min, 1 000 req/dia, 8 000 tokens/min.', true, 40),
  ('groq-llama-3-3-70b', 'groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B (Groq)', 'Aberto, rápido, com ferramentas. O melhor gratuito para começar.', true, true, true, 3, 0.59, 0.79, 131072, 'Grátis: 30 req/min, 1 000 req/dia, 12 000 tokens/min.', true, 50),
  ('groq-gpt-oss-20b',  'groq', 'openai/gpt-oss-20b',  'GPT-OSS 20B (Groq)',  'Menor e mais rápido; aceitável para loja pequena.', true, true, true, 3, 0.075, 0.30, 131072, 'Grátis: 30 req/min, 1 000 req/dia.', false, 60),
  ('groq-llama-3-1-8b', 'groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B (Groq)', 'Muito rápido, mas erra ferramenta e português. Só triagem.', true, true, false, 2, 0.05, 0.08, 131072, 'Grátis: 14 400 req/dia. Não recomendado para vender.', false, 70),
  ('cerebras-llama-3-3-70b', 'cerebras', 'llama-3.3-70b', 'Llama 3.3 70B (Cerebras)', 'Mesmo modelo do Groq, outro fornecedor gratuito — reserva.', true, true, true, 3, 0.85, 1.20, 8192, 'Grátis: 30 req/min, 1 M tokens/dia, contexto limitado a 8k.', false, 80),
  ('gemini-2-5-flash',  'gemini', 'gemini-2.5-flash',  'Gemini 2.5 Flash',  'Bom em pt-BR e com ferramentas; cota gratuita apertada.', true, true, true, 4, 0.30, 2.50, 1000000, 'Grátis: ~5 req/min e ~100 req/dia desde abr/2026 — pouco para atendimento.', false, 90),
  ('openrouter-free',   'openrouter', 'openrouter/free', 'OpenRouter — roteador gratuito', 'Escolhe um modelo gratuito que aceite ferramentas a cada chamada. Qualidade varia.', true, true, true, 2, 0, 0, 128000, 'Grátis; comportamento muda de uma chamada para outra.', false, 100),
  ('openrouter-qwen3-coder-free', 'openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (OpenRouter, grátis)', 'Aberto, segue formato e ferramentas razoavelmente.', true, true, true, 3, 0, 0, 262144, 'Grátis; limites do OpenRouter por conta.', false, 110),
  ('maritaca-sabia-3-1', 'maritaca', 'sabia-3.1', 'Sabiá 3.1 (Maritaca)', 'Modelo brasileiro, o melhor português do grupo; barato.', false, true, true, 4, 1.00, 2.00, 128000, 'R$ 5 / R$ 10 por milhão de tokens. Verificar ferramentas na conta.', false, 120)
ON CONFLICT (codigo) DO NOTHING;
