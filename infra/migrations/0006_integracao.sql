-- 0006_integracao.sql
--
-- A camada que faz o CRM se preencher sozinho (ADR-008).
--
-- ⚠️ Só este contexto conhece formato de ERP. Se `pedido` ou `contato` souberem
--    que existe um campo com o nome que o GeraCloud usa, a abstração multi-ERP
--    já vazou — e o segundo conector prova isso da pior forma.

-- ---------------------------------------------------------------------------
-- conexao_erp — um conector configurado
-- ---------------------------------------------------------------------------
-- Um tenant pode ter mais de uma conexão: o ERP principal, um marketplace, uma
-- planilha de importação. Elas coexistem e cada uma declara o que sabe fazer.

CREATE TABLE conexao_erp (
    tenant_id       uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id              uuid        NOT NULL,
    -- Qual adaptador roda. ⚠️ NUNCA aparece na interface: a tela mostra
    -- `nome_amigavel` (A-07). Um cliente de Bling lendo "GeraCloud" é bug visível.
    conector        text        NOT NULL,     -- 'geracloud' | 'drezz' | 'bling' | 'api_publica'
    nome_amigavel   text        NOT NULL,     -- "Nosso ERP", "Bling da loja 2"
    -- ⚠️ Credencial POR TENANT, cifrada em repouso. A credencial de um cliente
    --    jamais alcança outro — mesmo risco do canal sem tenant, com consequência pior.
    credenciais_cifradas bytea,
    -- Declaração de capacidades (ADR-008). O produto DEGRADA conforme isto,
    -- em vez de quebrar — e a degradação é visível na interface.
    capacidades     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Papéis que esta conexão exerce para o tenant.
    papel_fiscal    boolean     NOT NULL DEFAULT false,
    fonte_de_venda  boolean     NOT NULL DEFAULT false,
    estado          text        NOT NULL DEFAULT 'configurando',
    ultimo_erro     text,
    criado_em       timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT conexao_erp_estado_valido CHECK (estado IN (
        'configurando', 'ativa', 'com_erro', 'pausada'
    ))
);

-- ⚠️ Duas fontes de venda para o mesmo tenant tornam o faturamento ambíguo —
--    e o faturamento é o denominador de RFV, de atribuição e do ROI. Uma só.
CREATE UNIQUE INDEX conexao_erp_fonte_de_venda_unica
    ON conexao_erp (tenant_id) WHERE fonte_de_venda;

-- Mesma lógica para o papel fiscal: qual sistema é a verdade do documento.
CREATE UNIQUE INDEX conexao_erp_papel_fiscal_unico
    ON conexao_erp (tenant_id) WHERE papel_fiscal;

SELECT aplicar_rls('conexao_erp');

COMMENT ON COLUMN conexao_erp.capacidades IS
    'saldoSincrono, tabelaPrecoSincrona, creditoCliente, escritaPedido, '
    'webhookDeVenda, cargaHistorica (ADR-008). Ausente = o produto degrada e '
    'a interface avisa por quê — nunca silenciosamente.';
COMMENT ON COLUMN conexao_erp.conector IS
    '⚠️ Identificador técnico. A interface mostra nome_amigavel — nomear o '
    'fornecedor na tela é bug visível para quem usa outro ERP.';

-- ---------------------------------------------------------------------------
-- conexao_erp_cobertura — até onde a sincronização chegou
-- ---------------------------------------------------------------------------
-- ⚠️ Sem isto não existe "carga histórica concluída", e o critério de saída da
--    Onda 0 não tem como ser provado. Importar não é migrar: é preciso saber
--    o que entrou, de quando até quando, e conciliar com o que o ERP diz.

CREATE TABLE conexao_erp_cobertura (
    tenant_id              uuid        NOT NULL,
    conexao_id             uuid        NOT NULL,
    fluxo                  text        NOT NULL,   -- customers | products | orders
    carga_historica_estado text        NOT NULL DEFAULT 'nao_iniciada',
    -- A janela realmente coberta. `de` NULL com estado completa = o ERP não
    -- informou o início; é diferente de "cobre desde sempre".
    coberto_de             timestamptz,
    coberto_ate            timestamptz,
    ultimo_sincronismo_em  timestamptz,
    registros_importados   bigint      NOT NULL DEFAULT 0,
    registros_rejeitados   bigint      NOT NULL DEFAULT 0,
    atualizado_em          timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, conexao_id, fluxo),
    FOREIGN KEY (tenant_id, conexao_id) REFERENCES conexao_erp (tenant_id, id) ON DELETE CASCADE,

    CONSTRAINT cobertura_fluxo_valido CHECK (fluxo IN ('customers','products','orders')),
    CONSTRAINT cobertura_estado_valido CHECK (carga_historica_estado IN (
        'nao_iniciada', 'em_andamento', 'completa', 'falhou', 'nao_suportada'
    ))
);

SELECT aplicar_rls('conexao_erp_cobertura');

COMMENT ON COLUMN conexao_erp_cobertura.carga_historica_estado IS
    '"nao_suportada" é estado legítimo: ERP sem carga histórica faz o RFV começar '
    'a contar da instalação — e a tela precisa dizer isso (ADR-008).';

-- ---------------------------------------------------------------------------
-- evento_externo — a guardiã da idempotência
-- ---------------------------------------------------------------------------
-- ⚠️ NÃO PARTICIONADA, de propósito (INV-37).
--
--    A única `(tenant_id, canal, id_externo)` é a base de TODA a idempotência
--    de webhook. Em tabela particionada por data, essa unicidade só valeria
--    dentro de cada partição — e um reenvio da Meta na virada do mês criaria
--    a mensagem duas vezes na tela do usuário.
--
--    O crescimento é controlado por expurgo, não por particionamento.

CREATE TABLE evento_externo (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    canal       text        NOT NULL,     -- 'meta_whatsapp' | 'meta_instagram' | 'erp' | 'pagamento'
    id_externo  text        NOT NULL,     -- o id do evento no sistema de origem
    recebido_em timestamptz NOT NULL DEFAULT now(),
    processado_em timestamptz,
    -- Payload bruto, para reprocessar e para investigar incidente.
    -- ⚠️ Expurgado junto com a linha; não é arquivo de auditoria.
    payload     jsonb,
    resultado   text,

    PRIMARY KEY (tenant_id, canal, id_externo)
);

SELECT aplicar_rls('evento_externo');

CREATE INDEX evento_externo_nao_processados
    ON evento_externo (tenant_id, recebido_em)
    WHERE processado_em IS NULL;

COMMENT ON TABLE evento_externo IS
    'Idempotência de webhook (INV-37). ⚠️ NÃO particionar: a unicidade '
    '(tenant, canal, id_externo) precisa valer para SEMPRE, não por período. '
    'Reenvio da Meta na virada do mês duplicaria a mensagem.';

-- ---------------------------------------------------------------------------
-- chave_idempotencia — idempotência das NOSSAS escritas
-- ---------------------------------------------------------------------------
-- Espelho do anterior, na direção oposta: garante que reenviar a mesma
-- operação para o ERP (ou para a nossa API pública) não a executa duas vezes.
--
-- ⚠️ É o que sustenta PED-07 e INV-53: depois de um timeout, a resposta se
--    perdeu mas o pedido pode existir lá. Sem esta tabela, "tentar novamente"
--    duplica pedido no ERP de um cliente real.

CREATE TABLE chave_idempotencia (
    tenant_id    uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    escopo       text        NOT NULL,     -- 'pedido.efetivar' | 'ingestao.lote' | ...
    chave        text        NOT NULL,
    estado       text        NOT NULL DEFAULT 'em_andamento',
    -- Resposta da primeira execução, devolvida nas repetições.
    resultado    jsonb,
    criado_em    timestamptz NOT NULL DEFAULT now(),
    concluido_em timestamptz,

    PRIMARY KEY (tenant_id, escopo, chave),
    CONSTRAINT chave_idempotencia_estado_valido CHECK (estado IN (
        'em_andamento', 'concluida', 'falhou'
    ))
);

SELECT aplicar_rls('chave_idempotencia');

COMMENT ON TABLE chave_idempotencia IS
    'Idempotência das nossas escritas. Sustenta PED-07/INV-53: após timeout, '
    'reenviar não pode duplicar pedido no ERP do cliente.';

-- ---------------------------------------------------------------------------
-- operacao_ingestao — cada lote que entrou
-- ---------------------------------------------------------------------------
-- Rastro para o painel de sincronização (INT-08) e para a conciliação. Sem ele,
-- "por que este cliente sumiu?" não tem resposta.

CREATE TABLE operacao_ingestao (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    conexao_id    uuid        NOT NULL,
    fluxo         text        NOT NULL,
    origem        text        NOT NULL DEFAULT 'sincronismo',  -- sincronismo | carga_historica | manual | api_publica
    iniciado_em   timestamptz NOT NULL DEFAULT now(),
    concluido_em  timestamptz,
    total         integer     NOT NULL DEFAULT 0,
    aceitos       integer     NOT NULL DEFAULT 0,
    rejeitados    integer     NOT NULL DEFAULT 0,
    -- ⚠️ Amostra dos rejeitados, com o motivo. Contagem sem exemplo não permite
    --    corrigir nada — e 40% da base sem documento é problema real observado.
    rejeicoes     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    estado        text        NOT NULL DEFAULT 'em_andamento',

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conexao_id) REFERENCES conexao_erp (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT operacao_ingestao_fluxo_valido CHECK (fluxo IN ('customers','products','orders')),
    CONSTRAINT operacao_ingestao_estado_valido CHECK (estado IN (
        'em_andamento', 'concluida', 'falhou', 'cancelada'
    ))
);

SELECT aplicar_rls('operacao_ingestao');

CREATE INDEX operacao_ingestao_recentes
    ON operacao_ingestao (tenant_id, iniciado_em DESC);

COMMENT ON COLUMN operacao_ingestao.rejeicoes IS
    'Amostra dos registros rejeitados COM o motivo. Contagem sem exemplo não '
    'permite corrigir — e a qualidade da base do ERP é o risco nº 1 da Onda 0.';
