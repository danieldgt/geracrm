-- 0051_canal_tiktok.sql
--
-- O canal genérico passa a aceitar TikTok como tipo, junto de WhatsApp e Instagram
-- (ADR-021: a porta de canal é genérica; cada rede é mais um adaptador atrás dela).
--
-- ⚠️ Aditiva e segura: alterar CHECK é drop+add, e só AMPLIA o conjunto de valores
--    permitidos — nenhuma linha existente passa a violar a restrição, então roda com
--    a versão anterior ainda atendendo. O perfil específico do TikTok
--    (perfil_tiktok, análogo a perfil_instagram) só entra quando o adaptador real
--    precisar dos campos; por ora o tipo basta para o modelo carregar o canal.

ALTER TABLE canal_conectado DROP CONSTRAINT canal_tipo_valido;
ALTER TABLE canal_conectado ADD CONSTRAINT canal_tipo_valido CHECK (tipo IN (
    'whatsapp_oficial',      -- Meta Cloud API — prioridade (ADR-002)
    'whatsapp_nao_oficial',  -- PlugZapi/Z-API e afins — opção, com risco
    'instagram',             -- Instagram Direct (Graph API)
    'tiktok'                 -- TikTok Business Messaging
));
