-- 0012_conversa_mensagem.sql
--
-- O núcleo operacional: conversa, mensagem e atendimento.
--
-- ⚠️ `atendimento` NASCE COMPLETO aqui, inclusive com as quatro colunas de
--    primeira resposta. Criá-las numa migration de métrica depois obriga a
--    varrer `mensagem` — PARTICIONADA — conversa a conversa para achar a
--    primeira entrante e a primeira saliente de cada episódio. E a definição
--    precisa estar decidida ANTES de existir dado.

-- ---------------------------------------------------------------------------
-- conversa — o fio contínuo com um contato num canal.
-- ---------------------------------------------------------------------------

CREATE TABLE conversa (
    tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id         uuid        NOT NULL,
    canal_id   uuid        NOT NULL,
    contato_id uuid        NOT NULL,

    -- Denormalizado para o inbox e a Fila do Dia não fazerem subconsulta por
    -- linha (§7). FK adicionada depois de `atendimento` existir.
    atendimento_atual_id uuid,

    -- INB-06 / IA-08: quem está conduzindo agora.
    conduzida_por text     NOT NULL DEFAULT 'humano',

    ultima_mensagem_em timestamptz,
    -- ⚠️ É DAQUI que sai o estado da janela (INV-18), junto da duração
    --    declarada em canal_conectado.capacidades. Nunca uma flag `janela_aberta`
    --    gravada: flag precisa de alguém para virá-la, e às 23h59 não tem ninguém.
    ultima_entrante_em timestamptz,
    ultima_direcao     text,

    -- Versão monotônica da conversa. É o que `conversa_leitura` compara.
    versao     bigint      NOT NULL DEFAULT 0,
    arquivada  boolean     NOT NULL DEFAULT false,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, canal_id)   REFERENCES canal_conectado (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id) REFERENCES contato         (tenant_id, id) ON DELETE CASCADE,

    -- ⚠️ Uma conversa por (canal, contato). É a chave natural — e é por causa
    --    dela que a raiz de canal precisava ser genérica desde a 0011.
    CONSTRAINT conversa_canal_contato_unica UNIQUE (tenant_id, canal_id, contato_id),
    CONSTRAINT conversa_conduzida_valida CHECK (conduzida_por IN ('humano','ia')),
    CONSTRAINT conversa_direcao_valida CHECK (ultima_direcao IS NULL OR ultima_direcao IN ('entrante','saliente'))
);

SELECT aplicar_rls('conversa');

-- Ordenação do inbox: mais recente primeiro, arquivadas fora.
CREATE INDEX conversa_inbox
    ON conversa (tenant_id, canal_id, ultima_mensagem_em DESC)
    WHERE NOT arquivada;
CREATE INDEX conversa_por_contato ON conversa (tenant_id, contato_id);

COMMENT ON COLUMN conversa.versao IS
    '⚠️ Substitui a coluna `nao_lidas` (§3.4.1). Um contador por conversa erra '
    'assim que duas pessoas veem o mesmo canal: quem lê primeiro zera para todo '
    'mundo. Não-lidas é DERIVADO de versao − conversa_leitura.lida_ate_versao, '
    'que é por pessoa.';

-- ---------------------------------------------------------------------------
-- conversa_leitura — até onde CADA pessoa leu.
-- ---------------------------------------------------------------------------

CREATE TABLE conversa_leitura (
    tenant_id        uuid        NOT NULL,
    conversa_id      uuid        NOT NULL,
    usuario_id       uuid        NOT NULL,
    lida_ate_versao  bigint      NOT NULL DEFAULT 0,
    atualizado_em    timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, conversa_id, usuario_id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, usuario_id)  REFERENCES usuario  (tenant_id, id) ON DELETE CASCADE
);

SELECT aplicar_rls('conversa_leitura');

-- ---------------------------------------------------------------------------
-- conversa_presenca (INB-18) — o mecanismo que sumiu junto com o Redis (ADR-007).
--
-- ⚠️ Postgres não tem TTL nativo: o vencimento é LÓGICO. Toda leitura filtra por
--    `expira_em > now()`; a varredura periódica só limpa linha morta.
--    Confiar só na varredura faz "Eduarda está nesta conversa" sobreviver ao
--    fechamento do navegador dela — e a vendedora seguinte deixa de responder
--    um cliente por causa de um fantasma.
-- ---------------------------------------------------------------------------

CREATE TABLE conversa_presenca (
    tenant_id     uuid        NOT NULL,
    conversa_id   uuid        NOT NULL,
    usuario_id    uuid        NOT NULL,
    estado        text        NOT NULL,
    expira_em     timestamptz NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, conversa_id, usuario_id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, usuario_id)  REFERENCES usuario  (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT presenca_estado_valido CHECK (estado IN ('visualizando','digitando','gravando'))
);

SELECT aplicar_rls('conversa_presenca');

-- Para a varredura de limpeza.
CREATE INDEX conversa_presenca_expiracao ON conversa_presenca (tenant_id, expira_em);

COMMENT ON TABLE conversa_presenca IS
    'Heartbeat por POST a cada N segundos. ⚠️ A ausência do heartbeat NÃO dispara '
    'evento de saída — o registro simplesmente vence. É o que mantém o mecanismo '
    'barato: sem conexão bidirecional, sem componente novo.';

-- ---------------------------------------------------------------------------
-- atendimento — o episódio dentro da conversa.
-- ---------------------------------------------------------------------------

CREATE TABLE atendimento (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id          uuid        NOT NULL,
    conversa_id uuid        NOT NULL,
    -- ⚠️ Desnormalizado da conversa: o índice da Fila mobile (MOB-03) filtra
    --    por canal e ordena por chegada. Sem esta coluna ele exigiria join com
    --    `conversa` e ficaria sem índice possível.
    canal_id    uuid        NOT NULL,

    -- ⚠️ Formato fechado (A-02): bigint sequencial por tenant, de
    --    contador_por_tenant. NUNCA reinicia — sequência que reinicia por mês
    --    quebra a unicidade no ano seguinte. O zero-padding (#000318) é só
    --    apresentação; a busca aceita com ou sem `#` e com ou sem zeros.
    protocolo   bigint      NOT NULL,

    atendente_id uuid,
    estado      text        NOT NULL DEFAULT 'na_fila',
    setor_id    uuid,
    csat        smallint,

    criado_em   timestamptz NOT NULL DEFAULT now(),
    assumido_em timestamptz,
    encerrado_em timestamptz,

    -- ⚠️ AS QUATRO COLUNAS DE PRIMEIRA RESPOSTA (MO-07, MC-05, LB-11).
    primeira_entrante_em        timestamptz,
    -- Qualquer resposta, inclusive a automática de ausência.
    primeira_resposta_em        timestamptz,
    -- ⚠️ SÓ resposta de gente. São duas colunas DE PROPÓSITO: a mensagem
    --    automática preenche a de cima e NÃO esta. Com uma coluna só, um robô
    --    respondendo "Recebemos sua mensagem!" em 2 segundos faz o tempo de
    --    primeira resposta despencar e a métrica declarar uma vitória que não
    --    houve — que é exatamente a contra-métrica MC-05.
    primeira_resposta_humana_em timestamptz,
    -- Quem respondeu. Liga MO-07 ao ranking sem varrer `mensagem`.
    primeira_resposta_por_id    uuid,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa        (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, canal_id)    REFERENCES canal_conectado (tenant_id, id),
    FOREIGN KEY (tenant_id, atendente_id) REFERENCES usuario        (tenant_id, id),
    FOREIGN KEY (tenant_id, setor_id)     REFERENCES setor          (tenant_id, id),
    FOREIGN KEY (tenant_id, primeira_resposta_por_id) REFERENCES usuario (tenant_id, id),

    CONSTRAINT atendimento_protocolo_unico UNIQUE (tenant_id, protocolo),
    CONSTRAINT atendimento_estado_valido CHECK (estado IN ('na_fila','em_atendimento','encerrado')),
    CONSTRAINT atendimento_csat_valido CHECK (csat IS NULL OR csat BETWEEN 1 AND 5)
);

SELECT aplicar_rls('atendimento');

-- ⚠️ INV-51: no máximo UM atendimento aberto por conversa. Sem isto, duas
--    vendedoras assumem o mesmo cliente e as duas respondem — o cliente recebe
--    respostas conflitantes e nenhuma das duas sabe que a outra está lá.
CREATE UNIQUE INDEX atendimento_aberto_unico
    ON atendimento (tenant_id, conversa_id)
    WHERE estado <> 'encerrado';

-- Fila mobile (MOB-03): por canal, ordenada por chegada.
CREATE INDEX atendimento_fila
    ON atendimento (tenant_id, canal_id, criado_em)
    WHERE estado = 'na_fila';
CREATE INDEX atendimento_por_atendente
    ON atendimento (tenant_id, atendente_id, criado_em DESC)
    WHERE atendente_id IS NOT NULL;

COMMENT ON COLUMN atendimento.primeira_resposta_humana_em IS
    '⚠️ Preenchida SÓ por mensagem de pessoa. A automática de ausência preenche '
    'primeira_resposta_em e não esta — é o que torna a contra-métrica MC-05 '
    'possível. Uma coluna só tornaria a diferença invisível.';

-- Agora a FK circular de conversa → atendimento.
-- ⚠️ DEFERRABLE: conversa e atendimento nascem no MESMO commit quando a
--    primeira mensagem chega, e uma referencia a outra.
ALTER TABLE conversa
    ADD CONSTRAINT conversa_atendimento_atual_fk
    FOREIGN KEY (tenant_id, atendimento_atual_id) REFERENCES atendimento (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE atendimento_evento (
    tenant_id      uuid        NOT NULL,
    id             uuid        NOT NULL,
    atendimento_id uuid        NOT NULL,
    tipo           text        NOT NULL,
    ator_id        uuid,
    motivo         text,
    criado_em      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, atendimento_id) REFERENCES atendimento (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, ator_id)        REFERENCES usuario     (tenant_id, id)
);

SELECT aplicar_rls('atendimento_evento');

CREATE INDEX atendimento_evento_por_atendimento
    ON atendimento_evento (tenant_id, atendimento_id, criado_em);

-- ---------------------------------------------------------------------------
-- mensagem — particionada por mês.
-- ---------------------------------------------------------------------------

CREATE TABLE mensagem (
    tenant_id      uuid        NOT NULL,
    id             uuid        NOT NULL,
    conversa_id    uuid        NOT NULL,
    atendimento_id uuid,
    -- wamid da Meta. A unicidade real mora em `mensagem_id_externo`.
    id_externo     text,
    direcao        text        NOT NULL,
    tipo           text        NOT NULL,
    conteudo       jsonb       NOT NULL DEFAULT '{}'::jsonb,

    status         text,
    -- ⚠️ Ordem numérica do status, porque os webhooks da Meta chegam FORA DE
    --    ORDEM: o "lido" pode chegar antes do "entregue". Comparar texto não
    --    resolve; sem esta coluna a mensagem regride de lido para entregue na
    --    tela, e o vendedor acha que o cliente não viu.
    status_ordem   smallint,
    enviada_por_id uuid,
    campanha_id    uuid,
    template_id    uuid,
    criado_em      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, criado_em, id),
    CONSTRAINT mensagem_direcao_valida CHECK (direcao IN ('entrante','saliente')),
    CONSTRAINT mensagem_tipo_valido CHECK (tipo IN (
        'texto','imagem','audio','video','documento','localizacao','contato','sticker','sistema'
    )),
    CONSTRAINT mensagem_status_valido CHECK (status IS NULL OR status IN (
        'pendente','enviada','entregue','lida','falhou'
    ))
) PARTITION BY RANGE (criado_em);

SELECT aplicar_rls('mensagem');

-- ⚠️ Função reutilizável em vez de bloco solto: sem alguém criando partição do
--    mês seguinte, o INSERT falha no dia 1º e o inbox PARA DE RECEBER mensagem.
--    Esta função é chamada por worker agendado, e é idempotente.
CREATE OR REPLACE FUNCTION garantir_particoes_mensais(
    nome_tabela text,
    meses_a_frente int DEFAULT 12,
    meses_atras int DEFAULT 1
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    criadas int := 0;
    inicio date := (date_trunc('month', now()) - (meses_atras || ' months')::interval)::date;
    i int; de date; ate date; nome text;
BEGIN
    FOR i IN 0 .. (meses_atras + meses_a_frente) LOOP
        de  := (inicio + (i     || ' month')::interval)::date;
        ate := (inicio + (i + 1 || ' month')::interval)::date;
        nome := format('%s_%s', nome_tabela, to_char(de, 'YYYY_MM'));
        IF to_regclass(nome) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                nome, nome_tabela, de, ate);
            criadas := criadas + 1;
        END IF;
    END LOOP;
    RETURN criadas;
END;
$$;

COMMENT ON FUNCTION garantir_particoes_mensais(text, int, int) IS
    '⚠️ Chamada por worker agendado. Sem partição do mês seguinte o INSERT falha '
    'no dia 1º e o inbox para de receber mensagem — falha total, no pior horário, '
    'e o erro que aparece ("no partition of relation found") não sugere a causa.';

SELECT garantir_particoes_mensais('mensagem', 12, 12);

-- Partição de escape para o passado. O corte é duro por número (ADR-014) e não
-- importamos histórico de conversa, mas mensagem com data torta vinda de webhook
-- não pode derrubar a ingestão inteira.
CREATE TABLE mensagem_anterior PARTITION OF mensagem
    FOR VALUES FROM ('1900-01-01') TO ('2025-08-01');

-- A leitura dominante: a thread da conversa, mais recente primeiro.
CREATE INDEX mensagem_thread ON mensagem (tenant_id, conversa_id, criado_em DESC);
CREATE INDEX mensagem_por_atendimento ON mensagem (tenant_id, atendimento_id, criado_em)
    WHERE atendimento_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- mensagem_id_externo — a guardiã do dedup (INV-38).
--
-- ⚠️ NÃO particionada, de propósito. A Meta reentrega webhook, e o reenvio pode
--    chegar semanas depois. Unicidade dentro da partição do mês deixaria a
--    mensagem duplicar quando o reenvio cruzasse a virada do mês — e o cliente
--    veria a mesma mensagem duas vezes na thread.
-- ---------------------------------------------------------------------------

CREATE TABLE mensagem_id_externo (
    tenant_id         uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id_externo        text        NOT NULL,
    mensagem_id       uuid        NOT NULL,
    mensagem_criado_em timestamptz NOT NULL,
    criado_em         timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id_externo)
);

SELECT aplicar_rls('mensagem_id_externo');

CREATE INDEX mensagem_id_externo_por_mensagem
    ON mensagem_id_externo (tenant_id, mensagem_id);

COMMENT ON TABLE mensagem_id_externo IS
    'Unicidade do wamid (INV-38), gravada no MESMO commit da mensagem. '
    '⚠️ Não particionada: reentrega de webhook pode cruzar a virada do mês, e '
    'unicidade por partição deixaria a mensagem duplicar na thread do cliente.';

-- ---------------------------------------------------------------------------
-- midia — ponteiro para object storage, nunca o binário.
-- ---------------------------------------------------------------------------

CREATE TABLE midia (
    tenant_id          uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id                 uuid        NOT NULL,
    mensagem_id        uuid        NOT NULL,
    -- ⚠️ Carrega a data da mensagem para a FK composta ser possível
    --    (INV-04/60): a PK de `mensagem` é (tenant_id, criado_em, id) por causa
    --    do particionamento, então referenciar só o id não fecha.
    mensagem_criado_em timestamptz NOT NULL,
    chave_objeto       text        NOT NULL,
    mime               text        NOT NULL,
    bytes              bigint,
    duracao_s          integer,
    -- Transcrição de áudio (IA). Nulável: nem todo áudio é transcrito.
    transcricao        text,
    criado_em          timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, mensagem_criado_em, mensagem_id)
        REFERENCES mensagem (tenant_id, criado_em, id) ON DELETE CASCADE
);

SELECT aplicar_rls('midia');

CREATE INDEX midia_por_mensagem ON midia (tenant_id, mensagem_id);
-- Busca por transcrição de áudio no histórico.
CREATE INDEX midia_transcricao_busca
    ON midia USING gin (transcricao gin_trgm_ops)
    WHERE transcricao IS NOT NULL;

COMMENT ON COLUMN midia.chave_objeto IS
    'Ponteiro no object storage. ⚠️ Nunca Base64 em coluna: infla backup, mata o '
    'custo e faz um único áudio de 2 min pesar mais que mil conversas de texto.';
