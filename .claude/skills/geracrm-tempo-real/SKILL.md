---
name: geracrm-tempo-real
description: >
  Implementar e depurar o push server→client do GeraCRM: SSE, outbox pós-commit, LISTEN/NOTIFY,
  nomenclatura e autorização de canais, payload mínimo, reconexão com cursor de versão, presence e
  revogação de permissão. Usar sempre que um evento precisar chegar à tela sem ação do usuário, ao
  criar canal novo, ou ao investigar evento perdido, duplicado ou entregue a quem não devia.
---

# Tempo real — SSE, outbox e isolamento

Decisão no ADR-007. **Esta é a área de maior risco de segurança do produto**: um erro aqui entrega
conversa de uma empresa para outra. Todas as regras marcadas com ⚠️ existem para impedir isso.

## O caminho de um evento

```
webhook/ação → transação → OUTBOX (mesmo commit) → worker → NOTIFY → SSE → aba
```

⚠️ **O evento nasce no outbox, na mesma transação do dado.** Publicar fora dela permite evento de
transação que não commitou — o cliente recebe aviso de uma mensagem que não existe.

## Nomenclatura de canal

```
tenant:{T}:numero:{N}      eventos do número — nova conversa, mensagem, status
tenant:{T}:conversa:{C}    eventos de uma conversa aberta na tela
tenant:{T}:usuario:{U}     pessoais — tarefa, menção, atribuição, invalidação de permissão
tenant:{T}:campanha:{K}    progresso de disparo
```

⚠️ **O nome do canal é montado por UMA função, que não aceita montar canal sem tenant.** Não é
convenção — é uma função que torna o erro impossível. Canal sem prefixo de tenant é o vetor de
vazamento nº 1: com IDs sequenciais, basta um canal `conversa:{C}` solto para alguém receber evento
de outra empresa.

## Autorização

```
1. Usuário autentica          → sessão normal (Cognito)
2. Cliente pede token de push → API emite token curto (5–15 min) com { tenantId, userId }
                                 ⚠️ o token NÃO carrega lista de canais permitidos
3. Cliente pede um canal      → servidor valida ANTES de assinar:
                                   • o canal pertence ao tenant do token?
                                   • o usuário tem permissão neste número?
                                   • o número pertence a este tenant?
                                   • a conversa pertence a este número?
4. Só então                   → subscrição efetivada
```

⚠️ **Validação por subscrição, não só no login.** Permissão muda durante a sessão: vendedora sai de
um número, carteira é transferida, usuário é desativado. Autorizar só na entrada deixa uma sessão
privilegiada aberta até o logout.

## Payload mínimo — a defesa em profundidade

```json
{ "tipo": "mensagem.recebida", "conversaId": "…", "numeroId": "…", "versao": 8412 }
```

⚠️ **O evento nunca carrega conteúdo.** O cliente recebe o aviso e busca o conteúdo pela API
autenticada, que passa por RLS.

**Por que isso vale o round-trip extra:** se o fan-out errar o alvo, o intruso recebe um ID que não
consegue resolver. É a diferença entre um bug e um incidente. E a maior parte dos eventos só
atualiza contador, sem precisar do conteúdo.

Efeito colateral bom: o payload de 80 bytes torna irrelevante o limite de 8 KB do `NOTIFY`.

## Reconexão

- O cliente guarda a **última versão recebida**; ao reconectar, busca o **delta pela API**.
- ⚠️ **Não confiar em histórico de broker** para recuperar evento perdido. O cursor no cliente é
  mais simples, mais barato e sobrevive a troca de infraestrutura.
- Backoff exponencial com teto.
- **Estado da conexão é visível na tela**: conectado / reconectando / offline. ⚠️ Silêncio é pior
  que aviso — a vendedora precisa saber que parou de receber.

## Revogação

| Situação | Tratamento |
|---|---|
| Permissão mudou | Publica `permissao.alterada` no canal do usuário → cliente descarta o token e re-autoriza |
| Token expirou | Renovação silenciosa; se falhar, estado degradado com aviso, nunca tela branca |
| Usuário desativado | Assinaturas encerradas no servidor, não só no cliente |

## Presence

Heartbeat por POST a cada N segundos, gravado com TTL lógico e limpeza periódica. Sem conexão
bidirecional e sem componente novo. Atende o aviso de colisão (INB-18) com precisão de segundos —
suficiente para "Eduarda está nesta conversa".

## Por que SSE e não WebSocket

O envio de mensagem vai por POST — a metade bidirecional do WebSocket sobraria. SSE reconecta
nativamente, passa por proxy corporativo, e o limite de 6 conexões por domínio só existe em
HTTP/1.1 (some com HTTP/2).

⚠️ **Não introduza WebSocket nem STOMP.** STOMP é padrão de backend Java/Spring com broker; nosso
backend é Fastify e não há broker. Adotá-lo seria adicionar protocolo e infraestrutura sem ganho.

## Sem polling de fundo

Antipadrão medido no GeraCloud, onde polling permanente dominava o tráfego. Exceção consciente só
com painel aberto, parando no primeiro estado final e desistindo por tempo — como o ADR-011 do
drezz faz na cobrança presencial.

## Testes obrigatórios

```
□ usuário do tenant A pedindo canal do tenant B → recusado
□ usuário sem permissão no número → recusado
□ permissão revogada durante a sessão → evento não entregue
□ payload publicado não contém conteúdo de mensagem
□ evento de transação revertida não é publicado
□ reconexão com cursor recupera o delta sem duplicar
```

⚠️ O teste de payload é o de defesa em profundidade: se alguém passar a incluir conteúdo, erro de
fan-out deixa de ser bug e vira incidente.

## Depuração

| Sintoma | Onde olhar |
|---|---|
| Evento não chega | Outbox processado? `NOTIFY` emitido? Assinatura ativa? |
| Evento chega duplicado | Handler de webhook não idempotente, ou outbox reprocessado sem controle |
| Evento chega para quem não devia | ⚠️ **Incidente** — canal sem tenant ou autorização não revalidada |
| Conexões acumulando | Cliente sem cancelamento ao trocar de tela (`takeUntilDestroyed`) |
| Tela desatualizada sem erro | Reconectou e não buscou o delta |

## Escala

Ordem de grandeza atual: uma vendedora com a tela aberta = 1 conexão; 100 clientes × 20 vendedoras
≈ 2.000 simultâneas — confortável para poucas instâncias. **Gatilho de migração** para broker
dedicado (Centrifugo) na §12 de `docs/stack-arquitetura.md`. O modelo de canais aqui já é
compatível: a migração não muda o cliente.
