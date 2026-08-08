-- 0008_contato_nucleo.sql
--
-- O núcleo do cadastro de cliente.
--
-- ⚠️ Com o varejo em primeiro lugar (ADR-019), a premissa mudou: muito cliente
--    tem SÓ TELEFONE E PRIMEIRO NOME. Nada aqui pode exigir documento, e o
--    telefone normalizado passou de chave secundária a PRIMÁRIA de reconciliação.

-- ---------------------------------------------------------------------------
-- grupo_economico — o mesmo dono, vários CNPJs
-- ---------------------------------------------------------------------------
-- Relevante no atacado (rede de lojas do mesmo dono). No varejo fica vazio, e
-- tudo bem: a coluna existir não custa nada, e criá-la depois com base cheia
-- custa migration de dado.

CREATE TABLE grupo_economico (
    tenant_id uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id        uuid        NOT NULL,
    nome      text        NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)
);

SELECT aplicar_rls('grupo_economico');

-- ---------------------------------------------------------------------------
-- contato — a entidade central
-- ---------------------------------------------------------------------------

CREATE TABLE contato (
    tenant_id      uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id             uuid        NOT NULL,
    -- ⚠️ NOME É O ÚNICO OBRIGATÓRIO. Nem documento, nem telefone, nem e-mail.
    --    No varejo o cadastro nasce com "Maria" e um telefone; às vezes só com
    --    o telefone, e o nome chega depois pelo WhatsApp.
    nome           text        NOT NULL,
    grupo_id       uuid,
    filial_id      uuid,
    -- Classificação comercial. No perfil varejo costuma ser sempre 'varejo';
    -- no atacado distingue quem compra para revender.
    modalidade     text,
    -- Qualificação (CTT-05). NULL = ainda não avaliado — diferente de desqualificado.
    qualificado    boolean,
    qualificado_em timestamptz,
    -- ⚠️ Desnormalizados de propósito, mantidos no mesmo commit do fato que os
    --    altera. Ordenam o kanban e alimentam a Fila do Dia; calcular ao vivo
    --    numa coluna de 11 mil cards não termina.
    ultimo_toque_em timestamptz,
    qtd_vendas      integer     NOT NULL DEFAULT 0,
    -- ⚠️ "qtd_vendas", não "qtd_pedidos": a fonte de verdade de compra é a
    --    venda, e nem toda venda tem pedido — a maioria é lançada no PDV.
    --    Um contador chamado "pedidos" alimentando a coluna "1 pedido" do
    --    kanban seria uma segunda verdade nascendo dentro do nome.
    total_vendas_centavos bigint NOT NULL DEFAULT 0,
    primeira_venda_em     timestamptz,
    ultima_venda_em       timestamptz,
    -- Preferências de contato (CTT-08). ⚠️ Opt-out é invariante, não filtro:
    --    desligar aqui bloqueia em TODOS os caminhos, inclusive disparo manual.
    recebe_campanhas  boolean  NOT NULL DEFAULT true,
    recebe_automacoes boolean  NOT NULL DEFAULT true,
    -- De onde este contato veio. ⚠️ Necessário para conciliar a carga histórica:
    --    sem isto não dá para separar "veio do ERP" de "nasceu de uma conversa".
    origem_carga   text,
    representante  boolean     NOT NULL DEFAULT false,
    ativo          boolean     NOT NULL DEFAULT true,
    criado_em      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, grupo_id)  REFERENCES grupo_economico (tenant_id, id),
    FOREIGN KEY (tenant_id, filial_id) REFERENCES filial          (tenant_id, id),
    CONSTRAINT contato_qualificacao_coerente CHECK (
        (qualificado IS NULL AND qualificado_em IS NULL) OR
        (qualificado IS NOT NULL AND qualificado_em IS NOT NULL)
    )
);

SELECT aplicar_rls('contato');

COMMENT ON COLUMN contato.nome IS
    '⚠️ Único campo obrigatório de identidade. No varejo (ADR-019) o cliente '
    'frequentemente tem só nome e telefone — exigir documento inviabilizaria o cadastro.';
COMMENT ON COLUMN contato.qtd_vendas IS
    'Contador desnormalizado, atualizado no mesmo commit da venda. Alimenta a '
    'coluna do kanban e a ordenação — calcular ao vivo em 11 mil cards não termina.';
COMMENT ON COLUMN contato.origem_carga IS
    'Distingue contato vindo da carga histórica do que nasceu numa conversa. '
    'Sem isto a conciliação do critério de saída da Onda 0 não fecha.';

-- ---------------------------------------------------------------------------
-- contato_nome — o mesmo cliente com nomes diferentes por fonte
-- ---------------------------------------------------------------------------
-- Observado no sistema de referência: "ver todos os nomes". O ERP diz
-- "SATURNO E ALVES LTDA", o WhatsApp diz "Saturno Modas", a vendedora salvou
-- como "Sat. Feira Nova". Os três são o mesmo cliente e nenhum é errado.

CREATE TABLE contato_nome (
    tenant_id  uuid        NOT NULL,
    contato_id uuid        NOT NULL,
    seq        smallint    NOT NULL,
    nome       text        NOT NULL,
    fonte      text        NOT NULL,   -- 'erp' | 'whatsapp' | 'manual' | 'importacao'
    preferido  boolean     NOT NULL DEFAULT false,
    visto_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, contato_id, seq),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('contato_nome');

-- Um preferido por contato.
CREATE UNIQUE INDEX contato_nome_preferido_unico
    ON contato_nome (tenant_id, contato_id) WHERE preferido;

-- ---------------------------------------------------------------------------
-- contato_telefone — a chave de reconciliação
-- ---------------------------------------------------------------------------
-- ⚠️ Com o varejo em primeiro lugar, esta é A tabela de identidade.

CREATE TABLE contato_telefone (
    tenant_id      uuid        NOT NULL,
    contato_id     uuid        NOT NULL,
    seq            smallint    NOT NULL,
    -- Normalizado na ESCRITA (packages/shared). "+55 81 99861-7049",
    -- "5581998617049" e "81998617049" chegam ao banco iguais.
    e164           text        NOT NULL,
    -- ⚠️ 55 + DDD + ÚLTIMOS 8 dígitos. Colide com e sem o nono dígito, porque
    --    o mesmo cliente aparece das duas formas entre ERP e WhatsApp — e o
    --    opt-out precisa valer para as duas (INV-50).
    chave_bloqueio text        NOT NULL,
    principal      boolean     NOT NULL DEFAULT false,
    whatsapp       boolean,
    fonte          text        NOT NULL,
    visto_em       timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, contato_id, seq),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('contato_telefone');

-- ⚠️ ÚNICA PARCIAL, só sobre o principal.
--    Única total sobre e164 quebraria a ingestão: no varejo é comum a mesma
--    linha telefônica aparecer em dois cadastros (mãe e filha, casal, a loja e
--    a dona). Impedir isso na escrita faria a carga histórica falhar em massa.
--    A duplicidade é tratada por mesclagem (CTT-11), não por recusa.
CREATE UNIQUE INDEX contato_telefone_principal_unico
    ON contato_telefone (tenant_id, e164) WHERE principal;

CREATE UNIQUE INDEX contato_telefone_um_principal_por_contato
    ON contato_telefone (tenant_id, contato_id) WHERE principal;

-- A busca do inbox e a reconciliação da ingestão.
CREATE INDEX contato_telefone_por_e164   ON contato_telefone (tenant_id, e164);
CREATE INDEX contato_telefone_por_chave  ON contato_telefone (tenant_id, chave_bloqueio);

COMMENT ON COLUMN contato_telefone.chave_bloqueio IS
    '55 + DDD + últimos 8 dígitos. O truncamento é o que faz colidir com e sem '
    'o nono dígito — sem ele, o opt-out valeria para uma grafia e não para a outra.';

-- ---------------------------------------------------------------------------
-- contato_documento — opcional, e é isso que importa
-- ---------------------------------------------------------------------------

CREATE TABLE contato_documento (
    tenant_id  uuid        NOT NULL,
    contato_id uuid        NOT NULL,
    seq        smallint    NOT NULL,
    tipo       text        NOT NULL,   -- 'cnpj' | 'cpf'
    numero     text        NOT NULL,   -- só dígitos
    fiscal     boolean     NOT NULL DEFAULT false,
    fonte      text        NOT NULL,
    visto_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, contato_id, seq),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT contato_documento_tipo_valido CHECK (tipo IN ('cnpj','cpf'))
);

SELECT aplicar_rls('contato_documento');

-- Um documento fiscal por contato — o que vai na nota.
CREATE UNIQUE INDEX contato_documento_fiscal_unico
    ON contato_documento (tenant_id, contato_id) WHERE fiscal;

-- ⚠️ Também parcial: o mesmo CNPJ pode aparecer em contatos distintos até a
--    mesclagem acontecer. Recusar na escrita faria a ingestão morrer no meio.
CREATE INDEX contato_documento_por_numero
    ON contato_documento (tenant_id, tipo, numero);

-- ---------------------------------------------------------------------------
-- contato_endereco
-- ---------------------------------------------------------------------------

CREATE TABLE contato_endereco (
    tenant_id  uuid        NOT NULL,
    contato_id uuid        NOT NULL,
    seq        smallint    NOT NULL,
    logradouro text,
    numero     text,
    complemento text,
    bairro     text,
    cidade     text,
    uf         char(2),
    cep        text,
    principal  boolean     NOT NULL DEFAULT false,
    fonte      text        NOT NULL,

    PRIMARY KEY (tenant_id, contato_id, seq),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('contato_endereco');

CREATE UNIQUE INDEX contato_endereco_principal_unico
    ON contato_endereco (tenant_id, contato_id) WHERE principal;

-- Cidade alimenta o mapa de clientes e o copiloto ("como estão as vendas em Feira Nova?").
CREATE INDEX contato_endereco_por_cidade ON contato_endereco (tenant_id, uf, cidade);
