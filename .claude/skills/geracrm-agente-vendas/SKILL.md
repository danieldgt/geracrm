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
  └─ vendedor.ts: config (lerConfig → cfg.extra) → PIPELINE → gateway → agente_sessao + agente_decisao
```

### Pipeline de ordem fixa (ADR-029)

`agente/pipeline/index.ts` (`PIPELINE_PADRAO`) — a ordem só muda ali:

```
modoEfetivo → [portão] → gatilhos → slots → teto(pré) → LLM → [guardrail R$] →
números → filtro → pergunta → qualidade → envio → teto(pós)
```

| Etapa | Arquivo | O que faz |
|---|---|---|
| modoEfetivo | `pipeline/modo-efetivo.ts` | mais restritivo entre `agente_tenant.modo_maximo`, número e recorte; falha fechada em `sombra` |
| gatilhos | `pipeline/gatilhos-entrada.ts` | sem token: opt-out (confirma antes de bloquear; "cancelar pedido" não é opt-out), humano, reclamação/Procon, "é robô?" (1ª fixa, 2ª handoff), áudio, abertura com identificação e aviso de privacidade |
| slots | `pipeline/slots-do-cliente.ts` | o que o cliente já disse (volume, prazo, orçamento, tipo de compra, CNPJ) vira instrução, nunca dígito |
| teto | `pipeline/teto-conversa.ts` | teto da sessão antes (handoff com aviso em autônomo) e depois (responde e transfere) |
| números | `pipeline/numeros-ampliados.ts` | %, quantidade e prazo só com fonte no turno (ferramenta, política, conhecimento, cliente) |
| filtro | `pipeline/filtro-saida.ts` | frases proibidas com regra de negação + compliance extra do número e do playbook |
| pergunta | `pipeline/pergunta-repetida.ts` | Jaccard ≥ 0,7 contra a pergunta anterior; troca pela próxima pendente |
| qualidade | `pipeline/regras-qualidade.ts` | regras em 100%; CRÍTICA não sai (autônomo → handoff `qualidade_violacao_critica`; assistido → "não envie") |
| falha | `pipeline/falha-llm.ts` | política de falha do LLM (ADR-030) |

**Onde estender:** regra nova é etapa (ou função pura no shared `agente-*.ts`) com teste isolado — nunca
`vendedor.ts`. Contratos em `pipeline/tipos.ts`: `DecisaoPreLlm` (`segue` | `resposta_fixa` | `handoff` |
`silencio`), `EtapaPosResposta`, `MarcaGuardrail {etapa, codigo, gravidade, acao, trecho?}`. Estado por
sessão em `agente_sessao.estado_agente` (`estado-agente.ts`, uma chave por etapa). Teste trocando a
etapa por uma falsa: `montarPipeline({ filtro: etapaFalsa })`. O pipeline vale igual em autônomo,
assistido, sombra, simulação e copiloto.

**Guardrails que não têm chave de desligar:** filtro base, número só com fonte, opt-out, handoff
obrigatório, identificação como assistente, `pedido_efetivar` fora do modelo. A tela e o playbook só
**acrescentam** restrição.

Regras que não admitem exceção:

- **Nenhuma regra de negócio no prompt.** Preço, estoque, desconto, alçada, mínimo: ferramenta
  devolve, código valida, guardrail confere. O prompt só diz ao modelo que ele não decide isso.
- **Número sem origem em ferramenta não sai.** `registroDeFerramentas` acumula `centavos` de toda
  chamada; `verificarNumerosNaResposta` (shared) bloqueia o resto e a resposta vira handoff
  `incerteza`. Toda ferramenta que mostra dinheiro devolve `centavos: centavosDe(saida)`.
- **O modelo nunca efetiva, nunca desconta, nunca apaga.** Não existe ferramenta para isso.
  `pedido_propor` manda o resumo pelo domínio; o "sim" é interpretado por
  `confirmacao-pedido.ts`; `efetivarSeDentroDaAlcada` decide; fora da alçada → fila.
- **Falha do modelo não é silêncio.** A política (`pipeline/falha-llm.ts`, ADR-030) classifica a falha;
  em autônomo o cliente sempre recebe aviso (sem prazo) e a conversa vai à fila com resumo
  determinístico; todo caminho abre o alerta `agente_llm_indisponivel`.
- **Modo nasce em sombra.** `sombra` decide e grava; `assistido` sugere no inbox; só `autonomo` envia.
  Trocar de modo tem efeito na próxima mensagem.
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

`fabrica-ferramentas.ts`: `IA_PROVEDOR = claude | openrouter | groq | gemini | simulado`; chave do
fornecedor (`ANTHROPIC_API_KEY`…); reserva `IA_RESERVA_PROVEDOR`/`IA_RESERVA_MODELO` (skill `geracrm-ia`); `IA_MODELO`
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

## Base de conhecimento (tela e API)

Aba **Conhecimento** na tela do agente: documentos por tipo (políticas/faq/frete/pagamento/troca/
produto/outro), globais ou do número, versionados; "testar a base" mostra os trechos com título,
versão, score e as pernas (`lexical`/`trgm`/`semantica`). Importar arquivo (`.txt/.md/.pdf`) passa por
`POST /v1/agente/conhecimento/extrair`, que devolve o TEXTO para revisão — nunca salva sozinho; PDF
sem camada de texto é 422 `conhecimento.sem_texto` (sem OCR). O documento de políticas do canal
espelha `agente_config.politicas` nos dois sentidos. Capacidade e pendências de embedding em
`GET /v1/agente/conhecimento/capacidades`; "Embutir agora" em `POST …/embutir` (409 quando a
semântica está desligada). Regras do retrieval na skill `geracrm-catalogo`.

## Playground e auditoria

`POST /v1/canais/:id/agente/simular` roda o agente REAL (ferramentas, catálogo, políticas) numa
conversa de simulação por canal, sem WhatsApp, gravando `agente_decisao` com `modo='simulacao'`.
`GET /v1/agente/decisoes` responde "por que o robô disse isso": ferramentas com argumentos e
resultado, resposta, confiança, números bloqueados, custo, latência, desfecho.

## Modos, recorte e kill switch (ADR-028)

- Vocabulário: `desligado`, `sombra`, `assistido` (**sugere**), `autonomo`. O "assistido" da AM é o
  nosso `autonomo` com recorte.
- **Recorte** (`agente_config.recorte`, shared `agente-modo.ts`): horário, feriado conta como
  `fora`|`dentro` (padrão `fora`), segmentos RFV, `foraDoRecorte` (padrão `sombra`).
- **O mais restritivo vence**: `decidirModoEfetivo` (puro) entre teto da conta (`agente_tenant`,
  `GET/PUT /v1/agente/tenant` = kill switch), número e recorte. Use `modoEfetivoDoCanal` /
  `modoEfetivoSeguro` em qualquer caminho que fale com o cliente (retorno, ausência, digitação, copiloto).
- `autonomo` e `desligado` exigem confirmação digitada (422 `agente.confirmacao_necessaria`) e admin;
  todo PUT de configuração audita `agente.config_alterada {antes, depois}`.
- Retorno fora do recorte só por horário/feriado é adiado até a abertura; kill switch e segmento
  cancelam.

## Playbook versionado (ADR-033)

`agente/playbook/`, shared `agente-playbook.ts`, rotas `/v1/agente/playbook/*`. Conteúdo: estilo,
persona, qualificação, mensagens prontas (inclui `avisoEspera` do SLA), compliance extra (só acrescenta)
e ações habilitáveis (`catalogo`, `pedido`, `proposta`, `memoria`, `conhecimento`). Transferir, perfil
do cliente, opt-out, humano, identificação, filtro base, números e `pedido_efetivar` ficam sempre
ligados (`SEMPRE_LIGADAS_PLAYBOOK`). Rascunho → simular (modo seco, memória não grava) → publicar
(admin, observação ≥ 10, auditoria) → versão imutável; restaurar cria versão nova. **Fato** vai para o
conhecimento; **conduta** para o playbook; **parâmetro** para `agente_config`.

## Qualidade em produção e revisão humana (ADR-031)

- Regras em 100% (shared `agente-qualidade.ts`, `avaliarRegrasQualidade`), gravidade
  `CRITICA|ALTA|MEDIA|INFO`; CRÍTICA pausa a conversa e abre `agente_violacao_critica`.
- Juiz amostrado (`workers/qualidade.ts`, `qualidade/juiz.ts`): amostra estável FNV-1a
  (`qualidade_amostra`; padrão sombra 1,0, assistido 0,2, autônomo 0,05), fim de sessão e a cada 10
  turnos, rubrica única do shared, teto mensal por número. Resultado em `agente_avaliacao`;
  `GET /v1/agente/qualidade` (cursor), `/resumo`, `/amostra-semanal.csv`.
- Revisão humana (`revisao-humana.ts`, `/v1/agente/revisao/*`): 20 por número, cega até gravar, 1ª
  gravação imutável, uma revisão por conversa e semana, meta ≥ 85% com ≥ 20 e 0 falso negativo
  crítico. Procedimento: `docs/agente-revisao-semanal.md`.

## Sugestão do assistido e copiloto

`agente/sugestao.ts`, `rotas-sugestao.ts`, shared `agente-sugestao.ts`. A sugestão é uma
`agente_decisao` já passada pelo pipeline; as marcas viram avisos por gravidade; `nao_envie` bloqueia o
envio inalterado (422 `sugestao.bloqueada`). `GET /v1/conversas/:id/sugestao`; copiloto em
`POST /v1/conversas/:id/sugestao/gerar` (só leitura, 20 s, 502 `copiloto.indisponivel`, 503
`copiloto.ocupado` acima de `COPILOTO_MAX_SIMULTANEOS`, concessão com TTL em `copiloto_geracao`); envio
humano com `sugestaoDecisaoId` grava `enviada`/`editada` + similaridade; `sombra_similaridade` compara
sombra × humano (sinal a calibrar). Métricas: `GET /v1/agente/sugestoes/metricas`.

## SLA do handoff (ADR-034)

Todo handoff arma o SLA (`sla-handoff.ts`: `armarSlaDoHandoff`, `rotearHandoff` dono → pool → gestor).
Config por número (`GET/PUT /v1/canais/:id/sla`, padrão 30/60 min úteis, aviso de espera ligado);
`workers/sla.ts` estoura (alerta `sla_handoff_estourado`), libera a reatribuição e manda UMA mensagem de
espera pelo gateway, filtro e rede de R$. Fila única via `fragmentoNaFila`. Em modo fundador o
roteamento e a reserva ficam dormentes.

## Avaliação (evals)

Guia completo: `apps/api/src/contexts/atendimento/agente/evals/README.md`.

- Determinístico (CI): `evals/cenarios-b2b.ts` + conversas douradas pelo executor único
  (`executar-cenario.ts`), pipeline real, modelo e juiz simulados, régua de 0 CRÍTICA; mais
  `vendedor.test.ts`, `pipeline.test.ts`, `fila.test.ts`.
- Real: `IA_E2E=1` (recusa `IA_PROVEDOR=simulado`), juiz do ambiente (`IA_QUALIDADE_MODELO`); nunca no CI.
- Scripts: `agente:smoke` (provedor e reserva, nunca imprime chave), `agente:avaliar` (transcrição;
  sai 2 com CRÍTICA), `agente:medir-prefixo` (volátil no system).
- Fases e critérios: `docs/agente-go-live.md`; incidentes: `docs/agente-runbook.md`.

## Checklist antes de ligar num cliente

- [ ] Catálogo indexado (`POST /v1/catalogo/reindexar`) e preços por perfil
- [ ] Políticas escritas (autônomo exige); persona com nome e loja
- [ ] Alçada decidida (padrão: tudo passa por vendedor)
- [ ] Sombra → assistido → autônomo num recorte pelos critérios de `docs/agente-go-live.md`
- [ ] Teto diário **por número**, teto da sessão e orçamento mensal definidos; `faltaConfigurar` vazio
- [ ] Reserva de provedor cadastrada e provada (`agente:smoke -- --reserva`)
- [ ] Aviso de privacidade, playbook publicado, SLA do número e dono da revisão semanal
