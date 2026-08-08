# GeraCRM — Especificação das telas de entrada e administração

> Companheiro de [`especificacao-telas.md`](./especificacao-telas.md), que cobre as **seis telas de
> operação**. Este documento cobre **como se entra no produto e como ele é administrado**.
> Mesmos padrões, mesmos cinco estados, mesma disciplina.
> A seção 9 continua a numeração das exigências técnicas da §8 do outro documento (**13 → 26**).

**Escopo:** estrutura, regiões, estados, transições e regras de negócio visíveis.
**Não** é design visual — isso vem de [`identidade-visual.md`](./identidade-visual.md), sobre esta base.

⚠️ **A tela mais importante deste documento é a §3 (onboarding do tenant).** É onde o cliente conecta
Meta e ERP. Se falhar ali, não existe operação — e nenhuma das seis telas de operação tem o que mostrar.

---

## 0. Padrões transversais destas telas

### 0.1 Os cinco estados continuam obrigatórios — inclusive em passo de assistente

Os mesmos cinco da §0.1 do documento de operação. Em tela de entrada, dois deles mudam de cara:

| Estado | Como aparece aqui |
|---|---|
| **Carregando** | Botão de submissão vira estado ocupado **sem trocar de largura** e sem desmontar o formulário. Passo de assistente que consulta terceiro mostra o que está esperando: *"Consultando a Meta…"*, não "Carregando" |
| **Vazio** | Equipe com 1 usuário, frota com 0 números, plano sem módulos extras — sempre com a ação seguinte |
| **Erro** | ⚠️ **Erro de terceiro nomeia o sistema e reproduz o motivo tipificado**: *"A Meta recusou o número: já registrado em outra conta WhatsApp Business"*. Nunca "Erro ao conectar" |
| **Sem permissão** | O item **não aparece**. Vendedora não vê "Gestão de equipe" no menu — nem desabilitado |
| **Parcial / degradado** | O caso normal do onboarding: WhatsApp conectado e ERP ainda não. O produto abre com a parte que funciona e diz, **no lugar do dado que falta**, por que ele não está lá |

### 0.2 Densidade: estas telas podem respirar

Telas de operação precisam de densidade porque são varridas 8 h/dia. **Estas não.** Login, convite,
onboarding e assinatura são de uso ocasional ou único — a prioridade é clareza do passo atual e
legibilidade do erro, não quantidade de informação por pixel.

A exceção é **Meus Telefones** (§6): é painel de monitoramento e é varrido como tela de operação.

### 0.3 Fora da sessão vs. dentro da sessão

| Grupo | Telas | Restrição |
|---|---|---|
| **Fora da sessão** | Login · recuperação · definição de senha · 2FA · aceite de convite | ⚠️ Não há `tenant_id` no token ainda — **nenhuma consulta sob RLS é possível**. Toda informação exibida vem de endpoint público e deliberadamente pobre |
| **Dentro da sessão, antes do onboarding** | Assistente de configuração | Token já tem tenant; o produto existe mas está vazio |
| **Dentro da sessão** | Seleção de escopo · equipe · telefones · perfil · plano | Menu completo, com o recorte de permissão aplicado |

### 0.4 Regras que valem em todas

1. ⚠️ **A Hosted UI do Cognito nunca é exibida** (ADR-006). Toda tela é nossa, inclusive as de erro do IdP.
2. ⚠️ **Nunca revelar se um e-mail existe.** Recuperação de senha responde igual para conta existente
   e inexistente. Vale também para o convite: "convite enviado" não confirma cadastro prévio.
3. ⚠️ **Segredo não volta para a tela.** Token da Meta, credencial de ERP e bearer de integração são
   **write-only**: depois de salvos, aparecem mascarados (`sk_live_••••7f2a`) e só podem ser
   substituídos ou revogados, nunca lidos.
4. **Toda ação destas telas é auditada** (PLT-05): convite, aceite, mudança de papel, conexão e
   desconexão de canal, troca de credencial de ERP, mudança de plano.
5. ⚠️ **`tenant_id` vem do token, nunca de campo de tela** (ADR-001/INV-02) — nem no login, onde a
   tentação de "informar a empresa" é maior.

---

## 1. Login, recuperação e 2FA

**Épico:** EP-01 · **Funcionalidade:** PLT-04 · **Onda:** 0

> **Propósito:** a única porta do produto — e a superfície que precisa funcionar mesmo quando tudo o
> mais está fora do ar.

### 1.1 Layout (web)

```
┌───────────────────────────────┬─────────────────────────────────────────┐
│                               │                                         │
│                               │   ◗ GeraCRM                             │
│                               │                                         │
│      painel de marca          │   Entrar                                │
│      quieto — sem             │   ┌───────────────────────────────────┐ │
│      ilustração, sem          │   │ e-mail                            │ │
│      gradiente                │   └───────────────────────────────────┘ │
│      (ADR-012 §9)             │   ┌───────────────────────────────────┐ │
│                               │   │ senha                          👁 │ │
│                               │   └───────────────────────────────────┘ │
│                               │   ☐ manter conectado neste dispositivo  │
│                               │   ┌───────────────────────────────────┐ │
│                               │   │             Entrar                │ │
│                               │   └───────────────────────────────────┘ │
│                               │   Esqueci minha senha                   │
│                               │   ─────────────────────────────────     │
│                               │   ⚠ E-mail ou senha inválidos.          │
│                               │     Tentativa 2 de 5.                   │
└───────────────────────────────┴─────────────────────────────────────────┘
         480px fixo                    flexível · formulário 360px
```

### 1.2 Regiões e regras

| Região | Regra de negócio |
|---|---|
| **Painel de marca** | ⚠️ Em tenant com white-label (PLT-09, Onda 4) este painel é o **único** ponto de personalização fora da sessão — e ele só pode ser resolvido **por domínio**, nunca por e-mail digitado. Enquanto white-label não existe, é a marca GeraCRM |
| **E-mail** | Identificador único do usuário. ⚠️ Não há campo "empresa": o tenant é derivado do usuário no servidor. Usuário que pertence a dois tenants escolhe **depois** do 2FA (§1.6), nunca antes da autenticação |
| **Senha** | Política do Cognito exibida **só quando relevante** (definição/troca), nunca no login |
| **Manter conectado** | Estende o refresh token. ⚠️ Não desativa 2FA — apenas evita repeti-lo no mesmo dispositivo, dentro do prazo do plano de segurança do tenant |
| **Erro de credencial** | Mensagem única, indistinguível entre e-mail inexistente e senha errada. O contador de tentativas aparece a partir da 2ª |
| **Bloqueio** | Após 5 tentativas, bloqueio temporário com **tempo restante em texto** e a única saída oferecida: recuperar senha |

### 1.3 Fluxos derivados do Cognito headless

O Cognito responde ao login com um **desafio**. Cada desafio é um estado de tela nosso — a UI nunca
mostra o nome do desafio, mas o mapa precisa ser explícito para não sobrar caso:

| Desafio do IdP | Tela | Regra |
|---|---|---|
| Autenticado | Vai para o escopo ativo (§4) ou para o onboarding (§3) | Se o tenant tem onboarding pendente e o usuário é admin, **vai para o onboarding**, não para a home |
| Senha temporária / primeira entrada | **Definir senha** (§1.5) | Vem do convite (§2). Sessão só existe depois |
| MFA por app autenticador | **2FA** (§1.4) | |
| MFA por SMS | **2FA** com reenvio e contagem | Fallback; app autenticador é o padrão recomendado |
| Cadastro de MFA obrigatório | **Configurar 2FA** — QR + chave manual + códigos de recuperação | ⚠️ Códigos de recuperação são exibidos **uma única vez**; a tela exige confirmação explícita de que foram guardados |
| Senha expirada | **Definir senha** | |
| Usuário desativado | Mensagem final, sem ação | ⚠️ Não oferece recuperar senha — recuperar não reativa, e sugerir isso vira chamado de suporte |

### 1.4 2FA

```
┌─────────────────────────────────────────────┐
│  Verificação em duas etapas                 │
│                                             │
│  Código do app autenticador                 │
│  ┌───┐┌───┐┌───┐┌───┐┌───┐┌───┐             │
│  │ 4 ││ 8 ││ 1 ││   ││   ││   │             │
│  └───┘└───┘└───┘└───┘└───┘└───┘             │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │            Verificar                  │  │
│  └───────────────────────────────────────┘  │
│  Usar um código de recuperação              │
│  Perdi o acesso ao autenticador             │
└─────────────────────────────────────────────┘
```

- Seis campos, mas **colar o código inteiro no primeiro preenche todos** — é como o usuário realmente faz.
- Verificação dispara sozinha ao completar o sexto dígito; o botão existe para teclado e leitor de tela.
- ⚠️ **"Perdi o acesso" não é autoatendimento.** Abre solicitação para o admin do tenant, que reseta o
  MFA daquele usuário na §5 — com auditoria. Reset de MFA por e-mail anula o 2FA.
- ⚠️ **Perda de MFA do único admin** é o caso que trava o cliente inteiro: escala para o staff da Gera3,
  com acesso cross-tenant auditado.

### 1.5 Recuperação e definição de senha

```
recuperar ──► "se existir conta, enviamos um link" ──► e-mail ──► definir senha ──► login
     │                                                              │
     └── link expirado ou já usado ──────────────────────────────────┘
                    "solicite um novo link"
```

| Tela | Regra |
|---|---|
| **Solicitar** | Resposta **sempre idêntica**, com o e-mail digitado ecoado. Rate limit por e-mail e por IP |
| **Definir senha** | Requisitos da política como **lista que vai sendo marcada enquanto digita**, não erro após submeter. Confirmação de senha obrigatória |
| **Link inválido** | Distinguir **expirado** (oferece novo link) de **já utilizado** (oferece login) — são ações diferentes |
| **Após definir** | ⚠️ **Todas as sessões ativas do usuário são encerradas**, e a tela diz isso. Troca de senha que não derruba sessão não é troca de senha |

### 1.6 Usuário em mais de um tenant

Raro nas Ondas 0–2, obrigatório na Onda 4 (revenda, PLT-10). Depois do 2FA:

```
┌──────────────────────────────────────┐
│  Escolha a empresa                   │
│  ┌────────────────────────────────┐  │
│  │ ⌂ VEST FÁCIL MODAS      admin  │  │
│  ├────────────────────────────────┤  │
│  │ ⌂ SATURNO ATACADO      gestor  │  │
│  └────────────────────────────────┘  │
│  ☐ lembrar minha escolha             │
└──────────────────────────────────────┘
```

⚠️ **A troca de tenant emite token novo e reinicia a aplicação inteira** — inclusive as assinaturas
SSE, que são prefixadas por tenant (ADR-007/INV-05). Não é filtro de tela; é outra sessão.

### 1.7 Cinco estados

| Estado | Comportamento |
|---|---|
| **Carregando** | Botão ocupado; campos ficam somente-leitura, **não desabilitados** (desabilitar perde foco e atrapalha gerenciador de senha) |
| **Vazio** | Não se aplica — formulário nasce preenchível |
| **Erro** | Credencial inválida (genérico) · bloqueio temporário (com tempo) · usuário desativado (final) · **IdP indisponível** (nomeia: *"Nosso provedor de autenticação não respondeu"*, com tentar novamente) |
| **Sem permissão** | Não se aplica |
| **Parcial** | ⚠️ Autenticou mas o carregamento do escopo falhou: entra com o **mínimo viável** (perfil e menu), com aviso no topo. Nunca devolver para o login por falha pós-autenticação — o usuário conclui que a senha está errada |

### 1.8 Mobile

Mesma sequência, empilhada, com dois acréscimos que existem **só** no app:

- **Biometria para reabrir sessão** — atalho para o refresh token guardado no keychain. ⚠️ Não substitui
  2FA no primeiro acesso do dispositivo, e não sobrevive à troca de senha.
- **Deep link de convite e de recuperação** — o e-mail abre o app se ele estiver instalado, e o
  navegador se não estiver. Os dois caminhos terminam no mesmo lugar.

---

## 2. Convite de usuário e aceite

**Épico:** EP-01 · **Funcionalidade:** PLT-02 · **Onda:** 0

> **Propósito:** colocar uma pessoa dentro do tenant já com escopo definido — nunca com acesso amplo
> "para ajustar depois".

### 2.1 Convidar (dentro da sessão, a partir da §5)

```
┌────────────────────────────────────────────────────────────┐
│  Convidar pessoa                                        ✕  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ e-mail                                               │  │
│  └──────────────────────────────────────────────────────┘  │
│  Nome                                                      │
│  ┌──────────────────────────────────────────────────────┐  │
│  └──────────────────────────────────────────────────────┘  │
│  ── Onde essa pessoa atua ────────────────────────────────  │
│  ┌────────────────────────────┬───────────────────────┐    │
│  │ Filial                     │ Papel                 │    │
│  ├────────────────────────────┼───────────────────────┤    │
│  │ ⌂ Matriz               ▾   │ vendedor          ▾   │  ✕ │
│  │ ⌂ Showroom Caruaru     ▾   │ supervisor        ▾   │  ✕ │
│  └────────────────────────────┴───────────────────────┘    │
│  [ + adicionar filial ]                                    │
│  ── Números que ela atende ───────────────────────────────  │
│  ☑ (Janaina) 55 81 9140-0900     ☐ (Layla) 55 81 9871-2233 │
│  ⚠ 1 de 5 números do plano ainda sem responsável            │
│  ── Carteira ─────────────────────────────────────────────  │
│  ○ sem carteira   ● receber clientes atribuídos manualmente │
│  ────────────────────────────────────────────────────────  │
│  [ Cancelar ]                        [ Enviar convite ]    │
└────────────────────────────────────────────────────────────┘
```

### 2.2 Regras

| Elemento | Regra |
|---|---|
| **Filial × Papel** | ⚠️ **O papel é do vínculo, não da pessoa** (INV-59). "Gestor na matriz e vendedor no showroom" é o caso normal, não a exceção. Tenant sem filiais mostra uma linha só, com escopo `tenant` |
| **Números** | Recorte de acesso ao inbox. Um número pode ter mais de um responsável (supervisor + vendedora) |
| **Carteira** | ⚠️ Convite **não atribui clientes**. Só declara se a pessoa é elegível a ter carteira — a atribuição é ato próprio, com histórico e autor (INV-32/33) |
| **Permissão avulsa** | ⚠️ **Não existe, e é decisão** (PLT-02, modelo de dados §1.2). Exceção vira **papel novo**, porque permissão por pessoa torna a autorização impossível de auditar. A tela não oferece checkbox de ação individual |
| **Limite do plano** | Se o convite ultrapassa o limite de usuários (PLT-06), o botão bloqueia **antes** de enviar, com o número atual, o limite e o caminho de upgrade — nunca falha depois do envio |
| **Reenvio / revogação** | Convite pendente aparece na lista da §5 com `⏳ pendente · expira em 6d` e ações `reenviar` / `revogar`. Revogar invalida o token imediatamente |

### 2.3 Aceite (fora da sessão)

```
convite por e-mail ──► aceite ──► definir senha ──► configurar 2FA ──► escopo ativo (§4)
        │                 │
        │                 └── link expirado / revogado / já aceito
        └── e-mail já tem conta em outro tenant → vincula, não recria
```

| Situação | Comportamento |
|---|---|
| **Token válido** | Mostra **quem convidou, para qual empresa e com qual papel** — a pessoa precisa reconhecer o convite antes de criar senha |
| **Expirado** | Não permite renovar sozinho: instrui a pedir novo convite ao admin, nomeando quem convidou |
| **Revogado ou já aceito** | Mensagem final distinta, com caminho para o login |
| **E-mail já é usuário de outro tenant** | ⚠️ **Vincula a identidade existente**, não cria conta nova. Não pede senha; pede confirmação e depois autenticação. Criar segundo usuário para o mesmo e-mail quebra o seletor da §1.6 |
| **Token de uso único** | Aceitar consome o token. Reabrir o link cai em "já aceito" |

### 2.4 Cinco estados

| Estado | Comportamento |
|---|---|
| **Carregando** | Validação do token com esqueleto do cartão de convite (nome da empresa, papel) |
| **Vazio** | Não se aplica |
| **Erro** | Token inválido/expirado/revogado (mensagens distintas) · falha do IdP ao criar credencial (preserva o formulário preenchido) |
| **Sem permissão** | Convidar não aparece para quem não é admin ou gestor |
| **Parcial** | Credencial criada mas o vínculo com a filial falhou → ⚠️ **entra sem escopo**, com tela dedicada "seu acesso ainda está sendo liberado" e alerta ao admin. Nunca entrar com escopo amplo por falha de gravação |

### 2.5 Mobile

**Aceite: sim** — é comum a vendedora receber o convite no celular e nunca abrir o console.
**Convidar: não** — administrar equipe pelo celular não tem caso de uso de campo, e a matriz
filial × papel × número não cabe. O app leva ao console.

---

## 3. ⚠️ Onboarding do tenant — a tela que decide se o produto existe

**Épico:** EP-01, EP-02, EP-03 · **Onda:** 0

> **Propósito:** levar a empresa de "assinou" a "recebendo mensagem e com dado do ERP dentro" — e,
> quando algum passo falhar, deixar claro **o que exatamente deixa de funcionar**.

### 3.1 Layout do assistente

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Configurar o GeraCRM                          Salvar e continuar depois → │
│                                                                            │
│  ①───────②───────③───────④───────⑤───────⑥                                │
│ Empresa  Número  Pagto    ERP   O que    Carga                             │
│    ✓       ✓      ⚠       ○    habilita  histórica                         │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│   [ conteúdo do passo atual ]                                              │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│  ‹ Voltar                                          [ Continuar ]           │
└────────────────────────────────────────────────────────────────────────────┘
```

| Regra do assistente | Detalhe |
|---|---|
| **Quem faz** | Somente papel `admin`. Outros usuários que entrarem durante o onboarding veem tela dedicada: *"Sua empresa ainda está sendo configurada"* + o que já funciona |
| **Estado no servidor** | ⚠️ O progresso é **do tenant**, não do navegador. Trocar de máquina, cair a rede ou fechar a aba retoma no mesmo passo. Estado em `localStorage` é o erro clássico aqui — o Embedded Signup abre popup e alguns navegadores isolam o contexto |
| **Passos obrigatórios** | ①②③ são obrigatórios para **enviar** mensagem. ④⑤ são obrigatórios para **pedido e RFV**. ⑥ é assíncrono e não bloqueia |
| **Sair no meio** | Permitido em qualquer passo. O produto abre com o que já existe, e o **banner de configuração pendente** fica fixo no topo até concluir, com o passo que falta nomeado |
| **Ordem** | ⚠️ ② antes de ③ é imposição da Meta, não escolha nossa: a conta de faturamento só existe depois da WABA |

### 3.2 Passo ① — Dados da empresa

| Campo | Regra |
|---|---|
| Razão social, nome fantasia, CNPJ | ⚠️ CNPJ **precisa bater com o da Business Verification da Meta** (passo ②). Divergência aqui vira rejeição lá, semanas depois. A tela avisa isso no momento do preenchimento, não depois |
| Fuso horário | Alimenta relatório diário e `metrica_numero_dia`. ⚠️ Não afeta a quota do número, que é janela móvel em UTC (INV-22) |
| **Perfil de vertical** | "Moda Atacado" pré-selecionado (ADR-004). Define nomenclatura da UI, atributos de grade, regras de pedido mínimo e faixas RFV padrão. ⚠️ **Trocar depois é caro** — a tela diz isso |
| **Filiais** | Opcional. Sem filial, tudo fica no escopo do tenant (`filial_id IS NULL`). Adicionar filial depois não obriga reclassificar nada |

**Falha:** validação local, sem terceiro envolvido. CNPJ inválido, campo obrigatório vazio.

### 3.3 Passo ② — Conectar o primeiro número (Embedded Signup)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Conectar o WhatsApp                                                       │
│                                                                            │
│  Você vai autorizar o GeraCRM na sua conta Meta. O número fica seu:        │
│  a conta WhatsApp Business é criada no seu nome, não no nosso.             │
│                                                                            │
│  Antes de começar, tenha em mãos:                                          │
│   • um número que NÃO esteja em uso no app WhatsApp ou WhatsApp Business   │
│   • acesso ao SMS ou à chamada de voz nesse número                         │
│   • documentos da empresa, se a verificação ainda não foi feita            │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │           Conectar com a Meta        (abre uma janela)               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ─── enquanto a janela está aberta ──────────────────────────────────────  │
│  ⏳ Aguardando a autorização na janela da Meta…                            │
│     [ Não abriu? Abrir em nova aba ]     [ Cancelar ]                      │
└────────────────────────────────────────────────────────────────────────────┘
```

⚠️ **A conclusão nunca é decidida pelo retorno do popup.** O popup pode ser fechado, bloqueado ou
perder o `postMessage`. A tela faz *polling* no **nosso** servidor, que consulta a Graph API e decide.
Marcar o passo como concluído por evento de janela produz tenant "configurado" que não envia nada.

**Falhas — cada uma com tratamento próprio:**

| Falha | O que a tela faz |
|---|---|
| **Popup bloqueado** | Detecta janela nula e oferece **abrir em nova aba**, com explicação de uma linha. Nunca deixa a tela em "aguardando" para sempre |
| **Usuário fecha no meio** | Mantém `em_andamento` e continua consultando por até 10 min; se não houver WABA, volta ao estado inicial com *"A autorização não foi concluída"* e o botão de retomar |
| **Número já em uso em outra conta** | Erro tipificado da Meta, traduzido: *"Este número já está registrado em outra conta WhatsApp Business"* + as duas saídas reais: migrar o número ou usar outro |
| **Número já em uso no app WhatsApp comum** | *"Este número está ativo no aplicativo WhatsApp. É preciso removê-lo de lá antes."* — com o passo a passo |
| **Não recebe SMS (número fixo/0800)** | Oferece **verificação por chamada de voz** |
| **Business Verification pendente** | ⚠️ **O número conecta e funciona, com limite de 250 contatos novos por 24 h.** Isso é um **estado**, não um erro: passo fica `✓ com ressalva`, e o limite reduzido aparece na §6 até a Meta aprovar. Esconder isso gera o chamado *"a campanha parou no meio"* |
| **App Review / Tech Provider não aprovado (nosso lado)** | ⚠️ Falha **nossa**, não do cliente. A tela assume: *"Ainda estamos concluindo a habilitação junto à Meta"*, com previsão e contato. Não culpar o cliente por processo nosso |
| **Meta fora do ar** | Nomeia a Meta, oferece tentar novamente e **permite pular para o passo ④** — ERP e carga histórica não dependem do WhatsApp |

**Ao concluir:** número entra na frota com nome amigável editável (padrão = nome do perfil na Meta),
filial e responsável. Números adicionais são registrados na §6 **sem repetir o fluxo completo**.

### 3.4 Passo ③ — ⚠️ Método de pagamento na conta Meta do cliente

**Este é o passo que o produto inteiro esquece, e é o que impede o envio.** Somos Tech Provider
(ADR-002): **o cliente paga a Meta direto**. Sem método de pagamento cadastrado na conta dele,
o número recebe mensagem mas **não envia** (INV-21).

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ⚠  Cadastrar o pagamento na sua conta Meta                                │
│                                                                            │
│  A Meta cobra você diretamente pelas mensagens iniciadas pela empresa.     │
│  Nós não intermediamos essa cobrança — e não conseguimos cadastrar         │
│  por você.                                                                 │
│                                                                            │
│  Sem isso:  ✓ você RECEBE mensagens normalmente                            │
│             ✗ você NÃO consegue ENVIAR template nem campanha               │
│             ✗ resposta dentro da janela de 24h também falha                │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │      Abrir o painel de faturamento da Meta   ⧉                       │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Status na conta 1234…7890:   ⏳ verificando…      [ Verificar de novo ]   │
│                                                                            │
│  Pular por enquanto — configuro depois                                     │
└────────────────────────────────────────────────────────────────────────────┘
```

| Regra | Detalhe |
|---|---|
| **Verificação é nossa, confirmação é da Meta** | ⚠️ O passo **só** fica verde quando a Graph API confirma o método de pagamento. Não existe "já cadastrei, pode seguir" — clicar em confirmar sem lastro produz o pior erro possível: a vendedora descobre no primeiro cliente |
| **Pular é permitido** | Mas o banner de pendência fica fixo, o número aparece na §6 com `⚠ pagamento ausente`, e o **composer da conversa bloqueia o envio com esta razão nomeada**, não com "falha ao enviar" |
| **Falha depois** | Cartão recusado, limite de gasto atingido ou pagamento removido caem no mesmo estado, com o mesmo texto — a §6 é a tela de reparo |
| **Múltiplos números** | O método é **por WABA**, não por número. Números da mesma WABA herdam o estado |

### 3.5 Passo ④ — Escolher e autenticar o ERP

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Onde estão seus clientes, produtos e vendas?                              │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐                 │
│  │ GeraCloud   │   drezz     │   Bling     │  Outro /    │                 │
│  │  nativo     │   nativo    │  em breve   │  planilha   │                 │
│  │     ●       │     ○       │     ⊘       │     ○       │                 │
│  └─────────────┴─────────────┴─────────────┴─────────────┘                 │
│  ── Credenciais do GeraCloud ────────────────────────────────────────────  │
│  URL do ambiente    ┌──────────────────────────────────────┐               │
│  Usuário de API     ┌──────────────────────────────────────┐               │
│  Chave              ┌──────────────────────────────────────┐               │
│                                                                            │
│  [ Testar conexão ]        ✓ conectado · 3 fluxos disponíveis              │
└────────────────────────────────────────────────────────────────────────────┘
```

| Regra | Detalhe |
|---|---|
| **Testar é obrigatório** | ⚠️ Não dá para avançar com credencial não testada. Salvar credencial sem provar que funciona empurra a falha para a carga histórica, horas depois, sem ninguém olhando |
| **"Outro / planilha"** | Cai na **API pública de ingestão** (INT-02): gera o bearer token ali mesmo, mostra a URL dos três fluxos (`customers`, `products`, `orders`) e link para a documentação. ⚠️ Também oferece **importação CSV** com mapeamento de colunas (INT-09), porque o cliente sem TI existe e é a maioria |
| **ERP em breve** | Aparece com cadeado e **captura interesse** — é sinal de mercado para priorizar conector (INT-10) |
| **Fonte de venda** | ⚠️ Se já houver outra conexão ingerindo vendas, a tela exige escolher **qual é a fonte** (INV-55). Duas conexões ingerindo a mesma venda dobram frequência e valor no RFV, silenciosamente |

**Falhas:**

| Falha | Tratamento |
|---|---|
| Credencial inválida | Nomeia o ERP e reproduz o motivo dele: *"O GeraCloud recusou a chave: usuário sem permissão de API"* |
| Host inacessível / timeout | Distingue de credencial errada. Oferece tentar novamente e **seguir sem ERP** |
| Versão de API não suportada | Diz a versão encontrada e a mínima exigida, e abre chamado — é problema nosso de compatibilidade |
| OAuth interrompido | Mesmo tratamento do popup do passo ② |

### 3.6 Passo ⑤ — ⚠️ O que esse ERP habilita (ADR-008)

**A tela que nenhum concorrente tem, e que evita a conclusão "o produto está errado".** Quando o
saldo tem hora, o usuário precisa saber **por quê** — senão conclui que o dado está quebrado.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  O que o GeraCloud habilita no seu GeraCRM                                 │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ ✅  FUNCIONA COMPLETO                                                 │  │
│  │   Clientes, produtos e vendas sincronizados                          │  │
│  │   Saldo por SKU ao vivo durante a montagem do pedido                 │  │
│  │   Tabela de preço do cliente ao vivo                                 │  │
│  │   Limite de crédito na tela do pedido                                │  │
│  │   Pedido enviado direto ao ERP, com número de retorno                │  │
│  │   Histórico de 24 meses — RFV pronto no primeiro dia                 │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │ ⚠  FUNCIONA COM RESSALVA                                             │  │
│  │   Venda entra por sincronização a cada 15 min (sem webhook)          │  │
│  │   → a atribuição de receita da campanha tem até 15 min de atraso     │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │ ⊘  NÃO DISPONÍVEL NESTE ERP                                          │  │
│  │   (nenhum)                                                            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Isso pode mudar: capacidades são reconsultadas a cada sincronização.      │
│  [ Comparar com outros ERPs ]                    [ Entendi, continuar ]    │
└────────────────────────────────────────────────────────────────────────────┘
```

**O mesmo passo, com um ERP limitado** — é aqui que a tela prova o próprio valor:

```
│ ⊘  NÃO DISPONÍVEL NO [ERP X]                                              │
│   Saldo ao vivo                                                            │
│   → o pedido mostra o saldo da última sincronização, com o horário,        │
│     e a validação de estoque acontece na hora de efetivar                  │
│   Envio de pedido ao ERP                                                   │
│   → o tira-pedidos vira rascunho exportável; o lançamento é manual         │
│   Limite de crédito                                                        │
│   → o bloco de crédito não aparece na tela de pedido                       │
│   Carga histórica                                                          │
│   → o RFV começa a contar a partir de hoje; a matriz leva ~90 dias         │
│     para ficar significativa                                               │
```

| Regra | Detalhe |
|---|---|
| **Capacidade → consequência de negócio** | ⚠️ Nunca mostrar `saldoSincrono: false`. Sempre a frase do que muda na tela do usuário. O texto de degradação é **conteúdo do domínio**, versionado junto da capacidade — não string espalhada no front |
| **Três faixas, nunca duas** | "Com ressalva" é a faixa que evita surpresa: o recurso existe, mas o comportamento é diferente do prometido no material comercial |
| **Reconsulta** | Capacidades são reavaliadas a cada sincronização. ⚠️ Se uma capacidade **cair** depois (ERP mudou de plano, endpoint desativado), a mudança vira notificação (PLT-07) com o mesmo texto de consequência |
| **Comparar com outros ERPs** | Honesto e comercial ao mesmo tempo: mostra o que o cliente ganharia. É o gancho para INT-10 |
| **Confirmação explícita** | O botão é `Entendi, continuar` e o aceite é **registrado**. Quando a vendedora reclamar do saldo com hora, existe a data em que o admin foi informado |

### 3.7 Passo ⑥ — Carga histórica em andamento

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Trazendo seus dados                                                       │
│                                                                            │
│  Clientes    ████████████████████████████  8.412 / 8.412        ✓ pronto   │
│  Produtos    ███████████████████░░░░░░░░░  3.190 / 4.877        ~4 min     │
│  Vendas      ████░░░░░░░░░░░░░░░░░░░░░░░░  21.004 / 158.220     ~38 min    │
│              período coberto: 08/2024 → 08/2026                            │
│                                                                            │
│  ⚠ Enquanto a carga de vendas roda, RFV, "dias sem comprar" e ciclo de     │
│    vida ficam indisponíveis para os clientes ainda não cobertos.           │
│    Eles aparecem como "ainda apurando" — nunca como "Perdido".             │
│                                                                            │
│  ✓ Você já pode: atender no inbox · cadastrar clientes · usar o catálogo   │
│                                                                            │
│  [ Ir para o GeraCRM ]        Avisamos por e-mail e no app quando terminar │
└────────────────────────────────────────────────────────────────────────────┘
```

| Regra | Detalhe |
|---|---|
| **Não bloqueia** | O onboarding **termina aqui**, com a carga rodando. Prender o cliente numa barra de progresso de 40 minutos no primeiro dia é como se perde o primeiro dia |
| ⚠️ **Cobertura declarada** | INV-56: enquanto o horizonte de vendas não cobre a janela de análise, **nenhuma projeção classifica o contato**. A ficha mostra `ainda apurando`, e o kanban de relacionamento não joga a base inteira em "Lead". Mentir com a mesma confiança do dado real é o pior desfecho possível |
| **Progresso em tempo real** | Pelo mesmo canal SSE do resto do produto, com payload mínimo (ADR-007) |
| **Falha parcial** | Retoma de onde parou, sem reprocessar o que entrou (INT-04). Linhas rejeitadas ficam em lista **exportável em CSV**, com o motivo por linha |
| **Falha total** | Nomeia o ERP, preserva o que entrou e oferece reprocessar. ⚠️ O produto continua utilizável — inbox e conversa não dependem de venda |
| **Estimativa** | Tempo restante é estimativa e é rotulado como tal. Estimativa que só aumenta destrói a confiança na tela inteira |

### 3.8 Cinco estados do assistente

| Estado | Comportamento |
|---|---|
| **Carregando** | Esqueleto do passo, com a trilha de passos já visível — o usuário precisa ver onde está antes do conteúdo chegar |
| **Vazio** | Não se aplica (o assistente é o próprio estado vazio do produto) |
| **Erro** | Sempre por passo, nunca global. ⚠️ Erro num passo **não invalida os anteriores** |
| **Sem permissão** | Não-admin vê a tela "sua empresa está sendo configurada" + o que já funciona + quem é o admin responsável |
| **Parcial** | ⚠️ **É o estado esperado, não a exceção.** WhatsApp ✓ / pagamento ⚠ / ERP ○ é uma empresa real na segunda-feira de manhã. O produto abre, o banner nomeia o que falta, e cada tela afetada explica localmente o que não tem — nunca uma tela em branco |

### 3.9 Mobile

⚠️ **O onboarding não existe no app, e isso é decisão.** Ele exige popup de OAuth da Meta,
navegação para o painel de faturamento da Meta, colar credencial de ERP e ler uma tela de
capacidades densa. Nada disso tem caso de uso de campo — quem assina está no computador.

O app, ao detectar tenant com onboarding pendente, mostra **o que falta e quem é o admin**, com
botão para abrir o console no navegador. Nunca uma tela vazia sem explicação.

---

## 4. Seleção de filial e de número

**Épico:** EP-01, EP-03 · **Onda:** 0

> **Propósito:** definir **em nome de que recorte** o usuário está olhando o produto agora.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◗ GeraCRM   [⌂ Showroom Caruaru ▾]  [☎ (Janaina) 5581914009 ▾]   👤 │
└──────────────────────────────────────────────────────────────────────┘
                       ▼ ao abrir
        ┌──────────────────────────────────────┐
        │ 🔍 filtrar                           │
        │ ─────────────────────────────────    │
        │ ⌂ Todas as minhas filiais            │
        │ ⌂ Matriz — Recife          gestor    │
        │ ⌂ Showroom Caruaru      supervisor ✓ │
        └──────────────────────────────────────┘
```

| Regra | Detalhe |
|---|---|
| ⚠️ **Não é fronteira de segurança** | O seletor **filtra o que já é permitido**; ele não concede nada. A autorização é decidida no caso de uso pelo predicado de INV-34, com o papel vindo do vínculo `(usuário, filial)` (INV-59). Seletor que amplia acesso é escalada de privilégio disfarçada de UX |
| **Um só item → não há seletor** | Vira rótulo estático. ⚠️ Não aparece desabilitado (§0.1) |
| **Papel visível no item** | O mesmo usuário é gestor numa filial e vendedor noutra; o menu e as ações **mudam** ao trocar. Mostrar o papel evita a pergunta "por que sumiu o relatório?" |
| **"Todas as minhas filiais"** | Só existe para quem tem mais de uma. Some das telas cujo dado não agrega entre filiais (metas por filial, quota por número) |
| **Escopo ativo é preferência do servidor** | ⚠️ Persistida por usuário, não no navegador — trocar de máquina mantém o recorte. E é a única forma de o app e o console concordarem |
| **Seletor de número** | Recorte do inbox. Vendedora com um número vê rótulo; supervisor vê a frota da filial ativa. Cada item mostra o **estado de saúde compacto** (§6): `● pronto` / `⚠ pagamento` / `● qualidade baixa` |

### 4.1 Transições — a parte delicada

| Evento | Comportamento |
|---|---|
| **Trocar de filial com a tela aberta** | ⚠️ Recarrega os dados **sem recarregar a aplicação**, cancela as assinaturas SSE do recorte antigo e assina o novo. Rascunho de pedido e texto digitado no composer **são preservados** — eles pertencem à conversa, não ao recorte |
| **Trocar de tenant** | Reinicia a aplicação inteira (§1.6). É outra sessão |
| **Permissão revogada durante a sessão** | Chega `permissao.alterada` pelo canal do usuário; o seletor **recalcula**. Se o recorte ativo deixou de existir, cai no primeiro permitido com aviso nomeado: *"Você não atende mais o Showroom Caruaru"*. ⚠️ Encerrar só no cliente não é revogação — o servidor já derrubou as assinaturas |
| **Número removido do usuário** | Mesmo caminho. Se o inbox aberto era daquele número, a lista esvazia com a razão explícita |

### 4.2 Cinco estados

| Estado | Comportamento |
|---|---|
| **Carregando** | Rótulo com esqueleto no lugar do nome; o cabeçalho **não muda de altura** |
| **Vazio** | ⚠️ Usuário sem nenhuma filial/número atribuído: tela dedicada *"Seu acesso ainda não foi liberado"*, com o admin nomeado. Nunca inbox vazio sem explicação |
| **Erro** | Falha ao carregar o escopo → mantém o último recorte conhecido e avisa; nunca desloga (§1.7) |
| **Sem permissão** | O seletor de número não aparece para quem só atende um |
| **Parcial** | Filiais carregaram e a saúde dos números não → lista os números sem o ponto de estado, com aviso localizado |

### 4.3 Mobile

**Mais importante no app do que no web.** Menos tela, e a vendedora troca de contexto entre showroom
e rua. O seletor vive no header, abre como folha deslizante de baixo para cima, com alvos grandes e
o estado de saúde do número visível — porque é no celular que ela descobre que o envio parou.

---

## 5. Gestão de equipe

**Épico:** EP-01 · **Funcionalidade:** PLT-02, CRM-06 · **Onda:** 0 (base), 2 (carteira)

> **Propósito:** responder, numa tela, **quem tem acesso a quê** — e permitir mudar isso com rastro.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Equipe                       [🔍 buscar]  [Filial ▾] [Papel ▾]  [+ Convidar]│
│  ┌────────────────────┬───────────────┬──────────────┬─────────┬────────┐ │
│  │ PESSOA             │ FILIAL/PAPEL  │ NÚMEROS      │ CARTEIRA│ ESTADO │ │
│  ├────────────────────┼───────────────┼──────────────┼─────────┼────────┤ │
│  │ Eduarda Lima       │ Matriz        │ (Eduarda)    │  412    │ ativa  │ │
│  │ eduarda@…          │ supervisor    │ (Layla) +2   │ clientes│  2FA ✓ │ │
│  ├────────────────────┼───────────────┼──────────────┼─────────┼────────┤ │
│  │ Janaína Souza      │ Caruaru       │ (Janaina)    │  289    │ ativa  │ │
│  │ janaina@…          │ vendedor      │              │ clientes│  2FA ✓ │ │
│  ├────────────────────┼───────────────┼──────────────┼─────────┼────────┤ │
│  │ Marília Alves      │ Matriz        │ —            │   —     │⏳ convite│ │
│  │ marilia@…          │ vendedor      │              │         │ 6d     │ │
│  ├────────────────────┼───────────────┼──────────────┼─────────┼────────┤ │
│  │ Kleber Nunes       │ Matriz        │ (Kleber)     │   0     │ inativo│ │
│  │ kleber@…           │ vendedor      │              │         │        │ │
│  └────────────────────┴───────────────┴──────────────┴─────────┴────────┘ │
│  4 de 10 usuários do plano Crescimento                    [ ver plano ⧉ ] │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Regiões e regras

| Região | Regra de negócio |
|---|---|
| **Filial/Papel** | ⚠️ Uma pessoa pode ter **N vínculos**; a célula mostra o primeiro e `+N`. Editar abre a mesma matriz do convite (§2.1). O papel **nunca** é escalar no usuário (INV-59) |
| **Números** | Recorte de inbox. ⚠️ Um número **sem nenhum responsável** é alerta: a conversa entra e ninguém vê. A tela destaca isso no rodapé, com link para a §6 |
| **Carteira** | Contagem de clientes com esse dono vigente (INV-32). Clicável: abre a lista com filtro |
| **Estado** | `ativa` · `⏳ convite pendente (expira em Xd)` · `inativo` · `🔒 bloqueada por tentativas`. O selo `2FA ✓/✗` é coluna de conformidade, não enfeite |
| **Contador do plano** | ⚠️ Sempre visível, mesmo longe do limite. É onde o upsell é honesto: o cliente vê antes de esbarrar |

### 5.2 Ações e suas regras duras

| Ação | Regra |
|---|---|
| **Editar vínculos** | Aplica na hora; o usuário afetado recebe `permissao.alterada` e a tela dele recalcula (§4.1) |
| **Desativar** | ⚠️ **Nunca apaga.** Encerra sessões, derruba assinaturas SSE e **abre a linha "sem dono" na carteira** (INV-58) para que não exista lacuna no histórico. A tela obriga a decidir: transferir a carteira para quem, ou deixar órfã |
| **Transferir carteira** | Em lote, com autor e horário gravados. Aparece no histórico da ficha de cada cliente (§3.2 do doc de operação) |
| **Resetar 2FA** | Só admin, com confirmação e auditoria. ⚠️ É a rota legítima do "perdi o autenticador" (§1.4) |
| **Remover do último número** | Confirmação nomeando o efeito: *"Janaína deixará de ver 187 conversas"* |
| **Excluir** | ⚠️ **Não existe.** Usuário é referenciado por mensagem enviada, pedido, tarefa e auditoria. Excluir apagaria a história da operação. Só desativação — e a tela diz por quê quando perguntam |

### 5.3 Por que não há tela de permissões por ação

⚠️ **Decisão registrada, não omissão** (PLT-02, modelo §1.2). Permissão individual fora do papel não
existe: exceção vira **papel novo**. Uma tela com 60 checkboxes por pessoa produz um estado que
ninguém consegue auditar nem reproduzir em teste — e a pergunta "por que fulano viu isso?" fica sem
resposta. Os três recortes que o produto realmente tem — **filial, número e carteira** — são
*atribuições* com dono e histórico, não caixas de seleção.

### 5.4 Cinco estados

| Estado | Comportamento |
|---|---|
| **Carregando** | 6 linhas de esqueleto com a forma da tabela |
| **Vazio** | Só o admin fundador: *"Você é a única pessoa aqui. Convide sua equipe para dividir os atendimentos."* + `Convidar` |
| **Erro** | Falha de gravação preserva o formulário e nomeia o campo recusado |
| **Sem permissão** | O item de menu **não aparece** para vendedor e atendente |
| **Parcial** | Lista carregou e a contagem de carteira falhou (vem do analítico) → coluna com `—` e aviso localizado, tabela funcionando |

### 5.5 Mobile

**Não existe no app.** A matriz filial × papel × número não cabe em 390px e não tem caso de uso de
campo. O que existe é **consulta**: dentro da ficha do cliente, ver quem é o dono e falar com ele.

---

## 6. Meus Telefones — frota e saúde do número

**Épico:** EP-03 · **Funcionalidade:** CAN-02…06 · **Onda:** 0 (frota), 1 (saúde)

> **Propósito:** dizer, de relance, **quais números podem enviar agora** — e, quando não podem, o
> que fazer.

⚠️ **Cada número é o ativo mais caro e mais frágil do cliente.** Perder um derruba a operação de uma
vendedora inteira. Esta tela é densa de propósito: é varrida, não lida.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Meus Telefones                    [Filial ▾]  [Só com problema ☐] [+ Novo]│
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ ● (Janaina)  55 81 91400-9000        Caruaru · Janaína Souza         │  │
│  │   LIVE ✓   verificada ✓   pagamento ✓   qualidade ALTA   tier 10K    │  │
│  │   1.204 contatos · 87 conversas ativas · 412/10.000 nas últimas 24h  │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │ ⚠ (Layla)    55 81 98712-2330        Matriz · Layla Menezes          │  │
│  │   LIVE ✓   verificada ✗   pagamento ✓   qualidade ALTA   tier 250    │  │
│  │   ⚠ Empresa não verificada na Meta — limite de 250 contatos/24h      │  │
│  │      [ Ver como verificar ⧉ ]                                        │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │ ● (Pietá)    55 81 99930-8490        Matriz · sem responsável        │  │
│  │   ⚠ Nenhum usuário atende este número — conversas ficam sem dono     │  │
│  │      [ Atribuir responsável ]                                        │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │ ✗ (Kleber)   55 81 99861-7049        Matriz · Kleber Nunes           │  │
│  │   LIVE ✓   verificada ✓   pagamento ✗   qualidade MÉDIA  tier 1K     │  │
│  │   ✗ NÃO ENVIA — método de pagamento ausente na conta Meta            │  │
│  │      [ Abrir faturamento da Meta ⧉ ]   [ Verificar de novo ]         │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │ ✗ (Sandy)    55 81 98120-4477        Caruaru · Sandy Rocha           │  │
│  │   qualidade BAIXA ▼ caiu há 2 dias   tier 1K   disparo PAUSADO       │  │
│  │   ✗ Disparo pausado automaticamente para proteger o número           │  │
│  │      [ Entender o que aconteceu ]      [ Retomar disparo ]           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  5 de 5 números do plano                              [ ver plano ⧉ ]      │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 A regra central: "conectado" ≠ "pode enviar"

⚠️ **Cinco condições independentes**, e a tela mostra as cinco separadas porque o reparo de cada uma
é diferente. Um único selo verde/vermelho esconde exatamente a informação que resolve o problema.

| Condição | Origem | Se falhar |
|---|---|---|
| **Canal conectado** | Nosso estado + token válido | Reconectar (§6.3) |
| **Conta LIVE na Meta** | Graph API | Sair do modo sandbox; instruções |
| **Empresa verificada** | Business Verification | Funciona, com tier travado em 250 contatos/24h |
| **Pagamento OK** | Graph API (billing) | ⚠️ **Recebe, mas não envia** (INV-21) |
| **Qualidade acima do limiar** | Webhook de qualidade | Disparo pausado automaticamente (CAN-06/INV-24) |

### 6.2 Regiões

| Região | Regra |
|---|---|
| **Ponto de estado** | ⚠️ Ordem fixa dos selos em **todos** os cartões — LIVE · verificada · pagamento · qualidade · tier. Posição que muda entre cartões quebra a leitura periférica |
| **Consumo do tier** | `412/10.000 nas últimas 24h` — ⚠️ **janela móvel de contatos distintos**, exatamente como a Meta conta (INV-22). Nunca "mensagens hoje": 3 templates para o mesmo contato consomem 1 slot lá e 3 num contador ingênuo, e a campanha legítima trava |
| **Qualidade com tendência** | `ALTA` / `MÉDIA` / `BAIXA` com seta e **desde quando**. Queda é sinal de ação, não de aviso |
| **Sem responsável** | Alerta próprio: conversa entra e ninguém vê. É a falha mais silenciosa da frota |
| **Contadores** | Contatos, conversas ativas (CAN-05) — por número, nunca somados na frota |
| **Filtro "só com problema"** | ⚠️ É o filtro que o gestor usa de verdade. Frota de 20 números não é lida inteira |

### 6.3 Configuração e reconexão de um número

Ao abrir um número: nome amigável · filial · responsáveis · horário de atendimento · mensagem de
ausência · assinatura da atendente · **reconectar** · **remover da frota**.

| Situação | Comportamento |
|---|---|
| **Token expirado / permissão revogada na Meta** | Cartão vai para `✗ desconectado` com a razão. `Reconectar` reabre o Embedded Signup **só na etapa necessária** — nunca o fluxo inteiro (ADR-002) |
| **Reconexão bem-sucedida** | ⚠️ Histórico e conversas **permanecem**: a identidade é `phone_number_id` + `waba_id`, não a sessão |
| **Adicionar número** | Sender adicional na WABA existente: fluxo curto. ⚠️ Bloqueado antes de começar se estourar o limite do plano, com o número atual, o limite e o upgrade |
| **Remover da frota** | Confirmação com o efeito nomeado: *"187 conversas deixarão de receber mensagem"*. ⚠️ Histórico não é apagado — a conversa fica somente-leitura, com a razão visível no composer |
| **Mudança vinda da Meta** | Qualidade, tier e pagamento chegam por webhook e **atualizam o cartão em tempo real**, sem recarregar (mesmo canal SSE) |

### 6.4 Cinco estados

| Estado | Comportamento |
|---|---|
| **Carregando** | Cartões-esqueleto com a forma real, inclusive a fileira de selos |
| **Vazio** | Onboarding incompleto: *"Nenhum número conectado. Sem isso, não há atendimento."* + `Conectar o primeiro número` (leva ao passo ② da §3) |
| **Erro** | Falha ao ler a Meta → ⚠️ **exibe o último estado conhecido com o horário da apuração** e um aviso, nunca campos vazios. Saúde desatualizada rotulada é útil; saúde em branco é inútil |
| **Sem permissão** | Vendedora vê **apenas os próprios números**, em versão reduzida (§6.5). Supervisor vê a frota da filial ativa |
| **Parcial** | ⚠️ **O caso mais comum.** Cadastro local carregou e a Meta demorou: cartões aparecem com nome, filial e responsável, e os selos em esqueleto — a tela é útil antes de a Meta responder |

### 6.5 Mobile

**Existe, reduzido — e é aqui que ele importa.** A vendedora está na rua quando o envio para.
Mostra **só os números dela**, com: os cinco selos, o consumo do tier, e a ação de reparo quando
existir. A frota inteira, a configuração e a reconexão ficam no console.

Ordem dos blocos no cartão, por prioridade de campo: **o que me impede de enviar agora** →
qualidade/tier → contadores → configuração.

---

## 7. Perfil e preferências

**Épico:** EP-01, EP-07 · **Funcionalidade:** PLT-04, PLT-07, MOB-07 · **Onda:** 0 (base), 1 (notificações)

> **Propósito:** o que é meu — identidade, segurança, notificações e dispositivos.

```
┌──────────────────────┬─────────────────────────────────────────────────┐
│  ◉ Eduarda Lima      │  PERFIL                                         │
│    supervisor        │  Nome · e-mail (troca exige confirmação)        │
│  ──────────────────  │  Foto · assinatura usada nas mensagens          │
│  ▸ Perfil            │  ──────────────────────────────────────────     │
│  ▸ Segurança         │  SEGURANÇA                                      │
│  ▸ Notificações      │  Trocar senha                                   │
│  ▸ Dispositivos      │  2FA: app autenticador ✓   [ reconfigurar ]     │
│  ▸ Aparência         │  Códigos de recuperação: 3 de 10 restantes      │
│  ──────────────────  │  ──────────────────────────────────────────     │
│  Meu acesso          │  NOTIFICAÇÕES            app   push   e-mail    │
│  ⌂ Matriz  supervisor│  Mensagem nova            ☑     ☑      ☐        │
│  ⌂ Caruaru vendedor  │  Conversa atribuída a mim ☑     ☑      ☐        │
│  ☎ 3 números         │  Tarefa vencendo          ☑     ☑      ☑        │
│  👥 412 clientes     │  Meta em risco            ☑     ☐      ☑        │
│                      │  Som no navegador         ☑                     │
│                      │  ──────────────────────────────────────────     │
│                      │  DISPOSITIVOS                                   │
│                      │  Chrome · Recife · agora            (este)      │
│                      │  iPhone 14 · app · há 2h        [ encerrar ]    │
│                      │  Chrome · Caruaru · há 8 dias   [ encerrar ]    │
│                      │  [ Encerrar todas as outras sessões ]           │
└──────────────────────┴─────────────────────────────────────────────────┘
```

| Região | Regra |
|---|---|
| **Troca de e-mail** | ⚠️ E-mail é o identificador de login. Exige confirmação **no endereço novo** e só efetiva depois; até lá, o antigo continua valendo |
| **"Meu acesso"** | ⚠️ Somente leitura, e é a resposta à pergunta *"por que não consigo ver X?"*. Mudar é ato do admin (§5). Reduz chamado de suporte mais do que qualquer texto de ajuda |
| **Códigos de recuperação** | Contador visível; ao chegar a 2, avisa proativamente |
| **Notificações** | Três canais independentes por evento. ⚠️ **Não substituem regra de negócio**: desligar "mensagem nova" não desliga o contador de não lidas nem o tempo real da tela |
| **Som** | Preferência por dispositivo, não por conta — e a única que **fica no navegador**, porque é sobre este alto-falante |
| **Dispositivos** | Sessão e token de push (MOB-07). Encerrar é decisão do **servidor**: derruba o refresh token e as assinaturas SSE |
| **Aparência** | Claro / escuro / seguir o sistema (ADR-012). Preferência do usuário, no servidor — a vendedora usa o mesmo tema no console e no app |

### 7.1 Cinco estados

| Estado | Comportamento |
|---|---|
| **Carregando** | Esqueleto por bloco; blocos independentes carregam independentes |
| **Vazio** | "Dispositivos" com um só item não mostra "encerrar todas as outras" |
| **Erro** | Falha em um bloco não derruba os outros. Falha na troca de senha nomeia a política violada |
| **Sem permissão** | Não se aplica — o perfil é sempre do próprio usuário. ⚠️ **Não existe tela de perfil de outra pessoa**: isso é a §5 |
| **Parcial** | "Meu acesso" falhou e o resto carregou → bloco com aviso local, sem bloquear a troca de senha |

### 7.2 Mobile

**Existe, e é onde as notificações realmente importam** — o app é o dono do push (MOB-07). Ordem:
**Notificações** → Segurança (biometria, 2FA) → Perfil → Aparência → Meu acesso → Sair.

Notificações vêm primeiro porque é o único bloco que o usuário abre por vontade própria; e a tela
precisa detectar **permissão de push negada no sistema operacional** e explicar isso — senão o
usuário liga o toggle e nada acontece.

---

## 8. Planos, limites e assinatura

**Épico:** EP-26 · **Funcionalidade:** PLT-06 · **Onda:** 2

> **Propósito:** mostrar o que está contratado, quanto do limite já foi usado e o que existe do outro
> lado da porta — sem esconder e sem mentir.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Plano e limites                                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  CRESCIMENTO           R$ ••••/mês · renova em 12/09/2026            │  │
│  │  ┌────────────────────┬────────────────────┬──────────────────────┐  │  │
│  │  │ Números            │ Usuários           │ Disparos no mês      │  │  │
│  │  │ ████████████ 5/5   │ ██████░░░░ 4/10    │ ███████░░ 6.7K/10K   │  │  │
│  │  │ ⚠ limite atingido  │                    │ zera em 8 dias       │  │  │
│  │  └────────────────────┴────────────────────┴──────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  MÓDULOS                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ ✓ Atendimento e inbox          ✓ CRM e funis     ✓ Pedido assistido  │  │
│  │ ✓ RFV e segmentação            ✓ Catálogo        ✓ Metas e ranking   │  │
│  │ 🔒 Campanhas em massa      não contratado    [ ver o que faz ]        │  │
│  │ 🔒 Agente autônomo de IA   não contratado    [ ver o que faz ]        │  │
│  │ 🔒 Capacitação e playbook  não contratado    [ ver o que faz ]        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  COBRANÇA                                                                  │
│  Forma de pagamento ····4412        Faturas: 08/2026 · 07/2026 · 06/2026   │
│  ⚠ O que a Meta cobra por mensagem NÃO passa por aqui — é cobrado          │
│    direto na sua conta Meta.  [ ver custo estimado do mês ⧉ ]              │
│                                                                            │
│  [ Comparar planos ]                                    [ Falar com vendas ]│
└────────────────────────────────────────────────────────────────────────────┘
```

### 8.1 O cadeado de upsell — a única exceção da regra dos cinco estados

⚠️ **"Sem permissão" esconde; "não contratado" mostra com cadeado.** São coisas diferentes e a mesma
resposta da API precisa distinguir as duas — senão o front adivinha, e adivinha errado:

| Situação | Comportamento na UI |
|---|---|
| Módulo **não contratado** | Aparece com 🔒 no menu e na tela. Clicar abre **o que o módulo faz**, com valor concreto para *este* tenant (*"Você tem 412 clientes sem comprar há mais de 90 dias"*), e o caminho comercial |
| Módulo contratado, **usuário sem papel** | ⚠️ **Não aparece.** Vendedora não precisa saber que existe um painel de revenda |
| Módulo contratado, **capacidade do ERP ausente** | Aparece, funcionando degradado, com o texto da §3.6. ⚠️ **Não é cadeado** — é limitação técnica declarada, e confundir as duas faz o cliente comprar um upgrade que não resolve |

### 8.2 Limites — comportamento ao encostar

| Limite | Ao atingir |
|---|---|
| **Números** | ⚠️ Bloqueia **antes** de iniciar o Embedded Signup (§6.3), com número atual, limite e upgrade. Nunca deixar conectar para falhar ao salvar |
| **Usuários** | Bloqueia o convite no formulário (§2.2) |
| **Disparos/mês** | ⚠️ Avisa em **80%** e em **95%**, com projeção de quando acaba. Ao atingir, campanha **agendada** não é cancelada: entra em `bloqueada por limite`, com a data de reset e o upgrade. Cancelar campanha agendada por limite destrói a confiança no agendamento |
| **Armazenamento de mídia** | Avisa; nunca apaga automaticamente |

⚠️ **O limite é avaliado no servidor, sempre.** A tela recebe `{ usado, limite }` e **não calcula** —
front que calcula limite é front que libera o que não devia quando o cálculo diverge.

### 8.3 A distinção que evita o pior chamado do produto

⚠️ **Assinatura do GeraCRM ≠ custo das mensagens na Meta** (ADR-002). São duas cobranças, dois
credores, dois motivos de bloqueio. A tela declara isso em texto fixo, e o link leva ao **custo
estimado do mês** que nós medimos (CMP-12/BI-11) — nós não cobramos, mas medimos, e é isso que dá ao
cliente a visão que a Meta não dá.

### 8.4 Cinco estados

| Estado | Comportamento |
|---|---|
| **Carregando** | Esqueleto das barras de uso com a forma real |
| **Vazio** | Sem faturas ainda (primeiro mês): explica quando a primeira será emitida |
| **Erro** | Falha ao ler o uso → ⚠️ mostra os limites contratados **sem** as barras, com aviso. Nunca mostrar `0/10.000`, que parece consumo zerado |
| **Sem permissão** | Item de menu invisível para quem não é admin. ⚠️ Mas o **cadeado dos módulos continua visível para todos** — é o ponto do PLT-06 |
| **Parcial** | Plano e módulos carregaram, cobrança (gateway) falhou → bloco de cobrança com aviso e o resto funcionando |

### 8.5 Mobile

**Só o cadeado.** Tocar num módulo não contratado abre a explicação do valor e leva ao console.
⚠️ Não há contratação nem cobrança dentro do app — regra de loja e, principalmente, decisão de
compra é do dono, no computador, não da vendedora no showroom.

---

## 9. O que estas telas exigem da stack

Continuação direta da §8 de `especificacao-telas.md`. Cada exigência nasce de uma tela concreta.

| # | Exigência | Origem | Por quê |
|---|---|---|---|
| **13** | **Estado de onboarding no servidor, retomável e por passo** | §3.1 | Popup da Meta, troca de máquina e queda de rede. ⚠️ `localStorage` não sobrevive ao contexto isolado do popup e não sobrevive à troca de dispositivo |
| **14** | **Conclusão do Embedded Signup confirmada pelo servidor via Graph API** | §3.3 | O retorno do popup **não é fonte de verdade**. Tenant marcado como configurado por evento de janela é tenant que não envia |
| **15** | **Estado de pagamento da Meta consultável e observado** | §3.4, §6.1 | INV-21: sem pagamento o número não envia. Precisa de leitura ao vivo **e** de webhook, e o composer precisa consultar esse estado para bloquear com a razão certa |
| **16** | **Saúde do número lida da Meta, cacheada com horário e atualizada por webhook** | §6 | Tier, qualidade, LIVE, verificação. ⚠️ A tela precisa exibir **último estado conhecido + horário** quando a Meta não responde — nunca campo vazio |
| **17** | **Capacidades por conexão de ERP, com texto de consequência versionado** | §3.6 | ADR-008. A frase *"o saldo terá horário"* é conteúdo do domínio, não string de front — ela precisa ser a mesma na tela de onboarding, na de pedido e na notificação de mudança de capacidade |
| **18** | **Cobertura de dados declarada por fluxo e por período** | §3.7 | INV-56. Enquanto a carga histórica roda, RFV e ciclo de vida **se recusam** a classificar. Exige `desde/ate/estado` por fluxo, propagado a toda projeção |
| **19** | **Progresso de carga histórica em tempo real, retomável, com erros por linha** | §3.7 | Mesmo canal SSE, payload mínimo. Reprocessamento idempotente (INT-04) e rejeitados exportáveis |
| **20** | **"O que eu posso" calculado no servidor** | §4, §5, §8.1 | A UI precisa de uma resposta que distinga **sem permissão** (esconder) de **não contratado** (cadeado) de **capacidade ausente** (degradar). Três causas, três comportamentos, uma origem |
| **21** | **Papel por vínculo `(usuário, filial)`, nunca escalar** | §2.1, §5.1 | INV-59. "Gestor na matriz, vendedor no showroom" é o caso normal. Menu, seletor e predicado de acesso derivam disso |
| **22** | **Revogação de permissão propagada na sessão** | §4.1 | Evento `permissao.alterada` no canal do usuário, assinaturas encerradas **no servidor**, seletor e menu recalculados. Encerrar só no cliente não é revogação |
| **23** | **Escopo ativo (filial/número) persistido por usuário no servidor** | §4 | É preferência compartilhada entre console e app — e ⚠️ **nunca** fronteira de segurança: filtra o que já é permitido |
| **24** | **Limites do plano avaliados e contados no servidor** | §8.2 | A tela recebe `{usado, limite}` e não calcula. Bloqueio acontece **antes** de iniciar a ação (Embedded Signup, convite), não depois |
| **25** | **Segredos write-only, cifrados por tenant, mascarados na leitura** | §0.4, §3.5 | INV-41. Token da Meta, credencial de ERP e bearer de integração nunca voltam para a tela nem para o log |
| **26** | **Convite como token de uso único, expirável e revogável, sem enumeração** | §1.5, §2.3 | Resposta idêntica para conta existente e inexistente; aceite consome o token; e-mail já existente **vincula** identidade em vez de duplicar (quebraria o seletor de tenant) |

---

## 10. O que ainda não está especificado

Segue os padrões da §0 deste documento e da §0 do documento de operação:

- **Onda 0–1:** Tokens de integração (INT-03) · Painel de sincronização com reprocessamento (INT-08) ·
  Importação CSV com mapeamento de colunas (INT-09) · Log de auditoria navegável (PLT-05)
- **Onda 1–2:** Central de notificações in-app (PLT-07) · Changelog / Novidades (PLT-08) ·
  Suporte embutido e base de conhecimento (PLT-11) · Configuração de funis, etapas e motivos de perda
  (CRM-05/09) · Configuração do perfil de vertical (ADR-004)
- **Onda 4:** White-label — logo, cores, domínio, remetente (PLT-09) · Painel de revenda com
  subcontas e hierarquia de tenant (PLT-10) · Onboarding guiado de vendedor novo (GES-09)

⚠️ **Duas dependências externas atravessam este documento e não dependem de código:** Business
Verification e enrollment no Tech Provider Program (ADR-002). Enquanto não estiverem aprovados, o
passo ② da §3 falha por motivo **nosso** — e a tela precisa dizer isso desde o primeiro dia, não
culpar o cliente por processo que é nosso.
