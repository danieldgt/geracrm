# Onboarding na Meta — WhatsApp (e depois Instagram)

> Guia do **cadastro do cliente/nós na Meta** para ligar WhatsApp Oficial (Cloud API).
> Quando alguém falar "cadastro na Meta", "verificação de negócio", "App da Meta",
> "webhook do WhatsApp" ou "número oficial", é **este** documento.
>
> Contexto técnico: modelo Tech Provider / Cloud API direto (ADR-002, ADR-003),
> Embedded Signup no onboarding (skill `geracrm-whatsapp-meta`). WhatsApp é a
> prioridade (ADR-021); Instagram reusa o mesmo webhook.

## 🟢 Valores fixos do nosso lado (usar no painel da Meta)

- **Callback URL (webhook):** `https://geracrm-api-production.up.railway.app/webhooks/meta`
- **Verify token:** `drezz_731f2e77b698ba2f6a99d6ffd6152a7667f0357e`
  - Já configurado no Railway (`META_VERIFY_TOKEN`, serviço `geracrm-api`).
  - O `GET /webhooks/meta` já responde ao handshake em produção (testado).

## Passo a passo (o que o cliente faz na Meta)

O gargalo é a **verificação de negócio** (semanas) — dispare o Passo 2 primeiro.

1. **Conta Meta Business** — [business.facebook.com](https://business.facebook.com):
   criar o *Business Portfolio* (nome, e‑mail comercial).
2. **Verificação de Negócio** ⏳ — *Configurações do Negócio → Central de Segurança →
   Verificação do negócio*. Pedem CNPJ, razão social, endereço, telefone/site que batam
   com registros públicos. **Começar AGORA** (dias a semanas).
3. **Criar o App** — [developers.facebook.com](https://developers.facebook.com) →
   *Meus Apps → Criar app → tipo "Empresa/Business"*, vinculado ao Portfolio do passo 1.
   Gera **App ID** e **App Secret**.
4. **Adicionar o produto WhatsApp** ao App → a Meta cria uma **WABA de teste** com número
   de teste + `phone_number_id` (dá para testar antes do número real).
5. **Configurar o Webhook** (produto WhatsApp → *Configuração → Webhooks*): colar a
   **Callback URL** e o **Verify token** acima; assinar o campo **`messages`** (depois
   também `message_template_status_update` e qualidade do número).
6. **App Secret → `META_APP_SECRET`** no Railway (serviço `geracrm-api`).
   ⚠️ **Segredo:** setar no painel do Railway, NUNCA digitar em formulário do produto nem
   colar em texto puro. Sem ele o `POST /webhooks/meta` recusa eventos (401), de propósito.
7. **Produção:** número real + **método de pagamento na conta Meta** (⚠️ o cliente paga a
   Meta direto; sem isso o número não envia) + concluir a verificação para sair do modo teste.

## Onde o número é cadastrado no nosso produto

Canal `WhatsApp Oficial (Meta)` em *Meus Números* (catálogo `meta_oficial`). Campos: número,
**WABA ID**, **Phone Number ID** e **token** (System User, permanente). É o **Phone Number ID**
que vira o `identificador_externo` (em claro) do canal — a chave por onde o webhook casa o evento
com o canal/tenant (a credencial é cifrada e não é pesquisável). Onboarding definitivo será por
**Embedded Signup** (não mandar o cliente ao Business Manager); este cadastro manual serve para
quem já tem os dados da WABA.

## Estado do código (o que já existe / falta)

- ✅ **Fase 1 — webhook**: `GET` verify + `POST` com assinatura HMAC (`X-Hub-Signature-256`).
  `apps/api/src/contexts/atendimento/rotas-webhook-meta.ts` + `canais/meta.ts`.
- 🚧 **Fase 3 — ingestão + envio**: mapear `phone_number_id → canal`, acender o Inbox com a
  mensagem entrante, registrar status de entrega, e enviar pela Graph API. Ver
  `canais/meta-oficial.ts` e a migration de lookup por número.
- ⬜ Instagram (Business Login), submissão de template à Meta, Embedded Signup, painel de saúde.

## Regras que não admitem exceção (skill `geracrm-whatsapp-meta`)

- Webhook: **valida assinatura → grava → outbox → responde**. Processar vai para worker.
- **2xx encerra; erro faz a Meta reenviar.** Falha permanente (401/403/404 do nosso lado ao
  processar) responde **200** e vai para o log — senão trava a fila de todos os clientes.
- **Handler idempotente** (a Meta reenvia o que demora; dedup por `id` da mensagem).
- **Janela de 24h** derivada do timestamp da última mensagem **do cliente**; fora dela, só
  template aprovado. Instagram: janela sem template e sem disparo em massa.
