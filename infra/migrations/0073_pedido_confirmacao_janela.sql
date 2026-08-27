-- 0073_pedido_confirmacao_janela.sql
--
-- O "SIM" QUE CONFIRMOU O PEDIDO ERRADO.
--
-- ⚠️ Incidente real (2026-08-27, conversa do Alef): o cliente recebeu o resumo
--    de um pedido de R$ 180, disse "Sim" (confirmou certo) e, entusiasmado,
--    seguiu com "EU QUERO", "CONFIRME", "SIM SIM SIM". Cada afirmativa extra
--    confirmou OUTRO pedido pendente da mesma conversa — inclusive um criado
--    TRÊS DIAS ANTES, que ele nunca viu ali.
--
--    Duas causas somadas:
--      · a conversa acumulava vários pedidos em `aguardando_confirmacao`, sem
--        prazo e sem limite;
--      · o "sim" pega "o pendente mais recente", então repetir caminha PARA TRÁS
--        na pilha, confirmando pedidos antigos um a um.
--
--    O resultado é a reclamação clássica: "confirmei um e vieram dois".
--
-- Três colunas, aditivas.

-- ---------------------------------------------------------------------------
-- Quando o resumo foi enviado — o relógio da janela de confirmação
-- ---------------------------------------------------------------------------
-- ⚠️ Coluna PRÓPRIA, e não `atualizado_em`: aquele muda por qualquer edição, e
--    a janela ficaria sendo esticada por operações que o cliente nem viu.
ALTER TABLE pedido ADD COLUMN resumo_enviado_em timestamptz;

COMMENT ON COLUMN pedido.resumo_enviado_em IS
    '⚠️ Quando o resumo foi enviado ao cliente. É o relógio da janela de 24h '
    'para o "sim" valer. Fora da janela, quem confirma é uma pessoa — o cliente '
    'não está mais olhando aquele resumo.';

-- ---------------------------------------------------------------------------
-- Cancelamento com motivo — para o cancelado ser CONSULTÁVEL, não um sumiço
-- ---------------------------------------------------------------------------
ALTER TABLE pedido ADD COLUMN cancelado_em     timestamptz;
ALTER TABLE pedido ADD COLUMN cancelado_motivo text;

COMMENT ON COLUMN pedido.cancelado_motivo IS
    '⚠️ SEMPRE preenchido ao cancelar. Pedido que some sem razão vira mistério '
    'na semana seguinte — e o vendedor precisa poder abrir, entender e '
    'reaproveitar o conteúdo num rascunho novo.';

-- ⚠️ BACKFILL ANTES DO CHECK. A restrição vale para as linhas que JÁ EXISTEM,
--    não só para as novas: um único pedido cancelado sem motivo faria a migration
--    falhar no preDeploy e derrubar o deploy inteiro. Hoje não há nenhum em
--    produção — mas depender disso é apostar que ninguém cancelou nada entre
--    escrever e subir.
UPDATE pedido
   SET cancelado_em     = coalesce(atualizado_em, criado_em),
       cancelado_motivo = 'cancelado antes de o motivo ser registrado (0073)'
 WHERE estado = 'cancelado' AND cancelado_em IS NULL;

-- Coerência: cancelado tem data e motivo; quem não está cancelado não tem nem um.
ALTER TABLE pedido ADD CONSTRAINT pedido_cancelamento_coerente CHECK (
    (estado =  'cancelado' AND cancelado_em IS NOT NULL AND cancelado_motivo IS NOT NULL) OR
    (estado <> 'cancelado' AND cancelado_em IS NULL     AND cancelado_motivo IS NULL));
