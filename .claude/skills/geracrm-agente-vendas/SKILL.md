---
name: geracrm-agente-vendas
description: >
  Construir, estender e depurar o AGENTE VENDEDOR do GeraCRM (ADR-023…027): fila com debounce,
  laço de ferramentas sob RLS, prompt em três blocos com cache, guardrail numérico, modos
  sombra/assistido/autônomo, propor-e-confirmar com alçada, handoff com contexto, auditoria por
  turno, playground e avaliação. Usar ao adicionar ferramenta, mudar prompt, trocar modelo, ligar
  o agente num cliente, ou investigar "por que o robô disse isso".
---

# Agente vendedor

O agente é a única parte do produto que fala com o cliente final em nome da marca sem ninguém
revisando. Tudo aqui existe para que ele **só diga o que o banco sabe** e para que cada decisão
seja **contestável**. Plano: `docs/plano-mestre-vendedor-autonomo.md`. Código:
`apps/api/src/contexts/atendimento/agente/`.

## O turno, de ponta a ponta

```
ingestão (tx) ──agendarTurno──▶ agente_tarefa (1 pendente/conversa, debounce 3 s)
workers/agente.ts (1 s, dono, FOR UPDATE SKIP LOCKED, serial por conversa)
  └─ vendedor.ts: config → portão → alçada do pedido confirmado → ferramentas →
     porta-llm.rodar (laço) → respostaDoAgente (Zod) → guardrail numérico →
     chegouMensagemNova? → modo → gateway → agente_sessao + agente_decisao → handoff
```

Regras que não admitem exceção:

- **Nenhuma regra de negócio no prompt.** Preço, estoque, desconto, alçada, mínimo: ferramenta
  devolve, código valida, guardrail confere. O prompt só diz ao modelo que ele não decide isso.
- **Número sem origem em ferramenta não sai.** `registroDeFerramentas` acumula `centavos` de toda
  chamada; `verificarNumerosNaResposta` (shared) bloqueia o resto e a resposta vira handoff
  `incerteza`. Toda ferramenta que mostra dinheiro devolve `centavos: centavosDe(saida)`.
- **O modelo nunca efetiva, nunca desconta, nunca apaga.** Não existe ferramenta para isso.
  `pedido_propor` manda o resumo pelo domínio; o "sim" é interpretado por
  `confirmacao-pedido.ts`; `efetivarSeDentroDaAlcada` decide; fora da alçada → fila.
- **Falha do modelo não é silêncio.** `handoffSemModelo` cria atendimento na fila, mensagem de
  sistema e notificação. O cliente nunca fica no vácuo com o agente ligado.
- **Modo nasce em sombra.** `sombra` decide e grava; `assistido` sugere (evento
  `agente.sugestao`); só `autonomo` envia. Trocar de modo tem efeito na próxima mensagem.
- **Atendimento aberto cala o agente** (na fila ou assumido). Quem reabre é a pessoa, encerrando.
- **PII mínima.** Prompt sem CPF/CNPJ/endereço; `mascarar()` antes de gravar em `agente_decisao`.

## Adicionar uma ferramenta

1. Declare a **porta** em `ferramentas/ligacoes-porta.ts` pelo que o vendedor precisa (nunca pelo
   formato do outro contexto). 2. Implemente em `ferramentas/ligacoes.ts` sobre o módulo público do
   contexto (`catalogo/busca.ts`, `pedido/montagem.ts`, `pedido/proposta.ts`). 3. Escreva a
   `Ferramenta<I>` em `ferramentas/<area>.ts`: `nome` em `snake_case` por recurso
   (`catalogo_*`, `pedido_*`), `descricao` dizendo QUANDO usar, `entrada` Zod **sem campos
   opcionais** (strict exige todos; use `.nullable()`), `executar` devolvendo `{ok, saida,
   centavos?, efeito?}` — nunca lançando. 4. Registre em `ferramentas/montar.ts` **por
   capacidade** (sem catálogo indexado, a ferramenta não entra no menu e o prompt diz isso).
   5. Teste com porta falsa em `vendedor.test.ts` e ensine o `llm-simulado.ts` a usá-la.

## Prompt (instrucao-vendedor.ts)

Três blocos: `BLOCO_GLOBAL` (igual para todos; cache), `blocoTenant` (persona, políticas,
método, capacidades, alçada; cache), `instrucaoDoTurno` (o que sabemos, resumo, pedido aberto,
hora — vai como **operador** dentro das mensagens, nunca no system). Mudar o bloco global é
mudança de comportamento: changelog + rodar as evals. Nada volátil no system (`cache_read_input_tokens`
zerando em produção = algo volátil entrou no prefixo).

⚠️ `respostaDoAgente.slots` é um `z.object` plano com cada slot opcional — nunca `z.record` nem
`z.partialRecord`: no Zod 4 o record com enum de chaves é exaustivo (`{}` reprova com "expected
string, received undefined" e o JSON Schema marca os 7 slots como obrigatórios, empurrando o modelo
a inventar), e os dois viram `propertyNames` no JSON Schema, que fornecedores gratuitos recusam
("Grammar error: Unimplemented keys"). O adaptador OpenAI-compatível normaliza slots nulos, vazios
ou com chave desconhecida antes do parse, e trata recusa de schema (mesmo em 200 com `error`) como
degrau de formato: json_schema → json_object → nenhum.

## Modelo

`fabrica-ferramentas.ts`: `IA_PROVEDOR = claude | simulado`; `ANTHROPIC_API_KEY`; `IA_MODELO`
(padrão `claude-opus-5-5`, effort `low`); `agente_config.modelo` sobrepõe por canal.
`claude-ferramentas.ts` usa o SDK oficial com `tool_choice: auto` + `strict: true` +
`output_config.format` — **forçar ferramenta devolve 400 nos modelos atuais**. `simulado` é um
vendedor de regras para testes/playground; recusado em produção.

## Catálogo de modelos (0093, `docs/estudo-modelos-llm.md`)

Três camadas: **catálogo** `modelo_ia` (global, mantido pela Gera3: fornecedor, id na API,
capacidades, custo, limite gratuito), **permissão** `tenant_modelo_ia` (staff decide por cliente;
sem linhas valem os `padrao_novos_tenants`), **escolha** `agente_config.modelo` (código do catálogo,
por número). A chave do fornecedor é NOSSA, no ambiente; fornecedor sem chave aparece como
indisponível com o nome da variável. Adicionar modelo = linha no catálogo (migration aditiva) +
rodar as douradas com `IA_E2E=1` nele. Fornecedores pelo fio OpenAI (`openrouter-ferramentas.ts`,
presets): openrouter, groq, gemini, cerebras, maritaca — o adaptador degrada formato
(json_schema → json_object → nenhum) e aceita texto cru; o guardrail numérico não depende do modelo.

## Playground e auditoria

`POST /v1/canais/:id/agente/simular` roda o agente REAL (ferramentas, catálogo, políticas) numa
conversa de simulação por canal, sem WhatsApp, gravando `agente_decisao` com `modo='simulacao'`.
`GET /v1/agente/decisoes` responde "por que o robô disse isso": ferramentas com argumentos e
resultado, resposta, confiança, números bloqueados, custo, latência, desfecho.

## Avaliação

- Determinístico (CI): `vendedor.test.ts`, `fila.test.ts`, `rotas-agente-vendedor.test.ts` e as
  conversas douradas de `evals/` com o modelo simulado.
- Real: `IA_E2E=1` roda as douradas contra o modelo de verdade e um juiz; nunca no CI.
- Métricas no painel: conversão em proposta/pedido, handoff por motivo, custo por conversa,
  latência p95, "corrigidas por humano".

## Checklist antes de ligar num cliente

- [ ] Catálogo indexado (`POST /v1/catalogo/reindexar`) e preços por perfil
- [ ] Políticas escritas (autônomo exige); persona com nome e loja
- [ ] Alçada decidida (padrão: tudo passa por vendedor)
- [ ] Uma semana em **sombra** lendo as decisões; depois assistido; só então autônomo
- [ ] Orçamento diário definido; `faltaConfigurar` vazio na tela
