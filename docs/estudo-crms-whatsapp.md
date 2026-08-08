# Estudo de funcionalidades — CRMs de atendimento + WhatsApp + comunicação em massa (Brasil)

> Documento base do GeraCRM. Objetivo: mapear **todas** as funcionalidades que os players de maior sucesso no Brasil entregam, para definir o escopo do nosso produto.
> Status: **v1 — pesquisa de mercado (sem as telas do cliente ainda)**. As imagens do sistema de referência devem ser colocadas em `docs/referencias/telas/`.

---

## 1. Mapa do mercado

O mercado brasileiro se divide em **quatro categorias** que se sobrepõem. Entender em qual o GeraCRM joga é a primeira decisão de produto.

| Categoria | O que resolve | Players |
|---|---|---|
| **A. CRM de vendas clássico** | Funil, oportunidades, metas, previsão | RD Station CRM, Ploomes, Agendor, Pipedrive, Bitrix24, HubSpot, Nectar, Meets |
| **B. Multiatendimento / caixa de entrada compartilhada** | Vários atendentes num número, filas, setores | Digisac, ChatGuru, Poli Digital, Tallos, Umbler Talk, SocialHub, MegaZap, CPChat |
| **C. Help desk / CX omnichannel** | Tickets, SLA, base de conhecimento, CSAT | Octadesk, Movidesk, Zendesk, Freshdesk, Huggy |
| **D. CPaaS / plataforma de bots e campanhas** | API oficial, chatbots complexos, disparo em escala | Take Blip, Zenvia, Twilio, Infobip, 360dialog, Gupshup |
| **E. Open source / white-label** | Base técnica para montar o próprio | Chatwoot, Whaticket / PressTicket, Evolution API, Typebot, n8n |

**Onde está o dinheiro no Brasil:** o produto que mais vende hoje é o **híbrido B+A** — inbox multiatendente com WhatsApp + funil Kanban + chatbot + disparo em massa, vendido por assinatura mensal por atendente/conexão (R$ 99–R$ 500/mês nas PMEs). É exatamente o espaço do Kommo, Digisac, ChatGuru, Poli e SocialHub.

**Recomendação de posicionamento para o GeraCRM:** núcleo B+A, com D (campanhas) como diferencial monetizável, e C (SLA/CSAT) como camada opcional para clientes maiores.

---

## 2. Catálogo de funcionalidades por módulo

Legenda de prioridade sugerida: **[P0]** = sem isso não é produto · **[P1]** = esperado pelo mercado · **[P2]** = diferencial/upsell.

### 2.1 Canais e conectividade

- **[P0]** WhatsApp via **API Oficial (Cloud API da Meta)** — múltiplos números, sem risco de banimento, templates aprovados.
- **[P0]** WhatsApp via **API não oficial (Baileys / WhatsApp Web)** — conexão por QR Code. É o que a maioria dos concorrentes brasileiros usa nos planos de entrada (Evolution API é o padrão de fato). Risco de bloqueio, mas custo zero por mensagem.
- **[P1]** Múltiplas conexões/números por conta, com identificação visual de origem.
- **[P1]** Instagram Direct, Facebook Messenger, Telegram, Webchat (widget no site), E-mail.
- **[P2]** SMS, voz/VoIP (discador), Mercado Livre, chat de marketplaces.
- **[P1]** Painel de status das conexões (online/offline/desconectado), reconexão automática, alerta quando cai.
- **[P0]** Onboarding do número: Embedded Signup da Meta (oficial) ou leitura de QR (não oficial).
- **[P1]** Verificação de perfil de negócios, foto, descrição, catálogo.

### 2.2 Inbox / multiatendimento (o coração do produto)

- **[P0]** Caixa de entrada unificada: todos os canais na mesma tela, lista de conversas + janela de chat + painel do contato (layout de 3 colunas — padrão em 100% dos concorrentes).
- **[P0]** Vários atendentes no **mesmo número**, cada um vendo só o que lhe cabe.
- **[P0]** Envio/recebimento de texto, imagem, vídeo, documento, **áudio (PTT)**, localização, contato, sticker.
- **[P1]** Gravação de áudio direto no navegador; **transcrição de áudio em texto** (IA) — hoje é quase obrigatório no Brasil.
- **[P1]** Responder mensagem específica (reply/quote), encaminhar, apagar para todos, reagir com emoji.
- **[P1]** Indicadores de entrega/leitura (✓✓), digitando…, gravando áudio.
- **[P0]** **Respostas rápidas / atalhos** (`/atalho`) com variáveis ({{nome}}, {{protocolo}}).
- **[P1]** Notas internas (comentário privado na conversa, invisível ao cliente) e **menção a colega** (@fulano).
- **[P1]** Transferência de conversa entre atendentes e entre setores, com motivo.
- **[P1]** Tags/etiquetas coloridas na conversa e no contato.
- **[P1]** Busca dentro da conversa e busca global por mensagem/contato/protocolo.
- **[P1]** Histórico completo e permanente, mesmo após encerramento e reabertura.
- **[P1]** Encerrar/resolver atendimento; reabertura automática se o cliente volta a falar.
- **[P1]** **Aviso de conversa já aberta por outro atendente** (bloqueio de colisão) — dor real em operação.
- **[P2]** Agendamento de mensagem para envio futuro.
- **[P2]** Envio de enquetes, listas e **botões interativos** (API oficial).
- **[P2]** Assinatura do atendente automática no início da mensagem.
- **[P2]** Tradução automática de mensagens.

### 2.3 Filas, distribuição e SLA

- **[P0]** Setores/departamentos (Comercial, Suporte, Financeiro) com atendentes vinculados.
- **[P0]** Fila de espera com pendentes/em atendimento/resolvidos.
- **[P1]** Distribuição automática: rodízio (round-robin), por menor carga, aleatória, manual (o atendente "puxa").
- **[P1]** Limite de conversas simultâneas por atendente.
- **[P1]** Horário de atendimento por setor, feriados, mensagem fora do expediente.
- **[P1]** Timeout de inatividade: encerrar ou devolver à fila após X minutos sem resposta.
- **[P1]** Status do atendente (disponível / pausa / almoço) e redistribuição de conversas ao sair.
- **[P2]** SLA de primeira resposta e de resolução, com alerta de estouro.
- **[P2]** Escalonamento automático para supervisor.
- **[P2]** Protocolo de atendimento numerado.

### 2.4 Contatos e base de clientes (CRM)

- **[P0]** Cadastro de contato: nome, telefone, e-mail, foto, empresa, origem.
- **[P0]** **Campos personalizados** (texto, número, data, lista, moeda) — presente em todos os concorrentes sérios.
- **[P1]** Empresas/organizações com contatos vinculados.
- **[P1]** Importação CSV/Excel com mapeamento de colunas; exportação.
- **[P1]** Segmentação por tags, campos, origem, última interação.
- **[P1]** Deduplicação e mesclagem de contatos.
- **[P1]** Timeline única do cliente: mensagens, negócios, tarefas, notas, campanhas recebidas.
- **[P2]** Carteirização (contato pertence a um vendedor).
- **[P2]** Enriquecimento por CNPJ/CPF, consulta de dados públicos.
- **[P2]** LGPD: consentimento (opt-in/opt-out), anonimização, exclusão sob pedido.

### 2.5 Funil de vendas / pipeline

- **[P0]** **Kanban de negócios** arrastável, múltiplos funis (comercial, pós-venda, cobrança).
- **[P0]** Etapas configuráveis por funil, com cor e ordem.
- **[P0]** Negócio/oportunidade: valor, produto, responsável, previsão de fechamento, probabilidade.
- **[P1]** **Criar negócio direto da conversa** e ver a conversa dentro do negócio (é o principal argumento de venda do Kommo).
- **[P1]** Motivo de perda obrigatório e catálogo de motivos.
- **[P1]** Automações por etapa ("ao entrar em Proposta, envia template X e cria tarefa").
- **[P1]** Tarefas e follow-ups com lembrete, agenda do vendedor.
- **[P2]** Metas por vendedor/equipe e acompanhamento.
- **[P2]** Produtos/catálogo, orçamento/proposta em PDF, assinatura eletrônica (forte no Ploomes).
- **[P2]** Ciclo de vida do lead / lead scoring.

### 2.6 Chatbot, fluxos e automação

- **[P0]** Bot de menu (URA de texto): "1 - Comercial, 2 - Suporte", encaminhando para setor.
- **[P0]** Mensagem de saudação, ausência e de espera.
- **[P1]** **Construtor de fluxo visual (drag-and-drop)** com nós: mensagem, pergunta, condição, espera, tag, transferir humano, HTTP request, salvar variável. Referências: Salesbot (Kommo), Blip Builder, Typebot, Huggy.
- **[P1]** Variáveis e memória do contato dentro do fluxo.
- **[P1]** Condições/ramificações por resposta, tag, campo, horário.
- **[P1]** Chamada de API externa dentro do fluxo (consultar pedido, CEP, boleto).
- **[P1]** Gatilhos: primeira mensagem, palavra-chave, entrada em etapa do funil, webhook, agendamento, campo alterado.
- **[P2]** Testes A/B de fluxo, versionamento, simulador/preview do bot.
- **[P2]** Automação "se cliente não responde em X horas → follow-up automático".

### 2.7 Inteligência artificial (hoje é diferencial competitivo obrigatório)

- **[P1]** **Agente de IA** que atende sozinho com base numa base de conhecimento (RAG sobre documentos/site do cliente) e transfere para humano quando não sabe. É o WOZ do Octadesk, o agente do GigaWhats, o AI Agent do Kommo.
- **[P1]** Transcrição de áudio.
- **[P1]** Resumo da conversa para quem assume no meio.
- **[P1]** Sugestão de resposta ao atendente (copiloto), correção de tom e ortografia.
- **[P2]** Classificação automática: intenção, sentimento, motivo de contato.
- **[P2]** Qualificação automática de lead e preenchimento de campos pela IA.
- **[P2]** Geração de texto de campanha.

### 2.8 Campanhas e comunicação em massa

Módulo mais monetizável e o mais sensível tecnicamente.

- **[P0]** Criação de campanha: público-alvo (segmento/tag/filtro/CSV importado), mensagem, canal, agendamento.
- **[P0]** **Personalização com variáveis** ({{nome}}, {{primeiro_nome}}, campos custom).
- **[P0]** **Templates HSM** da API oficial: criação, submissão à Meta, acompanhamento de aprovação/rejeição, categorias (Marketing / Utility / Authentication), header, body, footer, botões (URL, ligar, resposta rápida).
- **[P1]** **Anti-ban / envio seguro** (essencial na API não oficial): intervalo aleatório entre envios, limite diário, aquecimento gradual do número, rotação entre vários números, pausas, variação de texto (spintax).
- **[P1]** Envio com mídia (imagem, PDF, vídeo, áudio).
- **[P1]** Fila de disparo com pausa/retomada/cancelamento e progresso em tempo real.
- **[P1]** Relatório da campanha: enviados, entregues, lidos, respondidos, falhas, opt-outs, custo.
- **[P1]** **Respostas da campanha caem no inbox** e podem abrir negócio no funil — é o que separa "ferramenta de disparo" de CRM de verdade.
- **[P1]** Lista de bloqueio / opt-out automático ("não quero mais receber") e respeito obrigatório.
- **[P2]** Campanhas recorrentes e réguas de relacionamento (drip/cadência multi-etapas).
- **[P2]** Gatilhos transacionais: carrinho abandonado, boleto a vencer, pós-venda, NPS, aniversário.
- **[P2]** Teste A/B de mensagem, janela de melhor horário.
- **[P2]** Campanhas por e-mail e SMS no mesmo builder.
- **[P2]** Simulador de custo antes do disparo (categoria × país × volume).

### 2.9 Relatórios e BI

- **[P1]** Dashboard operacional: conversas por status, fila atual, tempo médio de primeira resposta, TMA, taxa de resolução.
- **[P1]** Produtividade por atendente e por setor; ranking.
- **[P1]** Curva por hora/dia da semana (dimensionamento de equipe).
- **[P1]** Relatório de funil: conversão por etapa, valor em aberto, ciclo médio de venda, motivos de perda.
- **[P1]** Exportação CSV/PDF; agendamento de envio por e-mail.
- **[P2]** **CSAT / NPS** disparado ao encerrar o atendimento, com relatório.
- **[P2]** Monitoramento ao vivo (supervisor vê conversas em andamento).
- **[P2]** Auditoria: quem enviou, quem apagou, quem transferiu.

### 2.10 Administração, times e segurança

- **[P0]** Usuários, perfis e permissões (admin, supervisor, atendente) por módulo e por ação.
- **[P1]** **Multiempresa / multi-tenant** — indispensável se o GeraCRM for vendido a agências e revendas.
- **[P1]** White-label: logo, cores, domínio próprio, e-mail de remetente.
- **[P1]** Planos, limites (atendentes, conexões, disparos/mês) e billing/assinatura.
- **[P1]** Log de auditoria e sessões ativas.
- **[P2]** SSO, 2FA, IP allowlist.
- **[P2]** Painel de revenda com subcontas e comissionamento.

### 2.11 Integrações

- **[P0]** **API REST pública + Webhooks** de eventos (mensagem recebida, negócio mudou de etapa, campanha finalizada).
- **[P1]** n8n / Make / Zapier / Pluga.
- **[P1]** ERPs e e-commerce nacionais: Bling, Tiny, Omie, Nuvemshop, Shopify, WooCommerce.
- **[P1]** Pagamentos: Asaas, PagBank, Mercado Pago, Stripe — cobrança pelo chat.
- **[P1]** Google Calendar / agenda, Google Sheets.
- **[P2]** RD Station Marketing, Meta Ads (lead ads → funil), Hotmart/Kiwify.
- **[P2]** Nota fiscal, assinatura eletrônica.

### 2.12 Mobile e experiência

- **[P1]** App mobile (ou PWA) para atendentes, com **push notification** de nova mensagem.
- **[P1]** Notificação sonora e no desktop, contador de não lidas.
- **[P1]** Modo escuro, atalhos de teclado, interface responsiva.
- **[P2]** Widget/extensão de navegador.

---

## 3. Matriz comparativa resumida

| | Kommo | Digisac | ChatGuru / Poli | Octadesk | Blip / Zenvia | Chatwoot (OSS) |
|---|---|---|---|---|---|---|
| Inbox multiatendente | ✅ | ✅✅ | ✅✅ | ✅✅ | ✅ | ✅✅ |
| Funil Kanban | ✅✅ | ⚠️ básico | ✅ | ⚠️ | ❌ | ⚠️ |
| Chatbot visual | ✅ Salesbot | ✅ | ✅ | ✅ | ✅✅ Builder | ⚠️ |
| Agente de IA | ✅ | ✅ | ⚠️ | ✅✅ WOZ | ✅✅ | ⚠️ |
| Disparo em massa | ✅ | ✅✅ | ✅✅ (foco) | ⚠️ | ✅✅ escala | ❌ |
| API não oficial | ⚠️ via parceiro | ⚠️ | ✅ | ❌ | ❌ | ✅ (Evolution) |
| Help desk / SLA / CSAT | ⚠️ | ⚠️ | ⚠️ | ✅✅ | ✅ | ✅ |
| Multiempresa / white-label | ❌ | ⚠️ | ✅ | ❌ | ⚠️ | ✅ |
| Público | PME vendas | PME/serviços | PME/agências | E-commerce/CX | Enterprise | Dev/revenda |

**Leitura:** ninguém entrega tudo bem. A brecha mais explorável é **funil forte + disparo em massa seguro + IA + white-label multiempresa no mesmo produto**, que hoje exige juntar 2 ou 3 ferramentas.

---

## 4. Restrições técnicas que definem o produto

Isso não é detalhe de implementação — muda o desenho das telas.

1. **Janela de 24 horas.** Fora dela, só template aprovado. A interface precisa mostrar o cronômetro da janela e bloquear/alertar o envio livre — quase todos os concorrentes mostram isso no topo do chat.
2. **Cobrança por mensagem (desde jul/2025).** Marketing é cobrado sempre; Utility e Authentication têm regras próprias; mensagens de serviço dentro da janela de 24h são gratuitas. Preço varia por país do destinatário, mais markup do BSP. → Precisamos de **medição de custo por conversa/campanha**.
3. **Qualidade do número e tiers de envio.** Bloqueio/queda de qualidade por denúncias. → Painel de saúde do número e opt-out obrigatório.
4. **API não oficial = risco de ban.** Se suportarmos, o módulo anti-ban (intervalos, limites, aquecimento) é requisito, não enfeite.
5. **LGPD.** Consentimento, opt-out, retenção e exportação de dados do titular.

---

## 5. Escopo sugerido para o GeraCRM (proposta a validar)

**MVP (P0)** — canais WhatsApp oficial + não oficial · inbox multiatendente com setores e fila · contatos com campos custom · funil Kanban com negócio criado da conversa · respostas rápidas · bot de menu · campanha simples com variáveis e agendamento · dashboard básico · usuários e permissões · API/webhooks.

**Fase 2 (P1)** — construtor de fluxo visual · agente de IA com base de conhecimento · transcrição de áudio · campanhas com templates HSM e anti-ban · relatórios completos · app mobile com push · multiempresa/white-label · integrações (n8n, Bling, Asaas).

**Fase 3 (P2)** — SLA/CSAT/NPS · réguas e gatilhos transacionais · monitoramento ao vivo · painel de revenda · marketplace de integrações.

---

## 6. Próximo passo — telas de referência

Coloque as imagens em `docs/referencias/telas/`. Para cada tela, vou extrair e catalogar aqui:
- nome da tela e onde ela vive na navegação;
- todos os elementos de UI (filtros, colunas, botões, estados);
- regras de negócio implícitas;
- o que copiar, o que melhorar, o que descartar.

O resultado vira o **inventário de telas do GeraCRM** (`docs/inventario-telas.md`), base do backlog.

---

## Fontes

- [Melhor CRM com WhatsApp no Brasil: guia 2026 — Ploomes](https://blog.ploomes.com/melhor-crm-com-whatsapp-no-brasil/)
- [10 Melhores CRMs WhatsApp Integrado 2026 — SocialHub](https://www.socialhub.pro/blog/melhores-crms-whatsapp-integrado/)
- [10 Melhores CRM do Brasil em 2026 — RMChat](https://rmchat.com.br/crm/10-melhores-crm-do-brasil/)
- [Guia da Kommo de CRM para WhatsApp](https://www.kommo.com/blog/whatsapp-crm/)
- [WhatsApp no Kommo: como usar e vantagens da integração — Reportei](https://reportei.com/whatsapp-no-kommo/)
- [Digisac — Plataforma de atendimento multicanal](https://digisac.com.br/)
- [Digisac — WhatsApp API Oficial](https://digisac.com.br/canais/whatsapp-api)
- [Octadesk — Plataforma de Atendimento ao Cliente com IA](https://www.octadesk.com/produtos/plataforma-de-atendimento)
- [Octadesk — Ferramentas para WhatsApp 2026](https://www.octadesk.com/blog/ferramentas-para-whatsapp)
- [Huggy — Chatbot para WhatsApp](https://www.huggy.io/pt-br/whatsapp)
- [Top 20 Provedores de WhatsApp Business API no Brasil em 2026 — AiSensy](https://m.aisensy.com/blog/pt/top-provedores-whatsapp-business-api/)
- [Poli Digital — Disparo em massa](https://poli.digital/disparo-em-massa/)
- [ChatGuru — Ferramenta de disparo de WhatsApp](https://chatguru.com.br/ferramenta-de-disparo-de-whatsapp/)
- [Evolution API — repositório oficial](https://github.com/evolution-foundation/evolution-api)
- [8 sistemas Open Source para Multi Atendimento e Vendas no WhatsApp — Conectando Net](https://conectandonet.com.br/blog/sistemas-open-source-multi-atendimento-e-vendas-no-whatsapp/)
- [Pricing on the WhatsApp Business Platform — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [WhatsApp Business API Pricing in 2026 — Blueticks](https://blueticks.co/blog/whatsapp-business-api-pricing-2026)
- [Bitrix24 — Plataforma completa de gestão, CRM e marketing](https://br24.io/plataforma-bitrix24/)
- [Pipedrive vs RD Station CRM 2026 — Pipecon](https://www.pipecon.com.br/blog/artigo/pipedrive-vs-rd-station-crm)
