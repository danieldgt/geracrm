# Capturar o `POST` de pedido do GeraCloud

O que falta para o CRM **efetivar pedido no ERP** (ADR-005). Todo o resto está
pronto: chave idempotente, estados, `resposta_perdida` → conferência, testes. Só
falta o **formato do corpo** de `POST /vendas/pedidos-catalogo`.

⚠️ **Por que não dá para deduzir:** o ERP não expõe especificação. `/v3/api-docs`,
`/swagger.json`, `/openapi.json` e mais cinco caminhos devolvem os mesmos 1418
bytes — o `index.html` do SPA respondendo a tudo. Chutar o corpo de um `POST` que
CRIA PEDIDO no ERP de um cliente é o pior lugar possível para chutar.

---

## Passo a passo

**Onde:** `https://apresentacao.geracloud.com.br` — a instância de apresentação,
não o ERP de um cliente real. Criar um pedido de teste ali tem risco baixo.

1. Abra o GeraCloud e faça login.
2. **F12** → aba **Network** (Rede).
3. No filtro, digite `pedidos-catalogo` — assim só o que interessa aparece.
   ⚠️ Deixe **"Preserve log"** marcado: sem isso, se a tela navegar depois de
   salvar, a requisição some antes de você olhar.
4. Monte um **pedido de catálogo de teste** — um cliente, um ou dois itens — e
   salve.
5. Clique na linha `pedidos-catalogo` que apareceu.

## O que copiar (nesta ordem de importância)

| Aba do DevTools | O que pegar |
|---|---|
| **Payload** (ou Request) | ⚠️ **o corpo inteiro** — é o essencial |
| **Response** | a resposta, principalmente onde vem o **número do pedido** |
| **Headers** | só a linha `Request URL` e o `Content-Type` |

O jeito mais rápido: clique com o botão direito na requisição → **Copy** → **Copy
as cURL** e me mande. Vem tudo junto.

⚠️ **Antes de colar aqui, apague o cabeçalho `Authorization`** (é um token de
acesso). Não preciso dele — tenho a credencial pela variável de ambiente. Se ele
vier junto por engano, avise para revogarmos.

---

## As quatro perguntas que a captura responde

O que eu preciso saber, e por quê:

1. **Como o cliente é identificado?** Nossa porta manda `clienteExterno` (o `id`
   de `/clientespdv`). O corpo espera esse id direto, um objeto `{ id }`, ou o
   CNPJ?

2. **Como o item é identificado?** Nós temos o `codigoBarra.id` (o SKU). O ERP
   espera esse id, o código de barras em texto, ou o id do produto + grade?

3. **O preço vai no corpo?** Se sim, em reais decimais (`89.90`) ou centavos?
   ⚠️ Isto é o que separa cobrar R$ 89,90 de cobrar R$ 8.990,00.

4. **Existe algum campo de referência externa?** Qualquer coisa como
   `observacao`, `numeroPedidoExterno` ou `referencia` que aceite um texto nosso.
   ⚠️ **É a pergunta mais importante depois do formato.** O ERP não tem
   idempotência (§6.2 de `conector-geracloud.md`): se houver um campo livre,
   gravamos a chave `pedidoId:versao` ali e a reconciliação depois de um timeout
   vira uma consulta exata. Sem ele, sobra busca heurística — mesmo cliente,
   mesmo valor, janela de minutos — que é ambígua por natureza e manda casos
   duvidosos para conferência humana.

---

## Depois que você mandar

Implemento `efetivarPedido` no adaptador do GeraCloud, viro
`escritaPedido: true` nas capacidades, e testamos criando um pedido de teste na
instância de apresentação — conferindo do lado do ERP que ele apareceu como
esperado.

⚠️ Só ligo a escrita depois desse teste passar. Enquanto isso, a degradação
continua honesta: o pedido confirmado fica esperando e a tela oferece o registro
manual (ADR-008).
