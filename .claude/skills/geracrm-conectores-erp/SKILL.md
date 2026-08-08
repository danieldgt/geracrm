---
name: geracrm-conectores-erp
description: >
  Construir e manter conectores de ERP no GeraCRM: modelo canônico, portas definidas pelo domínio,
  declaração de capacidades, degradação em vez de quebra, ingestão em lote, leitura síncrona,
  escrita idempotente de pedido, carga histórica e suíte de conformidade. Usar ao criar adaptador
  novo (GeraCloud, drezz, Bling, Tiny…), alterar contrato de integração, ou depurar dado divergente
  entre CRM e ERP.
---

# Conectores de ERP

Decisão no ADR-008. **O GeraCRM é produto horizontal de integração** — vive de conversar com o ERP
que o cliente já tem. Cada conector novo é mercado novo.

⚠️ **A diferença em relação ao drezz é de postura, não de stack.** O drezz *é* o ERP da loja. Nós
conversamos com o ERP de terceiros. Copiar a stack faz sentido; copiar a postura, não.

## Modelo canônico + porta do domínio

```
        DOMÍNIO GeraCRM  (modelo canônico, nosso)
        Cliente · Produto · Pedido · Saldo · TabelaPreco · Credito
                        │ portas definidas por NÓS
     ┌──────────────────┼──────────────────┬──────────────┐
 GeraCloud            drezz              Bling         API genérica
```

⚠️ **A porta é definida pela necessidade do domínio, nunca pela API do fornecedor.** Se a interface
tem método com nome de endpoint de ERP, não é porta — é SDK copiado, e o segundo conector vai
provar isso da pior forma.

⚠️ **Só o contexto `integracao` conhece formato de ERP.** Se `pedido` souber que existe um campo
chamado como o do GeraCloud, a abstração já vazou.

## Adaptador

- **Stateless**, credencial recebida por chamada — mesma forma do `Adquirente` do drezz (ADR-011 de lá).
- Credencial é **por tenant**, cifrada em repouso. ⚠️ Credencial de um cliente nunca alcança outro.
- Todo dado ingerido guarda **origem por campo**. Com N ERPs escrevendo no mesmo cadastro, é
  preciso saber quem escreveu o quê — senão ninguém explica por que o nome mudou sozinho.

## Capacidades — o que faz o produto vender para qualquer ERP

Nem todo ERP entrega tudo. Bling e Tiny têm API rica; um ERP de polo pode só exportar CSV.
⚠️ **Se o produto exigir o melhor caso, ele só vende para quem tem o melhor ERP.**

```ts
capacidades = {
  ingestaoClientes:    true,
  ingestaoProdutos:    true,
  ingestaoPedidos:     true,
  cargaHistorica:      true,
  saldoSincrono:       true,   // GeraCloud: sim
  tabelaPrecoSincrona: true,
  creditoCliente:      true,
  escritaPedido:       true,
  webhookDeVenda:      false,  // se false, sincroniza por polling agendado
}
```

### Degradação, não quebra

| Capacidade ausente | Comportamento |
|---|---|
| `saldoSincrono` | Saldo da última sincronização, **com aviso e horário**; validação de estoque migra para a efetivação (PED-08 já trata a falha) |
| `tabelaPrecoSincrona` | Preço da última carga, com aviso |
| `creditoCliente` | Bloco de crédito **não aparece** — não aparece desabilitado |
| `escritaPedido` | Tira-pedidos vira **rascunho exportável**; lançamento no ERP é manual |
| `webhookDeVenda` | Sincronização agendada; a latência da atribuição 3/7/14d é **declarada na interface** |
| `cargaHistorica` | RFV começa a contar da instalação, e a tela diz isso |

⚠️ **A capacidade é visível na interface, nunca silenciosa.** O usuário de um ERP limitado precisa
saber *por que* o saldo tem hora — senão conclui que o produto está errado.

## Os três contratos

### 1. Ingestão em lote
Clientes, produtos/estoque, pedidos. Fluxos independentes e combináveis.
⚠️ **Idempotente por chave de operação** — reenvio não duplica.
**Carga histórica** em lotes, com retomada de onde parou e sem derrubar a primária.

### 2. Leitura síncrona ao vivo
Saldo por SKU, tabela de preço do cliente, limite de crédito — **durante a montagem do pedido**.

⚠️ **Timeout curto e degradação explícita.** Sem resposta em ~2s, a tela avisa e **bloqueia o
envio**. Nunca deixar montar às cegas para falhar depois.

### 3. Escrita de pedido
⚠️ **Idempotente**, com retorno de número do pedido **ou erro tipificado** — nunca string crua do
ERP. Os erros que a tela precisa distinguir (PED-08):

| Erro | O que a tela oferece |
|---|---|
| Estoque esgotado | Nomear o SKU e o saldo; ajustar ou remover |
| Crédito bloqueado | Valor do pedido vs. disponível; solicitar liberação ou reduzir |
| Item inativado | Remover ou buscar substituto |
| Cliente sem cadastro fiscal | Abrir a ficha para completar |
| Falha de comunicação | **Tentar novamente** — a idempotência garante que não duplica |

⚠️ **Falha na efetivação nunca perde o rascunho.** É aqui que produtos desse tipo morrem na
prática: se a vendedora perde o pedido montado, ela volta a lançar no ERP e abandona a ferramenta.

## Circuit breaker

ERP fora do ar degrada **localizado**: o inbox continua mostrando histórico, o pedido bloqueia com
aviso claro. ⚠️ Uma integração ruim não pode derrubar o produto.

## Suíte de conformidade

**Uma suíte, rodada contra todo adaptador.** É o que prova que a porta é do nosso domínio.

```ts
describe.each(conectores)('conformidade — %s', (conector) => {
  it('ingestão de cliente produz o modelo canônico completo', ...)
  it('reenvio da mesma operação é idempotente', ...)
  it.skipIf(!conector.capacidades.saldoSincrono)('saldo responde dentro do timeout', ...)
  it.skipIf(!conector.capacidades.escritaPedido)('escrita retorna número ou erro tipificado', ...)
})
```

⚠️ **Capacidade ausente é `skip`, não falha.** ERP sem saldo síncrono não é conector quebrado.
E a **degradação também é testada**.

Conector mockado **pelo contrato**, com fixtures reais (sucesso, recusa tipificada, timeout).
⚠️ Proibido stub ad-hoc de `fetch`. ERP real só em teste manual etiquetado, nunca no CI.

## Ao criar um conector novo

1. Ler a documentação do ERP e **mapear para o modelo canônico** — não o contrário
2. Preencher a declaração de capacidades **antes** de escrever código
3. Implementar ingestão primeiro (é o que alimenta RFV e faz o produto ter valor)
4. Rodar a suíte de conformidade e confirmar que os `skip` são os esperados
5. Verificar a interface com aquelas capacidades: os avisos de degradação aparecem?
6. ⚠️ Só então leitura síncrona e escrita de pedido

**A API pública (INT-02) é o conector universal** — para todo ERP sem adaptador dedicado. Ela nunca
pode ser menos capaz que um adaptador nativo, senão amarramos o produto aos ERPs da casa.
