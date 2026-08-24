-- 0060_midia_conversao.sql
--
-- A DEVOLUÇÃO DO SINAL (agencia-mkt, AQ-15) — o que fecha o loop e é o produto.
--
-- Sem isto, a plataforma otimiza pelo que ela consegue ver: lead barato. Com
-- isto, ela passa a procurar quem COMPRA, porque recebe de volta a venda
-- efetivada no ERP com o valor real.
--
-- ⚠️ A devolução é um FATO COM ENTREGA PRÓPRIA: pode falhar, precisa de retry,
--    dead-letter e registro. É por isso que `Conversao` é entidade separada de
--    `venda` (AMK-006) — colapsar as duas esconderia a falha de entrega, e o
--    painel continuaria bonito com o loop aberto.
--
-- Mesma forma do despachante de `webhook_saida` (0033): cursor de tentativa,
-- backoff e dead-letter.
-- Tudo aditivo, tudo sob RLS.

CREATE TABLE midia_conversao (
    tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id         uuid        NOT NULL,

    -- ⚠️ SEM FK para `venda`: ela é particionada por `ocorrida_em` e a PK é
    --    composta com a chave de partição. O precedente da casa é `item_venda`
    --    (0014), que carrega as duas colunas e dispensa a FK.
    venda_id          uuid,
    venda_ocorrida_em timestamptz,

    -- A origem que recebe o crédito. É dela que sai o `click_id` no envio.
    origem_id  uuid        NOT NULL,
    plataforma text        NOT NULL,

    -- lead: entrou · lead_qualificado: o agente aprovou · compra: virou venda.
    -- ⚠️ `lead_qualificado` é o evento que muda o jogo: ensina a plataforma a
    --    buscar lead BOM, não lead barato — sem esperar o ciclo até a venda.
    tipo_evento text      NOT NULL,

    -- ⚠️ Em centavos inteiros (INV-46). É O PONTO INTEIRO desta tabela: devolver
    --    a compra SEM valor faz a plataforma voltar a otimizar por volume.
    valor_centavos bigint,

    -- ⚠️ Compartilhado com o pixel do navegador para a plataforma DEDUPLICAR.
    --    Sem ele o mesmo evento entra duas vezes e o ROAS aparece dobrado — erro
    --    que ninguém percebe porque o número fica MELHOR.
    event_id   text        NOT NULL,

    -- pendente → enviada | falhou | descartada
    estado     text        NOT NULL DEFAULT 'pendente',
    tentativas integer     NOT NULL DEFAULT 0,
    proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
    -- ⚠️ Motivo TIPIFICADO, não texto livre do fornecedor: quem opera precisa
    --    saber se espera, corrige credencial ou desiste (PED-08).
    ultimo_erro text,
    enviada_em timestamptz,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, origem_id) REFERENCES midia_lead_origem (tenant_id, id) ON DELETE CASCADE,

    CONSTRAINT midia_conversao_plataforma_valida CHECK (plataforma IN ('google','meta','tiktok')),
    CONSTRAINT midia_conversao_tipo_valido CHECK (tipo_evento IN ('lead','lead_qualificado','compra')),
    CONSTRAINT midia_conversao_estado_valido CHECK (estado IN (
        'pendente',
        'enviada',
        -- Tentamos e a plataforma recusou até esgotar as tentativas.
        'falhou',
        -- ⚠️ NÓS decidimos não enviar (fora da janela de importação, origem sem
        --    click_id). Separado de 'falhou' de propósito: são causas diferentes
        --    e ações diferentes, e juntá-las esconderia qual é qual no painel.
        'descartada'
    )),
    -- ⚠️ Compra SEM valor não pode existir: é exatamente o bug que faz a
    --    plataforma voltar a otimizar por lead barato.
    CONSTRAINT midia_conversao_compra_tem_valor CHECK (
        tipo_evento <> 'compra' OR (valor_centavos IS NOT NULL AND valor_centavos > 0)
    ),
    CONSTRAINT midia_conversao_compra_tem_venda CHECK (
        tipo_evento <> 'compra' OR (venda_id IS NOT NULL AND venda_ocorrida_em IS NOT NULL)
    ),
    CONSTRAINT midia_conversao_venda_par CHECK (
        (venda_id IS NULL AND venda_ocorrida_em IS NULL) OR
        (venda_id IS NOT NULL AND venda_ocorrida_em IS NOT NULL)
    ),
    CONSTRAINT midia_conversao_tentativas_nao_negativas CHECK (tentativas >= 0)
);

-- ⚠️ INV-62: a MESMA venda não é devolvida duas vezes para a mesma plataforma no
--    mesmo tipo de evento. Sem isto, um reprocessamento duplica a receita no
--    painel da plataforma — e o número fica MAIOR, então ninguém reclama.
CREATE UNIQUE INDEX midia_conversao_venda_unica
    ON midia_conversao (tenant_id, venda_id, plataforma, tipo_evento)
    WHERE venda_id IS NOT NULL;

-- ⚠️ O `event_id` é a chave de deduplicação DA PLATAFORMA. Repetir um event_id
--    para eventos diferentes faria a plataforma descartar um deles em silêncio.
CREATE UNIQUE INDEX midia_conversao_event_id_unico
    ON midia_conversao (tenant_id, event_id);

-- A fila do despachante: pendentes cuja hora chegou.
CREATE INDEX midia_conversao_fila
    ON midia_conversao (tenant_id, proxima_tentativa_em)
    WHERE estado = 'pendente';

-- Painel: o que falhou ou foi descartado, por origem.
CREATE INDEX midia_conversao_por_origem
    ON midia_conversao (tenant_id, origem_id, criado_em DESC);

SELECT aplicar_rls('midia_conversao');

COMMENT ON TABLE midia_conversao IS
    '⚠️ A devolução do sinal à plataforma — o que fecha o loop. Entidade separada '
    'de `venda` porque tem entrega própria: falha, retry e dead-letter. Colapsar '
    'as duas esconderia o loop aberto.';
COMMENT ON COLUMN midia_conversao.valor_centavos IS
    '⚠️ O ponto inteiro da tabela. Devolver compra SEM valor faz a plataforma '
    'voltar a otimizar por volume de lead em vez de por receita.';
COMMENT ON COLUMN midia_conversao.event_id IS
    '⚠️ Compartilhado com o pixel para a plataforma deduplicar. Sem ele o evento '
    'entra duas vezes e o ROAS dobra — erro que ninguém percebe porque melhora.';
COMMENT ON COLUMN midia_conversao.estado IS
    'descartada ≠ falhou: descartada é decisão NOSSA (fora da janela de '
    'importação, origem sem click_id); falhou é recusa da plataforma após esgotar '
    'as tentativas. Causas diferentes, ações diferentes.';
