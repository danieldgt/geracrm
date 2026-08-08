# Manual — os quatro passos que dependem de você

> Executável. Cada passo tem o que fazer, onde clicar, o que copiar e o que dá errado.
> ⚠️ **Os quatro correm em paralelo.** Nenhum espera o outro, exceto o ② que precisa do ① pronto.
> Nada aqui depende de uma linha de código nossa — e tudo aqui bloqueia o projeto.

**Ordem de urgência, se só der para fazer um hoje:** ① (destrava o ②, que é o relógio mais longo).

---

# ① Registrar e verificar o domínio

**Por que primeiro:** o domínio entra na verificação da Meta (②) **e** na política de privacidade
exigida pelo App Review. É pré-requisito de duas coisas ao mesmo tempo.

**Tempo:** 30 minutos de trabalho + até 72h de propagação.

## 1.1 Escolher o nome

Três exigências da Meta que restringem a escolha:

| Exigência | Consequência prática |
|---|---|
| O site tem de ficar **no domínio verificado** | Não adianta verificar `geracrm.com.br` e hospedar o site em outro lugar |
| O e-mail de contato tem de ser **do mesmo domínio** | ⚠️ Gmail corporativo **reprova**. Precisa de `contato@seudominio` |
| O nome legal exibido no site tem de bater com o cartão CNPJ | Byte a byte — ver §2.3 |

Sugestões: `geracrm.com.br` · `usegeracrm.com.br` · `geracrm.app`

⚠️ **Prefira `.com.br`.** A Meta trata domínios brasileiros com CNPJ associado com menos atrito na
verificação do que gTLDs novos.

## 1.2 Registrar

Registro.br (para `.com.br`) ou qualquer registrador internacional. No Registro.br o CNPJ já fica
vinculado ao domínio, o que ajuda na etapa ②.

**Ao registrar, já resolva o e-mail:** qualquer serviço de e-mail no domínio serve — o que importa é
`algo@seudominio` funcionar e ser lido.

## 1.3 Publicar uma página mínima

Não precisa do site final. Precisa de **uma página** que a Meta consiga abrir, contendo:

```
[Nome legal exato do cartão CNPJ]
CNPJ: 00.000.000/0001-00
[Endereço completo, igual ao do comprovante]
contato@seudominio.com.br
```

Mais o link para a política de privacidade (a minuta está em
[`juridico/politica-de-privacidade.md`](./juridico/politica-de-privacidade.md), aguardando revisão).

⚠️ **Uma página estática basta.** O que reprova é não existir, não estar feia.

## 1.4 Verificar o domínio na Meta

1. Acesse **business.facebook.com** → engrenagem de **Configurações do Negócio**
2. Menu lateral: **Segurança da marca e adequação** → **Domínios**
3. **Adicionar** → digite o domínio **sem `www` e sem `https://`** → `geracrm.com.br`
4. Escolha **Registro TXT no DNS** *(recomendado — é permanente; a meta-tag some se o site mudar)*
5. Copie o valor que a Meta mostra, algo como `facebook-domain-verification=a1b2c3...`
6. No painel de DNS do registrador, crie:

   | Campo | Valor |
   |---|---|
   | Tipo | `TXT` |
   | Nome / Host | `@` *(significa a raiz do domínio)* |
   | Valor | `facebook-domain-verification=a1b2c3...` |
   | TTL | o padrão |

7. Espere a propagação e confirme com um verificador de DNS público antes de voltar à Meta
8. Volte à Meta e clique em **Verificar domínio**

⚠️ **Se der erro, espere e tente de novo — não crie um segundo registro.** DNS pode levar até 72h.
Dois registros TXT de verificação confundem a validação.

✅ **Depois de verificado, o registro TXT pode ser removido** sem perder a verificação. Mas não há
motivo para remover.

## 1.5 Checklist do ①

- ☐ Domínio registrado
- ☐ E-mail `@dominio` funcionando e sendo lido
- ☐ Página no ar com nome legal, CNPJ, endereço e e-mail
- ☐ Registro TXT criado
- ☐ Domínio marcado como **Verificado** na Meta

---

# ② Business Manager e Business Verification na Meta

**Por que é o relógio mais longo:** a análise é da Meta, e reprovação recomeça o ciclo.

**Tempo:** 1 hora de trabalho + ~2 dias úteis de análise (pode passar disso).

## 2.1 Criar o Business Manager — M-01

**business.facebook.com** → criar conta de negócio com o **nome legal** da Gera3, e-mail do domínio
(§1.1) e CNPJ.

⚠️ **Se a Gera3 já tem um Business Manager** (para o drezz ou para anúncios), **use o existente**.
Criar um segundo fragmenta ativos e complica a verificação.

## 2.2 Criar o app — M-03

**developers.facebook.com** → **Meus Apps** → **Criar app** → tipo **Empresa/Business** → vincular
ao Business Manager do passo anterior.

Depois, dentro do app, adicione os produtos **WhatsApp** e **Instagram**. Adicionar o Instagram
agora, mesmo que ele só entre na Onda 2/3, evita **dois ciclos de App Review**.

## 2.3 ⚠️ Reunir os documentos ANTES de abrir a verificação — M-04

Este é o passo que mais reprova. Confira **antes** de enviar:

| Documento | Cuidado |
|---|---|
| **Cartão CNPJ** | Emitir na hora, no site da Receita |
| **Contrato social ou estatuto** | Última alteração consolidada |
| **Comprovante de endereço da empresa** | Conta de serviço público recente, **em nome da empresa** |
| **Documento do responsável legal** | De quem consta no contrato social |

### A conferência que evita a reprovação

Coloque lado a lado e compare **caractere por caractere**:

```
Cartão CNPJ ......  GERA 3 TECNOLOGIA LTDA
Business Manager .  GERA 3 TECNOLOGIA LTDA   ← tem de ser idêntico
Site (§1.3) ......  GERA 3 TECNOLOGIA LTDA   ← idêntico também
```

⚠️ **"Gera3 Ltda" contra "GERA 3 TECNOLOGIA LTDA" reprova.** Espaço, abreviação e acento contam.
O mesmo vale para o endereço: o do site precisa bater com o do comprovante.

## 2.4 Enviar

**Configurações do Negócio** → **Central de Segurança** → **Iniciar verificação**. Preencha com os
dados **exatos** dos documentos e anexe.

Depois de enviado, **acompanhe o e-mail do domínio** — é por lá que a Meta pede complemento.

## 2.5 O que vem depois (não é agora, mas saiba a sequência)

```
M-04 Business Verification ──► M-05 Tech Provider Program ──► M-07 App Review
        ~2 dias úteis                dias a semanas             dias a semanas
                                                                      ▲
                          ⚠️ M-07 exige o Embedded Signup FUNCIONANDO
                             em URL pública (≈ semana 5 do nosso lado)
                             e a URL da política de privacidade
```

⚠️ **Por isso o registro começa agora e o App Review não.** Quem tenta submeter o App Review antes
de o fluxo existir é reprovado e recomeça.

## 2.6 Checklist do ②

- ☐ Business Manager com nome legal e CNPJ
- ☐ App criado, tipo Empresa, com WhatsApp **e** Instagram
- ☐ Nome legal idêntico nos três lugares (cartão, BM, site)
- ☐ Documentos conferidos lado a lado
- ☐ Verificação enviada
- ☐ E-mail do domínio sendo monitorado

---

# ③ Documentação e credenciais do GeraCloud

**Por que importa:** bloqueia o **EP-02 inteiro** — conector, carga histórica e RFV. É o coração da
Onda 0.

**Tempo:** enviar o pedido, 10 minutos. A resposta depende do time do ERP.

## 3.1 E-mail pronto para enviar

> **Assunto:** GeraCRM — acesso à API do GeraCloud para integração
>
> Oi,
>
> Estamos iniciando o GeraCRM, que vai se integrar ao GeraCloud para trazer clientes, produtos e
> pedidos, e para registrar pedidos originados no atendimento.
>
> Precisamos de quatro coisas para começar:
>
> **1. Documentação da API**, cobrindo:
> - Clientes — cadastro, telefones, documentos, endereços
> - Produtos e estoque — incluindo grade (cor × tamanho) e referência
> - Pedidos e vendas — histórico, com itens
> - **Consulta de saldo por SKU em tempo real**
> - **Tabela de preço por cliente**
> - **Limite de crédito do cliente**
> - **Criação de pedido** — com o comportamento em caso de reenvio da mesma requisição
>
> **2. Credenciais de homologação**, isoladas das de produção.
>
> **3. Base de teste** com volume parecido com o de um cliente real, ou autorização para usarmos uma
> cópia anonimizada da base de um cliente. A anonimização é feita pelo nosso lado.
>
> **4. Três respostas rápidas:**
> - Existe webhook ou notificação quando uma venda é registrada, ou precisamos consultar
>   periodicamente?
> - Qual o limite de requisições por minuto?
> - A criação de pedido aceita uma chave de idempotência? *(Se a mesma requisição for enviada duas
>   vezes por falha de rede, criam-se dois pedidos ou um?)*
>
> A quarta pergunta é a mais importante: sem idempotência, uma falha de rede no momento errado
> duplica pedido no ERP de um cliente real.
>
> Obrigado.

## 3.2 O que fazer com a resposta

Cada resposta preenche a **declaração de capacidades** do conector (ADR-008). Se faltar saldo em
tempo real ou idempotência, **o produto não quebra** — degrada, e a interface passa a avisar. Mas
precisamos saber **antes** de escrever o adaptador.

---

# ④ Portabilidade dos números que já estão em API oficial

**Por que agora:** pelo ADR-018 a frota é mista. Os números do app comum entram rápido; os que já
estão em API oficial dependem de **liberação do fornecedor atual do cliente** — até 3 semanas.

⚠️ **O relógio é de terceiro e não paraleliza depois.** Abrir isso hoje é o que impede a
portabilidade de virar o gargalo da Onda 1.

## 4.1 Levantar com o cliente — três perguntas

> 1. Quais números estão hoje em **API oficial** (por outro sistema) e quais estão no **app WhatsApp
>    Business** comum?
> 2. No caso dos de API: **qual é o fornecedor** e quem na sua empresa tem acesso de administrador
>    ao Business Manager onde eles estão?
> 3. O Business Manager é **da sua empresa** ou foi criado pelo fornecedor?

⚠️ **A terceira pergunta é a decisiva.** Se o Business Manager for do fornecedor, a portabilidade é
mais lenta e mais dependente da boa vontade dele. Se for do cliente, ele controla o processo.

## 4.2 O que dizer ao cliente

Vale ser transparente, porque isso tranquiliza:

> A portabilidade **preserva o número, o histórico de qualidade, o limite de envio e os templates já
> aprovados**. O número continua sendo seu — inclusive se um dia você quiser levá-lo para outro
> lugar.

## 4.3 Sequência

```
1. Cliente identifica os números e o fornecedor atual
2. Cliente confirma quem é administrador do Business Manager
3. Cliente solicita ao fornecedor a liberação para migração
4. Nós recebemos os números pelo Embedded Signup, quando liberados
```

⚠️ **Enquanto isso, o piloto anda com os números do app comum** (ADR-018). A portabilidade não
bloqueia o primeiro corte.

## 4.4 ⚠️ Antes de conectar um número do app comum

O número precisa ser **removido do app WhatsApp Business** antes de conectar à API. E:

> **As conversas que estão no app não migram.**

A vendedora precisa saber disso **antes**, não no dia. Se houver conversa em andamento que ela
queira preservar, o app exporta conversa individualmente — e essa exportação, aliás, é útil para a
**medição do antes** (ADR-017), porque carrega os horários das mensagens.

---

# Checklist geral

| # | Item | Depende de | Feito |
|---|---|---|---|
| ① | Domínio registrado e verificado na Meta | — | ☐ |
| ① | E-mail no domínio funcionando | Domínio | ☐ |
| ① | Página no ar com nome legal, CNPJ e endereço | Domínio | ☐ |
| ② | Business Manager criado ou identificado | ① | ☐ |
| ② | App criado com WhatsApp e Instagram | ② | ☐ |
| ② | Documentos conferidos lado a lado | — | ☐ |
| ② | Business Verification enviada | ①② | ☐ |
| ③ | E-mail ao time do GeraCloud enviado | — | ☐ |
| ③ | Credenciais de homologação recebidas | ③ | ☐ |
| ④ | Levantamento dos números com o cliente | — | ☐ |
| ④ | Solicitação de portabilidade aberta | ④ | ☐ |

---

# Quando der errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Verificação de domínio falha | DNS não propagou | Esperar até 72h. ⚠️ Não criar um segundo registro TXT |
| Business Verification reprovada | Nome legal divergente | Comparar caractere por caractere com o cartão CNPJ e reenviar |
| Meta pede documento adicional | Normal no processo | Responder pelo e-mail do domínio, com o documento pedido |
| Fornecedor atual não responde sobre portabilidade | Comum — ele está perdendo o cliente | Escalar com o cliente; se o Business Manager for dele, o cliente tem mais força |
| Time do ERP demora | — | O adaptador pode começar com dublê; ⚠️ mas a carga histórica não |

---

## Fontes

- [Verify your domain in Business Manager — Meta Business Help Centre](https://en-gb.facebook.com/business/help/321167023127050)
- [Como verificar sua empresa no Meta — PipeRun](https://ajuda.crmpiperun.com/como-verificar-sua-empresa-no-meta)
- [Verificação da empresa no Facebook Business — Superlógica](https://superlogica-atende.zendesk.com/hc/pt-br/articles/34946676567703-Como-verificar-a-empresa-no-Facebook-Business)
- [Meta Domain Verification Step by Step — Qtonix](https://qtonix.com/blog/how-to-verify-your-domain-in-meta-business-manager-step-by-step-guide/)
- [Verificar Conta WhatsApp Business 2026 — SocialHub](https://www.socialhub.pro/blog/verificar-conta-whatsapp-business-2026-meta-cnpj-recursos-avancados-2/)
