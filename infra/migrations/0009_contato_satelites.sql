-- 0009_contato_satelites.sql
--
-- Identidade externa, conflito entre fontes, consentimento e mesclagem.
--
-- ⚠️ Esta migration existe porque o mesmo cliente chega por várias portas com
--    dados diferentes, e nenhuma delas está errada. O trabalho não é escolher
--    a verdadeira — é registrar todas e saber qual mostrar.

-- ---------------------------------------------------------------------------
-- contato_identidade_externa
-- ---------------------------------------------------------------------------
-- ⚠️ Genérica de propósito. Hoje guarda id do ERP e telefone do WhatsApp;
--    amanhã guarda o BSUID da Meta (meta-plataforma §6), quando o telefone
--    puder não vir. A tabela já nos protege — o que falta remover é a premissa
--    de que telefone sempre existe.

CREATE TABLE contato_identidade_externa (
    tenant_id  uuid        NOT NULL,
    contato_id uuid        NOT NULL,
    -- 'erp:<conexao>' | 'whatsapp' | 'instagram' | 'bsuid' | 'importacao'
    sistema    text        NOT NULL,
    id_externo text        NOT NULL,
    visto_em   timestamptz NOT NULL DEFAULT now(),
    criado_em  timestamptz NOT NULL DEFAULT now(),

    -- Um id externo aponta para UM contato; um contato tem vários ids externos.
    PRIMARY KEY (tenant_id, sistema, id_externo),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('contato_identidade_externa');

CREATE INDEX contato_identidade_externa_por_contato
    ON contato_identidade_externa (tenant_id, contato_id);

COMMENT ON TABLE contato_identidade_externa IS
    'Identidades do mesmo cliente em sistemas externos. Genérica para acomodar '
    'o BSUID da Meta sem migration nova — ele chega quando o telefone deixar de vir.';

-- ---------------------------------------------------------------------------
-- contato_campo_origem — quem escreveu o quê
-- ---------------------------------------------------------------------------
-- ⚠️ Com N fontes escrevendo no mesmo cadastro, "por que o nome mudou sozinho?"
--    precisa de resposta. Sem isto, a vendedora corrige o nome à mão e a
--    próxima sincronização desfaz — e ela conclui que o sistema é teimoso.

CREATE TABLE contato_campo_origem (
    tenant_id     uuid        NOT NULL,
    contato_id    uuid        NOT NULL,
    campo         text        NOT NULL,   -- 'nome' | 'email' | 'modalidade' | ...
    fonte         text        NOT NULL,
    -- ⚠️ Edição manual vence sincronização automática. É o que impede o ERP de
    --    sobrescrever a correção que a vendedora acabou de fazer.
    manual        boolean     NOT NULL DEFAULT false,
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, contato_id, campo),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('contato_campo_origem');

COMMENT ON COLUMN contato_campo_origem.manual IS
    'Edição manual vence sincronização. Sem isto, a correção da vendedora é '
    'desfeita na próxima carga e ela para de corrigir.';

-- ---------------------------------------------------------------------------
-- conflito_identidade — quando duas fontes discordam
-- ---------------------------------------------------------------------------
-- ⚠️ Resolver sozinho é pior que registrar. Se o ERP diz um CNPJ e o cadastro
--    tem outro, escolher em silêncio esconde um erro que alguém precisa ver.

CREATE TABLE conflito_identidade (
    tenant_id    uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id           uuid        NOT NULL,
    contato_id   uuid        NOT NULL,
    campo        text        NOT NULL,
    valor_atual  text,
    valor_novo   text,
    fonte_novo   text        NOT NULL,
    detectado_em timestamptz NOT NULL DEFAULT now(),
    resolvido_em timestamptz,
    resolucao    text,       -- 'manteve' | 'substituiu' | 'ignorou'

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('conflito_identidade');

CREATE INDEX conflito_identidade_abertos
    ON conflito_identidade (tenant_id, detectado_em DESC) WHERE resolvido_em IS NULL;

-- ---------------------------------------------------------------------------
-- consentimento_contato — LGPD
-- ---------------------------------------------------------------------------

CREATE TABLE consentimento_contato (
    tenant_id  uuid        NOT NULL,
    contato_id uuid        NOT NULL,
    tipo       text        NOT NULL,   -- 'campanhas' | 'automacoes' | 'whatsapp'
    concedido  boolean     NOT NULL,
    origem     text        NOT NULL,   -- 'cadastro' | 'opt_out_mensagem' | 'solicitacao' | 'importacao'
    registrado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, contato_id, tipo, registrado_em),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('consentimento_contato');

COMMENT ON TABLE consentimento_contato IS
    'Histórico de consentimento, não estado. O estado vive em contato.recebe_*; '
    'aqui fica o rastro de quando e por que mudou — que é o que a LGPD pede.';

-- ---------------------------------------------------------------------------
-- lista_bloqueio — o opt-out que sobrevive a tudo
-- ---------------------------------------------------------------------------
-- ⚠️ Chaveada pela CHAVE REDUZIDA (55+DDD+8 dígitos), não pela E.164 completa.
--    Quem pediu para não receber pediu para o número dele, e ele aparece com e
--    sem o nono dígito entre sistemas.
--
-- ⚠️ E não tem FK para contato: o bloqueio precisa valer mesmo para número que
--    ainda não virou cadastro, e precisa SOBREVIVER à exclusão do contato.
--    Apagar a recusa junto com o contato faria a pessoa voltar a receber.

CREATE TABLE lista_bloqueio (
    tenant_id      uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    chave_bloqueio text        NOT NULL,
    motivo         text        NOT NULL,   -- 'opt_out' | 'denuncia' | 'manual' | 'invalido'
    origem         text,
    bloqueado_em   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, chave_bloqueio)
);

SELECT aplicar_rls('lista_bloqueio');

COMMENT ON TABLE lista_bloqueio IS
    'Opt-out por chave reduzida, sem FK para contato. Vale para número ainda não '
    'cadastrado e sobrevive à exclusão do contato — apagar a recusa junto faria '
    'a pessoa voltar a receber mensagem.';

-- ---------------------------------------------------------------------------
-- pessoa — quem atende do outro lado
-- ---------------------------------------------------------------------------
-- No atacado: o comprador da loja. No varejo: raramente usado.

CREATE TABLE pessoa (
    tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id         uuid        NOT NULL,
    nome       text        NOT NULL,
    cargo      text,
    telefone   text,
    email      text,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)
);

SELECT aplicar_rls('pessoa');

CREATE TABLE pessoa_contato (
    tenant_id  uuid NOT NULL,
    pessoa_id  uuid NOT NULL,
    contato_id uuid NOT NULL,

    PRIMARY KEY (tenant_id, pessoa_id, contato_id),
    FOREIGN KEY (tenant_id, pessoa_id)  REFERENCES pessoa  (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('pessoa_contato');

-- ---------------------------------------------------------------------------
-- comentario — anotação interna
-- ---------------------------------------------------------------------------

CREATE TABLE comentario (
    tenant_id  uuid        NOT NULL,
    id         uuid        NOT NULL,
    contato_id uuid        NOT NULL,
    autor_id   uuid,
    texto      text        NOT NULL,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, autor_id)   REFERENCES usuario (tenant_id, id)
);

SELECT aplicar_rls('comentario');

CREATE INDEX comentario_por_contato ON comentario (tenant_id, contato_id, criado_em DESC);

-- ---------------------------------------------------------------------------
-- contato_mesclagem — reversível, e é isso que a torna usável
-- ---------------------------------------------------------------------------
-- ⚠️ No varejo a duplicata é inevitável: sem documento, o mesmo cliente vira
--    dois cadastros com facilidade. Mesclar é operação rotineira — e mesclagem
--    irreversível é operação que ninguém tem coragem de fazer.

CREATE TABLE contato_mesclagem (
    tenant_id        uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id               uuid        NOT NULL,
    contato_destino  uuid        NOT NULL,
    contato_origem   uuid        NOT NULL,
    -- Estado do contato de origem antes da mesclagem, para permitir desfazer.
    estado_anterior  jsonb       NOT NULL,
    mesclado_por     uuid,
    mesclado_em      timestamptz NOT NULL DEFAULT now(),
    desfeito_em      timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, mesclado_por) REFERENCES usuario (tenant_id, id),
    CONSTRAINT mesclagem_origem_diferente_destino CHECK (contato_origem <> contato_destino)
);

SELECT aplicar_rls('contato_mesclagem');

CREATE INDEX contato_mesclagem_por_destino
    ON contato_mesclagem (tenant_id, contato_destino) WHERE desfeito_em IS NULL;

COMMENT ON COLUMN contato_mesclagem.estado_anterior IS
    'Snapshot do contato de origem. Mesclagem irreversível é operação que '
    'ninguém tem coragem de fazer — e no varejo mesclar é rotina.';
