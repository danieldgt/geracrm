-- 0034_funil.sql
--
-- Funil de RELACIONAMENTO (Onda 2, decisão 2026-08-10). ⚠️ NÃO é funil de
-- negociação: em venda recorrente o cliente compra todo mês, não "fecha". O card
-- anda conforme a RELAÇÃO evolui: Lead → Em conversa → Orçamento → 1º pedido →
-- Recorrente (+ Perdido com motivo obrigatório de catálogo fechado).
--
-- Regras da skill funil-de-vendas embutidas no schema:
--   • todo estágio tem critério de entrada (coluna `criterio`);
--   • perda exige motivo de um catálogo (`motivo_perda`);
--   • tempo-em-estágio é métrica de 1ª classe (`entrou_etapa_em` + histórico);
--   • no máximo UMA oportunidade ABERTA por contato (índice parcial).
--
-- Paginação por COLUNA (não virtual scroll — drag-drop nativo do CDK): ordem por
-- `posicao` numérica (fractional indexing: inserir entre 10 e 20 = 15, sem
-- renumerar a coluna inteira). Tudo sob RLS.

-- ─── Estágios (configuráveis por tenant) ───
CREATE TABLE funil_etapa (
    tenant_id  uuid    NOT NULL,
    id         uuid    NOT NULL,
    ordem      integer NOT NULL,
    chave      text    NOT NULL,   -- 'lead' | 'conversa' | ...
    nome       text    NOT NULL,
    tipo       text    NOT NULL,   -- 'aberto' | 'ganho' | 'perdido'
    criterio   text,               -- critério objetivo de entrada
    ativo      boolean NOT NULL DEFAULT true,

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT funil_etapa_tipo_valido CHECK (tipo IN ('aberto','ganho','perdido')),
    UNIQUE (tenant_id, chave)
);
CREATE INDEX funil_etapa_ordem ON funil_etapa (tenant_id, ordem);
SELECT aplicar_rls('funil_etapa');

-- ─── Catálogo fechado de motivos de perda ───
CREATE TABLE motivo_perda (
    tenant_id uuid    NOT NULL,
    codigo    text    NOT NULL,
    nome      text    NOT NULL,
    ativo     boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, codigo)
);
SELECT aplicar_rls('motivo_perda');

-- ─── Oportunidade (o card) ───
CREATE TABLE oportunidade (
    tenant_id            uuid        NOT NULL,
    id                   uuid        NOT NULL,
    contato_id           uuid        NOT NULL,
    etapa_id             uuid        NOT NULL,
    titulo               text,                     -- NULL = usa o nome do contato
    valor_estimado_centavos bigint,
    responsavel_id       uuid,                     -- carteira; NULL = órfã
    -- Ordenação dentro da coluna (fractional indexing p/ drag-drop).
    posicao              double precision NOT NULL DEFAULT 0,
    entrou_etapa_em      timestamptz NOT NULL DEFAULT now(),  -- base do tempo-em-estágio
    estado               text        NOT NULL DEFAULT 'aberta',
    motivo_perda_codigo  text,                     -- obrigatório quando perdida
    fechada_em           timestamptz,
    criado_em            timestamptz NOT NULL DEFAULT now(),
    versao               bigint      NOT NULL DEFAULT 0,      -- concorrência otimista no move

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id)     REFERENCES contato     (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, etapa_id)       REFERENCES funil_etapa (tenant_id, id),
    FOREIGN KEY (tenant_id, responsavel_id) REFERENCES usuario     (tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT oportunidade_estado_valido CHECK (estado IN ('aberta','ganha','perdida')),
    -- ⚠️ Perda SEM motivo é proibida no banco, não só na tela.
    CONSTRAINT oportunidade_perda_tem_motivo CHECK (estado <> 'perdida' OR motivo_perda_codigo IS NOT NULL)
);
-- ⚠️ No máximo UMA oportunidade aberta por contato (como INV-51 do atendimento).
CREATE UNIQUE INDEX oportunidade_aberta_unica ON oportunidade (tenant_id, contato_id) WHERE estado = 'aberta';
-- Paginação por COLUNA: cursor (posicao, id) dentro de (tenant, etapa).
CREATE INDEX oportunidade_por_coluna ON oportunidade (tenant_id, etapa_id, posicao, id);
SELECT aplicar_rls('oportunidade');

-- ─── Histórico de estágio (tempo-em-estágio + conversão A→B) ───
CREATE TABLE oportunidade_etapa_historico (
    tenant_id      uuid        NOT NULL,
    id             uuid        NOT NULL,
    oportunidade_id uuid       NOT NULL,
    etapa_id       uuid        NOT NULL,
    entrou_em      timestamptz NOT NULL DEFAULT now(),
    saiu_em        timestamptz,                    -- NULL = etapa atual
    ator_id        uuid,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, oportunidade_id) REFERENCES oportunidade (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX oportunidade_hist_por_op ON oportunidade_etapa_historico (tenant_id, oportunidade_id, entrou_em);
SELECT aplicar_rls('oportunidade_etapa_historico');

-- ─── Seed dos estágios e motivos para os tenants existentes ───
-- ⚠️ Novos tenants recebem no bootstrap; aqui semeamos os que já existem.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    INSERT INTO funil_etapa (tenant_id, id, ordem, chave, nome, tipo, criterio) VALUES
      (t.id, gen_random_uuid(), 1, 'lead',       'Lead',        'aberto', 'Contato novo, ainda sem conversa iniciada'),
      (t.id, gen_random_uuid(), 2, 'conversa',   'Em conversa', 'aberto', 'Conversa ativa no WhatsApp'),
      (t.id, gen_random_uuid(), 3, 'orcamento',  'Orçamento',   'aberto', 'Pedido/orçamento em montagem'),
      (t.id, gen_random_uuid(), 4, 'pedido',     '1º pedido',   'ganho',  'Primeiro pedido efetivado no ERP'),
      (t.id, gen_random_uuid(), 5, 'recorrente', 'Recorrente',  'ganho',  'Comprou 2 vezes ou mais'),
      (t.id, gen_random_uuid(), 9, 'perdido',    'Perdido',     'perdido','Não avançou; motivo obrigatório')
    ON CONFLICT (tenant_id, chave) DO NOTHING;

    INSERT INTO motivo_perda (tenant_id, codigo, nome) VALUES
      (t.id, 'preco',        'Preço'),
      (t.id, 'sem_resposta', 'Parou de responder'),
      (t.id, 'concorrente',  'Foi para o concorrente'),
      (t.id, 'sem_interesse','Sem interesse'),
      (t.id, 'outro',        'Outro')
    ON CONFLICT (tenant_id, codigo) DO NOTHING;
  END LOOP;
END $$;
