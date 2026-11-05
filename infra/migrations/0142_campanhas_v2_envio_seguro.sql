-- 0142_campanhas_v2_envio_seguro.sql
--
-- CAMPANHAS V2, correcoes da revisao (F1a): indices para o despachante contar o que
-- esta saindo AGORA sem varrer o historico.
--
--   campanha_destinatario_enviando  as linhas reivindicadas (estado enviando): contam no
--                                   lote do dia e no aquecimento, e a varredura de linha
--                                   presa as acha por tenant e instante. Conjunto minusculo
--                                   (no maximo o que esta em voo).
--   campanha_v2_por_canal           o aquecimento soma, por numero, os envios de hoje de
--                                   cada campanha v2 daquele numero.
--
-- Aditiva: so indices novos. As tabelas sao pequenas no momento do deploy (a v2 acabou de
-- entrar); lock_timeout para nao segurar a versao anterior se algo estiver travado.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS campanha_destinatario_enviando
    ON campanha_destinatario (tenant_id, campanha_id, enviando_desde)
    WHERE estado = 'enviando';

CREATE INDEX IF NOT EXISTS campanha_v2_por_canal
    ON campanha (tenant_id, canal_id)
    WHERE modelo_versao = 2;
