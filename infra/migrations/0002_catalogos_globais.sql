-- 0002_catalogos_globais.sql
--
-- As tabelas que NÃO têm tenant_id. São catálogos do produto, iguais para todos
-- os clientes: o que vendemos (planos), os perfis de vertical disponíveis e a
-- tabela de preços da Meta.
--
-- ⚠️ REGRA DE REVISÃO: a lista de tabelas sem tenant_id é FECHADA (modelo §7.2).
--    Tabela nova sem tenant_id que não esteja nessa lista é bug de revisão de
--    migration, não decisão de implementação. O varredor de schema falha o CI.
--
-- Como não têm tenant, não têm RLS. Em compensação, o papel da aplicação só
-- recebe SELECT — escrita nestas tabelas é operação de administração do produto,
-- não de uso do produto.

-- ---------------------------------------------------------------------------
-- plano — o catálogo comercial (PLT-06)
-- ---------------------------------------------------------------------------
-- O que existe para vender. NÃO confundir com `assinatura_tenant` (0003), que é
-- o que ESTE cliente paga. Um é cardápio, o outro é a conta.

CREATE TABLE plano (
    id          uuid        PRIMARY KEY,
    codigo      text        NOT NULL UNIQUE,
    nome        text        NOT NULL,
    -- Limites contratados: números, usuários, disparos/mês, conectores.
    -- JSONB porque a lista de limites cresce e cada plano usa um subconjunto.
    limites     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Módulos que o plano libera. É o que o cadeado de upsell lê (PLT-06).
    modulos     text[]      NOT NULL DEFAULT '{}',
    ativo       boolean     NOT NULL DEFAULT true,
    criado_em   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  plano IS 'Catálogo de planos do produto. Sem tenant_id (§7.2).';
COMMENT ON COLUMN plano.modulos IS
    'Módulos liberados. GET /eu compara com isto para distinguir "não contratado" '
    'de "sem permissão" — a tela precisa dos dois separados (exigência 20).';

-- ---------------------------------------------------------------------------
-- perfil_vertical_modelo — os perfis disponíveis (ADR-004)
-- ---------------------------------------------------------------------------
-- O molde. Cada tenant instancia um em `perfil_vertical` (0003) e pode ajustar.
-- "Moda Atacado" nasce completo; é o cliente inicial e o teste da abstração.

CREATE TABLE perfil_vertical_modelo (
    id                uuid        PRIMARY KEY,
    codigo            text        NOT NULL UNIQUE,
    nome              text        NOT NULL,
    -- Nomenclatura da UI: como este ramo chama produto, grade, cliente.
    rotulos           jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Atributos de produto obrigatórios: cor, tamanho, referência...
    atributos         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Pedido mínimo, múltiplo de grade, mix mínimo.
    regras_pedido     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- As 11 faixas de RFV e os cortes padrão do ramo.
    faixas_rfv        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ativo             boolean     NOT NULL DEFAULT true,
    criado_em         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE perfil_vertical_modelo IS
    'Moldes de vertical (ADR-004). O tenant instancia em perfil_vertical e ajusta.';

-- ---------------------------------------------------------------------------
-- tarifa_meta — quanto a Meta cobra (E3-12)
-- ---------------------------------------------------------------------------
-- ⚠️ O cliente paga a Meta direto (ADR-002), mas QUEM MOSTRA O ROI SOMOS NÓS.
--    Sem esta tabela, o custo por campanha (CMP-12) e o ROI da ferramenta
--    (BI-11) não existem — e são o diferencial central do produto.
--
-- Preço varia por categoria e por país do destinatário, e muda com aviso.
-- Por isso tem vigência: uma campanha de junho tem de ser calculada com a
-- tarifa de junho, não com a de hoje.

CREATE TABLE tarifa_meta (
    id             uuid        PRIMARY KEY,
    pais           text        NOT NULL,          -- ISO 3166-1 alpha-2: 'BR'
    categoria      text        NOT NULL,          -- marketing | utility | authentication | service
    moeda          text        NOT NULL,          -- 'BRL' — a Meta passou a cobrar em reais
    -- Centavos inteiros, como todo dinheiro no projeto. ⚠️ Nunca float.
    -- 4 casas porque a tarifa unitária é fração de centavo.
    valor_centavos numeric(12,4) NOT NULL,
    vigencia_de    date        NOT NULL,
    vigencia_ate   date,                          -- NULL = vigente
    criado_em      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tarifa_meta_categoria_valida
        CHECK (categoria IN ('marketing','utility','authentication','service')),
    CONSTRAINT tarifa_meta_vigencia_coerente
        CHECK (vigencia_ate IS NULL OR vigencia_ate >= vigencia_de)
);

-- Uma tarifa vigente por país+categoria. A restrição é parcial porque só a
-- linha aberta (vigencia_ate NULL) precisa ser única — o histórico coexiste.
CREATE UNIQUE INDEX tarifa_meta_vigente_unica
    ON tarifa_meta (pais, categoria)
    WHERE vigencia_ate IS NULL;

CREATE INDEX tarifa_meta_busca_por_data
    ON tarifa_meta (pais, categoria, vigencia_de DESC);

COMMENT ON TABLE tarifa_meta IS
    'Tarifas da Meta por país, categoria e vigência. Alimenta o custo por '
    'mensagem (E3-12), o ROI de campanha (CMP-12) e o ROI da ferramenta (BI-11).';
COMMENT ON COLUMN tarifa_meta.valor_centavos IS
    'Centavos com 4 decimais — a tarifa unitária é fração de centavo. Nunca float.';

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
-- ⚠️ Só leitura. Escrever em catálogo global é administração do produto, feita
--    por migration ou por ferramenta interna — nunca pelo caminho do usuário.
--    Um GRANT INSERT aqui permitiria a um tenant alterar o preço que o outro vê.

GRANT SELECT ON plano                  TO geracrm_app;
GRANT SELECT ON perfil_vertical_modelo TO geracrm_app;
GRANT SELECT ON tarifa_meta            TO geracrm_app;
