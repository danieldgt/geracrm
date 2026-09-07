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
depois que um número real sobreviver 30 dias. Recomendo **não** ligar campanha
por este caminho na primeira fase — a razão está em "Riscos".

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
