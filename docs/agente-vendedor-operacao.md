# Agente vendedor — manual de operação

> Para quem vai LIGAR o agente num cliente (nosso time ou o dono da loja). O desenho está em
> `plano-mestre-vendedor-autonomo.md` e nos ADR-023…034; as regras de código na skill
> `geracrm-agente-vendas`. Este documento é o "como usar". Documentos de operação (port do playbook da
> AM, 2026-10-17): fases e rollback em `agente-go-live.md`, incidentes em `agente-runbook.md`, revisão
> semanal em `agente-revisao-semanal.md`, guia do vendedor em `agente-guia-vendedor.md` e treinamento em
> `agente-treinamento-1h.md`.

## 1. O que ele faz — e o que nunca faz

Atende pelo WhatsApp como vendedor da loja: entende o que a pessoa quer, busca no catálogo,
cita preço e estoque **da tabela daquele cliente**, monta o pedido, manda o resumo e pede
confirmação. Responde dúvidas pelas **políticas escritas** da loja. Transfere para uma pessoa
quando o cliente pede, reclama, pede desconto, ou quando ele não sabe.

Nunca: inventa preço, prazo, percentual ou quantidade (número sem fonte no turno é bloqueado antes de
sair), dá desconto, promete entrega/estoque/crédito (filtro de saída), nega ser assistente virtual,
efetiva pedido sozinho fora da alçada, manda campanha, fala com quem está em atendimento humano, manda
mensagem a quem pediu opt-out.

## 2. Antes de ligar (checklist do onboarding)

1. **Catálogo** com produtos, variações e preço por perfil (ERP sincronizado ou cadastro manual
   em *Vendas → Catálogo*). Clique em **Reindexar** depois de cargas grandes.
2. **Perfil de preço do cliente** (varejo/atacado) na ficha do contato; sem ele, vale o padrão
   (atacado).
3. **Políticas da loja** escritas na tela do agente (pagamento, entrega, troca, horário, "o que
   não respondemos por aqui"). Modelo em `agente-politicas-exemplo.md` — **sem preço** no texto.
4. **Persona e playbook**: nome, nome da loja, tom, roteiro de qualificação e mensagens prontas na aba
   **Playbook** (rascunho → testar → publicar com observação). Identificar-se como assistente virtual
   não é opção: é regra do código (ADR-028/029), junto com o **aviso de privacidade** da 1ª resposta
   (`PUT /v1/privacidade`).
5. **Alçada**: por padrão todo pedido confirmado espera um vendedor faturar. Só ligue "efetiva
   sozinho" com um valor máximo depois de uma semana de sombra sem susto.
6. **Chave de IA** no servidor (`ANTHROPIC_API_KEY` ou a do provedor escolhido) **e a da reserva**
   (`IA_RESERVA_PROVEDOR`/`IA_RESERVA_MODELO`, ADR-030); a tela mostra "falta configurar" se não houver.
7. **SLA do handoff** do número (`PUT /v1/canais/:id/sla`; sem configuração valem 30/60 minutos úteis
   com a mensagem de espera ligada — ADR-034) e **papéis** atribuídos (sem admin, a conta está em modo
   fundador e a reserva do handoff fica dormente).
8. **Dono da revisão semanal** no cliente (gestor) — sem ele o agente não passa da sombra.

## 3. Os quatro modos — e a ordem certa

| Modo | O que acontece | Quando usar |
|---|---|---|
| Desligado | Nada. A ausência continua funcionando | Padrão de todo canal novo |
| **Sombra** | Decide e registra o que diria; **não envia** | Primeira fase: mede similaridade com o vendedor e qualidade |
| **Assistido** | Sugere a resposta ao vendedor no inbox (Usar / Descartar); **não envia** | Quando a sombra cumpriu o critério |
| **Autônomo** | Responde sozinho — primeiro num **recorte** (horário, feriado, segmento RFV) | Depois de assistido cumprir o critério |

Os critérios numéricos de cada fase, como medir e como voltar estão em `agente-go-live.md`. O modo
**efetivo** é o mais restritivo entre o teto da conta (kill switch, `PUT /v1/agente/tenant`), o número e
o recorte (ADR-028). Trocar para `autonomo` ou `desligado` pede a palavra digitada e papel de admin, e
toda troca é auditada. Vale na **próxima mensagem**.

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
  acima da alçada, IA indisponível, limite de custo do dia ou da conversa, opt-out, áudio sem
  transcrição, "é robô?" pela 2ª vez, gatilho do playbook, violação crítica de qualidade).
- "O que as proteções mexeram?" → as **marcas de guardrail** de cada turno (etapa, código, gravidade,
  ação): número sem fonte, frase proibida, pergunta repetida, regra de qualidade.
- "Quanto custa?" → custo por turno e por conversa; *Métricas* soma por período.

## 6. Quando o cliente confirma o pedido

O "sim" é interpretado pelo sistema (não pelo robô) e só vale para a proposta mais recente, por
24 h. Dentro da alçada, o pedido vai ao ERP (no GeraCloud, como orçamento); fora, nasce um
atendimento na fila com o resumo e o cliente recebe "nossa equipe vai finalizar". Em todos os
casos o rascunho fica salvo.

## 7. Custos e limites

- **Teto diário por número** (`agente_config.orcamento_dia_centavos`, não por tenant — ADR-032): ao
  estourar, o agente transfere (`limite_de_custo`) em vez de calar. Vira à meia-noite no fuso da loja.
- **Teto por sessão** (`IA_TETO_SESSAO_CENTAVOS`, padrão R$ 3,00; o número pode sobrepor): pega loop e
  conversa patológica (`limite_de_custo_conversa`).
- **Orçamento mensal da conta** (`PUT /v1/agente/orcamento`): só **alerta** a 80% e 100%, não corta.
- Custo pelo catálogo `modelo_ia` com id normalizado; modelo gratuito custa 0; desconhecido cai no maior
  preço e abre `preco_desconhecido`.
- Prazo do turno (padrão 20 s) e teto de rodadas de ferramenta (6).
- Cada mensagem enviada pela Meta é cobrada; o agente responde em 1–3 bolhas por turno.

## 8. Canal não-oficial

Funciona, com o risco de banimento que a tela já mostra. Antes de deixar autônomo num número
não-oficial, ligue o throttle por número (INV-23) — está na lista de pendências do plano.
