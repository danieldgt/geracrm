---
name: geracrm-console-angular
description: >
  Regras do console web do GeraCRM em Angular 21+: SSE como Observable, estado com signals,
  listas grandes, kanban com drag-drop, design tokens compartilhados com o app Expo, e os cinco
  estados obrigatórios de tela. Usar sempre que criar ou alterar código em apps/console, ou ao
  decidir como uma tela do console busca dados, recebe eventos ou lida com volume.
---

# Console web — Angular

Angular 21+ **zoneless**, signals dirigindo o change detection, componentes standalone, Vitest.
Decisão e consequências no ADR-010 (`docs/decisoes.md`). Regras gerais de arquitetura na skill
`geracrm-arquitetura`.

O console é onde a operação vive: a vendedora fica **8 horas na mesma tela**. Densidade e
estabilidade valem mais que animação.

## Estado: signals para estado, RxJS para fluxo

| Use | Para |
|---|---|
| **Signal** | Estado que a tela lê — conversa aberta, filtros, rascunho de pedido, contadores |
| **Observable** | Fluxo que chega ao longo do tempo — SSE, digitação com debounce, busca |
| `toSignal()` | Ponte do fluxo para o estado que o template consome |

⚠️ Não modele estado com `BehaviorSubject` no Angular 21 — signal é o mecanismo do framework e o
change detection depende dele. E não modele stream de eventos como signal: você perde cancelamento,
retry e composição.

## SSE — o coração do console

Um serviço expõe o stream **por canal**, não um stream global.

```ts
eventos.doNumero(numeroId)      // tenant:{T}:numero:{N}
eventos.daConversa(conversaId)  // tenant:{T}:conversa:{C}
```

Regras:

- **Cursor de versão no cliente.** Ao reconectar, buscar o delta pela API — ⚠️ nunca confiar em
  histórico de broker para recuperar evento perdido.
- **Cancelar ao sair.** `takeUntilDestroyed()` em toda assinatura. Trocar de conversa cancela a
  anterior; sem isso, uma manhã de trabalho acumula dezenas de assinaturas vivas.
- **O payload não traz conteúdo** (ADR-007). O evento avisa; o conteúdo vem por API sob RLS. O
  serviço de eventos **não** popula a tela sozinho — ele invalida e dispara a busca.
- **Reconexão com backoff**, e estado visível: conectado / reconectando / offline. ⚠️ Silêncio na
  tela é pior que aviso — a vendedora precisa saber que parou de receber.
- **Sem polling de fundo.** Antipadrão medido no GeraCloud, onde polling dominava o tráfego.

## Listas grandes

| Superfície | Técnica | Por quê |
|---|---|---|
| Lista de conversas | **CDK virtual scroll** + paginação por cursor | Milhares de itens, sem drag |
| Tabela de campanhas | **CDK virtual scroll** | 16 colunas ordenáveis, sem drag |
| Contatos, leads da IA | **CDK virtual scroll** | Sem drag |
| **Kanban** | ⚠️ **Paginação por coluna — SEM virtual scroll** | Ver abaixo |
| Histórico de mensagens | Cursor **para trás**, blocos de 30 dias, sob demanda | Nunca scroll infinito retroativo |

### ⚠️ Por que o kanban não virtualiza

O CDK **não suporta drag-drop e virtual scroll juntos**: ao arrastar dentro de um viewport
virtualizado, os índices deixam de localizar o item. Em vez de contornar com gambiarra, resolvemos
por desenho:

Card de ~120 px → coluna visível mostra 6–8 cards. **Carregar 50 por página, com "carregar mais"
ao aproximar do fim.** Atende a coluna de 11 mil cards, mantém o drag-drop nativo do CDK e a
paginação server-side já é obrigatória de qualquer forma.

Toda lista, virtualizada ou não, usa `track` no `@for`. Sem isso, o Angular recria a linha inteira
a cada evento — e eventos chegam o tempo todo.

## Os cinco estados de tela

Todo bloco de dados define os cinco (regra da skill `especificar-telas`):

| Estado | No console |
|---|---|
| **Carregando** | Esqueleto com a forma do conteúdo. ⚠️ Nunca spinner solto no centro |
| **Vazio** | Explica por quê e oferece a ação seguinte |
| **Erro** | Diz o que falhou e se é recuperável. Erro de integração **nomeia o sistema** ("GeraCloud não respondeu") |
| **Sem permissão** | O elemento **não aparece**. Exceção: recurso não contratado, com cadeado como upsell |
| **Parcial** | Dado principal carregou, secundário falhou — aviso localizado, tela não quebra |

## Transições de contexto — onde as telas erram

⚠️ **Janela de 24h fechando com a conversa aberta.** O composer troca de modo **sem recarregar**,
**preserva o texto digitado** e o oferece para colar no template. Perder o que a vendedora escreveu
é o defeito mais caro do inbox.

⚠️ **Permissão revogada durante a sessão.** Chega pelo canal do usuário; o console descarta o
token de push e re-autoriza. Não recarrega a página inteira.

⚠️ **Rascunho de pedido é estado do servidor**, não do navegador. Começar no celular e terminar no
console precisa funcionar (PED-06).

## Formulários

- **Signal Forms** onde já estiver estável; `ReactiveForms` no restante. ⚠️ Nunca template-driven
  em formulário de negócio.
- Validação de borda com o **mesmo schema Zod de `packages/shared`** que a API usa. Duplicar regra
  de validação garante divergência.
- Erro de servidor volta **tipificado** e é mapeado para o campo. ⚠️ Nunca exibir mensagem crua do
  ERP.

## Design tokens

Console (CSS) e app Expo (NativeWind) **não compartilham componente** — compartilham **tokens**:
cor, escala tipográfica, espaçamento, raio, elevação. Fonte da verdade em formato neutro, consumida
pelos dois.

⚠️ Cor literal em componente do console é divergência garantida com o app em três meses.

## Densidade e leitura periférica

Quem usa o dia inteiro **varre, não lê**. Consequências práticas:

- **Badges em ordem fixa**, sempre. Posição que muda entre cards quebra a varredura e obriga
  leitura item a item
- Alvos de clique compactos, mas com área mínima confortável
- Atalhos de teclado nas ações do inbox — `Ctrl+Enter` para enviar é o mínimo
- Modo escuro desde o começo, não depois

## Estrutura

```
apps/console/src/app/
  nucleo/          auth, interceptors, eventos SSE, tokens de design
  compartilhado/   componentes de UI sem regra de negócio
  funcionalidades/ atendimento/ crm/ pedido/ campanha/ catalogo/ analitico/
```

- Uma pasta por **capacidade de negócio**, espelhando os contextos da API
- ⚠️ Funcionalidade não importa de funcionalidade. Precisou compartilhar? Sobe para `compartilhado`
  (UI) ou `nucleo` (serviço)
- Rotas com **lazy loading** por funcionalidade
- ⚠️ Regra de negócio não mora no console. Cálculo de RFV, validação de pedido mínimo e decisão de
  janela vêm da API ou de `packages/shared`. O console **apresenta**

## Testes

Vitest (padrão do Angular 21) + Testing Library. Cobrir:

- Fluxos críticos: assumir atendimento, enviar com janela fechada, montar e efetivar pedido, mover
  card no kanban
- **Transições de estado**, não só render: janela fechando, permissão revogada, reconexão de SSE
- ⚠️ Testar por comportamento observável, não por classe CSS ou estrutura de DOM

Detalhes em `geracrm-testes`.
