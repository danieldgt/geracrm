# Plano — portar os padrões do agente da AM Consórcio para o GeraCRM

> Fonte: `AMConsorcio/repo/docs/agente-vendas/PLAYBOOK-AGENTE-IA.md` (§13). Auditoria e raias levantadas em
> 2026-10-17 sobre a `main` em `1eac3e5`. Plano **vivo**: o quadro de estado (§0) é atualizado a cada integração.
> Formato de raia igual ao `plano-mestre-vendedor-autonomo.md` (ARQUIVOS / NÃO TOCAR / CONTRATO / PRONTO).

## 0. Estado

| Raia | Onda | Migration | Estado | Branch | Observação |
|---|---|---|---|---|---|
| P0 costura do pipeline | 0 | 0096 | integrada (ac8d3a7, revisão aprovada na 2ª) | | dona de vendedor.ts / app.ts / server.ts / index.ts |
| P1 ADRs 028–034 | 0 | — | integrada (d155c22) | worktree-agent-a2ffbdfdac6113d71 | |
| P2 filtro de saída | 1 | 0097 | integrada (740f4d1; 4 revisões) | | |
| P3 pergunta repetida | 1 | — | integrada (5237e45; 3 revisões; main verde 1525 api) | | |
| P4 gatilhos + privacidade | 1 | 0098 | integrada (8c2af3e; 3 revisões; main verde 1682 api) | | |
| P5 resiliência LLM | 1 | — | integrada (api 1509 verde; removida tabela fixa de preço) | | |
| P6 custo e tetos | 1 | 0099 | integrada (af264b2) | | |
| P7 números ampliados | 1 | — | integrada (c322eee; 4 revisões; main verde 1545 api) | | |
| P8 saúde 3 estados | 1 | — | integrada (d589e00; main verde 1323 api) | | |
| P9 histórico do conhecimento | 1 | 0100 | integrada (0fce467; main verde 1414 api) | | |
| P10 tela de números | 1 | — | integrada (15c0f85; revalidar visual no fim) | | |
| P11 webhook enxuto + ativas | 1 | 0101 | integrada (3ad34fa; 2 revisões; main verde 1759 api) | | |
| P12 qualidade em produção | 2 | 0102 | integrada (b5b1e87; 3 revisões) | | |
| P13 sugestão/copiloto/edição | 2 | 0103 | em andamento | | |
| P14 modo: recorte/confirmação/auditoria | 2 | 0104 | integrada (c0487fc; 2 revisões; main verde 1805 api) | | |
| P15 evals + scripts | 2 | — | em andamento | | |
| P16 revisão humana | 3 | 0105 | em andamento | | |
| P17 playbook versionado | 3 | 0106 | em andamento | | |
| P18 SLA do handoff | 3 | 0107 | pendente | | fatia mínima de INB-22 (decisão padrão: fazer; ver ADR-034) |
| P19 painel de fase | 3 | — | pendente | | |
| P20 operação/docs/skills | 4 | — | pendente | | |

Integração: `pnpm lint typecheck test` verde **e** revisão adversarial (`revisar-raia`) aprovada, merge na `main`
na ordem da §2.3. Reserva de migrations: 0108–0110.

## 1. Auditoria de lacunas (resumo com evidência)

| Capacidade | Situação | Evidência | Raia |
|---|---|---|---|
| Fila com debounce/serialização | completo | `fila.ts:18-58`, `ingestao-mensagem.ts:230` | — |
| 2xx do webhook só após commit | parcial: ausência e download de mídia fazem rede antes do 200 | `rotas-webhook-meta.ts:101-122`, `rotas-webhook.ts:98-113` | P11 |
| Guardrail numérico pré-envio | parcial: só R$ | `shared agente-vendedor.ts:106`, `vendedor.ts:272-282` | P7 |
| Filtro de frases com negação | não tem | — | P2 |
| Trava de pergunta repetida | não tem (só prompt) | `instrucao-vendedor.ts:45` | P3 |
| Gatilhos pré-LLM (opt-out, humano, Procon, "é robô?") | não tem (só prompt) | `instrucao-vendedor.ts:53-59` | P4 |
| Modos/recorte/"mais restritivo vence" | parcial | `portao.ts:57-177` | P14 |
| Confirmação digitada + auditoria do modo + papel | não tem | PUT `rotas-agente.ts:109-203` sem `auditar()`; sem checagem de papel | P0 (helper) + P14 |
| Qualidade em produção (regras+juiz amostrado+pausa) | não tem (juiz só `IA_E2E`) | `evals/juiz.ts` | P12 |
| Revisão humana com concordância | não tem | — | P16 |
| Reserva de provedor com janela / fallback 403 | não tem | `fabrica-ferramentas.ts:72-90`; 403 → `credencial_invalida` | P5 |
| Falha LLM: fatal na hora, transitória na 2ª, aviso ao cliente | divergente: handoff imediato e mudo | `vendedor.ts:247-259,353-363` | P5 |
| Teto de custo | parcial: diário **por número**; sem teto por sessão; sem alerta mensal | `vendedor.ts:151,470-477` | P6 |
| Custo com id normalizado | não: desconhecido cai no preço do Opus (Groq/Gemini/OpenRouter) | `porta-llm.ts:114-122` | P6 |
| Saúde ok/degradado/erro | não tem | `app.ts:160-175` | P8 |
| SLA de handoff | não tem (INB-22 na Onda 4) | `escopo-funcional-geracrm.md:186` | P18 |
| Sugestão do assistido chega ao vendedor / métrica de edição | não: evento `agente.sugestao` sem consumidor | `vendedor.ts:335-339` | P13 |
| Fases com critério numérico | não (qualitativo) | `agente-vendedor-operacao.md` §3 | P19 + P20 |
| Aviso de privacidade registrado | não tem | — | P4 |
| Cadência sem LLM | completo; faltam expediente, limites e template fora de 24h | `retorno.ts` | P11 |
| Webhook de qualidade do número / status de template | ignorados | `rotas-webhook-meta.ts:61-66` | P11 |
| QR exige papel / polling por estado | não | `rotas-canais.ts:320-341`, `canais.pagina.ts:624-669` | P10 |
| Conhecimento com histórico imutável | não (contador sobrescreve) | `0089`, `rotas-conhecimento.ts:175-186` | P9 |
| Playbook versionado com sandbox | parcial (playground existe; `memoria_anotar` grava em simulação) | `memoria/ferramenta-memoria.ts:24` | P17 |
| Painel de métricas | rota existe, sem tela | `rotas-agente.ts:413-480` | P19 |
| STT, "nunca LLM no não-respondente", comportamento lido no uso | completo | `workers/transcricao.ts`, `retorno.ts:15`, `vendedor.ts:85` | — |
| Vocabulário "assistido" | já alinhado (assistido = sugere); registrar em ADR | ADR-023 | P1 |

## 2. Raias

### 2.1 Princípios de paralelismo
- **P0 é dona da costura**: transforma `vendedor.ts` num pipeline com pontos de extensão e cria stubs com nome fixo;
  cada raia edita só os seus stubs.
- **Leitura tolerante**: `lerConfig` lê `to_jsonb(ac.*) AS extra`; cada raia lê seus campos de `cfg.extra`.
- **Estado por sessão sem migration por raia**: `agente_sessao.estado_agente` (jsonb, uma chave por raia) e
  `agente_decisao.guardrails` (jsonb com marcas).
- Migrations reservadas, aditivas, com RLS (`aplicar_rls`). Migration aplicada é imutável (hash conferido).

### 2.2 Donos de arquivos compartilhados
| Arquivo | Dono | Outros contribuem via |
|---|---|---|
| `agente/vendedor.ts` | P0 | stubs `agente/pipeline/*` |
| `shared/src/index.ts`, `shared/dominio/agente-vendedor.ts` | P0 | stubs `shared/dominio/agente-*.ts` já exportados |
| `apps/api/src/app.ts`, `server.ts`, `apps/api/package.json` | P0 | plugins/workers/scripts-stub já registrados |
| console `agente/agente.pagina.ts` | P0 | abas e componentes-stub já montados |
| `agente/rotas-agente.ts` | P14, depois P17 | sub-rotas em arquivo próprio |
| `agente/instrucao-vendedor.ts` | P4 (onda 1, uma linha), P17 (onda 3) | hook `instrucoes` |
| `portao.ts`, `contexto-lead.ts`, `agente-config.componente.ts`, `compartilhado/ui/confirmar*` | P14 | — |
| `porta.ts`, `porta-llm.ts`, `claude-ferramentas.ts`, `openrouter-ferramentas.ts`, `fabrica-ferramentas.ts` | P5 | P0 só adiciona `RastroDoLaco.provedor?` |
| `ferramentas/{porta,catalogo,pedido,cliente}.ts` | P7 | — |
| `ferramentas/montar.ts`, `memoria/ferramenta-memoria.ts`, `agente-playground.componente.ts` | P17 | — |
| `retorno.ts`, `rotas-webhook*.ts`, `ingestao-mensagem.ts`, `expediente.ts` | P11 | — |
| `rotas-canais.ts`, `canais.pagina.ts`, `canais.regras.ts`, `shared telefone.ts` | P10 | — |
| `inbox.pagina.ts`, `rotas-mensagens.ts`, `shared mensagem.ts` | P13 (P18 +1 linha depois) | — |
| `handoff.ts`, `rotas-fila.ts`, `atendimento-kanban.pagina.ts`, `rotas-performance.ts` | P18 | — |
| `conhecimento/**`, `agente-conhecimento.componente.ts` | P9 | — |
| `evals/**` | P15 | — |
| `docs/decisoes.md` | P1 (onda 0); P20 (onda 4) | — |
| skills, `CLAUDE.md`, plano-mestre | P20 | — |

### 2.3 Ondas e ordem de integração
| Onda | Raias | Ordem de integração |
|---|---|---|
| 0 | P0 ∥ P1 | P0 entra antes de tudo |
| 1 | P2 P3 P4 P5 P6 P7 P8 P9 P10 P11 | P5 → P6 → P2 → P7 → P3 → P4 → P11 → P8 → P9 → P10 |
| 2 | P12 (P2,P3,P6,P7), P13 (P2,P4), P14, P15 (P2–P7 + rubrica P12) | P14 → P12 → P13 → P15 |
| 3 | P16 (P12), P17 (P2,P3,P4,P14), P18 (P5,P13), P19 (P12,P13,P16) | P16 → P17 → P18 → P19 |
| 4 | P20 | — |

### P0 — Costura do pipeline (onda 0, migration 0096)
```
OBJETIVO   Pontos de extensão para as raias rodarem em paralelo sem tocar vendedor.ts.
MIGRATION  0096_agente_guardrails_estado.sql: agente_decisao ADD guardrails jsonb NOT NULL DEFAULT '[]',
           ADD falha_tipo text NULL CHECK (falha_tipo IN ('fatal','transitoria','requisicao','formato'));
           ampliar o CHECK de modo de agente_decisao com 'copiloto';
           agente_sessao ADD estado_agente jsonb NOT NULL DEFAULT '{}'
ARQUIVOS   agente/vendedor.ts (pipeline; lerConfig com `extra`; registrarDecisao grava guardrails/falha_tipo;
           handoffSemModelo aceita avisoCliente e envia pelo gateway só em autônomo; DepsTurno.copiloto?;
           resultado.reagendarEmMs); agente/pipeline/{tipos,index}.ts (reais);
           stubs pipeline/{modo-efetivo(P14), gatilhos-entrada(P4), slots-do-cliente(P3), teto-conversa(P6),
           numeros-ampliados(P7), filtro-saida(P2), pergunta-repetida(P3), regras-qualidade(P12), falha-llm(P5)}.ts;
           agente/{custo(P6), llm-estado(P5)}.ts stubs; agente/estado-agente.ts (lerEstado/patchEstado);
           workers/agente.ts (reagendarEmMs); plataforma/papel.ts (papeisDoUsuario, exigirPapel → 403
           acesso.papel_insuficiente); plataforma/batimento.ts (stub P8); porta-llm.ts (só RastroDoLaco.provedor?);
           shared agente-vendedor.ts: motivos novos (qualidade_violacao_critica, limite_de_custo_conversa, opt_out,
           audio_sem_transcricao, pergunta_robo, gatilho_playbook) + rótulos; shared stubs agente-{filtro,perguntas,
           gatilhos,numeros,qualidade,revisao,sugestao,modo,playbook,fases,sla,saude}.ts exportados;
           app.ts plugins-stub rotasCompliance, rotasCusto, rotasPrivacidade, rotasAtivas, rotasQualidade,
           rotasRevisao, rotasSugestao, rotasPlaybook, rotasGoLive, rotasSaudeDetalhada, rotasSla;
           server.ts workers-stub qualidade, sla, pos-ingestao + batimento(...) em cada intervalo;
           package.json scripts agente:smoke, agente:avaliar, agente:medir-prefixo (stubs);
           console agente.pagina.ts com abas protecoes, qualidade, revisao, metricas, playbook e componentes-stub
           agente-{protecoes,compliance,custo,ativas,qualidade,revisao,metricas,playbook}.componente.ts
NÃO TOCAR  lógica de negócio (stubs devolvem identidade/segue)
CONTRATO   MarcaGuardrail {etapa, codigo, gravidade 'CRITICA'|'ALTA'|'MEDIA'|'INFO',
             acao 'removido'|'reescrito'|'anexado'|'substituido'|'bloqueado'|'handoff'|'registrado', trecho? (≤160, mascarado)}
           ContextoPipeline {tenantId, conversaId, canalId, contatoId, sessaoId, modo: ModoAgente|'simulacao'|'copiloto',
             agora, cfgExtra, persona, estado, historico, entrantes[{id,tipo,texto,transcricaoPendente,transcricaoFalhou}],
             primeiraResposta, foraDoExpediente}
           DecisaoPreLlm = {tipo:'segue', instrucoes?, estado?, guardrails?} | {tipo:'resposta_fixa', mensagens, handoff?,
             estado?, guardrails?} | {tipo:'handoff', motivo, resumo, avisoCliente, guardrails?} | {tipo:'silencio', motivo}
           EtapaPosResposta.executar(ctx, {mensagens, handoff, centavosVistos, numerosVistos, falasAnterioresDoAgente})
             → {mensagens, guardrails, bloquear?, estado?}
           PoliticaFalha.decidir(ctx, {motivo, detalhe, executouFerramentas, estado})
             → {acao:'handoff'|'aviso_e_reagendar'|'registrar', classe, avisoCliente, reagendarEmMs?}
           custoDoLaco({provedor, modelo, uso}) → centavos
           Ordem fixa: modoEfetivo → [portão] → gatilhos → slots → teto(pré) → LLM → [guardrail R$] → números →
             filtro → pergunta → qualidade → envio → teto(pós)
TESTES     vendedor.test.ts e evals verdes sem mudar comportamento; teste de pipeline com etapa falsa em cada ponto;
           papel.test.ts com dois tenants
PRONTO     suíte verde e igual à de antes; cada stub editável isoladamente; 0096 aplicada e RLS mantida
```

### P1 — Decisões (onda 0, só docs)
```
ARQUIVOS   docs/decisoes.md: ADR-028 vocabulário (assistido = sugere; recorte; mais restritivo vence) · 029 pipeline
           determinístico; tela só acrescenta restrição · 030 resiliência de provedor · 031 qualidade em produção e
           revisão humana · 032 custo pelo catálogo, teto por sessão, alerta mensal · 033 playbook × conhecimento ×
           agente_config · 034 SLA do handoff como fatia de INB-22
NÃO TOCAR  código, skills
PRONTO     ADRs no formato do arquivo; números de fase marcados "proposta"
```

### P2 — Filtro de saída com negação (onda 1, migration 0097)
```
MIGRATION  0097: agente_config ADD compliance jsonb NOT NULL DEFAULT '{"frasesProibidas":[],"gatilhosHandoff":[]}'
ARQUIVOS   shared/dominio/agente-filtro.ts (+test); pipeline/filtro-saida.ts; agente/rotas-compliance.ts (+test);
           agente/evals/respostas-aprovadas-b2b.json (≥30); console agente-compliance.componente.ts + compliance.servico.ts
NÃO TOCAR  vendedor.ts, rotas-agente.ts, evals/conversas-douradas.json
CONTRATO   termoNegado(frase, inicio) regra AM (mesma oração, ≤2 palavras, conectivos, "sem" colado, dupla negação = afirmação)
           filtrarSaida(texto, {extras?, limites?:{maxCaracteres,maxPerguntas}}) → {texto, alterado, ocorrencias[{id,gravidade,acao}]}
           ajustarMensagemHandoff(texto, {semNumeros}) remove promessa de prazo
           PROIBIDAS_BASE_B2B: negar ser IA; garantir entrega/prazo/estoque/preço/crédito; "melhor preço do mercado";
             oferecer desconto; urgência falsa; pedido de consentimento para atender; hesitações (reescritas)
           ComplianceExtra {frasesProibidas ≤50×80, gatilhosHandoff ≤50} literais, só acrescentam
           GET/PUT /v1/canais/:id/agente/compliance (admin grava; auditoria)
PRONTO     "não garantimos entrega amanhã" passa; "garantimos entrega amanhã" removida e CRITICA; extras valem no turno
           seguinte; vale em autônomo, assistido, sombra e simulação; as ≥30 respostas aprovadas saem inalteradas
```

### P3 — Pergunta repetida e slots determinísticos (onda 1)
```
ARQUIVOS   shared/dominio/agente-perguntas.ts (+test); pipeline/slots-do-cliente.ts; pipeline/pergunta-repetida.ts
CONTRATO   normalizar; perguntasDe; Jaccard; LIMIAR 0,7; PERGUNTA_DO_SLOT; extrairSlotsDoCliente(texto) (volume, prazo,
           orçamento, tipoCompra, cnpj → 'informado', nunca dígitos); evitarPerguntaRepetida(texto, {perguntasAnteriores,
           slotsRespondidos, slotsDoCanal}) → {texto, removidas, substituta}; estado_agente.perguntas.ultima;
           marca MEDIA pergunta_repetida 'substituido'
PRONTO     caso real da AM portado ao B2B não repete; sem substituta → pergunta neutra; após restart vale o estado
```

### P4 — Gatilhos de entrada, identidade e privacidade (onda 1, migration 0098)
```
MIGRATION  0098: aviso_privacidade (tenant_id, id, contato_id, conversa_id, canal_id, mensagem_id, texto, versao,
           origem 'agente'|'humano', exibido_em) RLS + índice; tenant_privacidade (tenant_id PK, url, versao,
           texto_padrao, atualizado_em) RLS
ARQUIVOS   shared/dominio/agente-gatilhos.ts (+test); pipeline/gatilhos-entrada.ts; agente/privacidade.ts;
           agente/rotas-privacidade.ts; contexts/crm/opt-out.ts; instrucao-vendedor.ts (só linha da identificação);
           console privacidade.componente.ts + 1 linha em plataforma/config.pagina.ts
CONTRATO   detectarOptOut ("cancelar pedido" NÃO é opt-out), detectarPedidoHumano, detectarReclamacao,
           detectarPerguntaRobo, gatilhoExtra; textoAbertura/textoRobo/textoOptOut; opt-out envia confirmação antes de
           registrar, cancela retornos, encerra sessão; abertura fixa na 1ª resposta em autônomo; "é robô?" 1ª fixa,
           2ª handoff; áudio pendente → silêncio, falha → 1ª pede texto, 2ª handoff; registrarAvisoSeExibido só após
           envio ok; GET/PUT /v1/privacidade (admin); GET /v1/contatos/:id/avisos-privacidade (cursor)
PRONTO     "pare" bloqueia sem LLM; abertura identifica a assistente; avisos listados por contato; nenhum caminho envia
           depois do opt-out
```

### P5 — Resiliência do LLM (onda 1)
```
ARQUIVOS   porta.ts (+'acesso_negado'); claude-ferramentas.ts, openrouter-ferramentas.ts (401/402/403/429/529);
           agente/falha-llm.ts; agente/llm-reserva.ts; fabrica-ferramentas.ts (IA_RESERVA_PROVEDOR, IA_RESERVA_MODELO,
           IA_RESERVA_JANELA_MIN=30); llm-estado.ts; pipeline/falha-llm.ts
CONTRATO   2 falhas de provedor seguidas no processo → reserva por N min (alerta=llm_reserva_ativo), volta sozinho;
           sem ferramentas executadas refaz já na reserva, com ferramentas não repete; acesso_negado → modelo bloqueado
           1h e usa IA_MODELO (alerta=modelo_bloqueado); política: fatal → handoff com aviso sem prazo; transitória 1ª →
           "tive uma instabilidade" + reagendar 30 s (uma vez); 2ª → handoff modelo_indisponivel com aviso;
           formato → handoff; sombra/assistido só registra; resumo determinístico; alerta 'agente_llm_indisponivel';
           estadoDoLlm()
PRONTO     derrubar o principal no teste vira reserva; cliente nunca fica sem aviso em autônomo
```

### P6 — Custo e tetos (onda 1, migration 0099)
```
MIGRATION  0099: modelo_ia ADD custo_cache_leitura_usd_milhao, custo_cache_escrita_usd_milhao + UPDATE Claude;
           agente_config ADD teto_sessao_centavos bigint; agente_orcamento (tenant_id PK, mensal_centavos,
           alertado_80_mes, alertado_100_mes) RLS
ARQUIVOS   agente/custo.ts (+test); pipeline/teto-conversa.ts; agente/rotas-custo.ts; console agente-custo.componente.ts
CONTRATO   normalizarIdModelo; precoDoModelo pelo catálogo (cache 10 min), gratuito 0, desconhecido = maior preço +
           alerta=preco_desconhecido; teto por sessão (IA_TETO_SESSAO_CENTAVOS): pré-LLM autônomo → handoff
           limite_de_custo_conversa com aviso, sombra/assistido silêncio; pós-turno responde e transfere em silêncio;
           alerta mensal 80/100% (só avisa); GET/PUT /v1/agente/orcamento; GET/PUT /v1/canais/:id/agente/custo
PRONTO     Groq gratuito custa 0; sessão em loop vai ao humano
```

### P7 — Guardrail numérico ampliado (onda 1)
```
ARQUIVOS   shared/dominio/agente-numeros.ts (+test); ferramentas/porta.ts; ferramentas/{catalogo,pedido,cliente}.ts;
           pipeline/numeros-ampliados.ts
CONTRATO   extrairNumerosDeNegocio → percentual|quantidade|prazo_dias|prazo_horas (ignora hora, data, telefone, CNPJ,
           CEP); ferramentas devolvem numeros?; políticas, conhecimento e cliente também são fonte; % sem fonte bloqueia;
           "temos N"/"entrega em N dias" sem fonte bloqueia; outros ALTA
PRONTO     "10% de desconto" sem ferramenta não sai
```

### P8 — Saúde em três estados (onda 1)
```
ARQUIVOS   plataforma/saude-detalhada.ts (+rotas); plataforma/batimento.ts; shared/dominio/agente-saude.ts
CONTRATO   GET /saude/detalhada público sem dado de tenant → {status, motivos[], componentes{processo, banco,
           workerAgente, filaAgente, llm, transcricao, embeddings, retornos}}; 503 só encerrando; degradado (200) para
           dependências; avaliarSaude pura
PRONTO     monitor externo por palavra-chave documentado; healthcheck do Railway inalterado
```

### P9 — Histórico imutável do conhecimento (onda 1, migration 0100)
```
MIGRATION  0100: conhecimento_documento_versao (PK tenant, documento_id, versao) RLS + backfill
CONTRATO   PATCH grava versão na mesma transação + auditoria; GET .../versoes (cursor); GET .../versoes/:v;
           POST .../restaurar {versao, observacao} cria versão nova; diff na tela
PRONTO     "doc vN" citado numa decisão abre o texto exato daquela versão
```

### P10 — Tela de números (onda 1)
```
CONTRATO   GET /v1/canais/:id/qrcode exige admin (403 → status sem QR); GET /v1/canais ganha podeParear, modoAgente,
           ativasSuspensas (tolerante); polling 3 s aguardando/conectando, 30 s no resto, para ao sair; estado
           "servidor indisponível" próprio; mascararTelefone
PRONTO     gestor vê status, nunca o QR
```

### P11 — Webhook enxuto e ativas (onda 1, migration 0101)
```
MIGRATION  0101: tarefa_pos_ingestao RLS + índice parcial; canal_conectado ADD ativas_suspensas_em/_motivo;
           agente_config ADD ativas jsonb ({limiteDia, limiteSemana, templateRetorno})
CONTRATO   webhook = grava + agenda + 200, sem rede no request (worker pos-ingestao faz ausência e mídia Meta);
           phone_number_quality_update/account_update → suspende ativas não transacionais + alerta 'qualidade_numero';
           template_status persistido; retorno respeita expediente (adia), limites (descarta), suspensão (adia),
           template fora de 24h quando configurado e aprovado
PRONTO     nenhum adaptador chamado dentro do request (teste)
```

### P12 — Qualidade em produção (onda 2, migration 0102)
```
MIGRATION  0102: agente_avaliacao (… origem, tipo regras|juiz, gatilho, violacoes, pior_gravidade, notas,
           justificativas, nota_media, acao, modelo, custo_centavos) UNIQUE (tenant, decisao_id, tipo) RLS;
           agente_config ADD qualidade_amostra, qualidade_teto_mes_centavos
CONTRATO   regras em 100%; CRÍTICA antes do envio → não envia + handoff qualidade_violacao_critica (autônomo) ou
           sugestão "não envie" (assistido) + alerta; amostra estável FNV-1a; juiz no fim de sessão e a cada 10 turnos;
           rubrica 5 critérios 0–5 + justificativa ≤280; GET /v1/agente/qualidade (cursor), /resumo,
           /amostra-semanal.csv (mascarado), POST /avaliar; tela de qualidade
PRONTO     tela mostra notas e violações; uma CRÍTICA pausa e alerta
```

### P13 — Sugestão do assistido, copiloto e métrica de edição (onda 2, migration 0103)
```
MIGRATION  0103: agente_decisao ADD sugestao_estado, sugestao_mensagem_id, sugestao_usada_em,
           sugestao_similaridade, sombra_similaridade + índice parcial
CONTRATO   GET /v1/conversas/:id/sugestao; POST /v1/conversas/:id/sugestao/gerar (copiloto só leitura, 20 s, 502
           copiloto.indisponivel); POST /v1/agente/sugestoes/:decisaoId/descartar; envio com sugestaoDecisaoId →
           enviada/editada + similaridade; sombra_similaridade; envio humano chama registrarAvisoSeExibido;
           GET /v1/agente/sugestoes/metricas; inbox com painel de sugestão (avisos por gravidade, Usar, Descartar,
           Sugerir resposta, selo do modo, SSE agente.sugestao)
PRONTO     vendedor vê e usa a sugestão; métrica vem do banco
```

### P14 — Modo: recorte, confirmação e auditoria (onda 2, migration 0104)
```
MIGRATION  0104: agente_config ADD recorte jsonb ({horario, segmentosRfv, foraDoRecorte}); agente_tenant
           (tenant_id PK, modo_maximo, atualizado_em, atualizado_por) RLS
CONTRATO   decidirModoEfetivo (mais restritivo entre tenant, número e recorte); MODOS_COM_CONFIRMACAO autonomo/desligado;
           confirmacaoConfere sem acento/caixa; PUT exige confirmação e admin (422 agente.confirmacao_necessaria);
           auditar 'agente.config_alterada' {antes, depois}; GET/PUT /v1/agente/tenant; esconder identificaComoRobo
PRONTO     trocar para autônomo pede digitar "autonomo"; auditoria mostra a diferença
```

### P15 — Evals e scripts de operação (onda 2)
```
CONTRATO   ≥25 cenários B2B (recompra, atacado/varejo, grade, sem estoque, prazo, desconto, CNPJ, pede humano, Procon,
           "pare", "é robô?" 2×, áudio, pergunta repetida, % sem fonte, promessa filtrada, acima da alçada, proposta
           confirmada, sombra, assistido, teto, falha transitória e fatal, fora do recorte) com fatos, marcas de
           guardrail e 0 CRÍTICA; juiz usa a rubrica de P12; agente:avaliar sai 2 com CRÍTICA; smoke nunca imprime chave
PRONTO     CI verde com modelo simulado
```

### P16 — Revisão humana e concordância (onda 3, migration 0105)
```
MIGRATION  0105: agente_revisao UNIQUE (tenant, avaliacao_id, revisor_id) RLS
CONTRATO   GET /v1/agente/revisao/amostra (20 por número, ordem P12); POST /v1/agente/revisao;
           GET /v1/agente/revisao/concordancia; concorda = |LLM − humano| ≤ 1 por critério e mesma classe de gravidade;
           gestor/admin
PRONTO     concordância semanal visível por número
```

### P17 — Playbook comercial versionado (onda 3, migration 0106)
```
MIGRATION  0106: agente_playbook_versao (um rascunho e uma publicada por tenant/canal)
CONTRATO   conteúdo {estilo, persona, qualificacao[], mensagens, compliance (só acrescenta), acoes}; transferir sempre
           ligada; diffPorSecao; import inicial idempotente; GET/PUT rascunho, publicar (observação ≥10, admin,
           auditoria), restaurar, a-partir-de-documento (só rascunho + resumo); simular {playbook} devolve guardrails e
           ações registradas; memória não grava em simulação; 20 mensagens e 1 simulação por vez
PRONTO     a tela não desliga guardrail (teste); publicar muda a próxima mensagem
```

### P18 — SLA do handoff, fatia de INB-22 (onda 3, migration 0107)
```
MIGRATION  0107: atendimento_sla_config RLS; atendimento ADD sla_vence_em, sla_estourado_em,
           reatribuicao_liberada_em, aviso_espera_em
CONTRATO   somarMinutosUteis, proximaAbertura, rotearHandoff puros; worker notifica no SLA, libera reatribuição no 2º
           limiar e manda UMA mensagem de espera fixa; cronômetro no inbox/kanban
PRONTO     cronômetro na fila; SLA medido
```

### P19 — Painel e critério de fase (onda 3)
```
CONTRATO   GET /v1/agente/go-live?canalId → {fase, dias, criterios[{id, alvo, valor, ok}], podeAvancar}; tela consome
           também /v1/agente/metricas
PRONTO     painel verde/vermelho por critério
```
Critérios propostos (B2B): Homologação — 25 douradas 0 CRÍTICA, smoke ok, ≥30 conversas no playground 0 CRÍTICA ·
Sombra (≥10 dias úteis, ≥150 turnos/≥50 conversas) — similaridade sombra×humano ≥0,6 em ≥60%, 0 CRÍTICA, nota ≥4,
concordância ≥85% (≥20 revisadas), ≤ R$ 1,50/conversa, números bloqueados ≤2% · Assistido (≥10 dias úteis, ≥100
sugestões) — uso ≥40%, sem edição ≥70% (≥50 enviadas), 0 CRÍTICA · Autônomo num recorte (21 dias) — 0 CRÍTICA em 14
dias, p95 ≤6 s, handoff 10–40%, opt-out ≤1%, conversão não-inferior (−2 p.p.), 0 pedido confirmado errado · Autônomo
amplo — revisão a cada 30 dias; violou → volta uma fase.

### P20 — Operação (onda 4)
```
ARQUIVOS   docs/agente-go-live.md, agente-runbook.md, agente-revisao-semanal.md, agente-guia-vendedor.md,
           agente-treinamento-1h.md; agente-vendedor-operacao.md; skills geracrm-agente-vendas/ia/observabilidade;
           plano-mestre §8; CLAUDE.md
CONTRATO   runbook por incidente (LLM fora, reserva ativa, modelo bloqueado, fila travada, outbox parada, canal
           desconectado, número RED, ERP degradado, teto, violação CRÍTICA, webhook parado, embeddings fora,
           transcrição fora); revisão semanal 20 conversas/número
PRONTO     skills descrevem o pipeline e onde estender
```

## 3. Fora de escopo, com motivo
- Worker separado + token de serviço, Mastra, Baileys, fila em disco: o GeraCRM já tem RLS no processo, laço próprio,
  PlugZapi e ingestão transacional (§13.3).
- Domínio de consórcio e listas de frases da AM: só o mecanismo é portado; "nunca GANHO" ≡ ADR-027.
- STT próprio: Groq atende. monitor-cron: tabela `alerta` + SSE + monitor por palavra-chave (P8).
- Cadência T1–T4, pós-venda D+0 e NPS: funil de recompra; retorno 1h/24h/72h é o análogo.
- PJ e menor de idade: no B2B a PJ é o público. 3 objeções → handoff: coberto por desconto fora da política; reavaliar
  com a revisão humana.
- If-Match no estado e Idempotency-Key em eventos: serialização pela fila e outbox no processo já resolvem.
- CTWA: já existe na aquisição. Exclusão do titular/retenção: R10d. Throttle INV-23: R10e.

## 4. Notas de integração
- [integrada c5eb01d] P0 (revisão, baixos não bloqueantes → raia P0b, onda 1): rede final de R$ deve rodar ANTES de `fatiarMensagem`;
  `avisoCliente` de `handoffSemModelo`/`avisarCliente` também passa pela rede.
- P3/P4: uma etapa pré-LLM que devolve estado e silencia no 1º turno abre sessão `ativa` com 0 turnos
  (`sessaoParaEstado`) — conta como `sessaoAtiva` no portão seguinte.
- P14: `exigirPapel` exige linha em `usuario`; chamar `garantirUsuarioId` antes, ou tratar na tela.
- Paralelismo: cada raia usa o próprio banco `geracrm_pN` no Postgres 5442 (suítes concorrentes no mesmo banco
  quebram testes de fila/sequência).
- [integrada eef0531; 2 revisões; main verde 1836 api] P0c (após onda 1; dono vendedor.ts): (a) fontes de números que hoje não entram no P7 — quantidades do
  pedido aberto carregado fora do laço e memória do contato (`lerMemoria`); (b) estabilizar os testes de
  fila/worker (`vendedor.test.ts` "Sequência e worker", `pipeline.test.ts` "aviso_e_reagendar") que falham
  intermitentemente por workers de outros arquivos varrerem todos os tenants. [feito na P0c-b: consumo da fila nos testes via workerDoTenant]
  (c) passar `tenantId` a `custoDoLaco` em vendedor.ts (alerta `preco_desconhecido` imediato — P6);
  (d) [feito] remover `custoEstimadoCentavos`/`PRECO_USD_POR_MILHAO` de porta-llm.ts depois de P5 e P6 integradas;
  (e) slots ditos no 1º turno com resposta fixa sem sessão se perdem (P3).
  (f) `workers/transcricao.ts registrarFalha`: falha definitiva deve chamar `agendarTurno` para o "1º pede texto"
      sair sem esperar nova mensagem (P4);
  (g) lista de avisos de privacidade por contato na tela do contato (API pronta na P4).
  (h) fechar o alerta `agente_llm_indisponivel` no turno bem-sucedido (`resolverAlertaLlm(tenantId)` em vendedor.ts — P5);
  (i) mostrar reserva/`faltaParaReserva` na tela do agente (P14/P17).
  Nota: a P5 isolou o worker dos testes por tenant (`workerDoTenant`), o que deve resolver o item (b).
  (j) `EntradaPosResposta.saldoDeEstoqueVisto` preenchido em vendedor.ts a partir do registro de ferramentas;
      filtro P2 passa `estoqueComFonte` (hoje fail-closed: escassez sempre vetada).
  (k) P10 follow-up: rotas-canais.ts preencher meta_waba_id/meta_telefone ao salvar credencial (hoje o worker
      da P11 preenche em até 10 min);
  (l) feriados também na ausência e na disponibilidade do agente (`disponibilidade.ts`) — P11 só aplicou nas ativas.
- Integração P14 × P11: depois da P14 na main, `retorno.ts avaliar()` (P11) usa `modoEfetivoDoCanal` — kill switch do
  tenant e recorte também calam o retorno. Integrar a P4 antes da P14 (identificaComoRobo ignorado na P4).
  (m) tela da campanha mostra "pausada por qualidade do número" (hoje só o alerta avisa) — P11;
  (n) purga de tarefa_pos_ingestao em laço até o lote vir curto (hoje ~72k/dia) — P11;
  (o) catch externo de processarRetornos reagenda sem contar falha (pré-existente) — P11.
- Decisões de produto pós-revisão da P14 (aplicar na P17, que é dona da tela/conteúdo do agente):
  (q) retorno fora do recorte só por horário/feriado → ADIA até a próxima abertura do recorte (kill switch e
      segmento continuam cancelando);
  (r) recorte ganha opção "feriado conta como: fora | dentro" (padrão: fora) — cobre "autônomo fora do expediente";
  (s) tela de empresa nomeia 403 ("só administrador") e 422 (mensagem do servidor); lista de números mostra o modo
      EFETIVO (selo "teto da conta" quando o kill switch restringe).
- P13 × P17: o teste "[P17] copiloto não grava memória" está em it.skip em rotas-sugestao.test.ts — a P17 tira o skip
  ao bloquear memoria_anotar em simulação e copiloto.
