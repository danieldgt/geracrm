-- 0066_push_assinatura.sql
--
-- PUSH NATIVO — a notificação que chega com o navegador FECHADO (PLT-07).
--
-- O sino do shell já existe e funciona: `notificacao` (0030) + SSE. Mas ele só
-- avisa quem está com a aba aberta. ⚠️ Quem fechou o console — que é a maioria
-- do tempo — não fica sabendo de mensagem nova, e o cliente espera.
--
-- ⚠️ **Uma assinatura é de um NAVEGADOR, não de uma pessoa.** A mesma vendedora
--    tem o desktop da loja e o celular; e o mesmo navegador pode ser usado por
--    duas pessoas em turnos diferentes. Por isso a chave é o `endpoint` (único
--    GLOBAL — é uma URL que o serviço de push emite por instalação), e o
--    `usuario_id` diz para QUEM notificar naquele aparelho.
--
-- ⚠️ E a assinatura MORRE sozinha: o usuário revoga a permissão, limpa o site,
--    troca de aparelho. O serviço de push responde 404/410 — resposta ESPERADA,
--    não erro. Nesses casos a linha é removida; insistir num endpoint morto é
--    gastar requisição para sempre.
--
-- Aditiva, sob RLS.

CREATE TABLE push_assinatura (
    tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id         uuid        NOT NULL,
    usuario_id uuid        NOT NULL,

    -- URL que o serviço de push (FCM/Mozilla/Apple) emitiu para ESTA instalação.
    endpoint   text        NOT NULL,
    -- Chaves da assinatura: o payload é cifrado para elas no envio.
    -- ⚠️ Não são segredo NOSSO — são do navegador, e sem elas o push não cifra.
    p256dh     text        NOT NULL,
    auth       text        NOT NULL,

    criado_em    timestamptz NOT NULL DEFAULT now(),
    ultimo_uso_em timestamptz,
    ultimo_erro  text,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id) ON DELETE CASCADE,
    -- ⚠️ Único GLOBAL: um endpoint pertence a uma instalação de navegador no
    --    mundo. Duas linhas com o mesmo endpoint mandariam a notificação duas
    --    vezes para o mesmo aparelho.
    CONSTRAINT push_assinatura_endpoint_unico UNIQUE (endpoint)
);

CREATE INDEX push_assinatura_por_usuario ON push_assinatura (tenant_id, usuario_id);

SELECT aplicar_rls('push_assinatura');

COMMENT ON TABLE push_assinatura IS
    'Assinatura de Web Push por INSTALAÇÃO de navegador (PLT-07). ⚠️ endpoint é '
    'único global; 404/410 do serviço de push é resposta esperada e apaga a linha.';

-- ---------------------------------------------------------------------------
-- Cursor do despachante de push
-- ---------------------------------------------------------------------------
-- ⚠️ Mesma forma do despachante de webhooks (0033): um cursor por tenant sobre a
--    tabela de notificações. Sem cursor, o worker teria de varrer a tabela
--    inteira procurando "o que ainda não empurrei" — e a resposta mudaria a cada
--    passada.
--
-- ⚠️ O cursor NASCE NO TOPO (id da última notificação existente) quando o tenant
--    assina o primeiro aparelho: assinar hoje não pode disparar o histórico de
--    notificações da semana passada no celular de alguém.

CREATE TABLE push_cursor (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    ate_criado_em timestamptz NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id)
);

SELECT aplicar_rls('push_cursor');

COMMENT ON COLUMN push_cursor.ate_criado_em IS
    '⚠️ Notificações até aqui já foram empurradas. Nasce no AGORA da primeira '
    'assinatura — assinar hoje não dispara o histórico da semana passada.';
