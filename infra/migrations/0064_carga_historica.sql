-- 0064_carga_historica.sql
--
-- O RECIBO DA CARGA HISTÓRICA (critério de saída nº 1 da Onda 0).
--
-- ⚠️ O problema que esta tabela resolve não é "guardar uma data": é que o ciclo
--    do integrador re-ingere a base INTEIRA a cada 6 horas. Com o teto de
--    páginas (`MAX_PAGINAS=5`) isso era uma amostra barata; sem o teto, viram
--    quatro varreduras completas por dia no ERP do cliente — que é o sistema de
--    onde ele fatura.
--
--    Com o recibo, a carga histórica acontece UMA VEZ e os ciclos seguintes
--    olham só a janela recente. É a diferença entre "temos o histórico" e
--    "buscamos o histórico de novo o tempo todo".
--
-- ⚠️ E o recibo só é gravado quando a carga rodou SEM TETO de páginas. Uma carga
--    truncada que se declarasse concluída é o pior resultado possível: o produto
--    passaria a operar em modo incremental sobre um histórico pela metade, e o
--    RFV mentiria em silêncio para sempre.
--
-- Aditiva, sob RLS.

CREATE TABLE carga_historica (
    tenant_id    uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    conexao_id   uuid        NOT NULL,
    -- A data a partir da qual o histórico foi puxado. ⚠️ Guardada porque define
    -- o que o "completo" significa: histórico desde 2024 não é desde sempre.
    desde        date        NOT NULL,
    concluida_em timestamptz NOT NULL DEFAULT now(),
    -- O que entrou, para a conciliação ter contra o que comparar.
    vendas       integer     NOT NULL DEFAULT 0,
    valor_centavos bigint    NOT NULL DEFAULT 0,
    clientes     integer     NOT NULL DEFAULT 0,
    produtos     integer     NOT NULL DEFAULT 0,

    PRIMARY KEY (tenant_id, conexao_id),
    FOREIGN KEY (tenant_id, conexao_id) REFERENCES conexao_erp (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('carga_historica');

COMMENT ON TABLE carga_historica IS
    '⚠️ Recibo da carga histórica por conexão. A EXISTÊNCIA da linha é o que faz o '
    'integrador passar para o modo incremental — sem ela, todo ciclo varreria a '
    'base inteira do ERP do cliente. Só é gravada em carga SEM teto de páginas.';
COMMENT ON COLUMN carga_historica.desde IS
    'A partir de quando o histórico foi puxado. "Completo" é relativo a esta data.';
