-- 0130_pos_venda_nps_indicacao_prova_social.sql
--
-- Raia G3 da paridade AM (#100, #104, #106): pós-venda pelo agente, NPS e
-- indicações registrados pelo agente, e PROVA SOCIAL aprovada no Conhecimento.
--
--   1. Automação: gatilho `pedido_efetivado` (parâmetro diasDepois 0..60) e ação
--      `agente_envia` (roteiro agradecimento | nps | indicacao, texto e/ou template).
--      A ação agenda uma ATIVA na fila do agente (`agente_retorno`, motivo novo
--      `pos_venda`): mesmo worker, mesma política (expediente, limites, opt-out,
--      suspensão por qualidade, template fora de 24h, aquecimento no não-oficial).
--      ⚠️ Idempotência por PEDIDO + ROTEIRO: índice único parcial em
--         agente_retorno (pedido_id, roteiro). Duas regras com o mesmo roteiro, ou
--         duas passadas do motor, não mandam a mesma mensagem duas vezes.
--   2. NPS: origem nova `agente` (a nota registrada pela ferramenta `registrar_nps`).
--   3. Contato: `indicado_por` (quem indicou), FK composta. ON DELETE SET NULL só da
--      coluna (PG 15+): apagar o indicante não apaga nem anula o tenant do indicado.
--   4. Conhecimento: tipo novo `prova_social` com fonte, link, data de apuração,
--      tipo da prova (número/depoimento), consentimento e APROVAÇÃO (admin).
--      Só aprovado e vigente chega à ferramenta `consultar_prova_social`; a busca
--      comum (`conhecimento_buscar`) nunca devolve prova social.
--
-- ⚠️ ADITIVA: colunas nulas ou com padrão, CHECKs AMPLIADOS (drop + add NOT VALID +
--    VALIDATE — nenhuma linha antiga viola, e a versão anterior só grava valores
--    antigos). O índice único `agente_retorno_um_pendente` NÃO é tocado: o
--    ON CONFLICT da versão anterior depende dele. Por causa dele, um pós-venda
--    pendente por conversa: o motor tenta o seguinte na próxima passada.

-- ── 1. automação ──────────────────────────────────────────────────────────────

ALTER TABLE automacao DROP CONSTRAINT automacao_gatilho_valido;
ALTER TABLE automacao ADD CONSTRAINT automacao_gatilho_valido CHECK (gatilho IN (
    'rfv_segmento', 'dias_sem_comprar', 'lead_frio', 'nps_detrator', 'reposicao_ritmo', 'pedido_efetivado'
)) NOT VALID;
ALTER TABLE automacao VALIDATE CONSTRAINT automacao_gatilho_valido;

ALTER TABLE automacao DROP CONSTRAINT automacao_acao_valida;
ALTER TABLE automacao ADD CONSTRAINT automacao_acao_valida CHECK (acao IN (
    'criar_tarefa', 'aplicar_sequencia', 'adicionar_lista', 'enviar_mensagem', 'agente_envia'
)) NOT VALID;
ALTER TABLE automacao VALIDATE CONSTRAINT automacao_acao_valida;

COMMENT ON COLUMN automacao.gatilho IS
    'rfv_segmento | dias_sem_comprar | lead_frio | nps_detrator | reposicao_ritmo | pedido_efetivado '
    '(gatilho_param.diasDepois 0..60: dias depois da efetivação; age POR PEDIDO, não por contato).';

-- ── agente_retorno: o pós-venda ──────────────────────────────────────────────

ALTER TABLE agente_retorno DROP CONSTRAINT agente_retorno_motivo_valido;
ALTER TABLE agente_retorno ADD CONSTRAINT agente_retorno_motivo_valido
    CHECK (motivo IN ('proposta_sem_resposta', 'carrinho_abandonado', 'combinado',
                      'descarte_sem_resposta', 'reativacao', 'pos_venda')) NOT VALID;
ALTER TABLE agente_retorno VALIDATE CONSTRAINT agente_retorno_motivo_valido;

ALTER TABLE agente_retorno
    ADD COLUMN pedido_id    uuid,
    ADD COLUMN roteiro      text,
    ADD COLUMN template_id  uuid,
    ADD COLUMN automacao_id uuid;

ALTER TABLE agente_retorno
    ADD CONSTRAINT agente_retorno_roteiro_valido
        CHECK (roteiro IS NULL OR roteiro IN ('agradecimento', 'nps', 'indicacao')) NOT VALID;
ALTER TABLE agente_retorno VALIDATE CONSTRAINT agente_retorno_roteiro_valido;

-- Pós-venda sempre sabe de qual pedido e de qual roteiro é; os outros motivos não têm.
ALTER TABLE agente_retorno
    ADD CONSTRAINT agente_retorno_pos_venda_coerente
        CHECK ((motivo = 'pos_venda') = (pedido_id IS NOT NULL AND roteiro IS NOT NULL)) NOT VALID;
ALTER TABLE agente_retorno VALIDATE CONSTRAINT agente_retorno_pos_venda_coerente;

ALTER TABLE agente_retorno
    ADD CONSTRAINT agente_retorno_pedido_fk
        FOREIGN KEY (tenant_id, pedido_id) REFERENCES pedido (tenant_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE agente_retorno VALIDATE CONSTRAINT agente_retorno_pedido_fk;

-- ⚠️ A idempotência do pós-venda: UMA linha por (pedido, roteiro), em qualquer estado.
CREATE UNIQUE INDEX agente_retorno_pos_venda_unico
    ON agente_retorno (tenant_id, pedido_id, roteiro) WHERE pedido_id IS NOT NULL;

COMMENT ON COLUMN agente_retorno.pedido_id IS
    'Pós-venda (motivo pos_venda): o pedido efetivado que originou a mensagem. Único com o roteiro.';
COMMENT ON COLUMN agente_retorno.roteiro IS
    'Pós-venda: agradecimento | nps | indicacao. O envio de "nps" abre o roteiro na sessão do agente '
    '(estado_agente.posVenda) — só então a ferramenta registrar_nps aceita nota.';
COMMENT ON COLUMN agente_retorno.template_id IS
    'Pós-venda no oficial: template aprovado da automação, usado fora da janela de 24h (ou sem texto).';
COMMENT ON COLUMN agente_retorno.automacao_id IS
    'Pós-venda: a automação que agendou (sem FK — apagar a regra não apaga o histórico do envio).';

-- ── 2. NPS: origem agente ────────────────────────────────────────────────────

ALTER TABLE nps_resposta DROP CONSTRAINT nps_origem_valida;
ALTER TABLE nps_resposta ADD CONSTRAINT nps_origem_valida
    CHECK (origem IN ('manual', 'campanha', 'conversa', 'importacao', 'agente')) NOT VALID;
ALTER TABLE nps_resposta VALIDATE CONSTRAINT nps_origem_valida;

COMMENT ON COLUMN nps_resposta.origem IS
    'manual | campanha | conversa | importacao | agente (nota registrada pelo agente no roteiro NPS do '
    'pós-venda; atendente_id NULL — o painel mostra o agente separado dos vendedores).';

-- ── 3. contato.indicado_por ──────────────────────────────────────────────────

ALTER TABLE contato ADD COLUMN indicado_por uuid;
ALTER TABLE contato
    ADD CONSTRAINT contato_indicado_por_fk
        FOREIGN KEY (tenant_id, indicado_por) REFERENCES contato (tenant_id, id)
        ON DELETE SET NULL (indicado_por) NOT VALID;
ALTER TABLE contato VALIDATE CONSTRAINT contato_indicado_por_fk;
ALTER TABLE contato
    ADD CONSTRAINT contato_indicado_por_outro CHECK (indicado_por IS NULL OR indicado_por <> id) NOT VALID;
ALTER TABLE contato VALIDATE CONSTRAINT contato_indicado_por_outro;

CREATE INDEX contato_por_indicante ON contato (tenant_id, indicado_por) WHERE indicado_por IS NOT NULL;

COMMENT ON COLUMN contato.indicado_por IS
    'Contato que indicou este (ferramenta registrar_indicacoes do agente). O indicado nasce SEM dono '
    'e entra na distribuição normal — não herda a carteira do indicante.';

-- ── 4. conhecimento: prova social ────────────────────────────────────────────

ALTER TABLE conhecimento_documento DROP CONSTRAINT conhecimento_tipo_valido;
ALTER TABLE conhecimento_documento ADD CONSTRAINT conhecimento_tipo_valido CHECK (
    tipo IN ('politicas', 'faq', 'frete', 'pagamento', 'troca', 'produto', 'outro', 'prova_social')) NOT VALID;
ALTER TABLE conhecimento_documento VALIDATE CONSTRAINT conhecimento_tipo_valido;

ALTER TABLE conhecimento_documento
    ADD COLUMN fonte          text,
    ADD COLUMN link           text,
    ADD COLUMN apurado_em     date,
    ADD COLUMN prova_tipo     text,
    ADD COLUMN consentimento  boolean NOT NULL DEFAULT false,
    ADD COLUMN aprovado       boolean NOT NULL DEFAULT false,
    ADD COLUMN aprovado_por   uuid,
    ADD COLUMN aprovado_em    timestamptz;

ALTER TABLE conhecimento_documento
    ADD CONSTRAINT conhecimento_prova_tipo_valido
        CHECK (prova_tipo IS NULL OR prova_tipo IN ('numero', 'depoimento')) NOT VALID;
ALTER TABLE conhecimento_documento VALIDATE CONSTRAINT conhecimento_prova_tipo_valido;

-- ⚠️ Aprovado só existe em prova social, e prova social aprovada tem fonte, data e
--    (se for depoimento de cliente) consentimento. A API valida antes; o banco é a rede.
ALTER TABLE conhecimento_documento
    ADD CONSTRAINT conhecimento_aprovacao_coerente CHECK (
        NOT aprovado OR (
            tipo = 'prova_social'
            AND fonte IS NOT NULL AND length(btrim(fonte)) > 0
            AND apurado_em IS NOT NULL
            AND prova_tipo IS NOT NULL
            AND (prova_tipo <> 'depoimento' OR consentimento)
        )) NOT VALID;
ALTER TABLE conhecimento_documento VALIDATE CONSTRAINT conhecimento_aprovacao_coerente;

ALTER TABLE conhecimento_documento
    ADD CONSTRAINT conhecimento_link_http CHECK (link IS NULL OR link ~* '^https?://\S+$') NOT VALID;
ALTER TABLE conhecimento_documento VALIDATE CONSTRAINT conhecimento_link_http;

ALTER TABLE conhecimento_documento
    ADD CONSTRAINT conhecimento_aprovado_por_fk
        FOREIGN KEY (tenant_id, aprovado_por) REFERENCES usuario (tenant_id, id)
        ON DELETE SET NULL (aprovado_por) NOT VALID;
ALTER TABLE conhecimento_documento VALIDATE CONSTRAINT conhecimento_aprovado_por_fk;

-- A ferramenta lê só aprovados publicados de um tenant, mais recentes primeiro.
CREATE INDEX conhecimento_prova_social_aprovada
    ON conhecimento_documento (tenant_id, apurado_em DESC)
    WHERE tipo = 'prova_social' AND aprovado AND publicado;

COMMENT ON COLUMN conhecimento_documento.aprovado IS
    'Prova social: aprovada por admin (só aprovada e vigente chega ao agente). Qualquer edição de '
    'texto, fonte, link, data, tipo ou consentimento volta para não aprovada.';
COMMENT ON COLUMN conhecimento_documento.consentimento IS
    'Prova social do tipo depoimento: o cliente autorizou o uso (LGPD). Obrigatório para aprovar.';
