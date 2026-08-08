# Arquitetura visual do GeraCRM

> Diagramas para entender o sistema sem ler os dez documentos. Cada um responde **uma** pergunta.
> Detalhes em `stack-arquitetura.md`, `decisoes.md` e `modelo-de-dados.md`.
> Sintaxe Mermaid — renderiza no GitHub.

---

## 1. Contexto — quem fala com o quê

**Pergunta:** onde o GeraCRM se encaixa no mundo do cliente?

```mermaid
flowchart TB
    subgraph pessoas["👥 Quem usa"]
        V["Vendedora<br/>atende, monta pedido"]
        G["Gestor<br/>metas, campanhas, BI"]
        S["Staff Gera3<br/>suporte auditado"]
    end

    subgraph crm["🟠 GeraCRM"]
        SYS["Atendimento · CRM · Campanhas<br/>Pedido assistido · IA · BI"]
    end

    subgraph externos["🌐 Sistemas externos"]
        META["Meta<br/>WhatsApp Cloud API<br/>Instagram Direct"]
        ERP["ERPs<br/>GeraCloud · drezz<br/>Bling · Tiny · ..."]
        COG["Amazon Cognito<br/>identidade"]
        IA["Provedor de IA<br/>copiloto e agente"]
        PAG["Pagamento<br/>link Pix/cartão"]
    end

    L["🛍️ Lojista<br/>cliente final"]

    V --> SYS
    G --> SYS
    S -.auditado.-> SYS

    SYS <-->|"mensagens<br/>templates · webhooks"| META
    META <-->|"WhatsApp<br/>Instagram"| L
    SYS <-->|"clientes · produtos · pedidos<br/>saldo · preço · crédito"| ERP
    SYS -->|"JWT · JWKS"| COG
    SYS -->|"sugestão · transcrição<br/>qualificação"| IA
    SYS -->|"link de cobrança"| PAG
    L -->|"abre catálogo"| SYS

    style crm fill:#FFF3E9,stroke:#FF6732,stroke-width:3px
    style SYS fill:#FF6732,color:#fff
```

⚠️ **O lojista nunca acessa o GeraCRM diretamente** — exceto pelo catálogo público. Ele conversa
pelo WhatsApp dele. Isso é o que torna o produto invisível para o cliente final e obrigatório para
a vendedora.

---

## 2. Containers — o que roda onde

**Pergunta:** quais são as peças que se implantam separadamente?

```mermaid
flowchart TB
    subgraph clientes["Superfícies"]
        direction LR
        CON["🖥️ Console<br/><b>Angular 21+</b><br/>operação, 8h/dia"]
        APP["📱 App vendedor<br/><b>Expo / RN</b><br/>campo, offline"]
        CAT["🛍️ Catálogo público<br/><b>SSR</b><br/>link do WhatsApp"]
    end

    subgraph backend["Backend — TypeScript"]
        direction TB
        API["⚙️ API<br/><b>Fastify</b><br/>monolito modular"]
        GW["📨 Gateway webhooks<br/>valida · grava · publica<br/><i>responde em ms</i>"]
        WK["⚡ Workers<br/>disparo · sincronização<br/>IA · mídia"]
    end

    subgraph dados["Dados"]
        direction LR
        PG[("🐘 PostgreSQL<br/>RLS multi-tenant<br/>+ réplica de leitura")]
        S3[("📦 Object storage<br/>áudio · imagem · PDF")]
    end

    META["Meta"]
    ERP["ERPs"]

    CON -->|"HTTP + SSE"| API
    APP -->|"HTTP + SSE + sync"| API
    CAT --> API

    API <--> PG
    API <--> S3
    GW --> PG
    WK <--> PG
    WK <--> S3

    META -.webhook.-> GW
    WK -->|"envio"| META
    API <-->|"leitura síncrona<br/>escrita de pedido"| ERP
    WK <-->|"ingestão em lote<br/>carga histórica"| ERP

    style CON fill:#DD0031,color:#fff
    style APP fill:#000,color:#fff
    style API fill:#FF6732,color:#fff
    style PG fill:#336791,color:#fff
```

**Por que só estes três processos de backend:** cada um tem perfil de carga genuinamente diferente.
O gateway responde em milissegundos porque a Meta reenvia o que demora. Os workers rodam por horas.
A API atende requisições curtas que o usuário sente. Tudo o mais é **módulo dentro da API**.

---

## 3. Contextos de domínio

**Pergunta:** como o código é dividido por capacidade de negócio?

```mermaid
flowchart TB
    subgraph nucleo["Núcleo transversal"]
        ID["identidade<br/><i>tenant · usuário · permissão</i>"]
        EV["eventos<br/><i>outbox · fan-out</i>"]
    end

    subgraph operacao["Operação"]
        AT["atendimento<br/><i>conversa · fila · janela 24h</i>"]
        CT["contato<br/><i>cadastro unificado · opt-out</i>"]
        PE["pedido<br/><i>rascunho · validação · efetivação</i>"]
    end

    subgraph comercial["Comercial"]
        CR["crm<br/><i>funil · carteira · tarefa</i>"]
        CA["campanha<br/><i>template · disparo · ROI</i>"]
        CL["catalogo<br/><i>produto · grade · link</i>"]
    end

    subgraph apoio["Apoio"]
        IN["integracao<br/><i>conectores de ERP</i>"]
        AN["analitico<br/><i>RFV · atribuição · BI</i>"]
    end

    AT -.->|evento| CR
    AT -.->|evento| CT
    PE -.->|evento| AN
    CA -.->|evento| AN
    IN -.->|evento| CT
    IN -.->|evento| PE
    IN -.->|evento| CL
    CR -.->|evento| CA

    style nucleo fill:#F5F5F5
    style IN fill:#FFF3E9,stroke:#FF6732,stroke-width:2px
```

**Regras que o diagrama expressa:**

- ⚠️ Um contexto **nunca importa código interno de outro**. As setas são **eventos de domínio
  pós-commit**, nunca chamada direta.
- ⚠️ **Só `integracao` conhece formato de ERP.** Se `pedido` souber que existe um campo com o nome
  que o GeraCloud usa, a abstração multi-ERP já vazou.
- Referência entre contextos é **por id**, nunca por join de objeto.

---

## 4. 🔴 Fluxo crítico — mensagem chega e aparece na tela

**Pergunta:** como uma mensagem do WhatsApp vira um evento na aba certa, sem vazar para outra empresa?

```mermaid
sequenceDiagram
    autonumber
    participant L as 🛍️ Lojista
    participant M as Meta
    participant GW as Gateway
    participant DB as Postgres
    participant W as Worker
    participant API as API
    participant AB as 🖥️ Aba da vendedora

    L->>M: manda mensagem
    M->>GW: webhook
    GW->>GW: valida assinatura
    GW->>DB: grava mensagem + OUTBOX<br/>(mesma transação)
    GW-->>M: 200 (em milissegundos)
    Note over GW,M: ⚠️ demorar = Meta reenvia<br/>handler é idempotente

    DB->>W: outbox pendente
    W->>DB: NOTIFY canal<br/>tenant:T:numero:N
    Note over W,DB: payload mínimo<br/>{tipo, conversaId, versao}<br/>⚠️ sem conteúdo

    DB-->>API: LISTEN
    API-->>AB: SSE (só assinantes autorizados)
    AB->>API: GET conversa/mensagens
    API->>DB: consulta sob RLS
    DB-->>API: conteúdo do tenant correto
    API-->>AB: renderiza
```

**As três defesas contra vazamento, visíveis no fluxo:**

| # | Defesa | Onde |
|---|---|---|
| 1 | Canal prefixado por tenant, montado por função única | passo 6 |
| 2 | Autorização revalidada a cada subscrição | antes do passo 8 |
| 3 | **Payload sem conteúdo** — o conteúdo vem por API sob RLS | passos 7 e 9–11 |

⚠️ Se o fan-out errar o alvo, o intruso recebe um ID que **não consegue resolver**. É a diferença
entre um bug e um incidente.

---

## 5. Fluxo — pedido assistido

**Pergunta:** como a vendedora fecha o pedido sem sair da conversa?

```mermaid
sequenceDiagram
    autonumber
    participant V as 👤 Vendedora
    participant CON as Console
    participant API as API
    participant ERP as ERP

    V->>CON: abre painel de pedido
    CON->>API: contexto do cliente
    API->>ERP: tabela de preço + crédito
    Note over API,ERP: ⚠️ leitura SÍNCRONA<br/>timeout 2s
    ERP-->>API: dados
    API-->>CON: cabeçalho do pedido

    loop montagem
        V->>CON: busca produto, escolhe grade
        CON->>API: saldo do SKU
        API->>ERP: consulta ao vivo
        ERP-->>API: saldo
        CON->>CON: valida mínimo, grade, mix
        CON->>API: salva rascunho
    end

    V->>CON: enviar
    CON->>API: efetivar
    API->>ERP: cria pedido (idempotente)

    alt sucesso
        ERP-->>API: número do pedido
        API->>API: vincula conversa + campanha + tarefa
        API-->>CON: efetivado
        CON-->>V: oferece resumo para enviar ao cliente
    else falha
        ERP-->>API: erro tipificado
        API-->>CON: erro nomeado
        CON-->>V: ⚠️ rascunho PRESERVADO<br/>+ ação corretiva
    end
```

⚠️ **O ramo de falha é o que decide se o módulo é usado.** Se a vendedora perde o pedido montado,
ela volta a lançar no ERP e abandona a ferramenta. Cinco erros tratados: estoque esgotado, crédito
bloqueado, item inativado, cliente sem cadastro fiscal, falha de comunicação.

**Ganho colateral:** o vínculo do passo 14 é o que torna a **atribuição de receita exata**, em vez
de estimada por janela de 3/7/14 dias.

---

## 6. Multi-ERP — porta e capacidades

**Pergunta:** como o produto vende para clientes com ERPs de qualidade muito diferente?

```mermaid
flowchart TB
    subgraph dom["Domínio GeraCRM — modelo canônico"]
        MC["Cliente · Produto · Pedido<br/>Saldo · TabelaPreco · Credito"]
    end

    subgraph portas["Portas definidas por NÓS"]
        P1["Ingestão em lote"]
        P2["Leitura síncrona"]
        P3["Escrita de pedido"]
    end

    subgraph adapt["Adaptadores"]
        A1["GeraCloud<br/>✅ tudo"]
        A2["drezz<br/>✅ tudo"]
        A3["Bling / Tiny<br/>⚠️ parcial"]
        A4["API pública<br/>conector universal"]
    end

    MC --> P1 & P2 & P3
    P1 & P2 & P3 --> A1 & A2 & A3 & A4

    style dom fill:#FFF3E9,stroke:#FF6732,stroke-width:2px
```

**Degradação por capacidade — o produto adapta, não quebra:**

```mermaid
flowchart LR
    C{"conector declara<br/>saldoSincrono?"}
    C -->|sim| S1["saldo ao vivo<br/>valida antes de enviar"]
    C -->|não| S2["saldo da última sincronização<br/>⚠️ com aviso e horário<br/>valida na efetivação"]

    D{"escritaPedido?"}
    D -->|sim| D1["efetiva no ERP"]
    D -->|não| D2["rascunho exportável<br/>lançamento manual"]

    style S2 fill:#FFF8E1
    style D2 fill:#FFF8E1
```

⚠️ **A capacidade é visível na interface.** Usuário de ERP limitado precisa saber *por que* o saldo
tem hora — senão conclui que o produto está errado.

---

## 7. Isolamento multi-tenant — as camadas

**Pergunta:** o que impede a empresa A de ver dado da empresa B?

```mermaid
flowchart TB
    T["Requisição autenticada"]
    T --> C1

    C1["1️⃣ tenant_id vem do TOKEN<br/>⚠️ nunca de parâmetro"]
    C1 --> C2["2️⃣ RLS no Postgres<br/>toda tabela, toda consulta"]
    C2 --> C3["3️⃣ Chave única composta<br/>UNIQUE tenant_id, cnpj"]
    C3 --> C4["4️⃣ Canal prefixado por tenant<br/>função única monta o nome"]
    C4 --> C5["5️⃣ Autorização por subscrição<br/>revalidada, não só no login"]
    C5 --> C6["6️⃣ Payload mínimo<br/>sem conteúdo no evento"]
    C6 --> C7["7️⃣ Credencial por tenant<br/>cifrada em repouso"]
    C7 --> OK(["✅ Dado isolado"])

    style C2 fill:#E8F5E9
    style C4 fill:#E8F5E9
    style C6 fill:#E8F5E9
    style OK fill:#4CAF50,color:#fff
```

**Testado, não presumido:** todo repositório tem caso com dois tenants; todo canal também. Ver
`geracrm-testes`.

---

## 8. Camadas — a regra de dependência

**Pergunta:** onde cada tipo de código mora?

```mermaid
flowchart TB
    E["🌐 ENTREGA<br/>rotas HTTP · SSE · workers · telas"]
    A["🔌 ADAPTADORES<br/>repositórios · conectores de ERP · cliente Meta · IA"]
    U["⚙️ CASOS DE USO<br/>orquestração · transação · autorização"]
    D["💎 DOMÍNIO<br/>entidades · invariantes · regras"]

    E --> A --> U --> D

    style D fill:#FF6732,color:#fff
    style U fill:#FFB08A
    style A fill:#FFD6C2
    style E fill:#FFF3E9
```

**Teste prático:** abra um arquivo de domínio. Se houver import de framework, ORM, HTTP ou SDK
externo, a regra foi violada.

⚠️ **Falha de negócio é retorno tipificado, não exceção.** Estoque insuficiente e crédito bloqueado
são resultados esperados — a tela precisa deles nomeados.

---

## 9. Monorepo e deploy

**Pergunta:** o que dispara qual deploy?

```mermaid
flowchart LR
    subgraph repo["Monorepo — pnpm + Turborepo"]
        direction TB
        AA["apps/api"]
        AC["apps/console"]
        AP["apps/app"]
        AT["apps/catalogo"]
        PS["packages/shared<br/><b>TypeScript PURO</b>"]
        PC["packages/conectores"]
        IM["infra/migrations"]
    end

    subgraph rw["Railway — watch path por serviço"]
        SA["serviço api"]
        SC["serviço console"]
        ST["serviço catalogo"]
    end

    EAS["EAS / lojas"]

    AA --> SA
    AC --> SC
    AT --> ST
    AP --> EAS
    PS -.->|⚠️ precisa estar<br/>no watch path| SA & SC & ST & EAS
    PC --> SA
    IM -->|preDeployCommand| SA

    style PS fill:#FFF3E9,stroke:#FF6732,stroke-width:2px
```

⚠️ **A armadilha herdada do drezz:** se um front importa `packages/shared` e o watch path não o
inclui, **o tipo muda na API e não muda na tela**. Deploy verde, comportamento errado, ninguém
entende por quê.

⚠️ **`packages/shared` é TypeScript puro** — consumido por Angular, Expo e API ao mesmo tempo.
Um import de framework quebra dois dos três.

---

## 10. Ondas de implementação

**Pergunta:** em que ordem isso é construído, e quando dá para cobrar?

```mermaid
flowchart LR
    O0["<b>Onda 0</b><br/>Fundação<br/><br/>dados entrando<br/>canal em pé"]
    O1["<b>Onda 1</b><br/>Atender<br/><br/>inbox · fila<br/>janela 24h"]
    O2["<b>Onda 2</b><br/>Vender<br/><br/>CRM · RFV · tarefas<br/>pedido · mobile"]
    O3["<b>Onda 3</b><br/>Escalar<br/><br/>campanhas com ROI<br/>IA · força de vendas"]
    O4["<b>Onda 4</b><br/>Diferenciar<br/><br/>fila do dia · SLA<br/>capacitação · white-label"]

    O0 --> O1 --> O2 --> O3 --> O4

    V(["💰 vendável"])
    O2 -.-> V

    style O2 fill:#E8F5E9,stroke:#4CAF50,stroke-width:3px
    style V fill:#4CAF50,color:#fff
```

**Dependências que não podem ser invertidas:**

```mermaid
flowchart LR
    CH["carga histórica"] --> RFV["RFV"] --> SEG["segmentação"] --> CMP["campanha"]
    RFV --> FD["fila do dia"]
    PED["latência do pedido"] --> ATR["atribuição de receita"]

    style CH fill:#FFF8E1
```

⚠️ **RFV sem carga histórica nasce vazio** — e o produto perde o argumento central.
⚠️ **Campanha antes de segmentação** vira disparo para todos, que é o que os concorrentes baratos fazem.

---

## 11. Mapa de documentos

```mermaid
flowchart TB
    subgraph desc["Descoberta"]
        E1["estudo-crms-whatsapp"]
        E2["inventario-funcionalidades-referencia"]
        E3["concorrentes-tailor"]
    end
    subgraph def["Definição"]
        D1["escopo-funcional"]
        D2["backlog-epicos"]
    end
    subgraph proj["Projeto"]
        P1["modelo-de-dados"]
        P2["especificacao-telas"]
        P3["especificacao-telas-entrada"]
        P4["contrato-api"]
        P5["cenarios-bdd"]
    end
    subgraph tec["Técnico"]
        T1["stack-arquitetura"]
        T2["aproveitamento-drezz"]
        T3["decisoes (ADRs)"]
        T4["arquitetura-visual"]
    end
    subgraph exec["Execução"]
        X1["prontidao-para-inicio"]
        X2["plano-onda-0"]
        X3["direcao-visual"]
    end

    desc --> def --> proj --> exec
    def --> tec --> proj
    T3 -.governa.-> proj & exec

    style T3 fill:#FFF3E9,stroke:#FF6732,stroke-width:2px
```

---

## Como manter estes diagramas

- ⚠️ **Diagrama desatualizado mente com autoridade** — pior que não existir.
- Mudou ADR? Confira os diagramas 2, 3, 6, 7 e 9.
- Contexto de domínio novo? Diagrama 3.
- Fluxo crítico alterado? Diagramas 4 e 5 — são os que mais explicam o sistema para quem chega.
- Mermaid é texto: entra no diff, e revisão de PR pega diagrama que não bate com o código.
