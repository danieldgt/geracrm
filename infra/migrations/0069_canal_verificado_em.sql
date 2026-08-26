-- 0069_canal_verificado_em.sql
--
-- O CARIMBO QUE FALTAVA NO ESTADO DO CANAL.
--
-- ⚠️ `canal_conectado.estado` dizia "conectado" sem dizer QUANDO isso foi
--    observado. Encontrado em produção (2026-08-25): `estado = 'conectado'`,
--    `conectado_em = NULL`, `ultimo_erro = NULL` — e nenhuma coluna de
--    atualização. Não havia como saber, nem pela linha nem pela tela, se aquilo
--    era o vigia de cinco minutos atrás ou o valor escrito no cadastro em 09/ago
--    e nunca confirmado por ninguém.
--
-- ⚠️ Isso é meio caminho de volta para o incidente de 24/ago, que o vigia existe
--    para eliminar: "o painel seguia conectado porque o estado só era atualizado
--    quando alguém tentava enviar". Estado sem carimbo continua permitindo ler
--    "conectado" sem saber se é OBSERVAÇÃO ou LEMBRANÇA — e é a lembrança
--    parecendo observação que faz o operador confiar num número morto.
--
-- ⚠️ **Fica NULL nas linhas que já existem, de propósito.** NULL significa
--    "nunca verificado", que é a verdade sobre elas. Preencher com `now()` no
--    backfill inventaria uma observação que não aconteceu — exatamente o defeito
--    que esta coluna existe para tornar impossível.
--
-- Aditiva: coluna nova, opcional, sem default. A versão anterior do código
-- segue funcionando sem enxergá-la.

ALTER TABLE canal_conectado ADD COLUMN verificado_em timestamptz;

COMMENT ON COLUMN canal_conectado.verificado_em IS
    '⚠️ Quando o estado foi OBSERVADO pela última vez (passada do vigia ou teste '
    'manual). Gravado em TODA verificação bem-sucedida, inclusive quando nada '
    'muda — é o que separa "conectado agora" de "conectado da última vez que '
    'alguém olhou". NULL = nunca verificado, e a tela mostra assim: ausência de '
    'notícia não é notícia boa.';
