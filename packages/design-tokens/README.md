# packages/design-tokens — Fonte da verdade visual

> Status: **não implementado**. ⚠️ Depende da definição de identidade visual — ver
> `docs/direcao-visual.md` e `docs/prontidao-para-inicio.md` §2.3.

## Por que existe

O console é **Angular (CSS)** e o app é **Expo (NativeWind)**. Eles **não compartilham componente** —
essa foi a consequência aceita do ADR-010.

O que eles compartilham é isto: **os tokens**.

> Componente se duplica. Token, não.

⚠️ Sem uma fonte única, console e app divergem em três meses — e a divergência aparece como
"o app tá com uma cor diferente" que ninguém sabe resolver, porque a cor está literal em vinte
arquivos.

## O que mora aqui

| Categoria | Exemplos |
|---|---|
| **Cor semântica** | superfície, superfície elevada, texto primário/secundário, borda, ação, sucesso, alerta, erro, informação |
| **Tipografia** | família, escala, pesos, altura de linha |
| **Espaçamento** | escala consistente |
| **Raio** | por tamanho de componente |
| **Elevação** | níveis de sombra |
| **Movimento** | durações e curvas |

⚠️ **Cor semântica, não cor literal.** `superficie-elevada`, não `cinza-100`. É o que permite o modo
escuro inverter os papéis sem tocar em componente.

## Modo claro e escuro

Definidos **desde o início**, não depois. O token muda de valor; o componente não muda.

## Formato

Fonte neutra (o formato exato será decidido junto com a implementação), com dois consumidores:

- **Angular** — custom properties CSS
- **Expo** — configuração do NativeWind/Tailwind

## Acessibilidade

Os tokens já nascem com contraste verificado. ⚠️ Contraste é propriedade do par de tokens
(texto sobre superfície), não de um token isolado — a verificação precisa ser dos pares que
realmente se usam.
