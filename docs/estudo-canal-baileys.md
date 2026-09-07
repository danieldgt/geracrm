# Estudo — `CanalBaileys` como terceira opção de canal

> Estudo para decisão. Não é ADR ainda: se for aprovado, vira **ADR-022** e
> altera o ADR-021 (que hoje só prevê *oficial × não-oficial via fornecedor*).
> Data: 2026-09-07. Base: leitura do código do
> [OpenClaw](https://github.com/openclaw/openclaw) (`extensions/whatsapp/`) e do
> nosso `contexts/atendimento/canais/`.

## A pergunta

Hoje o não-oficial chega até nós **por um fornecedor** (PlugZapi/Z-API): eles
mantêm a sessão do WhatsApp Web e nos expõem HTTP + webhook. O Baileys é a
biblioteca que faz esse trabalho — falar o protocolo multi-device direto. A
pergunta é se vale **trazer essa camada para dentro**, como um terceiro
provedor no catálogo.

## Resposta curta

**Vale, e a arquitetura já comporta — mas não é "mais um `case` na fábrica".**
É um **subsistema novo**: um processo sempre ligado, dono de sockets, com estado
de sessão mutável por tenant. O que o ADR-008/021 nos dá de graça é a *fachada*
(porta + capacidades + degradação); o que ele **não** dá é o ciclo de vida da
conexão, que hoje é problema do fornecedor.

Recomendo construir **em fases, mantendo o PlugZapi**, e só promover a padrão
depois que um número real sobreviver 30 dias.

> **Atualização de 2026-09-07 — as três decisões do dono estão em §12.**
> O custo do PlugZapi é **R$ 250 por número/mês**, o que muda a conta: a economia
> é recorrente e por número, contra um custo de construção que se paga uma vez.
> **Campanha ENTRA** por este caminho (eu havia recomendado o contrário) — e isso
> tem um pré-requisito que já estava especificado e nunca foi ligado: o `INV-23`.
> E a **prioridade oficial × não-oficial passa a ser por cliente**, o que é uma
> lacuna do produto **hoje**, mesmo sem Baileys.

---

## 1. O achado central: webhook × socket

Todo o desenho atual de canal assume **entrada por webhook e saída por HTTP sem
estado**:

```
                 ENTRADA                          SAÍDA
Meta      → POST /webhooks/meta/...       criarCanal(cred).enviarTexto()
PlugZapi  → POST /webhooks/plugzapi/:id   criarCanal(cred).enviarTexto()
```

Isso é o que permite a API ser **stateless** (ADR: "qualquer instância atende
qualquer tenant"). O adaptador nasce a cada chamada, recebe a credencial, faz um
`fetch` e morre.

O Baileys quebra as duas pontas:

| | Webhook (hoje) | Baileys |
|---|---|---|
| Entrada | HTTP chega em qualquer instância | Evento num **socket aberto** num processo específico |
| Saída | `fetch` de qualquer instância | Só **quem tem o socket** pode enviar |
| Estado | Credencial imutável, cifrada | **Sessão mutável**, escrita a cada mensagem |
| Escala | N instâncias, indiferente | **Uma dona por número**, sempre |

⚠️ **Este é o custo real da decisão**, e não a biblioteca. Trocar `fetch` por
`makeWASocket` é a parte fácil; assumir a posse de uma sessão viva é a parte que
muda o desenho de deploy.

## 2. O desenho que preserva a porta

A saída para não contaminar a API é **transformar o problema no problema que já
sabemos resolver**: um serviço nosso, com HTTP, na rede privada — do ponto de
vista do adaptador, indistinguível do PlugZapi.

```
apps/api (N instâncias, stateless)
   │  criarCanal('baileys', cred) → CanalBaileys
   │      cred = { base: http://geracrm-whatsapp.railway.internal, canalId, segredo }
   │
   │  POST /interno/canais/:id/enviar-texto           ← saída
   ▼
geracrm-whatsapp  (SERVICE_ROLE=whatsapp, 1 réplica)
   │  Map<canalId, WASocket>  ·  reconexão  ·  watchdog
   │  sessão ⇄ Postgres (cifrada, por tenant)
   │
   │  POST /webhooks/baileys/:canalId  (loopback interno, assinado)  → entrada
   ▼
apps/api → ingerirMensagemEntrante(...)   ← MESMA função de hoje
```

O que isso compra:

- **`PortaCanal` não muda uma linha.** `CanalBaileys` é um cliente HTTP, como o
  `CanalPlugZapi` — só que a "API do fornecedor" é nossa.
- **A ingestão não muda.** O socket devolve o evento para o caminho de webhook
  que já existe, com a mesma idempotência por `idExterno` (INV-38) e o mesmo
  `tenant_do_canal()`.
- **O vigia não muda.** `verificarConexao()` pergunta ao nosso serviço em vez de
  perguntar ao PlugZapi.
- **O `SERVICE_ROLE` já existe.** `docker-start.sh` ramifica por papel e o
  `geracrm-integrador` já prova o padrão (mesma imagem, papel diferente). A rede
  privada está **ativa** — confirmei `geracrm-integrador.railway.internal`.

⚠️ **Uma réplica, sempre.** Duas instâncias com a mesma sessão do WhatsApp não
"balanceiam": elas se derrubam (o WhatsApp encerra a sessão anterior do mesmo
aparelho). Isso precisa ser garantia de configuração **e** de código —
`pg_try_advisory_lock` por `canal_id` no boot, como o vigia já faz.

## 3. O problema do cofre: credencial × sessão

Nosso cofre (`integracao/cofre.ts`) foi desenhado sobre uma premissa que o
Baileys viola: *"a credencial ENTRA e nunca SAI"*, imutável, escrita quando
alguém preenche o formulário.

A sessão do Baileys é o oposto:

- **muda o tempo todo** — `creds` mais o *signal key store* (pre-keys, sessões
  por contato, sender-keys de grupo, chaves de app-state). O OpenClaw usa
  `useMultiFileAuthState`, que é **um diretório de arquivos**, não um JSON;
- **é gravada durante o tráfego** — cada mensagem pode consumir uma pre-key;
- **corrompe** — a ponto de o OpenClaw manter `creds.json.bak`, escrita atômica e
  uma regra explícita de *"não sobrescrever um backup bom com um `creds.json`
  truncado"*;
- **é grande** perto de uma credencial: não cabe na cabeça de `credenciais_cifradas`.

Consequência: **tabela nova**, não coluna nova.

```sql
CREATE TABLE canal_sessao_baileys (
    tenant_id  uuid NOT NULL,
    canal_id   uuid NOT NULL,
    chave      text NOT NULL,        -- 'creds' | 'pre-key-123' | 'session-55…' | …
    valor      bytea NOT NULL,       -- cifrado com a MESMA chave do cofre
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, canal_id, chave),
    FOREIGN KEY (tenant_id, canal_id) REFERENCES canal_conectado (tenant_id, id) ON DELETE CASCADE
);
SELECT aplicar_rls('canal_sessao_baileys');
```

Três razões de estar no Postgres e não em volume:

1. **Zero camadas em produção** é decisão vigente (não há backup de volume aqui);
   sessão em disco de container é sessão perdida no próximo deploy — e sessão
   perdida significa **QR de novo, com o dono do número no celular**.
2. RLS e cifra vêm de graça, no mesmo modelo do resto.
3. `ON DELETE CASCADE` faz o "Remover número" (0083) limpar a sessão junto — o
   que um diretório em disco não faria.

⚠️ O contraponto honesto: escrever chave de signal no Postgres a cada mensagem é
tráfego de escrita que hoje não existe. Mitigação: `makeCacheableSignalKeyStore`
(que o OpenClaw usa) na frente, com flush em lote. **Isto precisa ser medido no
spike, não estimado.**

## 4. Capacidades declaradas

O tipo persistido é o mesmo do PlugZapi — `whatsapp_nao_oficial` — então o
gateway de envio, a janela e o aviso de risco **já funcionam sem tocar em nada**:

```ts
const CAPACIDADES_BAILEYS: CapacidadesCanal = {
  janela24h: false,        // não-oficial não tem janela
  aceitaTemplate: false,
  riscoBanimento: true,    // ⚠️ IDÊNTICO ao PlugZapi — a origem do risco é o protocolo
  textoLivreSempre: true,
  sessaoPodeCair: true,    // e aqui somos NÓS que precisamos perceber
}
```

⚠️ **`riscoBanimento` não melhora.** É o mesmo protocolo não-oficial; o que muda
é quem opera. Qualquer texto de interface que sugira "agora é mais seguro" seria
mentira — e o ADR-021 existe justamente para esse aviso ser visível.

O que **muda de verdade** na tela: com o PlugZapi, "sessão caiu" é uma resposta
de fornecedor; com o Baileys, é um evento nosso, em tempo real. Dá para acender o
alerta em segundos em vez de esperar a passada de 5 min do vigia.

## 5. Ciclo de vida — o que o OpenClaw ensina

Foi por isso que li o código deles em vez da documentação. Três coisas valem
cópia direta:

**Backoff com teto e desistência** (`reconnect.ts`):

```ts
{ initialMs: 2_000, maxMs: 30_000, factor: 1.8, jitter: 0.25, maxAttempts: 12 }
```

O `jitter` importa quando são N sockets: sem ele, uma queda de rede faz todos os
tenants reconectarem no mesmo milissegundo.

**Nem toda queda é igual** (`connection-controller.ts`):

| Código | Significado | Ação |
|---|---|---|
| `515` | reinício pós-pareamento | reconecta — é **esperado** logo após o QR |
| `408` | timeout antes do login | socket novo |
| `401` | **deslogado** | **fatal**: limpa a sessão e exige QR de novo |

⚠️ Tratar `401` como "tenta de novo" é o erro que gera o loop de reconexão que
aparece nos relatos de banimento — o número fica batendo na porta com uma
credencial que o WhatsApp já invalidou.

**Watchdog de dois sinais** — o mais interessante, e algo que **o nosso vigia não
tem**: eles não reiniciam uma sessão só porque ninguém escreveu. Reconectam
quando os *frames de transporte* param, **ou** quando mensagens de aplicação
ficam mudas além de 4× o timeout normal. Silêncio de cliente ≠ silêncio de rede.

Timings deles, como ponto de partida: `keepAlive 25s`, `connect 60s`, `query 60s`.

**Pareamento é só QR.** Não há *pairing code* por telefone no caminho deles.
A nossa tela `/numeros` já faz isso bem (sessão de pareamento com renovação a
cada 20s e detecção automática de conexão) — e essa parte é reaproveitável
inteira, porque `qrCode()` já é contrato da porta.

## 6. Multi-tenant: o que o OpenClaw *não* resolve

O OpenClaw é **mono-usuário**: um socket, um `~/.openclaw/credentials/`. Nós
teríamos N sockets num processo, e isso traz problemas que o código deles não
tem resposta para:

- **Isolamento de falha.** Uma exceção não tratada no handler de um tenant não
  pode derrubar o processo — que levaria junto os sockets de todos os outros.
- **Ordem de reconexão no boot.** Subir 20 sockets de uma vez após um deploy é um
  padrão de tráfego que chama atenção. Precisa de fila com espaçamento.
- **Memória.** Cada socket carrega cache de chaves e metadados de grupo. Não
  tenho número confiável — **medir no spike com 1, 5 e 20 sockets** antes de
  prometer qualquer densidade.
- **Deploy derruba tudo.** Todo `railway up` reinicia N sessões. Com o PlugZapi,
  nosso deploy não afeta a sessão (ela vive lá). Isso é uma **perda real** de
  disponibilidade que precisa entrar na conta.

## 7. O que se ganha e o que se perde

**Ganha**

- Fim do custo por instância do fornecedor e da dependência dele (hoje a mesma
  instância PlugZapi é compartilhada por dois tenants — ver a pendência da Drezz
  Fábrica; com Baileys, "mais um número" é só mais um socket).
- Eventos em tempo real: queda de sessão, recibo de leitura e presença chegam
  como evento, não como resposta de *polling*.
- Sem intermediário lendo o conteúdo das conversas dos clientes.

**Perde**

- A API deixa de ser inteiramente stateless: nasce um serviço com dono e estado.
- Passamos a acompanhar a evolução do protocolo do WhatsApp Web. No npm, a tag
  `latest` do Baileys hoje é **`7.0.0-rc14`** (a linha estável anterior é
  `6.7.24`, sob a tag `legacy`) — quem depende disso vive de release candidate.
- Todo defeito de entrega vira **nosso**. Com o fornecedor, metade dos incidentes
  tem para quem ligar.

## 8. Dimensionamento (com evidência)

A extensão de WhatsApp do OpenClaw, medida pela API do GitHub:

- **393 KB de código de produção** e **838 KB de teste**, em 174 arquivos —
  para um caso **mono-usuário**.
- Só o núcleo equivalente ao que precisaríamos (`connection-controller`,
  `session`, `login-qr`, `send`, `auth-store`, `monitor-inbox`, mídia, timings,
  persistência de credencial) soma **≈129 KB** — algo entre 3.000 e 3.500 linhas.
- O `connection-controller.ts` sozinho tem 37 KB, com 39 KB de teste ao lado.
  Isso é **só a máquina de estados da conexão**.

⚠️ Boa parte do resto é específico deles (aprovação por reação, ferramentas de
agente, driver de QA) e não nos serve. Mas a proporção **2:1 de teste para
produção** no ciclo de conexão é o recado: eles descobriram esses casos
apanhando.

Estimativa honesta para o nosso escopo (texto + imagem + áudio, sem grupos, sem
chamadas): **um subsistema de porte médio**, comparável ao contexto de campanha —
não a uma tarde. E a maior parte do custo não é escrever: é descobrir os modos de
falha que só aparecem com número real, em dias.

## 9. Riscos, sem maquiagem

1. **Banimento não melhora** (§4). Se o número da Drezz Fábrica for banido com
   Baileys, o prejuízo é o mesmo — e a culpa fica mais perto de nós.
2. **O próprio Baileys desencoraja o nosso caso de uso.** O README diz, literal:
   *"We discourage any stalkerware, bulk or automated messaging usage."*
   Nossa `campanha` **é** disparo em lote. Isso não impede tecnicamente nada
   (licença MIT), mas é o motivo de eu recomendar **não** ligar campanha por este
   caminho na fase 1: é exatamente o padrão de tráfego que faz o WhatsApp
   derrubar número.
3. **RC em produção.** `7.0.0-rc14` como `latest` significa aceitar *breaking
   change* fora do nosso calendário.
4. **Deploy = queda de sessão** (§6). Precisa de janela e aviso na tela.
5. **Sessão em Postgres é caminho novo de escrita.** Se o cache não segurar,
   vira escrita por mensagem numa tabela com RLS.

## 10. Plano em fases

| Fase | O que | Critério para seguir |
|---|---|---|
| **0 — Spike** | Um socket, fora do produto, contra um número descartável. Medir memória, tráfego de escrita da sessão e sobrevivência a deploy | Sessão sobrevive a 3 deploys e 48h sem QR novo |
| **1 — Serviço** | `SERVICE_ROLE=whatsapp` com 1 réplica, sessão no Postgres cifrada, RPC interno, `CanalBaileys` no catálogo. **Sem campanha** | Um número real de dogfooding, 30 dias, sem queda não explicada |
| **2 — Frota** | N tenants, fila de reconexão com jitter, alerta por socket, watchdog de dois sinais | Dois tenants convivendo, incidente de queda detectado em < 1 min |
| **3 — Decisão** | Promover a padrão do não-oficial *ou* manter como alternativa | — |

⚠️ **Critério de parada**, definido antes de começar: se na fase 1 o número cair
mais de duas vezes por semana sem causa externa identificada, o estudo se encerra
com "o fornecedor faz isso melhor" — e isso é um resultado válido, não um
fracasso.

## 11. O que depende de decisão sua

1. **Motivação principal**: custo do fornecedor, independência, ou controle
   técnico? A resposta muda a prioridade — se for custo, vale antes levantar
   quanto o PlugZapi pesa hoje de fato.
2. **Campanha por Baileys**: eu recomendo não, na fase 1. Se for requisito,
   muda o desenho (precisa de *throttle* por socket bem mais conservador).
3. **Prioridade contra a Meta.** O `CLAUDE.md` diz que o caminho crítico é o
   registro na Meta, que está fora do nosso controle. Este estudo é sobre a
   **alternativa** a esse caminho — e, se a Meta sair, o não-oficial vira
   secundário por decisão de produto (ADR-021: *"o oficial é a prioridade"*).

## Referências

- OpenClaw — `extensions/whatsapp/src/{session,connection-controller,reconnect,auth-store}.ts`
  · <https://github.com/openclaw/openclaw>
- OpenClaw docs, canal WhatsApp · <https://docs.openclaw.ai/channels/whatsapp>
- Pedido de Cloud API oficial, **fechado como *not planned*** · [issue #23093](https://github.com/openclaw/openclaw/issues/23093)
- Baileys (MIT) · <https://github.com/WhiskeySockets/Baileys>
- Nosso lado: `contexts/atendimento/canais/{porta,fabrica,plugzapi}.ts`,
  `vigia-canal.ts`, `integracao/cofre.ts`, `apps/api/docker-start.sh`, ADR-008/021

---

## 12. As três decisões do dono (2026-09-07)

### 12.1 A economia: R$ 250 por número/mês

Isto muda a natureza da conta. O custo do fornecedor é **recorrente e por
número**; o custo de construir é **uma vez**. São curvas diferentes, e a segunda
não cresce com a base de clientes.

| Números na frota | Por mês | Por ano |
|---:|---:|---:|
| 1 | R$ 250 | R$ 3.000 |
| 5 | R$ 1.250 | R$ 15.000 |
| 10 | R$ 2.500 | R$ 30.000 |
| 20 | R$ 5.000 | R$ 60.000 |

⚠️ **O número de hoje está artificialmente baixo, e por um defeito.** Os dois
canais PlugZapi em produção (Drezz Fábrica e Gera3 dogfooding) apontam para a
**mesma instância** — um número servindo dois tenants. Corrigir isso, que é o
certo, já dobra a fatura antes de qualquer cliente novo. A economia real começa
em R$ 500/mês, não em R$ 250.

Contra isso, o custo recorrente do Baileys é **um serviço a mais no Railway** —
ordem de grandeza de dezenas de reais, não centenas — mais o tempo de operação,
que é o custo verdadeiro e não aparece em fatura.

**Leitura:** a partir de ~5 números a construção se paga no primeiro ano; a
partir de ~10 ela se paga em meses. Como cada cliente novo é pelo menos um
número, isto deixa de ser otimização e vira **estrutura de custo do produto**.
O que a economia **não** compra é tempo de operação — e é por isso que as fases
continuam existindo.

### 12.2 Campanha entra — e o pré-requisito já estava escrito

Registro que eu havia recomendado o contrário e que a decisão é sua; sigo com
ela. Mas o levantamento achou uma coisa que muda o que "campanha por Baileys"
significa na prática:

⚠️ **O `INV-23` foi especificado, tem tabela criada e NUNCA foi ligado.**

```
numero_throttle           → 0 arquivos de produção
numero_quota_hora         → 0 arquivos de produção
numero_conversa_iniciada  → 0 arquivos de produção
```

As três tabelas existem desde a `0011`, com comentário explicando a reserva
atômica por `UPDATE … RETURNING`, e **nenhuma linha de produção as consulta**. O
que existe hoje de verdade é só o **teto diário** do aquecimento (`0037`).

Na prática, o ritmo atual de disparo é:

- despachante a cada **30 s**, `LOTE = 10` por campanha, por passada;
- os 10 saem **em sequência, sem espaçamento nenhum** entre si;
- o único freio é o teto do dia (rampa de 20 → 1000 em ~9 dias).

Com o PlugZapi, uma rajada de 10 chega ao fornecedor e a infra dele absorve o
ritmo. **Com Baileys, somos nós emitindo 10 mensagens seguidas de um socket
cru** — que é exatamente o padrão que derruba número, e exatamente o que o
`INV-23` existe para impedir.

Portanto, campanha por Baileys tem um pré-requisito, e ele vem antes:

1. **Ligar o `INV-23`**: intervalo mínimo randômico entre dois envios do mesmo
   número, com reserva atômica em `numero_throttle`. É trabalho que vale por si,
   **independente do Baileys** — o PlugZapi também agradece.
2. **Ritmo por socket, não por lote**: com espaçamento real, `LOTE = 10` a cada
   30 s deixa de fazer sentido; o despachante passa a pedir "quantos couberem
   até agora" ao throttle.
3. **Teto próprio do Baileys**, mais conservador que o do PlugZapi na largada —
   a rampa de aquecimento é a mesma máquina, só com outro parâmetro.

⚠️ E o aviso do README do Baileys continua de pé (§9). A decisão de disparar em
lote por ali é uma decisão de risco consciente: se um número for banido, a causa
mais provável é esta, e não a biblioteca.

### 12.3 Prioridade por cliente — uma lacuna que já existe hoje

O ADR-021 diz "o oficial é a **prioridade**", como regra global do produto. Vira
preferência **por tenant**. Duas descobertas ao levantar o impacto:

**A escolha de canal hoje não olha para oficial × não-oficial.** Em
`rotas-conversas.ts`, quando ninguém passa `canalId`:

```sql
SELECT id FROM canal_conectado WHERE tenant_id = tenant_atual() AND arquivado_em IS NULL
 ORDER BY (estado = 'conectado') DESC, criado_em ASC LIMIT 1
```

O critério é *"conectado primeiro, depois o mais antigo"*. Um cliente com número
oficial **e** não-oficial pode ter a conversa saindo pelo não-oficial só porque
ele foi cadastrado antes. Isto é um defeito de hoje, sem relação com Baileys.

**Onde a preferência mora.** `tenant` já tem uma coluna `config jsonb` — **sem
nenhum uso em produção**. Mesmo assim, recomendo **coluna explícita**, não chave
em jsonb: isto decide por qual número a mensagem de um cliente sai, e chave de
jsonb com erro de digitação falha em silêncio.

```sql
ALTER TABLE tenant ADD COLUMN caminho_preferido text NOT NULL DEFAULT 'oficial';
ALTER TABLE tenant ADD CONSTRAINT tenant_caminho_preferido_valido
  CHECK (caminho_preferido IN ('oficial', 'nao_oficial'));
```

Aditiva, um deploy. O `DEFAULT 'oficial'` mantém o ADR-021 como comportamento
padrão — quem não escolher nada continua no caminho recomendado.

A ordenação passa a ser:

```sql
ORDER BY (estado = 'conectado') DESC,
         (tipo = 'whatsapp_oficial') = (SELECT caminho_preferido = 'oficial' FROM tenant …) DESC,
         criado_em ASC
```

⚠️ **Preferência não é permissão.** Se o preferido estiver desconectado, cair no
outro caminho é o comportamento certo — mas a tela precisa **dizer** que caiu,
porque os dois caminhos têm risco e custo diferentes. Degradação silenciosa aqui
é pior que nas outras: o cliente do nosso cliente recebe por um número que a
empresa não escolheu.

E a preferência aparece em três lugares, não um: abertura de conversa,
sugestão de canal na campanha, e a tela de Números (marcando qual é o caminho
padrão daquele cliente).

### 12.4 O plano, revisado

As decisões movem duas coisas: campanha deixa de ser adiada e ganha um
pré-requisito próprio, e a preferência por tenant sai na frente porque **vale
sozinha**.

| Fase | O que | Porta |
|---|---|---|
| **A — Agora, sem Baileys** | `INV-23` ligado (throttle real por número) + `caminho_preferido` por tenant + aviso de queda para o outro caminho | Campanha com espaçamento medido no PlugZapi; preferência respeitada nos três lugares |
| **0 — Spike** | Um socket, número descartável, fora do produto | Sessão sobrevive a 3 deploys e 48 h sem QR novo |
| **1 — Serviço** | `SERVICE_ROLE=whatsapp`, sessão cifrada no Postgres, RPC interno, `CanalBaileys` no catálogo. **Só conversa 1:1** | 30 dias com número real, sem queda não explicada |
| **2 — Campanha** | Disparo por Baileys com teto próprio e ritmo do `INV-23` | Uma campanha real completa sem alerta de qualidade |
| **3 — Frota** | N tenants, reconexão com jitter, alerta por socket, watchdog de dois sinais | Dois tenants convivendo, queda detectada em < 1 min |

⚠️ A **fase A não depende da decisão do Baileys**. Se o estudo parar na fase 1,
ela continua valendo — e é a que protege os números que já estão no ar hoje.
