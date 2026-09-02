-- 0082_staff_sessao.sql
--
-- PLT-05 — sessão de acesso do staff ao tenant de um cliente.
--
-- Dois atos: (1) cai o único global de `cognito_sub`, cujo substituto composto
-- nasceu na 0081 e já está no ar; (2) nasce a sessão de acesso.

-- ---------------------------------------------------------------------------
-- ① O único global sai
-- ---------------------------------------------------------------------------
-- ⚠️ Só é seguro agora porque a versão da API que está atendendo JÁ usa
--    `ON CONFLICT (tenant_id, cognito_sub)` (deploy da 0081). Se as duas
--    migrations tivessem subido juntas, o código antigo teria ficado sem
--    constraint correspondente e respondido "there is no unique or exclusion
--    constraint matching the ON CONFLICT specification" em ~19 rotas de escrita.
--
--    É o que destrava o caso: a mesma pessoa em dois clientes — consultor,
--    contador, e o staff que entra no cliente por esta migration.

ALTER TABLE usuario DROP CONSTRAINT usuario_cognito_sub_key;

COMMENT ON COLUMN usuario.cognito_sub IS
    'Identificador no Cognito (ADR-006). Unico DENTRO DO TENANT (0081): a mesma '
    'pessoa pode ser usuaria de dois clientes nossos — consultor, contador, e o '
    'staff que opera dentro do cliente (PLT-05).';

-- ---------------------------------------------------------------------------
-- ② staff_sessao — o token que troca de tenant
-- ---------------------------------------------------------------------------
-- ⚠️ POR QUE TOKEN OPACO, E NÃO JWT. O contrato (§2.2) diz "emite um token
--    novo", e a leitura óbvia seria assinar um JWT. Contra isso: o projeto não
--    tem emissor próprio para copiar (`POST /v1/eventos/token` do contrato nunca
--    foi implementado) e a única biblioteca é `aws-jwt-verify`, que apenas
--    VERIFICA token do Cognito. Sobraria assinar HS256 à mão, num caminho de
--    autenticação, para ganhar o quê.
--
--    Um token opaco resolvido por SECURITY DEFINER é o padrão que este repo já
--    usa para descobrir tenant sem sessão — `tenant_do_canal` (0025) pelo
--    webhook, `lp_por_chave` (0062) pela landing. E ganha o que um JWT não dá de
--    graça: REVOGAÇÃO IMEDIATA (encerrar apaga o acesso; um JWT vale até
--    expirar), nenhuma chave de assinatura para guardar ou rotacionar, e a lista
--    de sessões abertas. O custo é uma consulta por requisição — e só o staff
--    paga.
--
-- ⚠️ Guarda o HASH, nunca o token — mesmo princípio de `token_integracao.hash`
--    (0005) e do segredo de webhook: vazar o banco não dá acesso a ninguém.
--
-- `tenant_id` é o do CLIENTE acessado, e é o que a RLS isola: cada cliente vê as
-- sessões que abriram sobre ele — o "o que a Gera3 viu deste cliente?" que o
-- índice `auditoria_staff` (0004) já esperava poder responder.

CREATE TABLE staff_sessao (
    tenant_id    uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id           uuid        NOT NULL,
    -- SHA-256 do token em claro. O token só existe na resposta da emissão.
    token_hash   text        NOT NULL,
    -- Quem entrou. ⚠️ Texto, não FK para `usuario`: na hora de abrir a sessão o
    -- staff ainda não tem linha no tenant do cliente — ela nasce na primeira
    -- escrita, por `garantirUsuarioId`.
    ator_sub     text        NOT NULL,
    ator_email   text        NOT NULL,
    motivo       text        NOT NULL,
    criada_em    timestamptz NOT NULL DEFAULT now(),
    expira_em    timestamptz NOT NULL,
    encerrada_em timestamptz,

    PRIMARY KEY (tenant_id, id)
);

SELECT aplicar_rls('staff_sessao');

-- ⚠️ Único GLOBAL, e desta vez de propósito: o token chega sem tenant nenhum e
--    precisa resolver para exatamente um. É a mesma natureza do id de canal que
--    `tenant_do_canal` traduz. Não confundir com o caso do `cognito_sub`, que
--    era identidade de PESSOA e por isso tinha de ser por tenant.
CREATE UNIQUE INDEX staff_sessao_token ON staff_sessao (token_hash);
CREATE INDEX staff_sessao_abertas ON staff_sessao (tenant_id, criada_em DESC)
    WHERE encerrada_em IS NULL;

-- ---------------------------------------------------------------------------
-- ③ A tradução token → tenant
-- ---------------------------------------------------------------------------
-- Mesma forma de `tenant_do_canal` (0025): roda como dono porque `staff_sessao`
-- tem RLS FORCE e a busca acontece ANTES de haver tenant na sessão; devolve o
-- mínimo — tenant e quem é o ator — e nada mais.
--
-- ⚠️ A expiração e o encerramento são checados AQUI, não no código: é a única
--    porta, e uma checagem esquecida na aplicação viraria sessão eterna.

CREATE OR REPLACE FUNCTION tenant_da_sessao_staff(p_token_hash text)
RETURNS TABLE (tenant_id uuid, sessao_id uuid, ator_sub text, ator_email text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT s.tenant_id, s.id, s.ator_sub, s.ator_email
      FROM staff_sessao s
     WHERE s.token_hash = p_token_hash
       AND s.encerrada_em IS NULL
       AND s.expira_em > now();
$$;

GRANT EXECUTE ON FUNCTION tenant_da_sessao_staff(text) TO geracrm_app;

COMMENT ON FUNCTION tenant_da_sessao_staff(text) IS
    'Traduz o token de sessao do staff em tenant. SECURITY DEFINER porque a busca '
    'acontece antes de haver tenant na sessao. Expiracao e encerramento sao '
    'checados aqui — e a unica porta.';
