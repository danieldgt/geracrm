# O fluxo, em diagramas

> Mesmo padrão de `../docs/arquitetura-visual.md`. Seis diagramas, do ciclo de negócio ao instante
> mais frágil da integração.
>
> **Legenda de cor:** 🟠 laranja = **construir** (não existe) · ⬜ neutro = **já existe no GeraCRM**
> · 🔵 azul = fora do nosso controle (plataforma, ERP).

---

## 1. O ciclo — por que a família drezz é o primeiro movimento

A operação não começa vendendo para fora. Ela começa **em nós**, e cada volta produz três coisas:
receita, **prova** e dado que melhora os públicos da volta seguinte.

```mermaid
flowchart LR
    A["<b>Gera3 anuncia</b><br/>Rede A · B2B"] --> B["Lojista<br/>vira lead"]
    B --> C["Contrata<br/>drezz / GeraCRM"]
    C --> D["<b>Opera a loja no CRM</b><br/>conversa · funil<br/>pedido · ERP"]
    D --> E["Contrata<br/>a agência · Rede B"]
    E --> F["Agência pesca<br/>consumidor para a loja"]
    F --> G["<b>Loja vende mais</b><br/>e fica"]
    G -->|"o caso vira PROVA"| A

    style A fill:#FF6732,color:#fff,stroke:#C7431A
    style D fill:#0FB5AE,color:#fff,stroke:#0A8A85
    style G fill:#2E9E5B,color:#fff,stroke:#237A46
```

⚠️ **A prova é o ativo composto.** Cada loja que cresce barateia a aquisição da próxima — é o que
faz a Rede A ficar mais eficiente com o tempo sem aumentar a verba.

⚠️ **E é por isso que validar em nós vem antes.** Vender fluxo não validado é vender promessa; o
primeiro cliente da agência somos nós, e o segundo é a base que já confia no drezz.

---

## 2. As duas redes — públicos opostos, mesma máquina

```mermaid
flowchart TB
    subgraph RA["🅰️ Rede A — a nossa (B2B SaaS)"]
        direction LR
        G1["Gera3"] -->|"anúncio para lojista"| L1["<b>Lojista</b><br/>universo pequeno<br/>e identificável"]
    end

    subgraph RB["🅱️ Rede B — a do cliente (B2C local)"]
        direction LR
        L2["Loja de moda"] -->|"anúncio no raio da loja"| C1["<b>Consumidor</b><br/>volume alto<br/>decisão rápida"]
    end

    L1 -->|"contrata o CRM<br/>e vira tenant"| L2
    C1 -->|"compra · PDV / ERP"| PR["<b>ROAS real</b><br/>receita efetivada"]
    PR -->|"vira caso e alimenta"| G1

    style L1 fill:#FF6732,color:#fff,stroke:#C7431A
    style C1 fill:#3F6FBE,color:#fff,stroke:#234380
    style PR fill:#2E9E5B,color:#fff,stroke:#237A46
```

⚠️ **Confundir as duas é o erro mais caro.** Ciclo, ticket, universo e formato são diferentes — o
playbook da Rede B **não** serve para a Rede A, e vice-versa.

---

## 3. O fluxo operacional, ponta a ponta

O que a operação faz com um lead, do anúncio até o sinal voltar para a plataforma.

```mermaid
flowchart TB
    AD["📣 <b>Anúncio</b><br/>Google · AMK-015"]

    subgraph ENT["Entrada — modo_entrada declarado na campanha (AMK-016)"]
        direction LR
        LP["<b>inbound_wa</b><br/>LP + botão wa.me<br/>o LEAD escreve ✅"]
        FORM["<b>outbound_formulario</b><br/>formulário<br/>NÓS iniciamos ⚠️"]
    end

    ORI["<b>midia_lead_origem</b><br/>UTM · gclid · código da sessão<br/>consentimento"]
    CON["<b>contato</b><br/>reconcilia por telefone"]
    ROT{"<b>Roteamento</b>"}
    AGE["🤖 <b>SDR agent</b><br/>assume pelo INV-51"]
    FIL["👤 <b>Fila humana</b><br/>Assumir atendimento"]
    QUA["Qualificação<br/>+ motivo registrado"]
    PED["<b>Pedido</b><br/>nasce na conversa"]
    ERP[("🏢 <b>ERP</b><br/>efetiva a venda")]
    CONV["<b>Devolve conversão</b><br/>com VALOR em centavos"]
    PUB["<b>Devolve públicos</b><br/>semelhante de comprador real"]

    AD --> LP & FORM
    LP --> ORI
    FORM --> ORI
    ORI --> CON --> ROT
    ROT -->|"inbound_wa · Rede B"| AGE
    ROT -->|"outbound_formulario · alto valor<br/>· Rede A · agente off"| FIL
    AGE -->|"handoff com contexto"| FIL
    AGE --> QUA
    FIL --> QUA
    QUA --> PED --> ERP
    ERP --> CONV
    ERP --> PUB
    CONV -->|"otimiza por VENDA,<br/>não por lead barato"| AD
    PUB -->|"procura quem se parece<br/>com quem COMPRA"| AD

    style AD fill:#3F6FBE,color:#fff,stroke:#234380
    style ERP fill:#3F6FBE,color:#fff,stroke:#234380
    style LP fill:#FF6732,color:#fff,stroke:#C7431A
    style FORM fill:#E8A317,color:#1F1A16,stroke:#B87F0D
    style ORI fill:#FF6732,color:#fff,stroke:#C7431A
    style ROT fill:#FF6732,color:#fff,stroke:#C7431A
    style AGE fill:#FF6732,color:#fff,stroke:#C7431A
    style CONV fill:#2E9E5B,color:#fff,stroke:#237A46
    style PUB fill:#2E9E5B,color:#fff,stroke:#237A46
```

⚠️ **A coluna do meio já existe inteira** — `contato`, fila, assunção atômica, qualificação, pedido,
ERP. O que falta é a **borda**: a entrada (origem) e o **retorno do sinal**.

⚠️ **O retorno é o produto.** Sem as duas setas de baixo, a plataforma continua otimizando por lead
barato e a operação vira agência comum.

---

## 4. O instante mais frágil da integração

Sem CTWA (AMK-012), a origem do lead viaja num **código dentro da mensagem pronta** do link `wa.me`.
É o nosso `ctwa_clid`, feito à mão — e ele é **editável pelo lead**.

```mermaid
sequenceDiagram
    autonumber
    participant L as 👤 Lead
    participant P as LP / catálogo
    participant W as WhatsApp
    participant G as Webhook (existe)
    participant D as Banco

    L->>P: chega pelo anúncio (gclid + utm)
    P->>D: gera código de sessão A7K2Q<br/>e guarda gclid · utm · página
    P->>L: botão "Falar no WhatsApp"<br/>wa.me/…?text=… [ref: A7K2Q]
    L->>W: envia a PRIMEIRA mensagem
    Note over L,W: ⚠️ o lead PODE apagar o texto pronto
    W->>G: webhook — mensagem entrante
    rect rgb(255, 243, 236)
    G->>D: procura o código em qualquer<br/>posição da mensagem
    alt código presente
        D->>D: origem COMPLETA<br/>anúncio ↔ lead ligado
    else código apagado
        D->>D: ⚠️ origem PARCIAL<br/>veio da LP, mas não sabemos de qual anúncio
    end
    end
```

⚠️ **A taxa de código perdido é métrica de saúde, não detalhe.** Se ela sobe, a atribuição está
furando — e o sintoma é silencioso: o lead entra, a conversa acontece, a venda acontece, e o anúncio
não recebe o crédito. É o AQ-45.

⚠️ **É o preço de AMK-012.** O `ctwa_clid` da Meta chega no protocolo e não dá para apagar; o nosso
depende de o lead não editar a mensagem. Mais frágil, e funciona sem registro nenhum.

---

## 5. O roteamento — agente ou humano

Regras avaliadas **em ordem**, em código. A primeira que casar decide. ⚠️ O padrão é **humano**.

```mermaid
flowchart TB
    IN(["Lead chega"]) --> R1{"Agente<br/>desligado?"}
    R1 -->|sim| H["👤 <b>Fila humana</b>"]
    R1 -->|não| R2{"Campanha é<br/>outbound?"}
    R2 -->|sim| H
    R2 -->|não| R3{"Cliente de<br/>ALTO VALOR?"}
    R3 -->|sim| HC["👤 <b>Dono da carteira</b><br/>notificado"]
    R3 -->|não| R4{"Tem dono<br/>de carteira?"}
    R4 -->|sim| HC
    R4 -->|não| R5{"Fora do<br/>escopo?"}
    R5 -->|sim| H
    R5 -->|não| R6{"Veio de<br/>anúncio?"}
    R6 -->|"sim · Rede B"| A["🤖 <b>SDR agent</b><br/>identificado"]
    R6 -->|"sim · Rede A"| H
    R6 -->|não| R7{"Fora do<br/>expediente?"}
    R7 -->|sim| A
    R7 -->|não| H

    A -.->|"por regra · por incerteza<br/>· por falha de IA"| H

    style R3 fill:#E8A317,color:#1F1A16,stroke:#B87F0D
    style A fill:#FF6732,color:#fff,stroke:#C7431A
    style H fill:#0FB5AE,color:#fff,stroke:#0A8A85
    style HC fill:#0FB5AE,color:#fff,stroke:#0A8A85
```

⚠️ **Regra 3 é inegociável.** O CRM sabe o RFV no instante da chegada — somos a única operação de
mídia que *pode* saber isso. Trocar a relação com o melhor cliente por um minuto de vendedora
economizado é péssimo negócio.

⚠️ **O agente assume pelo mesmo INV-51 que uma pessoa.** Não há caminho paralelo: agente desligado
simplesmente não assume, e tudo cai na fila. Degradar é o padrão, não a exceção.

---

## 6. As fases e o que cada uma destrava

```mermaid
flowchart LR
    F0["<b>F0 · Observar</b><br/>só leitura<br/>⚠️ zero risco"]
    F1["<b>F1 · Loop de dados</b><br/>origem · CAPI<br/>públicos"]
    F2["<b>F2 · Leads</b><br/>roteamento<br/>SDR agent"]
    F3["<b>F3 · Criativo</b><br/>volume + fadiga"]
    F4["<b>F4 · Escrita</b><br/>pausar → publicar<br/>→ orçamento"]
    F5["<b>F5 · Escala</b><br/>console da agência<br/>playbooks"]

    META["🔴 <b>Registro na Meta</b><br/>semanas · fora do<br/>nosso controle"]

    F0 --> F1 --> F2 --> F3 --> F4 --> F5
    META -.->|"destrava"| F2
    META -.->|"destrava"| F4
    F1 -.->|"sem isto, automatizar<br/>é acelerar errado"| F4

    style F0 fill:#0FB5AE,color:#fff,stroke:#0A8A85
    style F1 fill:#FF6732,color:#fff,stroke:#C7431A
    style META fill:#B8383C,color:#fff,stroke:#7A2810
```

⚠️ **O registro na Meta começa na F0**, não na F2 — ele leva semanas, não depende de nós, e destrava
duas fases. É a mesma lição que `../docs/prontidao-para-inicio.md` já tinha aprendido no CRM.

⚠️ **F1 antes de F4** não é preferência de ordem: é a diferença entre otimizar por venda e otimizar
por lead barato.
