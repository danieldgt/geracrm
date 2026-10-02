# Plano mestre — Vendedor autônomo no WhatsApp + CRM pronto para produto

> **Data:** 2026-10-02. **Dono:** produto. **Estado:** aprovado para execução nesta rodada.
> Substitui o escopo "SDR" de `agente-sdr-escopo.md` na parte em que ele dizia *"o agente NÃO é
> vendedor"*. A decisão de produto mudou: o agente **vende**. Os invariantes daquele documento
> (regra de negócio fora do prompt, opt-out no gateway, extração validada, auditoria, botão de
> desligar) continuam valendo e estão incorporados aqui.
>
> Documento-pai das frentes de trabalho. Cada frente tem fronteira de arquivos, contrato e
> definição de pronto, no formato da skill `workflow-agentes-programacao`, para poder virar um
> workflow paralelo. Decisões estruturais estão nos ADR-023 a ADR-027 em `decisoes.md`.

---

## 0. Veredito em dez linhas

| | |
|---|---|
| **O que existe** | Um SDR de uma chamada só: prompt + envelope JSON, sem ferramentas, sem catálogo, síncrono dentro do webhook (até 90 s), sem handoff real, sem auditoria por turno, sem debounce. Não cota preço por decisão, e o código quebra nos modelos atuais (`tool_choice: tool` retorna 400 em Opus 5.5 / Sonnet 5.5) |
| **O que o mercado exige em 2026** | Catálogo + RAG, pedido montado no chat com preço/estoque reais, confirmação explícita, handoff com resumo, memória do cliente, follow-up de carrinho, playground antes do go-live, métricas de conversão e custo. O Meta Business Agent faz quase tudo isso nativamente desde jun/2026 — com catálogo público. **Nenhum concorrente resolve "esse cliente tem limite, qual tabela dele"** — é a nossa vantagem (ADR-005/019) |
| **Decisão central** | Reescrever o laço do agente: **worker fora do webhook + laço de ferramentas sob RLS + retrieval híbrido em Postgres + propor-e-confirmar + três modos (sombra, assistido, autônomo)**. Agente ÚNICO com seções e ferramentas; nada de multiagente no turno (latência) |
| **Modelo** | `claude-opus-5-5` por padrão (regra da skill `claude-api`), `effort: low` no turno de chat, `IA_MODELO` continua trocando sem deploy. OpenRouter fica como reserva de **disponibilidade**, nunca de custo |
| **Catálogo** | Passa a existir **sem ERP**: CRUD manual de produto/SKU/preço/estoque (`sistema = 'manual'`), para vender nossos planos SaaS e, depois, roupas e qualquer item. ERP continua sendo uma origem, com origem por campo |
| **O que o modelo NUNCA faz** | Inventar preço, estoque, prazo ou desconto (vêm de ferramenta, no mesmo turno, e a resposta é verificada); efetivar pedido (o domínio efetiva a partir de uma proposta gravada, após o "sim" do cliente, com alçada); mandar campanha por conta própria |
| **Como se prova que funciona** | Suíte determinística (contrato de cada ferramenta, guardrail numérico, replay de conversas), conjunto dourado com juiz, playground na tela com transcrição e decisões por turno, modo sombra em tráfego real antes de ligar |
| **UI/UX** | A tela do agente vira um produto (persona, modo, conhecimento, playground, decisões, métricas); o CRM fecha os becos sem saída (ficha ↔ conversa ↔ pedido), adota a biblioteca de componentes que existe e ninguém usa, e ganha confirmação em ação destrutiva |
| **Padrão de projeto** | Novas skills (`geracrm-agente-vendas`, `geracrm-catalogo`), ADRs, e este plano com raias — para a próxima rodada rodar em workflows paralelos |
| **Ordem** | Fundação (worker + ferramentas + catálogo manual + auditoria) → vender (pedido + confirmação + alçada) → conhecer (KB + memória + embeddings) → mostrar (console + playground) → medir (evals + painel) → canal (interativos, áudio, Meta mídia) |

---

## 1. Diagnóstico (o que os seis levantamentos acharam)

### 1.1 Robô (apps/api/src/contexts/atendimento/agente)

- **Uma chamada por mensagem, sem ferramentas.** `instrucao.ts` manda políticas inteiras + "o que já sabemos" e pede um envelope `{texto, proximoPasso, extraido}`. Não lê catálogo, preço, estoque, pedidos nem sessões anteriores. `pedido/preco-de-venda.ts` existe e está comentado "o agente vai chamar" — não chama.
- **Síncrono dentro do webhook.** `rotas-webhook.ts` e `rotas-webhook-meta.ts` `await responderAutomaticamente()` antes do 200. Pior caso: 6 transações + envio de ausência + até 2 chamadas de 45 s no OpenRouter + envio. O comentário em `openrouter.ts:106` dizendo "fora do caminho do 2xx" está errado.
- **Sem debounce nem serialização.** Duas mensagens rápidas rodam dois turnos em paralelo; a segunda viola o índice único de sessão ativa DEPOIS de já ter enviado.
- **Handoff não existe.** `entregar` só muda `agente_sessao.estado`; não cria atendimento, não notifica, não resume. O escopo prometia "resumo, dados extraídos e motivo".
- **Falha do modelo = silêncio.** Encerra a sessão; ninguém é avisado (contradiz o invariante 5).
- **Auditoria rasa.** Nada guarda prompt, resposta crua, modelo, latência ou decisão do portão (só log). `extraido` é sobrescrito a cada turno.
- **Contrato quebrado nos modelos atuais.** `claude.ts` força `tool_choice: {type:'tool'}` — 400 em Opus 5.5 / Sonnet 5.5 / Fable 5.1. Modelo padrão `claude-sonnet-5` (geração anterior).
- **Meta:** mensagens não-texto nem são ingeridas (`rotas-webhook-meta.ts:78`).
- **Prompt contradiz o comportamento** ("FORA DO HORÁRIO… humano pela manhã" — mas desde 01/09 roda em horário comercial quando ninguém está).
- `rotearLead()` (shared) não é usado por ninguém; `capacidades` da porta nunca são lidas; não há custo por tenant.

### 1.2 Dados e pedido (grounding)

- Catálogo **só vem do ERP** (`integracao/ingestao-produtos.ts`). **Não há CRUD manual**, não há imagem, descrição rica nem `categoria` preenchida. Busca é `ILIKE` + trgm; sem FTS, sem vetores (`pg_trgm`, `unaccent` disponíveis; `vector` não está no Postgres local).
- Preço: a regra está em um lugar (`preco-de-venda.ts`, perfil varejo/atacado), mas **o cliente não tem perfil gravado** (`contato.modalidade` existe e não é usado) e **`POST /pedidos/:id/itens` aceita o preço do cliente** no corpo (o servidor não resolve).
- Sem checagem de estoque/crédito na montagem; só na efetivação (ERP). GeraCloud efetiva como **orçamento**.
- Fluxo de confirmação **já existe e é bom**: `enviar-resumo` → `aguardando_confirmacao` → "sim" conservador (`confirmacao-pedido.ts`) → `confirmado` → `efetivar` (idempotente, rascunho preservado, PED-08). O agente deve **reusar**, não reinventar.
- `perfil_vertical.regras_pedido` (mínimo, múltiplos de grade) existe e nada valida.
- `packages/shared` não tem schema de produto nem de pedido (tipos inline nas rotas).

### 1.3 Console

- 46 rotas reais, 1 placeholder. Padrão de 5 estados existe, mas cada tela reimplementa cabeçalho, esqueleto, vazio e erro; **a biblioteca `compartilhado/ui` não é usada por nenhuma tela** (nem o toast está montado no shell).
- **Formulários sem formulário:** nenhum reactive form, nenhuma validação por campo, nenhuma mensagem de sucesso. Campanhas engole erro em silêncio e **"Disparar" não confirma**. 30+ `catch {}` silenciosos.
- **Becos:** conversa não liga para a ficha; ficha não abre conversa nem pedido; funil sem link; pedido só em modal sem URL; catálogo sem "adicionar ao pedido"; sem breadcrumb; "Meu perfil" vai para config da empresa.
- **Sem cursor:** lista de conversas (`limite=40`), tarefas, campanhas, sequências, metas, automações, webhooks.
- **Fio solto:** rodapé compara versão da API lendo `/saude` que o nginx responde "ok"; sair do cliente (staff) não encerra a sessão no servidor; item de pedido não pode ser removido na tela (a API tem `DELETE`).

### 1.4 Testes e infra

- 105 specs na API contra Postgres real (não Testcontainers), fixtures inline por arquivo com UUIDs exclusivos; 9 specs no console (nenhum de componente); conformidade de conector aplicada só ao GeraCloud. CI roda lint/typecheck/test/build.
- Não há adaptador de canal falso; injeção local é pelo webhook do PlugZapi (`POST /webhooks/plugzapi/:canalId`). Sem Sentry; pino com redação de headers.

---

## 2. Visão do produto: o que o agente passa a ser

**Um vendedor da marca, no WhatsApp, 24/7 se o dono quiser**, que:

1. **Recebe e entende** (texto, áudio transcrito, imagem com legenda), agrupando rajadas de mensagens antes de responder.
2. **Sabe quem é o cliente** antes de abrir a boca: histórico de compras, RFV, perfil de preço, memória (preferências, objeções, restrições), pedidos em aberto.
3. **Descobre a necessidade** com perguntas de qualificação parametrizáveis (SPIN/BANT como *slots*, não script), sem perguntar o que já sabe.
4. **Recomenda do catálogo do tenant** por busca híbrida (lexical + semântica), com variações (cor/tamanho/plano), e cita preço/estoque **só do que a ferramenta devolveu neste turno**.
5. **Monta o pedido no chat** (rascunho de verdade, no servidor, com preço resolvido pelo domínio), trata objeções, sugere cross-sell por regra, e **propõe**: manda o resumo e pede confirmação explícita.
6. **Efetiva via domínio** quando o cliente confirma e a alçada permite (valor máximo, desconto zero sem aprovação); senão, entrega ao vendedor humano com contexto. Rascunho nunca se perde (ADR-005).
7. **Faz follow-up** de carrinho/proposta (1h/24h/72h) pelo gateway, com template no oficial, respeitando opt-out e consentimento.
8. **Para e chama humano** por regra (pedido de humano, reclamação, desconto fora da política, incerteza, sentimento, 2 incompreensões) — criando atendimento na fila com **resumo + intenção + dados + motivo**, e notificando.
9. **É auditável por turno**: ferramentas chamadas, argumentos, resultados, resposta, custo, latência, modo — e **cita a fonte** quando fala de preço/política.
10. **Nasce em modo sombra**, passa para assistido (vendedor aprova), e só então fica autônomo — por número.

Vende **SaaS** hoje (planos, módulos, demonstração, onboarding) e **produtos físicos** amanhã (roupas com grade, qualquer item) sem mudar de código: o que muda é o catálogo e o perfil vertical.

---

## 3. Arquitetura alvo

### 3.1 Fluxo de um turno

```
webhook (Meta | PlugZapi | Baileys)
  └─ ingere mensagem (tx) + agenda tarefa de turno (MESMA tx): agente_tarefa
       job por conversa, debounce 3 s (nova mensagem reagenda), responde 200
worker do agente (server.ts, dono, advisory lock, acordado por NOTIFY + varredura 1 s)
  ├─ pega 1 tarefa vencida por conversa (FOR UPDATE SKIP LOCKED), serial por conversa
  ├─ portão (modo/regras/janela/humano presente)            → decide entrar
  ├─ carrega contexto: persona + regras do canal | memória + perfil do cliente |
  │   resumo da sessão | últimas N mensagens | mensagens novas coalescidas
  ├─ "digitando" (capacidade do canal)
  ├─ laço de ferramentas (≤ 6 rodadas, ≤ 20 s) com @anthropic-ai/sdk
  │     catalogo_buscar · catalogo_detalhar · catalogo_preco_estoque · cliente_perfil ·
  │     conhecimento_buscar · pedido_ver · pedido_itens · pedido_propor ·
  │     atendimento_transferir · memoria_anotar · retorno_agendar
  ├─ saída estruturada {mensagens[1..3], confianca, handoff?}
  ├─ guardrails determinísticos (números vêm de tool_result; sem markdown; tamanho)
  ├─ verificação de sequência (chegou mensagem nova? descarta e reagenda)
  ├─ modo: sombra → grava sugestão | assistido → notifica vendedor | autônomo → envia
  ├─ envio pelo GATEWAY ÚNICO (opt-out, janela, estado do canal)
  └─ grava agente_decisao + outbox (tela atualiza) + custo por tenant
```

### 3.2 Decisões estruturais (resumo dos ADRs)

| ADR | Decisão | Por quê |
|---|---|---|
| **023** | Agente vendedor com laço de ferramentas sob RLS; agente único; modos sombra/assistido/autônomo por canal | Latência de chat não comporta multiagente; ferramentas são o jeito de o modelo só falar o que o banco sabe |
| **024** | Fila própria em Postgres (`agente_tarefa`) com debounce e serialização por conversa; worker no padrão já existente do `server.ts` | ADR-007 "sem broker"; migrations à mão (graphile/pg-boss trariam schema próprio); o padrão advisory lock + intervalo já está na casa |
| **025** | Catálogo com origem múltipla: ERP **e** manual; preço resolvido **sempre** no servidor; perfil de preço gravado no contato | Vender SaaS e roupas sem ERP; o cliente nunca manda preço no corpo; multi-ERP com origem por campo (ADR-008) |
| **026** | Retrieval híbrido em Postgres: FTS `portuguese` + `unaccent` + trgm (fase 1) e `pgvector` opcional (fase 2, degradação visível se a extensão faltar) | Sem serviço externo de busca; sob RLS; a semântica entra quando o ambiente tiver a extensão |
| **027** | Propor-e-confirmar: o modelo grava uma proposta; o "sim" do cliente é interpretado pelo domínio; a efetivação respeita alçada por canal | ADR-005 vale para o robô igual; incidente de 27/08 ("sim" confirmou o pedido errado) já mostrou o custo |

### 3.3 Modelo de dados (aditivo, migrations 0084+)

| Migration | O que | Observações |
|---|---|---|
| `0084_agente_vendedor.sql` | `agente_config`: `modo` (desligado/sombra/assistido/autonomo), `persona` jsonb (nome, tom, emojis, idioma, saudação), `objetivo` (vender/qualificar), `alcada` jsonb (valor_max_autonomo_centavos, desconto_max_pct=0, efetiva_sozinho bool), `qualificacao` jsonb (slots), `modelo` (override por canal, nullable); `agente_sessao`: `resumo`, `resumo_ate_mensagem_id`, `pedido_id`, `fase` (descoberta/recomendacao/proposta/fechamento/handoff) | `ativo` continua como derivado de `modo <> 'desligado'` para a versão anterior conviver |
| `0085_agente_tarefa.sql` | fila: `(tenant_id, id, conversa_id, canal_id, executar_em, tentativas, estado, chave)` + índice parcial pendentes + UNIQUE parcial por conversa pendente | debounce = `INSERT … ON CONFLICT (conversa pendente) DO UPDATE SET executar_em` |
| `0086_agente_decisao.sql` | uma linha por turno: mensagens_entrantes_ids[], modo, modelo, effort, ferramentas jsonb (nome, args, resumo do resultado, ms), resposta jsonb, confianca, handoff_motivo, usage jsonb, latencia_ms, custo_centavos_estimado, portao_motivo, enviada bool | RLS; índice (tenant, conversa, criado_em); retenção por tenant |
| `0087_catalogo_manual.sql` | `produto`: `origem` (erp/manual), `descricao_longa`, `categoria` já existe, `imagens` jsonb[], `atributos_fixos` jsonb; `tabela_preco` aceita `sistema='manual'`; `sku_saldo` idem; `contato.perfil_preco` (varejo/atacado, nullable) | Origem por campo (ADR-008): o integrador não sobrescreve `origem='manual'` |
| `0088_produto_indice.sql` | `produto_indice (tenant, produto_id, texto, fts tsvector GENERATED, texto_hash, embedding vector(1024) NULL, modelo, atualizado_em)` + GIN fts + GIN trgm; `hnsw` só se `vector` existir (DO block guardado) | config `pt_sem_acento` |
| `0089_conhecimento.sql` | `conhecimento_documento (id, titulo, tipo: politicas/faq/frete/pagamento/produto/outro, conteudo, versao, publicado_em)` + `conhecimento_trecho (documento_id, ordem, texto, fts, embedding NULL)` | `agente_config.politicas` vira o documento "Políticas" na migração de dados |
| `0090_cliente_memoria.sql` | `cliente_memoria (contato_id, tipo: preferencia/objecao/contexto/restricao, fato, origem_mensagem_id, confianca, valido_ate)` | só por ferramenta ou extração pós-conversa; nunca PII sensível |
| `0091_pedido_proposta.sql` | `pedido_proposta (pedido_id, versao_conteudo, resumo, total_centavos, enviada_em, expira_em, confirmada_em, confirmada_por: cliente/vendedor, mensagem_id)` + `pedido.origem` (humano/agente) | o "sim" só confirma a proposta cuja `versao_conteudo` ainda é a atual |
| `0092_agente_followup.sql` | `agente_retorno (conversa_id, motivo: proposta_sem_resposta/carrinho/combinado, executar_em, estado, tentativa)` | disparo pelo gateway; template no oficial |

### 3.4 Contratos (packages/shared — TypeScript puro)

- `dominio/agente-vendedor.ts`: `ModoAgente`, `Persona` (Zod), `Alcada` (Zod), `SlotsQualificacao`, `FaseDaVenda`, `MotivoHandoff`, `RespostaDoAgente` (Zod: `mensagens: string[1..3]`, `confianca 0..1`, `handoff?`), `decidirAlcada(total, alcada) → 'efetiva' | 'aguarda_vendedor'`, `verificarNumerosNaResposta(texto, numerosPermitidos)`.
- `dominio/catalogo.ts`: `ProdutoEntrada`, `SkuEntrada`, `PrecoEntrada` (Zod), `OrigemCampo`.
- `dominio/pedido.ts`: estados como união + `transicoesPermitidas`, `ItemPedidoEntrada` (Zod, **sem preço**).

### 3.5 Portas (apps/api)

- `atendimento/agente/porta-llm.ts`: `PortaModeloComFerramentas.rodar({ sistema: Bloco[], mensagens, ferramentas: DefinicaoFerramenta[], executar, limites, formatoSaida }) → ResultadoLlm<{ saida, rastro }>`; capacidades `{ ferramentas, saidaEstruturada, cachePrefixo, instrucaoEmMensagens }`.
- `atendimento/agente/ferramentas/porta.ts`: `Ferramenta<I,O> = { nome, descricao, entrada: ZodSchema, executar(ctx, entrada) → O }`; registro por capacidade do canal/tenant (sem ERP escrevendo → sem `pedido_efetivar` no menu do modelo, etc.).
- `catalogo/porta-embedding.ts`: `PortaEmbedding.embutir(textos, tipo: 'consulta'|'documento') → number[][]`; adaptador Voyage (`voyage-4`, 1024 dims) e `EmbeddingIndisponivel` (capacidade false → só lexical).

### 3.6 Prompt (persona de vendas)

Seções XML, prefixo congelado e cacheado em 3 pontos (global → tenant → conversa):
`<papel>` · `<politicas_do_tenant>` · `<regras_de_catalogo>` ("preço, estoque e desconto só existem se vieram de ferramenta NESTE turno; cite a tabela do cliente; não achou → diga e busque alternativa") · `<metodo_de_venda>` (slots) · `<escalonamento>` · `<formato>` (1–3 mensagens curtas, sem markdown, sem emojis além da persona) · `<exemplos>` (6 trocas pt-BR incluindo "não sei o estoque, vou confirmar" e um handoff). Nada volátil (data, nome, ids) no `system`; vai em bloco após o breakpoint ou como `role: system` dentro de `messages` (Opus 5.5 suporta).

### 3.7 Guardrails (em código, não no prompt)

1. Entrada de ferramenta validada por Zod (+ `strict: true`); saída validada antes de voltar ao modelo; erro vira `tool_result is_error`.
2. **Verificação numérica**: todo `R$` e toda quantidade na resposta precisa existir num `tool_result` do mesmo turno; falha → reescreve sem o número ou entrega.
3. Resultado de ferramenta embrulhado em `<dados_externos>`; texto do cliente só em `user`; instruções do operador por `role: system`.
4. Ferramentas de menor privilégio: sem apagar, sem alterar preço, sem acesso a outro contato; `pedido_efetivar` **não existe** para o modelo.
5. Alçada: `decidirAlcada()` no domínio; desconto = 0 sem aprovação; valor máximo por canal.
6. Limites: 6 rodadas, 20 s, 1.500 tokens de saída, 1 turno por conversa por vez, teto diário de custo por tenant (degrada para humano, nunca cala).
7. PII mínima no prompt (sem CPF/CNPJ completo, sem endereço); mascaramento em `agente_decisao` e logs.

---

## 4. Frentes de trabalho (raias)

Formato da skill `workflow-agentes-programacao`. **Se duas raias listam o mesmo arquivo, são uma só.**

### R1 — Núcleo do agente (worker, laço, auditoria) — *arquitetura, não delegável*
```
ARQUIVOS   apps/api/src/contexts/atendimento/agente/** (exceto ferramentas/catalogo*),
           apps/api/src/workers/agente.ts, infra/migrations/0084, 0085, 0086,
           apps/api/src/server.ts (bloco do worker), rotas-webhook*.ts (troca do await por agendar)
NÃO TOCAR  pedido/**, catalogo/**, console
CONTRATO   PortaModeloComFerramentas; Ferramenta<I,O>; RespostaDoAgente (shared)
PRONTO     webhook responde 200 em < 300 ms com agente ligado; duas mensagens em 1 s viram UM turno;
           turno grava agente_decisao; falha do modelo cria atendimento na fila + notificação;
           modo sombra não envia; testes: fila (debounce, serialização, concorrência), portão,
           laço com LLM falso (ferramentas chamadas na ordem, limites), guardrail numérico
```

### R2 — Catálogo próprio e retrieval
```
ARQUIVOS   apps/api/src/contexts/catalogo/** (novo contexto: rotas CRUD, indexador, busca híbrida,
           porta-embedding + adaptador voyage), infra/migrations/0087, 0088,
           packages/shared/src/dominio/catalogo.ts, apps/api/src/db/seed-demo.ts
NÃO TOCAR  agente/**, pedido/** (consome preco-de-venda.ts; não altera)
CONTRATO   buscarCatalogo(tx, {consulta, filtros, perfil, limite}) → itens com score, fonte;
           indexarProduto(tx, produtoId); PortaEmbedding
PRONTO     POST/PUT/DELETE produto/sku/preco/saldo manuais sob RLS; integrador não sobrescreve manual;
           busca "camiseta verde G" acha por FTS+trgm sem embedding; com `vector` presente, RRF
           inclui semântico; seed demo cria tenant "Demo" com 3 planos SaaS + 40 SKUs de roupas;
           testes: RLS dois tenants, origem por campo, RRF, degradação sem extensão
```

### R3 — Conhecimento e memória
```
ARQUIVOS   apps/api/src/contexts/atendimento/agente/conhecimento/**, memoria/**,
           infra/migrations/0089, 0090, rotas /v1/agente/conhecimento, /v1/contatos/:id/memoria
CONTRATO   buscarConhecimento(tx, pergunta) → trechos com documento/versão; anotarMemoria(); lerMemoria()
PRONTO     políticas atuais migradas para documento; trecho citado tem documento+versão;
           memória nunca grava CPF/CNPJ/endereço (teste); resumo da sessão regenerado a cada 10 turnos
```

### R4 — Pedido pelo agente (propor-e-confirmar, alçada)
```
ARQUIVOS   apps/api/src/contexts/pedido/** (rotas-pedido: preço resolvido no servidor; proposta.ts;
           alcada.ts), infra/migrations/0091, packages/shared/src/dominio/pedido.ts,
           apps/api/src/contexts/atendimento/agente/ferramentas/pedido*.ts
CONTRATO   adicionarItem(tx, pedidoId, {skuId, quantidade}) resolve preço por perfil do contato;
           proporPedido() reusa enviar-resumo + pedido_proposta; confirmarPedidoPorResposta() passa a
           exigir proposta vigente; decidirAlcada()
PRONTO     cliente nunca manda preço; "sim" só confirma a proposta da versão atual; acima da alçada →
           atendimento na fila com resumo; abaixo → efetiva pelo conector (ou degrada visível);
           regras_pedido do perfil vertical validadas; testes de concorrência e de versão
```

### R5 — Canal (ritmo humano e capacidades)
```
ARQUIVOS   apps/api/src/contexts/atendimento/canais/** (porta: digitando, interativos, capacidades),
           rotas-webhook-meta.ts (ingerir mídia), midia/transcricao/** (porta + adaptador),
           infra/migrations/0092, agente/retorno.ts (follow-up)
CONTRATO   PortaCanal.indicarDigitando?(), enviarLista?(), enviarBotoes?(); capacidades declaradas
PRONTO     Meta ingere imagem/áudio; áudio entrante transcrito em worker e visível abaixo do áudio;
           proposta no oficial sai com botões Confirmar/Alterar; não-oficial degrada para texto;
           follow-up 1h/24h/72h pelo gateway com opt-out; testes por capacidade (skip, não falha)
```

### R6 — Console: o agente como produto
```
ARQUIVOS   apps/console/src/app/funcionalidades/atendimento/agente/** (nova pasta: config, persona,
           conhecimento, playground, decisoes, metricas), nucleo/menu.ts (item), rotas.ts
CONTRATO   endpoints de R1/R3 + POST /v1/agente/simular (playground sem WhatsApp) + GET /v1/agente/decisoes
PRONTO     configurar persona/modo/alçada com validação por campo e toast; playground conversa com o
           agente real contra o catálogo do tenant e mostra ferramentas chamadas; lista de decisões
           com transcrição; 5 estados; claro/escuro; 320px; testado no Chrome
```

### R7 — Console: CRM sem becos e formulários de verdade
```
ARQUIVOS   apps/console/src/app/compartilhado/ui/** (adoção + ui-confirmar + toasts no shell),
           crm/ficha.pagina.ts (links conversa/pedido/tarefas), nucleo/inbox.servico.ts + inbox (link ficha,
           cursor na lista), pedido/pedidos.pagina.ts (rota /pedido/:id, remover item), campanha/campanhas
           (confirmar disparo, erros visíveis), catalogo/** (CRUD manual + "adicionar ao pedido"),
           shell (/saude via proxy, estado SSE), tarefas/sequencias/metas/automacoes/webhooks (cursor)
PRONTO     zero catch {} silencioso nas telas listadas; toda ação destrutiva confirma; sucesso tem toast;
           conversa ↔ ficha ↔ pedido linkados nos dois sentidos; listas por cursor; specs de regra pura
```

### R8 — Avaliação e observabilidade
```
ARQUIVOS   apps/api/src/contexts/atendimento/agente/evals/** (conjunto dourado jsonl, runner Vitest com
           LLM falso por fixture; runner real sob IA_E2E com juiz Opus 5.5), GET /v1/agente/metricas,
           custo por tenant (metrica_janela), console metricas
PRONTO     20+ conversas douradas (SaaS e roupas) passando no determinístico; juiz roda sob IA_E2E
           e grava score; painel: conversão em proposta/pedido, handoff por motivo, custo/conversa,
           latência p95, "corrigidas por humano"
```

### R9 — Skills e padrões de projeto
```
ARQUIVOS   .claude/skills/geracrm-agente-vendas/SKILL.md, geracrm-catalogo/SKILL.md,
           geracrm-ia/SKILL.md (atualizar), CLAUDE.md (estado + regras novas), docs/decisoes.md (ADR-023…027),
           docs/agente-sdr-escopo.md (nota de substituição), .claude/workflows/*.js (uma por raia)
PRONTO     skill nova explica porta, ferramentas, guardrails, evals e como adicionar ferramenta;
           workflows nomeados rodam `Workflow({name})` com briefing por raia
```

### R10 — Plataforma para vender o CRM (depois desta rodada)
White-label (logo/cores/domínio por tenant), módulos por plano com cadeado, onboarding guiado (número → catálogo → políticas → agente em sombra), LGPD (retenção, exclusão alcançando `agente_decisao`), Baileys fase 1, Instagram Direct com a Meta.

---

## 5. Ordem de execução nesta rodada

| Passo | Raias | Verificação |
|---|---|---|
| 1 | R9 (docs/ADR/skills esqueleto) | lint de markdown não existe; revisão por leitura |
| 2 | R1 + R2 (fase 1 lexical) + R4 — o núcleo que vende | `pnpm --filter @geracrm/api test` verde; webhook < 300 ms |
| 3 | R3 + R6 (config + playground) | Chrome: configurar persona, conversar no playground, ver decisões |
| 4 | R8 (determinístico + painel) | suíte de evals verde |
| 5 | R7 | Chrome: fluxo contato → conversa → pedido → ficha |
| 6 | R5 (digitando, Meta mídia, follow-up) | testes por capacidade |
| 7 | R2 fase 2 (embeddings) se `vector` disponível no Railway | degradação visível quando não |

Integração: uma raia por vez na `main`, suíte completa a cada integração, revisão adversarial (requisito reduzido em silêncio, caminho de erro, contrato inventado, teste que não testa).

---

## 6. Métricas que dizem se funciona

| Métrica | Alvo inicial |
|---|---|
| Latência fim do debounce → envio (p95) | ≤ 6 s |
| Webhook (p95) com agente ligado | ≤ 300 ms |
| Conversas que viraram proposta / pedido efetivado | medir; comparar sombra × humano |
| Handoff por motivo (incerteza × sucesso × regra) | incerteza < 20% após 30 dias |
| Respostas com número fora de `tool_result` | 0 (guardrail bloqueia) |
| Conversas corrigidas por humano | a métrica honesta; painel por semana |
| Custo por conversa (tokens + mensagens Meta) | ≤ R$ 1,50 em Opus 5.5 com cache |
| Cache hit (`cache_read_input_tokens`) | > 60% dos tokens de entrada |

---

## 7. Riscos e mitigação

1. **O modelo diz número errado** → ferramenta + verificação numérica + citação de fonte + modo sombra primeiro.
2. **Banimento no não-oficial com volume de robô** → INV-23 (throttle) antes de autônomo no não-oficial; aviso visível (ADR-021).
3. **Custo** → cache em 3 pontos, effort low, teto diário por tenant com degradação, Batch API para extração de memória.
4. **`vector` indisponível no Railway** → fase 1 é lexical; a semântica é capacidade declarada.
5. **Conflito agente × humano na mesma conversa** → agente cala ao detectar presença (já existe) e ao ser assumido; sessão encerra com motivo.
6. **LGPD** → PII mínima, mascaramento, retenção configurável, exclusão do titular alcança `agente_decisao` e `cliente_memoria`.

---

## 8. Estado da execução (atualizado em 2026-10-02)

| Raia | Estado | Entregue |
|---|---|---|
| R1 Núcleo | ✅ integrada | `agente_tarefa` (0085) com debounce/serialização, worker em `workers/agente.ts`, `PortaLlmFerramentas` + adaptadores Claude (SDK, strict, cache) / OpenRouter (tool_calls) / simulado, registro de ferramentas com `centavos` e guardrail numérico, modos, handoff com atendimento+sistema+notificação, `agente_decisao` (0086), config com modo/persona/alçada (0084), rotas de decisões, playground (`simular`) e métricas |
| R2 Catálogo | ✅ integrada | origem manual (0087), `produto_indice` híbrido (0088), CRUD `/v1/catalogo/produtos`, indexador, porta de embedding (Voyage), seed demo |
| R4 Pedido | ✅ integrada | `montagem.ts` (preço no servidor, perfil do contato), `proposta.ts` + `pedido_proposta` (0091), `alcada.ts`, regras do perfil vertical, "sim" só confirma a versão vigente |
| R3 Conhecimento/memória | 🔨 em execução | documentos versionados + trechos (0089), `cliente_memoria` (0090), resumo de sessão |
| R5 Canal | 🔨 em execução | digitação, mídia Meta, transcrição em worker, `agente_retorno` (0092) |
| R6 Console agente | 🔨 em execução | config/persona/alçada, playground, decisões, sessões |
| R7 Console CRM | 🔨 em execução | confirmações, toasts, becos, cursor, catálogo manual, item de pedido |
| R8 Evals | ✅ parcial | `evals/conversas-douradas.json` + runner (simulado no CI, `IA_E2E=1` real); métricas `/v1/agente/metricas`; falta juiz com rubrica e painel |
| R9 Skills/padrões | ✅ | `geracrm-agente-vendas`, `geracrm-catalogo`, ADR-023…027, workflows `revisar-raia` e `rodada-raias` |
| R10 Plataforma | ⏳ próxima rodada | white-label, módulos por plano, onboarding guiado, LGPD |

Pendências conhecidas: embeddings dos pendentes (worker) sem pgvector local; juiz LLM das douradas;
INV-23 (throttle) antes de autônomo no não-oficial; console em dev aponta para o tenant dogfooding.
