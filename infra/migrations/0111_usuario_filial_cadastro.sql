-- 0111_usuario_filial_cadastro.sql
--
-- CADASTRO DE USUÁRIOS E FILIAIS (raia D3 — plano-paridade-am #97, #98, #103).
--
--   usuario — telefone, cargo e o carimbo do último login (a lista de usuários
--             mostra "último acesso"; o login grava, a tela só lê).
--   filial  — cor (o chip da unidade nas telas) e tipo matriz/filial.
--             `ativa` já existe desde a 0004 — não é recriada.
--
-- ⚠️ Aditiva: só colunas anuláveis ou com DEFAULT. A versão anterior não as
--    conhece e segue funcionando. Nenhuma tabela nova (o RLS de `usuario` e
--    `filial` vem da 0004/0005 e cobre as colunas novas).
--
-- ⚠️ `usuario` continua SEM coluna papel (0005): o papel é por filial, em
--    `usuario_filial`. `cargo` é TEXTO LIVRE de exibição ("Vendedora externa"),
--    nunca autoriza nada — a autorização é `papel.ts` / `escopo.ts`.

ALTER TABLE usuario ADD COLUMN IF NOT EXISTS telefone        text;
ALTER TABLE usuario ADD COLUMN IF NOT EXISTS cargo           text;
ALTER TABLE usuario ADD COLUMN IF NOT EXISTS ultimo_login_em timestamptz;

COMMENT ON COLUMN usuario.cargo IS
    'Texto livre de exibição. ⚠️ Não autoriza nada: papel é por filial (usuario_filial).';
COMMENT ON COLUMN usuario.ultimo_login_em IS
    'Gravado no login bem-sucedido (rotas-auth). NULL = nunca entrou.';

ALTER TABLE filial ADD COLUMN IF NOT EXISTS cor  text;
ALTER TABLE filial ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'filial';

ALTER TABLE filial ADD CONSTRAINT filial_tipo_valido CHECK (tipo IN ('matriz', 'filial'));
-- Cor no formato que o console consome (#RRGGBB) — texto qualquer quebraria o chip.
ALTER TABLE filial ADD CONSTRAINT filial_cor_valida CHECK (cor IS NULL OR cor ~ '^#[0-9A-Fa-f]{6}$');

-- Uma matriz por tenant: duas "matrizes" tornam o relatório por unidade ambíguo.
CREATE UNIQUE INDEX IF NOT EXISTS filial_matriz_unica ON filial (tenant_id) WHERE tipo = 'matriz';

COMMENT ON COLUMN filial.tipo IS 'matriz | filial. No máximo uma matriz por tenant (filial_matriz_unica).';
