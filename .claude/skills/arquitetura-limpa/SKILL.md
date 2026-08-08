---
name: arquitetura-limpa
description: >
  Aplicar Clean Architecture de forma pragmática: camadas, regra de dependência, casos de uso,
  portas e adaptadores, onde cada tipo de código mora e o que fica fora do domínio. Inclui como
  isolar integrações externas e como manter testabilidade sem cerimônia inútil. Use quando for
  preciso "definir a arquitetura", "organizar as camadas", "estruturar o projeto", discutir
  acoplamento, dependência ou testabilidade, ou antes de decidir framework e banco de dados.
---

# Arquitetura limpa, sem cerimônia

O objetivo não é ter camadas bonitas. É que **a regra de negócio possa mudar sem que o framework
mude, e vice-versa** — e que dê para testar o negócio sem subir infraestrutura.

## A única regra que importa

**A dependência aponta para dentro.** Sempre.

```
   ┌──────────────────────────────────────────┐
   │  ENTREGA    web · mobile · API · cron    │  conhece tudo
   │  ┌────────────────────────────────────┐  │
   │  │ ADAPTADORES  banco · ERP · Meta    │  │  conhece o domínio
   │  │  ┌──────────────────────────────┐  │  │
   │  │  │ CASOS DE USO                 │  │  │  conhece o domínio
   │  │  │  ┌────────────────────────┐  │  │  │
   │  │  │  │ DOMÍNIO                │  │  │  │  não conhece ninguém
   │  │  │  │ entidades, invariantes │  │  │  │
   │  │  │  └────────────────────────┘  │  │  │
   │  │  └──────────────────────────────┘  │  │
   │  └────────────────────────────────────┘  │
   └──────────────────────────────────────────┘
```

Teste prático: **abra um arquivo do domínio. Se houver import de framework, ORM, HTTP ou SDK
externo, a regra foi violada.**

## O que mora onde

| Camada | Contém | Nunca contém |
|---|---|---|
| **Domínio** | Entidades, objetos de valor, invariantes, regras que existiriam mesmo no papel | Anotação de ORM, DTO de API, chamada de rede, data/hora do sistema |
| **Casos de uso** | Orquestração de um objetivo do usuário; transação; autorização | SQL, JSON, rota HTTP, template de e-mail |
| **Adaptadores** | Repositórios, clientes de API externa, mapeamento entre modelos | Regra de negócio — nem "só uma validaçãozinha" |
| **Entrega** | Controllers, telas, jobs, consumidores de fila | Qualquer decisão de negócio |

⚠️ **Validação de negócio em controller é o vazamento mais comum.** Se a regra é "pedido abaixo do
mínimo não efetiva", ela mora no domínio — e continua valendo se o pedido chegar por API, por
importação ou por job.

## Casos de uso: um por objetivo do usuário

Nomeie pelo que o usuário quer, não pelo verbo técnico:

| ❌ | ✅ |
|---|---|
| `PedidoService.salvar()` | `EfetivarPedido` |
| `ClienteManager.update()` | `TransferirCarteira` |
| `MensagemHandler.process()` | `AssumirAtendimento` |

Cada caso de uso: **uma entrada, uma saída, um resultado de negócio, uma transação.**

Assinatura típica:

```
EfetivarPedido(comando) → Resultado<PedidoEfetivado, FalhaDeEfetivacao>
```

**Falha de negócio é valor de retorno, não exceção.** Estoque insuficiente e crédito bloqueado
são resultados esperados do caso de uso — a tela precisa deles tipificados. Exceção fica para o
que é realmente excepcional: rede caiu, banco fora do ar.

## Portas e adaptadores para integração externa

Toda dependência externa entra por uma **porta definida pelo domínio**, não pelo fornecedor:

```
domínio define:      EstoqueConsultavel.saldoDe(sku) → Saldo
adaptador implementa: GeraCloudEstoque, ERPGenericoEstoque, EstoqueFake (teste)
```

**Por que isso importa mais do que parece:** quando o segundo ERP aparecer — e ele aparece — a
mudança fica contida em um adaptador. Se o caso de uso conhece o formato do GeraCloud, o produto
inteiro fica preso ao primeiro cliente.

⚠️ **A porta é definida pela necessidade do domínio, não pela API do fornecedor.** Se a interface
tem um método `postOrdersV2Batch()`, você não fez uma porta — copiou o SDK e chamou de arquitetura.

## Onde ficam as coisas difíceis

| Preocupação | Onde mora | Por quê |
|---|---|---|
| **Transação** | Caso de uso | Ele conhece o limite do agregado |
| **Autorização** | Caso de uso (não no controller) | A regra vale para toda porta de entrada |
| **Isolamento de tenant** | Camada de acesso, obrigatório | Não pode depender de quem chama lembrar |
| **Tempo (agora)** | Injetado, nunca lido direto | Senão nada com prazo é testável |
| **ID novo** | Injetado ou gerado no domínio | Idem |
| **Eventos de domínio** | Emitidos pelo domínio, publicados pelo caso de uso | Domínio não conhece o barramento |
| **Cache** | Adaptador | É detalhe de desempenho, não de negócio |

## Quando NÃO aplicar

Arquitetura limpa custa. Não pague onde não rende:

- **CRUD genuíno sem regra** — cadastro de cor, de categoria. Camada direta resolve
- **Relatório de leitura** — consulta analítica pode ir direto ao banco, com SQL bem escrito.
  Forçar relatório a passar por entidades gera N+1 e código pior
- **Protótipo descartável**

⚠️ **A separação leitura/escrita é o atalho legítimo.** Escrita passa por domínio e invariantes;
leitura complexa pode ser consulta direta otimizada. Não é violação — é reconhecer que ler e
escrever têm necessidades diferentes.

## Modularização

Módulo por **capacidade de negócio**, não por camada técnica:

```
❌ controllers/ services/ repositories/ models/
✅ atendimento/ pedido/ campanha/ catalogo/ integracao/
```

Dentro de cada módulo, as camadas. Entre módulos, comunicação por **contrato explícito** —
interface publicada ou evento — nunca acessando a tabela do vizinho.

**Teste do limite:** se dá para extrair um módulo para outro processo sem tocar nos outros, o
limite está certo. Se não dá, ainda é um monólito com pastas bonitas — o que pode até ser
aceitável, desde que seja consciente.

## Checklist

- □ Nenhum arquivo de domínio importa framework, ORM ou SDK
- □ Todo caso de uso tem nome de objetivo do usuário
- □ Falha de negócio é retorno tipificado, não exceção
- □ Toda integração externa entra por porta definida pelo domínio
- □ Tempo e ID são injetados
- □ Isolamento de tenant é garantido pela camada
- □ Módulos por capacidade, não por camada
- □ Cada decisão de arquitetura aponta para uma exigência das telas ou dos requisitos

## Próxima etapa

Arquitetura definida → `tdd` e `bdd`. A testabilidade que a arquitetura permite é o que
viabiliza os dois. Depois, a **stack** — que agora só precisa preencher os adaptadores.
