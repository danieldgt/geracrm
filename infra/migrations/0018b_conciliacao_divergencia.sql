-- 0018b_conciliacao_divergencia.sql
--
-- ⚠️ DIVERGÊNCIA SEM ESTADO E SEM RESPONSÁVEL VIRA PDF MORTO.
--
--    A 0018 criou a apuração por período: quanto o ERP diz, quanto entrou, e uma
--    amostra em JSON dos ids que faltam. Isso responde "bate?" — mas não
--    responde "quem está cuidando das 47 que não batem, e quais já foram
--    explicadas?". Amostra em JSON não tem dono, não tem estado e não se
--    consulta: é exatamente o retrato que o critério de saída nº 1 recusa.
--
--    O RC precisa ser CONSULTÁVEL, não só gerado. Assinar um relatório cujas
--    pendências não têm dono é assinar um retrato — e o retrato envelhece
--    sozinho, enquanto a divergência continua lá.
--
-- Nota de nomenclatura: `conciliacao` (0018) faz o papel do `conciliacao_execucao`
-- previsto no plano. O nome ficou mais curto; o papel é o mesmo, e esta tabela é
-- a filha que faltava.

CREATE TABLE conciliacao_divergencia (
    tenant_id      uuid        NOT NULL,
    id             uuid        NOT NULL,
    conciliacao_id uuid        NOT NULL,

    -- Código estável. ⚠️ É por ele que se agrupa: "37 das 47 são DIV-04" muda a
    --    conversa de "a carga falhou" para "faltou cadastrar cliente no ERP".
    codigo         text        NOT NULL,
    -- O que diverge: id externo da venda, documento do cliente, código do SKU.
    chave          text        NOT NULL,

    -- ⚠️ OS DOIS LADOS, sempre. Guardar só a diferença obriga a voltar no ERP
    --    para saber o que era esperado — e o ERP já mudou desde a apuração.
    valor_erp      text,
    valor_geracrm  text,

    estado         text        NOT NULL DEFAULT 'aberta',
    -- Quem está cuidando. Nulo enquanto ninguém pegou — e é essa lista de nulos
    -- que a reunião de conciliação usa.
    responsavel_id uuid,
    resolucao      text,
    resolvido_em   timestamptz,
    criado_em      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conciliacao_id) REFERENCES conciliacao (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, responsavel_id) REFERENCES usuario     (tenant_id, id),

    CONSTRAINT divergencia_codigo_valido CHECK (codigo IN (
        'DIV-01',   -- registro existe no ERP e não aqui
        'DIV-02',   -- registro existe aqui e não no ERP
        'DIV-03',   -- existe nos dois, com valor diferente
        'DIV-04',   -- venda sem cliente resolvido (não entra no RFV)
        'DIV-05',   -- vendedor externo sem correspondência
        'DIV-06',   -- item de venda com SKU desconhecido
        'DIV-07'    -- data fora do período esperado
    )),
    CONSTRAINT divergencia_estado_valido CHECK (estado IN (
        'aberta',
        'em_analise',
        'resolvida',   -- foi corrigida na origem e reimportada
        'aceita'       -- ⚠️ explicada e aceita como está — decisão, não conserto
    )),
    -- ⚠️ Fechar exige dizer o que foi feito E quem fez. Sem isso, "resolvida"
    --    não distingue "corrigimos" de "cansamos de olhar", e a diferença
    --    aparece no mês seguinte com o mesmo número.
    CONSTRAINT divergencia_fecho_coerente CHECK (
        estado NOT IN ('resolvida','aceita') OR
        (resolucao IS NOT NULL AND resolvido_em IS NOT NULL AND responsavel_id IS NOT NULL)
    ),
    -- Mesma divergência não entra duas vezes quando a apuração é refeita.
    CONSTRAINT divergencia_unica UNIQUE (tenant_id, conciliacao_id, codigo, chave)
);

SELECT aplicar_rls('conciliacao_divergencia');

-- A consulta da reunião: o que ainda está em aberto, agrupado por código.
CREATE INDEX divergencia_abertas
    ON conciliacao_divergencia (tenant_id, codigo, criado_em)
    WHERE estado IN ('aberta','em_analise');
CREATE INDEX divergencia_por_responsavel
    ON conciliacao_divergencia (tenant_id, responsavel_id)
    WHERE responsavel_id IS NOT NULL AND estado IN ('aberta','em_analise');
CREATE INDEX divergencia_por_execucao
    ON conciliacao_divergencia (tenant_id, conciliacao_id);

COMMENT ON TABLE conciliacao_divergencia IS
    'Uma linha por divergência, com os dois lados, dono e estado. ⚠️ É o que '
    'torna o RC consultável em vez de um retrato: amostra em JSON não tem dono, '
    'não tem estado e não se consulta.';
COMMENT ON COLUMN conciliacao_divergencia.codigo IS
    '⚠️ Agrupar por código muda a conversa: "37 das 47 são DIV-04" vira "faltou '
    'cadastrar cliente no ERP", que tem conserto — enquanto "a carga falhou" não tem.';
COMMENT ON CONSTRAINT divergencia_fecho_coerente ON conciliacao_divergencia IS
    'Fechar exige o que foi feito e quem fez. Sem isso "resolvida" não distingue '
    '"corrigimos" de "cansamos de olhar".';
