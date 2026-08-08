# Meta — contexto, ciclo de vida do cliente e superfície da plataforma

> Manual de referência da integração com a Meta. Cobre o que precisamos hoje (Ondas 0–1), o que
> virá (2–4) e o que existe na plataforma e ainda não usamos.
> Decisões relacionadas: ADR-002 (Tech Provider), ADR-003 (só API oficial), ADR-014 (corte seco).
> O cronograma do nosso registro está em [`plano-onda-0.md`](./plano-onda-0.md) §1 — não é repetido aqui.

---

## 1. As entidades, e por que confundi-las custa caro

```
Meta Business Manager (do CLIENTE)
 └── WABA — WhatsApp Business Account
      ├── Números (phone numbers)          ← cada vendedora tem um
      ├── Templates (máx. 250 por WABA)    ← compartilhados entre os números da WABA
      └── Método de pagamento              ⚠️ do cliente, não nosso (ADR-002)

Nosso App (developers.facebook.com)
 ├── Tech Provider enrollment
 ├── Embedded Signup (config_id)
 └── Webhook único                          ⚠️ um por app, para TODOS os clientes
```

| Conceito | O que é | ⚠️ Erro comum |
|---|---|---|
| **Business Manager** | Conta de negócio do cliente na Meta | Achar que criamos uma para ele. É dele, e a propriedade importa na saída (§4) |
| **WABA** | Conta WhatsApp Business, contêiner de números e templates | Achar que WABA = número. Uma WABA tem várias |
| **Número** | O que envia e recebe. Tem tier e qualidade **próprios** | Tratar limite como se fosse da conta |
| **Template** | Mensagem aprovada, **por WABA** — não por número | Aprovar por número; são compartilhados, e o teto de 250 é da WABA |
| **App** | Nosso software na Meta | — |
| **Webhook** | **Um endpoint por app**, recebendo eventos de **todos** os clientes | Imaginar um webhook por cliente. O roteamento por tenant é nosso |

⚠️ **O webhook único é a razão de o gateway ser um processo separado** (`stack-arquitetura` §3): um
endpoint recebe o tráfego de toda a base, e um handler lento trava a fila de **todos** os clientes.

### Tech Provider × Solution Partner

| | Tech Provider *(nosso caso)* | Solution Partner |
|---|---|---|
| Linha de crédito da Meta | Não | Sim |
| Quem paga o consumo | **O cliente, direto à Meta** | Nós, e refaturamos |
| Nossa receita | Assinatura | Assinatura + margem por mensagem |
| Risco financeiro | Baixo | Inadimplência é nossa |

---

## 2. Fluxo de ENTRADA de cliente

O que o cliente vê é um assistente de seis passos (`especificacao-telas-entrada.md` §3). O que
acontece por baixo:

```
①  Cliente clica "Conectar WhatsApp"
        ↓
②  Embedded Signup abre em popup da Meta (nosso config_id)
        ↓  ele faz login, escolhe/cria Business Manager, escolhe/cria WABA,
        ↓  informa o número, recebe e digita o código de verificação
        ↓
③  Popup devolve um CODE via postMessage        ⚠️ curta duração, uso único
        ↓
④  Backend troca o code por ACCESS TOKEN        POST /oauth/access_token
        ↓
⑤  Backend descobre o que foi criado            GET /debug_token → waba_id
        ↓                                        GET /{waba}/phone_numbers → phone_number_id
        ↓
⑥  Backend ASSINA o webhook da WABA             POST /{waba}/subscribed_apps
        ↓                                        ⚠️ sem isto nada chega, e o silêncio é mudo
⑦  Backend REGISTRA o número                    POST /{phone_number_id}/register  (PIN 6 dígitos)
        ↓                                        ⚠️ sem isto o número não envia
⑧  Cliente cadastra método de pagamento na conta Meta DELE
        ↓                                        ⚠️ sem isto o envio falha por billing
⑨  Sincronizar templates existentes             GET /{waba}/message_templates
```

### O que gravamos, e onde

| Passo | Gravamos | Tabela |
|---|---|---|
| ④ | Token **cifrado, por tenant** | `canal_conectado.credenciais_cifradas` |
| ⑤ | `waba_id`, `phone_number_id`, telefone E.164 | `numero_whatsapp` |
| ⑥ | Confirmação de assinatura | `canal_conectado.estado` |
| ⑦ | PIN de registro (cifrado — necessário para re-registrar) | `canal_conectado.credenciais_cifradas` |
| ⑧ | `pagamento_ok` | `numero_whatsapp` |
| ⑨ | Catálogo de templates | `template`, `template_versao` |
| todos | Progresso retomável | `onboarding_passo` |

⚠️ **O passo ⑥ é o que mais some.** Trocar o code por token e achar que acabou é o erro clássico:
a conexão parece pronta, o número aparece na tela, e **nenhuma mensagem chega**. Sem assinatura da
WABA, a Meta não tem para onde entregar. O teste de fumaça do onboarding é uma mensagem real
entrando, nunca "o token foi obtido".

⚠️ **O passo ⑧ não é nosso, e é bloqueante.** Como somos Tech Provider, o método de pagamento vive
na conta do cliente. Sem ele o envio falha com erro de billing — e a tela precisa dizer isso, não
"erro ao enviar" (`canal.sem_pagamento_meta`).

### Casos que o assistente precisa tratar

| Situação | O que fazer |
|---|---|
| Cliente fecha o popup no meio | Retomar de `onboarding_passo`. ⚠️ Estado no `localStorage` perde uma conexão que **já existe** do lado da Meta |
| Número já está em outra WABA | É migração, não cadastro — §5 |
| Número já usado no app WhatsApp Business | Precisa ser **deletado do app** antes; a Meta orienta no fluxo |
| Business Verification do cliente pendente | Conecta, mas com limite reduzido. Não bloqueia o onboarding |
| Cliente escolhe WABA existente com 250 templates | Teto atingido — avisar antes de tentar criar |

---

## 3. Fluxo de SAÍDA de cliente

⚠️ **Nenhum documento do projeto tratava disso.** Um cliente sai — por cancelamento, por troca de
fornecedor, por encerramento. O que acontece com o número, os dados e o histórico precisa estar
decidido **antes** do primeiro contrato, não no dia do pedido.

### 3.1 O que é de quem

| Ativo | De quem | Na saída |
|---|---|---|
| **Número de telefone** | **Do cliente** | Ele leva. Migra para outro provedor ou volta para o app |
| **WABA** | **Do cliente** (Business Manager dele) | Permanece dele; só removemos nosso acesso |
| **Templates aprovados** | Da WABA, logo do cliente | Permanecem |
| **Qualidade e tier do número** | Do número | Preservados na migração (§5) |
| **Histórico de conversas** | **Nosso banco** | ⚠️ Precisa ser exportável — §3.3 |
| **Contatos, RFV, pedidos** | Nosso banco, alimentado pelo ERP dele | Idem |
| **Token de acesso** | Nosso | Revogado |

### 3.2 Procedimento de desconexão

```
1. Confirmar com o cliente qual é o destino do número (outro provedor? app? desativar?)
2. Exportar os dados dele (§3.3) e obter aceite do que foi entregue
3. Cancelar a assinatura do webhook:  DELETE /{waba}/subscribed_apps
4. Revogar o token do nosso lado e apagar a credencial cifrada
5. Remover nosso app do Business Manager dele (ele faz, ou orientamos)
6. Encerrar o tenant — sem apagar dado ainda (§3.4)
```

⚠️ **A ordem importa.** Cancelar a assinatura antes de exportar significa perder as mensagens que
chegarem no intervalo. E revogar o token antes de exportar mídia impede baixar os anexos — os
arquivos vivem na Meta e expiram.

⚠️ **Mídia expira.** Anexos que só existem como referência da Meta **não são recuperáveis depois**.
Se a política for guardar a mídia em nosso object storage (é o que `INB-02` prevê), isso precisa
estar valendo desde o dia 1 — não dá para "baixar tudo" na saída.

### 3.3 O que o cliente leva

| Dado | Formato | Prazo |
|---|---|---|
| Contatos com campos personalizados | CSV | No ato |
| Histórico de conversas e mensagens | CSV ou JSON por conversa | Assíncrono (volume) |
| Mídia | Arquivos, em pacote | Assíncrono |
| Pedidos e vendas | CSV — ⚠️ mas a fonte é o ERP dele, que ele já tem | No ato |
| Campanhas e resultados | CSV | No ato |

Isto é **direito do titular sob LGPD** e não deve depender de negociação. Vira requisito
(`CTT-15`) e precisa de rota na API.

### 3.4 Retenção depois da saída

Decisão a tomar com o jurídico, registrada aqui como pendência: por quanto tempo mantemos o dado
após o encerramento (para reativação e para obrigação legal), e o que é apagado imediatamente.
⚠️ Apagar na hora impede reativar um cliente que voltou em duas semanas; guardar para sempre é
passivo de LGPD.

---

## 4. Migração de número entre WABAs

O caso mais provável de entrada de cliente **grande**: ele já usa WhatsApp API com outro fornecedor.

**O que a migração preserva:** nome de exibição, **qualidade**, **limite de mensagens**, status de
Official Business Account, e os templates aprovados — desde que caibam no teto de 250 da WABA de
destino.

**Como funciona hoje:** migrações entre provedores diferentes podem ser feitas **pelo próprio
Embedded Signup**, o que simplifica muito em relação ao processo antigo. Exige nosso enrollment no
Tech Provider Program concluído.

⚠️ **Isto pode ser o caminho crítico real** (risco M-13 do plano): se o cliente piloto já opera com
outro fornecedor, o onboarding dele não é "conectar", é "migrar" — e migração tem passos e riscos
próprios, incluindo janela de indisponibilidade.

⚠️ **Migrar de volta também é possível**, e isso é argumento de venda honesto: o cliente não fica
preso porque o número é dele.

---

## 5. Limites, qualidade e o que mudou em 2026

### Tiers de mensagens iniciadas pelo negócio (por número, por 24h)

| Tier | Conversas únicas iniciadas |
|---|---|
| 1 (novo) | 1.000 |
| 2 | 10.000 |
| 3 | 100.000 |

**Mudança de 2026:** ao concluir a Business Verification, o número passa a receber **limite de 100
mil** diretamente, com implantação começando por parceiros selecionados e remoção progressiva dos
degraus.

⚠️ **A consequência é estratégica:** o gargalo deixa de ser o *tier* e passa a ser **qualidade de
entrega e ritmo de envio**. Nosso módulo de campanha foi desenhado com throttling por número
(INV-23) — continua certo, mas o motivo muda: não é mais "não estourar o limite", é "não degradar a
qualidade".

### Qualidade

Calculada por **bloqueios e denúncias** dos destinatários. Ela governa a progressão de tier e, se
cair demais, o número é restringido.

⚠️ É por isso que `CAN-06` (pausa automática de disparo em número em risco) existe. Perder um número
é perder a operação de uma vendedora — e a qualidade cai **antes** de a Meta restringir, o que dá
janela para agir.

### Pacing de campanha

A Meta **envia campanhas grandes em lotes**, observa o retorno dos primeiros e só então libera o
restante. Se os sinais indicarem problema, **o resto pode não ser enviado**.

⚠️ **Isto muda o relatório de campanha** (`CMP-10`): "enviados < contatos" pode não ser falha nossa
nem erro de número — pode ser a Meta retendo. O relatório precisa distinguir *falha* de *retido*,
senão a vendedora conclui que o produto está quebrado.

---

## 6. ⚠️ Usernames e BSUID — a mudança que afeta o modelo

**O WhatsApp está introduzindo nomes de usuário**, com o telefone podendo ficar oculto por padrão.
Para os negócios, o identificador que chega no webhook passa a ser o **BSUID** (*business-scoped
user ID*) — **único por negócio**: o mesmo consumidor tem BSUIDs diferentes em empresas diferentes.
A implantação começa por países de teste em 2026 e se expande gradualmente.

**Por que isto é sério para nós:** a identidade do contato no nosso modelo é o **telefone
normalizado** (INV-07/49/50). Todo o cruzamento com o ERP, a lista de bloqueio e a reconciliação
multi-ERP dependem dele.

**O que precisa acontecer, e é barato agora:**

| Ação | Onde |
|---|---|
| Guardar `bsuid` como identidade externa de primeira classe, ao lado do telefone | `contato_identidade_externa` — a tabela **já existe** e já é genérica |
| Aceitar contato **sem telefone** — hoje há premissa implícita do contrário | `modelo-de-dados` §6, regras de reconciliação |
| Chave de bloqueio por BSUID, além da chave reduzida de telefone | INV-50 |
| A tela de contato não pode assumir que existe telefone para exibir | `especificacao-telas` §0.3 |

⚠️ **Não é urgente, é irreversível.** Enquanto for opcional, adaptar é barato. Depois que a base
tiver contatos sem telefone, converter é migração de dados com ambiguidade. A tabela genérica de
identidade externa já nos protege — falta remover a **premissa** de que telefone sempre existe.

---

## 7. Superfície da plataforma — o que usamos e o que existe

| Recurso | Onda | Situação |
|---|---|---|
| Envio e recebimento de texto, mídia, áudio, documento, localização | 0–1 | Planejado |
| **Templates** — criar, submeter, consultar status, enviar | 0 | `D-11b`, `E3-15` |
| Webhooks: mensagem, status de entrega, qualidade, template | 0 | `E3-04…E3-08` |
| Registro e verificação de número | 0 | `E3-01` |
| Métricas de conversa e **custo por mensagem** | 0 | `E3-12` |
| Botões de resposta rápida e listas | 3 | Previsto (`INB-20`) |
| **Instagram Direct** | 2–3 | Mesma Graph API; ⚠️ sem disparo em massa, sem template |
| **WhatsApp Flows** — formulários nativos | 4 | O Tailor já tem; nós não |
| Catálogo e carrinho no WhatsApp | — | ⚠️ Fora de escopo: conflita com o ERP e com a decisão de não fazer loja |
| Pagamentos no WhatsApp (Brasil) | — | Avaliar quando `PED-12` amadurecer |
| Chamadas de voz pela API | — | Não avaliado |
| Blocos de bem-vinda e anúncios click-to-WhatsApp | 3 | Entram com campanhas |

---

## 8. Armadilhas, em ordem de frequência

| # | Armadilha | Consequência |
|---|---|---|
| 1 | Não assinar o webhook da WABA (passo ⑥) | Conexão "pronta" e **nada chega** |
| 2 | Handler de webhook lento ou não idempotente | Reenvio em laço; ⚠️ com entrega sequencial, trava a fila de **todos** os clientes |
| 3 | Responder erro a falha permanente (401/403/404) | Idem — responder `200` e registrar |
| 4 | Tratar limite como se fosse da conta | Estouro em um número enquanto outros estão ociosos |
| 5 | Aprovar template por número | Templates são da **WABA**; teto de 250 |
| 6 | Categoria errada de template | Rejeição, ou cobrança de marketing onde caberia utility |
| 7 | Achar que a janela de 24h é por conversa em nosso banco | É da Meta, por número e contato — e nasce **fechada** |
| 8 | Confiar que a mídia estará lá depois | Expira. Guardar em object storage desde o dia 1 |
| 9 | Nome legal divergente do cartão CNPJ na verificação | Reprovação com recomeço do ciclo |
| 10 | Deixar o registro na Meta para depois do código | App Review exige o fluxo **funcionando em URL pública** |

---

## 9. Pendências desta área

| # | Pendência | Prazo |
|---|---|---|
| 1 | 🔴 Iniciar o registro (M-01…M-04) | **Imediato** — semanas de espera de terceiro |
| 2 | Descobrir se o cliente piloto **já usa** API com outro fornecedor (define entrada vs. migração) | Levantamento prévio |
| 3 | Remover a premissa de "todo contato tem telefone" (§6) | Antes de fechar as migrations de contato |
| 4 | Política de retenção pós-saída, com jurídico | Antes do primeiro contrato |
| 5 | Rota de exportação para saída de cliente (`CTT-15`) | Onda 1 |
| 6 | Distinguir *falha* de *retido pela Meta* no relatório de campanha | Onda 3 |

---

## Fontes

- [Business phone numbers — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)
- [Messaging Limits — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)
- [Embedded Signup — onboarding business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
- [Official Business Accounts — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/official-business-accounts/)
- [WhatsApp API 2026 Updates: pacing, 100K limits, usernames — Woztell](https://woztell.com/whatsapp-api-2026-updates-pacing-limits-usernames/)
- [WhatsApp 2026 Updates: Pacing, Limits & Usernames — Sanuker](https://sanuker.com/whatsapp-api-2026_updates-pacing-limits-usernames/)
- [Migrating WhatsApp Business from another provider — Bird](https://docs.bird.com/connectivity-platform/account/migrating-whatsapp-business-from-another-provider-bsp)
- [Migrations — 360dialog](https://docs.360dialog.com/docs/hub/migrations)
