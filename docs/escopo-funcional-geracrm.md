# GeraCRM — Escopo funcional e plano de ondas

> Documento de definição de produto. Consolida:
> - [`estudo-crms-whatsapp.md`](./estudo-crms-whatsapp.md) — mercado geral de CRM + WhatsApp no Brasil
> - [`inventario-funcionalidades-referencia.md`](./inventario-funcionalidades-referencia.md) — o Tailor tela a tela (38 capturas da reunião)
> - [`concorrentes-tailor.md`](./concorrentes-tailor.md) — mapa competitivo em 6 anéis
>
> **Este documento define O QUÊ.** A definição de stack, arquitetura e custo de infraestrutura vem depois, num documento separado.

---

## 1. Decisões que moldam o escopo

### 1.1 Anéis competitivos adotados

| Anel | Decisão | Consequência |
|---|---|---|
| **1 — CRM vertical (Tailor, Modall, ViaShopModa)** | **Paridade completa + diferenciais** | Precisamos de tudo que eles têm, mais o que nos tira do mar vermelho |
| **3 — Força de vendas B2B (Mercos, Vendizap)** | **Paridade completa** | Módulo de campo/representante é escopo, não opcional |
| **4 — Marketplace (ZAX)** | **Recorte:** só capacitação e gestão de equipe/vendas | Não construímos marketplace nem canal de venda |
| **2 — CRM de retenção B2C (Dito, Mercafácil)** | Absorver o *conceito* (RFV, agenda do vendedor) | Não perseguimos CDP nem fidelidade agora |
| **5 — ERPs de moda** | **Não competimos — integramos** | GeraCloud é o ERP de origem; outros entram por conector |
| **6 — CRM genérico** | Não é referência de produto | Só referência de UX de inbox |

### 1.2 Fronteiras explícitas

**Fora do escopo agora:**
- **Loja B2B self-service / checkout do cliente final** — o lojista entrando sozinho, navegando e fechando compra. O ERP da casa já resolve, com integração completa.
- **Marketplace** de terceiros.
- **Emissão fiscal, controle de estoque, financeiro contábil** — permanecem no ERP.

**Dentro do escopo:**
- **Tira-pedidos assistido** ✅ *decidido* — a vendedora monta o pedido **dentro da conversa**, com tabela de preço do cliente, grade e estoque em tempo real. O rascunho vive no GeraCRM; a **efetivação acontece no ERP do cliente** — GeraCloud é o primeiro conector, não o único (ADR-008). Não confundir com loja B2B: aqui quem monta é a vendedora, durante o atendimento.
- **O pedido efetivado, o estoque e o fiscal são do ERP.** O GeraCRM origina a intenção e o rascunho; do pedido efetivado em diante, o ERP é a fonte da verdade.
- **Integração aberta com terceiros** desde o dia 1 — GeraCloud é o primeiro conector, não o único. Todo dado que o GeraCloud fornece precisa ter equivalente via API pública, senão amarramos o produto a um único ERP e perdemos o mercado.

> **Por que o tira-pedidos muda o produto, e não só o escopo:** com o pedido nascendo na conversa, a **atribuição de receita deixa de ser estimativa**. O modelo de referência (Tailor) atribui venda por janela temporal — "quem comprou em 3/7/14 dias depois de receber a campanha". Com o vínculo direto pedido ↔ conversa ↔ campanha ↔ tarefa, sabemos exatamente o que gerou o quê. O diferencial mais forte do produto passa de aproximação estatística a fato registrado.

### 1.3 Legenda de origem

`T` Tailor · `M` Modall · `V` ViaShopModa · `MC` Mercos · `Z` ZAX · `D` Dito · `K` mercado geral · **`★` diferencial nosso**

### 1.4 Decisões estruturais — **TOMADAS**

| # | Decisão | Resposta |
|---|---|---|
| 1 | Multi-tenant / white-label | **Sim, desde a modelagem.** Isolamento por tenant já na Onda 0, mesmo que a venda comece como produto único |
| 2 | Modelo de parceria com a Meta | **Tech Provider.** Cloud API direto; o cliente cadastra método de pagamento na própria conta Meta. Reavaliar Solution Partner na Onda 3 |
| 3 | API não oficial (Baileys/Evolution) | **Não nas Ondas 0–2.** Só API Oficial. Reavaliar na Onda 3 como módulo isolado |
| 4 | Vertical ou horizontal | **Genérico com perfil de vertical configurável.** Modelo de dados neutro; grade/cor/tamanho e regras de moda entram como perfil ativável |

Detalhamento e consequências na seção 20.

---

## 2. Mapa de módulos

```
┌─ PLT  Plataforma, tenancy, usuários, permissões, planos
├─ INT  Integrações: GeraCloud, API pública, webhooks, conectores
├─ CAN  Canais e frota de números (WhatsApp, Instagram, e-mail)
├─ INB  Inbox / atendimento / fila
├─ CTT  Contatos e base de clientes
├─ CRM  Funis, carteiras, oportunidades
├─ RFV  Inteligência de cliente: RFV, ciclo de vida, visão de base
├─ TSK  Tarefas, cadências e Fila do Dia
├─ CMP  Campanhas e comunicação em massa
├─ IA   Agente autônomo e copiloto
├─ CAT  Catálogo como peça de conversa
├─ PED  Pedido assistido (tira-pedidos na conversa)
├─ FDV  Força de vendas / campo / representante
├─ GES  Metas, performance e capacitação de equipe
├─ BI   Dashboards, atribuição de receita, relatórios
└─ MOB  Aplicativo mobile
```

---

## 3. PLT — Plataforma

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| PLT-01 | Cadastro de empresa, **filiais/unidades** e agrupamento de recursos por filial | T | 0 |
| PLT-02 | Usuários, papéis (admin, gestor, supervisor, vendedor, atendente) e permissões por módulo e por ação | T,K | 0 |
| PLT-03 | **Multi-tenant desde a modelagem** — isolamento de dados por tenant, transversal a todos os módulos ✅ *decidido* | ★ | 0 |
| PLT-04 | Autenticação, sessão, recuperação de senha, 2FA | K | 0 |
| PLT-05 | **Log de auditoria** — quem enviou, apagou, transferiu, mudou carteira, alterou preço | T | 1 |
| PLT-06 | Planos, limites contratados (números, disparos/mês, usuários) e **bloqueio visual de módulo não contratado** (cadeado como upsell no menu) | T | 2 |
| PLT-07 | Notificações no app + push + som, com contador | T | 1 |
| PLT-08 | **Changelog / Novidades in-app** categorizado por módulo, com "marcar como lido" | T | 2 |
| PLT-09 | White-label: logo, cores, domínio, remetente — *destravado por PLT-03* | ★ | 4 |
| PLT-10 | Painel de revenda com subcontas — *destravado por PLT-03* | ★ | 4 |
| PLT-11 | Suporte embutido ("Solicitar Ajuda") e base de conhecimento | T | 2 |

---

## 4. INT — Integrações e dados

O módulo mais estratégico. Se ele falha, o CRM não se preenche sozinho e todo o discurso de produto cai.

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| INT-01 | **Conector nativo GeraCloud** — sincronização de clientes, produtos/estoque e pedidos/vendas | ★ | 0 |
| INT-01b | **Leitura síncrona ao vivo** (não em lote): saldo por SKU, tabela de preço do cliente, limite de crédito — requisito do pedido assistido (PED-03, PED-04, PED-11) | ★ | 0 |
| INT-01c | **Escrita de pedido** no ERP com idempotência e retorno de número/erro tipificado (PED-07, PED-08) | ★ | 0 |
| INT-02 | **API pública de ingestão** com três fluxos independentes: `customers`, `products`, `orders` — combináveis | T | 0 |
| INT-03 | Autenticação por **Bearer Token**, gerado em painel próprio ("Tokens de Integração") | T | 0 |
| INT-04 | **Idempotência** por chave de operação — reenvio não duplica | T | 0 |
| INT-05 | **Carga histórica** — importação retroativa de anos de venda (é o que alimenta o RFV no dia 1) | T | 0 |
| INT-06 | Documentação pública navegável da API: campos, erros HTTP, limites, formatos, exemplos cURL | T | 1 |
| INT-07 | **Webhooks de saída** — mensagem recebida, lead qualificado, negócio mudou de etapa, campanha finalizada, tarefa concluída | K | 1 |
| INT-08 | Painel de monitoramento de sincronização: última carga, volume, erros, reprocessamento | ★ | 1 |
| INT-09 | Importação/exportação CSV com mapeamento de colunas | K | 1 |
| INT-10 | Conectores para ERPs de mercado (Bling, Tiny, Omie, TOTVS) | T,V | 3 |
| INT-11 | n8n / Make / Zapier | K | 3 |
| INT-12 | Pagamentos (Asaas, Mercado Pago, PagBank) para link de pagamento | T | 3 |
| INT-13 | **Marketplace de conectores** com SDK e certificação de parceiro | ★ | 4 |

> **Regra de ouro:** nada que o conector GeraCloud faz pode ser exclusivo dele. Toda capacidade tem de existir também pela API pública — senão o produto vira acessório do ERP da casa e perde o mercado externo.

---

## 5. CAN — Canais e frota de números

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| CAN-01 | **WhatsApp Cloud API oficial (Meta)** como **Tech Provider**, com Embedded Signup e múltiplos senders ✅ *decidido* | T,M | 0 |
| CAN-02 | **Frota de números**: um por vendedor(a), nome amigável editável, agrupamento por filial | T | 0 |
| CAN-03 | Status do número (disponível / offline / bloqueado) e reconexão com alerta | T,K | 0 |
| CAN-04 | **Painel de saúde do número**: tier de envio (ex. 10K/dia), status de pagamento na Meta, conta LIVE, empresa verificada, qualidade | T | 1 |
| CAN-05 | Contadores por número: contatos, clientes, conversas ativas | T | 1 |
| CAN-06 | **Governança de reputação** — alerta preditivo de queda de qualidade, sugestão de pausa, bloqueio automático de disparo em número em risco | ★ | 3 |
| CAN-07 | Instagram Direct | M,T | 2 |
| CAN-08 | E-mail (envio transacional e campanha) | T | 3 |
| CAN-09 | Webchat / widget de site | K | 4 |
| CAN-10 | ~~API não oficial (Baileys)~~ — **descartado nas Ondas 0–2** ✅ *decidido*; se voltar na Onda 3, entra como módulo isolado com infraestrutura própria | K | — |

---

## 6. INB — Inbox e atendimento

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| INB-01 | Caixa de entrada com **seletor de número**, lista de conversas, chat e painel do contato | T | 1 |
| INB-02 | Envio/recebimento de texto, imagem, vídeo, documento, **áudio (PTT)**, localização, contato | T,K | 1 |
| INB-03 | Gravação de áudio no navegador e no app; **player inline** com velocidade | T | 1 |
| INB-04 | **Badge de janela de 24h** (`Janela Aberta` / `Janela Fechada`) fixo no header, com contagem regressiva | T | 1 |
| INB-05 | Bloqueio de envio livre com janela fechada + oferta automática de template | ★ | 1 |
| INB-06 | **Badges de contexto na lista**: estágio (Lead / Lead Qualificado), vendedor dono, histórico (`1 pedido`, `3+ pedidos`), quem conduz (humano ou IA), tipo do último conteúdo, não lido | T | 1 |
| INB-07 | Triagem: **"Só sem resposta"**, ordenar por mensagem do cliente, busca por nome/telefone/**protocolo** | T | 1 |
| INB-08 | Recorte temporal com "carregar mais 30 dias" | T | 1 |
| INB-09 | **Fila em modo pull**: ver em leitura + botão "Assumir atendimento" | T | 1 |
| INB-10 | Abas "Meus atendimentos" / "Fila" com contador | T | 1 |
| INB-11 | Protocolo numerado de atendimento | T | 1 |
| INB-12 | **Seletor de funil e etapa dentro do chat** — mover o negócio sem sair da conversa | T | 2 |
| INB-13 | **Respostas rápidas / atalhos** com variáveis | K | 2 |
| INB-14 | Notas internas na conversa e menção a colega | K | 2 |
| INB-15 | Transferência entre atendentes e entre setores, com motivo | K | 2 |
| INB-16 | Encerrar / resolver / reabrir automaticamente | K | 2 |
| INB-17 | Reply/quote, encaminhar, reagir | K | 2 |
| INB-18 | Aviso de colisão (outro atendente já está na conversa) | K | 2 |
| INB-19 | Agendamento de mensagem | K | 3 |
| INB-20 | Botões interativos, listas e enquetes (API oficial) | K | 3 |
| INB-21 | **Setores/departamentos com distribuição automática** (round-robin, menor carga), limite de simultâneas, horário de atendimento, timeout de inatividade | ★ | 3 |
| INB-22 | **SLA de primeira resposta e de resolução** com alerta e escalonamento | ★ | 4 |
| INB-23 | **CSAT ao encerrar** + relatório | ★ | 4 |
| INB-24 | Monitoramento ao vivo pelo supervisor | ★ | 4 |

> **INB-21 a INB-24 são o buraco da vertical inteira.** Nem Tailor, nem Modall, nem ViaShopModa têm setores, SLA ou CSAT. Quem tem operação de 20+ atendentes hoje precisa comprar uma segunda ferramenta.

---

## 7. CTT — Contatos e base

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| CTT-01 | Cadastro: razão social, nome fantasia, **múltiplos nomes** ("ver todos os nomes" — o mesmo CNPJ chega com nome diferente de cada fonte) | T | 0 |
| CTT-02 | **Múltiplos telefones** com marcação de principal | T | 0 |
| CTT-03 | **Múltiplos CNPJs / CPF**, aniversário, e-mail, Instagram | T | 0 |
| CTT-04 | Endereço, cidade/UF, localização | T | 0 |
| CTT-05 | Classificação **Atacado / Varejo** e **Qualificado / Desqualificado** com data e origem da qualificação | T | 1 |
| CTT-06 | **Campos personalizados** (texto, número, data, lista, moeda) | T,K | 1 |
| CTT-07 | **"Está no telefone"** — em quais números da frota o contato existe, com badge por número | T | 1 |
| CTT-08 | **Preferências de contato**: toggles independentes `Recebe Campanhas` / `Recebe Automações` — opt-out granular | T | 1 |
| CTT-09 | **Pessoas** — múltiplos contatos-pessoa vinculados à empresa | T | 2 |
| CTT-10 | Comentários / anotações internas | T | 1 |
| CTT-11 | Deduplicação e mesclagem (por CNPJ, telefone, e-mail) | K | 2 |
| CTT-12 | Timeline unificada: mensagens, pedidos, tarefas, campanhas recebidas, mudanças de carteira | T | 2 |
| CTT-13 | **Marcar como representante** — tipo de relação distinto de cliente | T | 2 |
| CTT-14 | Listas personalizadas / segmentos salvos | T | 2 |
| CTT-15 | LGPD: consentimento, opt-out, exportação e exclusão do titular | ★ | 3 |

---

## 8. CRM — Funis, carteiras e oportunidades

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| CRM-01 | **Funil de Leads (kanban)** — Lead → Qualificado → Trabalhando → Descartado | T | 2 |
| CRM-02 | **Funil de Relacionamento (kanban)** com colunas por **quantidade de pedidos**: Lead · 1 pedido · 2 pedidos · 3+ pedidos · Representantes · Descartados | T | 2 |
| CRM-03 | Card com: nome, telefone, última compra, **responsável + tempo desde o último toque**, "está no telefone", UF, **badge RFV**, valor, status Ativo/Perdido, ação de abrir conversa | T | 2 |
| CRM-04 | Ações rápidas no card: **Trabalhar / Descartar / Qualificar** | T | 2 |
| CRM-05 | **Funis e etapas configuráveis** (múltiplos funis: comercial, pós-venda, cobrança, reativação) | T,K | 2 |
| CRM-06 | **Carteirização** — vendedor dono do cliente, atribuição manual e automática | T,MC | 2 |
| CRM-07 | **Histórico da carteira** — eventos de atribuição e remoção com data/hora e autor | T | 2 |
| CRM-08 | Filtros avançados e exportação do kanban | T | 2 |
| CRM-09 | Motivo de perda/descarte obrigatório, com catálogo de motivos | K | 2 |
| CRM-10 | Automação por etapa (entrou na etapa → envia template, cria tarefa, muda responsável) | K | 3 |
| CRM-11 | Oportunidade/negócio com valor previsto e probabilidade (opcional — o pedido real vive no ERP) | K | 3 |

---

## 9. RFV — Inteligência de cliente

O coração analítico. É o que separa CRM de caixa de entrada.

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| RFV-01 | **Matriz RFV** com 11 faixas: Campeão · Clientes Fiéis · Potencial Fiel · Clientes Promissores · Clientes Recentes · Não Perder · Em Risco · Precisa de Atenção · Semi Perdido · Hibernando · Perdido | T | 2 |
| RFV-02 | **Histórico de evolução do segmento** por cliente (gráfico temporal) | T | 2 |
| RFV-03 | Ciclo de vida **configurável por dias sem comprar**: Ativo / Inativo / Perdido | T | 2 |
| RFV-04 | Métricas por cliente: total em vendas, primeira e última venda, **dias sem vendas**, qtd de vendas, ticket médio, **média entre vendas** | T | 2 |
| RFV-05 | **Categorias mais compradas** (donut) com drill-down até SKU-cor-tamanho, com busca | T | 2 |
| RFV-06 | Gráfico de vendas do cliente ao longo do tempo | T | 2 |
| RFV-07 | **Visão de Mercado** — Venn cruzando Base do CRM × Contatos de WhatsApp × Clientes do ERP, com interseções | T | 3 |
| RFV-08 | **Qualidade cadastral** da base: % com CPF, % com CNPJ, % não informado | T | 3 |
| RFV-09 | Distribuição RFV da base inteira, com filtro por filial e vendedor | T | 3 |
| RFV-10 | **Predição de churn** — probabilidade de o cliente parar de comprar, com janela e motivo | D,★ | 4 |
| RFV-11 | **Valor esperado de reativação** por cliente — quanto vale falar com ele hoje | ★ | 4 |
| RFV-12 | Mapa de clientes (geolocalização) e lista de cidades / cobertura | T | 3 |

---

## 10. TSK — Tarefas, cadências e Fila do Dia

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| TSK-01 | Tarefa com título, descrição, data/hora, **tipo** (Follow-up, Pós-venda, Reposição, Cobrança), **canal** (WhatsApp, ligação, visita) e responsável | T | 2 |
| TSK-02 | Abas **Agendadas / Vencidas / Concluídas** com contadores e navegação por dia | T | 2 |
| TSK-03 | Filtro por vendedor; visão do gestor sobre a equipe | T | 2 |
| TSK-04 | Conclusão com registro do que foi feito (vira histórico do cliente) | T | 2 |
| TSK-05 | **Sequências / cadências** — régua multi-etapas de follow-up com espera entre passos | T,MC | 3 |
| TSK-06 | Tarefas geradas automaticamente por regra (X dias sem comprar, pós-venda D+7, aniversário, pedido entregue) | T | 3 |
| TSK-07 | **Fila do Dia** — lista priorizada de quem falar hoje | T | 3 |
| TSK-08 | **Motor de priorização da Fila do Dia** — ordena por risco de churn × valor esperado × tempo sem toque, e **entrega a mensagem sugerida junto** | ★ | 4 |

> **TSK-08 é o diferencial central do produto.** Tailor tem a Fila do Dia; Dito tem a Agenda com sugestão de texto. Ninguém junta *priorização por valor esperado* + *mensagem pronta* + *medição do resultado daquele toque*. É o que transforma o CRM de registro em operação.

---

## 11. CMP — Campanhas e comunicação em massa

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| CMP-01 | Criação de campanha: público (segmento, tag, filtro RFV, lista, CSV), mensagem, canal, número remetente, agendamento | T | 3 |
| CMP-02 | **Personalização com variáveis** do contato e do histórico | T | 3 |
| CMP-03 | **Templates HSM**: criação, submissão à Meta, acompanhamento de aprovação/rejeição, categorias (Marketing/Utility/Authentication), header, body, footer, botões | T | 3 |
| CMP-04 | Biblioteca de templates reutilizável **também no atendimento 1-a-1**, com busca e preview renderizado | T | 3 |
| CMP-05 | **Aviso de custo e risco no momento do envio** — tarifa da Meta por categoria + risco de limitação do número + link explicativo | T | 3 |
| CMP-06 | Envio com mídia (imagem, PDF, vídeo, áudio) | T,K | 3 |
| CMP-07 | Fila de disparo com progresso ao vivo, pausar / retomar / cancelar | K | 3 |
| CMP-08 | **Disparo distribuído pela frota** — mesma campanha por vários números, com comparação de performance entre eles | T | 3 |
| CMP-09 | **Anti-ban**: intervalo randômico, limite diário por número, aquecimento gradual, rotação, variação de texto | K | 3 |
| CMP-10 | **Relatório por campanha**: contatos, entregues, **lidos**, **respostas**, falhas com detalhamento de erro, opt-outs | T | 3 |
| CMP-11 | **Atribuição de receita em duas fontes:** *exata* (pedido originado na conversa via PED-09) e *estimada* por janela 3d/7d/14d (para quem comprou por fora). As duas exibidas separadamente — nunca somadas sem distinção | T,★ | 3 |
| CMP-12 | **Custo aproximado e ROI (retorno em X)** por campanha e consolidado no período | T | 3 |
| CMP-13 | Respostas da campanha caem no inbox e podem virar lead/tarefa | T | 3 |
| CMP-14 | Lista de bloqueio e opt-out automático, respeitado por todos os módulos | T,K | 3 |
| CMP-15 | Campanhas de e-mail no mesmo builder | T | 4 |
| CMP-16 | Gatilhos transacionais: pós-venda, boleto a vencer, reposição, aniversário, NPS | K | 4 |
| CMP-17 | Teste A/B de mensagem e de horário | K | 4 |
| CMP-18 | **Simulador pré-disparo** — custo estimado na Meta + receita esperada com base no histórico daquele segmento, antes de apertar o botão | ★ | 4 |

---

## 12. IA — Agente e copiloto

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| IA-01 | **Copiloto de mensagem** — gera sugestões usando cidade, histórico de categorias, tempo sem comprar e nome da loja; botão "copiar e enviar" | T | 2 |
| IA-02 | Variação por contexto de negócio (ex.: atacado vs. varejo) | T | 2 |
| IA-03 | **Transcrição de áudio** recebido | M,K | 2 |
| IA-04 | Resumo da conversa para quem assume no meio | K | 2 |
| IA-05 | **Agente autônomo de atendimento 24/7** com base de conhecimento da marca | T,M | 3 |
| IA-06 | **Extração estruturada** da conversa: CNPJ, e-mail, Instagram, necessidade, cidade — preenche o cadastro sozinho | T,M | 3 |
| IA-07 | **Qualificação automática** (qualificado / desqualificado) com motivo | T,M | 3 |
| IA-08 | Handoff para humano com contexto, por regra ou por incerteza | K | 3 |
| IA-09 | **Painel de auditoria da IA**: leads totais, qualificados, taxa de conversão, **tempo até qualificação**, canal, origem, virou cliente | T | 3 |
| IA-10 | **Equipe de agentes** — múltiplos agentes com papéis distintos (triagem, qualificação, pós-venda, cobrança) | T | 4 |
| IA-11 | Entendimento do jargão do negócio (referência, grade, sazonalidade) treinado com o histórico do próprio cliente | M | 4 |
| IA-12 | Correção de tom/ortografia e classificação de sentimento | K | 4 |
| IA-13 | Geração de texto de campanha a partir do segmento escolhido | K | 4 |

---

## 13. CAT — Catálogo como peça de conversa

Escopo reduzido por decisão: **sem loja self-service, sem checkout do cliente final**. O carrinho que existe é o da vendedora, no módulo PED.

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| CAT-01 | Espelho do catálogo do ERP: produto, **referência/SKU, cor, tamanho, grade**, preço, categoria, estoque | T,V | 2 |
| CAT-02 | **Link de catálogo compartilhável** e botão "copiar catálogo" dentro da conversa | T | 2 |
| CAT-03 | **Rastreio de comportamento online** — quem abriu, o que olhou, quando | T | 3 |
| CAT-04 | Envio de mídia/lookbook e PDF pela conversa | M | 2 |
| CAT-05 | Catálogo filtrado por cliente (tabela de preço, mix permitido) | V,MC | 4 |
| CAT-06 | **Alerta de reposição** — cliente comprou X, o estoque voltou, gera tarefa | ★ | 4 |

---

## 14. PED — Pedido assistido (tira-pedidos na conversa)

**Decisão:** a vendedora monta o pedido dentro do atendimento; **o ERP conectado** efetiva. O rascunho é nosso, o pedido efetivado é do ERP.

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| PED-01 | **Painel de pedido ao lado da conversa** — abre e fecha sem perder o chat; no mobile, folha deslizante | MC,V | 2 |
| PED-02 | Busca de produto por **referência, SKU, nome e categoria**, com seleção por **grade (cor × tamanho)** e quantidade | MC,V | 2 |
| PED-03 | **Tabela de preço e condição comercial do cliente** aplicada automaticamente (atacado/varejo, prazo, desconto contratado) | MC,V | 2 |
| PED-04 | **Estoque e disponibilidade em tempo real** por SKU, com aviso de saldo insuficiente antes de adicionar | MC | 2 |
| PED-05 | **Validação das regras comerciais antes de enviar**: pedido mínimo (peças ou valor), múltiplo de grade, mix mínimo por categoria — com o que falta explicitado | V,MC | 2 |
| PED-06 | **Rascunho persistente e retomável**, múltiplos rascunhos por cliente, sobrevive a fechar o navegador e a troca de dispositivo | ★ | 2 |
| PED-07 | **Envio ao ERP para efetivação**, com idempotência e retorno do número do pedido. ⚠️ A interface nunca nomeia o ERP literalmente — usa o nome da conexão ativa | ★ | 2 |
| PED-08 | **Tratamento de falha na efetivação** — estoque esgotado, crédito bloqueado, item inativo, cliente sem cadastro fiscal — com ação corretiva na própria tela, sem perder o rascunho | ★ | 2 |
| PED-09 | **Vínculo pedido ↔ conversa ↔ campanha ↔ tarefa ↔ vendedora** — base da atribuição exata de receita (CMP-11, BI-02) | ★ | 2 |
| PED-10 | **Resumo do pedido enviado ao cliente pela conversa**, em mensagem formatada e conferível | ★ | 2 |
| PED-11 | Status de **crédito e limite** do cliente, lido do ERP e exibido antes de montar | MC | 2 |
| PED-12 | **Link de pagamento** gerado a partir do pedido (Pix/cartão) e enviado na conversa | T | 3 |
| PED-13 | **Acompanhamento do status** (separação, faturado, enviado) com aviso automático ao cliente | ★ | 3 |
| PED-14 | **Modo offline** com fila de sincronização — pedido montado sem sinal, efetivado ao reconectar | MC | 3 |
| PED-15 | **Desconto com alçada de aprovação** — vendedora solicita, gestor aprova no app | MC | 3 |
| PED-16 | Duplicar pedido anterior / "repetir última compra" como ponto de partida | ★ | 3 |

> **PED-08 é o item mais subestimado da lista.** Todo tira-pedidos falha na efetivação em algum momento — estoque acabou entre a montagem e o envio, o crédito estourou, o item foi inativado. Se a falha perder o rascunho ou aparecer como erro genérico, a vendedora abandona a ferramenta e volta a lançar no ERP. É aqui que produtos desse tipo morrem na prática.

---

## 14b. FDV — Força de vendas e campo (Anel 3)

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| FDV-01 | **App do vendedor/representante** com carteira, histórico e ficha do cliente | MC | 2 |
| FDV-02 | *(movido para PED-01…PED-11 — tira-pedidos)* | — | — |
| FDV-03 | *(movido para PED-14 — operação offline)* | — | — |
| FDV-06 | **Visitas e roteiro** — agenda de visitas, check-in com geolocalização, relatório de visita | MC | 4 |
| FDV-07 | Prospecção fora da área de cobertura, com regra de atribuição | MC | 4 |
| FDV-11 | Showroom/feira: atendimento presencial registrado no CRM com o mesmo fluxo de pedido | ★ | 4 |

---

## 15. GES — Metas, performance e capacitação (Anel 4, recorte)

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| GES-01 | **Metas por vendedor, equipe e filial**, com acompanhamento e projeção | T | 2 |
| GES-02 | **Ranking de vendedores** e de clientes no período | T | 2 |
| GES-03 | **Performance de atendimento**: tempo médio de resposta, conversas atendidas, taxa de resolução, receita por pessoa | T,M | 2 |
| GES-04 | Painel "quem está fechando, quem está parado" | M | 2 |
| GES-05 | Curva de demanda por hora/dia (dimensionamento de equipe) | K | 3 |
| GES-06 | Comissionamento e apuração | Z | 4 |
| GES-07 | **Trilhas de capacitação** — conteúdo, vídeo, quiz, certificação por vendedor | Z,★ | 4 |
| GES-08 | **Playbook comercial embutido** — script e abordagem por segmento RFV, disponível no momento do atendimento | ★ | 4 |
| GES-09 | Onboarding guiado de novo vendedor | ★ | 4 |
| GES-10 | Gamificação: metas, badges, ranking de equipe | Z | 4 |

> **GES-07 a GES-09 não existem em nenhum concorrente do mapa.** Em operação de atacado, a rotatividade de vendedoras é alta e o conhecimento mora na cabeça delas. Capacitação embutida é retenção de cliente disfarçada de funcionalidade.

---

## 16. BI — Dashboards e relatórios

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| BI-01 | **Home executiva**: vendas, pedidos, ticket médio, clientes (novos vs. recorrentes) | T | 2 |
| BI-02 | **Cards de atribuição de receita**: Vendas por Campanha (com custo e ROI), Vendas por Tarefa, Leads atendidos pela IA, Leads que viraram clientes | T | 3 |
| BI-03 | Gráfico de vendas com eixo duplo (R$ × qtd. clientes) e **comparação com ano anterior** | T | 2 |
| BI-04 | Filtros de período em chips + filtro de filial + personalizado | T | 2 |
| BI-05 | Tabela de vendas detalhada e Top Produtos (por valor e por quantidade) | T | 2 |
| BI-06 | Funil de conversão etapa a etapa; leads e conversão | T | 3 |
| BI-07 | **NPS** — coleta e relatório | T | 4 |
| BI-08 | **Relatórios agendados por e-mail** — resumo diário/semanal da operação na caixa de entrada do dono | T | 3 |
| BI-09 | Exportação CSV/PDF de tudo | T | 2 |
| BI-10 | Dashboard configurável (escolher quais cards aparecem) | T | 3 |
| BI-11 | **Painel de ROI da própria ferramenta** — receita atribuída ÷ custo do GeraCRM + custo Meta, no período | ★ | 4 |

> **BI-11:** o Tailor prova o próprio valor toda vez que o dono abre a home. Levar isso ao explícito ("este mês o GeraCRM gerou R$ X para você e custou R$ Y") é a melhor arma anti-churn que existe.

---

## 17. MOB — Aplicativo mobile

Recorte de campo, **não** espelho do web.

| ID | Funcionalidade | Origem | Onda |
|---|---|---|---|
| MOB-01 | Tab bar: **Indicadores · Atendimento · Catálogo · CRM · Pagamentos** | T | 2 |
| MOB-02 | Indicadores com filtros de período, filial e alternância Visão Geral / Equipe | T | 2 |
| MOB-03 | Atendimento: Meus atendimentos / Fila, busca por nome-telefone-protocolo, assumir atendimento | T | 2 |
| MOB-04 | Ficha do cliente completa em cards verticais | T | 2 |
| MOB-05 | CRM com sub-abas Tarefas / CRM / Metas | T | 2 |
| MOB-06 | Envio de template com seletor de número e preview | T | 2 |
| MOB-07 | **Push notification** de nova mensagem, tarefa vencendo e meta em risco | T,V | 2 |
| MOB-08 | Modo offline para tira-pedidos e consulta de carteira | MC | 3 |

---

## 18. Os diferenciais — como sair do mar vermelho

Sete apostas. Nenhuma delas existe hoje em Tailor, Modall ou ViaShopModa.

| # | Diferencial | Por que ninguém tem | IDs |
|---|---|---|---|
| **D1** | **Motor de Fila do Dia por valor esperado** — prioriza por risco de churn × valor de reativação × tempo sem toque, entrega a mensagem pronta e **mede o resultado daquele toque** | Todos têm lista de tarefas; ninguém fecha o ciclo priorização → ação → medição | TSK-08, RFV-10, RFV-11 |
| **D2** | **Atendimento estruturado na vertical** — setores, distribuição automática, SLA, escalonamento, CSAT, monitoramento ao vivo | A vertical inteira foi para "venda" e ignorou "operação de atendimento"; cliente com 20+ atendentes hoje compra 2 ferramentas | INB-21…24 |
| **D3** | **Governança de reputação da frota** — saúde preditiva do número, bloqueio automático de disparo em número em risco, aquecimento gerenciado | Todos mostram o status; ninguém age sozinho para proteger o ativo mais caro do cliente | CAN-04, CAN-06, CMP-09 |
| **D4** | **Simulador de custo e retorno pré-disparo** — antes de enviar, mostra o custo Meta estimado e a receita esperada daquele segmento pelo histórico | Todos mostram o gasto depois; ninguém decide antes | CMP-18, CMP-12 |
| **D5** | **Capacitação e playbook embutidos** — trilhas, quiz, script por segmento RFV no momento do atendimento, onboarding de vendedor novo | Rotatividade alta é a dor real do atacado, e ninguém tratou | GES-07…10 |
| **D6** | **Integração aberta de verdade** — API pública com paridade total ao conector nativo, marketplace de conectores, SDK | Concorrentes amarram o cliente ao seu conjunto de ERPs | INT-02, INT-13 |
| **D7** | **Multi-tenant / white-label** ✅ *aprovado* | **Nenhum player do mapa inteiro tem.** Campo vazio para agências, revendas e consultorias de polo. Fundação entra na Onda 0; a superfície comercial na Onda 4 | PLT-03, PLT-09, PLT-10 |

---

## 19. Plano de ondas

| Onda | Nome | Objetivo | Módulos | Critério de saída |
|---|---|---|---|---|
| **0** | **Fundação** | Dados entrando e canal em pé | PLT-01…04, INT-01…05, CAN-01…03, CTT-01…04 | Base do GeraCloud sincronizada com carga histórica; números conectados; contatos unificados |
| **1** | **Atender** | Operação de atendimento funcionando | INB-01…11, CAN-04/05, CTT-05…08/10, INT-06…09, PLT-05/07 | Equipe atende pelo GeraCRM em produção, com fila, janela de 24h e protocolo |
| **2** | **Vender** | CRM, RFV, rotina comercial **e pedido na conversa** | CRM-01…09, RFV-01…06, TSK-01…04, **PED-01…11**, GES-01…04, BI-01/03/04/05/09, IA-01…04, CAT-01/02/04, FDV-01, MOB-01…07, INB-12…18 | Vendedora abre o app, sabe com quem falar, o que dizer **e fecha o pedido sem sair da conversa**; gestor vê meta e ranking |
| **3** | **Escalar** | Campanhas, IA autônoma e força de vendas | CMP-01…14, IA-05…09, RFV-07…09/12, TSK-05…07, **PED-12…16**, BI-02/06/08/10, INB-19…21, CAN-06…08, INT-10…12 | Campanha com ROI medido; IA qualificando sozinha; representante tirando pedido offline em campo |
| **4** | **Diferenciar** | O que nos tira do mar vermelho | D1…D7 completos: TSK-08, RFV-10/11, INB-22…24, CMP-15…18, IA-10…13, GES-06…10, BI-07/11, CAT-05/06, FDV-06/07, PLT-09/10, INT-13 | Produto sem paralelo no mercado brasileiro |

**Ondas 0–2 = produto vendável.** Ondas 3–4 = produto competitivo e depois único.

---

## 20. Decisões estruturais tomadas — e o que cada uma obriga

### 20.1 Multi-tenant desde a modelagem ✅ (PLT-03)

Todo acesso a dado carrega `tenant_id` desde a primeira tabela. Consequências:
- Isolamento verificável em **toda** consulta — não pode depender da disciplina do desenvolvedor
- Chaves, tokens de integração, números de WhatsApp e templates são **por tenant**
- Sobe para **PLT-03 na Onda 0** (era item de fundação, agora é premissa transversal)
- **Destrava PLT-09/PLT-10 (white-label e revenda) na Onda 4 sem reescrita** — o diferencial D7 fica disponível quando a venda pedir
- Custo: consultas e índices mais cuidadosos desde o início; benefício: nenhum retrofit

### 20.2 Tech Provider na Meta ✅ (CAN-01)

- **Enrollment no Tech Provider Program é obrigatório** — iniciar antes da primeira linha de código do EP-03 (App Review + Business Verification demoram)
- **Embedded Signup** embutido no onboarding: o cliente conecta o próprio número dentro do nosso produto
- **O cliente paga a Meta direto** — precisa cadastrar método de pagamento na conta dele. Isso vira **passo obrigatório do onboarding** e **item do painel de saúde do número** (CAN-04, campo "pagamento OK")
- Nossa receita na Onda 0–2 é **só a assinatura**. Sem risco de crédito, sem billing de mensagem
- **Reavaliar Solution Partner na Onda 3**, quando o volume agregado justificar assumir inadimplência em troca de margem por mensagem
- Ainda assim **medimos o custo por mensagem** (CMP-12, BI-11): o cliente paga a Meta, mas quem mostra o ROI somos nós

### 20.3 Só API Oficial nas Ondas 0–2 ✅ (CAN-10)

- Arquitetura de canal é **webhook stateless** — sem sessão persistente por número, sem WebSocket de longa duração
- Reduz drasticamente o custo de servidor por número conectado
- Elimina o risco de banimento do número do cliente — condição para vender ao alvo (faturamento ≥ R$ 150 mil/mês)
- **CAN-10 sai do backlog das Ondas 0–2.** Se voltar na Onda 3, entra como **módulo isolado**, com sua própria infraestrutura, nunca misturado ao caminho oficial

### 20.4 Genérico com perfil de vertical ✅

- Modelo de dados **neutro**: produto tem atributos variáveis (`referência`, `cor`, `tamanho`, `grade`) como estrutura configurável, não como coluna fixa de moda
- **Perfil de vertical** ativável define: nomenclatura da UI, atributos obrigatórios, regras de pedido mínimo, faixas de RFV padrão e templates de playbook
- Perfil "Moda Atacado" é o primeiro — nasce completo, porque é onde está o cliente inicial e a referência (Tailor/Modall)
- Permite atacar autopeças, distribuição de alimentos e material de construção depois **sem reescrever o núcleo**
- Impacto no escopo: CAT-01, FDV-04 e RFV-01 passam a ser configuráveis por perfil, não hard-coded

### 20.5 Decisão comercial ainda aberta

| Decisão | Contexto |
|---|---|
| **Modelo de cobrança** | O nicho cobra **por número de WhatsApp** (Tailor R$ 297/número) ou por faixa de volume (Modall R$ 347→1.497). Cobrar por usuário nos deixa fora do padrão de comparação do mercado. **Recomendação: por número**, alinhado à percepção de valor (cada número é uma vendedora produzindo) |

---

## 21. Rastreabilidade

Total de funcionalidades catalogadas: **~150**, distribuídas em 15 módulos e 5 ondas.

Cobertura por origem:
- **Tailor** — paridade praticamente completa (todas as telas das 38 capturas viraram item)
- **Modall** — IA de atendimento, jargão do setor, performance por vendedora
- **Mercos / ViaShopModa** — força de vendas, tira-pedidos, offline, tabela de preço, grade
- **ZAX** — recorte de capacitação e gestão de equipe
- **Dito** — RFV com histórico, agenda do vendedor, predição de churn
- **Mercado geral** — inbox, setores, SLA, CSAT, anti-ban, LGPD
- **★ Nossos** — 7 diferenciais, 25 itens

**Próximo documento:** definição de stack e arquitetura — módulos, limites de contexto, custo de servidor por módulo e escolhas técnicas por desafio (tempo real, fila de disparo, RFV analítico, IA, mobile offline).
