-- Estado "Aguardando nós" no kanban de atendimentos (além de "Aguardando cliente").
--
-- Distinção que o gestor precisa: "aguardando cliente" = respondemos, a bola
-- está com ele; "aguardando nós" = o cliente respondeu, a bola está com a gente
-- (é o que não pode esfriar). É uma etapa configurável como as outras.
--
-- ⚠️ Aditiva: só INSERT. Adiciona a etapa a quem já usa o fluxo padrão (tem a
--    etapa 'em_atendimento') e ainda não tem 'aguardando_nos'. Tenants que
--    customizaram o fluxo não são forçados. A `chave` é estável (a config só
--    muda nome/ordem/ativo/tipo), então o marcador é confiável.
INSERT INTO atendimento_etapa (tenant_id, id, ordem, chave, nome, tipo)
SELECT t.id, gen_random_uuid(), 3, 'aguardando_nos', 'Aguardando nós', 'atendimento'
  FROM tenant t
 WHERE EXISTS (SELECT 1 FROM atendimento_etapa e
                WHERE e.tenant_id = t.id AND e.chave = 'em_atendimento')
   AND NOT EXISTS (SELECT 1 FROM atendimento_etapa e
                    WHERE e.tenant_id = t.id AND e.chave = 'aguardando_nos');
