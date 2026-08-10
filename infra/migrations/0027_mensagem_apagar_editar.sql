-- 0027_mensagem_apagar_editar.sql
--
-- Apagar e editar mensagem (como no WhatsApp). Colunas ADITIVAS (a versão
-- anterior segue servindo): NULL = mensagem normal.
--
-- ⚠️ Não removemos a linha ao apagar: a thread mostra "Esta mensagem foi
--    apagada" (como o WhatsApp) e a auditoria precisa saber que existiu.

ALTER TABLE mensagem ADD COLUMN IF NOT EXISTS apagada_em          timestamptz;
ALTER TABLE mensagem ADD COLUMN IF NOT EXISTS apagada_para_todos  boolean;
ALTER TABLE mensagem ADD COLUMN IF NOT EXISTS editada_em          timestamptz;

COMMENT ON COLUMN mensagem.apagada_em IS
    'Quando foi apagada (NULL = não apagada). apagada_para_todos distingue '
    '"apagar para todos" (recall no WhatsApp) de "apagar para mim" (só na tela).';
COMMENT ON COLUMN mensagem.editada_em IS
    'Quando o texto foi editado (NULL = nunca). A tela mostra "(editada)".';
