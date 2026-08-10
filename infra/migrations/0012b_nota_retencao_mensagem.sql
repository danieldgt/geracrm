-- 0012b_nota_retencao_mensagem.sql
--
-- Só documentação — mas documentação de uma armadilha que já apareceu.
--
-- ⚠️ A FK de `midia` para `mensagem` depende de CADA PARTIÇÃO individualmente.
--
--    A consequência aparece na retenção, daqui a dois anos, quando alguém for
--    apagar as mensagens antigas:
--
--      DROP TABLE mensagem_2026_08;
--      ERROR: cannot drop desired object(s) because other objects depend on them
--      HINT:  Use DROP ... CASCADE to drop the dependent objects too.
--
--    Seguir o HINT do Postgres é o desastre: o CASCADE apaga a restrição de
--    integridade de `midia` INTEIRA — não só da partição —, e a partir daí
--    qualquer mídia pode apontar para mensagem que não existe. Nada falha na
--    hora; o banco só para de recusar lixo, silenciosamente.
--
--    A ordem correta:
--      ALTER TABLE mensagem DETACH PARTITION mensagem_2026_08;
--      DROP TABLE mensagem_2026_08;
--
--    Registrado no próprio banco porque é lá que a pessoa vai estar quando o
--    erro aparecer — e o HINT que ela vai ler sugere exatamente o caminho errado.

COMMENT ON CONSTRAINT midia_tenant_id_mensagem_criado_em_mensagem_id_fkey ON midia IS
    '⚠️ Depende de CADA partição de mensagem. Retenção exige DETACH antes do DROP: '
    'o DROP direto falha e o DROP … CASCADE sugerido pelo HINT do Postgres apaga a '
    'integridade referencial de midia inteira, sem aviso. Ordem correta: '
    'ALTER TABLE mensagem DETACH PARTITION x; DROP TABLE x;';
