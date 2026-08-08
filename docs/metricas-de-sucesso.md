# GeraCRM — Métricas de sucesso

> Fecha a lacuna §4.3 de [`prontidao-para-inicio.md`](./prontidao-para-inicio.md): existe critério de
> saída **técnico** por onda; não existia métrica de **produto**.
>
> Deriva de [`escopo-funcional-geracrm.md`](./escopo-funcional-geracrm.md) §19,
> [`backlog-epicos-geracrm.md`](./backlog-epicos-geracrm.md) §3,
> [`modelo-de-dados.md`](./modelo-de-dados.md) §2.9/§5.5/§8,
> [`decisoes.md`](./decisoes.md) (ADR-002, ADR-005, ADR-008) e das skills
> `funil-de-vendas`, `geracrm-observabilidade`, `geracrm-whatsapp-meta`, `geracrm-ia`.

**O que este documento decide:** o que precisa acontecer com o **negócio do cliente** para cada onda
ter valido, e o que precisa ser **gravado desde a Onda 0** para essa resposta existir.

⚠️ **A urgência é de instrumentação, não de análise.** Métrica de venda é reconstituível a qualquer
momento (`venda` é fato imutável, e a carga histórica traz anos). **Métrica de atendimento não é**:
tempo de primeira resposta, conversa sem resposta e volume de conversa do dia anterior ao
`primeiro_corte`
**deixam de existir para sempre** se ninguém capturar antes. O produto que promete provar ROI não
pode ser o único sem linha de base.

---

## 0. Os cinco princípios

| # | Princípio | Consequência prática |
|---|---|---|
| **1** | **Métrica sem consulta escrita não existe** | A definição executável (SQL contra a réplica) é entregável da tarefa que cria a funcionalidade, não trabalho posterior. Entra na DoD do épico |
| **2** | **Métrica sem dono e sem decisão sai do painel** | Mesma disciplina de `geracrm-observabilidade`: alerta sem ação treina o time a ignorar. Vale igual para indicador |
| **3** | **Fonte declarada, sempre** | `erp` · `medido` · `export_antigo` · `declarado`. ⚠️ Declarado nunca é promovido a medido — mesma lógica de INV-56 (`confiavel`) e INV-42 (exata × estimada) |
| **4** | **Comparação é contra linha de base, nunca contra zero** | "1.200 mensagens enviadas" não é resultado. "Tempo de primeira resposta caiu de 47 min para 9 min" é |
| **5** | **Toda métrica de valor tem contra-métrica publicada ao lado** | §4. Sem isso, a equipe otimiza o número e degrada o negócio — e o painel aplaude |

**Legenda de alvo:** ✅ = alvo firme · **H** = hipótese, a calibrar contra a linha de base do primeiro
cliente antes da onda começar (§9, decisão nº 1) · — = observar sem alvo na primeira rodada.

---

## 1. Linha de base

### 1.1 A janela em que ela é obtível

```
        ┌── carga histórica (Onda 0) ──┐
        │                              │
──── anos de venda no ERP ─────────────┼──── operação no GeraCRM ────►
                                       │
   sombra (2 semanas, manual, em T-8) ─┤
                                       ▲
                          linha de base CONGELADA  =  marco `linha_base_congelada`
                                       ▲
                          corte do 1º número do cliente = marco `primeiro_corte`
```

⚠️ **A janela fecha no `primeiro_corte` e não reabre.** Depois dela, tudo que a equipe faz já é o
produto agindo — inclusive antes do login, porque a equipe muda de comportamento assim que sabe que
está sendo medida.

### 1.2 As métricas de linha de base

| ID | Métrica | Período mínimo | Fonte | Reconstituível depois? |
|---|---|---|---|---|
| **LB-01** | Receita mensal por filial e por vendedora | 24 meses | `venda` (ERP) | ✅ sim |
| **LB-02** | Compradores ativos no mês (contatos distintos com venda) | 24 meses | `venda` | ✅ sim |
| **LB-03** | Taxa de recompra em 90 dias | 24 meses | `venda` | ✅ sim |
| **LB-04** | Tempo até o 2º pedido — **mediana**, por coorte de 1º pedido | 24 meses | `venda` | ✅ sim |
| **LB-05** | Ticket médio **e mediana**; peças por pedido | 24 meses | `venda`, `venda_item` | ✅ sim |
| **LB-06** | Intervalo médio entre compras, por cliente | 24 meses | `venda` | ✅ sim |
| **LB-07** | Distribuição RFV da base no dia do `primeiro_corte` | foto | job de RFV sobre `venda` | ✅ sim (RFV é Onda 2; a foto se reconstrói) |
| **LB-08** | Qualidade cadastral: % com CNPJ, % com telefone válido, duplicidade estimada | foto | `contato_documento`, `contato_telefone`, `conflito_identidade` | ✅ sim |
| **LB-09** | Clientes "invisíveis": compraram nos últimos 12 meses e **não têm telefone** | foto | `contato` | ✅ sim |
| **LB-10** | **Conversas por dia**, por vendedora | 2 semanas | ⚠️ sombra / export | 🔴 **não** |
| **LB-11** | **Tempo até a primeira resposta** — mediana e p90 | amostra de 30 conversas/vendedora | ⚠️ sombra / export | 🔴 **não** |
| **LB-12** | **% de conversas entrantes sem resposta em 24 h** | 2 semanas | ⚠️ sombra | 🔴 **não** |
| **LB-13** | Mensagens em massa enviadas/mês e **custo atual** com elas | 3 meses | fatura BSP ou declarado | 🔴 **não** |
| **LB-14** | Custo das ferramentas atuais (Tailor, planilha, disparador, BSP) | mês | contrato/fatura | 🔴 **não** |
| **LB-15** | Nº de vendedoras, números em uso e horas/dia de atendimento | foto | declarado | 🔴 **não** |

🔴 **LB-10 a LB-15 são o único trabalho desta seção que não pode ser adiado.** LB-01 a LB-09 saem de
uma consulta rodada quando der.

### 1.3 Como obter cada uma

**Quando o dado está no ERP** — LB-01…LB-09 são consultas sobre a carga histórica. Duas restrições:

- ⚠️ **Nenhuma linha de base pode declarar período fora de `conexao_erp_cobertura`** (INV-56). Carga
  parcial que vira "recompra de 41%" é o mesmo erro de classificar cliente ativo como Perdido.
- ⚠️ **Sazonalidade de coleção domina o atacado de moda.** Toda comparação é **contra o mesmo mês do
  ano anterior**, nunca contra o mês passado — é o mesmo eixo que BI-03 já exige. A linha de base é
  um par: *nível* (12 meses) + *índice sazonal por mês*.

**Quando o dado está no sistema antigo** — três táticas, em ordem de preferência, e a fonte fica
gravada:

| Tática | Como | Fonte gravada | Custo |
|---|---|---|---|
| **1. Exportação** | Relatório do Tailor / planilha do disparador, importado como CSV | `export_antigo` | Horas. ⚠️ Conferir **cobertura** antes de usar: relatório que só tem conversa encerrada não mede sem resposta |
| **2. Medição do antes** | 2 semanas com a equipe ainda no sistema antigo; alguém mede à mão: contagem diária de conversas, amostra de 30 conversas por vendedora para tempo de resposta, contagem de sem resposta às 18h | `medido` | Uma pessoa, ~1 h/dia. **Não consome engenharia** e roda em paralelo à carga histórica |
| **3. Declarado** | O gestor responde. Registrar como **faixa** ("30 a 60 min"), nunca como número | `declarado` | Minutos, e vale o que vale |

⚠️ **Se o cliente opera em WhatsApp puro, existe uma quarta fonte quase gratuita:** a exportação de
conversa do próprio aplicativo carrega os horários de cada mensagem. Vinte conversas por vendedora
reconstroem LB-11 e LB-12 com fidelidade melhor que qualquer declaração.

⚠️ **Meça a sombra antes de anunciar a ferramenta à equipe.** Depois do anúncio, o tempo de resposta
melhora sozinho — e a Onda 1 perde o crédito por uma melhora que já tinha acontecido.

**A sombra tem semana no cronograma: `T-8`** (`entrada-do-primeiro-cliente.md` §7), duas semanas
**antes** da ficha de entrada — porque T-6 já é a conversa com o gestor sobre carteira e vendedoras,
e a partir dela a equipe sabe. Custo: uma pessoa do cliente, ~1 h/dia. **Não consome engenharia.**

⚠️ **O artefato tem nome e destino, e não é uma planilha solta.** A sombra produz
`docs/clientes/<cliente>/linha-de-base.md` e é **carregada em `linha_base_metrica`** (PLT-12, D-17),
com `fonte` (`export_antigo` \| `medido` \| `declarado`), `apurado_em` e, depois da conferência com o
cliente, `congelado_em`. Planilha no Drive some no primeiro rodízio de pessoa; e uma régua que
ninguém acha é uma régua que não existe quando alguém contesta o resultado.

### 1.4 Congelamento

A linha de base é **gravada, congelada e conferida com o cliente** antes do `primeiro_corte`:

- Vive em `linha_base_metrica` (§6.2), com `fonte`, `confiavel`, `apurado_em` e `congelado_em`.
- Congelada = imutável. Correção posterior entra como **nova linha** com `observacao`, nunca por
  `UPDATE` — o histórico da própria régua precisa ser auditável.
- ⚠️ **O cliente confere e concorda antes.** Linha de base apresentada junto com o resultado é linha
  de base contestada — e a contestação vem exatamente quando o número é bom.

### 1.5 As quatro armadilhas da comparação

| Armadilha | Por que engana | Tratamento |
|---|---|---|
| **Sazonalidade** | Virada em janeiro contra dezembro "prova" queda de 40% | Comparação YoY + índice sazonal (§1.3) |
| **Cobertura parcial** | Carga incompleta subestima recompra e infla "clientes novos" | INV-56 barra o período |
| **Mudança de mix** | Nova coleção/tabela de preço muda ticket sem o produto ter feito nada | Reportar ticket **e** peças/pedido lado a lado |
| **Queda de aprendizado** | Toda troca de ferramenta custa produtividade nas 2 primeiras semanas | Alvo da Onda 1 é **retomar** a linha de base em 30 dias, não superá-la (§2.2) |

---

## 2. Métricas por onda

Três famílias, sempre: **Adoção** (a equipe usa?) · **Operação** (funciona?) · **Negócio** (vale?).

⚠️ **A ordem importa.** Negócio ruim com adoção baixa é problema de adoção, não de produto — e
otimizar o produto nesse cenário é resolver a coisa errada. Nenhuma métrica de negócio é lida sem a
de adoção ao lado.

### 2.1 Onda 0 — Fundação

Não há tela nem usuário. A onda tem **duas** famílias, e um critério de produto que não é técnico.

| ID | Família | Métrica | Alvo | Fonte |
|---|---|---|---|---|
| **MO-01** | Operação | Cobertura da carga nos três fluxos | `completa` ✅ | `conexao_erp_cobertura` |
| **MO-02** | Operação | Reconciliação de contadores batendo (INV-57) | 100% ✅ | `mv_metricas_contato` × `contato` |
| **MO-03** | Operação | % da base com CNPJ e com telefone válido | medir, sem alvo — | LB-08 |
| **MO-04** | Operação | `conflito_identidade` abertos ÷ contatos | < 2% **H** | `conflito_identidade` |
| **MO-05** | Operação | Latência p95 da leitura síncrona ao ERP (E2-12) | < 2 s ✅ | métrica de aplicação |
| **MO-06** | Operação | Passos do onboarding que exigiram intervenção manual da Gera3 | ≤ 1 **H** | `onboarding_passo` |
| **MN-01** | Negócio | **Linha de base congelada e conferida com o cliente** | LB-01…LB-15 gravadas ✅ | `linha_base_metrica` |

> **A Onda 0 valeu se:** a base histórica está no CRM, reconciliada, **e existe uma régua congelada
> contra a qual a Onda 1 poderá ser julgada.** MO-06 é a métrica que prevê o custo de vender o
> segundo cliente — onboarding que só a Gera3 sabe fazer não escala.

⚠️ **MN-01 é critério de saída de produto da Onda 0 e não está no checklist técnico de
`plano-onda-0.md` §8.** Deveria estar — é o item que, faltando, invalida a avaliação das quatro
ondas seguintes.

### 2.2 Onda 1 — Atender

| ID | Família | Métrica | Definição | Alvo |
|---|---|---|---|---|
| **MA-01** | Adoção | **Vendedoras ativas/dia** ÷ vendedoras cadastradas | "Ativa" = ≥ 1 ação de escrita no dia (§9, nº 4) | ≥ 90% após 2 semanas **H** |
| **MA-02** | Adoção | Números da frota com tráfego no dia ÷ números conectados | | 100% ✅ |
| **MA-03** | Adoção | Mensagens enviadas/dia ÷ LB-10 (volume da sombra) | Mede se o volume real migrou | ≥ 80% **H** |
| **MA-04** | Adoção | 🔴 **Vazamento**: contatos com venda no período e **sem conversa** no CRM | O proxy possível de "atendeu por fora" | ≤ 15% e **caindo** **H** |
| **MO-07** | Operação | **Tempo até a primeira resposta humana** — mediana e p90 | Da entrante ao primeiro envio com `enviada_por_id` humano | mediana < 50% de LB-11 **H** |
| **MO-08** | Operação | % de conversas entrantes **sem resposta em 24 h** | | < 5% ✅ |
| **MO-09** | Operação | % de conversas que **perderam a janela** sem resposta | Custo direto: reabrir exige template pago | < 3% **H** |
| **MO-10** | Operação | Taxa de entrega por número | | ≥ 97% ✅ |
| **MO-11** | Operação | Tempo na fila até "Assumir atendimento" — p90 | INB-09 | < 10 min **H** |
| **MN-02** | Negócio | Receita mensal por vendedora × LB-01 (YoY, sazonalizada) | ⚠️ **Alvo é não piorar** | ≥ 100% da base em **30 dias** ✅ |
| **MN-03** | Negócio | Compradores ativos no mês × LB-02 | | ≥ 100% da base ✅ |

> **A Onda 1 valeu se:** o tempo de primeira resposta caiu de forma mensurável contra LB-11 **e** a
> receita voltou ao patamar da linha de base em até 30 dias.

⚠️ **A Onda 1 não é onda de crescimento — é onda de não regressão.** Prometer aumento de receita
aqui é vender o que o produto ainda não faz: não há RFV, não há tarefa, não há pedido na conversa.
⚠️ **E se LB-11 não foi capturada, a Onda 1 não tem como ser declarada vencida.** Volta à §1.

### 2.3 Onda 2 — Vender

| ID | Família | Métrica | Definição | Alvo |
|---|---|---|---|---|
| **MA-05** | Adoção | 🔴 **% dos pedidos do ERP que nasceram no GeraCRM** | `venda` com `pedido_id` ÷ `venda` no período | ≥ 60% em 60 dias **H** |
| **MA-06** | Adoção | % de vendedoras que abriram a carteira/funil ≥ 4 dias/semana | | ≥ 80% **H** |
| **MA-07** | Adoção | Tarefas concluídas ÷ tarefas vencidas no período | | ≥ 70% **H** |
| **MA-08** | Adoção | **Sugestões do copiloto enviadas sem edição** ÷ geradas | A métrica mais honesta de qualidade de IA (`geracrm-ia`) | ≥ 30% **H** |
| **MO-12** | Operação | Taxa de falha na efetivação do pedido (PED-08) | | < 2% ✅, **0% de rascunho perdido** ✅ |
| **MO-13** | Operação | Tempo de montagem do pedido — mediana | Contra o tempo de montar no ERP (declarado) | menor que o do ERP ✅ |
| **MO-14** | Operação | Divergência pedido → venda na reconciliação | `pedido_tentativa.reconciliado_em` nulo há > 24 h | < 1% ✅ |
| **MN-04** | Negócio | 🔴 **Taxa de recompra 90 d** × LB-03 | A métrica central do recorrente | +3 pp em 90 dias **H** |
| **MN-05** | Negócio | **Tempo até o 2º pedido** (mediana) × LB-04 | O melhor preditor de retenção em atacado | −15% **H** |
| **MN-06** | Negócio | **Cobertura de carteira**: clientes ativos com toque em 30 dias | Era invisível antes do produto | ≥ 80% **H** |
| **MN-07** | Negócio | Clientes **reativados**: saíram de Em Risco/Hibernando para Ativo | RFV-02, via `rfv_evento` | medir, sem alvo — |
| **MN-08** | Negócio | Ticket médio **e mediana** × LB-05 | | ≥ base ✅ |

> **A Onda 2 valeu se:** a maioria dos pedidos nasce dentro da conversa **e** a taxa de recompra
> superou a linha de base. MA-05 é a métrica-mãe da onda: sem ela, a atribuição **exata** (§3) fica
> vazia e a Onda 3 não terá o que provar.

### 2.4 Onda 3 — Escalar

| ID | Família | Métrica | Alvo |
|---|---|---|---|
| **MA-09** | Adoção | Campanhas disparadas/mês e % da base alcançada | medir — |
| **MA-10** | Adoção | Vendedoras que executam a Fila do Dia ÷ ativas | ≥ 70% **H** |
| **MA-11** | Adoção | Leads atendidos pela IA **sem handoff** ÷ leads da IA | ≥ 50% **H** |
| **MO-15** | Operação | Taxa de entrega, leitura e **resposta** por campanha | resposta ≥ 8% **H** |
| **MO-16** | Operação | Qualidade e tier dos números **durante e depois** do disparo | sem queda de tier ✅ |
| **MO-17** | Operação | Custo realizado ÷ custo estimado no aviso pré-envio (CMP-05) | ±10% ✅ |
| **MO-18** | Operação | Tempo até qualificação pela IA — mediana (IA-09) | < 5 min **H** |
| **MN-09** | Negócio | 🔴 **Receita atribuída EXATA** por campanha e por tarefa | §3 |
| **MN-10** | Negócio | Receita atribuída **estimada**, com janela declarada | §3 — **nunca somada a MN-09** |
| **MN-11** | Negócio | **Custo por venda atribuída** (Meta + IA) | < 2% do ticket médio **H** |
| **MN-12** | Negócio | Receita **incremental** medida por holdout | §3.4 |
| **MN-13** | Negócio | Reativação atribuída a campanha (cliente inativo que voltou) | medir — |

> **A Onda 3 valeu se:** existe pelo menos uma campanha com receita **exata** atribuída maior que o
> custo dela, e a qualidade dos números não caiu no processo.

### 2.5 Onda 4 — Diferenciar

| ID | Família | Métrica | Alvo |
|---|---|---|---|
| **MA-12** | Adoção | Tarefas da Fila do Dia executadas ÷ sugeridas (D1) | ≥ 60% **H** |
| **MA-13** | Adoção | Trilhas de capacitação concluídas por vendedora (GES-07) | medir — |
| **MO-19** | Operação | SLA de primeira resposta cumprido (INB-22) | ≥ 95% **H** |
| **MO-20** | Operação | **CSAT** ao encerrar (INB-23) e taxa de resposta do CSAT | CSAT ≥ 4,5 **H** |
| **MN-14** | Negócio | 🔴 **BI-11 — ROI do GeraCRM**, exibido ao dono | § 3 |
| **MN-15** | Negócio | **NPS** da base do cliente (BI-07) | medir — |
| **MN-16** | Negócio | ⚠️ **Churn de tenant e retenção líquida de receita — nossa** | churn < 1%/mês **H** |
| **MN-17** | Negócio | Tempo até o novo vendedor bater a 1ª meta (GES-09) | < 45 dias **H** |

> **A Onda 4 valeu se:** o dono abre o painel de ROI, entende o número e não pede desconto na
> renovação. MN-16 é a única métrica deste documento que mede **a nós** — e é a razão comercial de
> BI-11 e da trilha de capacitação existirem.

---

## 3. A métrica que prova o produto — BI-11

O painel que responde: *"este mês o GeraCRM gerou R$ X para você e custou R$ Y."* É a melhor arma
anti-churn do produto — e a mais fácil de transformar em mentira.

### 3.1 Os dois numeradores, que nunca viram um

| | Definição | Confiabilidade | Origem |
|---|---|---|---|
| **R_exata** | Venda cujo `pedido` nasceu na conversa, com vínculo a campanha/tarefa/vendedora (PED-09, ADR-005) | **Fato registrado** | `atribuicao_receita` com `metodo='exata'` |
| **R_estimada(j)** | Venda de contato tocado nos **j** dias anteriores, **sem** atribuição exata | **Correlação** | `metodo='estimada'`, `janela_dias = j` |

⚠️ **Somar as duas é maquiar o número** (INV-42, CMP-11). O modelo já impede: `metodo` é obrigatório,
nenhuma view materializada expõe a soma, a API devolve dois campos. **BI-11 usa `R_exata` como
número principal**; `R_estimada` aparece abaixo, como faixa, com a janela escrita na tela (INV-44).

⚠️ **A palavra também é instrumentação.** Sem holdout (§3.4), a tela diz *"receita que passou pelo
GeraCRM"* — não *"receita que o GeraCRM gerou"*. A segunda frase é uma afirmação causal, e ela custa
o contrato quando o cliente pedir a prova.

⚠️ **Dupla contagem entre os cards de BI-02.** Uma venda pode ter `campanha_id` **e** `tarefa_id` **e**
`conversa_id`. INV-43 garante uma atribuição exata por venda; falta a **precedência**, que este
documento fecha: **campanha > tarefa > conversa > vendedora**. Cada venda aparece em **exatamente um**
card. Somar os cards de BI-02 tem que devolver `R_exata`, e existe teste que verifica isso.

### 3.2 O denominador — custo honesto

```
Custo_total = assinatura_GeraCRM + custo_Meta + custo_IA
```

| Parcela | Fonte | ⚠️ |
|---|---|---|
| **Assinatura** | `assinatura_tenant.valor_centavos` no período (§6.2) | Sem esta tabela, o ROI usa "o que o comercial lembra que ele paga" |
| **Meta** | `Σ custo_mensagem.centavos` | **O cliente paga a Meta direto (ADR-002) — e mesmo assim entra no denominador.** Omitir infla o ROI a nosso favor e é a primeira coisa que um dono desconfiado vai perguntar |
| **IA** | `Σ uso_ia.centavos` | Entra mesmo se embutida no plano: o painel mostra "incluído no plano", não zero |

**Não entram:** salário da equipe (não é atribuível), custo do ERP, custo do celular. **Entra como
comparativo, fora da conta:** LB-14 (o que ele gastava com as ferramentas antigas) — é a linha que
transforma o ROI em decisão de renovação.

⚠️ **Custo da Meta é calculado por nós, não devolvido pela Meta** (§5.5 do modelo). Por isso
`custo_mensagem.estimado` e `tarifa_id`: quando a tarifa muda, o histórico **não** recalcula. Um
painel que recalcula o passado é um painel que muda o ROI de março em julho.

### 3.3 A fórmula

```
ROI  =  (R_exata − Custo_total) ÷ Custo_total          → "retorno de 4,2×"
```

**Cinco regras de exibição, todas verificáveis por teste:**

1. Dois números de receita, nunca um — com legenda de método.
2. A janela da estimada, escrita na tela (INV-44).
3. Período com cobertura declarada (INV-56). Mês com carga incompleta **não vira ROI**.
4. Custo Meta sempre visível no denominador.
5. ⚠️ Se `R_exata = 0` porque o pedido assistido não é usado, o painel **diz isso** — *"nenhum pedido
   nasceu na conversa neste período"* — e não promove a estimada ao lugar da exata. Este é o caminho
   pelo qual todo CRM do mercado mente, e é um `if` de três linhas.

### 3.4 Incrementalidade — o holdout

⚠️ **`R_exata` prova que a venda passou pelo produto. Não prova que ela não aconteceria de qualquer
jeito.** O cliente de atacado compra todo mês; atribuir a recompra dele a uma campanha é o erro mais
comum do setor.

A única defesa honesta é barata: **grupo de controle**. Ao montar o público da campanha, 5–10% dos
contatos elegíveis entram como `grupo='controle'` e **não recebem** o disparo.

```
Receita incremental ≈ (taxa_compra_alvo − taxa_compra_controle) × N_alvo × ticket_médio
```

| Decisão | Resposta |
|---|---|
| Onde vive | `campanha_destinatario.grupo ('alvo'\|'controle')`, default `'alvo'` |
| Quando nasce a coluna | **Com a campanha, na Onda 3** — mas a decisão é agora: sem a coluna, incrementalidade **nunca** é calculável retroativamente |
| Quem aceita | ⚠️ Decisão **comercial** do cliente: ele topa não falar com 5% da base? (§9, nº 3) |
| Se ele não topar | Holdout **rotativo por período** (a cada campanha, um recorte diferente fica de fora) ou nenhum — e aí MN-12 não existe, e a tela nunca escreve "gerou" |

---

## 4. Contra-métricas

| ID | Métrica que se otimiza | Como se distorce | Contra-métrica | Limiar de parada |
|---|---|---|---|---|
| **MC-01** | Mensagens enviadas | Volume vira meta; a base é bombardeada | **Mensagens por venda atribuída** e **taxa de resposta do cliente** | Resposta caindo 2 períodos seguidos ⇒ revisar conteúdo, não aumentar volume |
| **MC-02** | Alcance de campanha | Dispara para a base toda | **Taxa de opt-out por campanha** | > 0,5% ⇒ pausar e revisar segmento ✅ |
| **MC-03** | Alcance de campanha | Denúncia derruba o ativo mais frágil do cliente | **Qualidade e tier do número** (`geracrm-whatsapp-meta`) | Qualidade → `medium` ⇒ pausar marketing, manter serviço ✅ |
| **MC-04** | Receita atribuída | Alarga-se a janela até tudo virar mérito do produto | **Razão estimada ÷ exata** e **% de vendas sem atribuição** | Estimada > 3× exata ⇒ o número é correlação com maquiagem |
| **MC-05** | Tempo de primeira resposta | Resposta automática vazia zera o relógio | **% de primeiras respostas humanas** e **taxa de reabertura em 24 h** | Auto > 30% ⇒ MO-07 deixa de ser lida ✅ |
| **MC-06** | Conversas atendidas por pessoa | Encerra rápido para inflar o contador | **Reabertura em 24 h** + **CSAT** | Reabertura > 10% **H** |
| **MC-07** | Cobertura da IA | IA responde mal para não chamar humano | **Handoff tardio** (após ≥ 3 trocas), qualificação auditada errada | Erro auditado > 5% ⇒ estreitar o escopo do agente **H** |
| **MC-08** | Pedidos nascidos no CRM (MA-05) | Vendedora registra no CRM um pedido que já existia, para bater a meta | Pedidos criados **no mesmo dia** da venda com valor idêntico e sem tempo de montagem | > 15% ⇒ MA-05 está sendo gamificada **H** |
| **MC-09** | Vendedoras ativas (MA-01) | Login sem trabalho | **Ações por sessão** e **conversas por vendedora ativa** | Ações/sessão < 5 ⇒ adoção é fachada **H** |
| **MC-10** | Custo baixo por mensagem | Só mensagem de serviço; ninguém inicia conversa | **Conversas iniciadas por nós** ÷ base ativa | Cair a zero ⇒ o produto virou reativo |
| **MC-11** | ROI alto (BI-11) | O período é escolhido a dedo | ROI **sempre em janela móvel de 3 meses**, ao lado do mês | — ✅ |

⚠️ **MC-02, MC-03 e MC-05 têm consequência automática no produto, não só no painel.** Contra-métrica
que depende de alguém olhar o gráfico não protege nada.

---

## 5. Métricas técnicas com consequência de negócio

As de `geracrm-observabilidade`, com o que elas custam ao cliente quando degradam.

| ID | Métrica técnica | Consequência de negócio | Limiar | Decisão que destrava |
|---|---|---|---|---|
| **MT-01** | Taxa de entrega por número | Campanha não entregue = receita que não existe; queda súbita antecipa o aviso da Meta | < 95% em 1 h | Pausar disparo naquele número (`canal_configuracao.disparo_pausado`) |
| **MT-02** | Qualidade e tier | Perder o número é perder a base de conversas e o histórico de relacionamento | Queda de faixa | Pausar marketing, manter serviço; avisar o gestor |
| **MT-03** | Latência do ERP p95 | > 2 s a vendedora abandona o pedido assistido ⇒ MA-05 cai ⇒ `R_exata` some ⇒ **BI-11 desaba** | > 2 s por 15 min | Avisar o cliente; validação migra para a efetivação (ADR-008) |
| **MT-04** | Tamanho e idade da fila de disparo | Campanha atrasada chega fora do horário comercial; a taxa de resposta despenca | Item > 30 min na fila | Escalar worker ou repartir pela frota |
| **MT-05** | Outbox não processado | Tela desatualizada ⇒ duas vendedoras respondem o mesmo cliente ⇒ colisão diante do lojista | > 2 min | Investigar worker (ADR-007) |
| **MT-06** | Custo de IA por tenant | Margem do plano e detecção de abuso | > 20% da assinatura **H** | Limite por tenant com degradação para humano, nunca falha |
| **MT-07** | Custo de mensagem por tenant | **É o denominador de BI-11** | — | Alimenta o painel e o simulador pré-disparo (CMP-18) |
| **MT-08** | Latência da consulta analítica | Dashboard lento é dashboard não aberto; ROI não visto é ROI que não retém | p95 > 3 s | Mover para MV/réplica (exigência 8 de `especificacao-telas`) |
| **MT-09** | Conexões SSE ativas | Gatilho de escala antes de a operação sentir | §12 de `stack-arquitetura` | Escalar |
| **MT-10** | Taxa de erro do webhook | Mensagem do cliente que não entra é atendimento perdido sem ninguém saber | Subindo | Verificar assinatura e idempotência |

⚠️ **O destino destas métricas é a tarefa I-11 de `plano-onda-0.md` §2.1** — um destino de **série
temporal** por ambiente, decidido entre tabelas de agregação no próprio Postgres (com job de janela)
e serviço gerenciado. **Sentry não serve**: ele é rastreamento de **erro**, não guarda p95 por 15
minutos nem dispara MT-03. MO-05 tem a mesma casa.

⚠️ Sem I-11, MT-01…MT-05 perdem exatamente o que as torna úteis: a **consequência automática**.
*"Taxa de entrega < 95% em 1 h ⇒ pausar disparo naquele número"* vira disciplina humana — e a §4
deste documento é categórica quanto a isso. Os três limiares viraram alerta em **I-10**.

---

## 6. Instrumentação

### 6.1 O que o modelo já resolve

Boa notícia: a maior parte não exige tabela nova, porque o modelo é factual.

| Métrica | Sai de |
|---|---|
| LB-01…LB-09, MN-02…MN-08 | `venda`, `venda_item`, `contato`, `mv_metricas_contato` |
| MO-10, MT-01, MT-02 | `metrica_numero_dia`, `canal_saude_evento`, `numero_whatsapp` |
| MO-08, MO-09, MO-11 | `conversa` (`ultima_entrante_em`, `ultima_direcao`), `atendimento` |
| MO-15, MC-02 | `campanha` (contadores) + `campanha_destinatario` |
| MN-09, MN-10, §3 | `atribuicao_receita` (`metodo`, `janela_dias`) — **já nasce com a distinção certa** |
| Custo Meta (§3.2) | `custo_mensagem` + `tarifa_meta` (com tarifa versionada) |
| MN-07 | `rfv_evento` |
| MA-05, MO-12, MO-14 | `pedido`, `pedido_tentativa`, `venda.pedido_id` |
| MC-06 (reabertura) | `atendimento_evento` |

### 6.2 O que falta — `0017_metricas_produto.sql` (Onda 0)

Sete lacunas. **Cinco entram na Onda 0** porque a alternativa é reprocessar histórico — o mesmo
raciocínio que fez `atendimento` nascer completo e vazio na `0012`.

⚠️ **Cada uma tem ID de requisito** (`processo-de-trabalho` §0, regra 1), criado em
`escopo-funcional-geracrm.md` §3. E ⚠️ **o item 1 não mora nesta migration**: ele é `atendimento`, e
`atendimento` nasce completo na **D-12 / `0012`** — ver a nota abaixo da tabela.

| # | Requisito | O que | Onda | Migration | Por que agora |
|---|---|---|---|---|---|
| **1** | `PLT-12` | `atendimento.primeira_entrante_em`, `primeira_resposta_em`, `primeira_resposta_humana_em`, `primeira_resposta_por_id` | **0** | ⚠️ **D-12**, não `0017` | 🔴 Derivar depois é varrer `mensagem` **particionada** conversa a conversa. E a definição precisa ser decidida **antes** de existir dado: a mensagem de ausência automática preenche `primeira_resposta_em`, **não** `primeira_resposta_humana_em` — é exatamente o que MC-05 vigia. Uma coluna só torna a contra-métrica impossível |
| **2** | `PLT-12` | `linha_base_metrica(tenant_id, metrica, periodo_de, periodo_ate, valor_num numeric, unidade, fonte, confiavel bool, observacao, apurado_em, congelado_em, congelado_por)` PK `(tenant_id, metrica, periodo_de)` | **0** | D-17 | §1. É a régua. Sem tabela, ela vira slide perdido no Drive |
| **3** | `PLT-12` | `tenant_marco(tenant_id, marco, ocorrido_em, observacao)` PK `(tenant_id, marco)` | **0** | D-17 | ⚠️ Sem a data do primeiro corte, todo "antes e depois" é chute. E não é a data do contrato: é o primeiro dia de operação real. Marcos: `onboarding_concluido`, `carga_historica_completa`, `linha_base_congelada`, **`primeiro_corte`**, **`ultimo_corte`**, **`abandono_sistema_antigo`**, `virada_onda2`… |
| **4** | `PLT-14` | `assinatura_tenant(tenant_id, id, plano_id, valor_centavos bigint, ciclo, vigente_de, vigente_ate)` + `EXCLUDE` sem sobreposição | **0** | D-17 | Denominador de BI-11 e base do MRR. `plano` (global, `0002`) tem catálogo, **não tem o que este cliente paga** — desconto e negociação existem |
| **5** | `PLT-13` | `uso_diario_usuario(tenant_id, usuario_id, dia, superficie, primeiro_em, ultimo_em, acoes, conversas_tocadas, mensagens_enviadas, pedidos_criados)` PK `(tenant_id, usuario_id, dia, superficie)` | **0** (escrita a partir da Onda 1) | D-17 | MA-01, MA-06, MC-09. ⚠️ **Não é pipeline de eventos**: é um `UPSERT` por caso de uso de escrita, uma linha por usuário/dia/superfície. Ponto quente por usuário, não global. Responde "vendedoras ativas/dia" sem varrer `mensagem` |
| **6** | `IA-*` | `uso_ia(tenant_id, id, criado_em, funcionalidade, modelo, tokens_entrada, tokens_saida, centavos bigint, latencia_ms, resultado, usuario_id, conversa_id, desfecho)` — particionada mensal | **2** | — | Espelha `custo_mensagem`, inclusive a única por evento. ⚠️ `desfecho ('enviado_sem_edicao'\|'enviado_editado'\|'descartado')` **nasce junto**: é MA-08, a única métrica honesta de qualidade do copiloto, e retrofit dela é impossível |
| **7** | `CMP-*` | `campanha_destinatario.grupo ('alvo'\|'controle')` default `'alvo'` | **3** | — | §3.4. Decidida agora, criada com a campanha |

⚠️ **`0017_metricas_produto.sql` cria os itens 2 a 5 — quatro tabelas.** O item 1 são colunas de
`atendimento` e vai para **D-12**, que é a migration que promete *"`atendimento` nasce completo"*;
com quatro colunas fora, ele nascia incompleto. E ⚠️ **`0018` está tomado**: é
`0018_conciliacao.sql` (`entrada-do-primeiro-cliente` §9.2), que reservou `0017` no mesmo dia que
este documento e foi renumerada. **A reserva de número vive na tabela §4 de `plano-onda-0.md`.**

⚠️ **Os marcos foram renomeados, e não é cosmética.** `virada_onda1` significava três coisas
diferentes em três documentos: o corte do **primeiro** número (`entrada`: `T`/`D-0`), a operação
inteira sem a ferramenta antiga (`plano-ondas-1-4` M1.7) e o "primeiro dia de operação real" daqui.
Ficou:

| Marco | O que é, exatamente |
|---|---|
| `linha_base_congelada` | ⚠️ **Sempre antes de `primeiro_corte`.** É o congelamento da régua, e ele não admite ser posterior ao evento que está medindo |
| `primeiro_corte` | O primeiro número do cliente apontando para o GeraCRM. É o instante em que LB-10…LB-12 deixam de ser obtíveis |
| `ultimo_corte` | O último número da frota conectado |
| `abandono_sistema_antigo` | A ferramenta antiga com acesso revogado ou contrato encerrado — fato administrativo, com data |

**Regras que valem para as sete** — as mesmas de `plano-onda-0.md` §4.1: `tenant_id` em todas
(nenhuma entra na lista fechada de exceções da §7.2), RLS `FORCE` com `USING` **e** `WITH CHECK` na
mesma migration, dinheiro em `_centavos bigint`, estado como união de literais em `text`.

### 6.3 O que **não** vamos criar

⚠️ **Nenhuma tabela genérica de "evento de produto".** O modelo já é factual — `mensagem`,
`atendimento`, `atendimento_evento`, `pedido`, `venda`, `tarefa`, `negocio_funil_evento`,
`rfv_evento`, `auditoria` — e uma `evento_produto(tipo, payload jsonb)` vira lixão em três meses:
ninguém sabe quais tipos existem, metade está errada, e a consulta que a usa nunca é escrita.
Telemetria de uso agregada (item 5) é a **única** exceção, e ela é agregada de propósito.

⚠️ **Auditoria não é telemetria** (`geracrm-observabilidade`). `auditoria` responde "quem fez isso?",
tem retenção definida e lista fechada de ações. Usá-la como fonte de MA-01 acopla um requisito legal
a um painel de produto — e o dia em que a retenção da auditoria encurtar, a série de adoção some.

### 6.4 Onde as métricas rodam

- **Sempre na réplica de leitura**, nunca competindo com o inbox (exigência 8 de
  `especificacao-telas`; §8.7 do modelo).
- MVs por onda, com `REFRESH CONCURRENTLY`: `mv_metricas_contato` (já existe, Onda 0) ·
  `mv_operacao_dia` (Onda 1) · `mv_atribuicao_periodo` (Onda 3).
- ⚠️ **Toda MV carrega `tenant_id` e tem policy própria** — view materializada **não herda RLS**
  (§7.3). MV de métrica sem policy é o painel de ROI de um cliente exibindo a receita de outro.

### 6.5 A regra que fecha a §0

**Toda métrica deste documento tem um arquivo `.sql` versionado em
`apps/api/src/contexts/analitico/consultas/`, com o ID da métrica no nome** — `MN-04-recompra-90d.sql`.
⚠️ O caminho é `src/contexts/analitico/`, não `src/analitico/`: a estrutura de `plano-onda-0.md` §3
coloca **todo** contexto sob `src/contexts/`, e um diretório fora dessa convenção é o começo de uma
segunda árvore de código. A consulta é escrita **junto com a funcionalidade**, e a tarefa não fecha
sem ela. Métrica combinada em reunião e consultada por SQL improvisado três meses depois devolve um
número diferente a cada pessoa que a roda.

---

## 7. Cadência e dono

| Quem | O quê | Frequência | Decisão que destrava |
|---|---|---|---|
| **Plantão de engenharia** | MT-01…MT-10 (só o que tem alerta) | Contínuo | Pausar disparo · escalar worker · avisar cliente sobre o ERP |
| **Vendedora** | Fila do Dia, tarefas vencidas, meta pessoal | Diário | O que fazer nas próximas 2 horas |
| **Gestor do cliente** | MO-08 (sem resposta), MO-11 (fila), MA-01 (quem não entrou) | Diário, 1ª hora | Redistribuir carteira · cobrar quem parou |
| **Gestor do cliente** | MN-06 (cobertura de carteira), ranking, MO-07 | Semanal | Ajustar meta · treinar quem está fora da curva |
| **Dono do cliente** | MN-04, MN-05, MN-08 e **BI-11** | Mensal | Renovar · contratar mais números · abrir filial |
| **Dono do produto (nós)** | MA-01…MA-05 do piloto, contra MC-09 | **Semanal, durante toda a onda** | 🔴 Adoção baixa é problema de **treinamento ou de produto** — e a resposta muda tudo. Decide se a onda avança ou se para para corrigir |
| **Dono do produto** | MO-* da onda corrente contra a linha de base | Quinzenal | Declarar a onda vencida ou estender |
| **Comercial / CS Gera3** | BI-11 por tenant, MN-16 (nosso churn) | Mensal | ⚠️ **Tenant com ROI < 1× é churn anunciado** — intervenção antes da renovação, não depois |
| **Todos** | Recalibrar alvos **H** e revisar contra-métricas | Trimestral | Alvo que nunca falha está baixo demais; contra-métrica que nunca dispara não está sendo medida |

⚠️ **Ritual único, não relatório novo.** Cada linha acima cabe numa tela que o backlog já prevê
(Home BI-01, GES-04, painel de saúde CAN-04, BI-11). Métrica que exige planilha paralela é métrica
que dura dois meses.

---

## 8. O que **não** vamos medir

> Lista fechada de métricas de vaidade. Entrar no painel exige justificativa escrita.

| Não medir | Por quê |
|---|---|
| Total de mensagens enviadas | Não distingue trabalho de spam (MC-01) |
| Total de contatos cadastrados | A carga histórica define o número no dia 1; depois ele só sobe |
| Tempo em tela / sessões por dia | A vendedora fica 8 h no CRM por desenho. Mais tempo não é melhor |
| Cliques, telas visitadas, funil de UI | Custo de instrumentação alto, decisão destravada nenhuma |
| "Leads gerados" sem definição fechada | Sem critério objetivo de qualificado (`funil-de-vendas`), é contagem de mensagem entrante |
| Uptime sem consequência declarada | Vira slide. O que importa é MT-01…MT-05, que têm ação |
| NPS antes da Onda 4 | Base pequena e produto em mudança: ruído caro |

---

## 9. Decisões em aberto

| # | Decisão | Quem decide | Até quando |
|---|---|---|---|
| **1** | **Todos os alvos marcados H** | Dono do produto, contra a linha de base do 1º cliente | Antes da onda correspondente começar |
| **2** | **Janela padrão da atribuição estimada** (3/7/14 d) e a regra de desempate quando o contato recebeu duas campanhas | ADR próprio — INV-44 exige que seja **única e declarada** | Antes da Onda 3 |
| **3** | **Holdout**: existe? qual %? rotativo? | ⚠️ Comercial, **com o cliente** — ele precisa aceitar não falar com parte da base | Antes da Onda 3 |
| **4** | Definição de **"vendedora ativa"**: ação de escrita, ou abrir o app basta? | Dono do produto | Antes da Onda 1 (define `uso_diario_usuario.acoes`) |
| **5** | Quem **assina** a linha de base do lado do cliente | Comercial | Antes da carga histórica |
| **6** | Retenção de `uso_diario_usuario` e `uso_ia` (dado de produtividade individual) | ⚠️ Jurídico — é dado de trabalhador, não só telemetria | Junto com a política de LGPD |
| **7** | O painel BI-11 é visível ao **gestor** ou só ao **dono**? | Comercial | Onda 4 |

---

## 10. Checklist — o que a Onda 0 precisa entregar por causa deste documento

Soma-se ao checklist de `plano-onda-0.md` §8 — ✅ **já incorporado lá**, item a item:

- ☐ **D-17 / `0017_metricas_produto.sql`** aplicada: itens **2 a 5** da §6.2 (`linha_base_metrica`, `tenant_marco`, `assinatura_tenant`, `uso_diario_usuario`)
- ☐ **D-12** com as **quatro colunas de primeira resposta** em `atendimento` — item **1** da §6.2, que não mora na `0017`
- ☐ **I-11** de pé: MO-05 responde o p95 dos últimos 15 min por tenant, e MT-01/MT-03/MT-05 têm alerta em I-10
- ☐ LB-01…LB-09 calculadas sobre a carga histórica, **dentro da cobertura** (INV-56)
- ☐ LB-10…LB-15 capturadas por sombra (**T-8**) / export / declaração, **com `fonte` gravada**
- ☐ Linha de base **congelada** e conferida com o cliente (`congelado_em` preenchido) — é **MN-01**, e é o **critério de saída nº 5** da Onda 0
- ☐ `tenant_marco` com `carga_historica_completa` e `linha_base_congelada` — ⚠️ **`linha_base_congelada` antes de `primeiro_corte`**, sempre
- ☐ Consultas `.sql` versionadas para toda métrica das Ondas 0 e 1, em `apps/api/src/contexts/analitico/consultas/`
- ☐ **PLT-12, PLT-13 e PLT-14** existem em `escopo-funcional-geracrm.md` §3 — nenhuma tabela desta lista entrou sem ID de requisito
- ☐ Decisões nº 4 e nº 5 da §9 fechadas
