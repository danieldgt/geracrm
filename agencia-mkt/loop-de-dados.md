# O loop de dados — identidade, atribuição e devolução

> ⚠️ **Este documento descreve a Fase 1 do roteiro, e ela vem antes de qualquer automação de
> campanha.** Agente otimizando com dado errado não erra mais devagar que um humano — erra mais
> rápido e em mais contas ao mesmo tempo.

## 1. Identidade: um `lead_id` que atravessa a cadeia

Sem um identificador nosso viajando do clique até a venda, não existe atribuição — existe
adivinhação com dashboard bonito.

```
clique ──▶ landing page ──▶ formulário/CTWA ──▶ contato ──▶ conversa ──▶ pedido ──▶ venda (ERP)
   │            │                  │                                                    │
   └── click_id └── utm_*          └── lead_id ─────────── mesmo id ────────────────────┘
```

O que precisa ser capturado e persistido **no momento da entrada**. ⚠️ **É 1:N com o `contato`,
não 1:1** — o mesmo contato pode chegar por um anúncio hoje e por outro daqui a três meses, e a
origem nova **não apaga a primeira**. Guardamos todos os toques e declaramos o modelo de
atribuição na consulta (primeiro toque × último toque), pela mesma disciplina de AMK-009:

| Campo | Origem | Observação |
|---|---|---|
| `utm_source/medium/campaign/content/term` | query string da LP | o que o cliente vê no relatório |
| `plataforma` | `meta` \| `google` \| … | |
| `campanha_externa_id`, `conjunto_externo_id`, `anuncio_externo_id` | Lead Ads / URL / referral do CTWA | ⚠️ o id da plataforma é a chave real; UTM é texto livre e o cliente digita errado |
| `click_id` | `fbclid`, `gclid`, `wbraid`, `gbraid` | ⚠️ **é o que permite devolver a conversão** — sem ele, offline conversion depende de correspondência por telefone/e-mail hasheado |
| `landing_page`, `referrer` | LP | |
| `consentimento_texto`, `consentimento_em` | formulário | LGPD — ver `guardrails.md` |
| `capturado_em` | servidor | ⚠️ do servidor, não do navegador |

⚠️ **Click-to-WhatsApp**: a Meta entrega o contexto do anúncio no *referral* da primeira mensagem
do webhook. É o único momento em que ele chega — se o handler não persistir ali, o vínculo se perde
para sempre. É a falha de integração mais comum nesse formato.

⚠️ **Reconciliação com contato existente**: o telefone normalizado já é a chave primária de
reconciliação no CRM (`0008`, ADR-019). Um lead que já é cliente não vira contato novo — vira uma
**origem nova** para o mesmo contato. Daí a origem ser tabela própria, e não colunas em `contato`:
um contato pode ter várias origens ao longo do tempo, e a última não apaga a primeira.

## 2. Coleta: server-side, não só pixel

Pixel puro no navegador perde tipicamente **20–40% dos eventos** (bloqueadores, ITP, consentimento
negado) — o suficiente para o algoritmo aprender com metade da história. O padrão é enviar dos dois lados com o **mesmo `event_id`**, para a plataforma
deduplicar:

| Plataforma | Caminho server-side |
|---|---|
| Meta | Conversions API (CAPI) |
| Google | Enhanced Conversions / Offline Conversion Import |

⚠️ Dedup por `event_id` é obrigatória. Sem ela, o evento entra duas vezes e o ROAS aparece dobrado
— erro que ninguém percebe porque o número fica *melhor*.

## 3. Devolução: o loop que fecha, e o diferencial do produto

Este é o pedaço que quase nenhuma agência entrega, e que aqui é quase de graça — porque o
GeraCRM **já lê a venda efetivada do ERP**.

| Evento devolvido | Quando | Valor |
|---|---|---|
| `Lead` | lead capturado | sem valor (ou valor nominal) |
| `LeadQualificado` | Qualificador aprovou | ⚠️ **o evento que muda o jogo** |
| `Compra` | pedido efetivado no ERP | **valor real em centavos** |

Efeito prático: otimizando por lead, o algoritmo busca **lead barato**. Otimizando por venda com
valor (*value-based bidding*), ele busca **cliente que compra**. É a diferença entre CPL bonito e
receita.

⚠️ **A devolução é um fato com entrega própria** — pode falhar, precisa de retry, dead-letter e
registro. Por isso `Conversao` é entidade separada de `venda` (ver `encaixe-no-geracrm.md` §4).
O padrão de entrega já existe no repo: o despachante de `webhook_saida` (`0033`) faz cursor sobre
o outbox, HMAC, backoff e dead-letter após 8 tentativas. O Conversor segue a mesma forma.

⚠️ **Janela de importação**: as plataformas recusam conversão offline fora da janela permitida
(tipicamente ~90 dias, e nunca anterior ao clique). Venda B2B com ciclo longo pode cair fora — a
falha precisa ser **nomeada e visível**, não engolida. Falha de negócio é retorno tipificado, não
exceção (regra da casa, PED-08).

## 4. ROAS honesto — herdando a régua que já existe

`0036` e `campanha-analise.ts` já codificam a disciplina certa. Ela se traduz assim para mídia:

| Camada | Definição | Natureza |
|---|---|---|
| **Exata** | o lead entrou com `click_id`/`anuncio_externo_id` **e** virou pedido efetivado | fato |
| **Estimada** | comprou dentro da janela declarada, sem vínculo direto | correlação |
| **Custo** | soma de `midia_metrica_dia.custo_centavos` no mesmo recorte | fato |

⚠️ **Nunca somar exata e estimada.** A janela é **sempre declarada** ao lado do número. Um painel
que mostra "R$ 120 mil atribuídos" sem dizer a janela e sem separar as camadas está mentindo — e
quando o cliente descobrir, o contrato acaba.

Duas métricas, sempre lado a lado e rotuladas:

```
ROAS_exato    = receita_exata_centavos    ÷ custo_centavos
ROAS_estimado = receita_estimada_centavos ÷ custo_centavos   (janela: N dias)
```

⚠️ Custo vem da plataforma em **micros** (Google: 1.000.000 = 1 unidade) ou em **float com ponto**
(Meta). A conversão para centavos inteiros acontece **no adaptador**, na borda. Float não atravessa
para o domínio — regra da casa.

## 5. O que a atribuição não resolve

Honestidade que precisa estar escrita, porque vira conversa com o cliente:

- **Último clique é ficção útil.** Ele credita o canal que fecha, não o que gerou a demanda.
- Cada plataforma **reivindica a mesma conversão**. Somar os dashboards dá mais venda do que o ERP
  registrou. A fonte de verdade é o nosso banco, nunca o painel da plataforma.
- Para decidir **alocação entre canais**, o instrumento é **incrementalidade** (geo holdout,
  conversion lift), não atribuição. Com volume, MMM.
- ⚠️ Agente nenhum corrige viés de atribuição. Ele só o automatiza e escala.
