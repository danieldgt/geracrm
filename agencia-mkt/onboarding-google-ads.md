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
2. Use um e-mail **da Gera3, no domínio da empresa** — ⚠️ e um que alguém **leia de verdade**: é
   por ele que o Google avisa sobre o token, e aviso perdido vira token suspenso.
3. Anote o **ID do gerenciador** (formato `123-456-7890`).

⚠️ **A MCC é da Gera3, não do cliente.** A conta de anúncio continua sendo do cliente (AMK-002) —
ela só é **vinculada** à nossa MCC por convite. Nada aqui transfere posse nem meio de pagamento.

---

## ② Gerar o developer token

**Tempo:** 5 minutos. Nasce em nível **Test**.

1. Dentro da MCC: **Ferramentas e configurações → Configuração → Central de API**
   (*Tools & Settings → Setup → API Center*).
2. Preencha o formulário de contato da API.
3. O token aparece na hora, com acesso **Test**.

⚠️ **Guarde como segredo.** Vai para variável de ambiente no Railway
(`GOOGLE_ADS_DEVELOPER_TOKEN`), nunca para o código nem para formulário do produto — mesma regra do
`META_APP_SECRET` (`../docs/onboarding-meta.md`).

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

- [ ] ① MCC criada, com e-mail da empresa que alguém lê · ID anotado
- [ ] ② Developer token gerado (nível Test) · guardado como segredo
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
