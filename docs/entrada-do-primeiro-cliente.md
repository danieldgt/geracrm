# Entrada do primeiro cliente — do sistema atual ao GeraCRM

> Preenche a lacuna 4.1 de [`prontidao-para-inicio.md`](./prontidao-para-inicio.md): todo o
> planejamento descreve **o produto**; este documento descreve **a transição**.
>
> Deriva de [`plano-onda-0.md`](./plano-onda-0.md) (§1, §5.2, §6, §8),
> [`modelo-de-dados.md`](./modelo-de-dados.md) (§6 identidade e reconciliação, INV-10/49/55/56/57),
> [`decisoes.md`](./decisoes.md) (ADR-002, ADR-003, ADR-008),
> [`inventario-funcionalidades-referencia.md`](./inventario-funcionalidades-referencia.md) (a base
> de referência real) e da skill `geracrm-whatsapp-meta`.
>
> **Não repete** o que esses documentos dizem. Referencia.

---

## 0. A tese deste documento, em três linhas

1. **Importar não é migrar.** Importar é escrever linhas; migrar é a operação passar a acontecer
   aqui. A prova é um **relatório de conciliação assinado** — não o job terminando sem erro.
2. **O canal não admite convivência.** Um número não pode estar na Cloud API e no WhatsApp Business
   App ao mesmo tempo. Corte seco por número é imposição técnica, não escolha.
3. **Rollback sem critério escrito é decisão tomada no desespero.** Os gatilhos, o decisor e o
   ponto de não retorno estão na §6 — escritos **antes** de conectar o primeiro número.

**Convenção de tempo:** `T` = semana do corte do **primeiro número**. `D` = dia do corte de um
número específico. `S0…S6` = semanas do plano da Onda 0 (S0 de preparação + seis de desenvolvimento).
`ENS-1` / `ENS-2` = os dois **ensaios de carga** — ⚠️ nunca `E1`/`E2`, que no plano são prefixos de
tarefa por épico.

**Artefatos que este documento obriga a existir** (um por cliente, versionados em `docs/clientes/<cliente>/`):

| Artefato | Quando | Quem assina |
|---|---|---|
| `ficha-de-entrada.md` | T-6 | Gestor do cliente + nós |
| `perfilamento.md` | T-5 | Nós (entregue ao cliente) |
| `o-que-nao-migra.md` | T-5 | **Gestor comercial** do cliente |
| `conciliacao-<data>.md` | T-3 (v1), T-2 (v2), T+6 (final) | **Gestor comercial** do cliente |
| `linha-de-base.md` | T-5 | Nós, com dado do ERP |
| `diario-da-migracao.md` | contínuo | Nós |

⚠️ **Sem `ficha-de-entrada` e `perfilamento` não existe data de go-live.** Data prometida antes de
medir a base é a origem de metade dos fracassos de migração.

---

## 1. Levantamento prévio — a ficha de entrada

Fecha a **decisão pendente nº 5** de [`stack-arquitetura.md`](./stack-arquitetura.md) §14 e a
**decisão aberta nº 1** do modelo de dados (granularidade de partição). Corresponde a **M-12** do
plano da Onda 0, expandido.

⚠️ **Número dito ≠ número medido.** O bloco A é *perguntado*; o bloco B é **medido por nós** sobre a
cópia da base (M-11). Cliente estima contatos por baixo e histórico por cima, sempre. Estimativa
serve para agendar a conversa, não para dimensionar partição.

### 1.A Volume e escala — perguntado, confirmado por medição

| # | Pergunta | Por que importa | O que muda com a resposta |
|---|---|---|---|
| A-01 | Números de WhatsApp hoje / previstos em 12 meses | Frota, throttling por número, precificação | > 15 números: onboarding da frota vira fluxo em lote, não um a um |
| A-02 | Mensagens/dia agregadas e no pico (segunda de manhã, lançamento de coleção) | Partição de `mensagem`, dimensionamento do gateway | > ~20 mil/dia → partição **mensal** confirmada; abaixo disso, mensal continua sendo o default seguro |
| A-03 | Contatos totais no ERP · no WhatsApp · no catálogo | Dimensiona a fila de deduplicação | Na base de referência: 3.561 no ERP, 17.920 no WhatsApp, 15.020 no catálogo, **29.780 no total** — a interseção do núcleo era 2.179 |
| A-04 | Anos de histórico de venda **disponíveis no ERP** (não "de empresa") | Horizonte da carga, `conexao_erp_cobertura.desde` | < 24 meses → o RFV **se recusa a classificar** parte da base (INV-56). Precisa ser dito ao cliente **antes**, não depois |
| A-05 | Vendas/ano e itens médios por venda | Partições anuais de `venda`, duração da carga | Define a janela do go-live (§2.6) |
| A-06 | SKUs ativos, tamanho da grade, giro de coleção | Volume de `produto`, catálogo | — |
| A-07 | Filiais, setores, e qual é a sede operacional | Escopo de `usuario_filial` (INV-59), ordem dos lotes (§3.1) | Define a filial do piloto |
| A-08 | Volume de mídia (áudio e foto de grade por dia) | Bucket e política de ciclo de vida (I-05) | Áudio dominante → transcrição sobe de prioridade na Onda 2 |

### 1.B Qualidade cadastral — **medido**, nunca perguntado

Roda sobre a cópia anonimizada (M-11) na **S1** do plano, não na S6. Saída: `perfilamento.md`.

| # | Métrica | Por que importa | Referência conhecida |
|---|---|---|---|
| B-01 | % com **CNPJ válido** (com DV conferido) · % com CPF válido · % **sem documento** | É a chave forte nível 2 da §6.2 do modelo. Sem ela sobra o telefone, que é chave **média** e não casa | **40% sem documento** na base de referência (11.766 de 29.780) |
| B-02 | Documento presente mas **inválido** (DV errado, máscara no campo, `00000000000`) | Pior que ausente: casa errado se alguém relaxar a validação | — |
| B-03 | Mesmo CNPJ em N cadastros distintos | Duplicidade que **divide o histórico de compra** e corrompe o RFV dos dois lados | — |
| B-04 | Mesmo telefone em N cadastros distintos | Colisão de principal na ingestão (INV-49): não funde, abre `conflito_identidade` | — |
| B-05 | % de telefones com **8 dígitos** (sem nono) por DDD | Alimenta o risco nº 7 do plano e a tabela de faixas de DDD | — |
| B-06 | Contatos **sem nenhuma venda** · vendas **sem contato** | Venda órfã é DIV-01 disfarçada | — |
| B-07 | Distribuição de vendas por mês nos últimos 60 meses | Revela buracos: mês sem venda é feriado ou é dado que não existe? | — |
| B-08 | Vendas **sem vendedor** · vendedores distintos no ERP | Bloqueia RC-03 e o ranking | — |
| B-09 | % com cidade/UF · % com endereço completo | Mapa de clientes e endereço de entrega | — |
| B-10 | Vendas canceladas/devolvidas, e como o ERP as representa | Define DIV-04 e a regra de RFV | — |

⚠️ **O perfilamento é entregue ao cliente antes da carga, e é ativo comercial.** Quem mostra a
bagunça da base antes de importar não é culpado por ela depois. Quem importa primeiro herda a culpa.

### 1.C Pessoas — o que o organograma não diz

| # | Pergunta | Por que importa |
|---|---|---|
| C-01 | Quantas vendedoras, nome, filial, e **qual número é de quem** | A frota é 1:1 com pessoa; a saída de uma vendedora vira evento de infraestrutura |
| C-02 | Existe carteira hoje? Como é atribuída? Há disputa de cliente? | Carteira sem regra vira briga na primeira semana; INV-32/33/58 exigem dono explícito, inclusive "sem dono" |
| C-03 | Volume por vendedora nos últimos 6 meses | Escolhe o piloto: **mediana**, não a melhor (§3.1) |
| C-04 | Quem é a **multiplicadora interna** (nomeada, com nome no contrato) | Sem ela, todo suporte passa por nós indefinidamente |
| C-05 | Quem usa **celular pessoal** para atender hoje | ⚠️ É o maior risco de adoção (TR-07). Precisa de política escrita, não de aviso verbal |
| C-06 | Turnover das vendedoras nos últimos 12 meses | Alto turnover → treinamento vira processo, não evento |
| C-07 | Quem é o **decisor** do lado do cliente para gate e rollback | Rollback sem nome vira reunião |

### 1.D ERP

| # | Pergunta | Liga em |
|---|---|---|
| D-01 | Qual ERP, versão, quem hospeda, quem opera | ADR-008 |
| D-02 | Capacidades: `saldoSincrono` · `escritaPedido` · `webhookDeVenda` · recarga por janela de data | Declaração de capacidades; **degradação anunciada** na interface |
| D-03 | Existe ambiente de **homologação**? | M-10. Sem ele, ensaio de carga roda contra produção — inaceitável |
| D-04 | Janela de manutenção e horário de menor carga | Define a janela da carga histórica |
| D-05 | Contato técnico nomeado e SLA de resposta | O ERP é terceiro no cronograma (§7) |
| D-06 | O ERP **altera venda retroativamente**? (cancelamento, correção de valor) | TR-10 — se sim, a conciliação nunca fecha sem data de corte contábil |
| D-07 | Definição oficial de "valor da venda": bruto, líquido, com frete, com desconto, com devolução | ⚠️ **DIV-03.** É a divergência mais comum e a mais política |

### 1.E O que usam hoje

| # | Pergunta | Por que importa |
|---|---|---|
| E-01 | Ferramenta atual (Tailor, planilha, WhatsApp puro) e há quanto tempo | Define o que existe para exportar |
| E-02 | Data de renovação/carência do contrato atual | ⚠️ Cancelar antes de exportar é **irreversível** (§4) |
| E-03 | O que a ferramenta atual **exporta**, e em que formato | Se não exporta opt-out, o item E-04 vira bloqueio |
| E-04 | **Lista de opt-out / bloqueio** — existe? exporta? | ⚠️ Obrigatório antes do primeiro disparo (INV-13/15/50). Risco jurídico, não conveniência |
| E-05 | Templates, listas, funis, tarefas e campanhas em uso | Recomenda-se **recriar**, não importar (§2.7) |
| E-06 | Quem tem acesso de administrador na ferramenta atual | Sem admin, não há exportação |
| E-07 | Relatório que o gestor olha hoje, toda segunda | É contra ele que o nosso vai ser comparado. Reproduzi-lo é requisito de aceitação social |

### 1.F Meta — ⚠️ o item mais subestimado do levantamento

| # | Pergunta | Consequência |
|---|---|---|
| F-01 | O cliente tem Meta Business Manager próprio? Quem é admin? | Sem admin do BM, o Embedded Signup não conclui |
| F-02 | Os números **já estão em API Oficial**, dentro de uma WABA de terceiro (a ferramenta atual)? | ⚠️ Se sim, **não é Embedded Signup — é portabilidade de número entre WABAs**, e depende de ação do detentor atual, que está perdendo o cliente. Ver **TR-01** |
| F-03 | Os números estão no **WhatsApp Business App** (celular)? PIN de verificação em duas etapas é conhecido? | Sem o PIN, o registro na Cloud API falha no dia D |
| F-04 | Método de pagamento cadastrado na conta Meta do cliente? | ADR-002 — **o cliente paga a Meta direto**. Sem isso o número não envia |
| F-05 | Nome de exibição (display name) desejado por número | Aprovação da Meta leva dias; submeter em T-2 |
| F-06 | Há número que será **novo** (vendedora nova)? | Número novo não tem histórico nem reconhecimento — só para caso novo |

⚠️ **F-02 pode ser mais lento que o Business Verification (M-04) e não está em nenhum documento do
projeto.** Entra como **M-13** no §1 do plano da Onda 0.

### 1.G Jurídico e LGPD

| # | Pergunta |
|---|---|
| G-01 | Base legal do tratamento e existência de consentimento registrado |
| G-02 | Quem assina o DPA; há encarregado (DPO) nomeado |
| G-03 | Retenção exigida por contrato ou por política do cliente (conversa, mídia, venda) |
| G-04 | Autorização formal para nós processarmos a cópia da base (M-11), com anonimização definida |

---

## 2. Carga histórica e **conciliação**

⚠️ **`conexao_erp_cobertura = 'completa'` e INV-57 batendo provam que a carga é internamente
consistente. Não provam que ela está certa.** Uma carga que trouxe 60% das vendas fecha INV-57
perfeitamente — os contadores batem com o que entrou. A conciliação é o **único** mecanismo que
compara o que entrou com o que o ERP diz.

### 2.1 Ordem e horizonte

| Ordem | Fluxo | Por quê | Cobertura declarada |
|---|---|---|---|
| 1 | `customers` | Venda sem contato vira órfã; contato precisa existir antes | `desde`/`ate` do cadastro |
| 2 | `products` | Item de venda referenciando SKU inexistente vira DIV-10 | idem |
| 3 | `orders` | Depende dos dois | ⚠️ É a cobertura que o RFV consulta (INV-56) |

**Horizonte mínimo: 24 meses** (é a janela do RFV). Recomendado: 36–60, se o ERP tiver e a janela
comportar. ⚠️ Se o ERP só tem 18 meses, isso é **informado ao cliente em T-5 e escrito em
`o-que-nao-migra.md`** — senão, no primeiro mês, "o sistema perdeu meus clientes antigos".

### 2.2 O relatório de conciliação (RC)

Comando executável, saída em Markdown + CSV, gerado três vezes: sobre o ensaio (T-3), sobre a carga
de produção (T-2) e final (T+6).

| # | Comparação | Corte | Tolerância | Bloqueia go-live? |
|---|---|---|---|---|
| **RC-01** | Quantidade de vendas e **soma em centavos** por mês, nos 24 meses | mês | **zero** em quantidade; **zero** em centavos | ✅ Sim |
| **RC-02** | Idem, por **filial × mês** | filial | zero | ✅ Sim |
| **RC-03** | Idem, por **vendedora × mês** | vendedora | zero em qtd; divergência de valor aceita só se explicada por DIV-05 | ⚠️ Bloqueia metas e ranking (Onda 2), não o canal |
| **RC-04** | **Top 200 clientes** por valor: total, qtd, primeira e última compra | contato | zero | ✅ Sim |
| **RC-05** | Cadastros: contatos no ERP × criados × casados por chave **forte** × criados por ausência de chave × `conflito_identidade` abertos | — | as cinco somas precisam **fechar** | ✅ Sim |
| **RC-06** | Cobertura: primeira e última data por fluxo, e **meses sem nenhuma venda** | mês | cada buraco explicado (feriado, sazonalidade, dado ausente) | ✅ Sim |
| **RC-07** | Reconciliação interna (INV-57): `contato.qtd_vendas` × `mv_metricas_contato` | contato | 100% | ✅ Sim — mas ⚠️ **é teste, não conciliação** |
| **RC-08** | Produtos: SKUs ativos; SKUs referenciados em item de venda que não existem no cadastro | SKU | zero órfãos | Não (degrada catálogo) |
| **RC-09** | **10 CNPJs estratificados** conferidos linha a linha: nomes, telefones, documentos, endereços, vendas | contato | zero | ✅ Sim |
| **RC-10** | Opt-outs importados × opt-outs exportados do sistema antigo | — | zero | ✅ Sim — **risco jurídico** |

**Estratificação de RC-09** (substitui o "um CNPJ" do checklist §8 do plano): o maior cliente · um
mediano · um sem documento · um com duplicidade conhecida · um inativo há > 12 meses · um com
telefone de 8 dígitos · um de cada filial (até 3) · um com devolução registrada.

⚠️ **Quem assina é o gestor comercial, não o TI.** Quem assina precisa ser quem vai cobrar o número
depois. TI assina que o job rodou; só o comercial assina que o faturamento é aquele.

### 2.3 Taxonomia de divergências (DIV)

⚠️ **Divergência sem nome vira "coisa do sistema novo".** Toda linha do relatório cai numa
categoria, ou o relatório não está pronto.

| Código | Divergência | Causa mais provável | Ação | Bloqueia |
|---|---|---|---|---|
| **DIV-01** | Venda no ERP, ausente no CRM | Filtro do adaptador (status, tipo de documento, empresa/filial não mapeada) | Corrigir a regra e reprocessar a janela | ✅ |
| **DIV-02** | Venda no CRM, ausente no ERP | Reingestão duplicada, ou venda vinda de conexão **não-fonte** (INV-55) | Investigar `venda_chave_externa`; abrir conflito | ✅ |
| **DIV-03** | Quantidade bate, **soma não** | Definição de "valor": bruto × líquido × frete × desconto × devolução | ⚠️ Fechar **uma** definição em T-5, por escrito (D-07) | ✅ |
| **DIV-04** | Venda cancelada ou devolvida depois | O ERP altera retroativamente (D-06) | Definir: some, ou entra negativa. Afeta o RFV | ✅ (regra) |
| **DIV-05** | Venda sem vendedora, ou vendedora sem de-para | `usuario_identidade_externa` incompleto | Completar o de-para | ⚠️ Onda 2 |
| **DIV-06** | Mesmo CNPJ em dois contatos | Duplicidade **do ERP**, não nossa | Fila de deduplicação, com número declarado no relatório | ❌ |
| **DIV-07** | Contato sem documento | 40% da base de referência | §2.4 | ❌ |
| **DIV-08** | Mês de fronteira diverge, os demais batem | **Fuso horário**: venda gravada em UTC × data local do ERP | Normalizar no adaptador e reprocessar | ✅ |
| **DIV-09** | Diferença de centavos constante por linha | Arredondamento — alguém usou float onde ADR-006 manda centavos | Achar o ponto; nunca tolerar | ✅ |
| **DIV-10** | Item de venda com SKU inexistente | `products` carregado depois, ou SKU excluído no ERP | Recarregar `products`; SKU morto vira registro sem catálogo | ❌ |

### 2.4 Contato sem CPF/CNPJ — o caminho dos 40%

Aplica a §6.2 do modelo, sem exceção:

```
tem documento válido (DV conferido)?
  ├─ sim → casa por chave FORTE (nível 2)
  └─ não →
       tem telefone que já é PRINCIPAL de outro contato?
         ├─ sim → cria contato próprio; telefone entra como SECUNDÁRIO;
         │        abre conflito_identidade; ⚠️ o lote NÃO falha (INV-49)
         └─ não → cria contato próprio, com telefone principal
                  ⚠️ marcado com origem_carga = 'sem_chave_forte'
```

- ⚠️ **Nunca fundir por telefone.** Chave média sozinha vira **sugestão**, nunca fusão. Fundir errado
  é irreversível na prática: mistura histórico de compra e corrompe o RFV dos dois.
- ⚠️ **Nunca deixar de fora "para não sujar a base".** Base sem eles **não bate com o ERP** e o
  cliente perde a confiança no primeiro relatório. Importa tudo, marca o que não tem chave.
- O número de "não informado" é **KPI de linha de base**, não vergonha escondida — e vira meta
  semanal de higienização do cliente. É a antecipação numérica de RFV-08, sem a tela.
- ⚠️ **Consequência operacional a dizer antes:** contato sem cadastro fiscal **conversa**, mas
  **não fecha pedido** — o erro `pedido.cliente_sem_cadastro_fiscal` aparece na Onda 2 e a resposta
  já está desenhada ("abrir ficha para completar"). Descobrir isso na primeira venda é ruim.

### 2.5 Execução

| Regra | Detalhe |
|---|---|
| Lotes | 1.000–5.000 linhas, transação curta, `cursor_retomada`, `statement_timeout`, pool próprio |
| Retomada | Testada com `kill -9` no meio do lote — já é DoD de E2-07 |
| Idempotência | Mesmo lote reenviado não muda a contagem (E2-03) |
| Horário | Fora do expediente, dentro da janela de manutenção do ERP (D-04) |
| Réplica | ⚠️ Lag durante a carga é esperado; o painel **declara a hora de apuração**, nunca finge tempo real |
| **Dois ensaios** | **ENS-1** em T-4, sobre a cópia real em homologação → mede duração e acha DIV. **ENS-2** em T-1, em produção, carga completa |
| **Delta de véspera** | Entre a carga de T-1 e o corte, o ERP continuou vendendo. Em T (D-0) roda **recarga por janela de data** |

⚠️ **Os ensaios chamam-se `ENS-1` e `ENS-2`, nunca `E1` e `E2`.** No `plano-onda-0.md`, `E1-xx` e
`E2-xx` são **prefixos de tarefa por épico** (`E1-01` = EP-01, `E2-16` = EP-02) — e este documento
usava os dois sentidos em seções vizinhas (§2.5 e §9.1). Uma frase como *"E2 depende de E2-07"* tem
duas leituras corretas e nenhuma delas óbvia.

⚠️ **A "recarga por janela de data" agora existe no plano:** é **E2-18 / INT-16**, na porta e no
adaptador. Sem ela, o delta de véspera exigiria recarregar tudo na madrugada do corte.

⚠️ **A duração medida no ensaio ENS-1 é o que define a janela do go-live.** Prometer data antes de
medir é a origem do go-live que vira madrugada.

### 2.6 O que **não** migra — lista fechada, assinada pelo cliente

| Não migra | Por quê | Mitigação |
|---|---|---|
| **Histórico de conversas do WhatsApp** anterior à conexão | A Meta não entrega histórico por API; ele vive no aparelho/app | A ficha do cliente nasce com o histórico de **compra** completo — que é o que sustenta recompra — e o de **conversa** zerado. Manter o aparelho antigo por 90 dias |
| **Janela de 24h** | Não é dado: é estado **derivado** do último inbound recebido **pela nossa API** | ⚠️ No minuto do corte, **todas** as conversas estão fechadas (§3.3) |
| **Mídia antiga** (áudio, foto de grade) | Idem | Idem |
| **Templates HSM aprovados** na WABA antiga | Template pertence à WABA, não ao número | ⚠️ Recriar e **submeter em T-2** — aprovação leva dias |
| Funis, tarefas, sequências, campanhas do sistema antigo | Semântica diferente; volume pequeno | **Recriar**, não importar. Importar semântica alheia contamina o modelo |
| Métricas históricas do sistema antigo | Fonte não auditável | A linha de base vem do **ERP** (§6.1) |
| **Opt-out / lista de bloqueio** | ⚠️ **ESTE MIGRA. Obrigatoriamente.** | E-04 → **E2-19**. Exportar **antes** de cancelar o contrato antigo. Sem isso, o primeiro disparo escreve para quem pediu para sair |

---

## 3. Conexão dos números — piloto antes da frota

### 3.1 A ordem, e o gate entre fases

| Fase | Quando | O que conecta | Gate para avançar |
|---|---|---|---|
| **0** | S3–S5 | Número de teste da Gera3 (M-08), em homologação | Fluxo completo sem cliente |
| **1** | **T** | **1 número piloto** | Critérios D+7 da §6.2 |
| **2** | T+1 | +2 números da mesma filial | ✅ Fecha o **critério de saída nº 2** da Onda 0 (3 números). Gate D+7 |
| **3** | T+2 | Restante da filial-sede | Gate D+7 |
| **4** | T+3…T+5 | Uma filial por semana | Gate D+7 por filial |

**Quem é o número piloto:** a vendedora de volume **mediano**, alta disposição, presente
fisicamente na sede.

⚠️ **Não é a melhor vendedora** — põe o maior faturamento no maior risco, e ela é justamente quem
mais perde com o histórico de conversa zerado. **Não é a pior** — contamina a avaliação: tudo que
der errado será atribuído ao sistema, e tudo que der certo, a ela.

⚠️ **Nunca conectar dois lotes na mesma semana.** O que falha no lote 2 precisa ser distinguível do
que falha no lote 1.

### 3.2 Os três casos de conexão

| Caso | Situação do número | O que é, tecnicamente | Risco |
|---|---|---|---|
| **A** | WhatsApp Business App (celular) | Registro na Cloud API via Embedded Signup. ⚠️ **Desliga o app naquele número** | Médio — depende só do PIN (F-03) e do cliente |
| **B** | Já em API Oficial, **em WABA de terceiro** | **Portabilidade entre WABAs.** Não é o Embedded Signup padrão; exige ação do detentor atual | ⚠️ **Alto — TR-01.** O detentor é o concorrente que está perdendo o cliente |
| **C** | Número novo | Registro limpo | Baixo tecnicamente, alto comercialmente: o lojista não reconhece o número. Só para vendedora nova |

### 3.3 O que acontece com as conversas em andamento no dia da conexão

Sequência real, do ponto de vista de uma conversa aberta:

```
D-0  17h30  a vendedora responde normalmente pelo app antigo
D-0  18h30  registro do número na Cloud API  ─── ponto de corte
            ├─ o app antigo para de receber naquele número
            ├─ o histórico local FICA no aparelho e NÃO vem para a API
            └─ nenhuma janela de 24h é herdada
D+1  08h10  o lojista manda "bom dia, chegou a grade?"
            ├─ webhook → conversa nasce no GeraCRM
            ├─ casa por telefone principal (INV-49) com o contato do ERP
            └─ a janela de 24h abre AGORA, pelo inbound
```

⚠️ **A consequência que surpreende:** no minuto do corte, a vendedora que estava no meio de uma
negociação **não consegue responder livremente** — a conversa está, para nós, fora da janela. Só
template aprovado. Ela não perdeu o cliente; perdeu a permissão de falar primeiro em texto livre.

**Por isso, três regras não negociáveis:**

1. **Corte fora do horário de pico**, no fim do expediente — a maioria das janelas ativas expira
   durante a noite, e o inbound da manhã reabre naturalmente.
2. **Carta de despedida**: a última ação da vendedora no sistema antigo é avisar, nas conversas
   ativas das últimas 24h, que o atendimento continua no mesmo número. Custo zero, dentro da janela
   ainda aberta lá.
3. ⚠️ **Nenhum disparo em massa nos primeiros 14 dias de cada número.** Número recém-registrado tem
   tier inicial e qualidade sem histórico; um disparo grande é o caminho mais curto para limitar o
   número — e perder um número derruba a operação de uma vendedora inteira (**TR-05**).

### 3.4 Checklist do dia D — por número

| Quando | Item | Dono |
|---|---|---|
| D-2 | PIN de verificação em duas etapas conhecido e testado (F-03) | Cliente |
| D-2 | Método de pagamento na conta Meta ativo (F-04) | Cliente |
| D-2 | Display name aprovado (F-05) | Meta |
| D-2 | Templates de reabertura aprovados **e sincronizados pelo E3-15** | Meta + nós |
| D-2 | Vendedora concluiu B1+B2 do treinamento e passou na certificação (§5.4) | Nós |
| D-1 | Backup do aparelho / exportação das conversas críticas | Cliente |
| D-1 | Carga de produção (ENS-2) concluída e RC v2 assinado | Nós + cliente |
| D-0 | Recarga delta desde o corte do ensaio (E2-18 / INT-16) | Nós |
| D-0 | Carta de despedida enviada nas conversas ativas | Vendedora |
| D-0 | **Registro na Cloud API** | Nós (Embedded Signup) |
| D-0 | Webhook verificado; assinatura validando | Nós |
| D-0 | Teste de ida e volta com **3 números conhecidos**: texto, imagem, áudio, status de entrega | Nós + vendedora |
| D-0 | Custo por mensagem gravado (inclusive a linha de **zero centavos** dentro da janela) | Nós |
| D-0 | Nome amigável, filial e permissão por número configurados | Nós |
| D+1 08h | Acompanhamento presencial/remoto da primeira hora | Nós |
| D+1 | Auditoria: contagem de eventos no gateway × conversas visíveis | Nós |

⚠️ **Um número por vendedora significa que a saída de uma vendedora é evento de infraestrutura.**
Quem herda o número e quem herda a carteira são decisões distintas — a carteira admite linha
explícita "sem dono" (INV-58); o número, não.

---

## 4. Convivência ou corte seco — recomendação

### Recomendação: **corte seco no canal, convivência na operação, com data de fim escrita.**

| Opção | O que é | Custo | Veredito |
|---|---|---|---|
| Corte seco total | Todos os números no mesmo dia | Nenhum ensaio; falha sistêmica atinge 100% da receita | ❌ **Não.** Uma única variável errada derruba a operação inteira |
| **Corte seco por número + convivência entre vendedoras** | Lote conectado opera no GeraCRM; as demais seguem no antigo, por ≤ 4 semanas | Gestor olha dois lugares durante a transição | ✅ **Recomendado** |
| Convivência real (dupla digitação) | Registrar no antigo **e** no novo | Sempre degenera | ❌ **Proibido.** A vendedora escolhe um; o outro passa a mentir |

**Por que não há escolha no canal:** um número não pode estar na Cloud API e no WhatsApp Business
App ao mesmo tempo. Corte seco por número é imposição técnica.

### Regras da convivência

| # | Regra | Motivo |
|---|---|---|
| 1 | **O ERP continua sendo a fonte de venda para os dois** | O faturamento nunca diverge entre os sistemas, porque nenhum dos dois é a fonte |
| 2 | Durante a convivência, o **relatório de gestão é o do ERP** — não os dois CRMs | ⚠️ Se o relatório do antigo continuar sendo "o oficial", o novo nunca vira sistema de registro |
| 3 | Prazo máximo **4 semanas**, com data de fim contratada **antes** de começar | Convivência sem prazo vira estado permanente |
| 4 | O sistema antigo entra em **modo leitura** quando o último número migra | — |
| 5 | ⚠️ O contrato antigo **não é cancelado antes de D+30 do último lote**, e nunca antes das exportações do checklist E-03/E-04 | Cancelar antes de exportar o opt-out é irreversível e é risco jurídico |
| 6 | Acesso de leitura ao sistema antigo por **90 dias** após o cancelamento, se o fornecedor permitir | Consulta de conversa antiga |

⚠️ **O que decide o prazo do contrato antigo não é técnico: é o opt-out e o histórico.** O cliente
vai querer cancelar cedo para economizar. Essa economia custa o item mais caro da lista.

---

## 5. Treinamento — a rotina, não a tela

### 5.1 O que muda de fato

| Rotina | Hoje | No GeraCRM |
|---|---|---|
| Onde responde | Celular na mão, WhatsApp Web | Console no desktop, 8 h/dia |
| De quem é o cliente | Quem falou primeiro | **Carteira com dono, histórico e transferência auditável** |
| O que fazer hoje | Memória, caderno, print | Fila do dia priorizada (Onda 2) |
| Quando pode escrever | Sempre | ⚠️ **Janela de 24h**; fora dela, só template |
| Onde fica o combinado | Cabeça, áudio, print | Conversa + comentário + tarefa |
| Pedido | Papel/WhatsApp para o faturamento | Rascunho dentro do atendimento (Onda 2) |
| Quem vê o trabalho | Ninguém | ⚠️ **Todo mundo** |

⚠️ **A mudança mais dura não é a tela: é que o trabalho fica visível.** Tempo de resposta, conversa
sem resposta, carteira sem toque. Apresentado como fiscalização, mata a adoção. Precisa ser
apresentado — **e configurado** — como priorização. O gestor que abre a primeira semana cobrando
tempo de resposta destrói meses de projeto.

### 5.2 Currículo — ordem importa

| Bloco | Quando | Duração | Público | Conteúdo |
|---|---|---|---|---|
| **B1** | D-5 | 60 min | Vendedoras do lote | Por que estamos mudando · **janela de 24h** · o que é template e por que existe · **o que acontece com o histórico** |
| **B2** | D-3 | 60 min | Vendedoras do lote | Prática em homologação, com o número da Gera3: responder, buscar, anexar, ouvir áudio, marcar não lido |
| **B3** | D-0 | 30 min | Vendedora do número | O corte, os três testes de ida e volta, o que fazer se não chegar |
| **B4** | **D+3** | 45 min | Vendedoras do lote | Carteira, ficha do cliente, comentário, tarefa — **a parte que muda a rotina** |
| **B5** | D-5 | 60 min | Gestor | O painel, o que ele vai cobrar — e ⚠️ **o que ele não deve cobrar na primeira semana** |
| **B6** | D+30 | 45 min | Todos | Reciclagem com base nos **erros reais medidos**, não no roteiro |

⚠️ **B4 vem depois do corte, deliberadamente.** Antes do corte, a vendedora não tem contexto para
absorver carteira e tarefa — ela está preocupada em não perder cliente. Ensinar tudo em um dia
produz zero retenção.

### 5.3 O que costuma dar errado

| Sintoma | Causa real | Tratamento |
|---|---|---|
| "Não consigo responder esse cliente" | Janela fechada | Ensinar a **ler o anel de janela** e o caminho do template. É o item nº 1 do suporte na semana 1 |
| Volta a usar o **celular pessoal** | Perdeu o hábito, ou acha mais rápido | ⚠️ **TR-07, o maior risco de adoção.** O número dela não existe mais no app — se ela usa o pessoal, cria operação paralela **invisível**. Política escrita + acompanhamento diário na semana 1 |
| "O sistema não trouxe meus clientes" | Contato sem documento, ou fora da cobertura (INV-56) | O `perfilamento.md` e o RC estão prontos: a resposta é um número, não uma desculpa |
| "Cadê a conversa do mês passado?" | Histórico de conversa não migra | Foi dito em B1 e está em `o-que-nao-migra.md` assinado. ⚠️ Se não foi dito antes, vira quebra de confiança |
| Template rejeitado | Categoria errada (Marketing em Utility) | B5, e biblioteca pré-aprovada antes do corte |
| Áudio não ouvido | Cliente manda áudio, ela não abre no console | Player obrigatório; transcrição é Onda 2 — e é o argumento mais forte dela para voltar ao celular |
| Top vendedora resiste | É quem mais perde com o histórico zerado | Envolvê-la como **validadora do B4**, e conectá-la no lote 2 — nunca no lote 1 |

### 5.4 Certificação prática

A vendedora **só recebe o número conectado** depois de concluir B1+B2 e executar um roteiro de seis
tarefas em homologação: responder dentro da janela · reconhecer janela fechada e enviar template ·
localizar um cliente pela busca · ouvir um áudio · abrir a ficha e ler o histórico de compra ·
registrar um comentário.

⚠️ **Sem isso, o dia do corte vira treinamento com cliente esperando resposta.**

### 5.5 Suporte

Multiplicadora interna **nomeada no contrato** (C-04). Grupo de suporte direto com a Gera3 nas duas
primeiras semanas de cada lote, com SLA declarado. Depois disso, canal normal — senão o grupo vira
o produto.

---

## 6. Critério de sucesso e de **rollback**

### 6.1 Linha de base — medida **antes**, ou nunca

⚠️ Resolve a metade operacional da lacuna 4.3 de `prontidao-para-inicio`. **A linha de base é
coletada na transição ou não é coletada nunca.**

**A régua é `metricas-de-sucesso.md` §1.2 — LB-01…LB-15.** Este documento não mantém uma segunda
lista: ela divergiria da primeira no primeiro ajuste. O que cabe aqui é **quando** e **por quem**:

| Bloco | O que | Fonte | Quando | Reconstituível? |
|---|---|---|---|---|
| **LB-01…LB-09** | Receita, compradores ativos, recompra 90 d, tempo até o 2º pedido, ticket **e mediana**, intervalo entre compras, foto RFV, qualidade cadastral, clientes "invisíveis" | **ERP**, sobre a carga histórica — **24 meses**, e ⚠️ **nunca fora de `conexao_erp_cobertura`** (INV-56) | Quando der, depois da carga | ✅ sim |
| **LB-10…LB-12** | 🔴 **Conversas/dia por vendedora · tempo até a primeira resposta (mediana e p90) · % de entrantes sem resposta em 24 h** | **Janela de sombra** — 2 semanas com a equipe ainda no sistema antigo: contagem diária de conversas, **amostra de 30 conversas por vendedora** para tempo de resposta, contagem de sem resposta às 18h. Se o antigo exporta, a exportação vem primeiro; se o cliente opera em WhatsApp puro, a **exportação de conversa do próprio aplicativo** carrega os horários e reconstrói LB-11/LB-12 melhor que qualquer declaração | **T-8**, 2 semanas **antes** da ficha de entrada | 🔴 **não** |
| **LB-13…LB-15** | Volume e custo de disparo atual · custo das ferramentas atuais · nº de vendedoras, números e horas/dia | Fatura do BSP, contratos, declarado (como **faixa**, nunca número) | T-6, com a ficha | 🔴 **não** |

⚠️ **A "amostra manual de 3 dias" que este documento pedia foi substituída pela janela de sombra de
2 semanas.** Três dias não distinguem segunda-feira de sexta em atacado de moda, e a **média** que
ela produzia é a estatística errada: uma conversa esquecida por 14 horas move a média e não move a
mediana. O instrumento é **mediana e p90 sobre 30 conversas por vendedora**, com a `fonte` gravada
em `linha_base_metrica` (`export_antigo` \| `medido` \| `declarado`).

⚠️ **A sombra roda ANTES de a equipe saber da mudança.** Depois do anúncio, o tempo de resposta
melhora sozinho — e a Onda 1 perde o crédito por uma melhora que já tinha acontecido. Como T-6 já é
uma conversa com o gestor sobre carteira e vendedoras (§1.C), **T-8 é o último momento em que a
medição ainda é do estado anterior**.

⚠️ **Toda comparação posterior é contra o mesmo mês do ano anterior, sazonalizada** — nunca contra
as semanas imediatamente anteriores. Sazonalidade de coleção domina o atacado de moda: virada em
janeiro comparada com dezembro "prova" queda de 40% que não existe.

⚠️ **Sem tempo de resposta de base, não se pode afirmar que piorou nem que melhorou — e a primeira
reclamação vira verdade por falta de contraditório.**

### 6.2 Critérios de sucesso, por marco

| Marco | Critério | Número | Fonte |
|---|---|---|---|
| **D+0** | Número recebe e envia; mídia e áudio funcionam; status de entrega chega; custo gravado (inclusive linha de zero centavos) | 3/3 testes | Log + banco |
| **D+1** | **Zero** mensagem entrante perdida | contagem de eventos do gateway = conversas visíveis | Auditoria |
| **D+1** | Tempo de primeira resposta | ≤ base × 1,5 | GeraCRM × §6.1 |
| **D+7** (gate do lote) | Conversas atendidas **dentro** do console | ≥ 95% | Relato + ausência de canal paralelo |
| **D+7** | Qualidade do número na Meta | alta | Painel Meta |
| **D+7** | Incidentes P1 abertos | 0 | Sentry + diário |
| **D+7** | Tempo de primeira resposta | ≤ base | GeraCRM |
| **D+30** | Faturamento da vendedora/filial | ⚠️ **≥ 95% do mesmo mês do ano anterior, sazonalizado** (LB-01) — **nunca** contra as 8 semanas anteriores | ERP |
| **D+30** | Relatório de conciliação final | assinado, sem DIV bloqueante aberto | `conciliacao-<data>.md` |
| **D+30** | Base classificada pelo RFV | ≥ 80%; o restante **justificado por INV-56**, não por falha | `mv_rfv_segmento_atual` |
| **D+30** | Sistema antigo | em modo leitura | Contrato |

⚠️ **O critério de faturamento não é "vender mais". É não cair.** Migração bem-sucedida é migração
que o negócio não sentiu. Ganho de receita é promessa da Onda 3 (campanhas com receita atribuída),
não da transição — e prometer ganho na semana 1 é o jeito mais rápido de perder o cliente na 4.

⚠️ **Sucesso não é "todo mundo gostou". É número com fonte declarada.**

### 6.3 Gatilhos de rollback (RB)

| # | Gatilho | Medida | Ação | Decisor |
|---|---|---|---|---|
| **RB-01** | Mensagem entrante **comprovadamente perdida** | > 0 em 24h | **Parar novos lotes**, investigar. ⚠️ **Não reverte o número** — reverter perde também o que já entrou | Nós (técnico) |
| **RB-02** | Número limitado ou qualidade "baixa" por ação nossa | evento da Meta | Pausar disparo (CAN-06), investigar volume. Não reverte | Nós |
| **RB-03** | Queda de faturamento da vendedora piloto | > 15% em 2 semanas consecutivas, sem causa externa identificada | **Rollback do número** (§6.4) | Cliente (C-07) + nós |
| **RB-04** | Conciliação com DIV-01/02/03/08/09 aberto na véspera | qualquer | ⚠️ **Adiar o go-live.** Não reverte nada. É o rollback mais barato — e o mais evitado por orgulho | Nós + gestor comercial |
| **RB-05** | ERP indisponível em janela comercial | > 2h, 2× em 7 dias | Suspender novos lotes. O produto **degrada** (ADR-008), não reverte | Nós |
| **RB-06** | Vendedora operando por canal paralelo | > 20% das conversas | ⚠️ Problema de **treinamento**, não de sistema. Repetir B1/B4. Não reverte | Cliente |
| **RB-07** | Incidente de isolamento entre tenants | qualquer | **Parada total imediata**, independente de tudo | Nós |

⚠️ **Prazo de decisão: 24h do gatilho.** Rollback sem decisor nomeado e sem prazo vira reunião — e
reunião durante incidente é a forma mais cara de não decidir.

### 6.4 O que rollback significa em cada fase — o ponto de não retorno

| Fase | Reverter significa | Custo | Reversível? |
|---|---|---|---|
| Antes do corte do 1º número | Cancelar. Nada foi tocado no canal | Tempo | ✅ Total |
| Número conectado, < 7 dias | Desregistrar da Cloud API e re-registrar no WhatsApp Business App | Horas; exige o PIN. ⚠️ As conversas do período **não vão** para o app | ⚠️ Parcial |
| Frota conectada + carga concluída | Reconstruir a operação inteira em outro lugar | Semanas | ⚠️ **PONTO DE NÃO RETORNO.** A partir daqui, rollback realista é **"congelar e corrigir"**, não "voltar" |
| Sistema antigo cancelado | — | — | ❌ Irreversível |

⚠️ **Consequência contratual direta:** o contrato do sistema antigo **não pode ser cancelado antes
de D+30 do último lote**. Isso vai no nosso contrato, não numa conversa.

### 6.5 Registro

Toda decisão de gate e de rollback vira uma linha em `diario-da-migracao.md`: data, número, gatilho,
decisão, decisor. ⚠️ **Sem diário, o segundo cliente repete os mesmos erros e ninguém sabe explicar
por quê.**

---

## 7. Cronograma-tipo

| Semana | Marco | Nós | Cliente | ERP | Meta |
|---|---|---|---|---|---|
| **T-8** | 🔴 **Janela de sombra abre** — 2 semanas medindo o **sistema antigo** (LB-10, LB-11, LB-12), **antes** da ficha de entrada | Entregar o instrumento e a planilha de contagem; treinar quem vai medir; congelar o método antes de começar | **Uma pessoa, ~1 h/dia**: contagem diária de conversas, 30 conversas por vendedora, sem resposta às 18h | — | — |
| **T-6** | Ficha de entrada + cópia da base | Conduzir §1.A/C/E/F/G; abrir **M-13** (situação dos números na Meta) | Assinar; entregar cópia (M-11); nomear decisor e multiplicadora | Liberar credenciais de homologação (M-10) | Business Verification já correndo (M-04) |
| **T-5** | **Perfilamento entregue** + definições fechadas | Rodar §1.B; entregar `perfilamento.md`, `linha-de-base.md`, `o-que-nao-migra.md` | ⚠️ Fechar **definição de "valor da venda"** (D-07) e a regra de cancelamento (D-06). Assinar `o-que-nao-migra` | Responder D-01…D-06 | Tech Provider (M-05) |
| **T-4** | **Ensaio ENS-1 de carga** em homologação, sobre a base real | Medir duração; gerar RC v0 | Entregar de-para de vendedoras | Ajustar filtros/consultas conforme DIV | App Review submetido (M-07) |
| **T-3** | **Conciliação v1** + divergências nomeadas | Classificar toda linha em DIV; corrigir e reprocessar | Responder DIV-01/02/03 | — | — |
| **T-2** | Conciliação v2 fecha · treinamento B1/B2/B5 · verificações Meta | Executar B1/B2/B5; submeter templates e display name | Liberar admin do BM; **cadastrar método de pagamento**; exportar **opt-out** | — | Aprovação de templates e display name |
| **T-1** | **Carga de produção** (ENS-2) + ensaio de corte | Executar; RC v2 assinado; checklist do dia D | Assinar RC v2; confirmar a janela | Janela de manutenção | — |
| **T** | **Corte do número piloto** | Delta + registro + 3 testes + B3; monitoramento 48h | Vendedora presente; carta de despedida | — | Embedded Signup |
| **T+1** | Gate D+7 do piloto → **lote 2 (+2 números)** | ✅ Fecha o critério de saída nº 2 da Onda 0 | — | — | — |
| **T+2** | Restante da filial-sede · **B4** com todas | — | — | — | — |
| **T+3…T+5** | Uma filial por semana, com gate D+7 | — | — | — | — |
| **T+6** | **D+30 do piloto** · conciliação final · antigo em leitura · retrospectiva | Assinar RC final; fechar o diário | Colocar o antigo em leitura (⚠️ não cancelar) | — | — |

⚠️ **T-8 é a única linha deste cronograma que não pode escorregar para a direita.** Todas as outras
custam prazo quando atrasam; esta custa **o dado**. LB-10, LB-11 e LB-12 são 🔴 não reconstituíveis
(`metricas-de-sucesso` §1.2): a janela fecha no `primeiro_corte` e não reabre. E ela precisa vir
**antes de T-6**, porque T-6 já é uma conversa com o gestor sobre carteira, vendedoras e turnover
(§1.C) — a partir daí a equipe sabe da mudança, e o tempo de resposta melhora sozinho.

⚠️ **A sombra não consome engenharia.** É uma pessoa do cliente, uma hora por dia, com planilha. O
que ela consome é **decisão antecipada**: quem mede, com que método, e o congelamento do método
antes da primeira contagem. O artefato final é `linha-de-base.md`, carregado em `linha_base_metrica`
(PLT-12) com `fonte` gravada — não uma planilha solta no Drive.

### ✅ O encaixe com o plano da Onda 0 — decidido: saída (b), ADR-015

O ensaio ENS-1 (T-4) depende de **E2-07/E2-08**, que o plano posiciona na **S6**. Levado a sério,
isso punha o corte do piloto em **S10** e o critério de saída nº 2 em **S11** — dez semanas sem
marco verificável no caminho.

**A escolha está feita e é a (b)**, registrada em **ADR-015**:

| Saída | Estado |
|---|---|
| **(a)** Onda 0 passa a 10–11 semanas, com o cliente dentro | ❌ **Descartada** |
| **(b)** Critério nº 2 atendido com **números da Gera3** (dogfooding); o cliente entra na **Onda 1** | ✅ **Decidida — ADR-015** |

**Consequências que este documento assume:**

| O que muda | Detalhe |
|---|---|
| **Este cronograma (T-8…T+6) é executado na Onda 1**, não na Onda 0 | O corte do primeiro número é o **primeiro bloco da Onda 1**, e depende do inbox (EP-05) e da certificação prática da §5.4 — cinco das seis ações certificadas são Onda 1 |
| ⚠️ **T-8 e T-6 começam AGORA, mesmo assim** | A janela de sombra e **M-13** medem/destravam o **estado anterior**. Adiá-los para a Onda 1 é perdê-los: a sombra fecha no primeiro corte, e a portabilidade entre WABAs depende de um terceiro hostil com até 3 semanas de espera |
| **A carga histórica e a conciliação permanecem na Onda 0** | São o critério de saída nº 1, e é o que dá seis semanas de sinal verificável |
| ⚠️ **O plano da Onda 1 deixa de ser macro** | É nela que o cliente entra; ela precisa do detalhe de `plano-onda-0.md`, com semanas — `plano-ondas-1-4.md` §3 já a abre com a transição como **escopo da onda** |

⚠️ **A frase que estava aqui — *"não escolher é escolher (b) por omissão, sem plano"* — deixou de
valer no pior sentido possível: escolheu-se (b), e agora o plano da Onda 1 é dívida com data.**

---

## 8. Riscos específicos da transição

| # | Risco | P × I | Sinal antecipado | Mitigação | Dono |
|---|---|---|---|---|---|
| **TR-01** | ⚠️ **Números já em WABA de terceiro** e o detentor atual não coopera com a portabilidade | Alta × **Alto** | F-02 sem resposta clara em T-6 | Levantar em T-6; **o cliente**, como dono do BM, abre a solicitação por escrito; prever 3 semanas. Plano B (número novo) só para vendedora nova — perde reconhecimento de base. ⚠️ **Pode ser o caminho crítico real, acima da Meta e da carga** | Cliente + nós |
| **TR-02** | Definição de "valor da venda" diverge (DIV-03) | Alta × Alto | RC v0 com qtd batendo e soma não | Fechar por escrito em T-5 com o **gestor comercial** | Gestor comercial |
| **TR-03** | Os 40% sem documento viram "o sistema perdeu clientes" | Alta × Médio | — | Entregar `perfilamento.md` **antes** da carga, assinado | Nós |
| **TR-04** | Janela fechada no corte trava negociação em andamento | Alta × Médio | — | Corte fora do expediente + carta de despedida + templates aprovados em T-2 | Nós |
| **TR-05** | Disparo em massa em número recém-conectado limita o número | Média × **Alto** | Pedido de campanha na semana 1 | **Proibição escrita** de campanha nos primeiros 14 dias de cada número; CAN-06 pausa automática | Nós |
| **TR-06** | Opt-out histórico não exportado antes do cancelamento do antigo | Média × **Alto (jurídico)** | E-04 sem resposta | Exportação é pré-requisito do **go-live**, não do cancelamento (RC-10) | Cliente |
| **TR-07** | Vendedora volta ao celular pessoal → operação paralela invisível | **Alta** × Alto | Queda de conversas/dia no número sem queda de faturamento | Política escrita, acompanhamento diário na semana 1, RB-06 | Gestor |
| **TR-08** | Carga de produção estoura a janela ou pressiona a primária | Média × Alto | Duração do ensaio ENS-1 > 1/3 da janela | Lotes curtos; janela com **3× folga** sobre o medido; partições criadas antes | Nós |
| **TR-09** | Top vendedora no lote 1 | Média × Alto | — | Regra da mediana (§3.1) | Nós |
| **TR-10** | ERP altera venda retroativamente → conciliação nunca fecha | Média × Médio | RC v1 e v2 divergindo em meses já fechados | **Data de corte contábil**: conciliar o "estado em D", com o snapshot guardado | Nós + ERP |
| **TR-11** | Cliente cancela o sistema antigo cedo para economizar | Média × **Alto** | Pergunta "posso cancelar já?" | Cláusula: cancelamento só após D+30 do último lote e após o checklist de exportação | Nós (contrato) |
| **TR-12** | Gestor cobra tempo de resposta na semana 1 | Alta × Médio | — | B5 trata explicitamente; combinar por escrito o que **não** se cobra na semana 1 | Nós |

---

## 9. O que isto muda na Onda 0

Itens acionáveis. Cada um altera um documento existente.

### 9.1 Novas tarefas em EP-02 (`plano-onda-0.md` §5.2)

⚠️ **Toda tarefa carrega o ID de requisito** — `processo-de-trabalho` §0, regra 1: *"trabalho sem ID
de requisito não entra; nem tarefa, nem branch, nem commit"*. Os IDs abaixo foram criados em
`escopo-funcional-geracrm.md` §3, §4 e §7. **Já aplicadas em `plano-onda-0.md` §5.2.**

| # | Requisito | Tarefa | Dep. | Definição de pronto |
|---|---|---|---|---|
| **E2-16** | `INT-14` | **Relatório de conciliação** (RC-01…RC-10) como comando executável, saída Markdown + CSV, gravando em `conciliacao_execucao`/`conciliacao_divergencia` | E2-07, E2-08, D-18 | `dado o ERP com 3 vendas a mais em março, quando roda, então RC-01 acusa o mês, a diferença em centavos e classifica como DIV-01` |
| **E2-17** | `INT-15` | **Perfilamento de base** (§1.B) como comando, sobre a cópia anonimizada por **R-11** | E2-03, R-11 | Roda na **S1**; produz as 10 métricas de B-01…B-10 e `perfilamento.md`. ⚠️ B-03/B-04 exigem anonimização **determinística** |
| **E2-18** | `INT-16` | **Recarga por janela de data** (delta) na porta e no adaptador | E2-01, E2-07 | `dada recarga de 01/03 a 07/03, quando roda, então só a janela é reprocessada e nada duplica` |
| **E2-19** | `CTT-16` | **Importação de opt-out histórico** para `lista_bloqueio`, por `chave_bloqueio` (INV-50), com `origem='migracao'` | E2-15, D-09 | `dado opt-out importado com 12 dígitos, quando a campanha materializa o contato de 13, então o gateway bloqueia` |
| **E2-20** | `INT-17` | **De-para de vendedoras e filiais** (`usuario_identidade_externa`, `filial_identidade_externa`) obrigatório antes de RC-03 | E1-03, E2-03, D-07 | RC-03 **falha explicitamente** se houver vendedor do ERP sem de-para — não silencia e não agrega em "outros" |
| **E2-21** | `CTT-17` | Marcar contato criado **sem chave forte** (`contato.origem_carga`) | E2-05, D-08 | O número aparece em RC-05 e alimenta a fila de deduplicação |

### 9.2 Nova migration

- **D-18 / `0018_conciliacao.sql`** — `conciliacao_execucao` e `conciliacao_divergencia` (código DIV,
  valores das duas fontes, estado, responsável, `resolvido_em`).
  ⚠️ **Divergência sem estado e sem responsável vira PDF morto.** O relatório precisa ser
  consultável, não só gerado.
- ⚠️ **Era `0017` e foi renumerada.** `metricas-de-sucesso.md` §6.2 reservou `0017_metricas_produto`
  no mesmo dia, e as duas reservas colidiram **no planejamento**, antes de existir PR. A reserva
  agora vive na tabela §4 de `plano-onda-0.md` — que é o lugar onde `processo-de-trabalho` §3.2
  manda procurar o próximo número livre, e não na cabeça de quem escreveu o documento.

### 9.3 Correções no plano da Onda 0 — ✅ aplicadas

| Onde | Mudança | Estado |
|---|---|---|
| **Critério de saída nº 1** | "Carregada **e reconciliada**" passa a exigir **conciliação com RC assinado**. ⚠️ INV-57 e `cobertura='completa'` são **consistência interna** — fecham perfeitamente numa carga que trouxe 60% das vendas | ✅ aplicada |
| **Critério de saída nº 3** | "Um CNPJ conferido linha a linha" → **RC-09, 10 CNPJs estratificados** | ✅ aplicada |
| **Checklist §8** | RC assinado · opt-out histórico importado (RC-10) · **linha de base congelada (MN-01)** · `tenant_marco` · consultas `.sql` versionadas | ✅ aplicada |
| **§1.1 (caminho crítico Meta)** | **M-13 — situação atual dos números na Meta** (F-02) | ✅ aplicada, com o risco nº 10 |
| **§5.2 (EP-02)** | As seis tarefas **E2-16…E2-21**, com ID de requisito | ✅ aplicada |
| **§5.5 (sequência)** | Ficha de entrada em **S0**; perfilamento (E2-17) em **S1**; E2-16/18/19/20/21 em **S6**; **sombra 2 semanas antes da ficha** | ✅ aplicada |
| **Duração** | Decidido: **(b)**, ADR-015 — ~6 semanas, sem o piloto real dentro | ✅ decidida |
| **§6 (riscos)** | TR-01, TR-05, TR-06, TR-07 e TR-11 incorporados como riscos **10 a 14** | ✅ aplicada |

### 9.4 Decisões que este documento fecha

| Decisão | Estado |
|---|---|
| **Pendente nº 5 da stack** (volume real do cliente) | ✅ Instrumento definido: `ficha-de-entrada` (§1.A) + `perfilamento` medido (§1.B). ⚠️ Volume **medido**, nunca estimado |
| **Convivência × corte seco** | ✅ Corte seco por número (imposição técnica) + convivência entre vendedoras, ≤ 4 semanas, com data de fim contratada |
| **Ordem de conexão** | ✅ Piloto mediano → +2 na mesma filial → filial-sede → uma filial por semana, com gate D+7 |
| **Ponto de não retorno** | ✅ Frota conectada + carga concluída. Depois disso: congelar e corrigir |

### 9.5 O que ainda falta, e onde

| Lacuna | Onde deve ser resolvida |
|---|---|
| Métricas de **produto** por onda (lacuna 4.3 de `prontidao-para-inicio`) | Este documento cobre a **linha de base operacional** (§6.1). A métrica de valor por onda continua sem dono |
| **Definição de pronto e política de branch** (lacuna 4.2) | Continua aberta |
| Runbook de operação pós-go-live (plantão, escalonamento, incidente com o cliente dentro) | Antes de T. ⚠️ Este documento cobre a **entrada**; o **dia seguinte** ainda não tem dono |
| Precificação e contrato com as cláusulas de §4 (regra 5) e §6.4 | Decisão comercial, antes de T-6 |
