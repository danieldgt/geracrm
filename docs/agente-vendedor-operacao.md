# Agente vendedor — manual de operação

> Para quem vai LIGAR o agente num cliente (nosso time ou o dono da loja). O desenho está em
> `plano-mestre-vendedor-autonomo.md` e nos ADR-023…027; as regras de código na skill
> `geracrm-agente-vendas`. Este documento é o "como usar".

## 1. O que ele faz — e o que nunca faz

Atende pelo WhatsApp como vendedor da loja: entende o que a pessoa quer, busca no catálogo,
cita preço e estoque **da tabela daquele cliente**, monta o pedido, manda o resumo e pede
confirmação. Responde dúvidas pelas **políticas escritas** da loja. Transfere para uma pessoa
quando o cliente pede, reclama, pede desconto, ou quando ele não sabe.

Nunca: inventa preço ou prazo (número que não veio do catálogo é bloqueado antes de sair), dá
desconto, efetiva pedido sozinho fora da alçada, manda campanha, fala com quem está em
atendimento humano.

## 2. Antes de ligar (checklist do onboarding)

1. **Catálogo** com produtos, variações e preço por perfil (ERP sincronizado ou cadastro manual
   em *Vendas → Catálogo*). Clique em **Reindexar** depois de cargas grandes.
2. **Perfil de preço do cliente** (varejo/atacado) na ficha do contato; sem ele, vale o padrão
   (atacado).
3. **Políticas da loja** escritas na tela do agente (pagamento, entrega, troca, horário, "o que
   não respondemos por aqui"). Modelo em `agente-politicas-exemplo.md` — **sem preço** no texto.
4. **Persona**: nome, nome da loja, tom, emojis. Deixe "identifica-se como atendimento
   automatizado" ligado — é exigência da Meta.
5. **Alçada**: por padrão todo pedido confirmado espera um vendedor faturar. Só ligue "efetiva
   sozinho" com um valor máximo depois de uma semana de sombra sem susto.
6. **Chave de IA** no servidor (`ANTHROPIC_API_KEY`); a tela mostra "falta configurar" se não
   houver.

## 3. Os quatro modos — e a ordem certa

| Modo | O que acontece | Quando usar |
|---|---|---|
| Desligado | Nada. A ausência continua funcionando | Padrão de todo canal novo |
| **Sombra** | Decide e registra o que diria; **não envia** | Primeira semana: leia as decisões todo dia |
| **Assistido** | Sugere a resposta ao vendedor (evento na tela); **não envia** | Quando as decisões estão boas e o time quer aprovar |
| **Autônomo** | Responde sozinho | Depois de sombra + assistido sem correção |

Trocar de modo vale na **próxima mensagem**. Desligar é imediato.

## 4. Playground

*Atendimento → Agente vendedor → Playground*: converse com o agente **de verdade** (catálogo,
políticas e ferramentas reais) sem WhatsApp. Em "Bastidores" aparecem as ferramentas chamadas
com argumentos e resultado, confiança, custo e latência. Use antes de ligar e sempre que mudar
políticas ou catálogo. "Reiniciar conversa" zera o histórico de simulação.

## 5. Ler as decisões

*Decisões* lista um registro por turno: o que o cliente mandou, o que o agente fez (ferramentas),
o que respondeu, se enviou, confiança, números bloqueados (sinal vermelho: ele tentou citar um
valor sem origem), custo e latência. Filtro por canal; abra a conversa pelo link.

Perguntas que a tela responde:
- "Por que o robô ficou quieto?" → desfecho *silêncio* + motivo do portão (desligado, humano
  assumiu, ausência recém-enviada, teto de turnos, sem gente disponível…).
- "Por que transferiu?" → motivo do handoff (pedido de humano, reclamação, desconto, incerteza,
  acima da alçada, IA indisponível, limite de custo).
- "Quanto custa?" → custo por turno e por conversa; *Métricas* soma por período.

## 6. Quando o cliente confirma o pedido

O "sim" é interpretado pelo sistema (não pelo robô) e só vale para a proposta mais recente, por
24 h. Dentro da alçada, o pedido vai ao ERP (no GeraCloud, como orçamento); fora, nasce um
atendimento na fila com o resumo e o cliente recebe "nossa equipe vai finalizar". Em todos os
casos o rascunho fica salvo.

## 7. Custos e limites

- Orçamento diário por canal (R$): ao estourar, o agente transfere para a fila em vez de calar.
- Prazo do turno (padrão 20 s) e teto de rodadas de ferramenta (6).
- Cada mensagem enviada pela Meta é cobrada; o agente responde em 1–3 bolhas por turno.

## 8. Canal não-oficial

Funciona, com o risco de banimento que a tela já mostra. Antes de deixar autônomo num número
não-oficial, ligue o throttle por número (INV-23) — está na lista de pendências do plano.
