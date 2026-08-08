# apps/catalogo — Catálogo público

Renderizado no servidor. Deployable separado, com cache agressivo.

> Status: **não implementado**. Aguardando Onda 2.

## Quem usa

O **lojista** — o cliente final da nossa cliente. Ele recebe um link no WhatsApp e abre no celular,
em 4G, no meio do dia.

⚠️ **É a única superfície do produto que o cliente final acessa.** Não tem login, não tem sessão,
não tem segunda chance: o primeiro carregamento é tudo o que importa.

## Por que renderizado no servidor

| Exigência | Consequência |
|---|---|
| Abrir rápido em 4G | Sem bundle grande de SPA |
| Gerar preview no WhatsApp | Metadados no HTML, no servidor |
| Ser compartilhado e recompartilhado | URL estável, cacheável |

O console é SPA justamente pelo motivo oposto: sessão de horas, alta interatividade, dado privado.
São perfis opostos e por isso são deployables diferentes.

## O que faz

- Vitrine de produtos com **grade cor × tamanho**, preço da tabela do cliente e disponibilidade
- Link compartilhável, gerado a partir da conversa ("copiar catálogo")
- ⚠️ **Rastreio de comportamento**: quem abriu, o que olhou, quando — alimenta o CRM (CAT-03)

## O que NÃO faz

⚠️ **Sem carrinho, sem checkout, sem cadastro do lojista.** Loja B2B self-service está fora de
escopo por decisão — o ERP já resolve. Aqui o catálogo é **peça de conversa**: a vendedora manda o
link, o lojista olha, e o pedido é montado pela vendedora no console ou no app.

## Segurança

O link é público, mas **não adivinhável**. ⚠️ Nunca expor identificador sequencial nem dado de
outro tenant. O que o lojista vê é filtrado pela tabela de preço e pelo mix permitido a ele.
