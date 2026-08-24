# A rede de pesca — geração de demanda e gestão do tráfego pago

> ⚠️ **Este documento é a montante de todos os outros.** `loop-de-dados.md` mede, `roteamento-do-lead.md`
> distribui, `arquitetura-agentes.md` opera — mas nada disso existe se a rede não pescar. Aqui está
> o mecanismo que **produz** o lead, antes de qualquer WhatsApp.

## 1. Duas redes, não uma

A decisão AMK-011 (nascer na família drezz) cria **duas operações de aquisição diferentes**, e
confundi-las é o erro mais caro possível — elas têm público, ticket, ciclo e formato distintos.

| | **Rede A — a nossa** | **Rede B — a do cliente** |
|---|---|---|
| Quem anuncia | Gera3 | a loja que usa o drezz/GeraCRM |
| Quem é pescado | **lojista** (dono de loja de moda) | **consumidor final** da região da loja |
| Natureza | B2B SaaS | B2C local |
| Universo | ⚠️ **pequeno e identificável** — milhares, não milhões | grande, mas com raio geográfico |
| Ciclo | semanas, decisão racional | dias ou horas, decisão por desejo |
| Ticket | assinatura recorrente | venda avulsa com recompra |
| Sinal de sucesso | conta ativada e usando | pedido no PDV |

⚠️ **A Rede A vem primeiro** — é dogfooding com dado próprio, risco contido, e o resultado vira
material de venda. E é a rede mais difícil das duas: universo pequeno significa que **público
errado queima verba rápido**, sem volume para diluir o erro.

⚠️ **A Rede B é o produto.** Ela precisa ser suficientemente padronizável para rodar em N lojas com
o mesmo playbook (`roteiro.md`, Fase 5) — senão cada cliente vira um projeto e a margem some.

## 2. A decisão que define tudo: para onde o anúncio manda

Não é detalhe de mídia — é **decisão de arquitetura**. Ela determina se a janela de 24h nasce
aberta, se é preciso template aprovado, e qual atribuição sobrevive.

| Destino | Quem escreve primeiro | Disponível para cliente? | Atribuição |
|---|---|---|---|
| **LP / catálogo → link `wa.me`** | ✅ **o lead** | ✅ **é o nosso caminho** (AMK-012/015) | UTM + `gclid` + ⚠️ **código na mensagem pronta** |
| **Click-to-WhatsApp (CTWA)** | ✅ o lead | ❌ exige Meta — deferida (AMK-012) | `ctwa_clid` + referral |
| **Lead Ads / formulário** | ⚠️ **nós** — outbound | ⚠️ tecnicamente possível, **desaconselhado** | webhook limpo |

### O veredito: o modo de entrada é CONFIGURÁVEL por campanha

Com a Meta deferida (AMK-012) o CTWA saiu do desenho — mas **o que o tornava valioso não era o
formato: era o lead escrever primeiro.** Um link `wa.me` na landing page entrega a mesma
propriedade, em qualquer plataforma de anúncio.

E como nem toda campanha quer o mesmo comportamento, **o modo de entrada é declarado na campanha**
(AMK-016), não fixado no produto:

| `modo_entrada` | Como o lead chega | Quem inicia | Agente autônomo |
|---|---|---|---|
| **`inbound_wa`** | LP → botão "Falar no WhatsApp" (`wa.me`) | ✅ **o lead** | ✅ permitido |
| **`outbound_formulario`** | LP/Lead Ads → formulário | ⚠️ **nós** | ❌ ⚠️ **fila humana obrigatória** |

⚠️ **A escolha do modo carrega a consequência junto, em código.** Não é o operador que lembra de
desligar o agente numa campanha de formulário — é a campanha que declara o modo, e o roteamento
obedece. Mesma disciplina do ADR-008 (capacidade declarada) e do ADR-021 (o risco fica **visível na
interface**): o produto degrada, não quebra, e a degradação aparece na tela.

#### `inbound_wa` — o caminho recomendado

```
Anúncio ──▶ LP / catálogo ──▶ botão "Falar no WhatsApp"
                                     │
                 wa.me/55...?text=Olá, vi o anúncio [ref: A7K2Q]
                                     │
                                     ▼
                   o LEAD envia a primeira mensagem  ← inbound
```

- ⚠️ **Mantém a operação inbound**, que é o que autoriza o agente autônomo no canal não-oficial
  (AMK-014). Responder quem escreveu é o uso normal do canal; abordar quem não escreveu é o padrão
  que derruba número.
- **Sem template e sem janela** — no não-oficial é texto livre (ADR-021).
- ⚠️ **A atribuição sobrevive por um código na mensagem pronta.** A LP gera um id por sessão, guarda
  `gclid` + UTM + página contra esse id, e injeta no `?text=`. A primeira mensagem chega com o
  código — **é o nosso `ctwa_clid`, feito à mão**.

⚠️ **O código é editável, e esse é o ponto frágil.** O lead pode apagar o texto antes de enviar. O
desenho precisa assumir isso: o parser aceita o código em qualquer posição da primeira mensagem; sem
código, o lead entra com origem **parcial** (sabemos que veio da LP pelo número discado, não de qual
anúncio); e ⚠️ **a taxa de código perdido é métrica de saúde** — se subir, a atribuição está furando.

#### `outbound_formulario` — disponível, com o preço declarado

Existe porque há casos legítimos: captação para lista, lead que prefere formulário, campanha em que
o WhatsApp não é o canal de resposta. O que ele **custa**:

- ⚠️ **Fila humana obrigatória.** O agente não aborda — nem primeira mensagem, nem follow-up.
- ⚠️ **Risco de banimento sobe no canal não-oficial**, porque o lead não pediu contato no WhatsApp:
  taxa de resposta cai, bloqueio sobe, e o número paga. A tela precisa dizer isso ao criar a
  campanha, como já faz com o risco do canal (ADR-021).
- **Speed-to-lead depende de gente disponível** — o argumento comercial 24/7 não vale nessa campanha,
  e isso tem de ser dito ao cliente **antes**.
- No dia em que a Meta entrar (AMK-012 é reversível), este modo ganha **template HSM** e vira uma
  opção bem menos arriscada.

### Onde entra o catálogo

`apps/catalogo` (SSR, link compartilhável, com rastreio de comportamento — CAT-03) é a landing page
natural: abre rápido em 4G, gera preview no WhatsApp e já mostra grade e preço.

⚠️ **Ele está marcado "aguardando Onda 2" e não existe.** Sem CTWA, o anúncio precisa de destino —
então o catálogo (ou uma LP mínima com o botão `wa.me` e o código de sessão) **deixa de ser dívida da
Onda 2 e vira pré-requisito da Fase 1**. É a consequência mais cara de AMK-012/015.

## 3. Públicos: o ativo que nenhuma agência tem

Aqui está a vantagem estrutural da operação, e ela não vem da mídia — vem do ERP.

| Público | Fonte | Por que é raro |
|---|---|---|
| **Semelhante de comprador real** | clientes do ERP com **valor de compra** | ⚠️ quase toda agência gera semelhante a partir de *lead* ou de evento de pixel. Nós geramos a partir de **quem realmente comprou, com quanto gastou**. |
| **Semelhante do topo do RFV** | as 11 faixas RFV, com histórico temporal | procurar quem se parece com o **melhor** cliente, não com o cliente médio |
| **Exclusão: já é cliente** | `contato` com `qtd_vendas > 0` | ⚠️ pagar para anunciar aquisição a quem já compra é desperdício puro — e ninguém corrige |
| **Exclusão: já está na conversa** | conversa/atendimento aberto | o lead já está sendo atendido; anunciar de novo é gastar duas vezes pelo mesmo |
| **Exclusão: opt-out** | `contato.recebe_campanhas = false` | ⚠️ ver abaixo |
| **Reativação** | RFV "em risco" / "perdido" | público **quente** e barato, que a prospecção nunca alcança tão bem |

⚠️ **Opt-out deve alcançar a mídia paga, não só a mensagem.** No CRM o opt-out é invariante — vale
em todos os caminhos, inclusive disparo manual. Quem pediu para não ser contatado e continua sendo
perseguido por anúncio de remarketing recebeu um "não" que o sistema não honrou. É coerência de
produto antes de ser LGPD.

⚠️ **Cuidados práticos**: PII sempre **hasheada** antes de subir (SHA-256 normalizado); semente
pequena gera público ruim (as plataformas exigem mínimos, e abaixo de algumas centenas o
"semelhante" é ruído); e o público precisa ser **re-sincronizado**, porque cliente novo entra e
opt-out novo aparece toda semana.

⚠️ **Excluir cliente existente da prospecção, mas não da reativação.** São objetivos opostos: um
paga para achar quem não conhecemos; o outro paga para trazer de volta quem já comprou e sumiu.

## 4. A estrutura da rede

Três funções, com verba e métrica separadas. ⚠️ Misturá-las na mesma campanha destrói a leitura —
o remarketing sempre parece melhor, porque pesca em água já preparada.

| Função | Público | O que mede | Expectativa |
|---|---|---|---|
| **Prospecção** | frio: semelhante, interesse, geo | custo por lead **qualificado** | ⚠️ o mais caro, e é assim mesmo |
| **Remarketing** | quem interagiu, abriu catálogo, não respondeu | custo por conversa retomada | barato — ⚠️ e por isso engana |
| **Reativação** | RFV em risco/perdido (Rede B) | custo por pedido | ⚠️ compete com o WhatsApp, que já faz isso **de graça** |

⚠️ **A reativação paga só se justifica onde o WhatsApp não alcança**: contato sem número válido,
opt-out de mensagem que não é opt-out de anúncio, ou quem não responde há meses. Pagar mídia para
falar com quem o CRM alcança sem custo é a forma mais silenciosa de queimar verba nesta operação —
e é um erro que só quem tem o CRM do lado consegue enxergar.

Sobre a **otimização de lance**: não é nossa (AMK-010). A plataforma decide melhor. Nosso trabalho
é **estrutura, público, criativo e qualidade do sinal devolvido** — e é o sinal que faz a
plataforma buscar cliente bom em vez de lead barato (`loop-de-dados.md` §3).

## 5. Oferta e ângulo — o que o agente não faz

⚠️ É o bloco de menor automatizabilidade e maior impacto (`limites-dos-agentes.md`). Nenhum volume
de criativo salva uma oferta que o mercado não quer pelo preço pedido.

O que o humano define e o agente executa:

- **A oferta**: condição comercial, primeiro pedido, prazo, frete, pedido mínimo. Não é desconto.
- **O ângulo**: o problema que a peça ataca (margem, giro, exclusividade regional, reposição rápida).
- **A prova**: número real, caso real, foto real.
- ⚠️ **A coerência anúncio ↔ destino**: prometer no anúncio o que a conversa não entrega gera lead
  qualificado-negativo — o pior tipo, porque **custa caro e ainda ocupa atendente**.

O Pesquisador acelera isso com a **Meta Ad Library** (pública, com API): anúncio que o concorrente
mantém no ar há meses está pagando a própria veiculação. É o insumo mais barato que existe.

## 6. Como se mede a rede (⚠️ não é CPL)

CPL é métrica de vaidade quando existe ERP do outro lado. A cadeia inteira, **por origem**:

```
impressão → clique → lead → qualificado → conversa respondida → pedido → venda efetivada
                      │         │                                          │
                    CPL     custo por                              custo por venda
                          lead qualificado                          + ROAS exato
```

⚠️ **O funil por origem é instrumento de diagnóstico, não relatório.** Onde ele quebra diz o que
consertar — e evita culpar a mídia por problema que não é dela:

| Etapa fraca | O problema está em |
|---|---|
| clique → lead | destino: LP lenta, catálogo confuso, promessa que não se sustenta |
| lead → qualificado | segmentação ou promessa do criativo: veio o público errado |
| qualificado → pedido | ⚠️ **oferta ou time de vendas** — não é mídia |
| pedido → venda | efetivação no ERP: crédito, estoque, prazo |

⚠️ **CPL caindo junto com a taxa de qualificação não é vitória** — é tráfego lixo entrando mais
barato. É o sinal nº 1 do `guardrails.md` §6, e o painel fica *melhor* enquanto a operação piora.

## 7. O que isso acrescenta ao backlog

Épicos novos, detalhados em [`backlog-tecnico.md`](backlog-tecnico.md): destino e entrada
(AQ-36), sincronização de públicos a partir do ERP/RFV (AQ-37), públicos de exclusão incluindo
opt-out (AQ-38), e o funil por origem como instrumento (AQ-39).
