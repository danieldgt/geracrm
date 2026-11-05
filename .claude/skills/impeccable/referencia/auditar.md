# `audit`: auditoria técnica (console e app)

Adaptado de `audit.md` e `audit.native.md`, do Impeccable (Apache-2.0; ver `../NOTICE.md`). Auditoria **documenta e
não corrige**. Para cada achado, diga o que produziu a evidência: teste, medição no Chrome, leitura de código.

## Console (`apps/console`): cinco dimensões de 0 a 4

1. **Acessibilidade.**
   - Contraste 4,5:1 (3:1 no texto grande e nos controles), nos dois temas.
   - `prefers-reduced-motion` (já no base em `estilos.css`); o anel de 24h continua legível parado.
   - Nome, papel e estado (`aria-expanded`, `aria-current`, `aria-pressed`). `ui-modal` prende e devolve o foco.
     Rótulo visível no campo; **nunca `aria-label` em campo que já tem `<label>`** (WCAG 2.5.3).
   - Nada só por cor: RFV com rótulo, janela com texto, estado com ícone ou palavra.
   - Prova: medição da `taste-skill` (alvo, contraste, transbordo) e leitura do template.
2. **Desempenho.**
   - Rota lazy em `rotas.ts`; nada pesado no bundle inicial da casca.
   - Lista por cursor e paginada no servidor (proibido `OFFSET` profundo e lista ilimitada); kanban com coluna de 11
     mil cards virtualizado ou paginado.
   - SSE como Observable, sem assinatura vazando ao desmontar (`geracrm-console-angular`).
   - Animação só de `transform`/`opacity`.
3. **Tema.**
   - Cor literal em componente (`cor-literal.spec.ts` deve estar verde).
   - Tema escuro: confira `data-tema="escuro"` **e** `prefers-color-scheme: dark` sem atributo.
   - Token errado (azul em fundo; `--erro` como decoração).
4. **Responsivo.**
   - Transbordo horizontal; filho de flex/grid sem `min-width: 0`; tabela larga fora de `.rolagem-x`.
   - Quebras: 640 px (grades viram 1 coluna) e 720 px (modal em tela cheia). O chat rail ao lado do conteúdo a 1280
     e 1440: o conteúdo não pode ficar sob o rail nem espremido abaixo do legível.
   - Alvo: 24 px com mouse (token do console: 28 px), 44 px no toque.
5. **Integridade da implementação (crítico).**
   - Deriva do sistema: tela que reimplementa `ui-cabecalho-tela`, `ui-tabela`, `ui-modal`, `ui-campo`.
   - Telas duplicadas ou sobrepostas no menu (`nucleo/menu.ts`); rota sem item e item sem trabalho próprio.
   - Estado enganoso: tela "pronta" que não faz nada, número inventado, degradação de ERP escondida.
   - Nota 0: deriva sistêmica. Nota 4: coerente e intencional.

## App (`apps/app`, Expo)

1. Acessibilidade: `accessibilityRole`/`Label`/`State`, fonte que acompanha o sistema, alvo 44
   (`--densidade-alvo-toque-app`).
2. Desempenho: `FlatList` em lista; nada antes do primeiro quadro.
3. Aparência: só tokens de `packages/design-tokens`.
4. Plataforma: voltar do sistema, área segura, folha de baixo em vez de menu suspenso. "App nativo ou site portado?"
5. Adaptação: teclado que não esconde o campo de mensagem.

## Relatório

```
Integridade: passa | não passa (uma frase), primeiro
Nota: | Dimensão | 0–4 | achado-chave |  Total ??/20
  faixas: 18–20 excelente · 14–17 boa · 10–13 aceitável · 6–9 fraca · 0–5 crítica
Resumo: contagem por P0–P3 e os 3 a 5 piores
Achados: [P?] nome / Onde (componente, arquivo, linha) / Categoria / Impacto / Critério WCAG / Recomendação / Comando
Padrões sistêmicos (ex.: "form inline em 6 telas", "cabeçalho próprio em 9 telas")
O que está bom
Ações em ordem: P0, P1, P2
```

Prova final de qualquer correção: `export PATH="$HOME/.local/bin:$PATH" && pnpm lint typecheck test`. Evite achado
sem impacto, tudo P0 e falso positivo que você não conferiu.
