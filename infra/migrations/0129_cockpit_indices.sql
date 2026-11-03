-- 0129_cockpit_indices.sql
--
-- Cockpit do gestor (raia D1). ADITIVA: só índices novos; a versão anterior da API continua
-- atendendo durante a migration.
--
-- O cockpit recorta por ESTADO e por TEMPO (nunca varre a tabela inteira):
--   - "SLA estourado hoje"     → atendimentos cujo prazo caiu na janela do dia;
--   - "reuniões / no-shows hoje" → eventos da agenda na janela do dia;
--   - "aguardando humano"       → conversas cujo último a falar foi o cliente (a fila derivada);
--   - "esquecidos"              → contatos qualificados (a outra metade vem de oportunidade aberta,
--                                 que já tem índice único parcial).

-- Prazo do SLA com prefixo de tenant (o índice atendimento_sla_pendente é global e só dos pendentes).
CREATE INDEX IF NOT EXISTS atendimento_sla_vence_por_tenant ON atendimento (tenant_id, sla_vence_em)
    WHERE sla_vence_em IS NOT NULL;

-- Eventos por dia, de qualquer responsável (evento_agenda_responsavel exige o responsável).
CREATE INDEX IF NOT EXISTS evento_agenda_por_inicio ON evento_agenda (tenant_id, inicio)
    WHERE status <> 'cancelado';

-- A fila derivada: o cliente falou por último e a conversa está viva.
CREATE INDEX IF NOT EXISTS conversa_cliente_por_ultimo ON conversa (tenant_id, ultima_mensagem_em DESC)
    WHERE ultima_direcao = 'entrante' AND NOT arquivada;

-- Contatos qualificados ativos (o conjunto "em funil" de leads que não têm oportunidade aberta).
CREATE INDEX IF NOT EXISTS contato_qualificado_ativo ON contato (tenant_id, id)
    WHERE ativo AND qualificado;
