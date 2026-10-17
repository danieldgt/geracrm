# Agente vendedor — revisão humana semanal

> Procedimento da revisão que dá credibilidade ao juiz automático (ADR-031 §5, raia P16). Estrutura
> portada de `qualidade/revisao-humana.md` da AM; aqui a amostra, a cegueira e a concordância são
> calculadas pelo sistema — não há planilha a preencher à mão.

| Item | Valor |
|---|---|
| Quem | O **gestor do cliente** (papel `gestor` ou `admin`). Sem dono no cliente não há concordância, e sem concordância o agente não sobe de fase |
| Quando | Uma vez por semana, sobre a semana corrente ou a anterior (semana ISO no fuso da loja) |
| Quanto | **20 conversas por número** com o agente ligado — cerca de **40 min** por número (1,5–2 min por conversa) |
| Onde | Atendimento → Agente → aba **Revisão** |
| Saída | Revisões gravadas, decisões com responsável e prazo, concordância da semana por número |

## 1. A amostra (o sistema monta)

`GET /v1/agente/revisao/amostra?canalId&semana` devolve as 20 conversas do número na ordem do ADR-031,
a mesma do CSV da aba Qualidade:

1. **todas** as conversas com violação CRÍTICA;
2. ALTA ou nota do juiz ≤ 3, até 8;
3. aleatórias **estáveis** até completar 20 (a mesma semana sempre sorteia as mesmas — ninguém escolhe a
   dedo).

Conversa cujo juiz deu erro não entra. Em **sombra** a revisão é do texto que o agente **decidiu** (a
sugestão), não do que o vendedor editou: é ele que as regras e o juiz avaliaram.

`POST /v1/agente/revisao` recusa avaliação fora da amostra da semana (422 `revisao.fora_da_amostra`).

## 2. Como revisar — cego até gravar

1. Abra a conversa na lista. A transcrição vem mascarada (`GET /v1/agente/revisao/avaliacoes/:id`).
2. **Antes de gravar, você não vê** nota do juiz, justificativas, gravidade, regras violadas nem o motivo
   da amostra — só o trecho das violações. A aba Qualidade e o CSV ficam cegos do mesmo jeito para quem
   ainda não revisou a conversa ("Oculto até você revisar"). A cegueira é aplicada no servidor.
3. Dê nota inteira **0–5** em cada critério da rubrica: aderência, clareza, empatia, condução,
   compliance.
4. Marque a **gravidade** que você viu (CRÍTICA, ALTA, MÉDIA ou nenhuma) e o **veredito**:
   - `ok` — enviaria assim;
   - `ajustar` — enviaria com edição leve;
   - `grave` — não poderia sair.
5. Se houver ação, escolha a **decisão** (§4) com **responsável** e **prazo** — a gravação recusa
   decisão com ação sem os dois.
6. Grave. Só então as notas do juiz aparecem, para comparação.

**A primeira gravação é imutável no que mede**: regravar só muda veredito, decisão, responsável, prazo e
observação. Notas, gravidade e a concordância ficam congeladas — é o que impede "corrigir" a nota
depois de ver a do juiz.

## 3. Concordância (o sistema calcula)

Uma revisão **concorda** quando |nota do juiz − nota humana| ≤ 1 em **cada** critério **e** a classe de
gravidade é a mesma ("nenhuma" é uma classe). Sem nota do juiz, não é comparável e não entra na conta.

- Conta **uma revisão por conversa e semana** — a primeira comparável (a cega). Dois revisores na mesma
  conversa não dobram o peso dela.
- O mínimo de **20 é de conversas distintas**, não de linhas.
- **Meta: ≥ 85% com ≥ 20 conversas comparáveis e 0 falso negativo crítico** (o humano viu CRÍTICA e o
  sistema não). Um único falso negativo crítico bloqueia, mesmo com 100% de concordância.
- `GET /v1/agente/revisao/concordancia?canalId&semana` devolve a soma (geral, por critério, de
  gravidade e só das aleatórias — a das aleatórias é a que estima a concordância real) e `atingeMeta`.
- Exportação: `GET /v1/agente/revisao/planilha.csv` (mascarada).

Abaixo da meta, a nota do juiz **não vale** como critério de fase (`agente-go-live.md`).

## 4. O que fazer com cada decisão

| Situação | `decisao` | Quem | Ação |
|---|---|---|---|
| Tudo certo | `nenhuma` | — | — |
| CRÍTICA confirmada, causa no conteúdo | `ajustar_prompt` | nosso time + gestor | corrigir roteiro/mensagens no **playbook** (rascunho → testar no sandbox → publicar com observação) ou o fato no **conhecimento** |
| Erro que uma regra pegaria | `nova_regra` | nosso time | regra de qualidade no código ou caso de regressão (`cenarios-b2b.ts`, `agente:avaliar`) |
| Sistema marcou e o gestor discorda | `falso_positivo` | nosso time | ajustar a regra; não rebaixa modo |
| Concordância < 85% no número | `calibrar_juiz` | nosso time | rever rubrica/instrução do juiz com as revisões que discordaram; repetir na semana seguinte |
| Vendedor usou sugestão com problema sem editar | `orientar_equipe` | gestor | conversa 1:1; reforçar o guia (`agente-guia-vendedor.md`) |
| Duas CRÍTICA no número na semana, CRÍTICA enviada ao cliente, ou pedido confirmado errado | `recuar_modo` | admin do cliente | rebaixar o modo (`agente-go-live.md` §3); a troca é auditada |

Na reunião semanal (15 min, gestor + nosso time): concordância por número, CRÍTICA e ALTA da semana,
decisões abertas e prazos vencidos.

## 5. Riscos aceitos

- **A ordem da amostra revela a gravidade.** As CRÍTICA vêm primeiro, depois ALTA ou nota ≤ 3. É o
  protocolo (começar pelo grave), aceito pelo coordenador na P16: a cegueira cobre motivo, gravidade,
  regras e notas, **não a posição na lista**. Quem revisa sabe que o topo tende a ser pior — e mesmo
  assim dá a própria nota antes de ver a do juiz.
- **Regravar fora das 20.** Se a conversa saiu da amostra depois da 1ª gravação, regravar continua
  permitido (o motivo da amostra original fica).
- A concordância depende de **um dono no cliente** que revise toda semana; sem ele, a fase não avança.
  Isso faz parte do onboarding.
