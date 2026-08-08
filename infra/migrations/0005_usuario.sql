-- 0005_usuario.sql
--
-- Usuários e permissões (PLT-02).
--
-- ⚠️ A decisão que estrutura esta migration: `usuario` NÃO tem coluna `papel`.
--
--    O papel é POR FILIAL. A mesma pessoa é gestora da filial de Santa Cruz e
--    atendente na de Caruaru — situação comum em rede. Uma coluna `papel` no
--    usuário força escolher uma das duas, e a resposta que sobra é errada.
--
--    Quem "simplifica" acrescentando a coluna reintroduz exatamente o bug que
--    esta modelagem fecha.

CREATE TABLE usuario (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id          uuid        NOT NULL,
    -- Identificador no Cognito (ADR-006). Único GLOBALMENTE, não por tenant:
    -- um sub do Cognito pertence a uma pessoa só.
    cognito_sub text        UNIQUE,
    nome        text        NOT NULL,
    email       text        NOT NULL,
    ativo       boolean     NOT NULL DEFAULT true,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    -- E-mail único dentro do tenant, não globalmente: a mesma pessoa pode ser
    -- usuária de dois clientes nossos (consultor, contador, staff de revenda).
    CONSTRAINT usuario_email_unico_no_tenant UNIQUE (tenant_id, email)
);

SELECT aplicar_rls('usuario');

COMMENT ON TABLE usuario IS
    'Usuário da plataforma. ⚠️ SEM coluna papel — papel é por filial (usuario_filial).';
COMMENT ON COLUMN usuario.cognito_sub IS
    'Único global: um sub do Cognito é uma pessoa. E-mail, ao contrário, é único '
    'por tenant — a mesma pessoa pode atender dois clientes nossos.';

-- ---------------------------------------------------------------------------
-- usuario_filial — o papel, que é por unidade
-- ---------------------------------------------------------------------------
-- ⚠️ `filial_id NULL` significa escopo de TENANT INTEIRO — o admin que enxerga
--    todas as unidades. Não é dado faltando: é a linha que representa "todas".

CREATE TABLE usuario_filial (
    tenant_id  uuid        NOT NULL,
    usuario_id uuid        NOT NULL,
    filial_id  uuid,       -- NULL = todas as filiais
    papel      text        NOT NULL,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, filial_id)  REFERENCES filial  (tenant_id, id) ON DELETE CASCADE,

    CONSTRAINT usuario_filial_papel_valido CHECK (papel IN (
        'admin',      -- tudo, inclusive faturamento
        'gestor',     -- metas, campanhas, BI, equipe
        'supervisor', -- fila, transferência, monitoramento
        'vendedor',   -- carteira própria, atendimento, pedido
        'atendente'   -- atendimento, sem carteira
    ))
);

-- PK precisa tratar NULL como valor: (tenant, usuario, NULL) é uma linha só.
-- ⚠️ PRIMARY KEY não aceita coluna nula, e UNIQUE trata NULLs como distintos —
--    ou seja, permitiria dez linhas "todas as filiais" para o mesmo usuário.
CREATE UNIQUE INDEX usuario_filial_unico
    ON usuario_filial (tenant_id, usuario_id, filial_id)
    WHERE filial_id IS NOT NULL;
CREATE UNIQUE INDEX usuario_filial_unico_tenant_inteiro
    ON usuario_filial (tenant_id, usuario_id)
    WHERE filial_id IS NULL;

SELECT aplicar_rls('usuario_filial');

COMMENT ON COLUMN usuario_filial.filial_id IS
    'NULL = todas as filiais do tenant. Os dois índices únicos parciais existem '
    'porque UNIQUE trata NULLs como distintos e permitiria linhas duplicadas.';

-- ---------------------------------------------------------------------------
-- Preferências, sessões e perfil (A-03 da revisão)
-- ---------------------------------------------------------------------------

CREATE TABLE usuario_preferencia (
    tenant_id     uuid        NOT NULL,
    usuario_id    uuid        NOT NULL,
    chave         text        NOT NULL,
    valor         jsonb       NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, usuario_id, chave),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id) ON DELETE CASCADE,

    CONSTRAINT usuario_preferencia_chave_valida CHECK (chave IN (
        'aparencia',     -- claro | escuro | sistema
        'escopo_ativo',  -- ⚠️ filial e número selecionados (exigência 23)
        'notificacoes',  -- por evento × canal
        'assinatura'     -- texto anexado às mensagens da atendente
    ))
);

SELECT aplicar_rls('usuario_preferencia');

COMMENT ON COLUMN usuario_preferencia.chave IS
    'escopo_ativo é a única forma de app e console concordarem sobre qual número '
    'a vendedora está atendendo. No localStorage, os dois discordam e ela atende '
    'pelo número errado.';

CREATE TABLE usuario_sessao (
    tenant_id    uuid        NOT NULL,
    id           uuid        NOT NULL,
    usuario_id   uuid        NOT NULL,
    dispositivo  text,
    user_agent   text,
    ip_ultimo    inet,
    criado_em    timestamptz NOT NULL DEFAULT now(),
    visto_em     timestamptz NOT NULL DEFAULT now(),
    encerrada_em timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('usuario_sessao');

CREATE INDEX usuario_sessao_ativas
    ON usuario_sessao (tenant_id, usuario_id, visto_em DESC)
    WHERE encerrada_em IS NULL;

COMMENT ON TABLE usuario_sessao IS
    'Dispositivos ativos. Sem esta tabela, "desativar usuário encerra as sessões" '
    'vira um ativo=false que só faz efeito no próximo login.';

CREATE TABLE usuario_perfil (
    tenant_id         uuid        NOT NULL,
    usuario_id        uuid        NOT NULL,
    foto_chave_objeto text,
    -- Bloqueio por tentativas de login. A lista de usuários exibe o cadeado.
    bloqueada_ate     timestamptz,
    -- Espelho do estado no Cognito, só para exibir o selo sem chamar a AWS
    -- a cada listagem. ⚠️ O 2FA em si vive no Cognito, não aqui.
    mfa_ativo         boolean     NOT NULL DEFAULT false,
    atualizado_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, usuario_id),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('usuario_perfil');

-- ---------------------------------------------------------------------------
-- FK adiada de 0003b
-- ---------------------------------------------------------------------------
-- `onboarding_passo.concluido_por` nasceu sem FK porque `usuario` não existia.

ALTER TABLE onboarding_passo
    ADD CONSTRAINT onboarding_passo_concluido_por_fk
    FOREIGN KEY (tenant_id, concluido_por) REFERENCES usuario (tenant_id, id);

-- ---------------------------------------------------------------------------
-- token_integracao — Bearer da API pública (INT-03)
-- ---------------------------------------------------------------------------
-- ⚠️ Guarda HASH, nunca o token. O segredo é exibido UMA vez, na criação.
--    Token recuperável em tela é token que vaza em captura de tela e em
--    compartilhamento de acesso.

CREATE TABLE token_integracao (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id            uuid        NOT NULL,
    nome          text        NOT NULL,
    hash          text        NOT NULL,
    prefixo       text        NOT NULL,   -- primeiros caracteres, para identificar na lista
    escopos       text[]      NOT NULL DEFAULT '{}',
    ultimo_uso_em timestamptz,
    revogado_em   timestamptz,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    criado_por    uuid,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, criado_por) REFERENCES usuario (tenant_id, id),
    CONSTRAINT token_hash_unico UNIQUE (hash)
);

SELECT aplicar_rls('token_integracao');

CREATE INDEX token_integracao_ativos
    ON token_integracao (tenant_id) WHERE revogado_em IS NULL;

COMMENT ON COLUMN token_integracao.hash IS
    'Hash do token, nunca o valor. Exibido uma única vez na criação (INV-41).';
