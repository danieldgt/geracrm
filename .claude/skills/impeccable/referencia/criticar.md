# `critique`: revisão de UX com nota

Adaptado de `critique.md`, do Impeccable (Apache-2.0; ver `../NOTICE.md`). A evidência visual vem do ciclo da
`taste-skill`.

## Como rodar

1. **Evidência.** Capture a tela nos dois temas a 1280×860 e a 390×844 (toque); com o chat rail aberto, também a
   1440. Rode a medição de `../../taste-skill/referencia/medir.md`. Use o tenant de dogfooding local ou o seed demo
   (`SEED_DEMO=on pnpm --filter @geracrm/api seed:demo`), **nunca produção nem cliente real**.
2. **Duas leituras independentes.** Faça a leitura A (imagens e código) **antes** de ver a medição B. Se não der,
   escreva na primeira linha: `Leitura única: a medição foi vista antes da crítica`.
3. Escreva o relatório no formato abaixo. A crítica **não corrige**.

## O que a leitura A avalia

- **Especificidade:** "outro CRM usaria esta tela sem mudar nada?" O GeraCRM tem coisas só dele: a janela de 24h, o
  canal dual oficial/não-oficial com risco visível, o pedido que nasce na conversa e o ERP efetiva, o RFV humanizado,
  a degradação de ERP visível, o agente vendedor com modo sombra/assistido/autônomo.
- **Hierarquia:** o que se lê primeiro é o que importa? Teste de apertar os olhos.
- **Carga cognitiva** (oito itens): foco único; até 4 itens por grupo; agrupamento; hierarquia; uma coisa de cada
  vez; até 4 opções visíveis; nada para guardar de uma tela para outra; divulgação progressiva. 0–1 falha: baixa;
  2–3: moderada; 4+: crítica. Botões: 1 primário, 1 ou 2 secundários, o resto no "⋯".
- **Arquitetura de informação:** a tela tem um trabalho que nenhuma outra faz? O rótulo do menu diz esse trabalho?
  Há outra tela com o mesmo dado, outro nome ou outro jeito de criar? Isso é achado de `distill`.
- **Jornada:** tranquilizar nos momentos de risco: efetivar pedido, disparar campanha, bloquear, anonimizar (LGPD),
  trocar modo do agente, desconectar número.

## As dez heurísticas (Nielsen), de 0 a 4

| # | Heurística | No GeraCRM, confira |
|---|---|---|
| 1 | Visibilidade do estado | janela de 24h, enviado/entregue/lido, rascunho/efetivado/falhou, SSE conectado, modo do agente |
| 2 | Mundo real | palavras do ofício: conversa, pedido, carteira, recompra, template; nada de "entidade" ou "registro" |
| 3 | Controle e liberdade | Cancelar no modal, Esc fecha e devolve o foco, voltar funciona, rascunho nunca se perde |
| 4 | Consistência | o mesmo jeito de criar (modal) e o mesmo botão em toda tela; mesmo padrão L/F/M/A/D/C |
| 5 | Prevenção de erro | confirmação que nomeia o objeto; envio duplo bloqueado; preço nunca digitado no corpo |
| 6 | Reconhecer em vez de lembrar | rótulo junto do ícone; RFV com nome; estado à vista |
| 7 | Flexibilidade | atalhos no inbox, deep link (`/contato/:id`, `/pedido/:id`), filtros no endereço |
| 8 | Estética e minimalismo | uma ação dominante, nada que não sirva à tarefa |
| 9 | Recuperação de erro | 422 no campo; falha de negócio nomeada com ação (estoque, crédito); integração nomeia o sistema |
| 10 | Ajuda | vazio que ensina, subtítulo do cabeçalho com o "job" da tela |

Faixas: 36–40 excelente, 28–35 boa, 20–27 aceitável, 12–19 fraca, 0–11 crítica. Heurística que não se aplica é
`n/a` e o total é renormalizado.

## Personas: escolha 2 ou 3

- **Atendente, 8 h/dia no inbox:** responde, cota e tira pedido sem sair da conversa; Esc fecha; nada de tutorial.
- **Gestor no Cockpit:** acha em 5 s quem está sem resposta, sem próximo passo, fora do SLA; age em lote.
- **Dono/admin configurando:** conecta número, ERP, usuários; entende o risco do não-oficial; não se perde no menu.
- **Vendedor no celular (Expo ou console a 390):** a ação na metade de baixo, alvo de 44 px, rede lenta.
- **Leitor de tela e teclado:** tudo com Tab, foco visível, 4,5:1, nada dito só por cor (RFV, janela).
- **Quem testa os limites:** 0, 1 e 11 mil cards; nome de 120 caracteres; ERP fora do ar; recarregar no meio do pedido.

## Gravidade

- **P0, bloqueia:** impede a tarefa (controle coberto por outro, chat sobreposto ao conteúdo, perda de rascunho).
- **P1, grave:** dificuldade séria, violação de WCAG AA, tela duplicada que confunde onde trabalhar.
- **P2, menor:** há contorno.
- **P3, acabamento.**

Desempate: "alguém abriria chamado no suporte por isso?" Se sim, é P1 ou pior.

## Formato do relatório

```
Leitura: dupla | única (motivo)
Modo: Operar | Conversar | Ler | Preencher
Evidência: capturas (tema, largura), medição, código lido

Nota de saúde
| # | Heurística | Nota | Problema principal |
Total: ??/40 (faixa)

Especificidade: genérica | do GeraCRM (uma frase)
Impressão geral: duas frases
O que funciona: 2 ou 3 itens
Problemas prioritários (3 a 5):
  [P?] O quê, com o seletor, o arquivo e a linha, e a captura onde aparece
  Por que importa
  Correção (direção, não CSS)
  Comando sugerido: polish | layout | distill | …
Personas: o que trava cada uma
Observações menores
Perguntas (2 a 4, cada uma com 2 ou 3 opções concretas)
```

Estilo: direto, com o nome da coisa ("o botão Novo contato", e não "alguns elementos"). Priorize sem dó.
