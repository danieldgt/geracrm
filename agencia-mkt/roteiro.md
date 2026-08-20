# Roteiro — na ordem que reduz risco, não na ordem que empolga

⚠️ A ordem importa mais que o conteúdo. "Agente que gerencia campanha" é a **última** fase, não a
primeira: ele depende de dado confiável (F1) e de guardrails testados (F0), e sem os dois só
automatiza o erro.

## Fase 0 — Observar (nenhum centavo de mídia em risco)

**Só leitura.** Conectar as contas de anúncio, sincronizar métrica e custo, e produzir relatório e
alerta. Zero risco de escrita, valor imediato para o cliente, e é onde se aprende o **formato real
das decisões** que os agentes vão tomar depois.

- Schema `midia_*` (conta, campanha, conjunto, anúncio, criativo, `midia_metrica_dia`) com RLS.
- Adaptador de **leitura** Meta / Google, atrás de porta do nosso domínio, capacidades declaradas
  (mesmo padrão do ADR-008).
- ⚠️ Custo convertido para **centavos inteiros na borda** (micros no Google, float na Meta).
- Painel de mídia no console + relatório diário automático.
- **Vigia de anomalia** sobre `metrica_janela`/`alerta` (`0031`) — infra já existe.
- ⚠️ **Iniciar o credenciamento no Google Ads** — *developer token* (básico → padrão) e conta
  **MCC**. É o caminho crítico externo desta configuração (AMK-015), e leva dias a semanas.
- ⚠️ **Construir a LP com botão `wa.me` e código de sessão** (AQ-44). Sem CTWA, o anúncio precisa
  de destino — isso promoveu `apps/catalogo` de dívida da Onda 2 a **pré-requisito**.

**Saída da fase:** o cliente recebe todo dia um relatório que ele não tinha, e nós sabemos ler as
contas dele sem tocar em nada.

## Fase 1 — Fechar o loop de dados (a fase que define o produto)

Antes disto, qualquer otimização automática é chute informado. Ver `loop-de-dados.md`.

- `midia_lead_origem` 1:1 com `contato` — UTM, ids da plataforma, `click_id`, consentimento.
- Ingestão de lead: **webhook de Lead Ads**, formulário de LP e ⚠️ **referral do Click-to-WhatsApp**
  (o contexto do anúncio chega uma única vez, na primeira mensagem — perdeu, perdeu).
- Reconciliação com contato existente pelo telefone normalizado (`0008`, ADR-019).
- CAPI / Enhanced Conversions com `event_id` compartilhado para dedup.
- **Conversor**: devolve `Compra` com **valor real do pedido efetivado no ERP**, com retry,
  dead-letter e falha visível — mesma forma do despachante de `webhook_saida` (`0033`).
- ROAS exato × estimado, separados e com janela declarada.
- **Públicos**: semelhante a partir de **comprador real do ERP** com valor, e exclusões
  (já é cliente, já está em conversa, ⚠️ opt-out). A Fase 1 devolve **dois** sinais — conversões
  e públicos.

**Saída da fase:** conseguimos dizer, com auditoria, quanto **cada anúncio** faturou no ERP.
É o argumento comercial inteiro.

## Fase 2 — Leads (o maior salto de ROI, e o mais fácil de vender)

- Caminho **por evento** (outbox → NOTIFY) para lead novo: latência de segundos, não de 5 minutos.
- **Motor de roteamento** (`roteamento-do-lead.md`): agente ou fila humana, ⚠️ com **default
  humano**, cliente de alto valor nunca triado por robô, e o **`modo_entrada` da campanha**
  decidindo se o agente pode atuar (AMK-016).
- **Qualificador** com score e ⚠️ **motivo registrado**.
- **SDR agent** na **Rede B**, identificado como assistente, ⚠️ **só em conversa inbound**
  (AMK-014), com base de conhecimento versionada, limite de escopo, handoff por regra e por
  incerteza, e botão de desligar. Na **Rede A**, copiloto — a pessoa envia.
- Nurture de lead frio pelo motor agendado que já existe (`automacao-motor.ts`).
- Painel de auditoria do agente: leads atendidos, qualificados, descartados, **tempo até
  qualificação**, canal, origem.

⚠️ **A dependência mudou de lugar.** AMK-014 substituiu "exige canal oficial" por "só inbound":
o SDR autônomo roda no não-oficial **desde que o lead escreva primeiro**. Quem garante isso é a
LP com `wa.me` (AQ-44) — que por isso virou o pré-requisito real da Fase 2, no lugar do registro
na Meta.

**Saída da fase:** speed-to-lead de segundos, 24/7 — vendável isoladamente, inclusive para cliente
que já tem outra agência.

## Fase 3 — Criativo em volume

- **Fábrica de criativo**: N variações por ângulo, saída tipada, guidelines por cliente.
- **Revisor de conformidade** como gate obrigatório antes de qualquer publicação.
- **Analista de performance**: fadiga (frequência, CTR caindo, CPM subindo), decisão
  escalar/manter/matar com piso de massa.
- Biblioteca de criativo versionada, com histórico de desempenho por peça.

**Saída da fase:** rotação de criativo deixa de ser gargalo de designer.

## Fase 4 — Escrita em veiculação (o que todo mundo quer fazer primeiro)

Em ordem crescente de risco, e só depois de dry-run com histórico batendo:

1. **Pausar** criativo ruim — risco baixo, reversível.
2. **Publicar** criativo novo em estrutura existente — risco médio, com aprovação.
3. **Ajustar orçamento** dentro do delta — ⚠️ risco alto, respeitando a *learning phase*.
4. **Criar estrutura nova** — sempre com aprovação humana.

**Saída da fase:** o gestor humano opera 20–30 contas em vez de 5–8.

## Fase 5 — Escala da operação

- Console da agência: visão agregada dos N tenants (⚠️ AMK-005 — **sem furar RLS na API**).
- Onboarding de cliente novo como processo, não como projeto.
- Incrementalidade (geo holdout / conversion lift) para decidir alocação entre canais.
- Playbooks por vertical, herdando o conceito de perfil de vertical do ADR-004.

## Dependências que não dependem de nós

| Dependência | Prazo | Bloqueia |
|---|---|---|
| **Google Ads: developer token + MCC** | dias a semanas | 🔴 **F0 inteira para clientes** (AMK-015) |
| Acesso às contas de anúncio dos clientes via MCC | dias | F0 |
| ~~Meta Business Verification + App Review~~ | ⏸️ **deferido** (AMK-012) | CTWA, template HSM e Marketing API em conta de cliente |
| ERP integrado no cliente | ✅ já existe na base drezz/GeraCloud (AMK-011) | ⚠️ F1 — sem ERP não há receita real; **por isso o piloto é a família drezz** |

⚠️ **O credenciamento no Google começa na Fase 0**, em paralelo ao desenvolvimento — é o mesmo
erro que `../docs/prontidao-para-inicio.md` já identificou no CRM: o caminho crítico é externo.
A Meta saiu da lista por decisão (AMK-012), mas isso **transferiu** a criticidade para o Google e
para a landing page, não a eliminou.
