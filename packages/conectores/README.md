# packages/conectores — Adaptadores de ERP

> Status: **não implementado**. ADR-008 decidido.

## Por que este pacote existe

**O GeraCRM é produto horizontal de integração.** Ele vive de conversar com o ERP que o cliente já
tem — GeraCloud e drezz primeiro, depois Bling, Tiny, TOTVS e ERPs de polo. **Cada conector novo é
mercado novo.**

⚠️ A diferença em relação ao drezz é de **postura**, não de stack: o drezz *é* o ERP da loja; nós
conversamos com o ERP de terceiros.

## A regra fundamental

⚠️ **A porta é definida pelo NOSSO domínio, nunca pela API do fornecedor.**

Se uma interface tiver método com nome de endpoint de ERP, não é porta — é SDK copiado, e o segundo
conector vai provar isso da pior forma.

```
        Domínio GeraCRM  (modelo canônico)
        Cliente · Produto · Pedido · Saldo · TabelaPreco · Credito
                     │  portas definidas por NÓS
   ┌─────────────────┼──────────────────┬────────────────┐
 GeraCloud         drezz              Bling         API pública
  ✅ tudo         ✅ tudo           ⚠️ parcial      universal
```

## Negociação de capacidade

Nem todo ERP entrega tudo. ⚠️ **Se o produto exigir o melhor caso, ele só vende para quem tem o
melhor ERP.**

Cada conector declara o que suporta — `ingestaoClientes`, `ingestaoProdutos`, `ingestaoPedidos`,
`cargaHistorica`, `saldoSincrono`, `tabelaPrecoSincrona`, `creditoCliente`, `escritaPedido`,
`webhookDeVenda` — e o produto **degrada em vez de quebrar**:

| Sem | Comportamento |
|---|---|
| `saldoSincrono` | Saldo da última sincronização, **com aviso e horário**; valida na efetivação |
| `escritaPedido` | Tira-pedidos vira **rascunho exportável** |
| `cargaHistorica` | RFV começa a contar da instalação, e a tela diz isso |

⚠️ **A capacidade é visível na interface, nunca silenciosa.** Usuário de ERP limitado precisa saber
*por que* o saldo tem hora.

## Os três contratos

1. **Ingestão em lote** — clientes, produtos, pedidos. Idempotente por chave de operação. Carga
   histórica com retomada e sem derrubar a primária.
2. **Leitura síncrona** — saldo por SKU, tabela de preço, crédito, durante a montagem do pedido.
   ⚠️ Timeout curto e degradação explícita: sem resposta em ~2s, a tela avisa e **bloqueia o envio**.
3. **Escrita de pedido** — idempotente, com retorno de número **ou erro tipificado**. ⚠️ Nunca
   string crua do ERP.

## Adaptador

Stateless, credencial recebida por chamada, **por tenant, cifrada em repouso**. ⚠️ Credencial de um
cliente jamais alcança outro.

Todo dado ingerido guarda **origem por campo** — com N ERPs escrevendo no mesmo cadastro, é preciso
saber quem escreveu o quê.

## Suíte de conformidade

**Uma suíte, rodada contra todo adaptador.** É o que prova que a porta é do nosso domínio.
Capacidade ausente é `skip`, não falha — e a **degradação também é testada**.

Regras completas: [`geracrm-conectores-erp`](../../.claude/skills/geracrm-conectores-erp/SKILL.md)
