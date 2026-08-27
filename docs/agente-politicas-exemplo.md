# Políticas da loja — o texto que o agente lê

Modelo para o campo **Políticas da loja** em *Atendimento → Agente SDR*. É o lado
curado da base híbrida (§4.2 de `agente-sdr-escopo.md`): o catálogo e o estoque
vêm do ERP; isto aqui é o que só o dono sabe.

---

## As quatro regras que decidem se isso funciona

**1. ⚠️ O que você escreve vira PROMESSA na voz da sua marca.**
Se estiver escrito "entregamos em 2 dias", o agente vai dizer isso a um cliente,
às 23h, sem ninguém revisando. Escreva só o que a operação cumpre num dia ruim,
não no melhor dia.

**2. ⚠️ O que você NÃO escreve vira ENTREGA PARA HUMANO.**
Essa é a alavanca, e ela é segura por construção: assunto que não está no texto
faz o agente chamar uma pessoa em vez de inventar. Começar com um texto curto e
crescer é mais barato que o contrário — texto grande demais faz o robô responder
coisas que você preferia que ele não respondesse.

**3. ⚠️ Não escreva preço.**
O agente está proibido de cotar valor, e é de propósito: a tabela de preço por
cliente ainda não é resolvida pelo conector (§4.5 do escopo), então qualquer
número aqui viraria preço errado dito com confiança.

**4. Frases curtas e afirmativas.**
Não é contrato — é o que o robô vai parafrasear. "Aceitamos PIX e cartão" rende
melhor que "a modalidade de pagamento poderá ser efetuada via...".

---

## Exemplo pronto (troque o que está entre colchetes)

```
SOBRE A LOJA
Somos a [Nome da Loja], em [Cidade/UF]. Vendemos [ex.: moda feminina e acessórios].
Atendemos varejo e atacado.

ATACADO
Pedido mínimo de atacado: [20] peças.
Para comprar no atacado é necessário CNPJ ativo.
Não trabalhamos com consignação.

PAGAMENTO
Aceitamos PIX e cartão de crédito.
Boleto apenas para clientes com cadastro aprovado.

ENTREGA
Enviamos para todo o Brasil pelos Correios e por transportadora.
Separação em até [2] dias úteis após a confirmação do pagamento.
O prazo do transporte depende do endereço e é confirmado no fechamento do pedido.
Retirada na loja: sim, com agendamento.

TROCA E DEVOLUÇÃO
Trocas em até [7] dias corridos após o recebimento, com etiqueta e nota fiscal.
Peças de promoção final não têm troca.

HORÁRIO
Segunda a sexta, das 9h às 18h. Sábado até as 13h. Domingo fechado.

O QUE NÃO RESPONDEMOS POR AQUI
Preço de item específico, disponibilidade em estoque e prazo exato de entrega:
quem confirma é a equipe pela manhã.
Pedido já feito, cobrança, nota fiscal e reclamação: sempre com uma pessoa.
```

---

## Por que a última seção existe

**"O QUE NÃO RESPONDEMOS POR AQUI" é opcional e vale o espaço que ocupa.**

Sem ela, o agente decide sozinho o que está fora do escopo — e decidir por
inferência é onde ele erra. Com ela, a fronteira é declarada: o modelo lê
"reclamação sempre com uma pessoa" e entrega, em vez de tentar acalmar alguém
irritado às 23h em nome da sua marca.

⚠️ **Não é redundante com as regras internas do agente.** Aquelas dizem *como*
ele se comporta; esta seção diz *o que este negócio específico* não quer que um
robô toque.

---

## O que NÃO colocar aqui

| Não escreva | Por quê |
|---|---|
| Preço, desconto, condição especial | O agente não cota (§4.5), e vira promessa |
| Regra de negócio do sistema (pedido mínimo que o CRM valida) | Regra vive em código, não em prompt — no prompt ela falha em silêncio |
| Dado de cliente ou de fornecedor | Este texto vai inteiro para o provedor de IA a cada mensagem |
| Instrução para o robô ("seja simpático") | O tom já está na instrução do sistema; aqui é informação da LOJA |

---

## Depois de escrever

O agente **não liga** com este campo vazio — é recusado pela tela e pelo banco.
Agente ligado sem base responde "não sei" a tudo: gasta a paciência do cliente e
o dinheiro do dono para não informar nada.

Escreveu, ligou: ele passa a atender **fora do expediente**, sempre **depois** da
resposta de ausência, e some da conversa assim que um humano aparece. O que ele
falou fica na mesma tela, com o que colheu e o que foi recusado.
