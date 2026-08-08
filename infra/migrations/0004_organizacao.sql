-- 0004_organizacao.sql
--
-- A estrutura interna do cliente: filiais, setores, contadores e auditoria.

-- ---------------------------------------------------------------------------
-- filial — a unidade (PLT-01)
-- ---------------------------------------------------------------------------
-- No sistema de referência, os números de WhatsApp aparecem agrupados por
-- filial ("FILIAL SANTA CRUZ") e os indicadores têm filtro "todas as filiais".

CREATE TABLE filial (
    tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id         uuid        NOT NULL,
    nome       text        NOT NULL,
    cidade     text,
    uf         char(2),
    ativa      boolean     NOT NULL DEFAULT true,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)
);

SELECT aplicar_rls('filial');

-- ---------------------------------------------------------------------------
-- setor — destino de transferência de atendimento (INB-15)
-- ---------------------------------------------------------------------------

CREATE TABLE setor (
    tenant_id uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id        uuid        NOT NULL,
    nome      text        NOT NULL,
    ativo     boolean     NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)
);

SELECT aplicar_rls('setor');

-- ---------------------------------------------------------------------------
-- contador_por_tenant — numeração sequencial POR CLIENTE
-- ---------------------------------------------------------------------------
-- ⚠️ SEQUENCE do Postgres NÃO serve aqui: ela é global ao banco. Com ela, o
--    protocolo do cliente A pularia de 41 para 87 porque o cliente B emitiu 45
--    no meio — e protocolo com buraco visível gera chamado de suporte.
--
-- O incremento é atômico via UPDATE ... RETURNING. ⚠️ Proibido
-- ler-incrementar-gravar: é onde nascem dois atendimentos com o mesmo protocolo.

CREATE TABLE contador_por_tenant (
    tenant_id uuid   NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    escopo    text   NOT NULL,     -- 'protocolo' | 'pedido_rascunho' | ...
    valor     bigint NOT NULL DEFAULT 0,

    PRIMARY KEY (tenant_id, escopo)
);

SELECT aplicar_rls('contador_por_tenant');

COMMENT ON TABLE contador_por_tenant IS
    'Numeração sequencial por tenant. SEQUENCE não serve: é global ao banco e '
    'deixaria buracos visíveis no protocolo de cada cliente.';

-- Uso: SELECT proximo_numero(tenant, 'protocolo')
CREATE OR REPLACE FUNCTION proximo_numero(p_tenant uuid, p_escopo text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_valor bigint;
BEGIN
    INSERT INTO contador_por_tenant (tenant_id, escopo, valor)
         VALUES (p_tenant, p_escopo, 1)
    ON CONFLICT (tenant_id, escopo)
      DO UPDATE SET valor = contador_por_tenant.valor + 1
      RETURNING valor INTO v_valor;
    RETURN v_valor;
END;
$$;

COMMENT ON FUNCTION proximo_numero(uuid, text) IS
    'Incremento atômico. O UPSERT com RETURNING garante que duas transações '
    'simultâneas nunca recebem o mesmo número.';

-- ---------------------------------------------------------------------------
-- auditoria — quem fez o quê (PLT-05)
-- ---------------------------------------------------------------------------
-- ⚠️ Auditoria NÃO é log (geracrm-observabilidade). Log é técnico, vive fora e
--    tem retenção curta. Auditoria responde "quem fez isso?" e é requisito de
--    produto: envio, exclusão, transferência, mudança de carteira e acesso do
--    staff a dado de cliente.
--
-- Particionada por mês desde o início: é a segunda tabela que mais cresce.

CREATE TABLE auditoria (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    criado_em   timestamptz NOT NULL DEFAULT now(),
    ator_id     uuid,                    -- NULL = ação do sistema
    ator_staff  boolean     NOT NULL DEFAULT false,
    acao        text        NOT NULL,    -- 'mensagem.enviada', 'carteira.transferida', ...
    entidade    text        NOT NULL,
    entidade_id text,
    dados       jsonb       NOT NULL DEFAULT '{}'::jsonb,

    PRIMARY KEY (tenant_id, criado_em, id)
) PARTITION BY RANGE (criado_em);

SELECT aplicar_rls('auditoria');

-- 12 meses à frente. ⚠️ Criar partição sob demanda, na primeira escrita do mês,
-- é o caminho para uma falha às 00h01 do dia 1º.
DO $$
DECLARE
    inicio date := date_trunc('month', now())::date;
    i int;
    de date; ate date;
BEGIN
    FOR i IN 0..11 LOOP
        de  := inicio + (i    || ' month')::interval;
        ate := inicio + (i + 1 || ' month')::interval;
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS auditoria_%s PARTITION OF auditoria FOR VALUES FROM (%L) TO (%L)',
            to_char(de, 'YYYY_MM'), de, ate
        );
    END LOOP;
END
$$;

CREATE INDEX auditoria_por_entidade ON auditoria (tenant_id, entidade, entidade_id, criado_em DESC);
CREATE INDEX auditoria_por_ator     ON auditoria (tenant_id, ator_id, criado_em DESC);
-- Acesso do staff é a consulta mais sensível: "o que a Gera3 viu deste cliente?"
CREATE INDEX auditoria_staff        ON auditoria (tenant_id, criado_em DESC) WHERE ator_staff;

COMMENT ON TABLE auditoria IS
    'Ações de negócio, para responder "quem fez isso?". Não é log técnico — '
    'vive no banco, com retenção definida, e é requisito de produto (PLT-05).';
