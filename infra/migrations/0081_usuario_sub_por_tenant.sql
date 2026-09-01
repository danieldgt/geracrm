-- 0081_usuario_sub_por_tenant.sql
--
-- Primeiro de DOIS passos para tornar `usuario.cognito_sub` único POR TENANT.
-- Este é aditivo de propósito; o `DROP` do único global vem na migration
-- seguinte, junto com o código que já não depende dele.
--
-- ⚠️ POR QUE MUDAR — o schema se contradiz hoje. Em 0005_usuario.sql:
--
--     cognito_sub text UNIQUE          -- "único GLOBALMENTE ... uma pessoa só"
--     ...
--     CONSTRAINT usuario_email_unico_no_tenant UNIQUE (tenant_id, email)
--                                      -- "a mesma pessoa pode ser usuária de
--                                      --  dois clientes nossos (consultor,
--                                      --  contador, staff de revenda)"
--
--    O e-mail já foi modelado para a mesma pessoa existir em dois clientes. O
--    `cognito_sub` global impede exatamente isso — e é o mesmo ser humano nas
--    duas frases. Não é decisão, é descuido: `garantirUsuarioId()` faz
--    `ON CONFLICT (cognito_sub) DO UPDATE ... RETURNING id`; com o único global,
--    a segunda empresa cai no UPDATE de uma linha de OUTRO tenant, o RLS FORCE
--    recusa, o RETURNING volta vazio e a rota estoura em 500. O comentário do
--    próprio `garantirUsuarioId` já descreve esse mecanismo — só concluía que
--    "em produção o sub é único por usuário", o que deixa de valer no minuto em
--    que o staff opera dentro do cliente (PLT-05).
--
-- ⚠️ POR QUE EM DOIS PASSOS — a migration roda com a versão ANTERIOR do código
--    ainda atendendo. Se o único global caísse agora, todo `ON CONFLICT
--    (cognito_sub)` da versão no ar passaria a responder "there is no unique or
--    exclusion constraint matching the ON CONFLICT specification": a API inteira
--    cairia até o deploy terminar. Aqui só ACRESCENTAMOS a chave composta; as
--    duas convivem, e nenhuma escrita existente muda de comportamento.
--
--    Convivência: enquanto o global existir, a mesma pessoa AINDA não pode estar
--    em dois tenants. Isso é esperado — quem destrava é a 0082.

ALTER TABLE usuario
    ADD CONSTRAINT usuario_sub_unico_no_tenant UNIQUE (tenant_id, cognito_sub);

COMMENT ON CONSTRAINT usuario_sub_unico_no_tenant ON usuario IS
    'Identidade do Cognito dentro do tenant (ADR-016). Substitui o unico global '
    'usuario_cognito_sub_key, removido na 0082 — a mesma pessoa pode ser usuaria '
    'de dois clientes (consultor, contador, staff).';
