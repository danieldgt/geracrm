-- 0062_midia_lp.sql
--
-- A LANDING PAGE (agencia-mkt, AQ-44) — o destino sem o qual não há campanha.
--
-- ⚠️ O que estava travado NÃO era a página: era o TENANT. `POST /v1/aquisicao/
--    sessoes` já criava a sessão e montava o link do `wa.me`, mas é autenticado —
--    e a landing page roda no navegador de um desconhecido, que não tem token.
--
--    A tentação era receber `tenantId` no corpo. Isso viola o ADR-001 de frente:
--    tenant NUNCA vem de parâmetro. O caminho certo já tem precedente NESTE
--    repositório — o webhook da Meta (0057) não confia no que chega, ele
--    RESOLVE o tenant a partir de um identificador público (`phone_number_id` →
--    `canal_conectado` → tenant).
--
--    Esta migration dá à LP o mesmo mecanismo: uma **chave pública por página**,
--    única no mundo, que resolve para um tenant. Quem tem a chave pode criar
--    sessão naquela LP — e nada além disso.
--
-- ⚠️ A chave é PÚBLICA, não é segredo: ela aparece na URL do anúncio, no
--    histórico do navegador e no Google Analytics de quem clicar. O que ela
--    autoriza é deliberadamente mínimo: gravar uma visita anônima. Não lê contato,
--    não lê métrica, não escreve em mais nada.
--
-- Aditiva. Sob RLS como toda tabela de domínio.

CREATE TABLE midia_lp (
    tenant_id  uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id         uuid        NOT NULL,

    -- ⚠️ Única GLOBAL, não por tenant — é ela que RESOLVE o tenant, então duas
    --    iguais em clientes diferentes não teriam resposta certa. Mesma regra do
    --    `identificador_externo` do canal (0057).
    chave      text        NOT NULL,

    nome       text        NOT NULL,
    -- Destino do wa.me: só dígitos, com DDI. ⚠️ É o número que atende, e ele
    -- aparece na página — não há segredo nenhum aqui.
    telefone_destino text  NOT NULL,
    -- O texto que já vai escrito na conversa. O código de origem é acrescentado
    -- no fim, no momento do clique (`montarTextoWaMe`).
    texto_base text        NOT NULL DEFAULT 'Olá! Vi o anúncio',

    -- Conteúdo mínimo da página. Sem CMS de propósito: LP que exige editor vira
    -- projeto, e o que trava a campanha hoje é não ter destino nenhum.
    titulo     text        NOT NULL,
    subtitulo  text,
    chamada_botao text     NOT NULL DEFAULT 'Chamar no WhatsApp',
    -- ⚠️ LGPD: o TEXTO do aviso mostrado ao lead, não um booleano. É ele que fica
    --    registrado em `midia_lead_origem.consentimento_texto` quando a conversa
    --    começa — "aceitou os termos" sem dizer QUAL texto é indefensável.
    aviso_consentimento text,

    ativo      boolean     NOT NULL DEFAULT true,
    criado_em  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT midia_lp_chave_unica UNIQUE (chave),
    -- Minúscula e sem ambiguidade: a chave é digitada por humano em painel de
    -- anúncio mais vezes do que se imagina.
    CONSTRAINT midia_lp_chave_formato CHECK (chave ~ '^[a-z0-9]{12,40}$'),
    CONSTRAINT midia_lp_telefone_formato CHECK (telefone_destino ~ '^[0-9]{10,15}$')
);

SELECT aplicar_rls('midia_lp');

COMMENT ON TABLE midia_lp IS
    'Landing page de aquisição (AQ-44). ⚠️ A `chave` é PÚBLICA e resolve o tenant '
    'sem token — mesmo mecanismo do webhook (0057). Autoriza só criar sessão anônima.';
COMMENT ON COLUMN midia_lp.chave IS
    '⚠️ Única GLOBAL: é ela que resolve o tenant. Pública por natureza (viaja na URL).';

-- Descoberta de tenant para a LP PÚBLICA (sem sessão), espelho de
-- `canal_por_identificador_externo` (0057). SECURITY DEFINER porque `midia_lp`
-- tem RLS FORCE. ⚠️ Devolve só o mínimo para rotear — o conteúdo da página é lido
-- depois, sob RLS, com o tenant já estabelecido.
CREATE OR REPLACE FUNCTION lp_por_chave(p_chave text)
RETURNS TABLE (tenant_id uuid, lp_id uuid, ativo boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT tenant_id, id AS lp_id, ativo
      FROM midia_lp
     WHERE chave = p_chave
     LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION lp_por_chave(text) TO geracrm_app;

COMMENT ON FUNCTION lp_por_chave(text) IS
    '⚠️ Roteamento da landing page pública por chave (sem sessão). SECURITY '
    'DEFINER (RLS FORCE). Devolve só tenant/lp/ativo — nunca conteúdo.';

-- A LP que originou a sessão. ⚠️ Nulo nas sessões criadas pela rota autenticada
-- (teste/LP com backend próprio) — ausência é caso normal, não dado faltando.
ALTER TABLE midia_sessao_lp ADD COLUMN lp_id uuid;

-- ⚠️ A plataforma é decidida NA BORDA, quando ainda se sabe QUAL parâmetro veio
--    (`gclid` é Google, `fbclid` é Meta). Guardar só o `click_id` jogaria essa
--    informação fora — os dois são texto opaco, e depois não há como distinguir.
ALTER TABLE midia_sessao_lp ADD COLUMN plataforma text;
ALTER TABLE midia_sessao_lp ADD CONSTRAINT midia_sessao_plataforma_valida
    CHECK (plataforma IS NULL OR plataforma IN ('google','meta','tiktok'));

-- ⚠️ LGPD: o texto do aviso EXIBIDO no momento do clique, congelado aqui. Ler o
--    aviso da LP na hora de consumir devolveria a redação ATUAL — e o registro
--    passaria a afirmar que a pessoa consentiu com um texto que ela nunca viu.
ALTER TABLE midia_sessao_lp ADD COLUMN consentimento_texto text;

COMMENT ON COLUMN midia_sessao_lp.consentimento_texto IS
    '⚠️ Texto do aviso como estava NO CLIQUE. Congelado de propósito: a LP pode '
    'ser editada depois, e o consentimento registrado tem de ser o que a pessoa leu.';
-- ⚠️ FK COMPOSTA (INV-04): a PK de `midia_lp` é (tenant_id, id), e uma FK só por
--    `lp_id` deixaria a sessão de um tenant apontar para a LP de outro.
ALTER TABLE midia_sessao_lp
    ADD CONSTRAINT midia_sessao_lp_fk
    FOREIGN KEY (tenant_id, lp_id) REFERENCES midia_lp (tenant_id, id);

COMMENT ON COLUMN midia_sessao_lp.lp_id IS
    'LP que gerou a sessão. NULL quando veio da rota autenticada (LP externa).';
