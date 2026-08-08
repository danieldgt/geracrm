---
name: geracrm-whatsapp-meta
description: >
  Integrar e operar os canais da Meta no GeraCRM: WhatsApp Cloud API como Tech Provider, Embedded
  Signup, frota de números, janela de 24h, templates HSM, custo por mensagem, qualidade e tier do
  número, webhooks idempotentes e Instagram Direct. Usar sempre que mexer em envio ou recebimento
  de mensagem, template, campanha, onboarding de número, ou ao depurar entrega, custo ou bloqueio.
---

# Canais da Meta — WhatsApp e Instagram

Decisões em `docs/decisoes.md`: ADR-002 (Tech Provider), ADR-003 (só API Oficial), ADR-007 (push).
**Este é o canal por onde passa 100% da operação do cliente.** Erro aqui não é bug de tela — é
mensagem não entregue, número limitado ou conta bloqueada.

## Modelo de parceria: Tech Provider

- Cloud API **direto**, sem BSP. Enrollment no Tech Provider Program é obrigatório para ISVs.
- **Onboarding pelo Embedded Signup**, dentro do nosso produto — nunca mandar o cliente para o
  Business Manager.
- ⚠️ **O cliente paga a Meta direto.** Cadastrar o método de pagamento na conta Meta dele é **passo
  obrigatório do onboarding**. Sem isso o número não envia — e a falha precisa dizer exatamente
  isso, não "erro ao enviar".
- Registrar senders adicionais (multi-número) não repete o fluxo completo do Embedded Signup.

## Frota de números

Um número por vendedora, agrupado por filial. Cada número é um ativo caro e frágil.

O **painel de saúde** (CAN-04) lê da própria Meta e exibe: tier de mensageria · qualidade ·
status de pagamento · conta LIVE · empresa verificada.

⚠️ **Limite de envio é por número, não global** — cada um tem tier próprio. O throttling usa
contador em tabela por `numero + dia`, com `UPDATE ... RETURNING` atômico.

⚠️ **Queda de qualidade é sinal de ação, não de aviso.** Número em risco tem disparo pausado
automaticamente (CAN-06). Perder um número derruba a operação de uma vendedora inteira.

## Janela de 24 horas — a regra que molda a interface

Quando o cliente manda mensagem, abre uma janela de 24h para responder livremente. Fora dela,
**só template aprovado**.

- O estado da janela é **derivado** do timestamp da última mensagem **do cliente** — não é campo
  gravado que alguém precisa lembrar de atualizar.
- A interface mostra o estado e a contagem regressiva **sempre** (INB-04).
- ⚠️ **Fora da janela, o composer bloqueia antes do envio.** Nunca deixar digitar para falhar
  depois — e ao trocar de modo com a conversa aberta, **preservar o texto digitado** e oferecê-lo
  para o template (INB-05).
- Testes de fronteira obrigatórios: 23h e 24h. As bordas é que quebram.

## Templates (HSM)

- Criação, submissão à Meta, acompanhamento de aprovação/rejeição, e versionamento.
- Categorias — **Marketing, Utility, Authentication** — determinam preço e regra. Categoria errada
  é rejeição ou cobrança inesperada.
- Variáveis posicionais (`{{1}}`, `{{2}}`) precisam de **preview renderizado com dado real** antes
  do envio; o usuário não deve ver `{{1}}` em lugar nenhum.
- A biblioteca serve campanha **e** atendimento 1-a-1 (CMP-04).

⚠️ **Aviso de custo e risco no momento do envio** (CMP-05) — tarifa por categoria e risco de
limitação do número, com link explicativo. É decisão de UX deliberada: reduz churn por susto de
fatura e protege o número.

## Custo por mensagem

- Meta cobra **por mensagem entregue** desde jul/2025, por categoria e país do destinatário; no
  Brasil já há cobrança em reais.
- Mensagem de serviço dentro da janela de 24h é gratuita.
- ⚠️ **O cliente paga, mas nós medimos.** Gravar custo **por conversa e por campanha** — é o que
  alimenta CMP-12 (ROI da campanha) e BI-11 (ROI da ferramenta). Sem isso, o principal diferencial
  do produto não existe.

## Webhooks — regras que não admitem exceção

O gateway faz **apenas**: valida assinatura → grava evento bruto → publica no outbox → responde.
Qualquer processamento vai para worker.

- ⚠️ **O código HTTP é instrução, não relatório.** 2xx encerra; erro faz a Meta reenviar.
- ⚠️ **Falha permanente (401/403/404) responde 200 e vai para o log.** Com entrega sequencial, um
  evento que falha sempre trava a fila de **todos** os clientes.
- ⚠️ **Todo handler é idempotente.** A Meta reenvia o que demora; reprocessar sem idempotência
  duplica mensagem na tela do usuário.
- Eventos a tratar: mensagem recebida · status de entrega (enviado/entregue/lido/falha) · mudança
  de qualidade do número · aprovação/rejeição de template.

## Instagram Direct

Mesma Graph API, mesmo modelo de webhook e de janela — mas **três diferenças que mudam o produto**:

1. ⚠️ **Não faz disparo em massa.** ~200 mensagens automatizadas por hora por conta, e uma por
   usuário por gatilho. O módulo de campanha **bloqueia** a seleção de Instagram e **explica por
   quê** — não deixa o usuário descobrir com erro.
2. ⚠️ **Janela de 24h sem templates.** Fechou, acabou — não há como reabrir. Isso vira
   funcionalidade: detectar a janela fechando e sugerir migração para WhatsApp.
3. **`instagram_id` é identificador de primeira classe** no cadastro unificado, junto com telefone
   e CNPJ.

Autenticação por **Instagram Business Login** (OAuth direto, sem exigir Página do Facebook) —
a maioria das confecções tem Instagram forte e Página abandonada. Permissão
`instagram_business_manage_messages`, com App Review para escala.

## Erros comuns

| Sintoma | Causa provável |
|---|---|
| Mensagem "enviada" que não chega | Fora da janela e enviada como texto livre |
| Template rejeitado | Categoria errada ou conteúdo promocional em Utility |
| Número limitado de repente | Denúncias; qualidade caiu; disparo sem intervalo |
| Webhook reenviado em loop | Handler não idempotente ou demorando para responder |
| Fila de todos os clientes travada | Falha permanente devolvendo erro em vez de 200 |
| Custo maior que o previsto | Marketing onde caberia Utility, ou envio fora da janela |

## Testes

Meta **sempre mockada por contrato**, com fixtures reais de webhook. ⚠️ Nunca chamar a API da Meta
em teste automatizado. Cobrir: janela nas fronteiras · idempotência de webhook · falha permanente
respondendo 200 · throttling por número · registro de custo por conversa. Ver `geracrm-testes`.
