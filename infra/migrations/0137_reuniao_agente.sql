-- 0137_reuniao_agente.sql
--
-- REUNIÃO MARCADA PELO CRM E PELO AGENTE (raia C3 do plano de paridade). Depende da agenda (C2,
-- 0117) e só tem efeito com o módulo `agenda` ligado no tenant (`tenant_modulo`, 0116).
--
-- ⚠️ ADITIVA: colunas com padrão constante, tabelas novas sob RLS. A versão anterior não conhece
--    nada disto e segue funcionando (sem chave = o agente não marca; sem origem = 'agenda').
--
-- • agente_config.agenda_reunioes — a chave POR NÚMERO "O agente pode marcar reuniões".
--   Padrão DESLIGADO (decisão do dono): desligada, a ferramenta `agendar_reuniao` não é
--   registrada no turno (ADR-029). Os dois templates são os dos avisos ao cliente no oficial
--   fora da janela de 24h (lembrete e convite para remarcar após no-show); sem eles, o aviso
--   fora da janela é recusado com motivo nomeado — nunca texto livre fora da janela.
-- • evento_agenda.{conversa_id, canal_id, origem} — de qual conversa a reunião nasceu. É o
--   que permite avisar o CLIENTE (lembrete/no-show vão pela conversa); evento da tela de
--   Agenda (origem 'agenda') continua só com o lembrete do sino.
-- • evento_agenda_aviso — um aviso ao cliente por evento + tipo. A chave única é o que torna
--   o worker idempotente (INSERT … ON CONFLICT DO NOTHING RETURNING antes de enviar):
--   lembretes por (evento, tipo, início) — reagendar rearma; no-show UMA vez por evento.
-- • reuniao_oferta — os horários que o agente ofertou numa conversa. O "sim" do cliente só
--   confirma uma oferta feita num turno ANTERIOR, ainda válida e ainda não usada.

ALTER TABLE agente_config
    ADD COLUMN agenda_reunioes           boolean NOT NULL DEFAULT false,
    ADD COLUMN agenda_template_lembrete  uuid    NULL,
    ADD COLUMN agenda_template_reagendar uuid    NULL;

COMMENT ON COLUMN agente_config.agenda_reunioes IS
    'C3: "O agente pode marcar reuniões" neste número. Padrão desligado; desligada, a ferramenta agendar_reuniao não entra no turno.';
COMMENT ON COLUMN agente_config.agenda_template_lembrete IS
    'C3: template aprovado (só {{1}} = primeiro nome) do lembrete H-24/H-2 no oficial fora da janela. NULL = recusa nomeada.';
COMMENT ON COLUMN agente_config.agenda_template_reagendar IS
    'C3: template aprovado do convite para remarcar após no-show no oficial fora da janela. NULL = recusa nomeada (e vai para uma pessoa).';

ALTER TABLE evento_agenda
    ADD COLUMN conversa_id uuid NULL,
    ADD COLUMN canal_id    uuid NULL,
    ADD COLUMN origem      text NOT NULL DEFAULT 'agenda';
ALTER TABLE evento_agenda ADD CONSTRAINT evento_agenda_origem
    CHECK (origem IN ('agenda', 'conversa', 'agente')) NOT VALID;
ALTER TABLE evento_agenda VALIDATE CONSTRAINT evento_agenda_origem;
ALTER TABLE evento_agenda ADD CONSTRAINT evento_agenda_conversa_fk
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE SET NULL (conversa_id) NOT VALID;
ALTER TABLE evento_agenda VALIDATE CONSTRAINT evento_agenda_conversa_fk;

COMMENT ON COLUMN evento_agenda.conversa_id IS 'C3: conversa onde a reunião foi marcada (botão do inbox ou agente). Os avisos ao cliente vão por ela.';
COMMENT ON COLUMN evento_agenda.origem IS 'C3: agenda (tela de Agenda) | conversa (botão "Agendar reunião") | agente (ferramenta agendar_reuniao).';

-- Varredura dos avisos ao cliente: só eventos que nasceram numa conversa e ainda podem pedir aviso.
CREATE INDEX evento_agenda_avisar_cliente ON evento_agenda (inicio)
    WHERE conversa_id IS NOT NULL AND status IN ('agendado', 'nao_compareceu');

CREATE TABLE evento_agenda_aviso (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    evento_id     uuid        NOT NULL,
    tipo          text        NOT NULL,
    -- O início do evento quando o aviso foi decidido: reagendar (novo início) rearma os lembretes.
    inicio_evento timestamptz NOT NULL,
    canal_id      uuid,
    estado        text        NOT NULL DEFAULT 'pendente',
    -- Por onde saiu: 'texto' (janela aberta / não-oficial) ou 'template' (oficial fora da janela).
    via           text,
    motivo        text,
    mensagem_id   uuid,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    concluido_em  timestamptz,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, evento_id) REFERENCES evento_agenda (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT evento_agenda_aviso_tipo CHECK (tipo IN ('h24', 'h2', 'noshow')),
    CONSTRAINT evento_agenda_aviso_estado CHECK (estado IN (
        'pendente',    -- reservado pelo worker, envio em curso
        'enviado',     -- lembrete enviado
        'recusado',    -- política (sem template, opt-out, janela, cota) ou transporte — com motivo
        'aguardando',  -- no-show: convite enviado, esperando o cliente remarcar
        'reagendado',  -- no-show: o contato ganhou outra reunião no prazo
        'handoff'      -- no-show: sem remarcar no prazo (ou convite recusado) → uma pessoa
    )),
    CONSTRAINT evento_agenda_aviso_via CHECK (via IS NULL OR via IN ('texto', 'template'))
);
-- ⚠️ A idempotência mora aqui: um lembrete por evento + tipo + início…
CREATE UNIQUE INDEX evento_agenda_aviso_unico ON evento_agenda_aviso (tenant_id, evento_id, tipo, inicio_evento);
-- …e no-show UMA vez por evento, mesmo que alguém reagende e ele falte de novo.
CREATE UNIQUE INDEX evento_agenda_aviso_noshow_unico ON evento_agenda_aviso (tenant_id, evento_id) WHERE tipo = 'noshow';
-- Acompanhamento do no-show (prazo de resposta) e cota diária do não-oficial por número.
CREATE INDEX evento_agenda_aviso_aguardando ON evento_agenda_aviso (criado_em) WHERE tipo = 'noshow' AND estado = 'aguardando';
CREATE INDEX evento_agenda_aviso_canal_dia ON evento_agenda_aviso (tenant_id, canal_id, concluido_em) WHERE via = 'texto';
SELECT aplicar_rls('evento_agenda_aviso');

COMMENT ON TABLE evento_agenda_aviso IS
    'C3: aviso ao cliente de uma reunião (lembrete H-24/H-2, no-show). Único por evento+tipo+início; no-show único por evento.';

CREATE TABLE reuniao_oferta (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    conversa_id   uuid        NOT NULL,
    contato_id    uuid        NOT NULL,
    canal_id      uuid        NOT NULL,
    -- [{n, usuarioId, inicio, fim, hora, data}] — o que o cliente leu, numerado a partir de 1.
    opcoes        jsonb       NOT NULL,
    ofertada_em   timestamptz NOT NULL,
    expira_em     timestamptz NOT NULL,
    confirmada_em timestamptz,
    evento_id     uuid,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, evento_id)   REFERENCES evento_agenda (tenant_id, id) ON DELETE SET NULL (evento_id),
    CONSTRAINT reuniao_oferta_opcoes_lista CHECK (jsonb_typeof(opcoes) = 'array'),
    CONSTRAINT reuniao_oferta_validade CHECK (expira_em > ofertada_em)
);
CREATE INDEX reuniao_oferta_conversa ON reuniao_oferta (tenant_id, conversa_id, ofertada_em DESC);
SELECT aplicar_rls('reuniao_oferta');

COMMENT ON TABLE reuniao_oferta IS
    'C3: horários ofertados pelo agente (modo autônomo). O "sim" só confirma oferta de turno anterior, válida e não usada.';
