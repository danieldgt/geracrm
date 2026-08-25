# Automações — motor de gatilhos

> Decisão de arquitetura tomada com o dono do produto em 2026-08-10.
> Implementação: `apps/api/src/contexts/crm/automacao-motor.ts`,
> `rotas-automacao.ts`, migration `0046_automacao.sql`.

Uma automação é uma regra **gatilho → ação**: "quando um cliente casar esta
condição, faça isto". O objetivo é tirar da cabeça do vendedor o trabalho de
lembrar quem precisa de atenção.

## As três decisões que estruturam tudo

### 1. Motor: varredura AGENDADA (não dirigido por evento)

Um job periódico (a cada 5 min, `server.ts`) varre a base e age sobre quem casa
a condição **agora**. Não reage a eventos em tempo real.

```
a cada 5 min (como DONO, com advisory lock):
  para cada tenant com automação ativa:
    para cada regra ativa:
      contatos que casam a condição
        E ainda não foram atendidos por esta regra
        → executa a ação, registra a execução
```

**Por quê:** recompra e retenção são intrinsecamente **por tempo** ("está há 60
dias sem comprar"), então a varredura é o modelo natural — determinística,
testável, sem barramento de eventos para manter. A latência do ciclo (minutos)
é irrelevante para esse tipo de gatilho.

⚠️ Roda como **DONO** (worker), sem tenant de sessão: o isolamento vem do
`tenant_id` explícito em cada query — igual ao dispatcher de webhooks e ao
integrador. Por isso lê `mv_metricas_contato` **cru** (a view `metricas_contato`
filtra por `tenant_atual()` e é para o papel da API).

Guardado por `pg_try_advisory_lock('automacao_varredura')` — várias instâncias
não varrem em dobro.

### 2. Ações

| Ação | O que faz | Reusa |
|---|---|---|
| `criar_tarefa` | Cria uma tarefa para o dono da carteira (ou sem dono) | `tarefa` (0039) |
| `aplicar_sequencia` | Materializa as tarefas dos passos da sequência (D+N) | `sequencia` (0044) |
| `adicionar_lista` | Põe o contato numa lista/público | `lista` (0041) |
| ⚠️ `enviar_mensagem` | **Fala com o cliente** — pelo gateway único | `envio-conversa` (E5-13), `0065` |

**A política mudou em 2026-08-25.** Até a `0065`, automação só organizava
trabalho HUMANO: o vendedor era quem falava com o cliente. Enviar sozinho carrega
risco real (opt-out, janela de 24h, banimento no não-oficial), e a ação ficou
para "uma segunda etapa, atrás dos guardrails do gateway".

⚠️ **O que mudou não foi o risco — foi a existência dos guardrails.** Hoje o
gateway único revalida opt-out, estado do canal, credencial, janela de 24h e a
pausa de disparo (CAN-06). A automação **não tem caminho próprio de envio**: ela
usa o mesmo `enviarTextoNaConversa` que o resto do produto.

E ela ainda respeita mais três coisas:

| Guardrail | Por quê |
|---|---|
| ⚠️ `contato.recebe_automacoes` | Opt-out **diferente** da lista de bloqueio: é o cliente dizendo "pode me mandar campanha, mas não robô". Filtrado **antes do dedup** — quem não recebe hoje continua elegível se mudar de ideia amanhã |
| ⚠️ **Sem conversa aberta, não inventa uma** | Abrir conversa para falar primeiro é mensagem fria: no oficial exige template aprovado, no não-oficial é o caminho mais curto para o banimento (ADR-021). Degrada para **tarefa**, com o motivo e o texto que sairia |
| ⚠️ Envio **fora** da transação | Rede não segura transação aberta. E se o processo cair entre o commit e o envio, a mensagem **não sai** — melhor do que a ordem inversa, em que ela sairia duas vezes |

O texto aceita `{nome}`, e o marcador **some limpo** quando o contato não tem
nome: sem o espaço órfão nem a vírgula pendurada que denunciam o modelo.

⚠️ A mensagem sai **sem cabeçalho de atendente**: ela é da empresa, não de uma
pessoa. Assinar com o nome de alguém que não escreveu seria mentir na assinatura.

### 3. Gatilhos do primeiro corte

| Gatilho | Casa quando | Parâmetro |
|---|---|---|
| `rfv_segmento` | O contato está hoje no segmento RFV alvo | `{ segmento: 'em-risco' }` |
| `dias_sem_comprar` | Comprou, mas passou de X dias sem comprar | `{ dias: 60 }` |
| `lead_frio` | Nunca comprou e foi cadastrado há mais de X dias | `{ dias: 30 }` |
| `nps_detrator` | Deu nota ≤ N no NPS na janela recente | `{ notaMax: 6, janelaDias: 30 }` |

A régua RFV é a **mesma** `classificarRfv` de `@geracrm/shared` — a automação não
reinventa fronteira de segmento.

## Dedup: cada regra age no mesmo contato UMA vez

`automacao_execucao (tenant_id, automacao_id, contato_id)` registra o que já foi
feito. Sem isso, toda varredura recriaria a tarefa/adição para quem ainda casa a
condição. A ação e o registro acontecem na **mesma transação**: ou os dois, ou
nenhum.

⚠️ **Limitação v1 (consciente):** a regra **não re-dispara** se o cliente sair e
voltar à condição (ex.: comprou, atrasou de novo). Para "cadência recorrente"
seria preciso janelar o dedup por período — está fora deste corte.

## Rodar agora

`POST /v1/automacoes/executar` roda a varredura para o tenant do token na hora
(sem esperar o ciclo). Útil para testar uma regra recém-criada. Motor em modo
dono, isolado pelo `tenant_id` do token.

## Como isto se encaixa

- **Sequências** dá o "o que fazer" (o playbook de toques).
- **Automações** dá o "quando disparar sozinho" (o gatilho + a ação).
- Juntos: "quando o cliente virar Em Risco, aplique a sequência de reativação".

## O que viria depois (não implementado)

- Ação de **enviar WhatsApp/template** (com os guardrails do gateway).
- Gatilhos **dirigidos por evento** (mensagem recebida → auto-resposta), num
  modelo híbrido — o agendado cobre tempo/estado, o evento cobre o imediato.
- Dedup **janelado** para cadências recorrentes.
- **Mover no funil** como ação (precisa do contexto de oportunidade).
