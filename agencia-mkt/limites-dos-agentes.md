# Onde os agentes não chegam

> ⚠️ Documento de contrapeso. Todo o resto desta pasta descreve o que a automação faz; este
> descreve o que ela **não** faz — e é o que separa uma operação honesta de uma que promete IA e
> entrega planilha automatizada.

## 1. O julgamento que continua humano

| O quê | Por que o agente não resolve |
|---|---|
| **Oferta e proposta de valor** | ⚠️ Oferta ruim não é salva por mídia. Nenhuma quantidade de criativo compra um produto que o mercado não quer pelo preço pedido. |
| **Explicar o CPA que subiu por causa externa** | Sazonalidade, concorrente novo entrando no leilão, mudança de algoritmo, notícia do setor. O agente vê a curva subir; ele não sabe **por quê**, e a resposta certa às vezes é *não fazer nada*. |
| **Relação e expectativa com o cliente** | Dizer "esse mês foi ruim e aqui está o motivo" é o trabalho que segura contrato. |
| **Risco de marca no criativo** | O revisor pega política de plataforma. Ele não pega "isso vai soar mal para o público **deste** cliente". |
| **Quando parar** | Decidir que uma conta não deveria receber mais verba é decisão comercial, não estatística. |

## 2. O risco estrutural: proxy contra objetivo

⚠️ **O agente otimiza o que consegue medir.** Se ele mede CPL e o objetivo real é LTV, ele degrada
a operação **silenciosamente** — com o painel melhorando o tempo todo. CPL caindo junto com a taxa
de qualificação não é vitória: é tráfego lixo entrando mais barato.

É por isso que o loop de dados (Fase 1) vem **antes** de qualquer automação de campanha, e por que
a devolução de conversão carrega o **valor da venda efetivada**, não a contagem de leads. Sem isso,
automatizar é acelerar na direção errada.

O sinal de alerta prático está em `guardrails.md` §6: **CPL despencou junto com a qualificação**.
Quem só olha o custo comemora.

## 3. Os limites do dado

- **Último clique é ficção útil** — credita quem fecha, não quem gerou a demanda.
- Somar os painéis das plataformas dá mais venda do que o ERP registrou.
- **Atribuição não decide alocação entre canais.** Isso é incrementalidade (geo holdout, conversion
  lift) e, com volume, MMM.
- ⚠️ Agente nenhum corrige viés de atribuição — ele o automatiza e o escala.

## 4. Os limites do modelo

- **Alucina campo bem formatado e errado.** CNPJ extraído de conversa passa por Zod e por dígito
  verificador antes de entrar no cadastro.
- **Regra de negócio no prompt falha em silêncio** e ninguém testa. Preço, prazo, saldo e teto de
  verba são domínio, não texto.
- **Prompt não se testa como código**, mas também não se ajusta por impressão — conjunto de casos
  reais, rodado a cada mudança.
- ⚠️ **Mudança de prompt é mudança de comportamento**: changelog e reversível.

## 5. O que isso implica para a venda

Não vender "IA que gerencia seu tráfego". Vender **margem e velocidade**, que são verificáveis:

- 3–5× mais contas por gestor, com a mesma qualidade;
- resposta ao lead em segundos, 24/7;
- ROAS até a venda no ERP, auditável.

⚠️ E vender o **pedaço de gestão de leads separado do tráfego** — ele funciona mesmo para o cliente
que já tem outra agência, e é a porta de entrada mais barata que existe nesta operação.
