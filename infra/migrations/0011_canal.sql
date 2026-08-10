-- 0011_canal.sql
--
-- A frota de canais conectados: WhatsApp hoje, Instagram na sequência.
--
-- ⚠️ A raiz é GENÉRICA desde já (§1.2). O caminho barato seria criar `numero`
--    como raiz e "adaptar para Instagram depois" — mas a chave natural de
--    conversa é `(canal, contato)`, e trocar a raiz depois obriga a reescrever
--    essa chave em `conversa`, `atendimento`, `mensagem` e em todo índice que
--    parte delas. O retrofit não é caro: é impraticável com dado dentro.

CREATE TABLE canal_conectado (
    tenant_id     uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id            uuid        NOT NULL,
    tipo          text        NOT NULL,
    -- Tenant sem filiais é o caso comum no começo.
    filial_id     uuid,
    nome_amigavel text        NOT NULL,
    estado        text        NOT NULL DEFAULT 'conectando',

    -- ⚠️ Capacidades DECLARADAS, não constantes no código (INV-18/19).
    --    A duração da janela e a política de reabertura são propriedade do
    --    canal: WhatsApp reabre por template, Instagram não reabre de jeito
    --    nenhum e não pode ser público de campanha. Constante no código faria
    --    o servidor liberar um envio que a Meta recusa — e o vendedor
    --    descobriria pelo erro, não pela tela.
    capacidades   jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- ⚠️ Credencial CIFRADA e por tenant. Token de uma loja lido por outra é o
    --    pior vazamento possível: dá para mandar mensagem no nome dela.
    credenciais_cifradas bytea,
    conectado_em  timestamptz,
    criado_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, filial_id) REFERENCES filial (tenant_id, id),

    CONSTRAINT canal_tipo_valido CHECK (tipo IN ('whatsapp','instagram')),
    CONSTRAINT canal_estado_valido CHECK (estado IN (
        'conectando',    -- Embedded Signup em andamento
        'conectado',
        'degradado',     -- qualidade caiu; ainda envia
        'suspenso',      -- ⚠️ Meta bloqueou, ou pagamento falhou (INV-21)
        'desconectado'
    ))
);

SELECT aplicar_rls('canal_conectado');

CREATE INDEX canal_por_filial ON canal_conectado (tenant_id, filial_id)
    WHERE filial_id IS NOT NULL;

COMMENT ON COLUMN canal_conectado.capacidades IS
    'Declaradas: {"janelaHoras":24,"aceitaTemplate":true,"podeSerPublicoDeCampanha":true}. '
    '⚠️ Lidas pela função pura de janela em packages/shared, usada por API E console — '
    'a contagem regressiva da tela e o bloqueio do servidor usam a MESMA função.';

-- ---------------------------------------------------------------------------
-- Especializações 1:1 por tipo.
--
-- ⚠️ Colunas nuláveis por tipo dentro da raiz, sem CHECK, é o caminho para dois
--    canais diferentes caírem no mesmo índice único — e para um perfil de
--    Instagram acabar com `tier` preenchido, que não existe lá.
-- ---------------------------------------------------------------------------

CREATE TABLE numero_whatsapp (
    tenant_id       uuid        NOT NULL,
    canal_id        uuid        NOT NULL,
    telefone_e164   text        NOT NULL,
    waba_id         text        NOT NULL,
    phone_number_id text        NOT NULL,
    tier            integer,
    qualidade       text,
    -- ⚠️ INV-21: o gateway de saída recusa antes de chamar a Meta quando isto é
    --    falso. Descobrir pelo erro da Meta é descobrir tarde e por cliente.
    pagamento_ok    boolean     NOT NULL DEFAULT true,
    atualizado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, canal_id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    -- Um número não se conecta duas vezes no mesmo tenant.
    CONSTRAINT numero_whatsapp_telefone_unico UNIQUE (tenant_id, telefone_e164),
    CONSTRAINT numero_qualidade_valida CHECK (qualidade IS NULL OR qualidade IN ('verde','amarelo','vermelho'))
);

SELECT aplicar_rls('numero_whatsapp');

-- ⚠️ `phone_number_id` é a chave do webhook: a mensagem entrante chega dizendo
--    para QUAL phone_number_id, e é por aqui que se acha o tenant.
CREATE UNIQUE INDEX numero_whatsapp_phone_number_id
    ON numero_whatsapp (tenant_id, phone_number_id);

CREATE TABLE perfil_instagram (
    tenant_id  uuid NOT NULL,
    canal_id   uuid NOT NULL,
    ig_user_id text NOT NULL,
    pagina_id  text NOT NULL,

    PRIMARY KEY (tenant_id, canal_id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT perfil_instagram_unico UNIQUE (tenant_id, ig_user_id)
);

SELECT aplicar_rls('perfil_instagram');

-- ---------------------------------------------------------------------------
-- Saúde do canal — HISTÓRICO, não estado atual.
-- ---------------------------------------------------------------------------

CREATE TABLE canal_saude_evento (
    tenant_id uuid        NOT NULL,
    id        uuid        NOT NULL,
    canal_id  uuid        NOT NULL,
    campo     text        NOT NULL,   -- 'tier' | 'qualidade' | 'estado' | 'pagamento_ok'
    de        text,
    para      text        NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('canal_saude_evento');

CREATE INDEX canal_saude_por_canal ON canal_saude_evento (tenant_id, canal_id, criado_em DESC);

COMMENT ON TABLE canal_saude_evento IS
    '⚠️ Histórico, não estado. Guardar só a qualidade atual responde "está verde?" '
    'mas não "quando começou a cair?" — e é a segunda pergunta que salva o número '
    'antes do bloqueio.';

-- ---------------------------------------------------------------------------
-- Configuração operacional do canal.
-- ---------------------------------------------------------------------------

CREATE TABLE canal_configuracao (
    tenant_id          uuid    NOT NULL,
    canal_id           uuid    NOT NULL,
    horario_atendimento jsonb  NOT NULL DEFAULT '{}'::jsonb,
    mensagem_ausencia  text,
    assinatura         text,
    -- ⚠️ É o que a tela de saúde liga e desliga (A-04). Sem esta coluna,
    --    "retomar disparo" não tem o que retomar, e a pausa automática por
    --    queda de qualidade (CAN-06) não tem onde ser registrada.
    disparo_pausado    boolean NOT NULL DEFAULT false,
    pausado_motivo     text,
    pausado_em         timestamptz,

    PRIMARY KEY (tenant_id, canal_id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    -- Pausa sem motivo registrado vira mistério na semana seguinte.
    CONSTRAINT canal_pausa_coerente CHECK (
        (disparo_pausado AND pausado_motivo IS NOT NULL AND pausado_em IS NOT NULL)
        OR NOT disparo_pausado
    )
);

SELECT aplicar_rls('canal_configuracao');

-- ---------------------------------------------------------------------------
-- Quem vê qual canal.
--
-- ⚠️ N:N, não 1:1: a vendedora pode ter dois números e o supervisor vê a frota
--    inteira. Modelar como 1:1 quebra no primeiro supervisor.
-- ---------------------------------------------------------------------------

CREATE TABLE usuario_canal (
    tenant_id  uuid        NOT NULL,
    usuario_id uuid        NOT NULL,
    canal_id   uuid        NOT NULL,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, usuario_id, canal_id),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario         (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)   REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('usuario_canal');

-- O inbox pergunta "quais conversas eu vejo?" partindo do canal.
CREATE INDEX usuario_canal_por_canal ON usuario_canal (tenant_id, canal_id);

-- ---------------------------------------------------------------------------
-- Throttling (INV-23) e limite de tier (INV-22).
--
-- ⚠️ São DUAS regras diferentes, com duas tabelas. Juntar numa só confunde
--    "intervalo entre envios" com "quantos contatos distintos em 24h", e a
--    segunda é a que faz a Meta bloquear o número.
-- ---------------------------------------------------------------------------

CREATE TABLE numero_throttle (
    tenant_id                 uuid        NOT NULL,
    canal_id                  uuid        NOT NULL,
    proximo_envio_permitido_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, canal_id),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('numero_throttle');

COMMENT ON TABLE numero_throttle IS
    'Intervalo mínimo randômico entre dois envios do mesmo número (INV-23). '
    'Tabela minúscula, SEM janela. ⚠️ A reserva é UPDATE … RETURNING atômico: '
    'ler-incrementar-gravar deixa 50 disparos concorrentes passarem juntos.';

-- Reserva por contato: sabe se AQUELE contato já consumiu slot na janela.
CREATE TABLE numero_conversa_iniciada (
    tenant_id   uuid        NOT NULL,
    canal_id    uuid        NOT NULL,
    contato_id  uuid        NOT NULL,
    iniciada_em timestamptz NOT NULL,

    PRIMARY KEY (tenant_id, canal_id, contato_id, iniciada_em),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('numero_conversa_iniciada');

CREATE INDEX numero_conversa_iniciada_janela
    ON numero_conversa_iniciada (tenant_id, canal_id, iniciada_em DESC);

-- Contagem por baldes horários.
CREATE TABLE numero_quota_hora (
    tenant_id          uuid    NOT NULL,
    canal_id           uuid    NOT NULL,
    hora_utc           timestamptz NOT NULL,
    contatos_distintos integer NOT NULL DEFAULT 0,
    limite             integer NOT NULL,

    PRIMARY KEY (tenant_id, canal_id, hora_utc),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT numero_quota_hora_alinhada CHECK (hora_utc = date_trunc('hour', hora_utc))
);

SELECT aplicar_rls('numero_quota_hora');

COMMENT ON TABLE numero_quota_hora IS
    'Contagem do limite de tier (INV-22) em baldes de hora. ⚠️ count(distinct) '
    'sobre a janela móvel a cada reserva varreria uma das linhas mais '
    'contendidas do sistema; o balde dá a soma em 24 leituras de chave primária.';
COMMENT ON TABLE numero_conversa_iniciada IS
    'Reserva de slot por contato, via INSERT … ON CONFLICT DO NOTHING RETURNING. '
    '⚠️ A reserva acontece ANTES da chamada à Meta — reservar depois entrega a '
    'mensagem e só então descobre que estourou o limite, e ela não se desfaz.';
