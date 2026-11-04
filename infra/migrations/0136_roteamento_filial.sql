-- 0136_roteamento_filial.sql
--
-- ROTEAMENTO POR FILIAL E RODÍZIO (raia G4 — plano-paridade-am #71, #91).
--
--   regra_roteamento — DDD → filial, origem → filial e a filial PADRÃO, por número
--       (canal_id) ou para todos (canal_id NULL). A precedência é do CÓDIGO
--       (shared `resolverFilial`): filial gravada no contato → origem → DDD →
--       padrão do número → filial do número → padrão geral → nenhuma.
--       `valor`: DDD com 2 dígitos | origem.id (texto) | NULL no padrão.
--       `prioridade` desempata regras do MESMO nível (menor vence) e ordena a tela.
--   rodizio_filial — o ponteiro do rodízio de cada filial: o último usuário
--       escolhido, por finalidade ('entrada' = carteira do contato novo;
--       'handoff' = responsável pelo cliente que o agente transferiu). A linha é
--       TRAVADA (INSERT … ON CONFLICT DO UPDATE) antes de ler o ponteiro: dois
--       contatos novos ao mesmo tempo não pegam o mesmo vendedor fora da vez.
--   canal_configuracao.rodizio_na_entrada — RN-04 por número: contato NOVO pela
--       ingestão de mensagem, sem carteira, ganha dono pelo rodízio da filial
--       roteada. Padrão DESLIGADO (o comportamento de hoje).
--   atendimento.responsavel_filial_id — a filial pela qual o handoff foi
--       roteado (rotas 'filial' e 'gestor_filial'): o aviso de mensagem nova
--       segue a mesma regra e a auditoria diz "por que foi para ela".
--   atendimento.responsavel_origem — ganha 'filial' e 'gestor_filial'.
--
-- ⚠️ Aditiva: tabelas novas, colunas anuláveis ou com DEFAULT constante (sem
--    reescrita no PG >= 11), e um CHECK ALARGADO (aceita tudo o que aceitava).
--    A versão anterior não conhece nada disto e segue roteando como antes.

CREATE TABLE regra_roteamento (
    tenant_id      uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id             uuid        NOT NULL,
    -- NULL = vale para TODOS os números do tenant.
    canal_id       uuid        NULL,
    tipo           text        NOT NULL,
    valor          text        NULL,
    filial_id      uuid        NOT NULL,
    prioridade     integer     NOT NULL DEFAULT 100,
    ativa          boolean     NOT NULL DEFAULT true,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    -- usuario.id de quem mudou por último. A trilha completa fica em `auditoria`.
    atualizado_por uuid        NULL,
    -- Origem como coluna própria para a FK (apagar a origem leva a regra junto).
    origem_id      uuid GENERATED ALWAYS AS (CASE WHEN tipo = 'origem' THEN valor::uuid END) STORED,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, canal_id)  REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, filial_id) REFERENCES filial (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, origem_id) REFERENCES origem (tenant_id, id) ON DELETE CASCADE,

    CONSTRAINT regra_roteamento_tipo_valido CHECK (tipo IN ('ddd', 'origem', 'padrao')),
    -- ⚠️ A regra do valor mora no banco também: DDD com letra ou origem que não é
    --    uuid nunca casaria, e a regra ficaria na tela sem efeito.
    CONSTRAINT regra_roteamento_valor_coerente CHECK (
        (tipo = 'ddd'    AND valor ~ '^[1-9][0-9]$')
     OR (tipo = 'origem' AND valor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (tipo = 'padrao' AND valor IS NULL)),
    CONSTRAINT regra_roteamento_prioridade CHECK (prioridade BETWEEN 0 AND 9999)
);

SELECT aplicar_rls('regra_roteamento');

-- Uma regra por (número, tipo, valor). ⚠️ UNIQUE comum trata NULL como distinto
-- — permitiria dez "padrão geral" no mesmo tenant. A expressão fecha o buraco.
CREATE UNIQUE INDEX regra_roteamento_unica
    ON regra_roteamento (tenant_id, coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo, coalesce(valor, ''));

-- A resolução procura por (tipo, valor) entre as ativas.
CREATE INDEX regra_roteamento_busca ON regra_roteamento (tenant_id, tipo, valor) WHERE ativa;

COMMENT ON TABLE regra_roteamento IS
    'Roteamento por filial (G4): DDD → filial, origem → filial e padrão, por número (canal_id) ou todos (NULL). '
    'Precedência no código (shared resolverFilial): contato → origem → DDD → padrão do número → filial do número '
    '→ padrão geral. prioridade desempata no mesmo nível (menor vence).';

CREATE TABLE rodizio_filial (
    tenant_id         uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    filial_id         uuid        NOT NULL,
    finalidade        text        NOT NULL,
    -- Ponteiro, não vínculo: usuário desativado continua aqui até a próxima vez
    -- (o próximo é o primeiro id MAIOR entre os elegíveis). Sem FK de propósito.
    ultimo_usuario_id uuid        NULL,
    atualizado_em     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, filial_id, finalidade),
    FOREIGN KEY (tenant_id, filial_id) REFERENCES filial (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT rodizio_filial_finalidade CHECK (finalidade IN ('entrada', 'handoff'))
);

SELECT aplicar_rls('rodizio_filial');

COMMENT ON TABLE rodizio_filial IS
    'Ponteiro do rodízio por filial (G4): último usuário escolhido. entrada = carteira do contato novo (RN-04); '
    'handoff = responsável do cliente transferido pelo agente. Travado por linha antes de ler: sem corrida.';

ALTER TABLE canal_configuracao
    ADD COLUMN rodizio_na_entrada boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN canal_configuracao.rodizio_na_entrada IS
    'RN-04 (G4): contato NOVO pela ingestão de mensagem neste número, sem carteira, ganha dono pelo rodízio da '
    'filial roteada (origem automatica, auditado). Desligado = o contato nasce órfão, como antes.';

ALTER TABLE atendimento ADD COLUMN responsavel_filial_id uuid NULL;

ALTER TABLE atendimento ADD CONSTRAINT atendimento_responsavel_filial_fk
    FOREIGN KEY (tenant_id, responsavel_filial_id) REFERENCES filial (tenant_id, id) NOT VALID;
ALTER TABLE atendimento VALIDATE CONSTRAINT atendimento_responsavel_filial_fk;

-- CHECK alargado: o antigo aceitava dono_carteira | pool | gestor; o novo, também.
ALTER TABLE atendimento DROP CONSTRAINT atendimento_responsavel_origem_valida;
ALTER TABLE atendimento ADD CONSTRAINT atendimento_responsavel_origem_valida CHECK (
    responsavel_origem IS NULL OR responsavel_origem IN ('dono_carteira', 'filial', 'pool', 'gestor_filial', 'gestor')) NOT VALID;
ALTER TABLE atendimento VALIDATE CONSTRAINT atendimento_responsavel_origem_valida;

COMMENT ON COLUMN atendimento.responsavel_filial_id IS
    'Filial pela qual o handoff foi roteado (G4: rotas filial e gestor_filial). NULL nas demais rotas.';
