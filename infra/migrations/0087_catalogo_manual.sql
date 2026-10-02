-- 0087_catalogo_manual.sql
--
-- CATÁLOGO COM ORIGEM MÚLTIPLA — o ERP sincroniza, e o dono cadastra à mão (ADR-025).
--
-- ⚠️ Até aqui o catálogo só existia por sincronismo de ERP. A Gera3 precisa vender
--    os próprios planos SaaS e a loja de roupas sem ERP precisa cadastrar o que
--    vende. As duas origens convivem NAS MESMAS tabelas, e a origem fica gravada
--    por registro — é a "origem por campo" do ADR-008: com N escritores na mesma
--    linha, é preciso saber quem escreveu o quê para o integrador NÃO sobrescrever
--    o que foi cadastrado à mão.
--
-- ⚠️ O que pertence a cada origem:
--      produto.origem = 'erp'    → referencia, descricao, ativo são do ERP; o CRM
--                                   só edita o que o ERP não tem (descricao_longa,
--                                   imagens, categoria) — campos "nossos".
--      produto.origem = 'manual' → tudo é nosso; o integrador rejeita a referência
--                                   com motivo visível (ingestao-produtos.ts).
--      sku.origem / sku_saldo.origem → mesma lógica.
--      tabela_preco.sistema = 'manual' → duas tabelas por tenant ('varejo' e
--                                   'atacado'), criadas sob demanda pelo código,
--                                   com `perfil` DECLARADO — assim entram na regra
--                                   de preco-de-venda.ts (0077) sem caso especial.
--
-- Aditiva: default 'erp' preserva o que já está lá, que hoje é 100% do ERP.

ALTER TABLE produto ADD COLUMN origem          text        NOT NULL DEFAULT 'erp';
ALTER TABLE produto ADD COLUMN descricao_longa text;
ALTER TABLE produto ADD COLUMN imagens         jsonb       NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE produto ADD COLUMN atualizado_em   timestamptz NOT NULL DEFAULT now();

ALTER TABLE produto ADD CONSTRAINT produto_origem_valida
    CHECK (origem IN ('erp', 'manual'));
-- ⚠️ Lista de URLs, nunca o binário (blob vai para object storage com ponteiro).
ALTER TABLE produto ADD CONSTRAINT produto_imagens_lista
    CHECK (jsonb_typeof(imagens) = 'array');

COMMENT ON COLUMN produto.origem IS
    'erp | manual (ADR-025). Com origem=erp, referencia/descricao/ativo pertencem ao '
    'ERP e o CRM só edita descricao_longa, imagens e categoria. Com origem=manual, '
    'o integrador NÃO sobrescreve — rejeita a referência com motivo (ADR-008).';
COMMENT ON COLUMN produto.descricao_longa IS
    'Texto de venda escrito no CRM (vai para o índice de busca e para o agente). '
    'É nosso em qualquer origem — o ERP não tem esse campo.';
COMMENT ON COLUMN produto.imagens IS
    'Lista de URLs/chaves de mídia; a tela mostra a primeira. Nunca Base64.';

ALTER TABLE sku ADD COLUMN origem text NOT NULL DEFAULT 'erp';
ALTER TABLE sku ADD CONSTRAINT sku_origem_valida CHECK (origem IN ('erp', 'manual'));

COMMENT ON COLUMN sku.origem IS
    'erp | manual. SKU do ERP é somente leitura para a API de catálogo: atributos, '
    'código de barras, preço e saldo vêm da sincronização.';

ALTER TABLE sku_saldo ADD COLUMN origem text NOT NULL DEFAULT 'erp';
ALTER TABLE sku_saldo ADD CONSTRAINT sku_saldo_origem_valida CHECK (origem IN ('erp', 'manual'));

COMMENT ON COLUMN sku_saldo.origem IS
    'erp | manual. Saldo manual é digitado no CRM (loja sem ERP); o apurado_em diz '
    'de quando é, como no saldo do ERP — a tela mostra a data nos dois casos.';

COMMENT ON COLUMN tabela_preco.sistema IS
    'erp:<conexao_id> para tabelas sincronizadas; ''manual'' para as duas tabelas '
    'do catálogo próprio (id_externo = perfil = varejo | atacado), criadas sob '
    'demanda pelo código. O índice tabela_preco_um_por_perfil é por sistema, então '
    'a declaração manual não colide com a do ERP.';

-- Listagem e cursor do catálogo manual filtram por origem.
CREATE INDEX produto_por_origem ON produto (tenant_id, origem, descricao, id);
