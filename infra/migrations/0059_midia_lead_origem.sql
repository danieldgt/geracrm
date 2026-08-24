-- 0059_midia_lead_origem.sql
--
-- DE ONDE O LEAD VEIO (agencia-mkt, AQ-09/44/45). É o item nº 1 da camada: sem
-- origem não existe atribuição, e sem atribuição a operação vira agência comum.
--
-- ⚠️ Sem Click-to-WhatsApp (AMK-012), a origem viaja num CÓDIGO dentro da mensagem
--    pronta do link `wa.me`. É o nosso `ctwa_clid`, feito à mão — e o lead PODE
--    apagá-lo antes de enviar. O desenho assume a perda em vez de fingir que ela
--    não acontece.
-- Tudo aditivo, tudo sob RLS.

-- ---------------------------------------------------------------------------
-- midia_sessao_lp — a visita à landing page, antes de existir contato
-- ---------------------------------------------------------------------------
-- A LP grava a sessão com o clique da plataforma, gera um código curto e o injeta
-- no `?text=` do wa.me. Quando a mensagem chega, o código liga a conversa ao anúncio.
--
-- ⚠️ A sessão nasce ANÔNIMA — não há contato ainda, e não pode haver: exigir
--    identificação antes da conversa é justamente o atrito que o wa.me elimina.

CREATE TABLE midia_sessao_lp (
    tenant_id   uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id          uuid        NOT NULL,
    -- ⚠️ O código que viaja na mensagem. Curto porque é lido por humano numa
    --    conversa; único por tenant porque é assim que o casamento acontece.
    --    Sem PII: é marcador de sessão, não identificador de pessoa.
    codigo      text        NOT NULL,
    -- Clique da plataforma: gclid | wbraid | gbraid (Google), fbclid (Meta).
    click_id    text,
    utm_source   text,
    utm_medium   text,
    utm_campaign text,
    utm_content  text,
    utm_term     text,
    -- Ids externos como VIERAM da URL. ⚠️ Texto, não FK: a sessão acontece antes
    --    de a estrutura de anúncio ter sido sincronizada.
    campanha_externa_id text,
    anuncio_externo_id  text,
    pagina      text,
    referrer    text,
    -- ⚠️ Carimbo do SERVIDOR, nunca do navegador.
    criado_em   timestamptz NOT NULL DEFAULT now(),
    -- Preenchido quando o código aparece numa primeira mensagem.
    consumida_em timestamptz,

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT midia_sessao_codigo_unico UNIQUE (tenant_id, codigo),
    CONSTRAINT midia_sessao_codigo_formato CHECK (codigo ~ '^[A-Z0-9]{5,12}$')
);
-- Expurgo de sessão que nunca virou conversa (a maioria) roda por data.
CREATE INDEX midia_sessao_por_data ON midia_sessao_lp (tenant_id, criado_em);
SELECT aplicar_rls('midia_sessao_lp');

COMMENT ON TABLE midia_sessao_lp IS
    '⚠️ Sessão anônima da landing page. O `codigo` viaja no ?text= do wa.me e é o '
    'que liga a conversa ao anúncio quando o lead escreve. Sem ele, a origem entra '
    'PARCIAL — sabemos que veio da LP, não de qual anúncio.';
COMMENT ON COLUMN midia_sessao_lp.consumida_em IS
    '⚠️ A razão (sessões consumidas ÷ criadas) é métrica de saúde da atribuição: '
    'se despencar, o código está se perdendo e o ROAS está furando em silêncio.';

-- ---------------------------------------------------------------------------
-- midia_lead_origem — o toque de mídia que trouxe este contato
-- ---------------------------------------------------------------------------
-- ⚠️ É 1:N com `contato`, NÃO 1:1. O mesmo contato pode chegar por um anúncio hoje
--    e por outro em três meses — e a origem nova NÃO apaga a primeira. Guardamos
--    todos os toques e o modelo de atribuição é DECLARADO na consulta (primeiro
--    toque × último toque), pela mesma disciplina de exata × estimada (AMK-009).

CREATE TABLE midia_lead_origem (
    tenant_id   uuid        NOT NULL,
    id          uuid        NOT NULL,
    contato_id  uuid        NOT NULL,
    -- A sessão de LP que originou, quando houve.
    sessao_id   uuid,
    -- ⚠️ Ids externos SEMPRE preenchidos; as FKs abaixo são conveniência resolvida
    --    depois pelo sincronizador. O lead chega pelo webhook em segundos; a
    --    estrutura de anúncio só é sincronizada horas depois. Um desenho só-FK
    --    perderia exatamente os leads mais recentes.
    plataforma          text,
    campanha_externa_id text,
    anuncio_externo_id  text,
    click_id            text,
    utm_source   text,
    utm_medium   text,
    utm_campaign text,
    -- Resolvidas pelo sincronizador quando a estrutura chega. NULL não é erro.
    conta_id    uuid,
    campanha_id uuid,
    anuncio_id  uuid,
    -- ⚠️ AMK-016: o modo pelo qual este lead entrou. Copiado da campanha no
    --    momento da entrada — a campanha pode mudar de modo depois, e o que
    --    valeu para ESTE lead precisa ficar registrado.
    modo_entrada text,
    -- ⚠️ Marca o PRIMEIRO toque. O índice parcial abaixo garante um só por contato.
    primeira    boolean     NOT NULL DEFAULT false,
    -- ⚠️ LGPD: guardar o TEXTO exato do consentimento, não um booleano. "Aceitou
    --    os termos" sem dizer QUAL texto é indefensável em auditoria.
    consentimento_texto text,
    consentimento_em    timestamptz,
    -- Carimbo do servidor.
    capturado_em timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato        (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, sessao_id)   REFERENCES midia_sessao_lp (tenant_id, id),
    FOREIGN KEY (tenant_id, conta_id)    REFERENCES midia_conta     (tenant_id, id),
    FOREIGN KEY (tenant_id, campanha_id) REFERENCES midia_campanha  (tenant_id, id),
    FOREIGN KEY (tenant_id, anuncio_id)  REFERENCES midia_anuncio   (tenant_id, id),
    CONSTRAINT midia_origem_plataforma_valida CHECK (
        plataforma IS NULL OR plataforma IN ('google','meta','tiktok')),
    CONSTRAINT midia_origem_modo_valido CHECK (
        modo_entrada IS NULL OR modo_entrada IN ('inbound_wa','outbound_formulario')),
    -- ⚠️ Consentimento é par: ou os dois, ou nenhum. Mesmo padrão de
    --    contato.qualificado/qualificado_em (0008).
    CONSTRAINT midia_origem_consentimento_coerente CHECK (
        (consentimento_texto IS NULL AND consentimento_em IS NULL) OR
        (consentimento_texto IS NOT NULL AND consentimento_em IS NOT NULL)
    )
);

-- ⚠️ INV-61: no máximo UM primeiro toque por contato. Sem isto, dois webhooks
--    concorrentes marcam os dois como primeira e a atribuição de primeiro toque
--    passa a depender de qual linha o ORDER BY escolher — bug silencioso e
--    irreprodutível. Mesmo padrão do INV-51 (atendimento_aberto_unico).
CREATE UNIQUE INDEX midia_origem_primeira_unica
    ON midia_lead_origem (tenant_id, contato_id)
    WHERE primeira;

-- Todos os toques de um contato, em ordem — a consulta da ficha e da atribuição.
CREATE INDEX midia_origem_por_contato
    ON midia_lead_origem (tenant_id, contato_id, capturado_em DESC);
-- Funil por origem (AQ-39): leads de um anúncio num período.
CREATE INDEX midia_origem_por_anuncio
    ON midia_lead_origem (tenant_id, anuncio_id, capturado_em)
    WHERE anuncio_id IS NOT NULL;
-- Resolução tardia: achar as origens que ainda não casaram com a estrutura.
CREATE INDEX midia_origem_pendente_resolucao
    ON midia_lead_origem (tenant_id, anuncio_externo_id)
    WHERE anuncio_id IS NULL AND anuncio_externo_id IS NOT NULL;

SELECT aplicar_rls('midia_lead_origem');

COMMENT ON TABLE midia_lead_origem IS
    '⚠️ 1:N com contato — todos os toques de mídia, o novo não apaga o antigo. O '
    'modelo de atribuição (primeiro × último toque) é escolhido e DECLARADO na '
    'consulta, nunca embutido no dado.';
COMMENT ON COLUMN midia_lead_origem.anuncio_externo_id IS
    '⚠️ Sempre preenchido quando conhecido; `anuncio_id` é resolvido depois pelo '
    'sincronizador. O lead chega em segundos, a estrutura só horas depois.';
COMMENT ON COLUMN midia_lead_origem.consentimento_texto IS
    '⚠️ LGPD: o TEXTO exato mostrado ao lead, não um booleano. Sem ele não há como '
    'provar qual base legal foi coletada.';
