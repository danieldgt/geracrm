# Prontidão para início — o que falta antes da primeira linha de código

> Estado em 07/08/2026. O repositório tem `docs/` e `.claude/skills/` — **nenhum código, nenhuma
> infraestrutura provisionada.**

---

## 1. O que está pronto

| Artefato | Documento | Estado |
|---|---|---|
| Estudo de mercado | `estudo-crms-whatsapp.md` | ✅ |
| Análise do sistema de referência | `inventario-funcionalidades-referencia.md` | ✅ 38 telas catalogadas |
| Mapa competitivo | `concorrentes-tailor.md` | ✅ 6 anéis |
| Escopo funcional | `escopo-funcional-geracrm.md` | ✅ ~150 funcionalidades, 15 módulos, 5 ondas |
| Épicos e backlog | `backlog-epicos-geracrm.md` | ✅ 27 épicos |
| Especificação de telas | `especificacao-telas.md` | ⚠️ **6 telas de operação — estrutura e estados, sem design visual** |
| Stack e arquitetura | `stack-arquitetura.md` | ✅ |
| Aproveitamento do drezz | `aproveitamento-drezz.md` | ✅ |
| Decisões (ADRs) | `decisoes.md` | ✅ 11 ADRs |
| Regras de código | `.claude/skills/` | ✅ 34 skills |

**A trilha de `workflow-produto` está cumprida nas etapas 1, 2, 4 (parcial), 5 e 7.**

---

## 2. As cinco lacunas de planejamento

### 2.1 ⚠️ Modelo de dados — a etapa 3 nunca foi executada

**É a lacuna mais crítica.** Existe a skill `modelar-dados`, mas o domínio do GeraCRM nunca foi
modelado. Não há entidades, invariantes escritas, agregados nem limites de transação definidos.

Sem isso não dá para escrever a primeira migration — e migration errada custa dois ou três deploys
para corrigir (ADR-006).

**O que precisa existir:**
- Entidades e objetos de valor (`Conversa`, `Contato`, `Numero`, `Pedido`, `Campanha`, `Tarefa`…)
- **Invariantes numeradas** (`INV-01`…) com o dono de cada uma
- Agregados e limites de transação
- Cardinalidades reais questionadas (múltiplos telefones, múltiplos CNPJs, múltiplos nomes)
- Estratégia de temporalidade (o que precisa de histórico: carteira, segmento RFV, preço no pedido)
- Chave de reconciliação de identidade externa, com N ERPs escrevendo
- Particionamento de mensagens desde o início

**Esforço:** é a entrega mais densa que falta. E é pré-requisito de tudo.

### 2.2 ⚠️ Telas de entrada não foram especificadas

A `especificacao-telas.md` cobre **seis telas de operação** — inbox, pedido, ficha, kanban, fila do
dia, home, fila mobile. **Nenhuma tela de entrada foi especificada:**

- Login, cadastro, recuperação de senha, definição de senha
- Convite de usuário e aceite
- **Onboarding do tenant** — conectar o primeiro número (Embedded Signup), escolher e autenticar o
  ERP, e a tela que **mostra o que aquele ERP habilita** (ADR-008)
- Seleção de filial e de número
- Perfil, equipe, papéis e permissões
- Assinatura, plano e limites

⚠️ **O onboarding é a tela mais importante do produto que ninguém lembra de especificar.** É onde o
cliente conecta Meta e ERP — se falhar ali, não existe operação.

### 2.3 ⚠️ Design visual não existe

O que temos é **estrutura**: regiões, estados, transições. O que não temos é **design**:

- Direção de arte — personalidade, referências, o que o produto comunica
- **Design tokens** — cor, tipografia, espaçamento, raio, elevação (fonte da verdade compartilhada
  entre Angular e Expo, ADR-010)
- Biblioteca de componentes — botão, campo, tabela, card, badge, modal, toast, estados vazios
- Telas em alta fidelidade
- Modo escuro (decidido desde o começo, não depois)
- Acessibilidade — contraste, foco, navegação por teclado

⚠️ **Pergunta em aberto:** o GeraCRM herda a identidade da Gera3, tem identidade própria, ou segue
o caminho do drezz (que tem `docs/design.md` com paleta definida)? Isso precisa ser respondido
antes de qualquer token.

### 2.4 Contrato de API não definido

Nenhum endpoint especificado. Precisa de: convenção de rota e versionamento, formato de paginação
por cursor, formato de erro tipificado, contrato do canal SSE, e a API pública de ingestão
(INT-02) — que é o **conector universal** e não pode ser menos capaz que um adaptador nativo.

### 2.5 Cenários BDD não escritos

A skill `bdd` existe; os cenários, não. Toda invariante do modelo precisa de pelo menos um cenário
que tenta violá-la — e eles são o critério de aceite executável de cada épico.

---

## 3. O que não é planejamento — é execução, e alguns levam semanas

### 3.1 🔴 Registro na Meta — CAMINHO CRÍTICO, começar hoje

| Etapa | Depende de |
|---|---|
| Conta de desenvolvedor e app | Nós |
| **Business Verification** | **Meta** — documentação da empresa, prazo variável |
| **Enrollment no Tech Provider Program** | **Meta** |
| **App Review** (WhatsApp + `instagram_business_manage_messages`) | **Meta** |

⚠️ **Isto não depende de código e leva semanas.** É o único item do projeto cujo prazo não
controlamos. Deve começar **em paralelo** ao modelo de dados, não depois.

### 3.2 Infraestrutura a provisionar

| Item | Estado |
|---|---|
| **Cognito user pool** | ❌ Não existe. Nada provisionado |
| Projeto Railway + Postgres + réplica | ❌ |
| Bucket S3 | ❌ |
| Sentry | ❌ |
| Ambientes (dev, homologação, produção) | ❌ |
| Credenciais separadas por ambiente | ❌ |

**Sobre a pergunta "já tem Cognito para a tela de login?":** não. Existe a **decisão** (ADR-006,
Cognito headless, herdado do ADR-005 do drezz) e as **regras** (`geracrm-identidade-acesso`). Não
existe user pool criado, nem tela, nem código. E a tela de login sequer foi especificada (§2.2).

### 3.3 Esqueleto do monorepo

Não existe `package.json`, `pnpm-workspace.yaml`, `turbo.json`, nem nenhuma das quatro apps.
É trabalho de horas, com o padrão do drezz para copiar — mas precisa ser feito.

### 3.4 Acesso ao GeraCloud

Documentação da API, credenciais de teste e um ambiente de homologação do ERP.

---

## 4. Ordem sugerida — as seis próximas entregas

| # | Entrega | Por quê nesta ordem | Bloqueia |
|---|---|---|---|
| **0** | **Iniciar registro na Meta** | Prazo fora do nosso controle | Onda 1 inteira |
| **1** | **Modelo de dados** | Nada pode ser escrito antes | Migrations, API, telas |
| **2** | **Identidade visual + design tokens** | Token é pré-requisito de qualquer componente | Todo o front |
| **3** | **Especificação das telas de entrada** | Login e onboarding são a primeira coisa a construir | Onda 0/1 |
| **4** | **Esqueleto do monorepo + infra provisionada** | Terreno para o código | Tudo |
| **5** | **Contrato de API + cenários BDD da Onda 0** | Critério de aceite antes da implementação | Onda 0 |

As entregas 0, 1 e 2 podem correr **em paralelo** — dependem de pessoas diferentes.

---

## 5. Sobre "testes de todas as naturezas"

A estratégia está definida em `geracrm-testes`, `tdd` e `bdd`. As naturezas e onde cada uma entra:

| Natureza | Onde | Quando entra |
|---|---|---|
| **Domínio puro** | Regras de RFV, janela de 24h, pedido mínimo, máquina de estados | Com o modelo de dados |
| **Caso de uso + banco real** | Testcontainers, transação, contador atômico | Onda 0 |
| **Isolamento (RLS)** | Todo repositório, com dois tenants | Onda 0 — não negociável |
| **Isolamento de canal** | Push SSE, com dois tenants | Onda 1 |
| **Conformidade de conector** | Uma suíte, todo adaptador | Onda 0 |
| **API HTTP** | `fastify.inject()` | Onda 0 |
| **Concorrência** | Disparo, assumir atendimento, efetivação | Onda 1–3 |
| **Console** | Vitest + Testing Library — fluxos e transições de estado | Onda 1 |
| **App** | RNTL — fila, assumir, pedido offline | Onda 2 |
| **Acessibilidade** | Contraste, foco, teclado | Com o design system |
| **Carga** | Volume real do primeiro cliente | Antes da Onda 3 |
| **Fim a fim** | Poucos, nos fluxos que param o negócio | Onda 2+ |

⚠️ **O que ainda falta é o volume real do primeiro cliente** (decisão pendente nº 5 da stack) —
sem ele não dá para dimensionar teste de carga.

---

## 6. Resposta curta

**Planejamento de produto e arquitetura: pronto.**
**Modelo de domínio, design e telas de entrada: não existem.**
**Infraestrutura e registro na Meta: nada provisionado.**

Nada disso é retrabalho — é a sequência natural. Mas **o registro na Meta deveria ter começado
ontem**, porque é o único prazo que não controlamos.
