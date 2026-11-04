-- 0147_reuniao_revisao.sql
--
-- REVISÃO DA RAIA C3 (reunião marcada pelo CRM e pelo agente). ⚠️ ADITIVA: a versão anterior
-- continua funcionando (só escreve tipos/estados que já existiam e ignora as colunas novas).
--
-- • evento_agenda_aviso.tipo ganha 'desfecho' e .estado ganha 'avisado' (decisão do orquestrador,
--   M5): reunião que passou do fim + 2h ainda "agendada" NÃO é no-show — o VENDEDOR é avisado UMA
--   vez para marcar o desfecho. O convite ao cliente e o handoff só existem quando alguém marca
--   "não compareceu". O CHECK fica mais permissivo: DROP + ADD NOT VALID + VALIDATE.
-- • reuniao_oferta.{mensagem_id, enviada_em} (A3): a oferta só vale (é confirmável) depois que a
--   mensagem do turno com as opções foi ENTREGUE ao gateway — marcada no pós-envio do turno.
--   Turno barrado ou envio recusado deixa NULL e o "sim" do cliente não confirma nada.

SET LOCAL lock_timeout = '5s';

ALTER TABLE evento_agenda_aviso DROP CONSTRAINT evento_agenda_aviso_tipo;
ALTER TABLE evento_agenda_aviso ADD CONSTRAINT evento_agenda_aviso_tipo
    CHECK (tipo IN ('h24', 'h2', 'desfecho', 'noshow')) NOT VALID;
ALTER TABLE evento_agenda_aviso VALIDATE CONSTRAINT evento_agenda_aviso_tipo;

ALTER TABLE evento_agenda_aviso DROP CONSTRAINT evento_agenda_aviso_estado;
ALTER TABLE evento_agenda_aviso ADD CONSTRAINT evento_agenda_aviso_estado
    CHECK (estado IN ('pendente', 'enviado', 'recusado', 'aguardando', 'reagendado', 'handoff', 'avisado')) NOT VALID;
ALTER TABLE evento_agenda_aviso VALIDATE CONSTRAINT evento_agenda_aviso_estado;

ALTER TABLE reuniao_oferta
    ADD COLUMN mensagem_id uuid NULL,
    ADD COLUMN enviada_em  timestamptz NULL;

COMMENT ON COLUMN reuniao_oferta.enviada_em IS
    'C3 (A3): quando a mensagem com as opções foi entregue ao gateway. NULL = o cliente não leu esta oferta; não confirma.';
