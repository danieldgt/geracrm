-- 0075_disponibilidade_usuario.sql
--
-- QUEM ESTÁ DISPONÍVEL PARA ATENDER — e, por consequência, quando o agente entra.
--
-- ⚠️ A regra que o agente seguia era fixa: "fora do expediente, depois da
--    ausência". Ela não cobre o caso real de uma operação — o consultor entra em
--    reunião às 14h, o cliente escreve, e o produto fica mudo porque
--    tecnicamente é horário comercial.
--
--    A regra nova, definida pelo dono do produto (27/ago): o agente entra quando
--    **NÃO HÁ NINGUÉM DISPONÍVEL** naquele número. E "disponível" é:
--      · o usuário NÃO se marcou ausente; E
--      · está DENTRO do expediente configurado; E
--      · está LOGADO na ferramenta (batimento recente).
--
-- ⚠️ A checagem é por NÚMERO, via `usuario_canal` — quem pode enviar por aquele
--    número. Um consultor de outro número estar online não deve calar o agente
--    de um número onde ninguém atende.
--
-- Duas colunas em `usuario`, aditivas.

-- ---------------------------------------------------------------------------
-- Marcado como ausente — decisão HUMANA, explícita
-- ---------------------------------------------------------------------------
ALTER TABLE usuario ADD COLUMN ausente boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN usuario.ausente IS
    '⚠️ O próprio usuário marca. Reunião, almoço, folga. Enquanto true ele não '
    'conta como disponível — e se ninguém do número estiver disponível, o agente '
    'assume. É o botão que o consultor usa para não deixar cliente no vácuo.';

-- ---------------------------------------------------------------------------
-- Último sinal de vida na ferramenta
-- ---------------------------------------------------------------------------
-- ⚠️ Sem isto, "ninguém logado" seria indistinguível de "todo mundo logado":
--    quem fecha o navegador não marca nada, e o produto acharia que há gente na
--    mesa a noite inteira. É o mesmo raciocínio do carimbo do canal (0069) —
--    estado sem prova de vida é lembrança, não observação.
ALTER TABLE usuario ADD COLUMN visto_em timestamptz;

COMMENT ON COLUMN usuario.visto_em IS
    '⚠️ Batimento do console. NULL ou velho = não está na ferramenta. Fechar o '
    'navegador não avisa ninguém, então a ausência de sinal É o sinal.';

CREATE INDEX usuario_disponivel
    ON usuario (tenant_id, visto_em DESC) WHERE ativo AND NOT ausente;
