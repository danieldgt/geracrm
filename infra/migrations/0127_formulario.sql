-- 0127_formulario.sql
--
-- FORMULÁRIOS PÚBLICOS (plano de paridade, raia F3 — #72). O gestor monta um formulário (campos,
-- condicionais, destino no funil), publica um link e quem preenche vira contato (ou é mesclado ao
-- existente pelo telefone).
--
-- ⚠️ Aditiva: só tabelas e função novas. A versão anterior ignora.
--
-- ⚠️ O slug é por tenant (`UNIQUE(tenant_id, slug)`, ADR-001), mas a URL pública não pode carregar o
--    tenant nem deixá-lo adivinhável: ela carrega `chave_publica`, única GLOBAL e aleatória (mesmo
--    desenho da `chave` da LP, 0062), resolvida por `formulario_por_chave()` SECURITY DEFINER que
--    devolve só o mínimo para rotear.
--
-- ⚠️ EDITADA NO LUGAR (2026-11-03, revisão de segurança da F3) — antes de ir para produção, por isso não
--    virou migration nova. Banco de desenvolvimento que já a aplicou precisa ser recriado (o runner recusa
--    hash alterado). Mudanças: formulário nasce INATIVO; `consentimento_marketing`; resposta de telefone já
--    cadastrado fica `verificacao='pendente'` com anexos na RESPOSTA (`formulario_resposta_anexo`), nunca na
--    ficha; consentimento ganha `formulario_resposta_id`; a função SECURITY DEFINER perdeu o EXECUTE de PUBLIC
--    e fixou `search_path = public, pg_temp`.

CREATE TABLE formulario (
    tenant_id             uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id                    uuid        NOT NULL,
    nome                  text        NOT NULL,
    slug                  text        NOT NULL,
    chave_publica         text        NOT NULL,
    titulo                text        NOT NULL,
    descricao             text,
    tipo                  text        NOT NULL DEFAULT 'cadastro',
    filial_id             uuid,
    etapa_destino_id      uuid,
    responsavel_padrao_id uuid,
    origem_id             uuid,
    cor                   text        NOT NULL DEFAULT 'acao',
    texto_botao           text        NOT NULL DEFAULT 'Enviar',
    mensagem_sucesso      text        NOT NULL DEFAULT 'Recebemos suas informações. Obrigado!',
    -- ⚠️ Nasce INATIVO: só publica depois de ter o campo telefone (a API recusa ativar sem ele, 422).
    ativo                 boolean     NOT NULL DEFAULT false,
    -- LGPD: o texto exibido pede EXPLICITAMENTE consentimento de marketing? Só então o contato criado
    -- nasce com `recebe_campanhas = true`. Padrão false.
    consentimento_marketing boolean   NOT NULL DEFAULT false,
    -- Hash (sha256 hex) do token de integração; o valor em claro é mostrado UMA vez ao gerar.
    token_hash            text,
    criado_em             timestamptz NOT NULL DEFAULT now(),
    atualizado_em         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT formulario_slug_unico UNIQUE (tenant_id, slug),
    CONSTRAINT formulario_chave_unica UNIQUE (chave_publica),
    FOREIGN KEY (tenant_id, filial_id)             REFERENCES filial (tenant_id, id)       ON DELETE SET NULL (filial_id),
    FOREIGN KEY (tenant_id, etapa_destino_id)      REFERENCES funil_etapa (tenant_id, id)  ON DELETE SET NULL (etapa_destino_id),
    FOREIGN KEY (tenant_id, responsavel_padrao_id) REFERENCES usuario (tenant_id, id)      ON DELETE SET NULL (responsavel_padrao_id),
    FOREIGN KEY (tenant_id, origem_id)             REFERENCES origem (tenant_id, id)       ON DELETE SET NULL (origem_id),
    CONSTRAINT formulario_nome   CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120),
    CONSTRAINT formulario_titulo CHECK (char_length(btrim(titulo)) BETWEEN 1 AND 160),
    CONSTRAINT formulario_slug   CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 80),
    CONSTRAINT formulario_chave  CHECK (chave_publica ~ '^[a-z0-9]{16,40}$'),
    CONSTRAINT formulario_tipo   CHECK (tipo IN ('cadastro','qualificacao','documentacao','pos_venda','outro')),
    CONSTRAINT formulario_cor    CHECK (cor IN ('acao','sucesso','atencao','erro','ia','neutro')),
    CONSTRAINT formulario_botao  CHECK (char_length(btrim(texto_botao)) BETWEEN 1 AND 40),
    CONSTRAINT formulario_descricao CHECK (descricao IS NULL OR char_length(descricao) <= 1000),
    CONSTRAINT formulario_sucesso CHECK (char_length(mensagem_sucesso) BETWEEN 1 AND 500)
);
CREATE INDEX formulario_por_criacao ON formulario (tenant_id, criado_em DESC, id DESC);
SELECT aplicar_rls('formulario');

CREATE TABLE formulario_campo (
    tenant_id     uuid    NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    formulario_id uuid    NOT NULL,
    id            uuid    NOT NULL,
    ordem         integer NOT NULL,
    tipo          text    NOT NULL,
    rotulo        text    NOT NULL,
    placeholder   text,
    obrigatorio   boolean NOT NULL DEFAULT false,
    -- selecao/escolha_unica/multipla/selecao_condicional: lista de textos.
    opcoes        jsonb   NOT NULL DEFAULT '[]'::jsonb,
    -- selecao_condicional: { "<opção>": ["<id de campo>", ...] } — campos exibidos quando a opção é escolhida.
    condicoes     jsonb   NOT NULL DEFAULT '{}'::jsonb,
    -- No máximo um por formulário: o valor dele é o NOME do contato criado.
    referencia    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id, formulario_id, id),
    FOREIGN KEY (tenant_id, formulario_id) REFERENCES formulario (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT formulario_campo_tipo CHECK (tipo IN ('texto','texto_longo','numero','moeda','data','telefone','email',
        'cpf','cnpj','selecao','selecao_condicional','escolha_unica','multipla','anexo')),
    CONSTRAINT formulario_campo_rotulo CHECK (char_length(btrim(rotulo)) BETWEEN 1 AND 160),
    CONSTRAINT formulario_campo_ordem CHECK (ordem BETWEEN 0 AND 999),
    CONSTRAINT formulario_campo_opcoes CHECK (jsonb_typeof(opcoes) = 'array' AND jsonb_array_length(opcoes) <= 100),
    CONSTRAINT formulario_campo_condicoes CHECK (jsonb_typeof(condicoes) = 'object')
);
CREATE UNIQUE INDEX formulario_campo_ordem_unica ON formulario_campo (tenant_id, formulario_id, ordem);
CREATE UNIQUE INDEX formulario_campo_referencia_unica ON formulario_campo (tenant_id, formulario_id) WHERE referencia;
SELECT aplicar_rls('formulario_campo');

CREATE TABLE formulario_resposta (
    tenant_id          uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id                 uuid        NOT NULL,
    formulario_id      uuid        NOT NULL,
    contato_id         uuid,
    -- { "<id do campo>": valor } — texto, número, lista; anexo guarda { arquivoId, nome }.
    respostas          jsonb       NOT NULL,
    -- HMAC-SHA256 do IP com segredo do servidor (FORMULARIO_IP_SEGREDO): sinal de abuso sem guardar o IP em
    -- claro (LGPD) e sem permitir reverter por força bruta do espaço IPv4.
    ip_hash            text,
    -- ⚠️ O texto do aviso EXIBIDO, congelado: o consentimento vale para o que a pessoa leu.
    consentimento_texto text,
    contato_novo       boolean     NOT NULL DEFAULT true,
    -- ⚠️ Quem preenche é ANÔNIMO. Telefone já cadastrado não prova que é o dono do cadastro: a resposta fica
    --    'pendente' e NADA do contato muda até um gestor aplicar ('aplicada'). Contato novo: 'nao_se_aplica'.
    verificacao        text        NOT NULL DEFAULT 'nao_se_aplica',
    aplicada_em        timestamptz,
    aplicada_por       uuid,
    criado_em          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, formulario_id) REFERENCES formulario (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contato_id)    REFERENCES contato (tenant_id, id) ON DELETE SET NULL (contato_id),
    FOREIGN KEY (tenant_id, aplicada_por)  REFERENCES usuario (tenant_id, id) ON DELETE SET NULL (aplicada_por),
    CONSTRAINT formulario_resposta_verificacao CHECK (verificacao IN ('nao_se_aplica', 'pendente', 'aplicada'))
);
CREATE INDEX formulario_resposta_por_form ON formulario_resposta (tenant_id, formulario_id, criado_em DESC, id DESC);
-- O feed do contato lê as respostas dele (ramo `formulario` em contato-feed.ts).
CREATE INDEX formulario_resposta_por_contato ON formulario_resposta (tenant_id, contato_id, criado_em DESC, id DESC)
    WHERE contato_id IS NOT NULL;
SELECT aplicar_rls('formulario_resposta');

-- Anexo de resposta ainda NÃO verificada (telefone já cadastrado): fica preso à resposta, não à ficha.
-- "Aplicar ao contato" move a linha para `contato_arquivo` com o MESMO id e a mesma chave do bucket.
CREATE TABLE formulario_resposta_anexo (
    tenant_id      uuid        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    id             uuid        NOT NULL,
    resposta_id    uuid        NOT NULL,
    campo_id       uuid        NOT NULL,
    nome           text        NOT NULL,
    tipo_mime      text        NOT NULL,
    tamanho_bytes  bigint      NOT NULL,
    chave_bucket   text        NOT NULL,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, resposta_id) REFERENCES formulario_resposta (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT formulario_resposta_anexo_tamanho CHECK (tamanho_bytes BETWEEN 1 AND 15728640),
    CONSTRAINT formulario_resposta_anexo_nome    CHECK (char_length(btrim(nome)) BETWEEN 1 AND 200),
    CONSTRAINT formulario_resposta_anexo_chave   CHECK (chave_bucket LIKE 'tenant/' || tenant_id::text || '/%')
);
CREATE INDEX formulario_resposta_anexo_por_resposta ON formulario_resposta_anexo (tenant_id, resposta_id);
SELECT aplicar_rls('formulario_resposta_anexo');

-- LGPD: o consentimento dado num formulário aponta para a resposta que o registrou (texto congelado lá).
ALTER TABLE consentimento_contato ADD COLUMN formulario_resposta_id uuid;

-- Roteamento do formulário PÚBLICO (sem sessão). SECURITY DEFINER porque `formulario` tem RLS FORCE.
-- ⚠️ Devolve só o mínimo para rotear — o conteúdo é lido depois, sob RLS, com o tenant estabelecido.
CREATE OR REPLACE FUNCTION formulario_por_chave(p_chave text)
RETURNS TABLE (tenant_id uuid, formulario_id uuid, ativo boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT tenant_id, id AS formulario_id, ativo
      FROM formulario
     WHERE chave_publica = p_chave
     LIMIT 1;
$$;
-- ⚠️ Função nasce executável por PUBLIC no Postgres: revoga e concede só ao papel da aplicação.
REVOKE EXECUTE ON FUNCTION formulario_por_chave(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION formulario_por_chave(text) TO geracrm_app;

COMMENT ON TABLE formulario IS
    'Formulário público (F3). ⚠️ `chave_publica` é única GLOBAL e resolve o tenant sem token (como midia_lp.chave).';
COMMENT ON FUNCTION formulario_por_chave(text) IS
    '⚠️ Roteamento do formulário público por chave (sem sessão). SECURITY DEFINER (RLS FORCE). Devolve só tenant/id/ativo.';
