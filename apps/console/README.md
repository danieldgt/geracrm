# apps/console — Console web

**Angular 21+** — zoneless, signals, standalone, Vitest. Servido por CDN (sem servidor de render).

> Status: **iniciado**. Primeira tela real: **Configurações → ERP**
> (`src/app/funcionalidades/integracao/`). O restante segue na Onda 1.

⚠️ **Angular 21, não 22.** O 22 exige TypeScript >= 6.0, e o monorepo está no 5.9 —
subir o TS por causa do console quebraria `api`, `shared` e `conectores` no mesmo commit.
O 21 aceita 5.9 e é o que o ADR-010 pede ("21+").

⚠️ **`vitest` 4 aqui, 2 no resto do monorepo.** É peer de `@angular/build` 21. Convivem porque o
Turbo roda `test` por pacote; a divergência é deliberada e some quando o resto subir.

⚠️ **`tsc --noEmit` NÃO valida template.** `strictTemplates` só roda no compilador Angular, e é lá
que moram os erros desta tela — `erroDe(campo.nome)` sobre um `computed` passa no `tsc` e quebra no
build. Por isso `pnpm typecheck` aqui é `ng build` **e** `tsc`, nessa ordem.

## Quem usa

Gestor e atendente, em **desktop, 8 horas por dia**. É a superfície mais densa e mais usada do
produto — inbox de quatro colunas, kanban com arrastar-e-soltar, tabela de campanhas com 16 colunas
ordenáveis, e fluxo contínuo de eventos chegando do servidor.

**Densidade e estabilidade valem mais que animação.**

## Por que Angular (ADR-010)

1. **RxJS** modela o stream SSE multiplexado por canal, com reconexão, cancelamento ao trocar de
   conversa e merge com estado local. Em React seria artesanal.
2. **CDK** entrega virtual scroll maduro para as listas grandes.
3. Estrutura opinativa reduz divergência arquitetural em app de vida longa.
4. Vitest é o runner padrão do Angular 21 — alinha com o resto da stack.
5. **O time domina Angular.**

## Estrutura

```
src/app/
  nucleo/            auth, interceptors, serviço de eventos SSE
  compartilhado/     componentes de UI sem regra de negócio
  funcionalidades/   atendimento/ crm/ pedido/ campanha/ catalogo/ analitico/
```

Uma pasta por capacidade, espelhando os contextos da API. Rotas com lazy loading.
⚠️ Funcionalidade não importa de funcionalidade.

## Regras críticas

- **Signals para estado, RxJS para fluxo.** `toSignal()` faz a ponte.
- **SSE por canal**, com cursor de versão e `takeUntilDestroyed()`. O serviço de eventos **invalida
  e dispara a busca** — não popula a tela sozinho (o payload não traz conteúdo).
- ⚠️ **Kanban não usa virtual scroll.** O CDK não suporta drag-drop e virtual scroll juntos;
  resolvemos por desenho, com paginação por coluna. Virtual scroll fica onde não há drag.
- **Cinco estados obrigatórios** em todo bloco de dados: carregando, vazio, erro, sem permissão,
  parcial.
- ⚠️ **Janela de 24h fechando com a conversa aberta**: o composer troca de modo sem recarregar e
  **preserva o texto digitado**. Perder o que a vendedora escreveu é o defeito mais caro do inbox.
- ⚠️ **Regra de negócio não mora aqui.** Cálculo de RFV, validação de pedido mínimo e decisão de
  janela vêm da API ou de `packages/shared`. O console **apresenta**.

Regras completas: [`geracrm-console-angular`](../../.claude/skills/geracrm-console-angular/SKILL.md)

## Design

Consome [`packages/design-tokens`](../../packages/design-tokens). ⚠️ Cor literal em componente é
divergência garantida com o app Expo em três meses.
