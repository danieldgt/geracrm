# Onboarding no Google Ads — developer token e MCC

> Executável, no formato de `../docs/manual-passos-externos.md`: o que fazer, onde clicar, o que
> copiar e o que dá errado.
>
> É o **único item externo bloqueante** da Fase 0 (AMK-017). Nada aqui depende de código nosso, e
> tudo aqui bloqueia o adaptador (AQ-04) — e com ele o worker e a tela.

## ⚠️ A boa notícia: talvez não bloqueie a Fase 0

Existem **quatro** níveis de acesso, e o segundo costuma ser concedido **automaticamente**:

| Nível | Contas | Operações/dia | Aprovação |
|---|---|---|---|
| **Test** | ⚠️ só contas de teste | 15.000 | imediata, ao criar o token |
| **Explorer** | teste **e produção** | **2.880** (produção) | ⚠️ **automática em alguns casos** |
| **Basic** | teste e produção | 15.000 | ~5 dias úteis |
| **Standard** | teste e produção | ilimitado na maioria | ~10 dias úteis, exige Basic antes |

### ⚠️ O painel NÃO usa os nomes da documentação

Executando isto de verdade em **2026-08-21**, a Central de API mostrou nível **"Acesso às Análises"**
— que **não existe** na documentação, nem em inglês nem em português (que lista *conta de teste ·
exploração · básico · padrão*). O que a doc chama de **"Relatórios"** é um **uso permitido**
(somente leitura via `GoogleAdsService.Search`), não um nível.

**Não tente mapear o nome lendo documentação — não bate.** O que resolve é **uma chamada real**:
o token existe, e um `GoogleAdsService.Search` contra uma conta de produção responde em segundos o
que nenhuma página responde. Isto é o passo ③ + a primeira chamada.

⚠️ A boa notícia é que a Fase 0 é exatamente leitura de estrutura e métrica — a operação que
qualquer tier de leitura permite. O nome importa menos do que parece.

⚠️ **`Explorer` já toca conta de produção.** As restrições dele — sem criar conta, sem gestão de
usuário, sem planejador de palavras-chave, sem *audience insights*, sem faturamento — **não atingem
nada da Fase 0**, que é leitura de estrutura e métrica.

**Consequência prática:** dá para começar a Fase 0 assim que o token existir, sem esperar aprovação
nenhuma. O Basic vira necessário quando o volume passar de 2.880 operações/dia.

⚠️ **A conferir na prática:** quanto uma sincronização diária nossa consome desse orçamento. Ler
estrutura + métricas de uma conta é da ordem de dezenas de chamadas, então 2.880/dia comportaria
dezenas de contas — mas isso precisa ser **medido**, não presumido, porque consulta de relatório
também conta.

---

## ① Criar a conta de gerenciador (MCC)

**Por que primeiro:** ⚠️ o **API Center só existe em conta de gerenciador**. Conta individual não
tem onde gerar o token — é o erro nº 1 de quem tenta.

**Tempo:** 10 minutos. Gratuito.

1. Acesse **[ads.google.com/home/tools/manager-accounts](https://ads.google.com/home/tools/manager-accounts)**
   e crie a conta de gerenciador.
2. Qualquer conta Google serve — **Gmail pessoal funciona**. ⚠️ **Correção (2026-08-21):** uma
   versão anterior deste guia dizia "e-mail no domínio da empresa" como se fosse exigência do
   Google. **Não é** — essa regra é da **Meta**, na verificação de negócio
   (`../docs/manual-passos-externos.md`), e foi transferida para cá sem evidência.
3. Anote o **ID do gerenciador** (formato `123-456-7890`).

### ⚠️ O risco real do e-mail pessoal é CONTINUIDADE, não aprovação

A MCC e o developer token ficam presos à conta que os criou. Se ela for perdida, suspensa ou sair
da empresa, **a MCC vai junto — e com ela a integração de todos os clientes**.

**Mitigação, e é barata:** assim que existir um e-mail da Gera3, adicione-o como **Administrador**
em *Ferramentas e configurações → Configuração → Acesso e segurança → +*. Um minuto, e o risco
acaba. Não bloqueia seguir agora.

Os cinco níveis de acesso, para escolher certo na hora:

| Nível | Para quem |
|---|---|
| **Administrador** | ⚠️ o segundo dono — pode tudo, inclusive gerenciar usuários |
| **Padrão** | quem opera campanha no dia a dia |
| **Somente leitura** | quem só acompanha |
| **Faturamento** | quem cuida de pagamento |
| **E-mail apenas** | só recebe notificação |

⚠️ **O e-mail de contato da API (passo ②) é outra coisa** e precisa ser um que alguém **leia de
verdade**: é por ele que o Google avisa sobre o token, e aviso perdido vira token suspenso.

⚠️ **A MCC é da Gera3, não do cliente.** A conta de anúncio continua sendo do cliente (AMK-002) —
ela só é **vinculada** à nossa MCC por convite. Nada aqui transfere posse nem meio de pagamento.

---

## ② Gerar o developer token

**Tempo:** 5 minutos. Nasce em nível **Test**.

⚠️ **Vá pela URL direta, não pelo menu:** **[ads.google.com/aw/apicenter](https://ads.google.com/aw/apicenter)**.
O menu do Google Ads muda de lugar entre versões do painel; a URL não.

1. Abra a URL **com a conta de gerenciador selecionada** no seletor do topo.
2. Preencha o formulário de contato da API.
3. O token aparece — **22 caracteres alfanuméricos** — com o **nível de acesso** e o **status** ao
   lado (ex.: *Explorer Access / Approved*, ou *Test Account Access / Pending Approval*).

### Como saber se você está mesmo numa MCC

⚠️ Se a página disser *"A Central de API está disponível apenas para contas de gerenciador"*, o
seletor está numa conta de anúncio comum.

**O sinal visual mais rápido:** conta de gerenciador tem **"Contas"** na barra lateral esquerda.
Conta de anúncio comum não tem. Se "Contas" está lá, você está no lugar certo.

⚠️ Também não funciona a partir de **conta de teste** (manager ou anunciante de teste).

⚠️ **Guarde como segredo.** Vai para variável de ambiente no Railway
(`GOOGLE_ADS_DEVELOPER_TOKEN`), nunca para o código, nem para formulário do produto, nem para
mensagem de chat — mesma regra do `META_APP_SECRET` (`../docs/onboarding-meta.md`).

⚠️ **O ID do gerenciador NÃO é segredo** (é identificador de conta, como o CNPJ de uma empresa) —
mas o **token é**. Confundir os dois nas duas direções custa caro: tratar o token como público vaza
acesso; tratar o ID como secreto trava conversa à toa.

---

## ③ Projeto no Google Cloud e OAuth

O token diz *qual aplicação*; o OAuth diz *em nome de quem*. São coisas separadas e as duas são
necessárias.

1. **[console.cloud.google.com](https://console.cloud.google.com)** → criar projeto (ex.: `geracrm-ads`).
2. **APIs e serviços → Biblioteca** → ativar **Google Ads API**.
3. **Credenciais** → criar **ID do cliente OAuth 2.0**.
4. Gerar o **refresh token** do usuário que administra a MCC.
5. Anote o **número do projeto** — ⚠️ ele entra no formulário do passo ④ e ajuda na aprovação.

---

## ④ Solicitar o Basic (quando 2.880/dia apertar)

**Tempo:** ~5 dias úteis — ⚠️ mas ver ⑤, que pode reduzir para horas.

Na Central de API, use o seletor de nível de acesso e preencha o formulário.

### ⚠️ O que faz reprovar

O motivo nº 1 é **descrição vaga**. O revisor precisa entender **o modelo de negócio** e **como a
API é usada** — em várias frases, não em uma linha.

| Faça | Não faça |
|---|---|
| Explicar que somos um **CRM que também gere tráfego** para o cliente | "Integração com Google Ads" |
| Dizer que **lemos** estrutura e métricas para relatório e atribuição de receita | Descrever genericamente "automação" |
| Dizer que a conta é **do cliente** e nós operamos como parceiro vinculado à MCC | Omitir de quem é a conta |
| Informar o **número do projeto** do Cloud | Deixar em branco |
| Ter **contas ativas reais** vinculadas à MCC | Aplicar com a MCC vazia |
| Concluir a **verificação de anunciante** onde possível | Ignorar |

⚠️ **Aplique com a MCC já tendo conta ativa vinculada.** Aplicação com gerenciador vazio é padrão
de reprovação.

---

## ⑤ Verificação de marca — o atalho

Fontes secundárias relatam que, desde **julho de 2026**, concluir a **verificação de marca** no
projeto do Google Cloud vinculado derruba a análise de uma solicitação pendente **de dias para
horas**. A documentação oficial confirma que a verificação de marca **acelera** a aprovação, sem
prometer prazo.

⚠️ E o contexto explica por que isso importa: o Google reconheceu em **fevereiro de 2026** uma
**fila acumulada** nas solicitações de token, com prazos esticados. Contar com "5 dias úteis" sem
fazer a verificação é otimismo.

---

## ⑥ Vincular a conta do cliente

1. Na MCC: **Contas → +** → convidar pelo ID da conta de anúncio do cliente.
2. O cliente **aceita o convite** dentro da conta dele.
3. A partir daí, o token + OAuth da MCC alcançam a conta.

⚠️ **Nunca peça a senha do cliente** e nunca opere de dentro do usuário pessoal dele — é a mesma
regra do `guardrails.md`, e vale para Google como vale para Meta.

---

## ⚠️ O que NÃO é atalho

A documentação do Google tem uma página sobre **níveis de acesso gerenciados pelo Cloud**, que
promete "sem developer token". ⚠️ **Não é um caminho alternativo:** ela **exige um token já
aprovado** como pré-requisito e apenas dispensa enviá-lo em cada chamada. É programa piloto, com
inscrição limitada, e não serve para começar.

---

## Checklist

- [x] ① MCC criada — conta **drezz**, ID **123-276-0756**, `danieldgt@gmail.com` (2026-08-21)
- [ ] ① Adicionar e-mail da Gera3 como **Administrador** — risco de continuidade
- [x] ② Developer token gerado (2026-08-21) · nível **"Acesso às Análises"** ⚠️ nome que não
      consta na documentação — a ser confirmado por chamada real
- [ ] ⚠️ **Redefinir o token** — ele apareceu numa captura de tela durante o onboarding
- [ ] ③ Projeto no Cloud + Google Ads API ativada + OAuth + refresh token · número do projeto anotado
- [ ] **Conferir o nível concedido** — se já veio `Explorer`, ⚠️ **a Fase 0 está destravada**
- [ ] ⑥ Primeira conta de cliente vinculada (ou a da própria Gera3, para o dogfooding)
- [ ] Medir quantas operações a sincronização diária consome
- [ ] ④ Solicitar Basic **quando** o volume exigir — com descrição detalhada
- [ ] ⑤ Verificação de marca no projeto do Cloud, para acelerar

---

## Fontes

- [Access levels and permissible use](https://developers.google.com/google-ads/api/docs/access-levels) — oficial, tabela de níveis e limites
- [Developer token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token) — oficial
- [Cloud-managed access levels](https://developers.google.com/google-ads/api/docs/concepts/no-developer-token) — oficial, o piloto que **não** é atalho
- [Quick start](https://developers.google.com/google-ads/api/docs/get-started/make-first-call) — oficial, OAuth e primeira chamada
- [Google faces developer token application backlog](https://ppc.land/google-faces-developer-token-application-backlog-as-new-api-tier-debuts/) — ⚠️ secundária, sobre a fila e o piloto de julho/2026
- [High demand slows Google Ads API access approvals](https://ppcnewsfeed.com/ppc-news/2026-02/high-demand-slows-google-ads-api-access-approvals/) — ⚠️ secundária, fev/2026
