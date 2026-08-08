---
name: geracrm-ia
description: >
  Construir os recursos de IA do GeraCRM: copiloto de mensagem, transcrição de áudio, resumo de
  conversa, agente autônomo de qualificação, extração estruturada e base de conhecimento. Cobre a
  porta do domínio, controle de custo, latência, avaliação de qualidade, fallback e auditoria.
  Usar ao implementar ou depurar qualquer funcionalidade que chame modelo de linguagem.
---

# IA no GeraCRM

Duas camadas distintas, com riscos distintos:

| Camada | O que é | Risco |
|---|---|---|
| **Copiloto** (IA-01…04) | Sugere, o humano decide | Baixo — sugestão ruim é descartada |
| **Agente autônomo** (IA-05…09) | Atende e qualifica sozinho | ⚠️ Alto — fala com o cliente final em nome da marca |

⚠️ **Não trate as duas com o mesmo rigor.** O agente autônomo precisa de auditoria, limite e
handoff; o copiloto, não.

## A IA é adaptador, nunca domínio

- Entra por **porta definida pelo nosso domínio**, como qualquer integração externa
  (`arquitetura-limpa`).
- ⚠️ **Nenhuma regra de negócio mora no prompt.** "Pedido mínimo é 10 peças" é regra do domínio,
  validada em código. Se estiver só no prompt, ela falha silenciosamente e ninguém testa.
- Trocar de provedor é escrever outra implementação da porta.

## Copiloto de mensagem (IA-01)

O que faz o copiloto valer: **contexto real do cliente**, não template genérico.

Entram no contexto: cidade · categorias mais compradas · tempo sem comprar · nome da loja ·
segmento RFV · última interação.

- Gera **várias sugestões**, o atendente escolhe e edita. ⚠️ Nunca envia sozinho.
- Variação por contexto comercial (atacado / varejo).
- ⚠️ **Dado sensível não vai para o prompt sem necessidade.** CPF, CNPJ completo e endereço não
  melhoram a sugestão — e saem do nosso perímetro.

## Transcrição (IA-03)

Assíncrona, em worker. ⚠️ Nunca no caminho da requisição — áudio de 3 minutos não pode segurar a
tela.

A transcrição aparece **abaixo do áudio**, nunca no lugar dele: erro de transcrição acontece, e o
atendente precisa poder ouvir.

## Agente autônomo (IA-05…09)

O que o agente precisa **antes** de falar com cliente:

- □ **Base de conhecimento** da marca, versionada
- □ **Limite de escopo** explícito — o que ele não responde
- □ **Handoff para humano** por regra e por incerteza, com contexto
- □ **Painel de auditoria**: leads atendidos, qualificados, desqualificados, **tempo até
  qualificação**, canal, origem
- □ **Registro de toda conversa** conduzida por ele
- □ **Botão de desligar**, por número e por tenant

⚠️ **Qualificação é decisão de negócio, e precisa de motivo registrado.** "Desqualificado" sem
razão auditável é ruído que ninguém consegue contestar.

⚠️ **Extração estruturada é validada como qualquer entrada externa** — CNPJ extraído da conversa
passa por Zod e por dígito verificador antes de entrar no cadastro. O modelo alucina campo bem
formatado e errado com facilidade.

## Custo e latência

A IA é uma das maiores linhas de custo variável do produto (§11 de `stack-arquitetura.md`).

- **Meça por tenant e por funcionalidade** — sem isso, não há como precificar plano nem detectar
  abuso.
- **Cache de resposta** para pergunta repetida na base de conhecimento.
- **Limite por tenant**, com comportamento definido ao estourar (degradar para humano, não falhar).
- ⚠️ **Escolha o tamanho do modelo pela tarefa.** Classificar intenção e gerar sugestão de mensagem
  não exigem o mesmo modelo. Usar o maior para tudo é desperdício que aparece na fatura.

## Fallback

⚠️ **Provedor de IA fora do ar não pode derrubar o produto** (circuit breaker, §9.4 da stack).

| Recurso | Sem IA |
|---|---|
| Copiloto | Botão some ou fica indisponível com aviso; o atendente escreve normalmente |
| Transcrição | Áudio continua tocável; transcrição entra depois |
| Agente autônomo | ⚠️ Conversa vai para a **fila humana**, nunca fica sem resposta |

## Avaliação de qualidade

Prompt não se testa como código — mas também não se ajusta por impressão.

- Mantenha um **conjunto de casos reais** com o resultado esperado, e rode contra ele ao mudar
  prompt ou modelo.
- Métricas do produto que revelam degradação: taxa de qualificação, tempo até qualificação, taxa de
  handoff, e — a mais honesta — **quantas sugestões do copiloto são enviadas sem edição**.
- ⚠️ **Mudança de prompt é mudança de comportamento.** Vai para o changelog e é reversível.

## Testes

- IA **mockada por contrato** nos testes automatizados. ⚠️ Nunca chamar o provedor no CI.
- Teste real é manual e etiquetado (`it.skipIf(!process.env.IA_E2E)`).
- Cobrir: extração inválida sendo rejeitada · handoff por incerteza · comportamento com provedor
  fora · limite de custo estourado.

## LGPD

- Conversa de cliente enviada a provedor externo é **tratamento de dado pessoal**. Precisa estar na
  política e no contrato.
- ⚠️ Verificar retenção do provedor. "Não treina com seus dados" e "não armazena" são coisas
  diferentes.
- Exclusão do titular (CTT-15) precisa alcançar o que foi enviado à IA, quando aplicável.
