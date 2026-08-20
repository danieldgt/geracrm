# Decisões (ADRs) — agencia-mkt

Registro corrido das decisões estruturais desta operação. Formato: contexto → decisão →
consequência, igual a `../docs/decisoes.md`. Prefixo **AMK** para não colidir com os ADRs do
GeraCRM.

⚠️ **Todas as decisões abaixo estão como PROPOSTA (2026-08-19).** Nenhuma foi validada com o dono
do produto. As que dependem dele estão listadas em [`perguntas-em-aberto.md`](perguntas-em-aberto.md).

---

## AMK-001 — A operação de mídia é um contexto novo dentro do GeraCRM, não um produto separado
**Contexto**: a cadeia anúncio → lead → conversa → pedido → venda só fecha se o dado de mídia e o
dado de venda morarem no mesmo banco. Produto separado obrigaria a sincronizar `contato` e `venda`
entre dois sistemas — a integração mais cara e mais frágil possível, e justamente sobre o dado que
sustenta a proposta de valor.
**Decisão**: um contexto novo `aquisicao` em `apps/api/src/contexts/`, com tabelas prefixadas
`midia_*`, sob o mesmo `tenant_id` e a mesma RLS. Nenhuma alteração de forma no núcleo.
**Consequência**: a agência é *upsell* do CRM, não venda nova — e cliente sem GeraCRM não é alvo da
oferta completa. Herda multi-tenant, auditoria, tempo real e opt-out sem escrever uma linha.

## AMK-002 — A conta de anúncio e o meio de pagamento são do cliente
**Contexto**: agência que coloca a mídia no próprio cartão vira financiadora — risco de crédito e
inadimplência sobre dinheiro que não é dela, com margem que não remunera esse risco.
**Decisão**: a conta de anúncio pertence ao cliente; nós operamos como **parceiro no Business
Manager**, com permissão mínima. O cliente paga a plataforma direto.
**Consequência**: mesma lógica do ADR-002 do CRM (o cliente paga a Meta direto pelas mensagens).
Cadastrar o meio de pagamento vira **passo obrigatório do onboarding** e campo do painel de saúde
da conta — se faltar, a veiculação para, e a falha precisa dizer isso com essas palavras.
⚠️ Nunca pedir senha do cliente nem operar de dentro do usuário pessoal dele.

## AMK-003 — Só API oficial das plataformas de anúncio
**Decisão**: Meta Marketing API, Google Ads API, TikTok Business API. Sem automação de interface do
Gerenciador de Anúncios, em nenhuma hipótese, nem "só para ler".
**Consequência**: algumas capacidades só existirão quando a API expuser — o produto **degrada em
vez de quebrar**, e a degradação é visível na interface (mesmo princípio do ADR-008). Em troca,
elimina o risco de derrubar Business Manager de cliente. É o análogo, no lado da mídia, do ADR-003.

## AMK-004 — O SDR autônomo só opera no canal oficial da Meta
**Contexto**: o ADR-021 mantém o canal dual e deixa o risco de banimento do não-oficial visível.
Um agente autônomo respondendo lead de anúncio multiplica volume de conversa junto com a verba —
é o perfil de tráfego que derruba número não-oficial.
**Decisão**: o SDR autônomo exige canal oficial. No não-oficial, o agente atua só como **copiloto**
(sugere, o humano envia).
**Consequência**: ⚠️ **reabre a dependência do registro na Meta**, hoje deferido pela decisão de
2026-08-09. Se a Fase 2 do roteiro está no plano, o registro começa na Fase 0. Sem canal oficial,
a operação entrega speed-to-lead assistido, não autônomo — e isso precisa ser dito ao cliente.

## AMK-005 — A visão cross-tenant da agência não fura a RLS
**Contexto**: a agência opera N tenants e precisa de painel agregado, mas o ADR-001 é categórico —
`tenant_id` vem do token, nunca de parâmetro.
**Decisão**: a agregação roda em **processo dono** (worker), com `tenant_id` explícito em cada
query, materializando um resumo por tenant — exatamente o padrão já usado pelo `automacao-motor`,
pelo despachante de webhooks e pelo integrador. A API **nunca** ganha um caminho "listar tudo".
**Consequência**: o console da agência lê o resumo materializado, não a base dos clientes. Custa
uma tabela de agregação e preserva o invariante que sustenta o white-label (PLT-09/10).

## AMK-006 — Vocabulário separado: `Veiculacao`/`midia_*` ≠ `Campanha`
**Contexto**: `campanha` no GeraCRM já significa **disparo de WhatsApp para a base**. Campanha de
mídia paga tem outra unidade e outro custo.
**Decisão**: prefixo `midia_` no schema; `Veiculacao` como termo de domínio; `Conversao` distinta
de `venda`; `Origem` distinta de `origem_carga`.
**Consequência**: evita duas verdades nascendo dentro do mesmo nome — o mesmo cuidado que levou
`contato.qtd_vendas` a **não** se chamar `qtd_pedidos`.

## AMK-007 — O fluxo é determinístico; o modelo entra só no julgamento
**Decisão**: orquestração em código (fila, job, transação, retry). LLM apenas onde há julgamento
genuíno: escrever copy, classificar intenção, ler curva, avaliar lead. ⚠️ **Nenhuma regra de
negócio no prompt** — teto de verba, pedido mínimo, preço e prazo são validados em código.
**Consequência**: custo previsível, comportamento auditável, cada passo testável isoladamente.
Extensão direta da skill `geracrm-ia` ("a IA é adaptador, nunca domínio").

## AMK-008 — Dry-run por padrão; escrita se conquista
**Decisão**: todo agente com poder de escrita nasce em **dry-run** — grava o que faria, não faz.
A escrita é liberada por ação, por conta, depois que o histórico de propostas bate com o que um
humano faria.
**Consequência**: exige que o plano de mudança seja um artefato persistido e comparável, não um
texto solto. É também o material de treino e de auditoria da operação.

## AMK-009 — ROAS exato × estimado, sempre separados e com janela declarada
**Decisão**: herda integralmente a régua de `0036`/`campanha-analise.ts`. Atribuição **exata** é
vínculo direto (lead com `click_id` do anúncio → pedido efetivado); **estimada** é correlação por
janela. ⚠️ Nunca somadas, janela sempre declarada ao lado do número.
**Consequência**: nosso número será **menor** que o do painel da plataforma — e é isso que o torna
defensável. Vender performance sobre a camada exata só é honesto por causa desta decisão.

## AMK-010 — Otimização de lance fica com a plataforma
**Contexto**: bidding automático da Meta e do Google tem sinal e volume que nenhum agente nosso
alcança; intervenção frequente reseta a *learning phase* e piora o resultado.
**Decisão**: não construir agente de lance. Nosso escopo é estrutura, criativo, público e
**qualidade do sinal devolvido**.
**Consequência**: contraria a expectativa comum de "IA que otimiza campanha" — precisa ser
explicado comercialmente. Em troca, concentra o esforço onde há vantagem real: o loop de dados,
que a plataforma **não** tem porque não enxerga o ERP do cliente.

## AMK-011 — Nasce na família drezz; vira serviço para terceiros depois
**Decisão do dono do produto (2026-08-19).**
**Contexto**: o produto inteiro depende de **receita real vinda do ERP** — sem ela, o loop de dados
não fecha e a oferta vira agência comum. Esse pré-requisito, que seria o maior obstáculo comercial,
já está satisfeito na base da casa: o drezz é PDV de lojas de moda sobre o **GeraCloud (~150 lojas
ativas)**, e `../docs/aproveitamento-drezz.md` já registra que *"cliente do drezz é loja de moda com
PDV — exatamente o perfil de quem precisa de CRM com WhatsApp"*.
**Decisão**: a operação nasce atendendo a **família drezz/GeraCloud** — primeiro a própria Gera3,
depois lojas dessa base — e só então é vendida como serviço a clientes de fora.
**Consequência**:
- ⚠️ O piloto tem **ERP integrado, mesmo domínio (moda) e mesma vertical** — o conector GeraCloud e
  o estudo de dados já existem. Nenhuma variável extra entre nós e a primeira medição de ROAS real.
- A base de partida é **cativa e conhecida**: a agência é *upsell*, não prospecção fria. O custo de
  aquisição do primeiro cliente é praticamente zero.
- O **perfil de vertical** (ADR-004) nasce completo em "Moda / varejo com PDV" — a mesma abstração
  que o CRM já validou.
- ⚠️ **Risco de generalização prematura**: o que funcionar na família drezz pode não transferir para
  outra vertical. Vender para fora só depois de a atribuição estar madura **e** de ter separado o
  que é regra do domínio do que é peculiaridade de moda.
- ⚠️ **Risco de concentração**: se GeraCloud e drezz forem a única fonte de receita real, uma
  mudança neles derruba a agência junto. Mitigar com o padrão de capacidade declarada (ADR-008) —
  o segundo ERP deve entrar antes de a operação depender do faturamento dela.

---

> As quatro decisões abaixo foram tomadas com o dono do produto em **2026-08-20**, fechando as
> perguntas 2, 3, 5 e 6 de [`perguntas-em-aberto.md`](perguntas-em-aberto.md).

## AMK-012 — O deferimento da Meta é mantido; a operação nasce no não-oficial
**Decisão do dono do produto (2026-08-20).**
**Contexto**: reabrir o registro na Meta (Business Verification → Tech Provider → App Review) foi
avaliado e **recusado por ora**, confirmando a decisão de 2026-08-09.
**Decisão**: seguimos sem registro na Meta. Canal de WhatsApp continua no **não-oficial**
(PlugZapi/Z-API), e a plataforma de anúncio para clientes é o **Google** (AMK-015).
**Consequência**:
- ⚠️ **A Marketing API da Meta fica indisponível para conta de cliente.** Ler a conta de anúncio de
  terceiro exige App Review + Business Verification. Só a conta da **própria Gera3** é acessível
  (app em modo dev, token de admin) — o que permite a Rede A, não o serviço.
- ⚠️ **Click-to-WhatsApp sai do desenho.** É formato de anúncio Meta. A entrada passa a ser
  **landing page → link `wa.me`** (AQ-44) — que preserva a propriedade essencial do CTWA: **o lead
  escreve primeiro**.
- ⚠️ **`apps/catalogo` (ou uma LP mínima) vira caminho crítico.** Estava marcado "aguardando Onda 2";
  sem CTWA, o anúncio precisa de um destino. Deixa de ser dívida e vira pré-requisito da Fase 1.
- No não-oficial **não há janela de 24h nem template** (ADR-021: "não-oficial = texto livre") — o que
  remove a trava técnica que o CTWA resolveria, e deixa **só** o risco de banimento, tratado em
  AMK-014.
- **Reversível**: o dia em que o registro sair, CTWA e template entram como um adaptador atrás da
  porta de canal que já existe. Nada do que for construído agora é descartado.

## AMK-013 — A verba é dinâmica, por campanha — não há piso
**Decisão do dono do produto (2026-08-20).**
**Decisão**: não existe piso de investimento. Cada contratante define **quanto quer investir por
campanha**, e a operação trabalha com o que ele colocar.
**Consequência**:
- ⚠️ **A cobrança não pode ser % do investimento.** Sem piso, o percentual não sustenta a operação —
  e ainda premia gastar mais, o conflito já declarado em `visao-de-negocio.md`. A receita vem de
  **assinatura/módulo fixo** e, quando a atribuição amadurecer, de **performance sobre receita
  exata**.
- ⚠️ **Serviço gerenciado com gestor dedicado não fecha a conta em verba pequena.** O modelo tem de
  ser majoritariamente **automatizado** — o que reforça AMK-001 (módulo do produto) contra "agência
  com gestores". O humano entra em estratégia e relação, não em operação.
- **"Por campanha" implica operação SAZONAL, não always-on.** Coleção nova, liquidação, data
  comemorativa — o que é o ritmo real do varejo de moda. Os guardrails passam a ser **teto por
  campanha**, além do teto diário por conta.
- ⚠️ **O risco técnico da verba pequena e curta: a campanha nunca sai da fase de aprendizado.** As
  plataformas precisam de dezenas de conversões por semana por conjunto para estabilizar. Uma
  campanha de 7 dias com verba baixa entrega pior **por real investido**, e isso não é falha de
  gestão — é física do leilão.
  **Mitigação**: manter uma campanha **sempre no ar** acumulando aprendizado, e usar as sazonais
  como reforço, em vez de ligar e desligar do zero a cada vez. ⚠️ A expectativa do cliente sobre
  campanha curta precisa ser declarada **antes**, não explicada depois.

## AMK-014 — SDR autônomo na Rede B, copiloto na Rede A — revisa AMK-004
**Decisão do dono do produto (2026-08-20).**
**Decisão**: política de identidade **por rede**. Na **Rede B** (B2C da loja, volume alto) o agente
é **autônomo e identificado como assistente** — diz o que é, resolve o que sabe, passa para pessoa.
Na **Rede A** (B2B, cada lead é caro) o agente é **copiloto**: sugere, a pessoa envia.
**Consequência**:
- ⚠️ **Revisa AMK-004**, que exigia canal oficial para qualquer agente autônomo. Com a Meta deferida
  (AMK-012), a exigência tornaria a Rede B inviável. A regra passa a ser mais precisa e o risco é
  gerenciado, não ignorado:
  > **Agente autônomo no canal não-oficial é permitido APENAS em conversa iniciada pelo lead
  > (inbound).** Nunca em outbound — nem primeira abordagem, nem disparo, nem reativação.
- **Por que a distinção protege**: o padrão que derruba número não-oficial é **mensagem fria em
  volume**. Responder quem escreveu primeiro é o uso normal do canal. Daí o link `wa.me` (AQ-44)
  ser estrutural, e não um detalhe de implementação — ⚠️ **é ele que mantém toda a operação em
  inbound**.
- **Continua valendo**: frota de números, aquecimento em rampa (`0037`), saúde da frota (EP-03) e o
  risco **visível na interface** (ADR-021). O agente respeita o teto diário por número.
- ⚠️ **O risco não é zero.** O canal segue não-oficial e pode ser banido por sinal de comportamento
  (taxa de bloqueio, denúncia). A diferença é que agora ele é **medido e limitado**, não evitado.
- Na Rede A o copiloto dispensa o checklist do agente autônomo — o volume é baixo e o roteamento já
  manda lead com dono e cliente de alto valor para humano.

## AMK-015 — Google primeiro; Meta só na nossa própria conta
**Decisão do dono do produto (2026-08-20).**
**Decisão**: o **Google Ads** é a plataforma da Fase 0 para clientes. A Meta fica restrita à conta
da própria Gera3 (Rede A, dogfooding), enquanto AMK-012 estiver de pé.
**Consequência**:
- **Coerente com AMK-012**: sem App Review, a Meta não serviria cliente de qualquer forma.
- **Intenção mais qualificada** e menor dependência de criativo — o que combina com AMK-013, já que
  verba pequena rende mais em busca do que em descoberta.
- ⚠️ **Exige credenciamento próprio**: *developer token* do Google Ads (acesso básico → padrão) e
  conta **MCC** para operar contas de cliente. Menor que o funil da Meta, mas **não é zero — começar
  já**, pela mesma lógica que eu havia proposto para a Meta.
- ⚠️ **Exige destino**: busca manda para página, não para conversa. Confirma `apps/catalogo`/LP como
  caminho crítico (AQ-44).
- ⚠️ **Customer Match tem requisitos de elegibilidade** (histórico e conformidade da conta) — a
  sincronização de públicos (AQ-37) pode não estar disponível de saída. **Verificar antes de
  prometer** ao cliente.
- **Na Rede A o volume de busca é pequeno** — o universo de "lojista de moda procurando sistema" é
  de milhares. Poucos leads, muito qualificados: exatamente o perfil que a decisão de copiloto
  (AMK-014) atende bem.

## AMK-016 — O modo de entrada é declarado na campanha, e carrega a consequência junto
**Decisão do dono do produto (2026-08-20).**
**Contexto**: AMK-014 restringe o agente autônomo a conversa inbound no canal não-oficial. Fixar o
produto só em `wa.me` resolveria o risco, mas eliminaria casos legítimos — captação para lista,
lead que prefere formulário, campanha em que o WhatsApp não é o canal de resposta.
**Decisão**: cada campanha declara seu **`modo_entrada`**:

| `modo_entrada` | Quem inicia | Agente autônomo |
|---|---|---|
| `inbound_wa` — LP com botão `wa.me` | o lead | ✅ permitido |
| `outbound_formulario` — LP ou Lead Ads com formulário | ⚠️ nós | ❌ fila humana obrigatória |

**Consequência**:
- ⚠️ **A restrição de AMK-014 deixa de depender de disciplina do operador.** Ninguém precisa lembrar
  de desligar o agente numa campanha de formulário: a campanha declara o modo, e o **roteamento
  obedece em código** (regra 2 de `roteamento-do-lead.md`). Configuração errada vira comportamento
  seguro, não incidente.
- **É o padrão da casa aplicado a mídia**: capacidade declarada (ADR-008), degradação **visível na
  interface** (ADR-008/021), falha de negócio nomeada em vez de silenciosa (PED-08).
- ⚠️ **A tela de criação de campanha precisa mostrar o preço do modo** — em `outbound_formulario`:
  sem agente 24/7, risco de banimento maior no não-oficial, e speed-to-lead dependente de gente.
  Escolher o modo arriscado é decisão legítima; escolher **sem saber** não é.
- A atribuição difere por modo: `inbound_wa` depende do **código na mensagem pronta** (frágil,
  editável, com taxa de perda medida); `outbound_formulario` tem **atribuição limpa** pelo próprio
  formulário. ⚠️ É a única vantagem real do outbound, e vale registrá-la em vez de fingir que ele só
  tem defeito.
- No dia em que a Meta entrar (AMK-012 é reversível), `outbound_formulario` ganha **template HSM** e
  o CTWA entra como um terceiro modo — sem mudar o desenho, só somando uma linha à tabela.

---

## ⚠️ REVISÃO DE AMK-012 (2026-08-20, mesma data) — a premissa estava desatualizada

**O que eu não sabia ao escrever AMK-012.** Os dois commits mais recentes do repositório
(`ec4bbd1` e `44cdb06`, ambos de 2026-08-19) implementaram o **canal WhatsApp Oficial da Meta**:
webhook com verificação de assinatura, ingestão de mensagem entrante, envio pela Graph API,
migration `0057` (lookup por `phone_number_id`) e o provedor `meta_oficial` ativo no catálogo, com
formulário de credencial (WABA ID · Phone Number ID · token).

A análise que sustentou AMK-012 veio de `../docs/onde-estamos.md`, que ainda registrava o canal
oficial como "⏸️ deferido". **O código andou no mesmo dia.**

### O que muda de fato

| Item | Estado real |
|---|---|
| Código do canal oficial (webhook · ingestão · envio) | ✅ **feito** |
| Onboarding manual com o **App do próprio cliente** | ✅ documentado (`../docs/onboarding-meta.md`) |
| Verificação de negócio na Meta | ⏳ **é do CLIENTE**, não nossa — semanas, e o guia já existe |
| Embedded Signup (evitar mandar o cliente ao Business Manager) | ⬜ não feito |
| Nosso Tech Provider / App Review | ⬜ não feito — necessário para **escalar**, não para o primeiro cliente |
| Submissão de template à Meta · mídia por media id · Instagram | ⬜ não feito |

⚠️ **A consequência principal:** o canal oficial **está disponível hoje** para um cliente disposto a
fazer o próprio cadastro na Meta. Não depende de App Review nosso — o modelo atual é *o cliente traz
o próprio App*, e o `META_APP_SECRET` vem dele.

### O que isso reabre

1. **AMK-014 fica menos restritiva do que parece.** A regra "agente autônomo só inbound" nasceu do
   risco de banimento do canal **não-oficial**. Num tenant no canal **oficial**, o que vale é a
   janela de 24h + template — não o risco de ban. ⚠️ A regra deve ser **por canal do tenant**, não
   global: oficial → janela/template; não-oficial → só inbound.
2. **AMK-015 (Google primeiro) merece reexame.** O argumento era "sem App Review, a Marketing API
   não lê conta de cliente". Mas se o **mesmo padrão do WhatsApp** valer para anúncios — o cliente
   cria o App, nos dá um token de System User, e lemos a conta de anúncio **dele** — a Meta volta a
   ser viável sem App Review nosso. ⚠️ **Isso precisa ser verificado na prática**, não assumido: é a
   pergunta técnica nº 1 desta camada.
3. **CTWA pode voltar ao desenho.** Se (2) se confirmar, o Click-to-WhatsApp volta a ser possível —
   e com ele o `ctwa_clid`, que é bem mais robusto que o nosso código na mensagem pronta (AQ-45).

### O que NÃO muda

- **AMK-013** (verba dinâmica por campanha) — independe de plataforma.
- **AMK-016** (`modo_entrada` configurável) — continua certo, e fica **mais** útil: com o canal
  oficial, `outbound_formulario` ganha template HSM e deixa de ser o modo arriscado.
- **AQ-44** (LP com `wa.me`) — continua valendo. Serve a Google, serve a tenant no não-oficial, e é
  mais barata que depender de CTWA. ⚠️ Deixa de ser *a única* entrada e vira *uma* das entradas.

### Encaminhamento

AMK-012 e AMK-015 ficam **marcadas para reexame** com o dono do produto. Nada é revertido
unilateralmente: as decisões foram tomadas e valem até serem revistas. O trabalho técnico que segue
(schema `midia_*`) é **agnóstico de plataforma** por desenho, então avança sem depender deste
desfecho.
