-- 0080_criar_tenant.sql
--
-- Provisionamento de cliente novo pelo STAFF (a tela de "Clientes" da Plataforma).
--
-- ⚠️ Criar um tenant é a ÚNICA operação do produto que acontece fora do escopo de
--    um tenant — e não poderia ser diferente: o tenant ainda não existe, então
--    não há `tenant_atual()` para a policy comparar. A policy de `tenant` é
--    `id = tenant_atual()`, o que torna o INSERT invisível para si mesmo e
--    impossível pelo papel da aplicação.
--
--    A saída é a MESMA já usada pelo webhook (`tenant_do_canal`, 0025) e pela
--    landing pública (`lp_por_chave`, 0062): uma função SECURITY DEFINER, que
--    roda como dono, faz o mínimo necessário e devolve o mínimo necessário.
--    Preferida a dar `DATABASE_ADMIN_URL` a um handler HTTP — nenhuma rota do
--    produto usa a conexão de dono hoje, e abrir essa porta é irreversível.
--
-- ⚠️ ATENÇÃO — estas duas funções são executáveis por `geracrm_app`, ou seja,
--    por QUALQUER sessão autenticada da API. Elas NÃO checam quem chamou (não
--    têm como: a identidade vive no JWT, não no banco). Quem autoriza é o
--    guard `exigirStaff` da rota, que exige o grupo `staff` no token do Cognito.
--    Mexer nas rotas de plataforma sem esse guard expõe a base inteira de
--    clientes. Toda criação grava `auditoria`.

-- ---------------------------------------------------------------------------
-- criar_tenant — tenant + perfil_vertical, na mesma transação
-- ---------------------------------------------------------------------------
-- ⚠️ FK CIRCULAR (0003): tenant.perfil_vertical_id → perfil_vertical, e
--    perfil_vertical.tenant_id → tenant. Nenhum dos dois pode nascer sozinho.
--    A FK composta é DEFERRABLE INITIALLY DEFERRED; o SET CONSTRAINTS explícito
--    está aqui para o caso de a função ser chamada de uma transação que já tenha
--    voltado as constraints para IMMEDIATE.

CREATE OR REPLACE FUNCTION criar_tenant(
    p_nome          text,
    p_fuso          text,
    p_plano_codigo  text,
    p_modelo_codigo text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant uuid := gen_random_uuid();
    v_pv     uuid := gen_random_uuid();
    v_plano  uuid;
    v_modelo uuid;
    v_modelo_nome text;
BEGIN
    IF p_nome IS NULL OR btrim(p_nome) = '' THEN
        RAISE EXCEPTION 'nome_obrigatorio' USING ERRCODE = '22023';
    END IF;

    SELECT id INTO v_plano FROM plano WHERE codigo = p_plano_codigo;
    IF v_plano IS NULL THEN
        RAISE EXCEPTION 'plano_nao_encontrado' USING ERRCODE = 'P0002';
    END IF;

    SELECT id, nome INTO v_modelo, v_modelo_nome
      FROM perfil_vertical_modelo WHERE codigo = p_modelo_codigo;
    IF v_modelo IS NULL THEN
        RAISE EXCEPTION 'modelo_nao_encontrado' USING ERRCODE = 'P0002';
    END IF;

    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO tenant (id, nome, plano_id, perfil_vertical_id, fuso)
    VALUES (v_tenant, btrim(p_nome), v_plano, v_pv,
            coalesce(nullif(btrim(coalesce(p_fuso, '')), ''), 'America/Sao_Paulo'));

    INSERT INTO perfil_vertical (tenant_id, id, modelo_id, nome)
    VALUES (v_tenant, v_pv, v_modelo, v_modelo_nome);

    RETURN v_tenant;
END;
$$;

GRANT EXECUTE ON FUNCTION criar_tenant(text, text, text, text) TO geracrm_app;

COMMENT ON FUNCTION criar_tenant(text, text, text, text) IS
    'Provisiona cliente novo (tenant + perfil_vertical) para a tela de staff. '
    'SECURITY DEFINER porque a policy de tenant e id = tenant_atual() e o tenant '
    'ainda nao existe. NAO autoriza nada — quem autoriza e o guard exigirStaff.';

-- ---------------------------------------------------------------------------
-- listar_tenants — a lista da tela de staff
-- ---------------------------------------------------------------------------
-- Devolve só o que a tela mostra. Nada de dado de operação do cliente: para ver
-- dado de cliente existe outro caminho (PLT-05, sessão de acesso auditada), que
-- não é este.

CREATE OR REPLACE FUNCTION listar_tenants()
RETURNS TABLE (
    id        uuid,
    nome      text,
    fuso      text,
    ativo     boolean,
    criado_em timestamptz,
    plano     text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT t.id, t.nome, t.fuso, t.ativo, t.criado_em, p.codigo
      FROM tenant t
      JOIN plano p ON p.id = t.plano_id
     ORDER BY t.criado_em DESC;
$$;

GRANT EXECUTE ON FUNCTION listar_tenants() TO geracrm_app;

COMMENT ON FUNCTION listar_tenants() IS
    'Lista de clientes para a tela de staff. So metadado do tenant — nunca dado '
    'de operacao. Autorizacao e do guard exigirStaff, nao desta funcao.';
