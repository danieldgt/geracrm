-- 0117_evento_agenda.sql
--
-- AGENDA como módulo opcional (raia C2 do plano de paridade). ⚠️ ADITIVA: só tabela nova sob RLS.
-- O módulo é ligado por tenant (`tenant_modulo`, 0116); a API responde 404 quando desligado.
--
-- • `responsavel_id` é obrigatório (de quem é o compromisso); FK composta para usuario.
-- • `cor` guarda o NOME de um token da paleta (nunca hex) — o console resolve para a variável CSS.
-- • "Cancelar" é status, não DELETE: o histórico do contato continua mostrando o que foi marcado.
-- • `lembrete_enviado_em` torna o job de lembrete idempotente (UPDATE ... WHERE NULL RETURNING).
-- • `versao` é o controle otimista (PUT com versão antiga → 409).

CREATE TABLE evento_agenda (
    tenant_id           uuid        NOT NULL,
    id                  uuid        NOT NULL,
    titulo              text        NOT NULL,
    descricao           text,
    contato_id          uuid,
    responsavel_id      uuid        NOT NULL,
    inicio              timestamptz NOT NULL,
    fim                 timestamptz NOT NULL,
    tipo                text        NOT NULL DEFAULT 'reuniao',
    modalidade          text        NOT NULL DEFAULT 'presencial',
    local               text,
    link                text,
    lembrete_min        integer,
    lembrete_enviado_em timestamptz,
    cor                 text        NOT NULL DEFAULT 'acao',
    status              text        NOT NULL DEFAULT 'agendado',
    criado_por          uuid,
    criado_em           timestamptz NOT NULL DEFAULT now(),
    atualizado_em       timestamptz NOT NULL DEFAULT now(),
    versao              integer     NOT NULL DEFAULT 1,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contato_id)     REFERENCES contato (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, responsavel_id) REFERENCES usuario (tenant_id, id),
    FOREIGN KEY (tenant_id, criado_por)     REFERENCES usuario (tenant_id, id) ON DELETE SET NULL (criado_por),
    CONSTRAINT evento_agenda_titulo_curto CHECK (length(titulo) BETWEEN 1 AND 120),
    CONSTRAINT evento_agenda_periodo CHECK (fim > inicio),
    CONSTRAINT evento_agenda_tipo CHECK (tipo IN ('reuniao','ligacao','visita','outro')),
    CONSTRAINT evento_agenda_modalidade CHECK (modalidade IN ('presencial','online')),
    CONSTRAINT evento_agenda_lembrete CHECK (lembrete_min IS NULL OR lembrete_min IN (5,15,30,60,1440)),
    CONSTRAINT evento_agenda_cor CHECK (cor IN ('acao','sucesso','atencao','erro','ia','neutro')),
    CONSTRAINT evento_agenda_status CHECK (status IN ('agendado','realizado','nao_compareceu','cancelado'))
);

-- Janela de calendário por responsável e a conferência de conflito.
CREATE INDEX evento_agenda_responsavel ON evento_agenda (tenant_id, responsavel_id, inicio);
-- Eventos do contato (ficha e "sem próximo passo").
CREATE INDEX evento_agenda_contato ON evento_agenda (tenant_id, contato_id, inicio) WHERE contato_id IS NOT NULL;
-- Varredura de lembretes: só os agendados que ainda não avisaram.
CREATE INDEX evento_agenda_lembrar ON evento_agenda (inicio) WHERE status = 'agendado' AND lembrete_min IS NOT NULL AND lembrete_enviado_em IS NULL;
SELECT aplicar_rls('evento_agenda');

COMMENT ON TABLE evento_agenda IS 'Compromisso do módulo Agenda (opcional por tenant). Cancelar = status, nunca DELETE.';
COMMENT ON COLUMN evento_agenda.cor IS 'Nome de token da paleta (acao|sucesso|atencao|erro|ia|neutro), nunca hex.';
COMMENT ON COLUMN evento_agenda.lembrete_enviado_em IS 'Quando o aviso do sino foi criado; NULL = ainda não avisou (idempotência do job).';
