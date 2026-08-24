# Conectar um número de WhatsApp — o fluxo, revisado

> Desenho de 2026-08-24, depois de um incidente real: o número caiu, o produto não
> avisou, e **não havia como reconectar pela interface**. A revisão vai além do
> conserto pontual — o fluxo inteiro estava errado de premissa.

## O erro de premissa

Hoje a tela "Meus Números" pede ao cliente **instância, token e client-token** do
PlugZapi. Isso assume que **o cliente tem contrato com o fornecedor**.

⚠️ **Ele não tem, e não deve ter.** O contrato com o PlugZapi é da **Gera3**. O
cliente final não deveria nem saber que o PlugZapi existe — para ele, o produto
conecta o WhatsApp dele, ponto.

Vazar infraestrutura para a tela do cliente cobra caro em três frentes:

| Custo | Por quê |
|---|---|
| **Onboarding** | Pedir três credenciais que ele não tem trava a ativação |
| **Suporte** | Toda dúvida vira "onde eu pego esse token?" |
| ⚠️ **Segurança** | Credencial de instância no formulário do cliente é credencial que circula por chat, print e e-mail |

## O modelo correto: dois níveis

```
┌─ NÍVEL PLATAFORMA — staff Gera3, uma vez ────────────────────┐
│  Token de INTEGRADOR do PlugZapi                             │
│  ⚠️ variável de ambiente, nunca por tenant                    │
│  É a conta da Gera3 com o fornecedor.                        │
└──────────────────────────────────────────────────────────────┘
                            │  provisiona sob demanda
                            ▼
┌─ NÍVEL TENANT — o cliente, por número ───────────────────────┐
│  1. "Adicionar número"  →  só digita um NOME ("Vendas")      │
│  2. o sistema cria a instância e configura os webhooks       │
│  3. o QR aparece na tela                                     │
│  4. ele escaneia no celular  →  conectado                    │
│  ⚠️ Ele nunca vê instância, token ou client-token.            │
└──────────────────────────────────────────────────────────────┘
```

É a **mesma assimetria** já decidida para o Google Ads (`agencia-mkt/implementacao.md`
§14): credencial da plataforma vive em variável de ambiente; o que varia por
cliente é só o recurso provisionado.

⚠️ **E é diferente do canal oficial da Meta**, onde o cliente **traz o próprio App
e a própria WABA** (`onboarding-meta.md`) — ali o contrato é dele mesmo. Os dois
modelos convivem, e a tela precisa deixar claro qual é qual.

## O que a API do fornecedor permite

`POST https://api.plugzapi.com.br/instances/integrator/on-demand`

| Campo | Uso |
|---|---|
| `name` | nome da instância — usamos `tenant · número` |
| `receivedCallbackUrl` | ⚠️ **o webhook se configura sozinho**, sem ninguém colar URL |
| `disconnectedCallbackUrl` | ⚠️ **o fornecedor nos avisa quando a sessão cai** |
| `deliveryCallbackUrl`, `messageStatusCallbackUrl` | tiques de entrega |

Resposta `201`: `{ id, token, due }`.

⚠️ **`disconnectedCallbackUrl` é o achado que mais importa.** Meu vigia pergunta
de 5 em 5 minutos; com o callback, a notícia chega em segundos. **Os dois
convivem**: o callback é rápido, a varredura é a rede de segurança para quando o
callback não chega — e "não chegou" é indistinguível de "está tudo bem" sem ela.

⚠️ **Instância nasce com 2 dias de teste** e é apagada se não for assinada. Isso
precisa aparecer no produto: número provisionado e não pago **some**, e descobrir
isso pelo silêncio seria repetir o incidente.

## Os problemas de UX que o incidente expôs

### 1. ⚠️ Sessão expirada vira "tela quebrada"

`POST /v1/auth/refresh` devolveu 400 e **tudo** passou a responder 401. A tela não
carregou — e o sintoma pareceu defeito da página.

**Correção:** interceptador de 401 que **manda para o login**. Falha de sessão é um
estado nomeado, não um carregamento infinito.

### 2. ⚠️ O botão de reconectar só aparecia se o sistema já soubesse que caiu

Circular: quem está com o WhatsApp fora do ar depende de o produto ter descoberto
antes de poder consertar.

**Correção:** no não-oficial, **reconectar está sempre disponível**. O QR é a ação
de recuperação — e ação de recuperação não pode depender do diagnóstico.

### 3. ⚠️ O estado exibido era velho

`canal_conectado.estado` só era atualizado quando alguém tentava enviar. O painel
dizia "Conectado" com o número fora do ar há horas.

**Correção:** vigia periódico (feito) + callback de desconexão (a fazer) + a tela
mostrando **quando** o estado foi verificado, não só qual é.

⚠️ "Conectado" sem carimbo de hora é uma afirmação sem prazo de validade.

## O fluxo desenhado

### Adicionar número (cliente)

```
[+ Adicionar número]
      │
      ▼
  Nome do número: "Vendas"          ← só isto
      │
      ▼
  provisionando…                    ← cria instância + webhooks
      │
      ▼
  ┌──────────────────┐
  │   [QR code]      │   No celular deste número:
  │                  │   WhatsApp → Aparelhos conectados
  │                  │   → Conectar aparelho
  └──────────────────┘
  ⏱ expira em segundos · [Gerar outro]
      │
      ▼
  ✅ Conectado — verificado agora
```

⚠️ **A tela deve detectar sozinha a conexão** (consulta a cada poucos segundos
enquanto o QR está aberto) e trocar para o estado conectado. Fazer o usuário
clicar em "testar" depois de escanear é obrigá-lo a confirmar algo que o sistema
já sabe.

### Reconectar (cliente)

Mesmo QR, a partir do card do número. **Sempre disponível** no não-oficial.

### Cadastro manual (staff)

⚠️ Continua existindo, escondido atrás de "opções avançadas": é o caminho para
número que já tem instância — e para o dia em que o provisionamento automático
falhar. **Remover a saída manual deixaria o produto refém de uma API de terceiro.**

## ✅ Decidido com o dono do produto (2026-08-24)

| Pendência | Decisão |
|---|---|
| Token de integrador do PlugZapi | ⚠️ **Não temos.** Staff da Gera3 cria a instância **no painel** e cadastra; o cliente só escaneia o QR |
| Assinatura da instância | **Gera3 assina ao provisionar** — o número nasce pago e não some no fim do teste |
| Ordem de implementação | **Correções de UX primeiro** |
| Canal do resumo diário | **Webhook de saída** (`0033`) — já existe, assinado, com retry; não gasta número nem aquecimento |

⚠️ **Consequência do provisionamento manual:** os campos de instância e token
continuam no formulário, mas passam a ser **área do staff**, não do cliente. E o
`disconnectedCallbackUrl` — que daria aviso em segundos — **fica de fora por
enquanto**, porque é configurado na criação por API. A varredura de 5 minutos
segue sendo a única detecção.

## ✅ Feito em 2026-08-24 (tarde) — a área da equipe

A tela de Números separou os dois modelos, que antes dividiam o mesmo formulário:

| Canal | Quem é dono da credencial | O que a tela mostra |
|---|---|---|
| **Oficial (Meta)** | ⚠️ o **cliente** — App e WABA são dele (`onboarding-meta.md`) | os campos, no fluxo principal |
| **Não-oficial (PlugZapi)** | ⚠️ a **Drezz** — é o nosso contrato com o fornecedor | um nome, e o QR. A credencial fica em **"Opções avançadas — equipe Drezz"**, fechada |

⚠️ **É fronteira de UX, não de autorização.** O bloco fecha por padrão e avisa que
o dado é da Drezz; ele não impede ninguém de abrir. Uma trava de verdade exigiria
o papel do usuário exposto pela API e checagem no servidor — e hoje `POST
/v1/canais` aceita credencial de qualquer usuário autenticado do tenant. Fica
registrado como está, em vez de parecer o que não é.

⚠️ **A área abre sozinha quando o servidor recusa um campo de credencial.** Erro
apontando para campo escondido é erro invisível: "confira os campos destacados"
sem campo destacado na tela.

## O que fica decidido

1. Token de integrador em **variável de ambiente**, nível plataforma.
2. Provisionamento **sob demanda**, disparado pelo cliente, sem ele ver credencial.
3. Webhooks configurados **no ato da criação** — ninguém cola URL.
4. **Callback de desconexão** como detecção primária; varredura como rede.
5. Reconectar por QR **sempre disponível** no não-oficial.
6. 401 **redireciona ao login**, em vez de tela pela metade.
7. Estado exibido **com carimbo de verificação**.
8. Cadastro manual preservado, como saída.

## O que isto NÃO resolve

⚠️ **A instância continua sendo um WhatsApp Web automatizado.** Provisionar por
API deixa o onboarding suave, e não muda o risco do ADR-021: a sessão cai, e pode
haver banimento. O que muda é que agora o produto **percebe e oferece o conserto**
— não que o problema deixou de existir.
