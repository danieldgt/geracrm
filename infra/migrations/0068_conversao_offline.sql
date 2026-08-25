-- 0068_conversao_offline.sql
--
-- O QUE FALTAVA PARA DEVOLVER A VENDA À PLATAFORMA (agencia-mkt, AQ-15).
--
-- O despachante, o enfileirador e o schema da conversão (`0060`) já existiam. O
-- adaptador não podia ser escrito por falta de DUAS informações — e nenhuma
-- delas é detalhe de implementação:
--
-- ⚠️ **1. A AÇÃO DE CONVERSÃO.** O Google não aceita uma conversão solta: ela é
--    creditada a uma `conversionAction` criada DENTRO da conta do cliente
--    ("Venda no WhatsApp", importação offline). É cadastro do dono da conta, não
--    coisa que a gente adivinhe. Sem ela, a chamada é recusada — então o
--    despachante DESCARTA com motivo nomeado em vez de tentar oito vezes.
--
-- ⚠️ **2. QUAL parâmetro trouxe o clique.** `gclid`, `wbraid` e `gbraid` vão em
--    CAMPOS DIFERENTES da API de upload, e o valor é opaco: não dá para
--    descobrir o tipo olhando o texto. A LP já sabia disso na borda (é o que
--    decide a plataforma), mas a informação morria ali. Guardar só o `click_id`
--    obrigaria a chutar o campo — e o Google recusa o chute em silêncio, com
--    `partialFailureError` dentro de um HTTP 200.
--
-- Aditiva.

-- ---------------------------------------------------------------------------
-- A ação de conversão, por conta de anúncio
-- ---------------------------------------------------------------------------
ALTER TABLE midia_conta ADD COLUMN conversao_action_id text;

COMMENT ON COLUMN midia_conta.conversao_action_id IS
    '⚠️ Id da `conversionAction` criada NA CONTA DO CLIENTE (importação offline). '
    'Cadastro do dono da conta. Sem ele o despachante descarta com motivo nomeado '
    '— tentar sem a ação é recusa garantida.';

-- ---------------------------------------------------------------------------
-- O TIPO do click id, ponta a ponta
-- ---------------------------------------------------------------------------
-- ⚠️ Decidido na borda (a LP sabe qual parâmetro veio na URL) e carregado até o
--    envio. É o mesmo raciocínio da conversão de micros: o que só existe na
--    borda tem de ser resolvido na borda, ou some.
ALTER TABLE midia_sessao_lp ADD COLUMN click_id_tipo text;
ALTER TABLE midia_sessao_lp ADD CONSTRAINT midia_sessao_click_tipo_valido
    CHECK (click_id_tipo IS NULL OR click_id_tipo IN ('gclid','wbraid','gbraid','fbclid'));

ALTER TABLE midia_lead_origem ADD COLUMN click_id_tipo text;
ALTER TABLE midia_lead_origem ADD CONSTRAINT midia_origem_click_tipo_valido
    CHECK (click_id_tipo IS NULL OR click_id_tipo IN ('gclid','wbraid','gbraid','fbclid'));

COMMENT ON COLUMN midia_lead_origem.click_id_tipo IS
    '⚠️ gclid | wbraid | gbraid | fbclid — vão em CAMPOS DIFERENTES na API de '
    'upload de conversão, e o valor é opaco. Sem o tipo, o envio é chute.';
