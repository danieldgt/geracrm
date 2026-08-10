-- 0015_indices_onda0.sql
--
-- Os índices que ESTA onda usa. Nada além.
--
-- ⚠️ Índice não usado não é neutro: custa escrita em toda inserção, e a Onda 0
--    é dominada por carga em massa. Um índice a mais na `mensagem` ou na
--    `venda` desacelera exatamente o momento em que a base inteira entra.
--
-- ⚠️ Índice de tela do inbox e do kanban NÃO entra agora — entra na onda que
--    tem a tela. Criar antes é pagar escrita durante meses por uma leitura que
--    ninguém faz, e ainda por cima adivinhando a forma da consulta.

-- ---------------------------------------------------------------------------
-- Busca por nome (CTT-*). A vendedora digita "mari" e espera achar "Mariana".
-- ---------------------------------------------------------------------------

CREATE INDEX contato_nome_busca
    ON contato USING gin (nome gin_trgm_ops);

COMMENT ON INDEX contato_nome_busca IS
    'Trigram porque a busca é por pedaço e tolerante a erro de digitação. '
    '⚠️ LIKE ''%mari%'' sem trigram varre a tabela inteira a cada tecla.';

-- ---------------------------------------------------------------------------
-- Expurgo de evento_externo.
--
-- O índice existente (evento_externo_nao_processados) serve o consumo. Este
-- serve a limpeza: apagar o que já foi processado há mais de N dias.
-- ⚠️ Sem ele o expurgo varre a tabela — e a tabela de webhook é das que mais
--    crescem, então o expurgo trava justamente quando passa a ser necessário.
-- ---------------------------------------------------------------------------

CREATE INDEX evento_externo_expurgo
    ON evento_externo (processado_em)
    WHERE processado_em IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Ingestão por id externo — o caminho quente da carga.
--
-- `contato_identidade_externa` e `sku_identidade_externa` já resolvem pela PK
-- (tenant_id, sistema, id_externo). O que faltava era o caminho INVERSO em
-- venda: "esta venda já entrou?" é feito pela PK de venda_identidade_externa,
-- mas "quais vendas vieram desta conexão?" — usado pela conciliação — não tinha
-- índice e varria a tabela.
-- ---------------------------------------------------------------------------

CREATE INDEX venda_identidade_externa_por_sistema
    ON venda_identidade_externa (tenant_id, sistema, venda_ocorrida_em);

-- ---------------------------------------------------------------------------
-- ⚠️ NÃO ENTRAM AGORA — e o motivo fica registrado para ninguém "corrigir a
--    falta" depois sem saber que foi decisão:
--
--    · Índices de tela do inbox e do kanban: a tela é de outra onda. A forma da
--      consulta ainda não existe, e índice desenhado por adivinhação erra a
--      ordem das colunas — o que é pior que não ter, porque parece resolvido.
--
--    · Reconciliação pedido↔venda: `pedido` só nasce na Onda 1. O índice vem
--      junto da tabela.
--
--    · `venda (tenant_id, contato_id, ocorrida_em DESC)`: JÁ EXISTE, criado na
--      0014 como `venda_por_contato`.
--
--    · Correspondências pendentes por frequência: JÁ EXISTE, criado na 0007
--      como `correspondencia_pendente_abertas`.
--
-- ⚠️ Os dois últimos foram escritos aqui primeiro e derrubaram a migration com
--    "relation already exists" — a lista da §8.6 do plano é de índices
--    NECESSÁRIOS, não de índices FALTANDO, e a diferença só aparece
--    consultando `pg_indexes` antes de escrever. Numa base grande, essa mesma
--    distração custa um deploy revertido em vez de trinta segundos.
-- ---------------------------------------------------------------------------
