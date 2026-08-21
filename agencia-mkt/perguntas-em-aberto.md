# Perguntas em aberto

O que depende de decisão sua antes de virar plano de execução. Ordenadas por quanto mudam o
desenho: as primeiras alteram a arquitetura, as últimas só a sequência de trabalho.

---

## 1. ✅ RESPONDIDA (2026-08-19) — A agência é cliente do GeraCRM, ou é o GeraCRM que ganha um módulo?

> **Resposta: (a) → (b), nessa ordem.** A operação nasce como **operação própria atendendo a
> família drezz/GeraCloud** e evolui para serviço vendido a clientes de fora. Registrado em
> **AMK-011**. A leitura (c) — plataforma para outras agências — fica fora do horizonte atual,
> o que **adia o console cross-tenant (AQ-32/33) para a Fase 5**, como o roteiro já previa.

São dois negócios diferentes com o mesmo código:

| Leitura | O que significa | Implicação |
|---|---|---|
| **(a) Operação própria** | a Gera3 monta a agência e usa o GeraCRM como ferramenta interna | dogfooding puro; o módulo pode ser cru; a receita é serviço |
| **(b) Módulo do produto** | qualquer cliente do GeraCRM contrata o módulo e roda o próprio tráfego | vira produto: precisa de onboarding, autoatendimento, suporte |
| **(c) Produto para agências** | vendemos a plataforma **para outras agências** operarem seus clientes | ⚠️ o mais ambicioso: exige o console cross-tenant (AMK-005) desde cedo |

Todo o resto herda daqui — inclusive se o console da agência é Fase 5 ou Fase 0.

## 2. ✅ RESPONDIDA (2026-08-20) — Vale reabrir o registro na Meta agora?

> **Resposta: não — o deferimento é mantido (AMK-012).** A operação nasce no canal não-oficial e
> anuncia no Google (AMK-015). ⚠️ Consequência: CTWA sai do desenho, e a LP com `wa.me` (AQ-44)
> assume o papel dele. A decisão é **reversível sem retrabalho** — quando o registro sair, CTWA e
> template entram como um modo a mais (AMK-016).

A decisão de 2026-08-09 deferiu o canal oficial e seguiu no não-oficial. Mas:

- O **SDR autônomo exige o canal oficial** (AMK-004) — é o coração da Fase 2.
- A **Marketing API** passa pelo mesmo funil de verificação (Business Verification, App Review).
- O prazo é de **semanas** e não depende de nós.

Se a operação de agência entra no plano, o registro deixa de ser adiável e volta a ser o caminho
crítico. Pergunta prática: **começamos o registro agora, em paralelo à Fase 0?**

## 3. ✅ RESPONDIDA (2026-08-20) — Qual plataforma primeiro?

> **Resposta: Google (AMK-015).** Coerente com AMK-012 — sem App Review a Meta não serviria conta
> de cliente de qualquer forma. A Meta fica na conta da própria Gera3, para a Rede A.
> ⚠️ **Novo caminho crítico:** *developer token* + conta **MCC** do Google Ads. Começar já.

| | Meta | Google |
|---|---|---|
| Fit com WhatsApp | ⚠️ **Click-to-WhatsApp**: lead entra na conversa com janela de 24h aberta | manda para LP/formulário |
| Volume de lead B2B moda atacado | alto | intenção mais qualificada, volume menor |
| Complexidade da API | média | ⚠️ maior (developer token, níveis de acesso) |

Minha leitura: **Meta primeiro**, pelo encaixe com o canal que o CRM já opera. Mas se o cliente
piloto já investe mais no Google, a ordem inverte.

## 4. ✅ RESPONDIDA (2026-08-19) — Quem é o cliente piloto?

O produto inteiro depende de haver **ERP integrado** — sem receita real, o loop de dados não fecha
e a proposta vira agência comum (`visao-de-negocio.md`). Duas perguntas:

- Existe um cliente com GeraCloud integrado, verba de mídia e disposição para ser piloto?
- Ou a Fase 0 roda primeiro **na própria Gera3**, anunciando o GeraCRM?

> **Resposta: a família drezz/GeraCloud** — a própria Gera3 primeiro, depois lojas da base
> (AMK-011). ⚠️ Isso resolve o pré-requisito que eu tinha marcado como bloqueante: **ERP
> integrado existe**, e com ele a receita real. O dogfooding com dado próprio vira material de
> venda — mesmo padrão do sprint de 2026-08-09.

⚠️ **O que continua em aberto aqui:** *qual* loja da base é a primeira externa, e qual o piso de
verba mensal para valer a pena. Uma loja com R$ 800/mês de mídia não paga o fee de gestão de
ninguém — e é a faixa em que boa parte da base provavelmente está.

## 5. ✅ RESPONDIDA (2026-08-20) — O SDR autônomo fala em nome de quem?

> **Resposta: política por rede (AMK-014).** Na **Rede B**, autônomo e **identificado como
> assistente**. Na **Rede A**, copiloto — a pessoa envia. ⚠️ Isso **revisou AMK-004**: a exigência
> de canal oficial foi substituída por uma regra mais precisa — *agente autônomo no não-oficial só
> em conversa **inbound**, nunca outbound* — e o `modo_entrada` da campanha (AMK-016) aplica isso
> em código.

- Em nome **da marca do cliente** (o lead não sabe que é agência) — exige base de conhecimento por
  cliente e ⚠️ eleva o risco de marca.
- Em nome de **um atendimento identificado como assistente** — mais seguro, converte menos.
- **Copiloto apenas** (humano envia) — sem risco autônomo, mas perde o speed-to-lead 24/7, que é o
  principal argumento comercial.

⚠️ Esta decisão define quanto rigor a Fase 2 precisa. As três são defensáveis; a primeira é a que
exige o checklist completo do agente autônomo.

## 6. ✅ PARCIALMENTE RESPONDIDA (2026-08-20) — Como se cobra?

> **Resposta: não há piso — a verba é dinâmica, definida por campanha pelo contratante (AMK-013).**
> ⚠️ Isso **elimina o % do investimento** como modelo (sem piso ele não sustenta a operação) e
> obriga o produto a ser majoritariamente automatizado. Ver AMK-013 para o risco de a campanha curta
> **nunca sair da fase de aprendizado**.

⚠️ **O que continua em aberto:** o **valor** da assinatura/módulo, e se a linha de performance entra
desde o começo ou só quando a atribuição amadurecer.

`visao-de-negocio.md` propõe três linhas (assinatura + fee de gestão + performance sobre receita
exata). Precisa de decisão sobre:

- % do investimento **ou** valor fixo por conta? (⚠️ o % premia gastar mais — conflito declarado)
- A linha de performance entra desde o começo, ou só depois de a atribuição estar madura?
- Piso de investimento para aceitar cliente?

## 7. A pasta fica onde está?

`agencia-mkt/` está na **raiz** do repositório, como você pediu. O repo hoje concentra documentação
em `docs/`. Se isto for virar um contexto do produto (leitura **b** ou **c** da pergunta 1), o
lugar natural passa a ser `docs/agencia-mkt/` — ou o próprio `docs/decisoes.md` absorvendo os ADRs
AMK. É reversível e barato; só não deve ficar ambíguo por muito tempo.


---

## ⚠️ Aberto pelas decisões de 2026-08-20

0. ✅ **RESPONDIDA (2026-08-20) — o padrão "App do cliente" SERVE para a Marketing API.**
   Ver [`pesquisa-acesso-meta.md`](pesquisa-acesso-meta.md). Em resumo: a documentação da Meta diz
   que App Review só é exigido para gerenciar conta **de terceiros**; o App do próprio cliente,
   lendo a conta de anúncio **dele**, roda sem revisão, com **5.000 chamadas/hora** — folgado para
   sincronizar uma conta por dia. ✅ **Reexame encerrado em 2026-08-21: AMK-012/015 CONFIRMADAS**
   (AMK-017) — o padrão funciona, mas cobra verificação de negócio **por cliente**, e a base-alvo
   é de lojas pequenas. O caminho leve venceu o caminho preciso.
1. **Quanto custa a assinatura/módulo?** AMK-013 tirou o % do investimento da mesa e não pôs número
   no lugar. É a próxima decisão comercial.
2. **`apps/catalogo` completo ou LP mínima?** AQ-44 virou caminho crítico. Construir o catálogo da
   Onda 2 inteiro é caro; uma LP com botão `wa.me` e código de sessão resolve a Fase 1. ⚠️ A LP mínima
   é descartável — decidir se isso é aceitável ou se vale já fazer o catálogo.
3. **Customer Match do Google está elegível para as contas dos clientes?** AQ-37 depende disso, e há
   requisitos de histórico e conformidade. ⚠️ **Verificar antes de prometer** — é a promessa mais
   forte da oferta.
4. 🔴 **Como a landing page se identifica?** A LP roda no navegador do lead e não tem sessão — mas
   ⚠️ **o ADR-001 proíbe tenant vindo de parâmetro**, e aceitar `tenantId` no corpo abriria a porta
   para qualquer um poluir a base de qualquer cliente. Os webhooks resolvem isso **resolvendo** o
   tenant de um identificador (`phone_number_id` → canal → tenant, migration 0057). A LP precisa
   do equivalente: uma **chave pública por tenant**. É superfície de segurança e não deve ser
   inventada de passagem. Enquanto isso, `POST /v1/aquisicao/sessoes` é **autenticada** — serve
   para testar o fluxo inteiro e para LP com backend próprio.
5. **Qual o teto de volume do SDR por número?** AMK-014 aceita o risco do não-oficial de forma
   medida; falta o número que a rampa de aquecimento (`0037`) deve respeitar com agente ligado.
