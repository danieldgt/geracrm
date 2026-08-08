# GeraCRM — Macro funcionalidades, épicos, backlog por onda e caminho de integração

> Deriva de [`escopo-funcional-geracrm.md`](./escopo-funcional-geracrm.md) (~150 funcionalidades, 15 módulos).
> Este documento organiza o **como executar**: épicos, backlog por onda e as decisões de integração com WhatsApp e Instagram.
> Ainda **não** é o documento de stack — mas as seções 5 e 6 travam escolhas técnicas que a stack terá de honrar.

---

## 1. Resumo das macro funcionalidades

Quinze blocos. Cada um é um capítulo do produto.

| # | Macro funcionalidade | Em uma frase | Onda de origem |
|---|---|---|---|
| **1** | **Plataforma e governança** | Empresa, filiais, usuários, papéis, permissões, auditoria, planos e limites | 0 |
| **2** | **Espinha dorsal de dados** | O CRM se preenche sozinho a partir do ERP: clientes, produtos e pedidos entram por conector nativo ou API pública | 0 |
| **3** | **Frota de números** | Um WhatsApp por vendedora, agrupado por filial, com saúde, tier e reputação monitorados | 0 |
| **4** | **Inbox e atendimento** | Conversa multicanal com janela de 24h visível, contexto comercial no card e histórico permanente | 1 |
| **5** | **Fila e roteamento** | Fila pull ("assumir atendimento") evoluindo para setores, distribuição automática e SLA | 1 → 3 |
| **6** | **Cliente unificado** | Um cadastro por CNPJ com múltiplos telefones, nomes, pessoas, campos custom e preferências de contato | 0 → 2 |
| **7** | **Funis e carteiras** | Kanban de leads e kanban de relacionamento por quantidade de pedidos, com dono e histórico de carteira | 2 |
| **8** | **Inteligência RFV** | 11 faixas de segmento com histórico temporal, ciclo de vida configurável e visão de qualidade da base | 2 → 3 |
| **9** | **Tarefas e Fila do Dia** | O sistema decide com quem falar hoje, por que, e entrega a mensagem pronta | 2 → 4 |
| **10** | **Catálogo conversacional** | Catálogo espelhado do ERP virando link, mídia e rastreio de interesse na conversa | 2 |
| **10b** | **Pedido assistido** | A vendedora monta o pedido dentro da conversa — grade, tabela de preço, estoque, regras comerciais — e o ERP conectado efetiva | 2 |
| **11** | **Copiloto de IA** | Sugere a mensagem usando cidade, categorias compradas e tempo sem comprar; transcreve áudio; resume conversa | 2 |
| **12** | **Agente autônomo de IA** | Atende 24/7, extrai dados, qualifica ou desqualifica, entrega ao humano só quem está pronto | 3 |
| **13** | **Campanhas em massa** | Disparo segmentado por templates HSM, distribuído pela frota, com custo e receita atribuída em 3/7/14 dias | 3 |
| **14** | **Governança de custo e reputação** | Simulador antes do disparo, anti-ban, bloqueio automático de número em risco | 3 → 4 |
| **15** | **Força de vendas e gestão de equipe** | App de campo, tira-pedidos offline, metas, ranking, performance e capacitação embutida | 2 → 4 |

---

## 2. Estrutura de épicos

**Vinte e oito épicos** — 23 na tabela abaixo e 5 exclusivos da Onda 4. A coluna **Onda** indica onde o épico **começa**; vários atravessam ondas.

| Épico | Nome | Escopo (IDs do escopo funcional) | Onda |
|---|---|---|---|
| **EP-01** | Fundação da plataforma e tenancy | PLT-01…04 | 0 |
| **EP-02** | Espinha dorsal de dados — GeraCloud + API pública | INT-01…09 | 0 |
| **EP-03** | Conectividade WhatsApp e frota de números | CAN-01…05 | 0 |
| **EP-04** | Cadastro unificado de cliente | CTT-01…08, CTT-10 | 0 |
| **EP-05** | Inbox e conversa | INB-01…08, INB-11 | 1 |
| **EP-06** | Fila e assunção de atendimento | INB-09, INB-10 | 1 |
| **EP-07** | Governança e auditoria | PLT-05, PLT-07, PLT-11 | 1 |
| **EP-08** | Funis, kanban e carteiras | CRM-01…09 | 2 |
| **EP-09** | Inteligência RFV e ciclo de vida | RFV-01…06 | 2 |
| **EP-10** | Tarefas e rotina comercial | TSK-01…04 | 2 |
| **EP-11** | Catálogo conversacional | CAT-01…04 | 2 |
| **EP-12** | Copiloto de IA | IA-01…04 | 2 |
| **EP-13** | Metas, ranking e performance | GES-01…05 | 2 |
| **EP-14** | BI e home executiva | BI-01, BI-03…05, BI-09 | 2 |
| **EP-15** | Aplicativo mobile | MOB-01…07 | 2 |
| **EP-16** | Produtividade do atendimento | INB-12…20 | 2 |
| **EP-17** | Campanhas e disparo em massa | CMP-01…14 | 3 |
| **EP-18** | Agente autônomo de IA | IA-05…09 | 3 |
| **EP-19** | Força de vendas e campo | FDV-01, FDV-06, FDV-07, FDV-11 | 2 → 4 |
| **EP-27** | **Pedido assistido (tira-pedidos na conversa)** | PED-01…16 | **2** |
| **EP-26** | **Planos, limites e cadeado de upsell** | PLT-06 | **2** |
| **EP-20** | Instagram e canais adicionais | CAN-07…09 | 2 → 3 |
| **EP-21** | Ecossistema de integrações | INT-10…13 | 3 → 4 |

⚠️ **EP-26 foi partido em dois.** `PLT-06` (planos, limites, cadeado de upsell) é **Onda 2** — o
cadeado atravessa `GET /eu` desde a Onda 0, a tabela `plano` nasce na migration `0002`, e a resposta
da API precisa distinguir *sem permissão* de *não contratado*. Já `PLT-09/10` (white-label e revenda)
seguem na **Onda 4**, como EP-28. Manter os três no mesmo épico colocava um item de Onda 2 numa
tabela intitulada "exclusivos da Onda 4".

Épicos exclusivos da Onda 4 (diferenciais):

| Épico | Nome | Escopo | Diferencial |
|---|---|---|---|
| **EP-22** | Motor da Fila do Dia | TSK-05…08, RFV-10, RFV-11 | **D1** |
| **EP-23** | Atendimento estruturado (setores, SLA, CSAT) | INB-21…24 | **D2** |
| **EP-24** | Governança de reputação e custo | CAN-06, CMP-18, BI-11 | **D3, D4** |
| **EP-25** | Capacitação e playbook | GES-06…10 | **D5** |
| **EP-28** | White-label e revenda | PLT-09, PLT-10 | **D7** |

---

## 3. Backlog por onda

### Onda 0 — Fundação

> **Objetivo:** dado entrando e canal em pé. Nada de tela bonita — se a sincronização não funcionar, todo o resto é fachada.

| Épico | Entregáveis |
|---|---|
| EP-01 | Modelo de tenant/empresa/filial · usuários e papéis · autenticação com 2FA · permissões por módulo |
| EP-02 | Conector GeraCloud (clientes, produtos/estoque, pedidos) · API pública de ingestão com três fluxos · Bearer Token e painel de tokens · **idempotência** · **carga histórica** · painel de sincronização com erros e reprocessamento |
| EP-03 | Onboarding de número via Embedded Signup · frota multi-número com nome amigável e filial · status e reconexão · recebimento e envio básico |
| EP-04 | Cadastro com múltiplos telefones, múltiplos CNPJs, múltiplos nomes · endereço e cidade/UF · unificação por chave |

**Critério de saída:** base histórica do GeraCloud carregada e reconciliada; pelo menos 3 números conectados recebendo e enviando; um contato do ERP aparece no CRM com telefone e histórico corretos.

**Riscos:** qualidade dos dados do ERP (nas telas do Tailor, **40% da base estava sem CPF/CNPJ**) · volume da carga histórica · aprovação da Meta para o app.

---

### Onda 1 — Atender

> **Objetivo:** a equipe larga a ferramenta atual e passa a atender pelo GeraCRM.

| Épico | Entregáveis |
|---|---|
| EP-05 | Inbox com seletor de número · texto, mídia e **áudio com player** · **badge de janela de 24h com contagem** · bloqueio de envio livre fora da janela com oferta de template · badges de contexto na lista · triagem "só sem resposta" · busca por nome/telefone/protocolo · protocolo numerado |
| EP-06 | Fila em modo pull · visualização em leitura · botão "Assumir atendimento" · abas Meus/Fila com contador |
| EP-03 (cont.) | **Painel de saúde do número**: tier, pagamento na Meta, LIVE, empresa verificada · contadores por número |
| EP-04 (cont.) | Atacado/Varejo · Qualificado/Desqualificado com data · campos personalizados · **"está no telefone"** · **toggles de opt-out** (campanhas / automações) · comentários internos |
| EP-07 | Log de auditoria · notificações e push · central de ajuda |
| EP-02 (cont.) | Documentação pública da API · webhooks de saída · importação CSV |

**Critério de saída:** operação real rodando por 2 semanas sem a ferramenta antiga.

---

### Onda 2 — Vender

> **Objetivo:** a vendedora abre o app e sabe com quem falar e o que dizer. O gestor vê meta, ranking e performance.

| Épico | Entregáveis |
|---|---|
| EP-08 | Funil de Leads · **Funil de Relacionamento por quantidade de pedidos** · card completo (última compra, responsável, tempo sem toque, badge RFV, valor, ativo/perdido) · ações Trabalhar/Descartar/Qualificar · funis configuráveis · carteirização · **histórico de carteira** · motivo de perda · filtros e exportação |
| EP-09 | **Matriz RFV de 11 faixas** · **histórico de evolução do segmento** · ciclo de vida configurável por dias sem comprar · métricas por cliente (dias sem vendas, média entre vendas, ticket) · **categorias mais compradas com drill-down até SKU-cor-tamanho** · gráfico de vendas do cliente |
| EP-10 | Tarefa com tipo, canal, data e responsável · abas Agendadas/Vencidas/Concluídas · filtro por vendedor · conclusão com registro no histórico |
| EP-11 | Catálogo espelhado com referência/grade · link compartilhável · "copiar catálogo" na conversa · envio de mídia e PDF |
| EP-12 | **Copiloto**: sugestões de mensagem com contexto do cliente · variação atacado/varejo · **transcrição de áudio** · resumo de conversa |
| EP-13 | Metas por vendedor/equipe/filial · ranking · performance de atendimento (tempo de resposta, receita por pessoa) · painel "quem está fechando, quem está parado" |
| EP-14 | Home executiva · gráfico com comparação ano anterior · filtros de período e filial · tabela de vendas e top produtos · exportação |
| EP-15 | App com tabs Indicadores/Atendimento/Catálogo/CRM/Pagamentos · ficha do cliente em cards · sub-abas Tarefas/CRM/Metas · envio de template · **push** |
| EP-16 | Seletor de funil dentro do chat · respostas rápidas · notas internas e menções · transferência · encerrar/reabrir · aviso de colisão |
| **EP-27** | **Painel de pedido ao lado da conversa** · busca por referência/SKU com **seleção por grade** · **tabela de preço do cliente** · **estoque em tempo real** · **validação de pedido mínimo, múltiplo de grade e mix** · **rascunho persistente e retomável** · **envio ao GeraCloud com idempotência** · **tratamento de falha na efetivação sem perder o rascunho** · **vínculo pedido ↔ conversa ↔ campanha ↔ tarefa** · resumo formatado ao cliente · crédito e limite |
| EP-19 (início) | App do vendedor com carteira e ficha |
| EP-20 (início) | Instagram Direct no inbox |

**Critério de saída:** produto vendável — a vendedora atende, decide com quem falar, monta e fecha o pedido sem trocar de sistema. Aqui já dá para cobrar.

---

### Onda 3 — Escalar

> **Objetivo:** campanha com ROI medido, IA qualificando sozinha, representante tirando pedido em campo.

| Épico | Entregáveis |
|---|---|
| EP-17 | Criação de campanha por segmento/RFV/lista/CSV · variáveis · **templates HSM com submissão e acompanhamento na Meta** · biblioteca reutilizável no 1-a-1 · **aviso de custo no envio** · fila com pausar/retomar · **disparo distribuído pela frota** · **anti-ban** · relatório (entregues, lidos, respostas, falhas detalhadas) · **atribuição de receita 3d/7d/14d** · **custo e ROI** · respostas caindo no inbox · opt-out global |
| EP-18 | Agente 24/7 com base de conhecimento · **extração estruturada** (CNPJ, e-mail, Instagram, necessidade) · qualificação automática com motivo · handoff com contexto · **painel de auditoria com tempo até qualificação** |
| EP-09 (cont.) | Visão de Mercado (Venn) · qualidade cadastral · distribuição RFV da base · mapa de clientes e cidades |
| EP-10 (cont.) | Sequências/cadências · tarefas automáticas por regra · **Fila do Dia** |
| EP-27 (cont.) | **Link de pagamento** a partir do pedido · **status do pedido** com aviso automático ao cliente · **modo offline** com fila de sincronização · desconto com alçada de aprovação · repetir última compra |
| EP-14 (cont.) | **Cards de atribuição de receita** · funil de conversão · **relatórios agendados por e-mail** · dashboard configurável |
| EP-16 (cont.) | **Setores com distribuição automática**, limite de simultâneas, horário e timeout |
| EP-20 | Instagram completo · e-mail como canal |
| EP-21 | Conectores Bling/Tiny/Omie/TOTVS · n8n/Make/Zapier · gateways de pagamento |
| EP-24 (início) | Governança de reputação com bloqueio automático |

---

### Onda 4 — Diferenciar

> **Objetivo:** os sete diferenciais. É aqui que saímos do mar vermelho.

| Épico | Entregáveis | Diferencial |
|---|---|---|
| EP-22 | **Motor da Fila do Dia**: priorização por risco de churn × valor esperado de reativação × tempo sem toque; mensagem sugerida junto; medição do resultado do toque | **D1** |
| EP-23 | SLA de primeira resposta e resolução · escalonamento · **CSAT** · monitoramento ao vivo do supervisor | **D2** |
| EP-24 | Saúde preditiva do número · **simulador de custo e receita pré-disparo** · **painel de ROI da própria ferramenta** | **D3, D4** |
| EP-25 | Trilhas de capacitação com quiz · **playbook por segmento RFV no momento do atendimento** · onboarding de vendedor novo · gamificação · comissionamento | **D5** |
| EP-28 | **White-label** (logo, cores, domínio, remetente) · **painel de revenda com subcontas** | **D7** |
| EP-21 (cont.) | **Marketplace de conectores** com SDK | **D6** |
| Diversos | NPS · campanhas de e-mail · gatilhos transacionais · teste A/B · equipe de agentes de IA · catálogo por cliente · alerta de reposição · visitas e roteiro | — |

---

## 4. Sequenciamento e dependências críticas

```
EP-02 (dados) ──┬──> EP-09 (RFV) ──> EP-22 (Fila do Dia)
                ├──> EP-08 (funis)
                └──> EP-17 (campanhas: segmento vem do RFV)

EP-03 (números) ──┬──> EP-05 (inbox) ──> EP-06 (fila) ──> EP-23 (SLA/CSAT)
                  └──> EP-17 (campanhas) ──> EP-24 (governança)

EP-01 (tenancy) ──> EP-26 (planos, Onda 2) ──> EP-28 (white-label, Onda 4)
```

**Quatro dependências que não podem ser invertidas:**

1. **RFV depende de carga histórica.** Sem 24 meses de venda importados, a matriz nasce vazia e o produto perde o argumento central. EP-02 antes de tudo.
2. **Campanha depende de segmentação.** Disparar para "todos" é o que os concorrentes baratos fazem. EP-09 antes de EP-17.
3. **Atribuição de receita depende de pedido chegando em tempo hábil.** Se o GeraCloud entrega venda com atraso de dias, a métrica de "vendas 3d" fica errada. A latência aceitável do conector precisa ser definida antes de prometer ROI.
4. **Pedido assistido depende de estoque e preço em tempo real.** EP-27 exige do conector GeraCloud três capacidades **de leitura síncrona** que a carga em lote não atende: saldo por SKU, tabela de preço do cliente e limite de crédito. Isso muda o contrato de integração — não é só ingestão de dados, é consulta ao vivo. **Precisa estar definido no EP-02, na Onda 0**, mesmo que o pedido só apareça na Onda 2.

---

## 5. Integração com WhatsApp — caminhos e recomendação

### 5.1 Os quatro caminhos

| Caminho | O que é | Prós | Contras |
|---|---|---|---|
| **A. Cloud API direto + Tech Provider** | Nos inscrevemos no **Tech Provider Program** da Meta e integramos a Cloud API diretamente. O cliente faz onboarding pelo **Embedded Signup** dentro do nosso produto | Margem cheia · controle total · sem intermediário · **é o caminho padrão da Meta desde abril/2026** | Precisamos de App Review, Business Verification e manter conformidade · suporte de infra por nossa conta |
| **B. Cloud API via BSP / Solution Partner** | Usamos um parceiro (360dialog, Infobip, Twilio, Gupshup, Zenvia, Take Blip) como intermediário | Time-to-market curto · o parceiro cuida de billing e compliance | **Markup por mensagem** (US$ 0,003–0,010) corrói margem · dependência de terceiro · menos controle sobre limites e suporte |
| **C. On-Premise API** | API auto-hospedada | — | **Descontinuada pela Meta.** Não é opção |
| **D. Não oficial (Baileys / Evolution API)** | Automação sobre o WhatsApp Web | Custo zero por mensagem · sem aprovação · plano de entrada barato | **Risco de banimento do número do cliente** · viola os termos · exige sessão persistente por número (custo de servidor alto e arquitetura totalmente diferente) · impede vender para cliente grande |

### 5.2 Decisão ✅

**Caminho A — Cloud API direto como Tech Provider.** *(decidido)*

Razões:
1. **A Meta tornou o Embedded Signup o caminho padrão** para todo onboarding novo, e o **enrollment no Tech Provider Program é obrigatório para ISVs** que oferecem mensageria. Não há atalho legítimo.
2. Nosso modelo é **multi-número por cliente** (uma vendedora por número). Depois do primeiro sender registrado via Embedded Signup, registrar senders adicionais é operação natural da API. Passar isso por um BSP multiplica o markup por número.
3. Margem: com dezenas de números por cliente e milhares de mensagens/mês, o markup do BSP vira a maior linha de custo variável do produto.

### 5.3 Decisão comercial embutida: Tech Provider vs. Solution Partner

Isto define **quem paga a Meta** e muda o modelo de receita:

| | **Tech Provider** *(recomendado para começar)* | **Solution Partner** |
|---|---|---|
| Linha de crédito da Meta | Não | Sim |
| Quem paga o consumo | **O cliente paga a Meta direto** (precisa cadastrar método de pagamento na própria conta) | **Nós pagamos a Meta e refaturamos** |
| Nossa receita | Só a assinatura do software | Assinatura **+ margem sobre mensagem** |
| Risco financeiro | Baixo — inadimplência do cliente não vira dívida nossa | Alto — consumo do cliente é dívida nossa |
| Complexidade | Menor | Billing, crédito, cobrança e inadimplência |

**Evidência de mercado:** o Tailor mostra `PAGAMENTO OK` no painel de cada número — indica que **o cliente tem método de pagamento na própria conta Meta**, ou seja, opera como Tech Provider. É o modelo com menor risco para começar.

> ✅ **Decidido:** entrar como **Tech Provider** na Onda 0. Reavaliar migração para Solution Partner na Onda 3, quando o volume agregado justificar assumir o risco de crédito em troca da margem por mensagem.
>
> **Consequência operacional:** cadastrar o método de pagamento na conta Meta do cliente vira **passo obrigatório do onboarding** e campo do painel de saúde do número (CAN-04). Se o cliente não fizer isso, o número não envia — e a falha precisa aparecer com essa causa explícita, não como erro genérico.

### 5.4 O que a integração precisa entregar (requisitos técnicos do épico EP-03)

- **Embedded Signup** embutido no onboarding do cliente (OAuth da Meta dentro do nosso produto)
- Registro de **senders adicionais** sem repetir o fluxo completo
- **Webhooks de entrada**: mensagem recebida, status de entrega (enviado/entregue/lido/falha), atualização de qualidade do número, aprovação/rejeição de template
- **Envio**: texto, mídia, áudio, documento, localização, template com variáveis, botões interativos e listas
- **Gestão de templates** pela API: criar, submeter, consultar status, versionar
- **Leitura de metadados da conta**: tier de mensageria, qualidade do número, status de billing, verificação de negócio → alimentam o painel de saúde (CAN-04)
- **Contabilização de custo por mensagem** por categoria e país — a Meta cobra **por mensagem entregue desde jul/2025**, e no Brasil já há cobrança **em reais**. O custo precisa ser gravado por conversa e por campanha para alimentar CMP-12 e BI-11
- **Controle da janela de 24h** por conversa, com timestamp de abertura, para INB-04 e INB-05

### 5.5 Sobre o caminho D (não oficial) — ✅ descartado nas Ondas 0–2

**Decidido: não construir na Onda 0–2.** Três motivos:
1. Muda a arquitetura por completo — sessão WebSocket persistente por número, com estado, contra webhooks stateless. São dois produtos de infraestrutura diferentes.
2. O custo de servidor por número é ordens de grandeza maior.
3. Cliente de R$ 150 mil/mês para cima — nosso alvo — não aceita risco de banimento.

Se for necessário um plano de entrada barato, reavaliar na Onda 3 **como módulo isolado**, nunca como caminho principal.

---

## 6. Integração com Instagram — caminhos e recomendação

### 6.1 O que existe

A **Instagram Messaging API** é o subconjunto de mensageria da Graph API da Meta, disponível para contas **Business e Creator**, operando sobre o endpoint `/messages`.

Dois caminhos de autenticação:

| Caminho | Como funciona | Quando usar |
|---|---|---|
| **A. Instagram Business Login** | OAuth 2.0 direto pelo Instagram, gera token do usuário Instagram. **Não exige Página do Facebook vinculada** | **Recomendado.** Onboarding mais simples para o cliente — a maioria das confecções tem Instagram forte e Página do Facebook abandonada |
| **B. Facebook Login for Business** | OAuth pela Página do Facebook à qual a conta Instagram está vinculada | Só quando o cliente já opera Página + Instagram integrados e quer os dois canais no mesmo fluxo |

### 6.2 Requisitos

- **Permissão `instagram_business_manage_messages`** — é ela que libera o acesso a DMs. Sem ela, autentica mas o endpoint de mensagens retorna erro de permissão.
- **App Review da Meta** para operar em escala. Em desenvolvimento, até **25 usuários de teste** sem review.
- **Webhooks** para DMs recebidas, com envio de resposta via `POST`.
- **Janela de 24 horas** igual à do WhatsApp: depois que o usuário manda DM, temos 24h para responder livremente; passado o prazo, a API rejeita.
- **Rate limit** de aproximadamente **200 mensagens automatizadas por hora por conta**, e uma mensagem automatizada por usuário por evento de gatilho.

### 6.3 Recomendação e consequências de produto

**Caminho A (Instagram Business Login), na Onda 2, com escopo reduzido; completo na Onda 3.**

Três consequências que o produto precisa absorver:

1. **Instagram não faz disparo em massa.** O rate limit de ~200 msgs/hora e a regra de uma mensagem automatizada por gatilho **inviabilizam campanha** no canal. Instagram entra como **canal de aquisição e atendimento**, nunca como canal de disparo. O módulo CMP deve bloquear explicitamente a seleção de Instagram como canal de campanha — e explicar por quê, em vez de deixar o usuário descobrir com erro.
2. **A janela de 24h é a mesma**, mas **não há templates HSM** para reabrir conversa fora dela. Uma vez fechada, o contato pelo Instagram acabou — só resta migrar o cliente para WhatsApp. Isso é, na verdade, uma **funcionalidade de produto**: detectar a janela fechando e sugerir a migração de canal.
3. **A unificação de identidade fica no nosso lado.** O mesmo cliente chega por Instagram (`@perfil`) e por WhatsApp (telefone). O cadastro unificado (EP-04) precisa tratar `instagram_id` como identificador de primeira classe, junto com telefone e CNPJ — exatamente como o Tailor faz (a coluna Instagram aparece tanto na ficha do cliente quanto no painel de leads da IA).

### 6.4 Ordem de canais recomendada

| Ordem | Canal | Onda | Justificativa |
|---|---|---|---|
| 1º | **WhatsApp Cloud API** | 0 | É o negócio inteiro. 100% da operação de atacado passa por aqui |
| 2º | **Instagram Direct** | 2–3 | Segundo canal de aquisição de lojista; baixo esforço marginal (mesma Graph API, mesmo modelo de webhook e janela) |
| 3º | **E-mail** | 3 | Canal de campanha sem custo por mensagem — alternativa quando o custo da Meta pesa |
| 4º | **Webchat** | 4 | Baixa prioridade: o público de atacado não usa chat de site |

---

## 7. Riscos do backlog

| Risco | Onda | Mitigação |
|---|---|---|
| Qualidade da base do ERP (40% sem CPF/CNPJ na referência) | 0 | Tela de qualidade cadastral (RFV-08) já na Onda 1, como ferramenta de higienização, não só de relatório |
| Aprovação Meta (App Review, Business Verification, Tech Provider) demora | 0 | Iniciar processo antes do primeiro código do EP-03 |
| Latência do conector inviabilizar atribuição 3d/7d/14d | 3 | Definir SLA de sincronização do GeraCloud na Onda 0 |
| Custo por mensagem da Meta surpreender o cliente | 3 | Aviso no clique (CMP-05) e simulador (CMP-18) — copiar o padrão do Tailor, que é bom |
| Escopo da Onda 4 competir com manutenção da Onda 3 | 4 | Onda 4 é sequência de diferenciais independentes; podem ser priorizados um a um por demanda de venda |
| ~~Multi-tenant adiado virar reescrita~~ | 0 | ✅ **Resolvido** — multi-tenant desde a modelagem (decisão registrada na seção 20 do escopo funcional) |
| Perfil de vertical mal abstraído engessar o núcleo | 0 | Modelo de produto com atributos variáveis; perfil "Moda Atacado" nasce completo e serve de teste da abstração |

---

## Fontes de integração

- [WhatsApp Cloud API — Get Started (Meta for Developers)](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)
- [Embedded Signup — Overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview)
- [Onboarding customers as a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)
- [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
- [Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [WhatsApp Business Solution Providers: Partner Tiers 2026](https://www.wuseller.com/whatsapp-business-knowledge-hub/whatsapp-business-solution-providers-partner-tiers-2026/)
- [Tech Provider Program — guia de integração (Twilio)](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide)
- [Tech Provider Program — setup e integração (Infobip)](https://www.infobip.com/docs/whatsapp/tech-provider-program/setup-and-integration)
- [How to Integrate the Instagram Messaging API (2026)](https://zernio.com/blog/instagram-messaging-api)
- [Instagram API in 2026: every option explained](https://zernio.com/blog/instagram-api)
- [Instagram Graph API — Developer Guide 2026](https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/)
