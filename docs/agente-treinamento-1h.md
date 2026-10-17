# Treinamento — 1 h vendedor + 20 min gestor

> Roteiro para a passagem de **sombra → assistido** num cliente (`agente-go-live.md`, Fase 2). Material
> do vendedor: `agente-guia-vendedor.md` (enviar antes da sessão). Estrutura portada do roteiro de 1 h da
> AM; conteúdo do GeraCRM.

## Preparação (nosso time, véspera)

- [ ] Um número de **teste** do cliente com o agente em `assistido` (ou `sombra`, para o exercício do
      copiloto), catálogo indexado, políticas escritas e playbook publicado.
- [ ] Um usuário por participante com acesso ao número de teste (`usuario_canal`) e um gestor
      (papel `gestor`). Sem nenhum admin atribuído a conta está em **modo fundador** (todos valem admin):
      atribua os papéis antes, senão a reserva do handoff e a rota para o gestor não aparecem.
- [ ] Um celular fazendo o papel do cliente, escrevendo para o número de teste.
- [ ] SLA do número conferido (`GET /v1/canais/:id/sla`; sem configuração vale 30/60 min úteis).
- [ ] Projetor ou tela espelhada; lista de presença com o checklist de domínio.

## Bloco do vendedor (60 min)

| Min | Tema | Demonstração | Exercício |
|---|---|---|---|
| 0–5 | Por que o agente | Ele atende rápido, cita só o que o catálogo e as políticas dizem, e passa para você o que é seu | — |
| 5–12 | Selo do modo | Os quatro selos; o modo que vale **agora** (horário, segmento, teto da conta) | **E1** Dizer o modo do número de teste e o que ele faz |
| 12–27 | **Sugestão do assistido** | Cliente pergunta preço e prazo; a sugestão chega com avisos; **Usar**, editar, enviar | **E2** Usar e enviar sem mexer. **E3** Usar, corrigir e enviar. **E4** Descartar e escrever à mão |
| 27–33 | "Não envie assim" | Sugestão barrada: **Usar** bloqueado, **Copiar para editar** | **E5** Reescrever a barrada e enviar |
| 33–40 | **Copiloto** | **Sugerir resposta** numa conversa em sombra; **Sugerir outra** | **E6** Pedir sugestão, comparar duas, usar uma |
| 40–50 | **Fila, cronômetro e Assumir** | Cliente pede "quero falar com uma pessoa"; o card entra na fila com cronômetro; Assumir; mensagem de reserva quando o cliente foi direcionado a outro | **E7** Assumir o handoff direcionado a você e responder antes do amarelo |
| 50–55 | Opt-out e o que nunca fazer | Cliente escreve "pare de me mandar mensagem"; faixa vermelha; tabela do guia | **E8** Confirmar o opt-out e bloquear em Opt-out / Bloqueios. **E9** "Ache o erro" em 3 mensagens: desconto oferecido, prazo garantido, número sem fonte |
| 55–60 | Dúvidas | Como reportar sugestão ruim ao gestor | Checklist de domínio |

### Checklist de domínio do vendedor (meta: 100% antes de ligar o assistido)

- [ ] Lê o selo e explica o que o modo faz
- [ ] Usa, edita e descarta uma sugestão
- [ ] Reconhece "Não envie assim" e reescreve antes de enviar
- [ ] Pede sugestão pelo copiloto
- [ ] Lê o cronômetro (sabe o que é vermelho) e assume um handoff
- [ ] Confirma e registra um opt-out
- [ ] Cita 3 coisas que nunca faz (inventar número, dar desconto, prometer entrega)

## Bloco do gestor (20 min, depois)

| Min | Tema | Demonstração | Exercício |
|---|---|---|---|
| 0–5 | **Fila e SLA** | Cronômetros no inbox e no kanban; gestor sempre assume; reatribuição liberada no 2º prazo; SLA cumprido em Performance | **G1** Assumir um handoff reservado a outro vendedor |
| 5–12 | **Revisão semanal** | Aba Revisão: amostra de 20, cego até gravar, notas 0–5, gravidade, veredito, decisão com responsável e prazo (`agente-revisao-semanal.md`) | **G2** Revisar 1 conversa da amostra e gravar |
| 12–16 | **Qualidade** | Aba Qualidade: violações por gravidade, nota média, "Oculto até você revisar" | **G3** Achar a conversa com a pior gravidade da semana |
| 16–20 | **Modo e kill switch** | Selo do modo efetivo; quem pode mudar (só admin, com a palavra digitada); auditoria | **G4** Explicar quando pedir ao admin para rebaixar o modo (CRÍTICA confirmada; duas na semana) |

### Checklist de domínio do gestor

- [ ] Assume e reatribui um handoff
- [ ] Revisa uma conversa às cegas e registra decisão com responsável e prazo
- [ ] Sabe o dia da revisão semanal e a meta de 85%
- [ ] Sabe quem rebaixa o modo e em que situação
