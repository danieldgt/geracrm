-- 0058_midia_estrutura.sql
--
-- Estrutura de VEICULAÇÃO paga — a camada de aquisição (agencia-mkt, AQ-01/02/36).
--
-- ⚠️ Vocabulário: `midia_*` e "veiculação" NÃO são `campanha` (0036), que é disparo
--    de WhatsApp para a base. Unidades e custos diferentes — o mesmo cuidado que fez
--    `contato.qtd_vendas` não se chamar `qtd_pedidos` (AMK-006).
-- ⚠️ Agnóstico de plataforma por desenho: `plataforma` é texto com CHECK (INV-48 proíbe
--    enum), e o adaptador converte na borda — Google devolve custo em MICROS, Meta em
--    float com ponto; centavos inteiros só existem deste lado da porta.
-- Tudo aditivo, tudo sob RLS.

-- ---------------------------------------------------------------------------
-- midia_conta — a conta de anúncio do cliente
-- ---------------------------------------------------------------------------
-- ⚠️ A conta é DO CLIENTE e o meio de pagamento é dele (AMK-002). Operamos como
--    parceiro; sem meio de pagamento a veiculação para, e a falha precisa dizer isso.

CREATE TABLE midia_conta (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id          uuid        NOT NULL,
    plataforma  text        NOT NULL,
    -- Id da conta na plataforma: `customer_id` (Google), `act_<id>` (Meta).
    id_externo  text        NOT NULL,
    nome        text        NOT NULL,
    -- ⚠️ Moeda da CONTA. Sem ela, somar custo de duas contas dá um número sem
    --    significado. Toda soma de custo é por moeda — nunca entre moedas.
    moeda       text        NOT NULL DEFAULT 'BRL',
    ativo       boolean     NOT NULL DEFAULT true,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT midia_conta_plataforma_valida CHECK (plataforma IN ('google','meta','tiktok')),
    CONSTRAINT midia_conta_moeda_valida CHECK (moeda ~ '^[A-Z]{3}$'),
    -- Uma conta externa não entra duas vezes no mesmo tenant.
    CONSTRAINT midia_conta_externa_unica UNIQUE (tenant_id, plataforma, id_externo)
);
SELECT aplicar_rls('midia_conta');

COMMENT ON COLUMN midia_conta.moeda IS
    '⚠️ Custo é somado SEMPRE por moeda. Duas contas em moedas diferentes não '
    'somam — o total precisa ser por conta ou convertido com taxa declarada.';

-- ---------------------------------------------------------------------------
-- midia_campanha — a campanha de veiculação
-- ---------------------------------------------------------------------------

CREATE TABLE midia_campanha (
    tenant_id    uuid        NOT NULL,
    id           uuid        NOT NULL,
    conta_id     uuid        NOT NULL,
    id_externo   text        NOT NULL,
    nome         text        NOT NULL,
    -- Estado espelhado da plataforma.
    estado       text        NOT NULL DEFAULT 'ativa',
    -- ⚠️ AMK-016: o modo de entrada é DECLARADO na campanha e carrega a
    --    consequência junto. `outbound_formulario` obriga fila humana — a regra
    --    2 do roteamento lê ESTA coluna, não a memória do operador.
    modo_entrada text        NOT NULL DEFAULT 'inbound_wa',
    -- ⚠️ AMK-013: a verba é dinâmica, definida por campanha pelo contratante.
    --    Teto NOSSO, validado em código — não é o teto da plataforma (guardrails).
    --    NULL = sem teto declarado; vale então só o teto da conta.
    teto_centavos bigint,
    criado_em    timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conta_id) REFERENCES midia_conta (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT midia_campanha_estado_valido CHECK (estado IN ('rascunho','ativa','pausada','removida')),
    CONSTRAINT midia_campanha_modo_valido CHECK (modo_entrada IN ('inbound_wa','outbound_formulario')),
    CONSTRAINT midia_campanha_teto_positivo CHECK (teto_centavos IS NULL OR teto_centavos > 0),
    CONSTRAINT midia_campanha_externa_unica UNIQUE (tenant_id, conta_id, id_externo)
);
CREATE INDEX midia_campanha_por_conta ON midia_campanha (tenant_id, conta_id, criado_em DESC);
SELECT aplicar_rls('midia_campanha');

COMMENT ON COLUMN midia_campanha.modo_entrada IS
    '⚠️ AMK-016. inbound_wa = LP com botão wa.me, o LEAD escreve primeiro, agente '
    'autônomo permitido. outbound_formulario = nós iniciamos, FILA HUMANA obrigatória. '
    'O roteamento lê esta coluna; configuração errada vira comportamento seguro.';

-- ---------------------------------------------------------------------------
-- midia_conjunto — ad set (Meta) / ad group (Google)
-- ---------------------------------------------------------------------------

CREATE TABLE midia_conjunto (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    campanha_id uuid        NOT NULL,
    id_externo  text        NOT NULL,
    nome        text        NOT NULL,
    estado      text        NOT NULL DEFAULT 'ativa',
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, campanha_id) REFERENCES midia_campanha (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT midia_conjunto_estado_valido CHECK (estado IN ('rascunho','ativa','pausada','removida')),
    CONSTRAINT midia_conjunto_externo_unico UNIQUE (tenant_id, campanha_id, id_externo)
);
CREATE INDEX midia_conjunto_por_campanha ON midia_conjunto (tenant_id, campanha_id);
SELECT aplicar_rls('midia_conjunto');

-- ---------------------------------------------------------------------------
-- midia_anuncio — a peça no ar. É o GRÃO das métricas.
-- ---------------------------------------------------------------------------
-- ⚠️ Criativo (biblioteca versionada) NÃO entra aqui: é AQ-23/25, da Fase 3, e
--    desenhá-lo antes de a fábrica existir arriscaria um rename (2–3 deploys).
--    Adicionar a tabela depois é aditivo, 1 deploy. Desempenho por criativo sai
--    da soma dos anúncios que o usam.

CREATE TABLE midia_anuncio (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    conjunto_id uuid        NOT NULL,
    id_externo  text        NOT NULL,
    nome        text        NOT NULL,
    estado      text        NOT NULL DEFAULT 'ativa',
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conjunto_id) REFERENCES midia_conjunto (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT midia_anuncio_estado_valido CHECK (estado IN ('rascunho','ativa','pausada','removida')),
    CONSTRAINT midia_anuncio_externo_unico UNIQUE (tenant_id, conjunto_id, id_externo)
);
CREATE INDEX midia_anuncio_por_conjunto ON midia_anuncio (tenant_id, conjunto_id);
SELECT aplicar_rls('midia_anuncio');

-- ---------------------------------------------------------------------------
-- midia_metrica_dia — custo e volume, no grão mais fino
-- ---------------------------------------------------------------------------
-- ⚠️ SÓ MÉTRICA ADITIVA MORA AQUI. Impressão, clique e custo somam; ALCANCE e
--    FREQUÊNCIA não — a plataforma deduplica PESSOAS, então somar o alcance de
--    5 anúncios devolve um número maior que a verdade. Se um dia forem
--    necessários, entram em tabela própria, no nível em que foram pedidos.
-- ⚠️ A sincronização é UPSERT, nunca INSERT: as plataformas REESCREVEM o número
--    de dias já fechados enquanto a janela de atribuição assenta (até ~28 dias).
--    A PK (tenant, anuncio, dia) é o que torna o ON CONFLICT possível.

CREATE TABLE midia_metrica_dia (
    tenant_id      uuid   NOT NULL,
    anuncio_id     uuid   NOT NULL,
    dia            date   NOT NULL,
    impressoes     bigint NOT NULL DEFAULT 0,
    cliques        bigint NOT NULL DEFAULT 0,
    -- ⚠️ INV-46: coluna *_centavos é bigint. E o driver devolve bigint como
    --    STRING — toda leitura para cálculo leva cast explícito na consulta.
    custo_centavos bigint NOT NULL DEFAULT 0,
    -- ⚠️ O que a PLATAFORMA reivindica. NÃO é a nossa verdade — a nossa é o
    --    pedido efetivado no ERP. O sufixo existe para que ninguém confunda as
    --    duas num relatório (mesma disciplina de exata × estimada, AMK-009).
    conversoes_plataforma integer NOT NULL DEFAULT 0,
    atualizado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, anuncio_id, dia),
    FOREIGN KEY (tenant_id, anuncio_id) REFERENCES midia_anuncio (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT midia_metrica_nao_negativa CHECK (
        impressoes >= 0 AND cliques >= 0 AND custo_centavos >= 0 AND conversoes_plataforma >= 0
    )
);
-- Recorte por período é a consulta dominante do painel e do analista.
CREATE INDEX midia_metrica_por_dia ON midia_metrica_dia (tenant_id, dia, anuncio_id);
SELECT aplicar_rls('midia_metrica_dia');

COMMENT ON TABLE midia_metrica_dia IS
    '⚠️ Grão = anúncio × dia, o mais fino. Totais de conjunto/campanha são SOMA '
    'daqui — nunca gravados em paralelo, senão nascem duas verdades. Só métrica '
    'ADITIVA: alcance e frequência não somam e ficam de fora.';
COMMENT ON COLUMN midia_metrica_dia.conversoes_plataforma IS
    '⚠️ O que a plataforma reivindica, não o que aconteceu. A verdade é o pedido '
    'efetivado no ERP. As duas nunca aparecem somadas num relatório.';
