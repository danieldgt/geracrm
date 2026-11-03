-- 0114_tarefa_v2.sql
--
-- Tarefas v2 (raia C1 do plano de paridade). ⚠️ ADITIVA: a versão anterior da API continua
-- atendendo durante a migration — só entram colunas novas com DEFAULT/NULL e um índice.
--
-- `descricao` e `responsavel_id` JÁ existem desde a 0039 (FK composta para usuario, ON DELETE SET NULL),
-- então não são recriadas. Semântica de `responsavel_id`: NULL = "de ninguém", aparece para todos
-- (tarefa de automação sem dono de carteira); a API grava quem criou quando o corpo não traz responsável.
--
-- Novas: tipo (ligação, whatsapp…), resultado (texto livre ao concluir) e concluida_por (quem concluiu).

ALTER TABLE tarefa
    ADD COLUMN tipo          text NOT NULL DEFAULT 'outro',
    ADD COLUMN resultado     text,
    ADD COLUMN concluida_por uuid;

ALTER TABLE tarefa
    ADD CONSTRAINT tarefa_tipo_valido
        CHECK (tipo IN ('ligacao','whatsapp','reuniao','email','visita','outro')),
    ADD CONSTRAINT tarefa_concluida_por_fk
        FOREIGN KEY (tenant_id, concluida_por) REFERENCES usuario (tenant_id, id) ON DELETE SET NULL (concluida_por);

-- Leitura quente da tela: "abertas por responsável e vencimento".
CREATE INDEX tarefa_abertas_responsavel ON tarefa (tenant_id, responsavel_id, vence_em)
    WHERE estado = 'aberta';

COMMENT ON COLUMN tarefa.tipo IS 'ligacao | whatsapp | reuniao | email | visita | outro (padrão).';
COMMENT ON COLUMN tarefa.resultado IS 'O que aconteceu, preenchido ao concluir (opcional).';
COMMENT ON COLUMN tarefa.concluida_por IS 'Usuário que concluiu; NULL = sistema ou usuário removido.';
COMMENT ON COLUMN tarefa.responsavel_id IS
    'Quem executa. NULL = de ninguém (aparece para todos); a API grava o criador por padrão.';
