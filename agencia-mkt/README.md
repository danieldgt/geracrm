# agencia-mkt — operação de tráfego pago sobre o GeraCRM

> Visão de negócio e arquitetura de uma operação de mídia paga (agência) conduzida por agentes,
> construída **sobre** o GeraCRM. Este diretório é planejamento — não há código aqui ainda.

## O veredito: o GeraCRM serve de base

A avaliação linha a linha está em [`encaixe-no-geracrm.md`](encaixe-no-geracrm.md). Em resumo:

**Já existe e é reaproveitável sem reescrita** — multi-tenant com RLS (ADR-001), kanban de leads
com qualificação, gateway único de envio com opt-out e janela de 24h, motor de automações com
dedup transacional, atribuição de receita **exata × estimada separadas**, pedido efetivado no ERP
com valor em centavos, webhooks de saída assinados, auditoria e tempo real por SSE.

**Não existe e precisa ser construído** — todo o lado da **aquisição paga**: origem do lead
(UTM, `ad_id`, `click_id`), custo de mídia, integração com Meta/Google Ads, devolução de conversão
para as plataformas e reação a lead em segundos (hoje a varredura é de 5 em 5 minutos).

A lacuna é grande, mas é **aditiva e periférica**: entra como um contexto novo (`aquisicao`) e um
punhado de tabelas com prefixo `midia_`. Nada do núcleo precisa mudar de forma.

## A tese

Uma agência de tráfego pago ganha dinheiro em cinco blocos de trabalho. Os agentes não valem o
mesmo em todos eles:

| Bloco | Automatizável | Onde o GeraCRM entra |
|---|---|---|
| Estratégia e oferta | Baixo | — (trabalho humano) |
| Criativo em volume | **Alto** | novo — contexto `aquisicao` |
| Setup de campanha | Alto | novo — adaptadores de plataforma |
| Otimização de lance | **Baixo** ⚠️ | a plataforma já faz melhor que nós |
| **Gestão e qualificação de lead** | **Alto** | ✅ **já existe** |

⚠️ **O erro que define quem quebra:** colocar o esforço em "agente que otimiza campanha". É o bloco
onde o algoritmo da Meta/Google é imbatível e onde o agente só reseta a *learning phase*. O valor
está em criativo em volume e em **fechar o loop de qualidade do lead** — e é justamente o loop que
o GeraCRM já tem meio construído, porque conhece a venda efetivada no ERP.

## Documentos

| Documento | O que responde |
|---|---|
| [`visao-de-negocio.md`](visao-de-negocio.md) | O que vendemos, para quem, como cobra, o que a operação entrega |
| [`rede-de-pesca.md`](rede-de-pesca.md) | ⚠️ **A montante de tudo**: geração de demanda, destino do anúncio, públicos e estrutura de campanha |
| [`roteamento-do-lead.md`](roteamento-do-lead.md) | O instante da chegada: agente automático ou fila puxada por humano |
| [`fluxo-visual.md`](fluxo-visual.md) | **6 diagramas**: o ciclo do negócio, as duas redes, o fluxo ponta a ponta, o roteamento e as fases |
| [`encaixe-no-geracrm.md`](encaixe-no-geracrm.md) | O que reusa, o que falta, o que **não** deve reusar |
| [`arquitetura-agentes.md`](arquitetura-agentes.md) | Os papéis de agente, a orquestração e o que fica determinístico |
| [`limites-dos-agentes.md`](limites-dos-agentes.md) | ⚠️ O contrapeso: o que a automação **não** faz |
| [`stack.md`](stack.md) | O que já é da casa, o que entra de novo e o que fica de fora |
| [`loop-de-dados.md`](loop-de-dados.md) | Identidade do lead, atribuição honesta, CAPI e offline conversions |
| [`guardrails.md`](guardrails.md) | Dinheiro real, políticas de plataforma, LGPD, kill switch |
| [`roteiro.md`](roteiro.md) | As fases, na ordem em que reduzem risco |
| [`backlog-tecnico.md`](backlog-tecnico.md) | Os épicos AQ-xx: o que falta programar, com dependências |
| [`implementacao.md`](implementacao.md) | **O que já foi construído** e as decisões técnicas por trás |
| [`pesquisa-acesso-meta.md`](pesquisa-acesso-meta.md) | ⚠️ **A resposta à pergunta nº 0** — e o que ela reabre |
| [`decisoes.md`](decisoes.md) | ADRs desta operação (AMK-xxx) |
| [`perguntas-em-aberto.md`](perguntas-em-aberto.md) | O que depende de decisão do dono do produto |

## Convenções

As mesmas do repositório (ver `../CLAUDE.md`), sem exceção:

- Prosa em **pt-BR**; código e comentários em inglês; **domínio em português**
  (`Veiculacao`, `Criativo`, `Lead`, `Origem`).
- **`tenant_id` do token, nunca de parâmetro.** RLS em toda tabela nova.
- Dinheiro em **centavos inteiros** — ⚠️ as plataformas devolvem custo em *micros* (Google) e em
  float com ponto (Meta); a conversão acontece **na borda do adaptador**, nunca no domínio.
- **Toda lista paginada** por cursor. IDs UUID v7. Migrations aditivas e numeradas.
- **Só API oficial.** Automatizar a interface do Gerenciador de Anúncios derruba conta e Business
  Manager — é o equivalente, no lado da mídia, ao risco de banimento do canal não-oficial (ADR-021).

## Estado

**Fundação em código** (2026-08-20): schema de mídia, origem do lead, conversão de custo na borda e a porta de plataforma — tudo agnóstico de plataforma, verificado por 9 varredores de schema e 461 testes. Ver [`implementacao.md`](implementacao.md).

O resto é planejamento. O primeiro passo do [`roteiro.md`](roteiro.md) é a Fase 0
(só leitura), que não gasta um centavo de mídia e já produz valor.

**Onde começa** (AMK-011): na **família drezz/GeraCloud** — a própria Gera3 primeiro, depois
lojas dessa base — e só então venda para clientes de fora. ⚠️ É a decisão que destrava tudo: o
pré-requisito duro do produto é **ERP integrado**, e essa base já o tem.
