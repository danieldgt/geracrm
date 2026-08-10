-- 0011b_template.sql
--
-- ⚠️ SEM ISTO A ONDA 0 NÃO CONSEGUE FALAR COM NINGUÉM NO DIA DO CORTE.
--
--    A janela de 24h é por número e nasce zerada. No minuto em que o número é
--    conectado, TODAS as janelas estão fechadas — não existe nenhuma conversa
--    com mensagem entrante recente, porque o número acabou de chegar aqui.
--
--    Sem template aprovado, a vendedora abre o inbox, vê a base inteira
--    carregada e não consegue mandar uma única mensagem. O corte parece
--    concluído e a operação está parada.
--
--    Por isso template é pré-requisito do corte, não item de campanha. O
--    construtor de campanha continua na Onda 3; aqui é só o envio unitário.

CREATE TABLE template (
    tenant_id uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id        uuid        NOT NULL,
    -- ⚠️ O nome é o identificador do template NA META, e é ele que vai no
    --    envio. Não é rótulo interno: mudar aqui quebra o envio lá.
    nome      text        NOT NULL,
    categoria text        NOT NULL,
    idioma    text        NOT NULL DEFAULT 'pt_BR',
    criado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    -- A Meta identifica por nome + idioma; o mesmo par não existe duas vezes.
    CONSTRAINT template_nome_unico UNIQUE (tenant_id, nome, idioma),
    CONSTRAINT template_categoria_valida CHECK (categoria IN (
        'MARKETING', 'UTILITY', 'AUTHENTICATION'
    ))
);

SELECT aplicar_rls('template');

COMMENT ON COLUMN template.categoria IS
    '⚠️ Categoria da Meta, em maiúsculas como ela devolve. MARKETING custa e '
    'exige opt-in; UTILITY não. Traduzir para termos nossos aqui obrigaria a '
    'traduzir de volta a cada sincronização, e a Meta muda a categoria sozinha.';

-- ---------------------------------------------------------------------------
-- Versões.
--
-- ⚠️ Versionado porque o template MUDA e o status na Meta muda junto: aprovado
--    hoje, rejeitado amanhã depois de uma edição. Sobrescrever a linha apaga
--    qual corpo estava aprovado quando a mensagem foi enviada — e é isso que
--    responde "o que exatamente o cliente recebeu?" numa reclamação.
-- ---------------------------------------------------------------------------

CREATE TABLE template_versao (
    tenant_id   uuid        NOT NULL,
    template_id uuid        NOT NULL,
    versao      integer     NOT NULL,
    -- Corpo com os componentes como a Meta os define (header, body, footer,
    -- buttons) e as variáveis posicionais.
    corpo       jsonb       NOT NULL,
    status_meta text        NOT NULL DEFAULT 'PENDING',
    -- ⚠️ Motivo da rejeição: sem ele a tela mostra "rejeitado" e ninguém sabe
    --    o que corrigir, então o próximo envio para aprovação repete o erro.
    motivo_rejeicao text,
    -- Id do template na Meta. NULL enquanto não foi submetido.
    id_externo  text,
    revisado_em timestamptz,
    criado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, template_id, versao),
    FOREIGN KEY (tenant_id, template_id) REFERENCES template (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT template_versao_status_valido CHECK (status_meta IN (
        'PENDING',    -- submetido, aguardando a Meta
        'APPROVED',   -- ⚠️ o único que o gateway aceita enviar
        'REJECTED',
        'PAUSED',     -- qualidade caiu; a Meta pausou
        'DISABLED'
    )),
    CONSTRAINT template_versao_rejeicao_explicada CHECK (
        status_meta <> 'REJECTED' OR motivo_rejeicao IS NOT NULL
    )
);

SELECT aplicar_rls('template_versao');

-- ⚠️ A pergunta do gateway de saída é sempre a mesma: "qual a versão APROVADA
--    deste template AGORA?". Sem índice parcial, isso vira varredura de todas
--    as versões a cada envio.
CREATE UNIQUE INDEX template_versao_aprovada
    ON template_versao (tenant_id, template_id)
    WHERE status_meta = 'APPROVED';

CREATE INDEX template_versao_por_id_externo
    ON template_versao (tenant_id, id_externo)
    WHERE id_externo IS NOT NULL;

COMMENT ON INDEX template_versao_aprovada IS
    'Único parcial: no máximo UMA versão aprovada por template. ⚠️ Duas '
    'aprovadas fariam o gateway escolher arbitrariamente qual corpo enviar, e '
    'a escolha mudaria entre execuções sem nada aparecer no log.';
