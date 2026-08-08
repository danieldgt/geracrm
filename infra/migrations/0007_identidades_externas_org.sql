-- 0007_identidades_externas_org.sql
--
-- Como o "JANAINA" que vem do ERP vira a usuária Janaina daqui.
--
-- ⚠️ Por que isto nasce na Onda 0, e não quando o ranking for construído:
--
--    A venda que chega do ERP traz o vendedor como TEXTO — "JANAINA",
--    "Janaina Marketing", "vend_04". A ingestão já grava isso desde o primeiro
--    dia. Sem a tabela de correspondência, esse texto fica solto, e quando o
--    ranking por vendedora (GES-02/03) for construído na Onda 2, não haverá
--    como ligá-lo a ninguém — seria preciso reprocessar todo o histórico.
--
--    Criar agora custa uma migration. Criar depois custa uma reimportação.

-- ---------------------------------------------------------------------------
-- usuario_identidade_externa
-- ---------------------------------------------------------------------------

CREATE TABLE usuario_identidade_externa (
    tenant_id  uuid        NOT NULL,
    usuario_id uuid        NOT NULL,
    conexao_id uuid        NOT NULL,
    -- Como o sistema de origem chama esta pessoa. ⚠️ Guardado como veio,
    -- sem normalizar: é a chave de correspondência com o dado bruto.
    id_externo text        NOT NULL,
    visto_em   timestamptz NOT NULL DEFAULT now(),
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, conexao_id, id_externo),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES usuario     (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, conexao_id) REFERENCES conexao_erp (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('usuario_identidade_externa');

-- ⚠️ A PK é (tenant, conexao, id_externo), não (tenant, usuario, ...):
--    um id externo aponta para UMA pessoa, mas uma pessoa pode ter vários ids
--    externos — "JANAINA" no ERP antigo e "vend_04" no novo, ambos válidos.
CREATE INDEX usuario_identidade_externa_por_usuario
    ON usuario_identidade_externa (tenant_id, usuario_id);

COMMENT ON TABLE usuario_identidade_externa IS
    'Liga o vendedor em texto que vem do ERP à usuária do GeraCRM. Sem isto, '
    'venda.vendedor_externo nunca vira ranking (GES-02/03) sem reimportar tudo.';
COMMENT ON COLUMN usuario_identidade_externa.id_externo IS
    'Como veio do sistema de origem, sem normalizar — é a chave de correspondência.';

-- ---------------------------------------------------------------------------
-- filial_identidade_externa
-- ---------------------------------------------------------------------------
-- Mesma lógica: o ERP diz "LOJA 2" ou "SCC"; aqui é uma filial com nome próprio.

CREATE TABLE filial_identidade_externa (
    tenant_id  uuid        NOT NULL,
    filial_id  uuid        NOT NULL,
    conexao_id uuid        NOT NULL,
    id_externo text        NOT NULL,
    visto_em   timestamptz NOT NULL DEFAULT now(),
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, conexao_id, id_externo),
    FOREIGN KEY (tenant_id, filial_id)  REFERENCES filial      (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, conexao_id) REFERENCES conexao_erp (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('filial_identidade_externa');

CREATE INDEX filial_identidade_externa_por_filial
    ON filial_identidade_externa (tenant_id, filial_id);

-- ---------------------------------------------------------------------------
-- correspondencia_pendente — o que chegou e não bate com ninguém
-- ---------------------------------------------------------------------------
-- ⚠️ Descartar em silêncio o que não corresponde é o pior desfecho: a venda
--    entra, o faturamento fecha, e o ranking simplesmente não mostra aquela
--    vendedora. Ninguém percebe até ela reclamar.
--
--    Aqui o não-correspondido fica visível e vira tarefa de configuração.

CREATE TABLE correspondencia_pendente (
    tenant_id    uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    conexao_id   uuid        NOT NULL,
    tipo         text        NOT NULL,   -- 'usuario' | 'filial'
    id_externo   text        NOT NULL,
    -- Quantas vezes apareceu e quando foi a última. Prioriza a resolução:
    -- o "JANAINA" com 4.000 ocorrências importa mais que o com 2.
    ocorrencias  bigint      NOT NULL DEFAULT 1,
    primeiro_em  timestamptz NOT NULL DEFAULT now(),
    ultimo_em    timestamptz NOT NULL DEFAULT now(),
    resolvido_em timestamptz,

    PRIMARY KEY (tenant_id, conexao_id, tipo, id_externo),
    FOREIGN KEY (tenant_id, conexao_id) REFERENCES conexao_erp (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT correspondencia_tipo_valido CHECK (tipo IN ('usuario','filial'))
);

SELECT aplicar_rls('correspondencia_pendente');

CREATE INDEX correspondencia_pendente_abertas
    ON correspondencia_pendente (tenant_id, ocorrencias DESC)
    WHERE resolvido_em IS NULL;

COMMENT ON TABLE correspondencia_pendente IS
    'Identificador externo que não corresponde a nenhum usuário ou filial. '
    '⚠️ Descartar em silêncio faria a vendedora sumir do ranking sem ninguém '
    'perceber. Ordenado por ocorrências: resolve-se primeiro o que mais aparece.';
