# Visão de negócio

## O problema do mercado

Uma agência de tráfego pago tradicional tem três limites estruturais:

1. **Vende CPL, entrega CPL.** Ela otimiza o que consegue medir — custo por lead — e o cliente
   descobre meses depois que o lead barato não virava venda. A agência não tem acesso ao que
   aconteceu depois do formulário.
2. **Não escala por gestor.** Um gestor bom cuida de 5 a 8 contas. Acima disso a qualidade cai,
   porque o trabalho é repetitivo e manual: montar campanha, trocar criativo, montar relatório.
3. **O lead esfria na mão do cliente.** A agência entrega o lead e o cliente demora 40 minutos
   para responder. A conversão despenca e a culpa sobra para a mídia.

Os três se resolvem com a mesma coisa: **estar dentro do CRM do cliente**, não fora dele.

## O que vendemos

Não "gestão de tráfego". Vendemos **um número de ROAS que o cliente consegue auditar**, e a
operação que o produz:

| Entrega | O diferencial |
|---|---|
| Veiculação em Meta / Google | commodity — todo mundo faz |
| **Resposta ao lead em segundos**, 24/7 | muda conversão em múltiplos, não em pontos percentuais |
| **Qualificação com motivo registrado** | o cliente vê *por que* o lead foi descartado |
| **ROAS até a venda efetivada no ERP** | ⚠️ ninguém no mercado entrega isso |
| Criativo em volume, com rotação por fadiga | escala sem contratar designer por conta |

⚠️ O quarto item é o produto. Os outros três são o que torna ele possível.

## Por que o GeraCRM torna isso viável

A cadeia que quase ninguém consegue fechar já está montada aqui:

```
anúncio → clique → lead → conversa (WhatsApp) → qualificação → pedido → ERP efetiva → receita real
   ▲                                                                                        │
   └──────────────── devolve a conversão COM VALOR para a plataforma ───────────────────────┘
```

O elo que falta no mercado é o penúltimo: quase nenhuma agência sabe qual venda veio de qual
anúncio, porque a venda mora no ERP do cliente e o ERP não conversa com o Gerenciador de Anúncios.
O GeraCRM **já lê venda e pedido do ERP** (ADR-005, conectores com capacidade declarada). Fechar o
loop deixa de ser um projeto de integração e vira uma tabela a mais.

Consequência prática: podemos otimizar por **valor de venda**, não por volume de lead. É o que faz
o algoritmo da plataforma parar de buscar lead barato e começar a buscar cliente bom.

## A quem vendemos

O alvo natural é o mesmo do GeraCRM — **venda B2B recorrente com ERP** (moda atacado como primeira
vertical) — por três razões:

- O ticket e a recorrência sustentam fee de gestão.
- **O ERP existe**, então a receita real é obtenível. Sem ERP, o loop não fecha e o produto vira
  agência comum.
- É a base de clientes que já será conquistada pelo CRM. A agência é *upsell*, não prospecção fria.

⚠️ Cliente sem ERP integrado é venda possível, mas é **outro produto** — entrega CPL, não ROAS.
Vender ROAS para quem não tem ERP é prometer o que não se sustenta.

### A base de partida: a família drezz (AMK-011)

O alvo não é hipotético. O drezz é PDV de lojas de moda sobre o **GeraCloud (~150 lojas ativas)**,
e `../docs/aproveitamento-drezz.md` já concluiu que *"cliente do drezz é loja de moda com PDV —
exatamente o perfil de quem precisa de CRM com WhatsApp"*. Três consequências:

- ⚠️ **O pré-requisito duro já está satisfeito**: ERP integrado, logo receita real, logo o loop
  fecha desde o primeiro cliente.
- **Custo de aquisição perto de zero** — é upsell sobre base cativa, não prospecção fria.
- **Mesma vertical do CRM** (moda, grade cor × tamanho): o perfil de vertical do ADR-004 nasce
  completo, sem abstrair no escuro.

A ordem é: **Gera3 anunciando o próprio produto → lojas da base drezz → clientes de fora.**
⚠️ A terceira etapa só depois de a atribuição estar madura e de estar claro o que é regra do
domínio e o que é peculiaridade de moda.

## Como se cobra

Três linhas, e a terceira é a que importa:

| Linha | Modelo | Observação |
|---|---|---|
| **Assinatura da plataforma** | fee mensal por tenant | previsível, cobre custo de infra e IA |
| **Fee de gestão** | valor fixo por conta, ou % do investimento | ⚠️ % do investimento **premia gastar mais** — conflito de interesse declarado |
| **Performance** | % sobre receita atribuída **exata** | só é honesto porque a atribuição é auditável |

⚠️ **A mídia é paga pelo cliente, direto na plataforma.** A agência nunca coloca a veiculação no
próprio cartão — isso a transforma em financiadora, com risco de crédito e de inadimplência sobre
dinheiro que não é dela. É a mesma decisão do ADR-002 (o cliente paga a Meta direto pelas
mensagens), aplicada à mídia. Formalizado em [`decisoes.md`](decisoes.md), AMK-002.

## A margem: o que muda com agentes

O ganho não é "usar IA". É aritmético:

| | Agência tradicional | Com a operação de agentes |
|---|---|---|
| Contas por gestor | 5–8 | 20–30 |
| Tempo de resposta ao lead | 10–60 min (horário comercial) | segundos, 24/7 |
| Variações de criativo/mês | 5–15 | 50–200 |
| Relatório | trabalho manual semanal | subproduto do sistema |
| Base da otimização | CPL | receita efetivada |

O gestor humano deixa de operar e passa a fazer o que os agentes não fazem: estratégia, oferta,
relação com o cliente e julgamento sobre o que a curva não explica.

## O que a operação NÃO faz

Decisões de escopo, não dívida:

- **Não cria a oferta do cliente.** Oferta ruim não é salva por mídia.
- **Não faz branding, site institucional ou social orgânico.** Adjacente e distrai.
- **Não intermedia pagamento de mídia** (AMK-002).
- **Não opera categorias especiais** de anúncio (crédito, emprego, moradia, saúde, política) na
  primeira fase — as regras de segmentação e as revisões da plataforma são um produto à parte.
- **Não promete otimização automática de lance.** A plataforma faz melhor; nosso agente propõe
  estrutura e criativo, não fica mexendo em lance (ver `arquitetura-agentes.md`).

## O risco que mata o negócio

Ordenados por probabilidade × dano:

| Risco | Mitigação |
|---|---|
| **Agente gasta mal e queima verba do cliente** | teto no código, delta máximo por ciclo, dry-run, kill switch — `guardrails.md` |
| **Conta de anúncio ou Business Manager banida** | só API oficial; *Compliance Reviewer* antes de publicar |
| **Número de WhatsApp banido pelo volume do SDR** | ⚠️ ADR-021: agente autônomo só no canal oficial — ver AMK-004 |
| **Otimizar CPL e degradar o LTV silenciosamente** | o loop de dados vem **antes** da automação de campanha (Fase 1 do roteiro) |
| **Vazamento de dado de lead entre clientes** | RLS (ADR-001) — herdado, e testado por tenant em toda tabela nova |
| **LGPD: lead sem base legal registrada** | consentimento gravado com texto e timestamp — `guardrails.md` |
