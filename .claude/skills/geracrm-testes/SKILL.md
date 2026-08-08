---
name: geracrm-testes
description: >
  Como escrever e rodar testes no GeraCRM: BDD pragmático com Vitest, Testcontainers para
  Postgres/RLS, suíte de conformidade dos conectores de ERP, teste de isolamento de canal SSE e
  testes de concorrência. Usar sempre que criar, alterar ou depurar testes, ou implementar
  funcionalidade que exija cobertura de fluxo de negócio.
---

# Testes no GeraCRM

Herdado de `drezz-testes`, com três acréscimos que o GeraCRM exige: **conformidade de conector**,
**isolamento de canal** e **degradação por capacidade**.

## Estilo: BDD pragmático

Fluxos de negócio são especificados **por comportamento**, em Given/When/Then, com Vitest puro —
`describe`/`it` narrativos em português. Sem Cucumber: a spec é o teste.

```ts
describe('Efetivação de pedido assistido', () => {
  it('dado pedido abaixo do mínimo do cliente, quando enviar, então bloqueia e informa quanto falta', async () => {})
  it('dado estoque esgotado entre montar e enviar, quando o ERP recusa, então preserva o rascunho e nomeia o SKU', async () => {})
  it('dado falha de comunicação, quando reenviar, então não duplica o pedido no ERP', async () => {})
})
```

- Todo caso de uso tem no mínimo: **caminho feliz, falha de validação e falha de infraestrutura**
  (ERP fora, Meta fora, conflito de transação).
- **Bug corrigido = teste que o reproduz, escrito ANTES do fix.**
- ⚠️ **Dado de teste nunca pode ser válido "às vezes".** CNPJ, CPF, EAN e telefone têm formato
  verificado — montar a partir de um pedaço de UUID cria dado que passa na maioria das rodadas e é
  recusado quando o recorte cai só com dígitos. Gere com a função que calcula o DV, ou use formato
  que a validação não confunda. Foi essa a origem de uma suíte que falhava em ~12% das rodadas.

## Pirâmide e infraestrutura

| Nível | Ferramenta | Regra |
|---|---|---|
| Domínio puro (RFV, janela de 24h, regras de pedido, máquina de estados) | Vitest, sem IO | maioria dos testes; sem mock de banco |
| Caso de uso + banco | Vitest + **Testcontainers (Postgres real)** | tudo que toca transação, RLS ou contador atômico — ⚠️ proibido SQLite ou mock de banco aqui |
| API HTTP | `fastify.inject()` | schema, auth e status codes, sem subir servidor |
| Console | Vitest (padrão do Angular 21) + Testing Library | fluxos críticos: inbox, montagem de pedido, kanban |
| App | React Native Testing Library | fluxos de campo: fila, assumir atendimento, pedido offline |

## Isolamento — a categoria mais importante

**RLS testa-se com dois tenants.** Todo teste de repositório inclui um caso provando que tenant A
não lê dado do tenant B. Sem exceção.

### ⚠️ E o teste precisa rodar sob o PAPEL DA APLICAÇÃO

Este erro custou um teste falso-verde no primeiro dia do projeto:

```sql
-- ❌ Conectado como dono/superusuário: o RLS é IGNORADO.
--    O teste passa sempre, inclusive quando a policy está errada ou ausente.
SET geracrm.tenant_id = '...tenant A...';
SELECT * FROM contato;          -- devolve TUDO, de todos os tenants

-- ✅ Sob o papel da aplicação, que é como a API se conecta de verdade:
SET ROLE geracrm_app;
SET geracrm.tenant_id = '...tenant A...';
SELECT * FROM contato;          -- devolve só o do tenant A
```

⚠️ **`FORCE ROW LEVEL SECURITY` não resolve isso.** `FORCE` submete o **dono** da tabela às
policies — mas **superusuário ignora RLS sempre**, com ou sem `FORCE`. E em desenvolvimento é
comum a conexão ser justamente com o superusuário do container.

**Regra:** todo teste de isolamento faz `SET ROLE geracrm_app` (ou usa uma conexão com esse papel)
**antes** de qualquer asserção. Um teste de isolamento que passa conectado como superusuário não
está provando nada — e é pior que nenhum teste, porque dá confiança falsa.

**Casos obrigatórios do bloco de isolamento:**

```
□ tenant A não lê linha do tenant B
□ tenant A não GRAVA linha com tenant_id de B   → o banco recusa
□ sessão sem tenant definido devolve zero linhas (não devolve tudo)
□ o papel da aplicação NÃO tem BYPASSRLS
```

**Canal SSE testa-se com dois tenants também.** Herda a mesma lógica, aplicada ao push:

```ts
describe('Isolamento de canal', () => {
  it('dado usuário do tenant A, quando pede canal do tenant B, então a subscrição é recusada', async () => {})
  it('dado usuário sem permissão no número, quando pede o canal do número, então recusa', async () => {})
  it('dado permissão revogada durante a sessão, quando o evento é publicado, então não é entregue', async () => {})
  it('dado evento publicado, então o payload não contém conteúdo de mensagem', async () => {})
})
```

⚠️ O último é o teste de defesa em profundidade: se um payload passar a carregar conteúdo, o erro
de fan-out deixa de ser bug e vira incidente.

## Conformidade dos conectores de ERP

**Uma suíte, rodada contra todo adaptador.** É o que garante que a porta é do nosso domínio e não
uma cópia do SDK de alguém.

```ts
describe.each(conectores)('conformidade — %s', (conector) => {
  it('ingestão de cliente produz o modelo canônico completo', async () => {})
  it('reenvio da mesma operação é idempotente', async () => {})
  it.skipIf(!conector.capacidades.saldoSincrono)('saldo responde dentro do timeout', async () => {})
  it.skipIf(!conector.capacidades.escritaPedido)('escrita de pedido retorna número ou erro tipificado', async () => {})
})
```

- **Capacidade ausente é `skip`, não falha.** ERP sem saldo síncrono não é conector quebrado.
- **A degradação também é testada**: com `saldoSincrono: false`, a tela mostra saldo da última
  sincronização com aviso — e a validação migra para a efetivação.
- Conector é mockado **pelo contrato**, com fixtures de resposta reais (sucesso, recusa tipificada,
  timeout). ⚠️ Proibido stub ad-hoc de `fetch`.

## ⚠️ Isolamento ENTRE arquivos de teste

O Vitest roda arquivos **em paralelo**, contra o mesmo banco. Dois erros aparecem, e os dois se
manifestam como falha intermitente que muda a cada execução:

| Erro | Sintoma |
|---|---|
| Dois arquivos usando o **mesmo `tenant_id`** de fixture | Um apaga o dado do outro no `beforeEach`. O teste falha comparando um nome pelo outro |
| Dois arquivos inserindo em **tabela global** com a mesma chave natural | `duplicate key` em `plano_codigo_key` — `plano` não tem `tenant_id` (§7.2), então `codigo` é único no banco inteiro |

**Regra:** cada arquivo de teste tem **UUIDs de fixture exclusivos** e, em tabela global, **chave
natural com o nome do arquivo** (`plano-teste-ingestao`, não `pro`).

⚠️ Isto é o "estado compartilhado" que a skill `tdd` proíbe — só que entre arquivos, onde é mais
difícil de enxergar. Serializar com `fileParallelism: false` esconde o problema e torna a suíte
lenta; isolar o fixture resolve.

## Concorrência

Testes de duas transações simultâneas, obrigatórios em:

- **Contador de disparo por número** — sem estourar o limite diário
- **Assumir atendimento** — dois atendentes clicando junto; só um assume
- **Efetivação de pedido** — reenvio simultâneo não duplica

## Integrações externas

- **Meta (WhatsApp/Instagram)**: sempre mockada por contrato, com fixtures de webhook reais —
  mensagem recebida, status de entrega, falha de template, mudança de qualidade do número.
  ⚠️ Nunca chamar a API da Meta em teste automatizado.
- **IA**: mockada por contrato. Teste de prompt real é manual e etiquetado
  (`it.skipIf(!process.env.IA_E2E)`).
- **ERP real**: manual e etiquetado, nunca no CI.

## O que sempre tem teste

- □ Toda invariante do modelo tem um caso que **tenta violá-la e espera falha**
- □ Todo caso de uso tem caminho feliz + validação + infraestrutura fora
- □ Todo repositório tem o caso de dois tenants
- □ Toda regra de janela de 24h tem os casos de fronteira (23h e 24h)
- □ Opt-out tem caso provando que **nenhum caminho** entrega — inclusive disparo manual em lote
- □ Todo erro tipificado do ERP tem caso com a mensagem que a tela mostra

## Execução

- `pnpm test` na raiz roda tudo (Turborepo com cache); `pnpm --filter api test` por app
- Testcontainers exige Docker ativo. Se indisponível, rode só os testes de domínio e **diga isso
  explicitamente no resultado** — não afirme que a suíte passou
- ⚠️ **Teste instável é defeito**: conserta ou apaga. Um flaky tolerado ensina o time a ignorar
  vermelho, e aí a suíte inteira perde valor
- CI roda a suíte completa; PR não mergeia com teste vermelho ou caso de uso sem cobertura
