# Plano — Base de conhecimento com tela e perna semântica (rodada 2026-10-04)

Fecha as três pendências do retrieval (ADR-026) apontadas em 2026-10-04:

1. **Não há tela.** A base de conhecimento só é alimentada pela API ou pelo campo de políticas.
2. **A perna semântica está desligada.** Adaptador e colunas condicionais existem; falta o worker
   que embute os pendentes, a chave no servidor e a confirmação do pgvector no Railway.
3. **A degradação não é visível.** A tela não diz se a busca é lexical ou lexical + semântica.

## Frentes

### F1 — API (contexto `catalogo` + `atendimento/agente/conhecimento`)

| Item | Entrega |
|---|---|
| Migration `0094_embedding_quando_pgvector.sql` | Aditiva e idempotente: se `vector` estiver disponível, cria a extensão e adiciona `embedding vector(1024)` + HNSW em `produto_indice` e `conhecimento_trecho` **onde ainda não existir**. Cobre o banco em que 0088/0089 rodaram antes de a extensão existir. Sem a extensão, só um NOTICE. |
| `catalogo/embutir-pendentes.ts` | `capacidadesDeBusca(tx, porta)` → `{ pgvector, embedding, semantica, pendentes, embutidos }`; `embutirPendentes(executar, porta, { lote })` lê um lote (`modelo_embedding IS DISTINCT FROM porta.nome`), embute **fora da transação**, grava com guarda de `texto_hash` (texto que mudou no meio não recebe vetor velho). Serve ao worker (dono, todos os tenants) e ao botão da tela (tenant, sob RLS). |
| Worker em `server.ts` | A cada 60 s, como dono, com advisory lock e guarda anti-sobreposição. Só faz rede quando `semantica === 'ligada'`. Falha do fornecedor é log + tenta no próximo ciclo; `limite_excedido` espera um ciclo extra. |
| `GET /v1/agente/conhecimento/capacidades` | Diz à tela (e a nós, em produção) se há pgvector, se há chave, quantos trechos/produtos faltam embutir. |
| `POST /v1/agente/conhecimento/embutir` | "Embutir agora" do tenant: até 5 lotes; 409 `conhecimento.semantica_desligada` quando não dá. |
| `POST /v1/agente/conhecimento/extrair` | Recebe arquivo em base64 (`.txt`, `.md`, `.pdf`; teto 6 MB) e devolve o TEXTO para revisão — nunca salva direto. PDF por `unpdf`; sem camada de texto → 422 `conhecimento.sem_texto` (OCR não está no escopo). |
| Limite de documento | `conteudo` sobe de 50 k para 150 k caracteres (o fatiador cuida do resto). |

### F2 — Console (`funcionalidades/atendimento/agente`)

| Item | Entrega |
|---|---|
| Aba **Conhecimento** na tela do agente | Lista por cursor (global + do número), filtro "incluir despublicados", criar/editar (título, tipo, alcance, conteúdo), publicar/despublicar, **importar arquivo** (`.txt/.md/.pdf` → extrair → revisar → salvar), **testar a base** (pergunta → trechos com título, versão, score e fontes). Cinco estados. |
| Painel de capacidade | "Busca: lexical" ou "lexical + semântica", com o motivo quando desligada (`falta VOYAGE_API_KEY no servidor` / `Postgres sem pgvector`), pendentes e botão "Embutir agora". |
| Aviso na aba Configuração | Uma linha sob "Políticas da loja" com o estado da busca e link para a aba. |
| Documento de políticas do canal | Aparece com selo "espelha a Configuração"; editar o texto aqui escreve lá (a API já faz). |

### F3 — Operação

- Railway: `VOYAGE_API_KEY` no serviço `geracrm-api` (criada vazia, como a do Groq). Sem ela, tudo
  segue lexical e a tela diz por quê.
- Se `capacidades.pgvector === false` em produção depois do deploy: o Postgres do Railway não tem a
  extensão; a saída é migrar para a imagem com pgvector (serviço novo + restore) — decisão à parte.
- Local: imagem `pgvector/pgvector:pg17` no compose (mesmo volume; só a imagem muda).

## Contratos (fonte da verdade para as duas frentes)

```
GET  /v1/agente/conhecimento/capacidades
→ { pgvector: boolean,
    embedding: { configurado: boolean, provedor: string|null, falta: 'VOYAGE_API_KEY'|null },
    semantica: 'ligada'|'sem_pgvector'|'sem_chave',
    pendentes: { produtos: number, trechos: number },
    embutidos: { produtos: number, trechos: number } }

POST /v1/agente/conhecimento/embutir
→ 200 { ok: true, produtos: n, trechos: n, restantes: { produtos, trechos } }
→ 409 { erro: 'conhecimento.semantica_desligada', semantica: 'sem_pgvector'|'sem_chave' }
→ 502 { erro: 'conhecimento.embedding_falhou', codigo: CodigoErroEmbedding }

POST /v1/agente/conhecimento/extrair   { nome, tipo: 'text/plain'|'text/markdown'|'application/pdf', conteudoBase64 }
→ 200 { texto, caracteres, paginas: number|null, avisos: string[] }
→ 422 { erro: 'conhecimento.arquivo_invalido' | 'conhecimento.arquivo_grande' | 'conhecimento.sem_texto', mensagem }

POST /v1/agente/conhecimento/buscar    (já existe)  { pergunta, canalId? }
→ { trechos: [{ texto, documentoId, titulo, tipo, versao, score, fontes: ('lexical'|'trgm'|'semantica')[], fonte }],
    fontes: [...], semantica: 'ligada' | motivo }
```

## Ordem e validação

1. F1 migration + compose + worker + rotas, com testes (`embutir-pendentes.test.ts` com porta falsa e
   pgvector local; rotas: capacidades, embutir, extrair com `.txt` e PDF mínimo gerado no teste).
2. F2 em paralelo, sobre os contratos acima; specs das regras puras.
3. Chrome: criar documento, importar `.md`, testar pergunta, ver fontes; ligar chave local da Voyage
   só se houver; sem ela, conferir a degradação visível.
4. `pnpm lint typecheck test` verdes → commit → push → CI → `/saude` → ler `capacidades` em produção.

## Adendo — provedor serverless e cache da pergunta (2026-10-04, tarde)

- Adaptador **Cloudflare Workers AI** (`@cf/baai/bge-m3`) como padrão; Voyage como alternativa;
  `EMBEDDING_PROVEDOR` força. Railway: `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_AI_TOKEN` criadas vazias.
- **Cache do vetor da pergunta**: migration 0095 (`embedding_consulta_cache`, global, sem texto),
  LRU em memória na frente, poda na passada do worker. `vetorDe: 'cache'|'fornecedor'` na resposta
  de `POST …/buscar` para a tela/diagnóstico.
- **Tempo limite separado**: 2 s para a pergunta (degrada para lexical), 15 s para o lote.
- Como obter as credenciais: dash.cloudflare.com → Account ID na página de Workers & Pages;
  API token em "My Profile → API Tokens → Create Token" com a permissão **Workers AI: Read**.

