# packages/shared — Contrato compartilhado

Tipos, schemas Zod, constantes e **regras puras de domínio**.

> Status: **não implementado**.

## ⚠️ TypeScript puro — a regra que define este pacote

É consumido por **Angular, Expo e API ao mesmo tempo**. Um `import` de React, de Angular ou de
qualquer runtime específico **quebra dois dos três consumidores**.

| Pode entrar | Não pode entrar |
|---|---|
| Tipos e interfaces | Componente, hook, `signal`, serviço |
| Schemas Zod | Acesso a `window`, `document`, `AsyncStorage` |
| Constantes e uniões de literais | `fetch`, cliente HTTP |
| **Funções puras de domínio** | Qualquer dependência de framework |

## Por que este pacote é o que mais importa

Depois da decisão de ter dois front-ends (ADR-010: Angular no console, Expo no app), `shared` é
**o único código que os três lugares compartilham**. E é justamente a parte que mais custa quando
diverge: regra de negócio escrita duas vezes, escrita diferente.

Exemplos do que mora aqui:

- Cálculo de faixa RFV e evolução de segmento
- Regra da janela de 24h (dado o timestamp da última mensagem do cliente, a janela está aberta?)
- Validação de pedido mínimo, múltiplo de grade e mix
- Normalização de telefone — ⚠️ `+55 81 99861-7049`, `5581998617049` e `81998617049` precisam
  colidir na mesma chave
- Formatação e parse de dinheiro em centavos
- Uniões de literais de estado, com as máquinas de estado

## Validação nas bordas

O mesmo schema Zod valida na API (entrada HTTP, webhook, ERP) **e** no formulário do console.
⚠️ Duplicar regra de validação garante divergência — e a divergência aparece como "o front deixou
passar" em produção.

## Watch path

⚠️ Ao adicionar um import de `shared` em qualquer app, **confira o watch path do deploy no mesmo
commit**. Se `packages/shared/**` não estiver lá, o tipo muda na API e não muda na tela — deploy
verde, comportamento errado. É a armadilha herdada do drezz.
