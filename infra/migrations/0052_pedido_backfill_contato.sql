-- 0052_pedido_backfill_contato.sql
--
-- Vincula ao cliente os pedidos que nasceram no chat SEM contato_id.
--
-- ⚠️ Aditiva e corretiva: pedidos criados via conversa gravavam contato_id NULL
--    (só conversa_id). Na lista /pedidos apareciam "sem cliente" mesmo depois de
--    confirmados, e não entravam em /v1/contatos/:id/pedidos. Aqui preenchemos o
--    contato_id a partir da conversa do próprio pedido. Só toca linhas órfãs
--    (contato_id IS NULL e conversa_id presente) — não altera pedido já vinculado.
--    A criação nova já resolve o contato pela conversa (rotas-pedido.ts).

UPDATE pedido p
   SET contato_id = cv.contato_id
  FROM conversa cv
 WHERE p.contato_id IS NULL
   AND p.conversa_id IS NOT NULL
   AND cv.id = p.conversa_id
   AND cv.tenant_id = p.tenant_id
   AND cv.contato_id IS NOT NULL;
