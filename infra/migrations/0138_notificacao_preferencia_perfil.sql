-- 0138_notificacao_preferencia_perfil.sql
--
-- D4 — preferências de notificação por tipo × canal, e-mail pendente e foto do perfil.
--
-- ⚠️ ADITIVA (a versão anterior segue atendendo durante o deploy): tabela nova e colunas com default.
--
-- 1) `usuario_preferencia_notificacao` — uma linha por (usuário, tipo, canal). FALTA DE LINHA = padrão
--    (no sistema e push ligados; e-mail só no SLA e na menção — a regra mora em `packages/shared`).
-- 2) `notificacao.no_app` — a notificação aparece no sino? Com o canal "no sistema" desligado e o push
--    ligado a linha existe só para o push empurrar; o sino e o contador a ignoram. Default true: o
--    código antigo continua gravando como sempre.
-- 3) `notificacao.email_pendente` / `email_enviado_em` — o e-mail sai por um worker (porta de e-mail),
--    nunca dentro da transação que gerou o aviso.
-- 4) `usuario.foto_chave` — chave do objeto no bucket (o tenant vai no prefixo). A URL é assinada e curta.

CREATE TABLE usuario_preferencia_notificacao (
    tenant_id     uuid        NOT NULL,
    usuario_id    uuid        NOT NULL,
    tipo          text        NOT NULL,
    canal         text        NOT NULL CHECK (canal IN ('app', 'push', 'email')),
    ligado        boolean     NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, usuario_id, tipo, canal),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('usuario_preferencia_notificacao');

COMMENT ON TABLE usuario_preferencia_notificacao IS
    'Preferência por (usuário, tipo, canal). Sem linha = padrão do tipo (packages/shared). Só o próprio usuário lê e grava (a rota usa o usuário do token).';

ALTER TABLE notificacao ADD COLUMN no_app boolean NOT NULL DEFAULT true;
ALTER TABLE notificacao ADD COLUMN email_pendente boolean NOT NULL DEFAULT false;
ALTER TABLE notificacao ADD COLUMN email_enviado_em timestamptz;

-- O worker de e-mail varre só o que está pendente (parcial: a tabela quase toda tem false).
CREATE INDEX notificacao_email_pendente ON notificacao (tenant_id, criado_em) WHERE email_pendente;

COMMENT ON COLUMN notificacao.no_app IS
    'false = a pessoa desligou o canal "no sistema" para este tipo; a linha existe só para o push. Sino e contador filtram por esta coluna.';

ALTER TABLE usuario ADD COLUMN foto_chave text;

COMMENT ON COLUMN usuario.foto_chave IS
    'Chave da foto no bucket (tenant/{T}/perfil/{usuario}/...). Nunca URL: a leitura devolve URL assinada curta.';
