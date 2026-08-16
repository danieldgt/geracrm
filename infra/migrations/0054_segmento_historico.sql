-- 0054_segmento_historico.sql
--
-- Trajetória do segmento RFV do cliente ao longo do tempo (skill funil-de-vendas:
-- "o que importa mais que a foto é a TRAJETÓRIA — era Campeão e virou Em Risco").
--
-- ⚠️ Grava SÓ NA MUDANÇA (uma linha por transição de segmento), não a cada
--    varredura — senão vira uma série gigante de repetições. Quem decide "mudou"
--    é o worker (compara o segmento atual com o último gravado). O segmento é
--    derivado (classificarRfv, em @geracrm/shared) — aqui é só o registro.

CREATE TABLE contato_segmento_historico (
    tenant_id    uuid        NOT NULL,
    id           uuid        NOT NULL,
    contato_id   uuid        NOT NULL,
    segmento     text        NOT NULL,   -- código do segmento RFV (ex.: 'campeao')
    capturado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);
-- Última posição por contato (o worker lê isto para saber se mudou) + a ficha.
CREATE INDEX contato_segmento_hist_por_contato
    ON contato_segmento_historico (tenant_id, contato_id, capturado_em DESC);
SELECT aplicar_rls('contato_segmento_historico');
