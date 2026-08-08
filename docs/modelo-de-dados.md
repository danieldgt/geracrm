# GeraCRM — Modelo de dados

> Etapa 3 da trilha de `workflow-produto`, e a lacuna nº 1 de `prontidao-para-inicio.md`.
> Deriva de [`escopo-funcional-geracrm.md`](./escopo-funcional-geracrm.md),
> [`especificacao-telas.md`](./especificacao-telas.md), [`decisoes.md`](./decisoes.md) e
> [`stack-arquitetura.md`](./stack-arquitetura.md).
>
> **Ordem obrigatória:** conceito → invariante → agregado → relacionamento → temporalidade →
> identidade externa → tenancy → **só então** tabela. Quem começa pela tabela acaba com um domínio
> que é o reflexo de uma decisão de armazenamento tomada cedo demais.
>
> Contextos espelham `apps/api/src/contexts/`: `atendimento` · `contato` · `pedido` · `crm` ·
> `campanha` · `catalogo` · `integracao` · `identidade` · `analitico`.

---

## 1. Entidades e objetos de valor

### 1.1 O critério

| | Entidade | Objeto de valor |
|---|---|---|
| Tem identidade própria | Sim (UUID v7 nosso) | Não |
| Duas cópias iguais são a mesma coisa? | Não | Sim |
| Ciclo de vida | Próprio | Do dono |
| Some quando o dono some? | Não | Sim |

⚠️ **A armadilha mais cara é promover valor a entidade.** `Endereco`, `Telefone`, `Nome` e `Preço`
com id próprio geram órfãos, duplicatas e telas de CRUD que ninguém pediu. Neste modelo eles são
**valores dentro do agregado do dono**, identificados pelo próprio conteúdo normalizado.

### 1.2 Entidades por contexto

#### `identidade` — plataforma, tenancy e acesso

| Entidade | O que identifica | Nota |
|---|---|---|
| **Tenant** | `id` UUID v7 | ⚠️ A **única** tabela de domínio sem `tenant_id` — ela *é* o tenant |
| **Filial** | `(tenant_id, id)` | PLT-01. Agrupa canais, usuários e metas |
| **Setor** | `(tenant_id, id)` | INB-15: destino de transferência de atendimento |
| **Usuario** | `(tenant_id, id)`; `cognito_sub` como identidade externa | Cognito headless (ADR-006) |
| **PerfilDeVertical** | `(tenant_id, id)`, derivado de `perfil_vertical_modelo` | ADR-004: nomenclatura, atributos obrigatórios, regras de pedido mínimo, faixas RFV. ⚠️ O **modelo** é global e nosso; o **perfil ativo** é linha do tenant — `tenant.perfil_vertical_id` aponta para ela, não para o modelo |
| **TokenDeIntegracao** | `(tenant_id, id)`; hash do bearer | INT-03 |
| **AssinaturaDeWebhook** | `(tenant_id, id)` | INT-07: URL, segredo de assinatura, eventos assinados, log de entrega |
| **Plano** | `id` — catálogo **global**, nosso | PLT-06: limites de canal, disparo, usuário. `tenant.plano_id` referencia esta tabela (§7.2) |
| **Notificacao** | `(tenant_id, id)` | PLT-07: in-app, por usuário, com `lida_em` (o contador é `count WHERE lida_em IS NULL`) |
| **DispositivoDePush** | `(tenant_id, id)` | MOB-07: token por dispositivo, por usuário, com plataforma |
| **RegistroDeAuditoria** | `(tenant_id, id)` | PLT-05 |

`Papel` (admin, gestor, supervisor, vendedor, atendente) e `Permissao` são **união de literais**, não
tabela — são código, não dado do cliente. A *atribuição* é dado, e ela é **por filial**:
`usuario_filial(tenant_id, usuario_id, filial_id, papel)`.

⚠️ **Papel escalar no usuário não representa o caso normal.** Um supervisor é gestor na filial da
matriz e vendedor no showroom. Por isso o papel mora no vínculo, não em `usuario`. Tenant sem filial
usa uma linha com `filial_id IS NULL` (escopo tenant). **Permissão individual fora do papel não
existe — é decisão, não omissão** (PLT-02): exceção vira papel novo, porque permissão por pessoa é
o que torna a autorização impossível de auditar.

#### `contato` — a base de clientes

| Entidade | O que identifica | Nota |
|---|---|---|
| **Contato** | `(tenant_id, id)` | A **empresa** (lojista, cliente, lead). ⚠️ Nunca identificado por CNPJ nem por telefone. **Um contato por CNPJ** (§4.1) |
| **GrupoEconomico** | `(tenant_id, id)` | Matriz e filiais com CNPJs distintos são **contatos separados** ligados por grupo. Agrupa na tela; **não** agrega RFV (§4.1) |
| **Pessoa** | `(tenant_id, id)` | CTT-09. Comprador, financeiro, dono. Vive N:N com Contato. ⚠️ **Não tem telefone próprio** — telefone é do Contato (§4.1) |
| **CampoPersonalizado** (definição) | `(tenant_id, id)` | CTT-06. O *valor* é JSONB no Contato |
| **ListaSalva / Segmento** | `(tenant_id, id)` | CTT-14 |
| **Comentario** | `(tenant_id, id)` | CTT-10. Agregado próprio: precisa de edição/exclusão auditável |
| **ConflitoDeIdentidade** | `(tenant_id, id)` | §6.4 — duas chaves discordando, aguardando decisão humana |

#### `atendimento` — canal, conversa e mensagem

| Entidade | O que identifica | Nota |
|---|---|---|
| **CanalConectado** | `(tenant_id, id)`; `tipo ('whatsapp'\|'instagram')` | ⚠️ **Raiz genérica do canal** (CAN-02/CAN-07). Carrega filial, nome amigável, estado e **capacidades declaradas** — é onde INV-19 e a duração da janela moram |
| **NumeroWhatsapp** | dentro de CanalConectado; externo: `phone_number_id` + `waba_id` | Especialização: telefone E.164, WABA, tier, qualidade, pagamento. Um por vendedora |
| **PerfilInstagram** | dentro de CanalConectado; externo: `ig_user_id` | Especialização: **sem telefone**, sem template, sem tier (§6.7) |
| **Conversa** | `(tenant_id, id)`; natural: `(canal_id, contato_id)` | ⚠️ Thread perpétuo. O mesmo contato em 3 canais = 3 conversas |
| **Mensagem** | `(tenant_id, id)`; externo: `wamid` | Particionada por período desde o dia 1 — ver §8.5 para o efeito disso na PK e na dedup |
| **Atendimento** | `(tenant_id, id)`; natural: `protocolo` | ⚠️ **Episódio** com protocolo, dono, início e fim — distinto da Conversa. Ver §3.5 |
| **Midia** | `(tenant_id, id)` | Ponteiro para object storage, nunca blob em coluna |
| **Template** | `(tenant_id, id)` | CMP-03 |
| **VersaoDeTemplate** | dentro do agregado Template | Status na Meta muda por versão |
| **RespostaRapida** | `(tenant_id, id)` | INB-13: texto com variáveis, opcionalmente por setor |

⚠️ **Por que `CanalConectado` e não `Numero` como raiz.** Instagram Direct não tem número de
telefone. Com `numero` como única entidade de canal, ou se cria uma linha semanticamente falsa (com
`telefone_e164` nulo, misturando dois canais com regras de janela, throttling e template diferentes
nos mesmos índices), ou `conversa.numero_id` vira nulável — e como `NULL` não conflita em índice
único no Postgres, a chave natural `(canal, contato)` degrada e o mesmo contato acumula N conversas
de Instagram duplicadas. A raiz genérica é o que dá a INV-19 um lugar onde morar.

#### `catalogo`

| Entidade | O que identifica | Nota |
|---|---|---|
| **Produto** | `(tenant_id, id)`; natural: `referencia` | Espelho do ERP (CAT-01) |
| **VarianteDeProduto (SKU)** | dentro de Produto; natural: `sku` | Grade cor × tamanho — atributos **configuráveis** (ADR-004), não colunas de moda |
| **AtributoDeVariacao** | `(tenant_id, id)` | "cor", "tamanho", "voltagem" — definido pelo perfil de vertical |
| **TabelaDePreco** | `(tenant_id, id)` | Agregado próprio: vigência e itens mudam juntos |
| **LinkDeCatalogo** | `(tenant_id, id)` | CAT-02/03: compartilhável e rastreável |

⚠️ **`Saldo` não é entidade nossa.** É leitura do ERP (INT-01b) com horário de apuração. Modelado
como valor `SaldoApurado { quantidade, apurado_em, fonte, ao_vivo: bool }`, cacheado por SKU. Tratar
saldo como entidade nossa faz o produto mentir quando o ERP diverge.

#### `pedido`

| Entidade | O que identifica | Nota |
|---|---|---|
| **Pedido** | `(tenant_id, id)` | O **rascunho nosso** e sua efetivação (ADR-005) |
| **ItemDePedido** | dentro do agregado Pedido | Grade + snapshot de preço |
| **TentativaDeEfetivacao** | dentro do agregado Pedido | ⚠️ Linha nova por tentativa, com chave de idempotência e erro tipificado |
| **Venda** | `(tenant_id, id)`; externo: `numero_do_pedido_no_erp` | ⚠️ **Fato consolidado vindo do ERP.** Entidade separada — ver §3.7 |
| **ItemDeVenda** | dentro de Venda | Alimenta RFV-05 (categorias até SKU-cor-tamanho) |

#### `crm`

| Entidade | O que identifica | Nota |
|---|---|---|
| **Funil** | `(tenant_id, id)` | CRM-05: múltiplos funis configuráveis |
| **EtapaDeFunil** | dentro de Funil | Ordem, tipo de saída, automações |
| **NegocioNoFunil** | `(tenant_id, id)`; natural: `(funil_id, contato_id)` | A posição do contato no kanban |
| **MotivoDePerda** | `(tenant_id, id)` | CRM-09: catálogo fechado |
| **AtribuicaoDeCarteira** | `(tenant_id, id)` | CRM-06/07: intervalo `[de, ate)` com autor |
| **Tarefa** | `(tenant_id, id)` | TSK-01 |
| **Cadencia** | `(tenant_id, id)` | TSK-05, Onda 3 |
| **Meta** | `(tenant_id, id)`; natural: `(escopo, alvo, tipo, periodo_de)` | GES-01: meta por usuário, equipe, filial ou tenant. ⚠️ O **realizado nunca é gravado** — é derivado de `venda` (§5.4) |

⚠️ **O Funil de Relacionamento (CRM-02) não tem posição gravada.** Suas colunas — Lead · 1 pedido ·
2 pedidos · 3+ pedidos — são **derivadas do contador de vendas** do contato. Gravar posição criaria
duas verdades que divergem no primeiro pedido importado em lote. As duas colunas que *não* são
deriváveis (`Representantes`, `Descartados`) são **flags do Contato**, não etapas.

⚠️ **O contador não escapa do problema, só o desloca.** `contato.qtd_vendas` é **cache** de
`mv_metricas_contato`, não fonte de verdade — com job de reconciliação obrigatório depois de toda
`operacao_ingestao` (INV-57, §3.8). Sem esse job, a primeira carga histórica põe a base inteira na
coluna "Lead", que é exatamente o sintoma que este parágrafo diz estar evitando.

#### `campanha`

| Entidade | O que identifica | Nota |
|---|---|---|
| **Campanha** | `(tenant_id, id)` | CMP-01 |
| **DestinatarioDeCampanha** | `(tenant_id, id)`; natural: `(campanha_id, contato_id)` | ⚠️ Público **congelado** no disparo. Agregado próprio por volume |
| **EntradaDeListaDeBloqueio** | `(tenant_id, chave_bloqueio)` — 55+DDD+últimos 8 | CMP-14. Vale mesmo sem contato cadastrado. ⚠️ Chaveada pela forma **reduzida**, não pela E.164 completa (INV-50) |
| **ConsentimentoDeContato** | `(tenant_id, id)` | CTT-15/LGPD: histórico de opt-in/opt-out |

#### `integracao`

| Entidade | O que identifica | Nota |
|---|---|---|
| **ConexaoDeErp** | `(tenant_id, id)` | Credencial cifrada + **capacidades declaradas** (ADR-008) |
| **IdentidadeExterna** | `(tenant_id, conexao_id, id_externo)` por tipo de entidade | §6 |
| **EventoExterno** | `(tenant_id, canal, id_externo_evento)` | Webhook bruto, base da idempotência |
| **OperacaoDeIngestao** | `(tenant_id, id)` | INT-04/05/08: lote, retomada, erros |
| **ChaveDeIdempotencia** | `(tenant_id, escopo, chave)` | INT-04 |
| **Outbox** | `id` | Infra (ADR-007), mas carrega `tenant_id` no payload |

#### `analitico`

| Entidade | O que identifica | Nota |
|---|---|---|
| **EventoDeSegmentoRfv** | `(tenant_id, id)` | Série temporal, RFV-02 |
| **AtribuicaoDeReceita** | `(tenant_id, id)` | CMP-11: `metodo` (exata \| estimada) obrigatório |
| **CustoDeMensagem** | `(tenant_id, id)` | Fato por mensagem entregue, com categoria e tarifa vigente |
| **MetricaDoNumero** | `(tenant_id, canal_id, dia)` | Série diária de saúde e volume. ⚠️ **Métrica, não controle de quota** (INV-22) |

`PerfilRfvDoContato`, `MetricasDoContato` (dias sem vendas, média entre vendas, ticket) e
`CicloDeVida` **não são entidades** — são projeções derivadas (§5.4).

### 1.3 Objetos de valor — a lista fechada

| Valor | Forma | Onde vive | Por que não é entidade |
|---|---|---|---|
| **Dinheiro** | `{ centavos: bigint, moeda: 'BRL' }` | Pedido, Venda, Meta, Custo | Duas quantias iguais são a mesma quantia. ⚠️ Nunca `float`, e no banco `*_centavos bigint` — **não** `numeric(14,2)` (INV-46) |
| **Telefone** | `{ e164_canonico, e164_do_canal, bruto, chave_reduzida }` | `contato_telefone`, `numero_whatsapp` | Identificado pelo próprio valor normalizado (§6.5). ⚠️ São **três** formas com papéis distintos, não uma |
| **DocumentoFiscal** | `{ tipo: 'CNPJ'\|'CPF', digitos, apelido }` | `contato_documento` | Idem — com **chave local `seq`** dentro do Contato, para o Pedido poder escolher qual (§5.3) |
| **NomeDeFonte** | `{ valor, fonte, visto_em, preferido }` | `contato_nome` | CTT-01: o mesmo CNPJ chega com grafia diferente de cada fonte |
| **Endereco** | `{ seq, apelido, logradouro, numero, bairro, cidade, uf, cep, geo }` | Contato, Venda | ⚠️ Endereço com id **próprio (UUID, CRUD, órfão)** é o erro clássico; chave **local** dentro do agregado não é promoção a entidade |
| **JanelaDeAtendimento** | `{ aberta: bool, expira_em, duracao_h, reabre_por: 'template'\|'nenhum' }` | **derivado**, nunca gravado | §5.5. ⚠️ Antes chamado `JanelaDe24h`: a duração e a política de reabertura são **propriedade declarada do canal**, lidas de `canal_conectado.capacidades` — não constante no código |
| **ChaveDeEfetivacao** | `hash(tenant_id, pedido_id, versao_conteudo)` | `pedido`, `pedido_tentativa` | Determinística por **conteúdo**, não por tentativa (INV-29) |
| **CondicaoComercialApurada** | `{ tabela_id, prazo_dias, desconto_pct, apurado_em, ao_vivo }` | `contato_condicao_comercial` | Mesmo padrão de `SaldoApurado`: valor **com hora e origem** |
| **FaixaRfv** | união de 11 literais | Projeção RFV | RFV-01 |
| **CicloDeVida** | `'ativo' \| 'inativo' \| 'perdido'` | Derivado de config do tenant | RFV-03 |
| **SaldoApurado** | `{ quantidade, apurado_em, ao_vivo }` | Catálogo, Pedido | Do ERP, com hora — nunca "o saldo" |
| **CondicaoComercialAplicada** | `{ tabela_id, tabela_nome, prazo, desconto_pct }` | **Snapshot** no Pedido | §5.3 |
| **Grade** | `{ atributos: [{nome, valor}], quantidade }` | ItemDePedido | Configurável por vertical |
| **Capacidades** | `{ saldoSincrono, escritaPedido, … }` | ConexaoDeErp | ADR-008 |
| **Protocolo** | inteiro sequencial por tenant | Atendimento | ⚠️ É chave natural humana, não a identidade |
| **Versao** | inteiro monotônico por conversa | Conversa | Cursor de reconexão SSE (ADR-007) |
| **Cursor** | `(campo_ordenacao, id)` opaco | Toda lista | Paginação obrigatória |

---

## 2. Invariantes

> **A regra do documento:** para cada invariante, **quem a protege**. Se a resposta for "o
> front-end" ou "todo mundo lembra de checar", está errado. Invariante protegida por disciplina é
> invariante violada.

### 2.1 Isolamento e tenancy

| ID | Invariante | Dono (quem protege) |
|---|---|---|
| **INV-01** | Toda leitura e escrita alcança **apenas** linhas do tenant do token autenticado | **RLS no Postgres** + plugin Fastify que injeta `app.tenant_id` a partir da claim `custom:tenant_id`. Role da aplicação **sem** `BYPASSRLS` |
| **INV-02** | `tenant_id` **nunca** chega por parâmetro (path, query ou corpo) | O schema Zod da borda **não tem o campo**. Teste que varre as rotas e falha se aparecer |
| **INV-03** | Toda chave única é composta com o tenant; todo índice de consulta começa por `tenant_id` | DDL + revisão de migration. ⚠️ `UNIQUE(cnpj)` impede dois tenants de cadastrarem o mesmo cliente. ⚠️ Em tabela **particionada** a única também precisa conter a chave de partição — ver INV-60 |
| **INV-04** | Linha filha nunca referencia pai de outro tenant | **FK composta** `(tenant_id, pai_id) → pai(tenant_id, id)` — torna o erro impossível, não improvável **quando o pai não é particionado** |
| **INV-05** | Canal de push é sempre prefixado por tenant e o payload **nunca** carrega conteúdo | Função única construtora de canal (que não aceita montar sem tenant) + tipo do evento de outbox restrito a `{tipo, id, versao}` (ADR-007) |

⚠️ **INV-04 tem um limite real do Postgres, e ele não pode ficar implícito.** FK só referencia
`UNIQUE`/PK existente, e tabela particionada não aceita única que não contenha a chave de partição
(INV-60). Logo, filho de tabela particionada **carrega a chave de partição do pai** para que a FK
composta seja possível:

| Filho | Coluna carregada | FK |
|---|---|---|
| `midia` | `mensagem_criado_em` | `(tenant_id, mensagem_criado_em, mensagem_id) → mensagem` |
| `custo_mensagem` | `mensagem_criado_em` | idem |
| `venda_item` | `venda_data` | `(tenant_id, venda_data, venda_id) → venda` |
| `atribuicao_receita` | `venda_data` | idem |
| `campanha_destinatario.mensagem_id` | `mensagem_criado_em` (nulável) | idem, `MATCH SIMPLE` — destinatário sem mensagem não é checado |

⚠️ Onde nem isso for possível, a relação é declarada **sem FK, com job diário de órfãos** — e escrita
como tal. O que não pode existir é invariante prometendo proteção que o schema não entrega.

### 2.2 Contato e identidade

| ID | Invariante | Dono |
|---|---|---|
| **INV-06** | Telefone é gravado em **forma canônica interna** E.164; formato livre não entra | Normalizador na borda (`packages/shared`) + `CHECK (telefone_e164 ~ '^\+[1-9][0-9]{7,14}$')`. ⚠️ A forma canônica é **nossa**, não a que a Meta devolve (§6.5) |
| **INV-07** | O mesmo telefone **principal** não pertence a dois contatos do mesmo tenant; telefone secundário pode repetir | `CREATE UNIQUE INDEX ON contato_telefone (tenant_id, telefone_e164) WHERE principal` |
| **INV-08** | Cada contato tem no máximo um telefone principal, um documento fiscal **padrão**, um endereço de entrega **padrão** e um nome preferido | Índice `UNIQUE` parcial `WHERE principal` / `WHERE fiscal_padrao` / `WHERE entrega_padrao` / `WHERE preferido`. ⚠️ "Padrão", não "único": o contato tem N documentos e N endereços (§5.3) |
| **INV-09** | Uma identidade externa `(conexão, id_externo)` aponta para no máximo um contato | `UNIQUE(tenant_id, conexao_id, id_externo)` |
| **INV-10** | Fonte externa **nunca sobrescreve** campo escrito por fonte de precedência maior — ela **adiciona** valor alternativo | Serviço de reconciliação: **único ponto de escrita** de dado vindo de fora, com tabela de origem por campo (§6.3) |
| **INV-11** | Contato mesclado nunca é apagado; referências antigas resolvem por redirecionamento | Caso de uso de mesclagem + tabela `contato_mesclagem` permanente |
| **INV-12** | Toda conversa tem contato — número desconhecido cria contato-lead na primeira mensagem, **na mesma transação da mensagem** | Caso de uso de ingestão de mensagem (contexto `atendimento`), §3.8 |
| **INV-49** | A resolução de **conversa entrante por telefone é determinística**: um telefone principal → no máximo um contato | INV-07 (única parcial) + o resolvedor de ingestão consulta **apenas** telefones principais. ⚠️ Colisão de principal na ingestão do ERP não falha o lote e não funde: o telefone entra como **secundário** no segundo contato e abre `conflito_identidade` |

⚠️ **INV-12 parece detalhe e é estrutural.** Sem ele, quem chega por WhatsApp não existe para funil,
RFV, tarefa nem campanha — metade do produto não alcança o lead novo.

⚠️ **INV-07 e a §6.2 se contradiziam, e a contradição era fatal na ingestão.** A §6.2 manda "não casar
por telefone: cria contato e enfileira sugestão de mesclagem"; um `UNIQUE(tenant_id, telefone_e164)`
total torna essa criação **fisicamente impossível** — o lote estoura, ou casa por chave média
(fundindo o histórico de compra de dois clientes), ou grava o contato **sem** o telefone, perdendo em
silêncio um dado multi-valorado que a §6.3 manda acrescentar. A separação entre **telefone de
roteamento** (principal, único) e **telefone de cadastro** (secundário, repetível) resolve os dois
lados: a mensagem entrante continua com dono determinístico (INV-49) e o cadastro continua aditivo.

### 2.3 Opt-out e consentimento

| ID | Invariante | Dono |
|---|---|---|
| **INV-13** | Contato com `recebe_campanhas = false` **não recebe mensagem de campanha por caminho nenhum** — inclusive disparo manual em lote, reenvio de falha, cadência e automação de etapa | **Três camadas:** (1) o materializador de público é a única porta que cria destinatário; (2) `TRIGGER` que recusa `INSERT` de destinatário com opt-out; (3) o gateway de envio revalida antes de chamar a Meta |
| **INV-14** | `recebe_automacoes` é independente de `recebe_campanhas` | Idem — dois campos, duas checagens |
| **INV-15** | Telefone na lista de bloqueio do tenant não recebe envio, **mesmo sem contato cadastrado** | Gateway de envio — saída única para a Meta. A comparação é por **`chave_bloqueio`** (55+DDD+últimos 8), não pela forma completa |
| **INV-50** | **Bloqueio compara por chave reduzida; cadastro nunca funde por chave reduzida** | `lista_bloqueio` chaveada por `chave_bloqueio` + gateway comparando por ela; §6.2 mantém `chave_busca` como sugestão. ⚠️ Assimetria **deliberada**: no bloqueio, colisão de 8 dígitos deixa de enviar a alguém (custo baixo, reversível); no cadastro, funde dois clientes (custo alto, irreversível) |
| **INV-16** | Toda mudança de preferência grava evento de consentimento com data, autor e origem — **e, quando houver, a campanha e a mensagem que a provocaram** | Caso de uso + tabela `consentimento_contato` com `campanha_id`/`mensagem_id` nuláveis (CTT-15/LGPD, CMP-10) |

⚠️ **INV-13 é o caso de invariante que precisa ser garantida pela camada, não pelo chamador.** Há
muitos caminhos até um envio (campanha, cadência, automação de etapa, reenvio, API pública) e **um
esquecimento basta** para o cliente receber mensagem depois de pedir para sair — dano jurídico e de
reputação do número.

⚠️ **INV-50 é a versão adulta de INV-15.** No Brasil o `wa_id` que a Meta devolve costuma vir **sem o
nono dígito** (12 dígitos) enquanto o ERP, o cadastro e a digitação da vendedora trazem 13. Sem
chave reduzida no bloqueio, o contato que pede para sair pelo WhatsApp entra na lista com 12 dígitos,
a campanha materializada do cadastro dispara com 13, o gateway revalida, **não encontra** e envia.
INV-15 seria burlável por diferença de formatação — exatamente no caso jurídico mais caro do produto.

### 2.4 Canal, janela de atendimento, template e episódio

| ID | Invariante | Dono |
|---|---|---|
| **INV-17** | Fora da janela de atendimento, **só template aprovado** sai | Caso de uso de envio (contexto `atendimento`) |
| **INV-18** | O estado da janela é **derivado** do timestamp da última mensagem **entrante** daquela conversa e da **duração declarada pelo canal** — nunca é flag gravada nem constante no código | Função pura em `packages/shared` recebendo `canal_conectado.capacidades`, usada por API **e** console (a contagem regressiva da tela e o bloqueio do servidor usam a mesma função) |
| **INV-19** | Instagram não aceita template para reabrir janela e **não pode ser público de campanha** | `canal_conectado.capacidades` (`aceitaTemplate`, `podeSerPublicoDeCampanha`) + validação no construtor de campanha, com explicação na tela |
| **INV-20** | Só template com versão `aprovada` vigente é enviável, e a mensagem grava o **texto renderizado**, não a referência ao template | Caso de uso de envio |
| **INV-21** | Nenhum envio sai por canal que não esteja conectado **e** (WhatsApp) com método de pagamento OK na Meta | Gateway de envio — e a falha diz exatamente isso (ADR-002) |
| **INV-51** | **Uma conversa tem no máximo um atendimento não encerrado** | `CREATE UNIQUE INDEX ON atendimento (tenant_id, conversa_id) WHERE estado <> 'encerrado'`. O caso de uso "Assumir" trata a violação de unicidade como **"já assumido por outra pessoa"** — mensagem de tela, não erro 500 |

⚠️ **INV-51 é a invariante que faltava e o front-end estava segurando sozinho.** INB-09 é fila em modo
*pull* com botão **Assumir**: duas atendentes clicando no mesmo card, ou uma mensagem entrante criando
atendimento enquanto alguém assume, produzem dois episódios abertos na mesma conversa. O estrago
percorre o produto: dois protocolos para o mesmo episódio, SLA (INB-22) e CSAT em dobro, o ranking de
GES-02/03 creditando duas pessoas, e a transferência (INB-15) sem saber qual linha fechar. Só mostrar
o botão para quem chegou primeiro **não é dono de invariante** — é esperança com CSS.

### 2.5 Throttling e reputação do número

| ID | Invariante | Dono |
|---|---|---|
| **INV-22** | Nenhum número ultrapassa o limite do seu tier, contado como a Meta conta: **conversas de negócio iniciadas com contatos distintos numa janela móvel de 24 h** | `numero_conversa_iniciada(tenant_id, canal_id, contato_id, iniciada_em)` + baldes horários `numero_quota_hora(tenant_id, canal_id, hora_utc, contatos_distintos)`; a reserva é `INSERT … ON CONFLICT DO NOTHING RETURNING` na tabela de conversa iniciada, e o limite é a **soma dos últimos 24 baldes**. ⚠️ A reserva acontece **antes** da chamada à Meta. Proibido ler-incrementar-gravar |
| **INV-23** | Intervalo mínimo (randômico) entre dois envios do mesmo número | `numero_throttle(tenant_id, canal_id, proximo_envio_permitido_em)` — tabela minúscula, **sem janela**, com `UPDATE … RETURNING` atômico |
| **INV-24** | Número com qualidade abaixo do limiar não dispara campanha | Worker de disparo, lendo o estado de saúde (CAN-06) |

⚠️ O limite é **por número, não global** — cada número da frota tem tier próprio na Meta.

⚠️ **A quota estava modelada com a unidade errada em duas dimensões, e nenhuma era a que a Meta
cobra.**

| Erro | O que acontecia |
|---|---|
| `enviadas int` conta **mensagens** | O tier limita **conversas iniciadas com destinatários únicos**: 3 templates para o mesmo contato consomem 1 slot na Meta e 3 no contador. Uma campanha para 900 contatos distintos com 2 mensagens cada marcava "1800" num tier de 1000 e **travava um disparo perfeitamente legal** |
| Chave `dia` (calendário) | O limite é de **24 h móveis**: dava para enviar o limite inteiro às 23h e o limite inteiro de novo às 00h05 — o dobro em 24 h reais, que é o comportamento que derruba a qualidade do número (CAN-06, diferencial D3) |
| `dia` **sem fuso declarado** | UTC do servidor ≠ dia comercial de Recife; a virada acontecia no meio da tarde ou de madrugada, dependendo de onde o container subiu |
| `UPDATE … RETURNING` sem linha | Na **primeira reserva do dia** a linha não existia: o `UPDATE` não afetava nada, o worker seguia adiante e a reserva **silenciosamente não acontecia** |

Os baldes são em **UTC** (`date_trunc('hour', now() AT TIME ZONE 'UTC')`), declarado aqui porque
janela móvel não depende de fuso — só o relatório depende, e ele usa `metrica_numero_dia`, que carrega
o fuso do tenant. `numero_quota` diária deixa de existir como controle e vira **métrica**
(`metrica_numero_dia`).

### 2.6 Pedido

| ID | Invariante | Dono |
|---|---|---|
| **INV-25** | Preço, condição comercial e dados fiscais dentro do pedido são **snapshot**, nunca referência ao preço atual | Agregado Pedido — o item **copia** `preco_unitario_centavos` e a tabela de origem no momento da inclusão |
| **INV-26** | Total do pedido = soma dos snapshots dos itens; nunca recalculado a partir do catálogo | Agregado Pedido |
| **INV-27** | Pedido não transita para efetivação com validação pendente: pedido mínimo (peças ou valor), múltiplo de grade, mix mínimo por categoria | `Pedido.validar()` na raiz do agregado; o caso de uso não deixa transitar. A tela apenas **reflete** o resultado |
| **INV-28** | As regras comerciais aplicadas ficam **congeladas no rascunho** e são **revalidadas na efetivação**; divergência entre as duas é apresentada, nunca silenciada | Caso de uso de efetivação (mesmo tratamento de PED-08) |
| **INV-29** | Uma **versão de conteúdo** do pedido produz **no máximo um** pedido no ERP | `pedido.versao_conteudo` (incrementada por toda mutação de item, quantidade ou condição) + `pedido.chave_efetivacao = hash(tenant_id, pedido_id, versao_conteudo)` **persistida antes** da primeira chamada e **reutilizada em toda retentativa** da mesma versão + índice `UNIQUE (tenant_id, pedido_id) WHERE resultado = 'sucesso'` em `pedido_tentativa` + o adaptador envia a chave ao ERP |
| **INV-30** | Falha na efetivação **nunca** altera nem apaga o rascunho | Máquina de estados: a tentativa é **linha nova** em `pedido_tentativa`, não mutação do pedido |
| **INV-53** | Depois de **timeout** (resposta perdida), a retentativa só ocorre após **reconciliação por consulta ao ERP** | Caso de uso de efetivação + capacidade `consultaPedidoPorChave`/`consultaPedidoPorNumero`. ⚠️ Sem essa capacidade (ADR-008), o pedido entra em `aguardando_conferencia` e a tela pede confirmação humana — **degradação anunciada, não garantia fingida** |
| **INV-31** | Pedido efetivado é imutável; correção é pedido novo | Agregado + `CHECK` por estado |
| **INV-52** | Uma conversa tem no máximo **um pedido em rascunho** | `CREATE UNIQUE INDEX ON pedido (tenant_id, conversa_id) WHERE estado = 'rascunho'` — mesma corrida de INV-51, dois cliques em "Novo pedido" na mesma conversa |

⚠️ **INV-30 é o item que decide se o módulo é usado ou abandonado.** Se a vendedora perde o pedido
montado numa falha do ERP, ela volta a lançar no ERP e a ferramenta morre (PED-08).

⚠️ **A INV-29 antiga era vacuamente satisfeita — protegia o caso que nunca acontece.** A chave era
gerada **por tentativa** e a única era `(tenant_id, pedido_id, chave_idempotencia)`, que permite N
chaves distintas para o mesmo pedido. No cenário que importa — o ERP criou o pedido e a resposta se
perdeu no timeout — a retentativa nascia com **chave nova**, o ERP não a reconhecia e criava o
**segundo pedido**. A única impedia reenviar a mesma chave, que é justamente o que nenhum cliente
faz. A invariante que o documento acreditava ter ("no máximo um pedido no ERP por pedido nosso") não
estava protegida por nada.

⚠️ **E os dois erros da tela §2.4 exigem comportamentos opostos**, que só a versão de conteúdo
distingue:

| Erro na efetivação | O que a vendedora faz | Chave |
|---|---|---|
| Erro de comunicação / timeout | "Tentar novamente" | **A mesma** — reenviar não duplica |
| Item sem saldo, quantidade inválida, item removido, condição recusada | Ajusta o pedido | **Nova** — `versao_conteudo` incrementa. Sem isso, um ERP corretamente idempotente devolveria o **primeiro pedido, errado**, como sucesso |

### 2.7 Carteira, funil e acesso

| ID | Invariante | Dono |
|---|---|---|
| **INV-32** | Um contato tem **no máximo um dono vigente** | Índice `UNIQUE` parcial `(tenant_id, contato_id) WHERE ate IS NULL` |
| **INV-33** | O histórico de carteira não tem **sobreposição**, e toda troca registra autor e horário | `EXCLUDE USING gist (tenant_id WITH =, contato_id WITH =, periodo WITH &&)` sobre a coluna gerada `periodo tstzrange(de, ate, '[)')`, com a extensão **`btree_gist`** |
| **INV-58** | O histórico de carteira não tem **lacuna**: todo instante desde o primeiro dono tem uma linha vigente | Linha explícita com `usuario_id IS NULL` representando **"sem dono"** — a transferência fecha uma e abre outra na mesma transação, e remover a vendedora abre a linha de órfão. ⚠️ Lacuna deixa de ser possível **por construção**, e não por job de auditoria |
| **INV-34** | "Este usuário pode ver este contato/esta conversa?" é decidido **em um lugar só**, por **predicado explícito por papel** | Função central de autorização, chamada pelo **caso de uso**. ⚠️ Nunca no controller — a mesma regra precisa valer para job, webhook e API pública |
| **INV-35** | Um contato ocupa no máximo uma etapa por funil, e toda mudança grava evento com autor, origem e horário | `UNIQUE(tenant_id, funil_id, contato_id)` + caso de uso |
| **INV-36** | Saída para etapa de descarte exige motivo do catálogo | `negocio_funil.etapa_tipo` **desnormalizada** (copiada de `funil_etapa.tipo_saida` na transição, junto com `etapa_id`) + `CHECK (etapa_tipo <> 'descarte' OR motivo_perda_id IS NOT NULL)`. ⚠️ Sem a desnormalização o `CHECK` é impossível: no Postgres ele não lê outra tabela, e o dono da invariante voltaria a ser "disciplina" |

⚠️ **INV-34 dizia *onde* a autorização mora e nunca dizia *o que* ela decide.** "tenant → filial →
número → carteira" é uma lista de dimensões **sem operador** — e conjunção e disjunção produzem
produtos diferentes. Com `AND`, a vendedora não vê a conversa que chegou no canal dela sobre cliente
da carteira da colega, e a mensagem fica sem ninguém. Com `OR`, a carteira deixa de ser exclusiva na
prática. O predicado, por papel, é este:

```
admin, gestor   → tenant                     (todos os contatos e conversas do tenant)
supervisor      → filial                     (contato.filial ∈ minhas filiais
                                              OR conversa.canal.filial ∈ minhas filiais)
vendedor,       → conversa: canal ∈ meus canais  OR  contato ∈ minha carteira
atendente         contato:  contato ∈ minha carteira  OR  existe conversa visível para mim
```

⚠️ **É disjunção no nível do vendedor, e isso é decisão, não descuido:** mensagem que chega no meu
canal precisa ter dono mesmo que o cliente seja da carteira da colega — senão ela fica invisível para
todo mundo. A exclusividade da carteira é mantida por INV-32 (**um dono**), não por invisibilidade.
O papel vem de `usuario_filial` (INV-59), nunca de `usuario`. As duas consultas de listagem — inbox
e kanban — **derivam deste predicado**, e por isso os índices da §8.6 começam por `canal_id` num caso
e por `dono_atual_id` no outro. Isto é **pré-requisito da primeira tela**, não item de Onda 3.

| ID | Invariante | Dono |
|---|---|---|
| **INV-59** | Papel é atribuído **por filial**, e a autorização sempre decide sobre o par `(usuário, filial)` | `usuario_filial(tenant_id, usuario_id, filial_id, papel)` com `filial_id IS NULL` = escopo tenant. ⚠️ `usuario.papel` escalar **não existe** — ele impedia representar "gestor na matriz, vendedor no showroom" |

### 2.8 Integração e idempotência

| ID | Invariante | Dono |
|---|---|---|
| **INV-37** | Um evento de webhook `(canal, id_externo)` é aplicado **uma vez** | `UNIQUE(tenant_id, canal, id_externo_evento)` em `evento_externo` — **tabela não particionada**, justamente para que essa única exista de verdade; o handler faz `INSERT … ON CONFLICT DO NOTHING` e só processa quem inseriu. Retenção: **corpo** expurgado cedo, **linha-chave** mantida além da janela máxima de reentrega da Meta (§8.5) |
| **INV-38** | Uma mensagem tem no máximo uma linha por identificador do canal (`wamid`) | `mensagem_id_externo(tenant_id, id_externo, mensagem_id, mensagem_criado_em)` **não particionada**, com `UNIQUE(tenant_id, id_externo)`, gravada na **mesma transação** da mensagem. ⚠️ A única **não** pode viver em `mensagem`, que é particionada (INV-60) |
| **INV-39** | Status de entrega só **avança** (enviado → entregue → lido); reentrega fora de ordem não regride | Máquina de estados no handler, comparando ordem interna numérica; o handler de status é **UPSERT**, idempotente por natureza, e não depende do expurgo de `evento_externo` |
| **INV-40** | Evento de push só é publicado **depois do commit** | Outbox gravado na mesma transação do dado + worker que emite `NOTIFY` (ADR-007) |
| **INV-41** | Credencial de terceiro nunca em texto plano e nunca alcança outro tenant | Repositório de credenciais que cifra/decifra + `conexao_erp` sob RLS. ⚠️ Nunca em log |
| **INV-55** | Uma venda física entra **uma vez**, mesmo que duas conexões a ingiram | `conexao_erp.fonte_de_venda bool` com `UNIQUE (tenant_id) WHERE fonte_de_venda` — **uma só conexão é fonte de venda por tenant**. Venda vinda de conexão não-fonte não é gravada: abre `conflito_identidade` com a chave de negócio `(contato_id, data, total_centavos)` |

⚠️ **INV-55 é o furo silencioso do multi-ERP.** `UNIQUE(tenant_id, conexao_id, numero_externo)` inclui
a conexão — então a **mesma venda física** ingerida por duas conexões (tenant migrando de ERP, ou
dois ERPs espelhando a operação) vira **duas Vendas do mesmo contato**. Frequência e valor do RFV
dobram, o ciclo de vida reclassifica, a Fila do Dia prioriza errado, e nada denuncia. A decisão
aberta nº 13 trata **ordem de conectores**, não isto.

### 2.9 Atribuição de receita e analítico

| ID | Invariante | Dono |
|---|---|---|
| **INV-42** | Atribuição **exata** e **estimada** nunca são somadas | Modelo: `metodo` é coluna **obrigatória** e nenhuma view materializada expõe a soma. A API devolve dois campos, não um total |
| **INV-43** | Uma venda tem no máximo **uma** atribuição exata | `UNIQUE(tenant_id, venda_id) WHERE metodo = 'exata'` |
| **INV-44** | A regra de desempate da atribuição estimada é única e **declarada**, e a janela usada fica gravada no registro | Job de atribuição + coluna `janela_dias` + legenda na tela |
| **INV-45** | A linha do tempo de RFV é **encadeada e sem empate**: não há duas transições do mesmo contato no mesmo instante, e `faixa_de` da linha N = `faixa_para` da linha N-1 | `UNIQUE(tenant_id, contato_id, avaliado_em)` + trigger de encadeamento no `INSERT`. ⚠️ A redação antiga ("um registro vigente", "índice parcial `WHERE ate IS NULL`") descrevia um modelo **com vigência que `rfv_evento` não tem** — o estado vigente mora em `mv_rfv_segmento_atual`, e view materializada **não impõe invariante de escrita** |
| **INV-54** | Uma mensagem gera **no máximo uma linha de custo por categoria cobrável** | `UNIQUE(tenant_id, mensagem_criado_em, mensagem_id, categoria)` em `custo_mensagem` (a coluna de partição entra na única, INV-60) |
| **INV-56** | Nenhuma projeção derivada de venda classifica contato **fora da cobertura de dados** daquela conexão | `conexao_erp_cobertura(fluxo, desde, ate, estado)` + toda MV derivada de venda carrega `confiavel bool` / `apurado_desde`; o job de RFV **se recusa** a classificar contato cuja janela R excede a cobertura |
| **INV-57** | Todo contador denormalizado é **cache com fonte declarada e job de reconciliação** — nunca fonte de verdade | `contato.qtd_vendas/primeira_venda_em/ultima_venda_em` ← `mv_metricas_contato`; `campanha.custo_centavos` ← soma de `custo_mensagem`; `campanha.opt_outs/respostas` ← `consentimento_contato`/`mensagem`. Reconciliação roda **depois de toda `operacao_ingestao`** e periodicamente |

⚠️ **INV-56 é a diferença entre "nunca comprou" e "não sabemos", e ela não era representável.**
Praticamente todo o valor analítico do produto deriva de `venda`: dias sem vendas, média entre
vendas, ticket, faixa RFV, ciclo de vida, colunas do CRM-02, card do kanban.
`operacao_ingestao` registra a **execução do lote**, não o **horizonte coberto** — então num ERP sem
carga histórica (ou com carga parcial, ou em andamento) a ficha exibia "Dias sem vendas: 267" e
"Perdido" para cliente ativo, a base inteira caía em "Lead" e a matriz RFV classificava tudo como
Perdido. Mentira apresentada com a mesma confiança do dado real — o oposto do que ADR-008 manda
fazer.

⚠️ **INV-54 protege o número mais comercial do produto.** A linha de custo nasce do webhook de status,
cuja idempotência depende de `evento_externo`; com expurgo agressivo, uma reentrega da Meta depois do
expurgo passava pela dedup, rodava o handler de novo e **inseria uma segunda linha de custo**. Somado
ao `campanha.custo_centavos` eventual e sem lastro, o número que o cliente usa para decidir se a
campanha valeu a pena era inflado por reentrega de webhook, **sem nada que denunciasse**.

### 2.10 Transversais

| ID | Invariante | Dono |
|---|---|---|
| **INV-46** | Dinheiro é **centavos inteiros** na aplicação **e `bigint` no banco**, em coluna com sufixo `_centavos` | Tipo `Dinheiro` em `packages/shared` + `CHECK` de faixa quando fizer sentido. ⚠️ Nunca `float`, **nunca `numeric(14,2)` numa coluna chamada `_centavos`** — a discrepância é de fator 100 e é silenciosa (ninguém percebe R$ 45,00 virando R$ 4.500,00 num agregado) |
| **INV-47** | Toda coleção é paginada server-side **por cursor** | Contrato de resposta `{ itens, cursorProximo, temMais }`. ⚠️ Nasceu de OOM real no Postgres do GeraCloud |
| **INV-48** | Estado é união de literais em `text` | ⚠️ Nunca status numérico mágico, nunca `enum` do Postgres (alterar valor exige migration dolorosa) |
| **INV-60** | Em tabela **particionada**, a PK e **toda** única contêm a chave de partição; unicidade que precisa ser **global** vive em tabela-guardiã **não particionada** | DDL + revisão de migration. ⚠️ Não é preferência: o Postgres **recusa** criar índice único que não contenha a chave de partição, e uma única "global" escrita nessa forma **simplesmente não existe no banco** — o `ON CONFLICT DO NOTHING` que depende dela não tem em que conflitar |

---

## 3. Agregados

> **Regras:** uma raiz · referência externa aponta só para a raiz · **transação = agregado** ·
> agregado pequeno. Agregado grande vira gargalo de concorrência.

| # | Agregado (raiz) | Dentro | Fora (referência por id) |
|---|---|---|---|
| 1 | **Tenant** | perfil de vertical ativo, limites do plano, configuração de ciclo de vida | plano (catálogo global), tudo o mais |
| 2 | **Usuario** | vínculos `(filial, papel)` e de canal, identidades externas por conexão | carteira, tarefas |
| 3 | **Contato** | nomes, telefones, documentos, endereços, preferências, campos personalizados, identidades externas, **histórico de carteira** | conversas, pedidos, tarefas, negócios no funil |
| 4 | **Pessoa** | dados da pessoa | vínculos com contatos (tabela de ligação própria) |
| 5 | **CanalConectado** | especialização (número WhatsApp \| perfil Instagram), credenciais Meta, capacidades, saúde, tier, filial, usuários com acesso | conversas |
| 6 | **ThrottleDoCanal** | próximo envio permitido, baldes horários de conversas iniciadas | — |
| 7 | **Conversa** | estado, versão, timestamps da janela, atendimento atual | mensagens (ver 3.4), contato, canal, **leituras por usuário** |
| 8 | **Mensagem** | conteúdo, status de entrega, mídias, custo | conversa, campanha, atendimento |
| 9 | **Atendimento** | protocolo, dono, setor, transferências, encerramento | conversa |
| 10 | **Pedido** | itens, grade, snapshot de condição, tentativas de efetivação | contato, produtos, conversa, campanha, tarefa |
| 11 | **Venda** | itens da venda | contato, pedido de origem |
| 12 | **Produto** | variantes (SKU), atributos, imagens | tabela de preço, saldo |
| 13 | **TabelaDePreco** | itens e vigência | produtos |
| 14 | **Campanha** | definição, público (critério), template, contadores | destinatários, números |
| 15 | **DestinatarioDeCampanha** | estado de envio, erro, custo | campanha, contato, mensagem |
| 16 | **Template** | versões, status na Meta | — |
| 17 | **Funil** | etapas, automações | negócios |
| 18 | **NegocioNoFunil** | etapa atual, motivo de perda, histórico de etapas | contato, funil |
| 19 | **Tarefa** | descrição, tipo, canal, conclusão | contato, responsável, conversa |
| 20 | **ConexaoDeErp** | credencial cifrada, capacidades, estado de sincronização | — |
| 21 | **EventoExterno / Outbox / OperacaoDeIngestao** | infraestrutura | — |

### 3.1 Por que a carteira está **dentro** do Contato

INV-32 e INV-33 exigem que fechar a atribuição vigente e abrir a nova aconteçam **atomicamente** —
duas transações produzem contato com dois donos ou com nenhum, e comissão vira discussão. Além
disso, o card do kanban lê o dono junto com o contato. Custo aceito: a tabela `carteira_atribuicao`
é filha do agregado, não agregado próprio.

### 3.2 Por que Pessoa é agregado próprio

A mesma pessoa (o comprador) aparece em duas empresas do mesmo grupo econômico. Colocá-la dentro do
Contato duplicaria a pessoa e quebraria a timeline. Vínculo N:N com papel.

### 3.3 Por que o destinatário de campanha é agregado próprio

Uma campanha tem **50 mil destinatários**. Carregar o agregado inteiro para marcar um envio como
entregue é inviável, e a linha de destinatário é escrita por workers concorrentes. Os contadores da
Campanha (enviados, entregues, lidos, falhas) são atualizados por **consistência eventual explícita**
— evento pós-commit, não na mesma transação.

### 3.4 Conversa e Mensagem — a fronteira mais delicada

A janela de atendimento (INV-18) depende da última mensagem entrante, o que **sugere** que Mensagem está
dentro de Conversa. Mas a tabela tem milhões de linhas e é particionada.

**Decisão:** a fronteira de transação da ingestão de mensagem é **`conversa` + a mensagem sendo
gravada + o contato-lead quando ele é novo** — nunca "todas as mensagens da conversa". A Conversa
mantém desnormalizado o que a invariante precisa (`ultima_entrante_em`, `ultima_mensagem_em`,
`ultima_direcao`, `versao`, `atendimento_atual_id`), atualizado no **mesmo commit** da mensagem, com
lock na linha da conversa.

⚠️ Sem esse commit único, a badge de janela diverge do histórico — e é o tipo de divergência que o
usuário vê antes do time.

### 3.4.1 "Não lidas" é do usuário, não da conversa

`conversa.nao_lidas int` **saiu do modelo**. Leitura é ato de uma pessoa, e a §4 estabelece
`usuario_canal` N:N justamente porque várias pessoas veem a mesma conversa (vendedora com 2 números,
supervisor vendo a frota). Com um contador único, **o supervisor abrindo a conversa para auditar
zerava a badge da vendedora** e ela perdia o item de trabalho; o filtro "só sem resposta" — o mais
usado do dia — ficava sujeito a quem abriu primeiro.

```
conversa_leitura (tenant_id, conversa_id, usuario_id, lida_ate_versao)
                  PK (tenant_id, conversa_id, usuario_id)
```

Reaproveita a `versao` que a conversa **já mantém** para o cursor de reconexão SSE: não lida ⇔
`conversa.versao > coalesce(lida_ate_versao, 0)`. Custo baixo, resolve também o badge do app mobile.
⚠️ Decidido agora porque retrofit muda a **query mais quente do produto**.

### 3.5 Por que Atendimento é separado de Conversa

| | Conversa | Atendimento |
|---|---|---|
| Duração | Perpétua (o thread com aquele contato naquele canal) | Episódio: começa, tem dono, termina |
| Identidade | `(canal, contato)` | `protocolo` sequencial |
| Cardinalidade | 1 | N por conversa, ao longo do tempo |
| Funcionalidades | INB-01…08 | INB-09/10/11 (fila, assumir), INB-15/16 (transferir, encerrar), INB-22/23 (SLA, CSAT) |

Fundir os dois obriga a reabrir e reescrever o mesmo registro a cada novo ciclo, e destrói o
histórico de "quem atendeu o quê, quando" — que é a base de GES-03 e de INB-22/24.
⚠️ Custo declarado: na Onda 1 o Atendimento tem só protocolo + dono + assumido_em. Ele **existe
desde o começo**, mesmo simples, porque retrofitá-lo exigiria reprocessar todo o histórico.

⚠️ **Separar os dois só serve se a mensagem souber a que episódio pertence.** Por isso
`mensagem.atendimento_id` (nulável) é preenchido na ingestão e no envio — o atendimento vigente da
conversa já está em memória naquele commit (`conversa.atendimento_atual_id`, §3.4). Sem essa coluna,
atribuir mensagem a episódio exigiria **join por faixa de tempo** (`assumido_em ≤ criado_em <
encerrado_em`) contra uma tabela particionada de milhões de linhas — inviável para GES-03 (tempo
médio de resposta, conversas atendidas, receita por pessoa), que é **Onda 2**. E o join por faixa é
ambíguo nos buracos entre episódios. **Regra para mensagem fora de episódio:** `atendimento_id NULL`
é legítimo (mensagem de campanha, automação, ou entrante que ainda não gerou episódio) e essas
mensagens ficam **fora** de toda métrica de atendimento — nunca rateadas no episódio anterior.

### 3.6 Por que o throttle do canal é agregado próprio

É a linha **mais contendida** do sistema durante um disparo: dezenas de workers reservando slot no
mesmo número. Mantê-la dentro do agregado CanalConectado faria toda atualização de saúde, nome
amigável ou filial competir com o disparo. Tabela minúscula, `UPDATE … RETURNING` atômico, zero
invariante de negócio compartilhada com o resto do canal.

⚠️ **São duas coisas com formas diferentes, e juntá-las numa tabela só foi o erro corrigido em
INV-22/23:**

| Controle | Unidade | Forma |
|---|---|---|
| Intervalo mínimo entre envios (INV-23) | por **canal** | uma linha por canal, `UPDATE … RETURNING` |
| Limite de tier (INV-22) | por **canal × contato × janela móvel de 24 h** | `numero_conversa_iniciada` (reserva por `INSERT … ON CONFLICT`) + baldes horários para a contagem |

### 3.7 Por que Venda é separada de Pedido

| | Pedido | Venda |
|---|---|---|
| Origem | Nasce no GeraCRM (rascunho na conversa) | Vem do ERP (ingestão em lote, INT-01/05) |
| Volume | Milhares | **Milhões** (anos de carga histórica) |
| Mutabilidade | Vivo: itens entram e saem, valida, tenta efetivar | Fato praticamente imutável |
| Serve a | PED-01…11 | RFV, BI, atribuição |

Uni-los criaria uma tabela onde 99% das linhas nunca passaram por rascunho, carregando colunas de
validação e tentativa que não se aplicam — e a carga histórica competiria com a montagem de pedido.
**Ligação:** ao efetivar, o Pedido guarda `numero_externo`; quando a Venda correspondente chega pela
ingestão, ela é reconciliada com o Pedido por esse número (§6.6). ⚠️ Nem toda Venda tem Pedido — a
maioria é venda lançada direto no ERP.

### 3.8 As quatro travessias de agregado assumidas

Toda operação abaixo toca mais de um agregado. Nenhuma é acidente: cada uma tem consistência
eventual **declarada**, via outbox pós-commit.

| Operação | Agregados | Consistência |
|---|---|---|
| Mensagem recebida | Mensagem + Conversa + **Contato, se novo** | ⚠️ **Transacional, incluindo o contato-lead** (exceção justificada, §3.4) |
| Pedido efetivado | Pedido → Contato (contador), NegocioNoFunil, Tarefa. ⚠️ **Venda NÃO é criada aqui** | **Eventual**, por evento pós-commit |
| Envio de campanha | Destinatario + Throttle/Quota + Mensagem + CustoDeMensagem | Quota reservada **antes** (INV-22); o resto é eventual |
| **Ingestão de venda em lote** | Venda → Contato (contadores) → coluna do Funil de Relacionamento → RFV → cobertura da conexão | **Eventual, com reconciliação obrigatória ao fim do lote** (INV-57). ⚠️ Estava oculta e é a que mais dói |

⚠️ **O contato-lead deixou de nascer em transação própria.** Se a transação da mensagem falhasse
(violação de unicidade do `wamid`, partição indisponível, erro do handler), o lead permanecia — sem
conversa, sem mensagem, sem origem visível. Webhooks são reentregues e falhas parciais são o normal
em ingestão, então o efeito é **cumulativo** e vai parar onde dói: a coluna "Lead" do Funil de
Relacionamento, o público de campanha materializado por critério e a fila de deduplicação (CTT-11) —
sem que ninguém consiga distinguir "lead fantasma de rollback" de "lead real que nunca respondeu".
Criar o contato no mesmo commit não muda a ordem de grandeza do lock (a transação já envolve conversa
+ mensagem) e elimina a anomalia.

⚠️ **A efetivação do pedido não cria Venda — e a tabela dizia o contrário.** A §3.7 e a §6.6 são
inequívocas: Venda é fato do ERP, chega pela ingestão, e enquanto ela não chega o **pedido efetivado
conta como pedido, não como venda**. Se a efetivação criasse a Venda, ela colidiria com a linha que a
ingestão traria depois (mesma `(conexao_id, numero_externo)`) ou, pior, criaria venda **sem**
`numero_externo` que nunca casa e passa a contar **em dobro** no RFV — exatamente o que a §6.6 abre
dizendo que precisa evitar. Pelo mesmo motivo, `atribuicao_receita` **também não nasce na
efetivação**: ela depende de `venda_id`, que naquele instante ainda não existe.

---

## 4. Relacionamentos — cardinalidade real

> O mundo real é mais bagunçado que o diagrama inicial. Cada "não" abaixo virou estrutura;
> descobrir depois custa migração.

| Relação | Ingênuo | **Real** | Estrutura | ⚠️ Armadilha |
|---|---|---|---|---|
| Contato → Telefone | 1:1 | **1 principal (único no tenant) + N secundários (repetíveis)** | `contato_telefone` com única **parcial** `WHERE principal` | CTT-02. O ERP tem o fixo, o WhatsApp tem o celular, a vendedora tem o do dono. ⚠️ Única total quebrava a ingestão (INV-07/49) |
| Contato → Documento | 1:1 | **1:N com chave local `seq`, um fiscal padrão** | `contato_documento (seq, apelido, fiscal_padrao)` | CTT-03. ⚠️ O Pedido precisa **escolher qual** — "faturar na filial 2" (§5.3) |
| Contato → Nome | 1:1 | **1:N por fonte, um preferido** | `contato_nome` com `fonte` | CTT-01. "ver todos os nomes" existe porque o mesmo CNPJ chega com grafia diferente de cada fonte |
| Contato → Endereço | 1:1 | **1:N com chave local `seq`, um de entrega padrão** | `contato_endereco (seq, apelido, tipo, entrega_padrao)` | ⚠️ Chaveado só por `(contato_id, tipo)` cabia **um** endereço de entrega — e lojista com matriz + duas filiais é o caso normal |
| Contato ↔ Pessoa | 1:N | **N:N com papel** | `pessoa_contato (papel)` | CTT-09. O comprador atende duas lojas do mesmo dono |
| Contato ↔ GrupoEconomico | — | **N:1** | `contato.grupo_id` nulável → `grupo_economico` | Agrupa na tela e no filtro. ⚠️ **Não** agrega RFV: pedido e nota são por CNPJ |
| Contato ↔ Canal da frota | — | **N:N derivada** | projeção `contato_canal` | CTT-07 "está no telefone". Existe **porque há conversa** naquele canal, não por cadastro |
| Contato → Conversa | 1:1 | **1:N (uma por canal)** | `UNIQUE(tenant_id, canal_id, contato_id)` | O mesmo cliente falando com 3 vendedoras são 3 conversas — e o card do kanban mostra "Eduarda, Sandy +3" |
| Conversa ↔ Usuario (leitura) | — | **N:N** | `conversa_leitura (lida_ate_versao)` | §3.4.1. ⚠️ Contador único na conversa fazia o supervisor zerar a badge da vendedora |
| Conversa → Atendimento | 1:1 | **1:N ao longo do tempo** | `atendimento.conversa_id` | §3.5 |
| Conversa → Mensagem | 1:N | 1:N (particionada) | `mensagem.conversa_id` + partição | Nunca carregar tudo (INV-47) |
| Contato → Dono (carteira) | 1:1 | **1 vigente + N histórico** | `carteira_atribuicao [de, ate)` | CRM-07. "Quem era o dono em março?" é pergunta real de comissão |
| Contato ↔ Funil | 1:1 | **N (um por funil)** | `UNIQUE(tenant_id, funil_id, contato_id)` | CRM-05: comercial, cobrança e reativação rodam ao mesmo tempo |
| CanalConectado → Especialização | 1:1 | **1:1 por tipo** | `numero_whatsapp` \| `perfil_instagram` | Instagram não tem telefone, WABA nem tier. ⚠️ Nulável por tipo sem `CHECK` é o caminho para dois canais no mesmo índice |
| CanalConectado → Filial | 1:1 | **0..1** | `canal_conectado.filial_id` nulável | Tenant sem filiais é o caso comum no começo |
| CanalConectado ↔ Usuario | 1:1 | **N:N** | `usuario_canal` | Vendedora pode ter 2 números; supervisor vê a frota inteira |
| Campanha ↔ CanalConectado | 1:1 | **N:N** | `campanha_canal` | CMP-08: disparo distribuído pela frota, com comparação entre números |
| Usuario ↔ Sistema externo | — | **1:N (um por conexão)** | `usuario_identidade_externa` | ⚠️ Sem isso, `venda.vendedor_externo` (string do ERP) não vira ranking de vendedor (GES-02/03) |
| Filial ↔ Sistema externo | — | **1:N (um por conexão)** | `filial_identidade_externa` | Filtro "todas as filiais" da Home e RFV-09 |
| Produto/Variante ↔ Sistema externo | 1:1 | **1:N (um por conexão)** | `produto_identidade_externa`, `variante_identidade_externa` | ⚠️ `produto.conexao_id` embutido impedia o mesmo produto existir nos dois ERPs (§6.7) |
| Pedido → Conversa | 1:1 | **0..1** | `pedido.conversa_id` nulável | Pedido de campo (FDV) e de showroom nascem sem conversa |
| Pedido → Origem | — | **0..1 campanha, 0..1 tarefa, 1 vendedora** | colunas nuláveis | PED-09: é a base da atribuição **exata** |
| Pedido ↔ Venda | 1:1 | **0..1 nos dois sentidos** | `venda.pedido_id` nulável | A maioria das vendas históricas não tem pedido nosso |
| Contato ↔ Sistema externo | 1:1 | **1:N (um por conexão)** | `contato_identidade_externa` | O mesmo cliente existe no GeraCloud **e** no drezz |
| Produto → Variante | 1:N | 1:N com atributos configuráveis | `produto_variante` + `variante_atributo` | ADR-004: cor/tamanho não são colunas |
| Mensagem → Mídia | 1:1 | **1:N** | `midia.mensagem_id` | Álbum de imagens chega como um evento |
| Campanha → Destinatário → Mensagem | — | **1:N → 0..1** | `destinatario.mensagem_id` nulável | Destinatário que falhou antes do envio não tem mensagem |
| Tenant → Tenant | — | **0..1 (revenda)** | `tenant.tenant_pai_id` | PLT-10, Onda 4 — a coluna nasce agora, vazia |

### 4.1 A decisão dura: **telefone principal** é único por tenant

Dois contatos com o mesmo celular acontece de verdade — é o dono com duas lojas e dois CNPJs.

**Decisão fechada (era a decisão aberta nº 6):**

1. **Contato é por CNPJ.** Pedido e nota são por CNPJ, logo venda é por CNPJ, logo RFV é por CNPJ.
   Matriz e filiais são **contatos separados**, ligados por `grupo_economico` para agrupar na tela e
   no filtro — **nunca** para somar RFV.
2. **Só o telefone principal é único** (INV-07). O mesmo celular pode aparecer como **secundário** em
   quantos contatos existirem.
3. A conversa entrante ancora no contato que tem aquele telefone como **principal** (INV-49) — dono
   determinístico, sem perguntar nada a ninguém.
4. A tela do pedido oferece **"trocar a empresa deste pedido"** entre os contatos do mesmo grupo
   econômico / da mesma Pessoa. É aí que o caso das duas lojas se resolve: na hora de faturar.

**Por quê:** o WhatsApp entrega mensagem por número. Se dois contatos disputassem o mesmo telefone de
roteamento, o produto teria que perguntar "de qual empresa é essa mensagem?" a cada evento.

⚠️ **As duas saídas antigas não funcionavam, e uma delas contradizia a §6.2.**

| Saída antiga | Por que caiu |
|---|---|
| "Resolve-se por **Pessoa** vinculada a dois Contatos" | Pessoa **não tem conversa, nem pedido, nem funil**. A mensagem continua caindo em **um** Contato e a segunda loja fica invisível naquele atendimento — não resolvia nada operacionalmente |
| "O segundo CNPJ entra como **documento adicional do mesmo Contato**" | É literalmente a **fusão que a §6.2 proíbe**: as vendas dos dois CNPJs, resolvidas por documento na ingestão, passam a somar no mesmo contato — misturando histórico de compra de dois clientes e corrompendo o RFV dos dois. O documento condenava isso numa seção e prescrevia na outra |

⚠️ **`pessoa.telefone_e164` foi removido.** Ele criava um universo paralelo de telefone **fora** de
`contato_telefone` e sem constraint nenhuma: se o celular do comprador só existisse ali, a ingestão de
mensagem (INV-12) não o encontrava e criava um contato-lead duplicado; se existisse nos dois lugares,
eram duas verdades sem dono de sincronização. O telefone da Pessoa é **derivado**: é o telefone do
Contato onde ela tem o papel de comprador.

---

## 5. Temporalidade

| Padrão | Custo | Onde usamos |
|---|---|---|
| **Estado atual** | Baixo | Cadastro, catálogo, preferências, configuração |
| **Histórico de mudanças** | Médio | Carteira, etapa de funil, saúde do número, permissões, qualificação |
| **Série temporal** | Alto | Segmento RFV, custo por mensagem, métricas diárias de número |
| **Snapshot em documento** | Baixo | Preço, condição, regras comerciais, texto de template |
| **Derivado (não gravar)** | Zero | Janela de atendimento, ciclo de vida, dias sem comprar, colunas do funil de relacionamento, **realizado da meta** |

### 5.1 Histórico de carteira — obrigatório e auditável

```
CREATE EXTENSION IF NOT EXISTS btree_gist;

carteira_atribuicao (tenant_id, id, contato_id,
                     usuario_id,          -- NULL = "sem dono" (órfão), linha explícita
                     de, ate, autor_id, motivo,
                     periodo tstzrange GENERATED ALWAYS AS (tstzrange(de, ate, '[)')) STORED)
                     ate IS NULL = vigente
  EXCLUDE USING gist (tenant_id WITH =, contato_id WITH =, periodo WITH &&)
```

- Um vigente por contato (INV-32), **sem sobreposição** (INV-33) e **sem lacuna** (INV-58).

⚠️ **O `EXCLUDE` cobria metade e a redação antiga prometia o dobro.** Ele impede **sobreposição**; nada
— nem ele, nem índice, nem `CHECK` — impede **lacuna**. Fechar uma atribuição sem abrir a próxima
(transferência que falha no meio, vendedora desligada) deixava o contato sem dono num intervalo, e a
pergunta de comissão *"quem era o dono em março?"* devolvia **vazio** — exatamente o cenário que esta
seção diz estar resolvendo. A linha explícita de `usuario_id IS NULL` torna a lacuna **impossível por
construção** e, de quebra, dá endereço ao contato órfão (decisão aberta nº 7).

⚠️ **Detalhe de viabilidade que faltava:** `EXCLUDE USING gist` com `tenant_id`/`contato_id` exige a
extensão **`btree_gist`**, e o operador `&&` **não existe** sobre `de`/`ate` como colunas soltas — daí
a coluna **gerada** `periodo`.
- Responde: *"quem era o dono desse cliente em março?"* — pergunta de comissão, não curiosidade.
- ⚠️ **Sem isso, comissão vira discussão e ninguém consegue auditar.** É citado explicitamente em
  CRM-07 e na ficha do cliente (§3.2 da spec de telas).

### 5.2 Evolução do segmento RFV — série temporal, com economia

RFV-02 pede o gráfico da trajetória nas 11 faixas. O erro caro seria gravar **uma linha por contato
por dia**: 50 mil contatos × 365 dias = 18 milhões de linhas/ano por tenant, para um gráfico com
5 pontos.

**Decisão:** gravar **na transição**, não na avaliação.

```
rfv_evento (tenant_id, contato_id, faixa_de, faixa_para, r, f, v, avaliado_em, motivo)
```

- Uma linha só quando a faixa **muda**, mais uma **âncora mensal** por contato ativo (garante que o
  gráfico tenha pontos mesmo para quem nunca mudou).
- O estado vigente fica em view materializada (`mv_rfv_segmento_atual`), não em coluna do contato —
  ⚠️ coluna no contato faria o job de RFV escrever em milhões de linhas da tabela mais lida do
  produto.
- ⚠️ **`rfv_evento` não tem vigência, e a invariante precisou ser reescrita para o modelo que existe.**
  INV-45 dizia "um registro vigente por contato, protegido por índice parcial `WHERE ate IS NULL`" —
  mas não há coluna `ate` nem qualquer noção de vigência aqui, e o vigente mora numa **view
  materializada, que não impõe invariante de escrita**. O que este modelo de fato sustenta é
  encadeamento: `UNIQUE(tenant_id, contato_id, avaliado_em)` mais trigger garantindo `faixa_de` da
  linha N = `faixa_para` da linha N-1.
- ⚠️ Nenhuma linha é gravada para contato **fora da cobertura de dados** da conexão (INV-56): sem
  histórico de venda ingerido, "Perdido" não é classificação, é chute.
- ⚠️ **A trajetória vale mais que a foto.** "Era Campeão e virou Em Risco" é urgência; "sempre foi
  Em Risco" é outro tipo de trabalho. O modelo precisa distinguir os dois — por isso `faixa_de` e
  `faixa_para` na mesma linha.

### 5.3 Preço e condição no pedido — snapshot, nunca referência

```
pedido_item (…, preco_unitario_centavos, tabela_preco_id, tabela_preco_nome,
                 desconto_pct, origem_do_preco, capturado_em)
pedido      (…, documento_seq,              -- QUAL documento originou o snapshot
                endereco_entrega_seq,       -- QUAL endereço originou o snapshot
                condicao_snapshot jsonb, regras_aplicadas jsonb, cliente_fiscal_snapshot jsonb)
```

⚠️ **Snapshot de uma escolha que o modelo não permitia fazer é snapshot de nada.** A cardinalidade
1:N de documento e endereço estava reconhecida na §4, mas o Pedido não tinha como escolher entre os
N: INV-08 forçava **um** documento fiscal por contato e `contato_endereco` era chaveado por
`(contato_id, tipo)`, portanto **um** endereço de entrega. No atacado de moda o caso normal é lojista
com matriz + duas filiais, CNPJs e endereços de entrega distintos, e o pedido é faturado num CNPJ e
entregue num endereço específicos — "pedido faturado na filial 2" **não era nem representável**. Na
prática a vendedora voltaria ao ERP para faturar certo, que é o cenário de abandono do ⚠️ de INV-30.

⚠️ `seq` é **chave local dentro do agregado Contato**, não promoção a entidade: não cria UUID, não
cria CRUD, não cria órfão. `apelido` ("Matriz", "Filial Boa Viagem") é o que a UI mostra no seletor.

- ⚠️ **Se o item apontasse para o preço atual do produto, o histórico financeiro se corromperia no
  primeiro reajuste** — e o relatório de ontem mudaria sozinho.
- `regras_aplicadas` congela pedido mínimo, múltiplo de grade e mix vigentes na criação do rascunho
  (INV-28). Um rascunho de três dias atrás não pode ficar inválido porque o gestor mudou a regra —
  mas a **revalidação na efetivação** apresenta a divergência.
- `cliente_fiscal_snapshot` guarda CNPJ e endereço usados: o cadastro muda, a nota já foi.
- Mesma regra para **mensagem enviada por template**: grava o **texto renderizado**, não o
  `template_id` (INV-20). A versão do template muda; a mensagem que o cliente leu, não.

### 5.4 O que é derivado e **não** se grava

| Derivado | De onde | ⚠️ Por que não gravar |
|---|---|---|
| Janela de atendimento aberta/fechada | `conversa.ultima_entrante_em` + `canal_conectado.capacidades.janela_horas` | Flag gravada precisa de alguém para virá-la — e às 23h59 ninguém vira |
| Dias sem comprar, média entre vendas, ticket | `venda` | Muda todo dia sozinho |
| Ciclo de vida (Ativo/Inativo/Perdido) | dias sem comprar + config do tenant | O dono do negócio muda o corte e tudo reclassifica |
| Colunas do Funil de Relacionamento | `contato.qtd_vendas` (**cache** de `mv_metricas_contato`) | §1.2 — duas verdades divergem no primeiro pedido importado |
| **Realizado da meta** (GES-01) | `venda` + `usuario_identidade_externa` | Gravar realizado é criar a terceira verdade; a meta guarda só o **alvo** |
| "Está no telefone" | existência de conversa por canal | Projeção (materializada por performance, §8.4) |

⚠️ **Exceção consciente:** as transições de ciclo de vida **geram evento** ("cruzou para Em Risco"),
porque a régua de relacionamento precisa disparar tarefa no momento da travessia. O **estado** é
derivado; a **travessia** é fato.

### 5.5 Custo por mensagem — série temporal com tarifa versionada

```
custo_mensagem (tenant_id, id, mensagem_id, mensagem_criado_em, canal_id, campanha_id,
                categoria, pais, centavos bigint, tarifa_id, cobrado_em, estimado bool)
                UNIQUE (tenant_id, mensagem_criado_em, mensagem_id, categoria)   -- INV-54
tarifa_meta    (categoria, pais, centavos bigint, vigente_de, vigente_ate)
```

- ⚠️ **O cliente paga a Meta direto (ADR-002), mas quem mostra o ROI somos nós.** Sem custo por
  mensagem, CMP-12 e BI-11 — os dois diferenciais mais comerciais do produto — não existem.
- ⚠️ **A Meta não devolve o preço na resposta de envio.** O custo é **calculado por nós** a partir da
  tabela de tarifa vigente por categoria e país. Por isso `estimado` e `tarifa_id`: quando a tarifa
  muda, o histórico não pode ser recalculado retroativamente.
- Mensagem de serviço dentro da janela de atendimento é gratuita — grava-se a linha com
  `centavos = 0`, não se omite a linha. Omitir impede provar que o toque foi barato.
- ⚠️ **Nenhuma invariante cobria custo, e ele sustenta os dois diferenciais mais comerciais.** Agora
  cobrem: INV-54 (uma linha por mensagem × categoria) e INV-57 (`campanha.custo_centavos` é
  **projeção** de `custo_mensagem`, com job de reconciliação — não um terceiro contador solto).

### 5.6 Resumo por dado

| Dado | Padrão | Onde |
|---|---|---|
| Cadastro do contato | Estado atual + **origem por campo** | `contato` + `contato_campo_origem` |
| Preferência de campanha/automação | Estado atual + **histórico de consentimento** (LGPD) | `contato` + `consentimento_contato` |
| Carteira | **Histórico de mudanças** | `carteira_atribuicao` |
| Etapa de funil | **Histórico** (tempo em estágio é métrica de 1ª classe) | `negocio_funil_evento` |
| Segmento RFV | **Série temporal por transição** | `rfv_evento` |
| Contadores do contato (qtd, 1ª/última venda, último toque) | **Cache reconciliável** (INV-57) | `contato` ← `mv_metricas_contato` |
| Cobertura de dados por conexão e fluxo | **Estado atual declarado** (INV-56) | `conexao_erp_cobertura` |
| Condição comercial e crédito do contato | **Valor apurado com hora e origem** | `contato_condicao_comercial`, `contato_credito` |
| Saúde/tier do número | **Histórico** + série diária | `canal_saude_evento`, `metrica_numero_dia` |
| Preço/condição no pedido | **Snapshot** | `pedido_item`, `pedido` |
| Texto de template enviado | **Snapshot** | `mensagem.conteudo` |
| Custo por mensagem | **Série temporal** com tarifa versionada | `custo_mensagem` |
| Mensagens | Fato imutável, **particionado por período** | `mensagem` |
| Status de entrega | Estado atual monotônico (INV-39) | `mensagem.status` |

---

## 6. Identidade externa e reconciliação

> N ERPs + WhatsApp + Instagram + importação CSV + IA escrevendo no **mesmo cadastro**. Sem regra
> explícita, ninguém consegue explicar por que o nome do cliente mudou sozinho.

### 6.1 Duas identidades, nunca uma

```
Contato
  id (UUID v7)                    ← NOSSA identidade: interna, estável, nunca exposta na UI
  identidades_externas [
    { conexao: geracloud_prod, sistema: 'erp',       id_externo: '4471' },
    { conexao: drezz_loja2,    sistema: 'erp',       id_externo: 'C-88' },
    { conexao: meta_waba_1,    sistema: 'whatsapp',  id_externo: '5581998617049' },
    { conexao: meta_ig_1,      sistema: 'instagram', id_externo: '178414…' }
  ]
```

**Regras duras:**
- ⚠️ **Nunca** usar id externo como chave primária. Ele muda, se repete entre sistemas e some quando
  a integração troca.
- Guardar **todos** os ids externos, com `visto_em` — não só o último.
- ⚠️ A UI **nunca** mostra id interno (regra §0.3 da spec de telas).

### 6.2 A chave de reconciliação — precedência declarada

| Ordem | Chave | Força | Casa automático? |
|---|---|---|---|
| 1 | `(conexao_id, id_externo)` — mesma conexão | **Determinística** | ✅ Sim |
| 2 | CNPJ/CPF normalizado, com dígito verificador validado | **Forte** | ✅ Sim |
| 3 | `instagram_id` da mesma conexão | Forte no canal | ✅ Sim, mas não identifica CNPJ |
| 4 | Telefone E.164 | **Média** | ⚠️ **Não.** Cria contato novo; o telefone entra nele como **secundário** (o principal continua sendo do contato que já tinha) e abre-se `conflito_identidade` + sugestão de mesclagem |
| 5 | E-mail | Fraca | ❌ Nunca sozinho (`contato@` compartilhado por grupo) |
| 6 | Nome / razão social | Nula | ❌ Nunca, em hipótese alguma |
| — | `chave_busca` reduzida (55+DDD+8) | Nula para cadastro | ❌ Nunca casa; **só** sugere. ⚠️ Mas **é a chave usada no bloqueio** (INV-50) — assimetria deliberada |

⚠️ **Casamento automático só com chave forte.** Chave média sozinha vira **sugestão** para CTT-11
(deduplicação e mesclagem), nunca fusão silenciosa. Fundir errado é irreversível na prática: mistura
histórico de compra de dois clientes e corrompe o RFV dos dois.

### 6.3 Origem por campo

```
contato_campo_origem (tenant_id, contato_id, campo, fonte, conexao_id,
                      atualizado_em, valor_anterior)
```

**Precedência default** (configurável por tenant):

```
manual (usuário)  >  ERP fiscal (conexao_erp.papel = 'fiscal')
                  >  ERP secundário (ordenado por conexao_erp.precedencia)
                  >  canal (WhatsApp/Instagram)  >  extração por IA  >  CSV
```

⚠️ **INV-10 era indecidível quando as duas fontes eram "ERP".** `conexao_erp` não tinha nenhuma coluna
que marcasse a fonte de verdade cadastral nem que ordenasse duas conexões — e o cenário multi-ERP é
assumido como normal no §6.1 (o exemplo canônico tem `geracloud_prod` **e** `drezz_loja2` no mesmo
tenant). Agora tem: `papel ('fiscal'|'secundario')` com **no máximo uma fiscal por tenant**
(`UNIQUE (tenant_id) WHERE papel = 'fiscal'`) e `precedencia int` para desempatar as secundárias.
`fonte_de_venda bool` é decisão **separada** de `papel` (INV-55) — o ERP fiscal do cadastro não é
necessariamente o que fatura.

- ⚠️ **Fonte de menor precedência não sobrescreve — ela adiciona** (INV-10). O nome vindo do
  WhatsApp entra como `contato_nome` alternativo, nunca por cima do nome do ERP fiscal.
- O que é multi-valorado por natureza (nome, telefone, documento) **nunca** sobrescreve: acrescenta.
- O que é escalar (cidade, e-mail, aniversário) segue a precedência, e a troca fica registrada com
  `valor_anterior`.
- Isso é o que responde *"por que o nome mudou sozinho?"* — a pergunta que sempre aparece no
  segundo mês de integração.

### 6.4 Quando duas chaves discordam

Caso real: o ERP diz que o cliente `4471` tem CNPJ `A`. No GeraCRM, o CNPJ `A` já pertence a um
contato ligado ao id externo `9982` da mesma conexão.

**O que **não** fazer:** sobrescrever, fundir automaticamente, ou escolher "o mais recente".

**O que fazer:**

| Passo | Ação |
|---|---|
| 1 | Registrar `conflito_de_identidade (chave_a, chave_b, contato_a, contato_b, detectado_em)` |
| 2 | **Manter os dois contatos** e **manter o vínculo mais antigo** — quem já estava, continua |
| 3 | Não aplicar a escrita conflitante; aplicar apenas os campos não conflitantes |
| 4 | Expor na tela de qualidade cadastral (RFV-08) e na fila de deduplicação (CTT-11) |
| 5 | A fusão é **operação humana**, registra quem fundiu, e é **reversível** — `contato_mesclagem` guarda o que veio de onde |

⚠️ **Deixar o conflito visível é melhor que resolvê-lo errado em silêncio.** O produto que "resolve
sozinho" é o que produz o cliente com dois históricos de compra e o RFV que ninguém entende.

#### 6.4.1 A mesclagem, agregado por agregado

A mesclagem **não é excepcional**: o caminho do telefone como chave média (§6.2, linha 4) a produz
toda semana. E cada agregado filho com única por contato tem uma decisão própria — sem ela, o
`UPDATE … SET contato_id = vencedor` **estoura na primeira conversa** e INV-11 ("a fusão é
reversível") não se sustenta.

| Agregado | Unicidade em jogo | Decisão |
|---|---|---|
| `conversa` | `UNIQUE(tenant_id, canal_id, contato_id)` | **Manter as duas linhas fisicamente**; a UI apresenta como thread único do contato vencedor. ⚠️ Mover mensagens e fechar a perdedora é **irreversível** — e INV-11 exige reversibilidade |
| `contato_telefone` | única parcial `WHERE principal` | O principal do **vencedor** permanece; o do perdedor vira **secundário** |
| `negocio_funil` | `UNIQUE(tenant_id, funil_id, contato_id)` | A **etapa mais avançada vence**; a outra linha é encerrada com `negocio_funil_evento (origem='mesclagem')` |
| `carteira_atribuicao` | INV-32 (um dono vigente) | A atribuição do **perdedor é fechada na data da fusão**; o dono do vencedor continua. Sem isso, a fusão produz contato com dois donos vigentes |
| `campanha_destinatario` | `UNIQUE(campanha, contato)` | **Mantém as duas linhas históricas**, apontando para o vencedor via `contato_mesclagem` na leitura. Reescrever destinatário de campanha fechada falsifica relatório já entregue |
| `pedido`, `venda`, `tarefa`, `comentario` | sem única por contato | Repontam direto para o vencedor |
| `consentimento_contato` | — | **União**, com a regra mais restritiva vencendo (opt-out de qualquer um dos dois vale para o resultado) |

`contato_mesclagem` guarda `dados_antes` de **todos** esses passos, que é o que torna o desfazer
possível.

### 6.5 Normalização de telefone — **na escrita**

`+55 81 99861-7049`, `5581998617049`, `81998617049` e `(81) 9861-7049` precisam colidir na mesma
chave, senão a base duplica silenciosamente.

```
contato_telefone (
  telefone_e164       text  -- +5581998617049  ← forma CANÔNICA INTERNA (nossa), única se principal
  telefone_e164_meta  text  -- +558198617049   ← forma que a Meta devolve; é a usada NO ENVIO
  telefone_bruto      text  -- como chegou, preservado para auditoria
  chave_busca         text  -- 55 + DDD + últimos 8 ← sugestão de cadastro E chave de bloqueio
  fonte, principal, visto_em
)
```

**Regras de normalização (Brasil):**
1. Remover tudo que não é dígito; aplicar o país default do tenant se não houver DDI.
2. ⚠️ **Nono dígito:** bases antigas de ERP trazem celular com 8 dígitos. A **forma canônica interna**
   acrescenta o 9 **quando o DDI é 55, o DDD é válido e a faixa indica celular** — regra determinística
   e declarada, não adivinhação. A forma como chegou fica em `telefone_bruto`.
3. `chave_busca` **nunca casa automaticamente no cadastro** — ali ela só alimenta a sugestão de
   mesclagem. ⚠️ Oito dígitos colidem entre fixo antigo e celular novo; casar por ela funde clientes
   diferentes. **No bloqueio ela é a chave** (INV-50).
4. O número que a Meta devolve (`wa_id`) é a forma **de envio**, guardada em `telefone_e164_meta` — e
   **não** é a canônica.

⚠️ **A regra 4 antiga (`wa_id` vira o canônico) era a fonte do bug, não a solução dele.** No Brasil o
`wa_id` de celular frequentemente vem **sem o nono dígito** (12 dígitos: 55+DDD+8) enquanto o
cadastro, o ERP e a digitação da vendedora trazem 13. Como a regra 2 corretamente proibia inventar o
9, as duas formas coexistiam como **duas linhas distintas** e `chave_busca` só gerava sugestão. O
estrago não era duplicidade cosmética:

```
cliente pede para sair pelo WhatsApp  →  lista_bloqueio recebe  55 81 98617049   (12)
campanha materializada do cadastro    →  dispara para          55 81 998617049  (13)
gateway revalida contra a lista       →  NÃO ENCONTRA          →  envia
```

INV-15 era burlável por diferença de formatação, no caso jurídico mais caro do produto. Com forma
canônica **independente da Meta** + bloqueio por `chave_busca`, os dois lados se encontram.

### 6.6 Reconciliação de pedido e venda

O pedido que **nós** efetivamos volta pela ingestão em lote como venda. Sem regra, o RFV conta duas
vezes.

```
pedido.numero_externo  ──┐
                          ├─► venda_chave_externa (tenant_id, conexao_id, numero_externo,
ingestão em lote ────────┘                          venda_id, venda_data)   UNIQUE  ← NÃO particionada
                                  venda.pedido_id preenchido no casamento
```

- Chave: `(conexao_id, numero_externo)`. Determinística.
- ⚠️ **A única não pode morar em `venda`.** `venda` é particionada por `data` (§8.5), e no Postgres
  índice único de tabela particionada **precisa conter a chave de partição** (INV-60). Incluir `data`
  na única destruiria a garantia: a mesma venda reingerida com a **data corrigida** entraria duas
  vezes, sem erro. Por isso a guardiã `venda_chave_externa`, pequena e não particionada, com a única
  de verdade — e é ela que a ingestão consulta antes de gravar.
- Enquanto a venda não chega, o pedido efetivado **conta como pedido**, não como venda — o RFV usa
  `venda`, e a atribuição exata usa o vínculo `pedido → venda` quando ele existe.
- ⚠️ Se o ERP não tem `webhookDeVenda` (capacidade ausente), a latência entre efetivar e aparecer no
  RFV é **declarada na interface** — não é bug, é degradação anunciada (ADR-008).

- ⚠️ **Duas conexões trazendo a mesma venda física** é caso separado e resolvido por INV-55: **uma só
  conexão é fonte de venda por tenant**. A segunda não grava — abre conflito.

### 6.7 Produtos e a armadilha do Instagram

- **Produto:** casa por `(conexao_id, id_externo)` em `produto_identidade_externa`; secundariamente
  por `referencia` dentro do tenant. ⚠️ Nunca por nome.
- ⚠️ **Catálogo tinha identidade externa de segunda classe, e o multi-ERP quebrava nele.** O Contato
  tem N identidades externas (uma por conexão), mas `produto` carregava **um** par
  `(conexao_id, id_externo)` embutido na própria linha. Com dois ERPs, o mesmo produto ou virava
  produto duplicado — quebrando `UNIQUE(tenant_id, referencia)` e o RFV-05 por categoria — ou perdia
  o vínculo com um deles. `saldo_cache` era pior: chaveado por `(tenant_id, variante_id)` com
  `conexao_id` como mero atributo, **dois ERPs com estoques distintos da mesma variante colidiam na
  mesma linha**, e o painel de pedido mostrava saldo de um ERP e efetivava no outro. `tabela_preco`
  não tinha identidade externa nenhuma, então reingerir tabelas duplicava ou sobrescrevia às cegas.
- **Correção:** `produto_identidade_externa`, `variante_identidade_externa` e
  `tabela_preco_identidade_externa`, todas `UNIQUE(tenant_id, conexao_id, id_externo)`; `saldo_cache`
  passa a ter chave `(tenant_id, conexao_id, variante_id)`. **A conexão que vale para o painel de
  pedido é a que vai receber o pedido** — declarado, não inferido.
- **Instagram:** o identificador de usuário (IGSID) é **escopado por app**. Trocar o app da Meta, ou
  o cliente reconectar por outro caminho, gera **id diferente para a mesma pessoa**. Consequência
  modelada: `instagram_id` é identidade externa **por conexão**, e a reconciliação entre Instagram e
  WhatsApp só acontece quando o cliente informa telefone ou CNPJ na conversa (IA-06 ajuda aqui).
  ⚠️ Prometer unificação automática Instagram↔WhatsApp é promessa que o modelo não sustenta.

### 6.8 Dado comercial do ERP: valor **com hora de apuração**, nunca sem fonte

O cabeçalho do Painel de Pedido (§2.2 da spec) mostra *"Tabela: ATACADO · Prazo 30d · Crédito
R$ 8.000"* como leitura ao vivo do ERP (INT-01b). ⚠️ **Num ERP sem essa capacidade (ADR-008) não havia
nem fonte remota nem fallback local, e a vendedora montava o pedido sem preço.**
`contato.classificacao ('atacado'|'varejo')` era a única pista, e não é a mesma coisa que "tabela
ATACADO, prazo 30d, desconto contratado 5%". O limite de crédito (PED-11) tinha o mesmo buraco,
apesar de o saldo já ter `saldo_cache` e o VO `SaldoApurado`.

| Capacidade da conexão | Como `contato_condicao_comercial` / `contato_credito` são preenchidos | O que a tela mostra |
|---|---|---|
| Leitura síncrona | Chamada no abrir do painel; `ao_vivo = true` | O valor, sem ressalva |
| Só ingestão em lote | Última ingestão; `ao_vivo = false`, `apurado_em` de ontem | O valor **com a hora de apuração visível** ("crédito apurado ontem 23h") |
| Nenhuma | Default do tenant / do perfil de vertical | Rótulo explícito de **valor padrão**, e a efetivação revalida no ERP (INV-28) |

⚠️ **Regra de atribuição de resposta a campanha** (CMP-10, e a razão de `campanha.janela_resposta_h`):
uma mensagem **entrante** recebe `campanha_id` quando chega numa conversa cuja última saliente é
daquela campanha **dentro da janela declarada**. A janela usada fica gravada, pelo mesmo motivo de
INV-44. Sem essa regra, `campanha.respostas` era contador sem lastro — e `opt_outs` também, porque
`consentimento_contato.origem` era texto livre **sem `campanha_id`**: não havia como reconstruir
"quantos saíram por causa DESTA campanha", que é exatamente a métrica que decide se a mensagem
queimou a base.

---

## 7. Multi-tenancy

> Decisão fechada no ADR-001. Ela é **transversal e não retroativa**: retrofitar tenancy é
> reescrever todo o acesso a dados.

### 7.1 As sete consequências em cada tabela

| # | Regra | Consequência prática |
|---|---|---|
| 1 | `tenant_id uuid NOT NULL` em **toda** tabela de domínio | Inclusive tabelas-filhas (`pedido_item`, `mensagem`, `contato_telefone`), mesmo sendo derivável do pai. ⚠️ RLS avalia a linha, não o join — checar pelo pai é caro e falível |
| 2 | **PK composta `(tenant_id, id)`** — e `(tenant_id, <chave_de_particao>, id)` nas tabelas particionadas | Todo índice de PK já começa por tenant. ⚠️ `(tenant_id, id)` é **impossível** em `mensagem`, `venda`, `campanha_destinatario`, `custo_mensagem` e `auditoria`: o Postgres exige a chave de partição na PK (INV-60) |
| 3 | **FK composta** `(tenant_id, pai_id) REFERENCES pai(tenant_id, id)` — **e com a chave de partição quando o pai é particionado** | Torna impossível ligar filho a pai de outro tenant (INV-04). ⚠️ Sem carregar a chave de partição do pai, o filho de tabela particionada **não pode ter FK nenhuma** — nem composta, nem simples |
| 4 | Toda `UNIQUE` composta com tenant | `UNIQUE(tenant_id, cnpj)`, `(tenant_id, telefone_e164) WHERE principal`, `(tenant_id, protocolo)`, `(tenant_id, referencia)`. ⚠️ Unicidade **global** sobre tabela particionada (`wamid`, `id_externo_evento`, `numero_externo` da venda) mora em **tabela-guardiã não particionada** (INV-60) |
| 5 | **Sequência por tenant é tabela contador**, não `SEQUENCE` | `SEQUENCE` do Postgres é global. Protocolo (INB-11) e numeração de rascunho usam `UPDATE … RETURNING` em `contador_por_tenant` |
| 6 | RLS `FORCE` com policy em `SELECT/INSERT/UPDATE/DELETE` | `USING (tenant_id = current_setting('app.tenant_id')::uuid)` **e** `WITH CHECK` idêntico — sem `WITH CHECK`, dá para *escrever* em outro tenant |
| 7 | Credencial, token e configuração de integração são **por tenant**, cifrados | Token da Meta de um cliente nunca alcança outro (INV-41) |

⚠️ **A limitação da regra 3 é assumida por escrito, não contornada com otimismo.** Onde carregar a
chave de partição do pai não resolve, a relação é declarada **"sem FK; integridade garantida pelo
único caso de uso de escrita + job diário de verificação de órfãos"** — e isso aparece na tabela da
§8.5, coluna por coluna. `venda_item` ou `custo_mensagem` órfãos deixam de ser "impossíveis" e passam
a ser "detectáveis em 24 h", que é uma promessa que o schema **de fato** cumpre.

### 7.2 As exceções — a lista fechada de tabelas sem `tenant_id`

| Tabela | Por quê |
|---|---|
| `tenant` | Ela é o tenant |
| `schema_migrations` | Infraestrutura |
| `tarifa_meta` | Tabela de preço da Meta por categoria/país — global, somente leitura |
| `perfil_vertical_modelo` | Modelos de vertical distribuídos por nós (o perfil **ativo** do cliente é por tenant) |
| `plano` | Catálogo de planos da Gera3 (PLT-06) — global, somente leitura para o tenant. `tenant.plano_id` referencia esta tabela |
| `outbox` | Infra; carrega `tenant_id` **dentro do payload** para o fan-out de canal |

⚠️ **Qualquer tabela nova fora desta lista sem `tenant_id` é bug de revisão de migration**, não
decisão de design.

### 7.3 O que a tenancy quebra e quase todo mundo esquece

| Armadilha | Tratamento |
|---|---|
| ⚠️ **View materializada não herda RLS** da tabela base | A MV carrega `tenant_id` e tem **policy própria**; ou o acesso passa por função `SECURITY DEFINER` que filtra. Sem isso, o dashboard vaza tudo |
| ⚠️ **Réplica de leitura** precisa da mesma configuração de RLS e do mesmo `SET app.tenant_id` | Conexão analítica não pode ser "a conexão que vê tudo" |
| ⚠️ **Partição por tenant é armadilha** | Milhares de tenants = milhares de partições e planner degradado. Partição é **por período**; tenant fica na policy e no índice |
| ⚠️ Worker e job não têm request | O contexto de tenant é **parâmetro explícito** do job, setado no começo da transação. Job sem tenant setado não roda |
| ⚠️ Staff da Gera3 com acesso cross-tenant | Role separada, com **auditoria obrigatória** de cada acesso (PLT-05) |
| Hierarquia de revenda (PLT-10, Onda 4) | `tenant.tenant_pai_id` nasce agora, nulo. A policy de revenda entra depois, sem migração de dados |

---

## 8. Esboço de tabelas

> Agora as decisões físicas ficam quase óbvias. Convenções: `id uuid` v7 · **dinheiro em coluna
> `*_centavos bigint`** (INV-46) · estado em `text` com união de literais · `criado_em`,
> `atualizado_em` em tudo · PK `(tenant_id, id)` — **exceto em tabela particionada**, onde a PK é
> `(tenant_id, <chave_de_particao>, id)` (INV-60).

⚠️ **A convenção de dinheiro estava se contradizendo por um fator de 100.** O cabeçalho mandava
`numeric(14,2)` e as colunas se chamavam `total_centavos`, `preco_unitario_centavos`,
`valor_centavos`, `custo_centavos` — `total_centavos numeric(14,2)` significa "centavos com duas
casas decimais", que não é nada. E INV-46 declarava como dono "o tipo `Dinheiro` + o tipo da coluna",
ficando ambígua **exatamente no ponto de conversão**, que é onde o bug de dinheiro sempre nasce e onde
ele é silencioso: ninguém percebe R$ 45,00 virando R$ 4.500,00 num relatório agregado. Escolhido
`bigint` — casa com o VO, elimina a conversão e é o que os nomes já diziam. `tabela_preco_item.preco`
vira `preco_centavos`.

### 8.1 `identidade`

```
plano(id, nome, limites jsonb, ativo)                     -- GLOBAL, sem tenant_id (§7.2)
tenant(id, nome, tenant_pai_id, perfil_vertical_id, plano_id, fuso text, config jsonb, criado_em)
perfil_vertical(tenant_id, id, modelo_id, nome, atributos jsonb,
                regras_pedido jsonb, faixas_rfv jsonb)    -- ADR-004: o perfil ATIVO do tenant
filial(tenant_id, id, nome, cidade, uf)
setor(tenant_id, id, nome, ativo)                         -- INB-15
usuario(tenant_id, id, cognito_sub UNIQUE, nome, email, ativo)   -- SEM coluna `papel` (INV-59)
usuario_filial(tenant_id, usuario_id, filial_id, papel)   PK (tenant_id, usuario_id, filial_id)
                                                          -- filial_id NULL = escopo tenant
usuario_canal(tenant_id, usuario_id, canal_id)            PK composta
usuario_identidade_externa(tenant_id, usuario_id, conexao_id, id_externo, visto_em)
                                                   UNIQUE(tenant_id, conexao_id, id_externo)
filial_identidade_externa(tenant_id, filial_id, conexao_id, id_externo, visto_em)
                                                   UNIQUE(tenant_id, conexao_id, id_externo)
token_integracao(tenant_id, id, nome, hash, escopos text[], ultimo_uso_em, revogado_em)
webhook_assinatura(tenant_id, id, url, segredo_cifrado bytea, eventos text[], ativo)   -- INT-07
webhook_entrega(tenant_id, id, assinatura_id, evento, payload jsonb, http_status,
                tentativa int, entregue_em, erro)
notificacao(tenant_id, id, usuario_id, tipo, entidade, entidade_id, lida_em, criado_em)  -- PLT-07
dispositivo_push(tenant_id, id, usuario_id, token, plataforma, atualizado_em)            -- MOB-07
                                                   UNIQUE(tenant_id, token)
contador_por_tenant(tenant_id, escopo, valor)             PK (tenant_id, escopo)
auditoria(tenant_id, id, ator_id, acao, entidade, entidade_id, dados jsonb, criado_em)
                                                   PK (tenant_id, criado_em, id)
                                                   PARTITION BY RANGE (criado_em)

-- Preferências e sessões do usuário (A-03) — telas de perfil sem lugar no modelo
usuario_preferencia(tenant_id, usuario_id, chave, valor jsonb, atualizado_em)
                                                   PK (tenant_id, usuario_id, chave)
      -- chave: 'aparencia' ('claro'|'escuro'|'sistema')
      --      | 'escopo_ativo' ({filialId, canalId})   ⚠️ exigência 23
      --      | 'notificacoes'  ({evento: {app, push, email, som}})
      --      | 'assinatura'    (texto anexado às mensagens da atendente)
usuario_sessao(tenant_id, id, usuario_id, dispositivo, user_agent, ip_ultimo,
               criado_em, visto_em, encerrada_em)
usuario_perfil(tenant_id, usuario_id, foto_chave_objeto, bloqueada_ate, mfa_ativo bool)
                                                   PK (tenant_id, usuario_id)

-- Onboarding do tenant (B-02) — a tela mais importante da Onda 0 não tinha onde morar
onboarding_passo(tenant_id, passo, estado, dados jsonb,
                 concluido_em, concluido_por, atualizado_em)
                                                   PK (tenant_id, passo)
      -- passo:  'empresa' | 'canal_whatsapp' | 'pagamento_meta' | 'erp'
      --       | 'aceite_capacidades' | 'carga_historica'
      -- estado: 'pendente' | 'em_andamento' | 'concluido' | 'falhou' | 'dispensado'
```

⚠️ **O estado do onboarding é do servidor, não do navegador.** `localStorage` é o erro clássico
aqui: o admin começa a configurar no escritório, o Embedded Signup abre uma janela da Meta, ele
fecha o navegador por engano — e sem estado no servidor perde tudo, inclusive a conexão que já
tinha sido criada do lado da Meta.

⚠️ **`aceite_capacidades` guarda a data em que o admin foi informado do que aquele ERP habilita**
(ADR-008). Sem esse registro, quando ele reclamar que "o saldo está errado", não há como mostrar
que a limitação foi apresentada e aceita na configuração.

O banner de "configuração pendente" que a tela exibe lê exatamente esta tabela — e **nomeia o passo
que falta**, em vez de dizer "configuração incompleta".

⚠️ **`escopo_ativo` é a exigência 23, e ela é a única forma de o app e o console concordarem.**
A vendedora escolhe filial e número no console e abre o app: se o escopo estiver no `localStorage`,
os dois discordam e ela atende pelo número errado. Por isso é preferência **do servidor**.

⚠️ **`usuario_sessao` existe porque "desativar usuário encerra as sessões" é promessa da tela.**
Sem a tabela, "encerrar todas as outras" não tem o que encerrar — e a desativação vira um `ativo =
false` que só faz efeito no próximo login. O 2FA em si fica no Cognito; `mfa_ativo` aqui é só o
selo que a lista de usuários exibe.

⚠️ **`tenant.plano_id` e `tenant.perfil_vertical_id` eram FKs penduradas no vazio** — nenhuma das duas
tabelas existia. Isso não é ausência de funcionalidade: é **migration que não fecha**. Mesmo caso de
`atendimento.setor_id`, `contato.grupo_id` e da `lista_salva` que a §1.2 declarava como entidade e o
§8 não tinha (CTT-14, usada como público de campanha em CMP-01).

### 8.2 `contato`

```
grupo_economico(tenant_id, id, nome)                        -- §4.1: agrupa, NÃO agrega RFV
contato(tenant_id, id,
        nome_preferido, tipo_relacao ('cliente'|'representante'|'lead'),
        classificacao ('atacado'|'varejo'), qualificacao, qualificado_em, qualificado_por,
        origem ('ingestao_mensagem'|'campanha'|'instagram'|'indicacao'|'importacao'|'manual'),
        origem_detalhe jsonb,                               -- IA-09, BI-06: lead sem procedência é lead cego
        recebe_campanhas bool, recebe_automacoes bool,      -- INV-13/14
        dono_atual_id,                                      -- desnormalizado da carteira
        filial_id,                                          -- INV-34 (escopo supervisor)
        qtd_vendas int, ultima_venda_em, primeira_venda_em, -- CACHE de mv_metricas_contato (INV-57)
        metricas_confiaveis bool, metricas_apuradas_desde,  -- INV-56
        ultimo_toque_em,                                    -- desnormalizada: kanban + Fila do Dia
        campos jsonb,                                       -- CTT-06 (GIN quando houver busca)
        descartado_em, motivo_descarte_id, grupo_id)
contato_nome(tenant_id, contato_id, valor, fonte, preferido, visto_em)
contato_telefone(tenant_id, contato_id, telefone_e164, telefone_e164_meta, telefone_bruto,
                 chave_busca, principal, fonte, visto_em)
                 CREATE UNIQUE INDEX ON contato_telefone (tenant_id, telefone_e164)
                                     WHERE principal                      -- INV-07/49
contato_documento(tenant_id, contato_id, seq, apelido, tipo, digitos, fiscal_padrao bool)
                                                   PK (tenant_id, contato_id, seq)
                                                   UNIQUE(tenant_id, tipo, digitos)
contato_endereco(tenant_id, contato_id, seq, apelido, tipo, entrega_padrao bool,
                 logradouro, …, cidade, uf, cep, geo)
                                                   PK (tenant_id, contato_id, seq)
contato_identidade_externa(tenant_id, contato_id, conexao_id, sistema, id_externo, visto_em)
                                                   UNIQUE(tenant_id, conexao_id, id_externo)
contato_condicao_comercial(tenant_id, contato_id, conexao_id, tabela_preco_id, prazo_dias,
                           desconto_pct, apurado_em, ao_vivo bool)   -- PED-03/INT-01b
contato_credito(tenant_id, contato_id, conexao_id, limite_centavos bigint,
                disponivel_centavos bigint, bloqueado bool, apurado_em)   -- PED-11
contato_campo_origem(tenant_id, contato_id, campo, fonte, conexao_id, atualizado_em, valor_anterior)
contato_mesclagem(tenant_id, id_perdedor, id_vencedor, autor_id, dados_antes jsonb, criado_em)
conflito_identidade(tenant_id, id, contato_a, contato_b, chave, detalhe jsonb, resolvido_em)
consentimento_contato(tenant_id, id, contato_id, tipo, valor bool, origem,
                      campanha_id, mensagem_id,             -- CMP-10: opt-out COM lastro
                      autor_id, criado_em)
carteira_atribuicao(tenant_id, id, contato_id, usuario_id NULL, de, ate, autor_id, motivo,
                    periodo tstzrange GENERATED ALWAYS AS (tstzrange(de, ate, '[)')) STORED)
                    EXCLUDE USING gist (tenant_id WITH =, contato_id WITH =, periodo WITH &&)
pessoa(tenant_id, id, nome, email, aniversario)     -- SEM telefone próprio (§4.1)
pessoa_contato(tenant_id, pessoa_id, contato_id, papel)
comentario(tenant_id, id, contato_id, autor_id, texto, criado_em)
contato_canal(tenant_id, contato_id, canal_id, primeira_em, ultima_em)   -- projeção CTT-07
lista_salva(tenant_id, id, nome, tipo ('estatica'|'dinamica'), criterio jsonb, criado_por)  -- CTT-14
lista_salva_membro(tenant_id, lista_id, contato_id, adicionado_em)       -- só para a estática
contato_campanha(tenant_id, contato_id, campanha_id, enviado_em, estado)
                                                   PK (tenant_id, contato_id, campanha_id)
                                                   -- projeção enxuta NÃO particionada, ver §8.6
```

⚠️ **`contato.ultimo_toque_em` e `contato.filial_id` existiam apenas dentro de índices da §8.6** —
colunas inventadas na hora de escrever o índice e nunca declaradas. `ultimo_toque_em` ordena o kanban
e alimenta o motor da Fila do Dia (TSK-08): é **desnormalização mantida no mesmo commit da mensagem
saliente**, igual a `conversa.ultima_mensagem_em` (§3.4), e entra na lista de contadores com dono
declarado (INV-57).

⚠️ **`qtd_pedidos` virou `qtd_vendas` porque o nome e o dado discordavam.** A fonte de verdade de
compra é `venda` (§3.7) e **nem toda venda tem pedido** — a maioria é lançada direto no ERP. Um
contador chamado "pedidos" alimentando a coluna "1 pedido" do CRM-02 a partir de vendas é a segunda
verdade nascendo dentro do nome da coluna.

### 8.3 `atendimento`

```
-- canal: raiz genérica + especializações (§1.2)
canal_conectado(tenant_id, id, tipo ('whatsapp'|'instagram'), filial_id, nome_amigavel,
                estado, capacidades jsonb,   -- janela_horas, aceitaTemplate,
                                             -- podeSerPublicoDeCampanha (INV-18/19)
                credenciais_cifradas bytea, conectado_em)
numero_whatsapp(tenant_id, canal_id, telefone_e164, waba_id, phone_number_id,
                tier, qualidade, pagamento_ok bool)   PK (tenant_id, canal_id)
                                                   UNIQUE(tenant_id, telefone_e164)
perfil_instagram(tenant_id, canal_id, ig_user_id, pagina_id)   PK (tenant_id, canal_id)
                                                   UNIQUE(tenant_id, ig_user_id)
canal_saude_evento(tenant_id, id, canal_id, campo, de, para, criado_em)
canal_configuracao(tenant_id, canal_id, horario_atendimento jsonb, mensagem_ausencia text,
                   assinatura text, disparo_pausado bool, pausado_motivo, pausado_em)
                                                   PK (tenant_id, canal_id)
      -- ⚠️ `disparo_pausado` é o que a tela de saúde liga e desliga (A-04). Sem ele, "retomar
      --    disparo" não tem o que retomar, e a pausa automática por queda de qualidade (CAN-06)
      --    não tem onde ser registrada.

-- throttling (INV-23) e limite de tier (INV-22) — duas formas, duas tabelas
numero_throttle(tenant_id, canal_id, proximo_envio_permitido_em)   PK (tenant_id, canal_id)
numero_conversa_iniciada(tenant_id, canal_id, contato_id, iniciada_em)
                                                   PK (tenant_id, canal_id, contato_id, iniciada_em)
numero_quota_hora(tenant_id, canal_id, hora_utc, contatos_distintos int, limite int)
                                                   PK (tenant_id, canal_id, hora_utc)
   -- reserva:  INSERT INTO numero_quota_hora … VALUES (…, 1, …)
   --           ON CONFLICT (tenant_id, canal_id, hora_utc)
   --           DO UPDATE SET contatos_distintos = numero_quota_hora.contatos_distintos + 1
   --           WHERE (SELECT sum(contatos_distintos) FROM últimas 24 horas) < limite
   --           RETURNING contatos_distintos;      -- sem linha devolvida = sem slot

conversa(tenant_id, id, canal_id, contato_id,
         atendimento_atual_id,                     -- evita subconsulta no inbox e na Fila (§7)
         conduzida_por ('humano'|'ia'),            -- INB-06, IA-08
         ultima_mensagem_em, ultima_entrante_em, ultima_direcao,
         versao bigint, arquivada bool)            -- SEM nao_lidas (§3.4.1)
                                                   UNIQUE(tenant_id, canal_id, contato_id)
conversa_leitura(tenant_id, conversa_id, usuario_id, lida_ate_versao)
                                                   PK (tenant_id, conversa_id, usuario_id)

-- presença (INB-18) — o mecanismo que sumiu junto com o Redis (ADR-007)
conversa_presenca(tenant_id, conversa_id, usuario_id, estado, expira_em, atualizado_em)
                                                   PK (tenant_id, conversa_id, usuario_id)
      -- estado: 'visualizando' | 'digitando' | 'gravando'
   CREATE INDEX ON conversa_presenca (tenant_id, expira_em)   -- para a varredura

mensagem(tenant_id, id, conversa_id, atendimento_id, id_externo, direcao, tipo, conteudo jsonb,
         status, status_ordem smallint, enviada_por_id, campanha_id, template_id,
         criado_em)                                PK (tenant_id, criado_em, id)
                                                   PARTITION BY RANGE (criado_em)
mensagem_id_externo(tenant_id, id_externo, mensagem_id, mensagem_criado_em, criado_em)
                                                   PK (tenant_id, id_externo)   -- INV-38, NÃO particionada

midia(tenant_id, id, mensagem_id, mensagem_criado_em, chave_objeto, mime, bytes,
      duracao_s, transcricao)

-- ⚠️ FORMATO DO PROTOCOLO — decisão fechada (A-02)
-- Armazenamento:  bigint sequencial por tenant, de `contador_por_tenant` com UPDATE … RETURNING.
--                 Nunca reinicia. UNIQUE(tenant_id, protocolo) vale para sempre.
-- Apresentação:   zero-padded a 6 dígitos com prefixo — #000318 — SÓ na camada de exibição.
-- Busca:          aceita com ou sem `#`, com ou sem zeros à esquerda. "318", "000318" e
--                 "#000318" encontram o mesmo atendimento.
-- ⚠️ Descartados: `2026-04-000318` (sequência que reinicia por mês quebra a unicidade no ano
--                 seguinte) e `#72372.2` (herança visual do Tailor, nunca foi decisão nossa).
atendimento(tenant_id, id, conversa_id, canal_id, protocolo bigint, atendente_id,
            estado ('na_fila'|'em_atendimento'|'encerrado'),
            criado_em, assumido_em, encerrado_em, setor_id, csat)
                                                   UNIQUE(tenant_id, protocolo)
   CREATE UNIQUE INDEX ON atendimento (tenant_id, conversa_id) WHERE estado <> 'encerrado'  -- INV-51
atendimento_evento(tenant_id, id, atendimento_id, tipo, ator_id, motivo, criado_em)

template(tenant_id, id, nome, categoria, idioma)
template_versao(tenant_id, template_id, versao, corpo jsonb, status_meta, id_externo, revisado_em)
resposta_rapida(tenant_id, id, setor_id, atalho, corpo, variaveis text[], ativo)   -- INB-13
```

⚠️ **Postgres não tem TTL nativo — o vencimento de `conversa_presenca` é lógico.** Toda leitura
filtra por `expira_em > now()`; a varredura periódica apenas limpa linha morta. Confiar só na
varredura faz o aviso "Eduarda está nesta conversa" sobreviver ao fechamento do navegador dela — e
a vendedora seguinte deixa de responder um cliente por causa de um fantasma.

O heartbeat chega por `POST` a cada N segundos, e a ausência dele **não** dispara evento de saída:
o registro simplesmente vence. É o que mantém o mecanismo barato — sem conexão bidirecional, sem
componente novo, e uma tabela pequena que nunca é lida sem filtro de tempo.

⚠️ **`atendimento.canal_id` e `atendimento.criado_em` também só existiam no índice da §8.6.** O índice
da Fila mobile (MOB-03, **Onda 1**) filtra por canal e ordena por chegada; sem essas colunas ele
exigia join com `conversa` e ficava sem índice possível. `canal_id` é **desnormalizado da conversa**,
com FK composta.

### 8.4 `catalogo`, `pedido`, `crm`, `campanha`, `integracao`

```
-- catalogo
produto(tenant_id, id, referencia, nome, categoria, ativo)   -- SEM conexao_id/id_externo embutidos
produto_identidade_externa(tenant_id, produto_id, conexao_id, id_externo, visto_em)
                                                   UNIQUE(tenant_id, conexao_id, id_externo)
produto_variante(tenant_id, id, produto_id, sku, atributos jsonb, ativo)
                                                   UNIQUE(tenant_id, sku)
variante_identidade_externa(tenant_id, variante_id, conexao_id, id_externo, visto_em)
                                                   UNIQUE(tenant_id, conexao_id, id_externo)
tabela_preco(tenant_id, id, nome, vigente_de, vigente_ate)
tabela_preco_identidade_externa(tenant_id, tabela_preco_id, conexao_id, id_externo, visto_em)
                                                   UNIQUE(tenant_id, conexao_id, id_externo)
tabela_preco_item(tenant_id, tabela_preco_id, variante_id, preco_centavos bigint)
saldo_cache(tenant_id, conexao_id, variante_id, quantidade, apurado_em)
                                                   PK (tenant_id, conexao_id, variante_id)
link_catalogo(tenant_id, id, contato_id, token, criado_por, expira_em)
link_catalogo_visita(tenant_id, id, link_id, variante_id, criado_em)   -- CAT-03

-- pedido
pedido(tenant_id, id, contato_id, vendedor_id, conversa_id, campanha_id, tarefa_id,
       estado ('rascunho'|'validando'|'enviando'|'efetivado'|'falhou'|'aguardando_conferencia'),
       versao_conteudo int,                        -- incrementa a cada mutação de item/condição
       chave_efetivacao text,                      -- hash(tenant_id, id, versao_conteudo) — INV-29
       documento_seq, endereco_entrega_seq,        -- QUAL documento/endereço (§5.3)
       condicao_snapshot jsonb, regras_aplicadas jsonb, cliente_fiscal_snapshot jsonb,
       total_centavos bigint, total_pecas, numero_externo, efetivado_em)
   CREATE UNIQUE INDEX ON pedido (tenant_id, conversa_id) WHERE estado = 'rascunho'   -- INV-52
pedido_item(tenant_id, id, pedido_id, variante_id, sku_snapshot, descricao_snapshot,
            quantidade, preco_unitario_centavos bigint, tabela_preco_id, tabela_preco_nome,
            desconto_pct, origem_do_preco, capturado_em)
pedido_tentativa(tenant_id, id, pedido_id, versao_conteudo, chave_efetivacao, enviado_em,
                 resultado ('sucesso'|'falha'|'timeout'), erro_tipo, erro_detalhe jsonb,
                 reconciliado_em)                  -- INV-53
   CREATE UNIQUE INDEX ON pedido_tentativa (tenant_id, pedido_id) WHERE resultado = 'sucesso'

-- venda (fato do ERP)
venda(tenant_id, id, contato_id, pedido_id, conexao_id, numero_externo,
      data, total_centavos bigint, qtd_itens,
      vendedor_externo,                            -- dado bruto do ERP, preservado
      vendedor_usuario_id,                         -- resolvido na ingestão; NULL = não mapeado
      filial_id)                                   PK (tenant_id, data, id)
                                                   PARTITION BY RANGE (data)
venda_chave_externa(tenant_id, conexao_id, numero_externo, venda_id, venda_data)
                                                   PK (tenant_id, conexao_id, numero_externo)
                                                   -- guardiã da reconciliação (§6.6), NÃO particionada
venda_item(tenant_id, id, venda_id, venda_data, variante_id, sku, categoria,
           quantidade, total_centavos bigint)

-- crm
funil(tenant_id, id, nome, tipo ('leads'|'custom'), ativo)
funil_etapa(tenant_id, id, funil_id, nome, ordem, tipo_saida)
negocio_funil(tenant_id, id, funil_id, contato_id, etapa_id,
              etapa_tipo,                          -- desnormalizado de funil_etapa.tipo_saida
              entrou_na_etapa_em, motivo_perda_id, valor_previsto_centavos bigint)
                                                   UNIQUE(tenant_id, funil_id, contato_id)
                     CHECK (etapa_tipo <> 'descarte' OR motivo_perda_id IS NOT NULL)   -- INV-36
negocio_funil_evento(tenant_id, id, negocio_id, etapa_de, etapa_para, ator_id, origem, criado_em)
motivo_perda(tenant_id, id, nome, ativo)
tarefa(tenant_id, id, contato_id, responsavel_id, tipo, canal, titulo, descricao,
       vence_em, estado, concluida_em, registro_do_que_foi_feito,
       origem_tipo ('campanha'|'cadencia'|'rfv'|'manual'|'automacao'), origem_id)
meta(tenant_id, id, escopo ('usuario'|'equipe'|'filial'|'tenant'), alvo_id,
     periodo_de, periodo_ate, tipo ('receita'|'pecas'|'pedidos'|'clientes_novos'),
     valor_centavos bigint, criado_por)            -- GES-01. Realizado é DERIVADO de venda
                                       UNIQUE(tenant_id, escopo, alvo_id, tipo, periodo_de)

-- campanha
campanha(tenant_id, id, nome, template_id, criterio_publico jsonb, lista_salva_id, agendada_para,
         estado, total_publico, enviadas, entregues, lidas, respostas, falhas, opt_outs,
         custo_centavos bigint,                    -- PROJEÇÃO de custo_mensagem (INV-57)
         janela_resposta_h int)                    -- janela usada para atribuir resposta (CMP-10)
campanha_canal(tenant_id, campanha_id, canal_id, peso)
campanha_destinatario(tenant_id, id, campanha_id, contato_id, canal_id, telefone_e164,
                      campanha_mes date,           -- chave de partição, derivada da campanha
                      criado_em, estado, mensagem_id, mensagem_criado_em, erro_tipo, enviado_em)
                      PK (tenant_id, campanha_mes, id)
                      UNIQUE(tenant_id, campanha_mes, campanha_id, contato_id)
                      PARTITION BY RANGE (campanha_mes)
lista_bloqueio(tenant_id, chave_bloqueio, telefone_e164_original, motivo, criado_em)
                                                   PK (tenant_id, chave_bloqueio)   -- INV-15/50

-- integracao
conexao_erp(tenant_id, id, sistema, nome, credenciais_cifradas bytea,
            papel ('fiscal'|'secundario'), precedencia int, fonte_de_venda bool,
            capacidades jsonb, estado, ultima_sincronizacao_em)
            UNIQUE (tenant_id) WHERE papel = 'fiscal'          -- INV-10 decidível (§6.3)
            UNIQUE (tenant_id) WHERE fonte_de_venda            -- INV-55
conexao_erp_cobertura(tenant_id, conexao_id, fluxo ('customers'|'products'|'orders'),
                      cobertura_desde, cobertura_ate,
                      carga_historica_estado ('ausente'|'em_andamento'|'parcial'|'completa'),
                      atualizado_em)               PK (tenant_id, conexao_id, fluxo)   -- INV-56
evento_externo(tenant_id, id, canal, id_externo_evento, corpo jsonb, recebido_em,
               processado_em, corpo_expurgado_em)  -- NÃO particionada (INV-37)
                                                   UNIQUE(tenant_id, canal, id_externo_evento)
operacao_ingestao(tenant_id, id, conexao_id, fluxo, cursor_retomada, lidos, gravados,
                  erros jsonb, iniciada_em, concluida_em, reconciliacao_concluida_em)
chave_idempotencia(tenant_id, escopo, chave, resultado jsonb, criado_em)  PK (tenant_id,escopo,chave)
outbox(id bigserial, payload jsonb, criado_em, processado_em)

-- analitico
rfv_evento(tenant_id, id, contato_id, faixa_de, faixa_para, r, f, v, avaliado_em, motivo)
                                                   UNIQUE(tenant_id, contato_id, avaliado_em)  -- INV-45
atribuicao_receita(tenant_id, id, venda_id, venda_data, metodo ('exata'|'estimada'),
                   campanha_id, tarefa_id, conversa_id, usuario_id,
                   janela_dias int, valor_centavos bigint, criado_em)
                                                   UNIQUE(tenant_id, venda_id) WHERE metodo='exata'
custo_mensagem(tenant_id, id, mensagem_id, mensagem_criado_em, canal_id, campanha_id,
               categoria, pais, centavos bigint, tarifa_id, estimado bool, cobrado_em)
               PK (tenant_id, mensagem_criado_em, id)   PARTITION BY RANGE (mensagem_criado_em)
               UNIQUE(tenant_id, mensagem_criado_em, mensagem_id, categoria)   -- INV-54
metrica_numero_dia(tenant_id, canal_id, dia, enviadas, entregues, lidas, falhas,
                   custo_centavos bigint)          -- dia no fuso do tenant; é MÉTRICA, não controle
```

⚠️ **`campanha_destinatario` particiona por `campanha_mes`, não por `criado_em`** — e a coluna
`criado_em` que a §8.5 usava como chave de partição **nem existia na definição**. A escolha não é
cosmética: `campanha_mes` é **função determinística da campanha**, então
`UNIQUE(tenant_id, campanha_mes, campanha_id, contato_id)` continua sendo a garantia real de "um
destinatário por contato por campanha" mesmo com a chave de partição dentro dela. Com `criado_em`, um
disparo que atravessa a virada do mês duplicaria o destinatário sem erro. O mesmo truque vale para
`custo_mensagem`, particionada por `mensagem_criado_em`: a coluna é determinada pela mensagem, então a
única de INV-54 sobrevive à inclusão da chave de partição — **e** habilita a FK composta para
`mensagem`.

⚠️ **`venda.vendedor_externo` sozinho não vira ranking.** Ele é string do ERP, e não existia mapa
entre código de vendedor do ERP e `usuario` — nem entre filial do ERP e `filial`. Sem
`usuario_identidade_externa`, **GES-02** (ranking de vendedores, Onda 2), **GES-03** (receita por
pessoa), **GES-01** (metas por vendedor) e o bloco RANKING da Home não conseguiam agregar receita por
usuário do CRM, e o filtro "todas as filiais" não tinha em que se apoiar. **Quando o casamento
falha:** a venda entra no total, fica **fora** do ranking, e aparece numa fila de "vendedores não
mapeados" — mesma lógica de §6.4, degradação visível em vez de número errado.

### 8.5 Particionamento — e o que ele custa em unicidade e FK

⚠️ **Esta é a seção que mais mudou, porque metade das invariantes de idempotência declarava como dono
uma constraint que o Postgres se recusa a criar.** Em tabela particionada, **todo índice único — a PK
inclusive — precisa conter todas as colunas da chave de partição**. Logo, escritas como estavam,
estas simplesmente não existiam no banco:

| Constraint declarada | Tabela | Consequência real |
|---|---|---|
| `UNIQUE(tenant_id, id_externo)` | `mensagem` (part. `criado_em`) | INV-38 sem dono: `wamid` duplicado entra |
| `UNIQUE(tenant_id, canal, id_externo_evento)` | `evento_externo` (part. `recebido_em`) | **INV-37 sem dono** — a base de toda a idempotência de webhook; e o `INSERT … ON CONFLICT DO NOTHING` **não tinha em que conflitar** |
| `UNIQUE(tenant_id, conexao_id, numero_externo)` | `venda` (part. `data`) | §6.6 sem chave: pedido↔venda deixa de reconciliar e o RFV conta duas vezes |
| `UNIQUE(tenant_id, campanha_id, contato_id)` | `campanha_destinatario` | Destinatário duplicado no disparo |
| PK `(tenant_id, id)` | as cinco | Convenção universal da §8 **impossível** nelas |

E incluir a coluna de partição na única — o único jeito de o DDL passar — **destrói a garantia**: o
mesmo `wamid` reprocessado num mês diferente, ou a mesma venda reingerida com a `data` corrigida,
entram duas vezes sem erro.

**Decisão, tabela por tabela:**

| Tabela | Chave / granularidade | PK | Unicidade global | FK dos filhos |
|---|---|---|---|---|
| **`mensagem`** | `criado_em` · **mensal** | `(tenant_id, criado_em, id)` | **Guardiã** `mensagem_id_externo`, não particionada, `UNIQUE(tenant_id, id_externo)`, escrita no mesmo commit | Filhos carregam `mensagem_criado_em` → FK composta |
| `campanha_destinatario` | **`campanha_mes`** · mensal | `(tenant_id, campanha_mes, id)` | `UNIQUE(tenant_id, campanha_mes, campanha_id, contato_id)` — **vale como global** porque `campanha_mes` é função da campanha | — |
| `venda` | `data` · anual | `(tenant_id, data, id)` | **Guardiã** `venda_chave_externa`, não particionada | `venda_item`, `atribuicao_receita` carregam `venda_data` |
| `custo_mensagem` | **`mensagem_criado_em`** · mensal | `(tenant_id, mensagem_criado_em, id)` | `UNIQUE(… , mensagem_id, categoria)` — **vale como global** pelo mesmo motivo (INV-54) | — |
| `evento_externo` | **não particionada** | `(tenant_id, id)` | `UNIQUE(tenant_id, canal, id_externo_evento)` **de verdade** | — |
| `auditoria` | `criado_em` · mensal | `(tenant_id, criado_em, id)` | não precisa | — |

⚠️ **Por que `evento_externo` deixou de ser particionada.** A justificativa da partição era "expurgo
rápido após processamento" — e expurgo se resolve com `DELETE` por índice em `recebido_em`. Já a
única **não** se resolve de outro jeito sem uma segunda guardiã, e ela é a **base declarada de toda a
idempotência de webhook**. Trocamos uma otimização de expurgo por uma invariante que existe.
**Retenção:** o `corpo` é anulado cedo (`corpo_expurgado_em`), mas a **linha-chave permanece além da
janela máxima de reentrega da Meta** — do contrário uma reentrega tardia passa pela dedup, roda o
handler de novo e insere custo em dobro (INV-54).

**Onde não deu para ter FK** (assumido por escrito, §7.1):

| Relação | Tratamento |
|---|---|
| `campanha_destinatario.mensagem_id` → `mensagem` | FK composta com `mensagem_criado_em`, `MATCH SIMPLE` — nula quando o destinatário falhou antes do envio |
| Qualquer filho de partição futura sem coluna de partição disponível | **Sem FK**, com job diário de órfãos e alerta. ⚠️ Escrito como tal — não fingido como impossível |

⚠️ **Não particionar por tenant** (§7.3).

### 8.6 Índices — derivados de consulta real de tela

| Tela / consulta | Índice |
|---|---|
| Inbox: lista por canal, ordenada pela última mensagem (§1.2) | `conversa (tenant_id, canal_id, ultima_mensagem_em DESC, id DESC) WHERE NOT arquivada` |
| Inbox: **"só sem resposta"** — o filtro mais usado do dia | `conversa (tenant_id, canal_id, ultima_entrante_em DESC, id DESC) WHERE ultima_direcao='entrante'` |
| Inbox: não lidas do usuário (§3.4.1) | `conversa_leitura (tenant_id, usuario_id, conversa_id)` — a comparação é com `conversa.versao` |
| Inbox: busca por protocolo | `atendimento UNIQUE(tenant_id, protocolo)` |
| Inbox: busca por nome | `contato USING gin (nome_preferido gin_trgm_ops)` com `tenant_id` no filtro |
| Inbox: busca por telefone | `contato_telefone (tenant_id, telefone_e164)` + índice em `chave_busca` |
| Conversa: histórico para trás em blocos de 30 dias (§1.3) | `mensagem (tenant_id, conversa_id, criado_em DESC, id DESC)` por partição |
| Métrica de atendimento (GES-03) | `mensagem (tenant_id, atendimento_id, criado_em)` por partição |
| Fila mobile: "Fila" vs "Meus" (§7) | `atendimento (tenant_id, canal_id, estado, criado_em DESC)`, parcial por estado — **exige as colunas `canal_id` e `criado_em` acrescentadas em §8.3** |
| Atendimento aberto por conversa (INV-51) | `atendimento UNIQUE(tenant_id, conversa_id) WHERE estado <> 'encerrado'` |
| Kanban de **leads** (CRM-01): coluna com 11 mil cards, paginada (§4.2) | `negocio_funil (tenant_id, funil_id, etapa_id, entrou_na_etapa_em DESC, id DESC)` |
| Kanban de **relacionamento** (CRM-02): coluna por nº de vendas | `contato (tenant_id, qtd_vendas, ultimo_toque_em DESC, id DESC) WHERE descartado_em IS NULL` — chave de ordenação do cursor: **`ultimo_toque_em DESC, id DESC`** (INV-47) |
| Kanban: "tempo desde o último toque" por dono | `contato (tenant_id, dono_atual_id, ultimo_toque_em DESC, id DESC)` |
| Fila do Dia: agendadas/vencidas por vendedor (§5) | `tarefa (tenant_id, responsavel_id, vence_em) WHERE estado='agendada'` |
| Ficha: últimos pedidos do cliente (§3) | `venda (tenant_id, contato_id, data DESC)` |
| Ficha: campanhas que este contato recebeu (CTT-12) | `contato_campanha (tenant_id, contato_id, enviado_em DESC)` — projeção não particionada |
| Ficha: "está no telefone" | `contato_canal (tenant_id, contato_id)` |
| Pedido: busca por referência/SKU (§2.2) | `produto (tenant_id, referencia)`, `produto_variante UNIQUE(tenant_id, sku)`, trigram no nome |
| Disparo: próximos destinatários pendentes | `campanha_destinatario (tenant_id, campanha_mes, campanha_id, id) WHERE estado='pendente'` |
| Throttling / limite de tier | `numero_throttle` PK `(tenant_id, canal_id)`; `numero_quota_hora` PK `(tenant_id, canal_id, hora_utc)` |
| Outbox: pendentes | `outbox (id) WHERE processado_em IS NULL` |
| Ingestão: casar por id externo | `contato_identidade_externa UNIQUE(tenant_id, conexao_id, id_externo)` (idem produto, variante, usuário, filial) |
| Webhook: idempotência | `evento_externo UNIQUE(tenant_id, canal, id_externo_evento)` |
| Dedup de mensagem por `wamid` | `mensagem_id_externo` PK `(tenant_id, id_externo)` |
| Reconciliação pedido↔venda | `venda_chave_externa` PK `(tenant_id, conexao_id, numero_externo)` |
| Carteira vigente | `carteira_atribuicao UNIQUE(tenant_id, contato_id) WHERE ate IS NULL` (INV-32) |
| Expurgo de evento bruto | `evento_externo (recebido_em) WHERE corpo_expurgado_em IS NULL` |

⚠️ **Índice não usado custa escrita em toda inserção.** Nenhum índice acima existe "porque vai
precisar" — cada um sai de uma consulta desenhada na especificação de telas.

⚠️ **Esta tabela foi conferida contra §8.2–§8.4, e antes não era.** Cinco índices apontavam para
colunas inexistentes (`atendimento.canal_id`, `atendimento.criado_em`, `contato.ultimo_toque_em`,
`campanha_destinatario.criado_em`) ou para tabelas que não existiam em lugar nenhum do documento
(`grupo`, `setor`) — cada um deles viraria uma decisão improvisada dentro de uma migration. E o
kanban do **CRM-02** não tinha índice nenhum: só o funil de leads (CRM-01) estava coberto, embora as
colunas do Funil de Relacionamento sejam consultas em `contato` com 11 mil cards, cursor estável e
join com duas MVs. ⚠️ Se o join triplo por página doer, a saída declarada é **materializar a coluna
do CRM-02 dentro de `mv_metricas_contato`** — decisão de otimização, não de modelo.

⚠️ **`campanha_destinatario` não tem índice por contato de propósito.** A pergunta "quais campanhas
este contato recebeu" (CTT-12, e qualquer regra de fadiga) varreria **todas as partições de todos os
meses** da segunda maior tabela do sistema. Ela é servida pela projeção enxuta `contato_campanha`,
não particionada.

### 8.7 Réplica de leitura e views materializadas

| Carga | Onde | Nota |
|---|---|---|
| Inbox, pedido, cadastro, kanban | **Primária** | ⚠️ O inbox é a tela que não pode piscar |
| Ficha analítica (categorias com drill-down, gráfico de vendas, evolução RFV) | **Réplica** | Consulta pesada por contato |
| Visão de Mercado (Venn, RFV-07), qualidade cadastral (RFV-08), distribuição RFV (RFV-09), mapa (RFV-12) | **Réplica** | Varre a base inteira |
| Exportações e relatórios agendados (BI-08/09) | **Réplica** | |

**Views materializadas** (atualizadas por worker, com `tenant_id` e policy própria — §7.3):

| MV | Alimenta | Atualização |
|---|---|---|
| `mv_metricas_contato` — total, 1ª/última venda, dias sem vendas, qtd, ticket, **média entre vendas**, **`confiavel`, `apurado_desde`** | Ficha (§3), card do kanban, Fila do Dia. **Fonte de verdade dos contadores de `contato`** (INV-57) | Diária + incremental por evento de venda + **reconciliação ao fim de toda `operacao_ingestao`** |
| `mv_rfv_segmento_atual` — R, F, V, faixa e **`confiavel`** por contato | RFV-01, badge em toda superfície | Diária. ⚠️ Contato fora da cobertura **não é classificado** (INV-56) |
| `mv_categorias_contato` — categorias compradas até SKU-cor-tamanho | RFV-05 (donut com drill-down) | Diária |
| `mv_home_indicadores` — vendas, ticket, clientes novos × recorrentes, por período e filial | Home (§6) | Horária |
| `mv_atribuicao_periodo` — receita por campanha/tarefa/IA, **separada por método** | BI-02, CMP-11/12 | Horária. ⚠️ Nunca com coluna de soma dos dois métodos (INV-42) |
| `mv_ranking_vendedor` — por `venda.vendedor_usuario_id` | GES-02, GES-03, Home | Horária. ⚠️ Venda **não mapeada** entra no total e fica fora do ranking, com fila própria |
| `mv_meta_realizado` — alvo (de `meta`) × realizado (de `venda`) por escopo e período | GES-01, GES-04, sub-aba Metas do app, push "meta em risco" (MOB-07) | Horária. ⚠️ Realizado **nunca gravado** (§5.4) |

⚠️ **`contato.qtd_vendas` × `mv_metricas_contato` eram duas verdades para o mesmo número** — uma
incremental por evento, outra diária — **sem regra de qual vence**. Agora a MV é a fonte e a coluna é
cache (INV-57): a divergência tem prazo (até a próxima reconciliação) e tem dono.

⚠️ **Não calcular RFV da base inteira sob demanda** a cada abertura de tela. O contato individual
pode ser calculado ao vivo; a base é MV com atualização agendada.

---

## 9. Decisões em aberto

> O que depende de informação que não temos. Nenhuma bloqueia a Onda 0 — mas cada uma que ficar
> aberta demais vira migração.

| # | Decisão | Depende de | Impacto se resolver tarde |
|---|---|---|---|
| 1 | **Volume real do primeiro cliente** (nº de números, mensagens/dia, contatos, anos de histórico) | Cliente inicial — já é a pendência nº 5 da stack | Define granularidade de partição (mensal × semanal) e quando os gatilhos da §12 da stack disparam. **Barato agora, caro depois** |
| 2 | **Fórmula das 11 faixas de RFV** — quintis sobre a base, cortes absolutos, ou por perfil de vertical | Regra de negócio do nicho (o Tailor não publica a dele) | O modelo já suporta as duas (guarda `r`, `f`, `v` além da faixa). Só a **fórmula** está em aberto |
| 3 | **Ciclo de vida:** dias default de Ativo/Inativo/Perdido por vertical | Dono do negócio (RFV-03 diz que é configurável) | Só configuração; sem impacto estrutural |
| 4 | **Janela default de atribuição estimada** (3/7/14d) e a **regra de desempate** quando o cliente recebeu duas campanhas | Decisão comercial | INV-44 exige que a regra seja única e declarada. Mudar depois **reescreve o histórico de atribuição** |
| 5 | **Precedência de fontes por campo** (§6.3) — a proposta é *manual > ERP fiscal > ERP secundário > canal > IA > CSV* | Validação com o cliente que tem 2 ERPs | Errar produz "o nome mudou sozinho" — o sintoma que mata a confiança na integração |
| 6 | ~~**Grupo econômico:** um Contato com N CNPJs, ou N Contatos com `grupo_id`?~~ **FECHADA (§4.1):** N Contatos, um por CNPJ, com `grupo_id` | — | ⚠️ Não era "o modelo suporta os dois": **muda a chave de agregação do RFV**. Ficou fechada antes da primeira migration |
| 7 | **Carteira exclusiva ou dono + apoio?** (o **órfão** já está resolvido: linha com `usuario_id IS NULL`, INV-58) | Dono do negócio (a skill `funil-de-vendas` exige resposta) | Apoio exige nova cardinalidade em `carteira_atribuicao`. O predicado de visibilidade já está escrito em INV-34 |
| 8 | **Tarifa da Meta:** de onde vem a tabela `tarifa_meta` e com que frequência é atualizada | Meta / operação | Sem ela o custo é estimativa não auditável — e CMP-12/BI-11 perdem credibilidade |
| 9 | **`Atendimento` na Onda 1: completo ou só protocolo + dono?** | Escopo da Onda 1 (INB-11 é Onda 1; INB-15/16 são Onda 2) | Proposta: a **tabela nasce completa**, o preenchimento é incremental. Criar depois obriga a reprocessar histórico |
| 10 | **PK composta `(tenant_id, id)`** — ergonomia com Drizzle e com o console | Prova de conceito na Onda 0 | Alternativa é `id` PK + `UNIQUE(tenant_id, id)` para as FKs compostas. ⚠️ Decidir **antes** da primeira migration. Nas particionadas a PK **já é** `(tenant_id, chave_de_particao, id)` — INV-60 não é negociável |
| 15 | **Janela máxima de reentrega de webhook da Meta** (define a retenção da linha-chave de `evento_externo`) | Documentação/observação da Meta | Retenção curta demais reabre o furo de custo em dobro (INV-54); longa demais é só storage barato. ⚠️ Na dúvida, **errar para o lado longo** |
| 16 | **Regra do nono dígito por faixa de DDD** — quais faixas são celular em cada DDD | Tabela da Anatel + observação da base | INV-06 depende dela para a forma canônica. Errar produz duplicidade de cadastro (recuperável) ou falha de bloqueio (não recuperável) |
| 11 | **Retenção**: mensagens, mídia, auditoria e eventos brutos | LGPD + custo de storage | Sem política, o custo nº 2 da stack cresce sem teto |
| 12 | **Multi-moeda** | Mercado-alvo | Assumido **BRL apenas**; o VO `Dinheiro` já carrega `moeda`, então é aditivo |
| 13 | **Ordem dos próximos conectores de ERP** | Decisão comercial (pendência nº 4 da stack) | Não muda o modelo canônico — muda quais capacidades precisam de degradação testada primeiro |
| 14 | **Hierarquia de revenda** (PLT-10) — profundidade e escopo do acesso cross-tenant | Onda 4 | `tenant.tenant_pai_id` já nasce; a policy entra depois |

---

## 10. Checklist de fechamento

- ☑ Toda invariante está escrita e tem um dono — **60 invariantes**, nenhuma cujo dono seja "o front-end"
- ☑ **Todo dono declarado é uma constraint que o Postgres aceita criar** (INV-60) — particionamento conferido contra cada `UNIQUE`, cada PK e cada FK (§8.5)
- ☑ Todo agregado cabe numa transação; as **4 travessias** estão declaradas com consistência eventual (§3.8)
- ☑ Nenhuma cardinalidade foi assumida sem ser questionada (§4) — telefones, CNPJs, endereços, nomes, canais da frota, pessoas, **leitura de conversa**
- ☑ O que precisa de histórico está identificado com o padrão escolhido (§5)
- ☑ Preço, condição, regras comerciais e texto de template em documentos são **snapshot** — e o Pedido registra **qual** documento e **qual** endereço originaram o snapshot (§5.3)
- ☑ Chave de reconciliação definida, com precedência, tratamento de conflito e **algoritmo de mesclagem agregado por agregado** (§6.2, §6.4)
- ☑ Telefone normalizado **na escrita**, com a armadilha do nono dígito tratada nos **dois** lados: cadastro nunca funde por chave reduzida, bloqueio sempre compara por ela (§6.5)
- ☑ Todo contador denormalizado é **cache com fonte e job de reconciliação** (INV-57); nenhum é fonte de verdade
- ☑ O modelo sabe distinguir **"nunca comprou"** de **"não sabemos"** (INV-56)
- ☑ `tenant_id` em tudo, com as **6 exceções listadas** (§7.2)
- ☑ Nenhuma tabela existe "porque vai precisar depois" — e nenhuma FK aponta para tabela que não existe
- ☑ Toda funcionalidade de **Onda 1–2** tem onde morar (meta, setor, plano, lista salva, resposta rápida, notificação, push, webhook de saída)

**Próximas etapas:** as invariantes viram cenários executáveis (`bdd`); os agregados viram casos de
uso e portas (`arquitetura-limpa`, `geracrm-arquitetura`); as tabelas viram a primeira migration
(`geracrm-dados-postgres`).

---

## 11. Achados descartados

**Nenhum achado da revisão adversarial foi descartado** — os 35 procediam e todos estão aplicados
acima. O que segue registra as três correções onde a **opção adotada difere da proposta**, e por quê.

| Achado | Proposta | O que foi feito | Por quê |
|---|---|---|---|
| Particionamento × unicidade (`evento_externo`) | Opções (a) incluir chave de partição, (b) tabela-guardiã, ou (c) não particionar | **(c) para `evento_externo`, (b) para `mensagem` e `venda`, (a) para `campanha_destinatario` e `custo_mensagem`** | (a) só é aceitável quando a chave de partição é **função determinística** da chave de negócio (`campanha_mes` vem da campanha, `mensagem_criado_em` vem da mensagem) — aí a unicidade continua global de fato. Onde não é, (a) é unicidade falsa |
| Idempotência do pedido | Um achado pedia `UNIQUE(tenant_id, pedido_id, versao_conteudo)` em `pedido_tentativa` | **Índice único parcial `WHERE resultado='sucesso'` + chave derivada de `versao_conteudo`** | `UNIQUE(pedido_id, versao_conteudo)` permitiria **uma única tentativa por versão**, contradizendo INV-30 ("linha nova por tentativa"). O parcial protege o que importa — no máximo um sucesso — sem quebrar o histórico de tentativas |
| Quota do número | Contagem por `count(distinct contato_id)` na janela, **ou** baldes horários | **Os dois papéis, com tabelas separadas:** `numero_conversa_iniciada` faz a **reserva** (`INSERT … ON CONFLICT`), `numero_quota_hora` faz a **contagem** | `count(distinct)` sobre a janela a cada reserva é varredura numa das linhas mais contendidas do sistema; o balde dá a soma em 24 leituras de PK. A reserva precisa da tabela por contato de qualquer jeito, porque é ela que sabe se aquele contato **já** consumiu slot na janela |

⚠️ **Uma consequência de escopo que este documento não pode esconder:** INV-34 (predicado de
autorização), INV-51 (um atendimento aberto) e o par condição-comercial/crédito (§6.8) eram tratados
como refinamento posterior e **são pré-requisito da primeira tela**. Eles entram na Onda 1, não na 3.
