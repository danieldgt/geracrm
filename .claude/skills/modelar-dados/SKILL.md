---
name: modelar-dados
description: >
  Modelar o domínio antes do banco: entidades, agregados, invariantes, identidade, relacionamentos,
  multi-tenancy, temporalidade/histórico, dados vindos de sistema externo e estratégia de migração.
  Produz modelo conceitual defensável, não DDL. Use quando for preciso "modelar os dados",
  "definir as entidades", "desenhar o banco", "modelar o domínio", quando aparecerem dúvidas sobre
  chaves, duplicidade, versionamento ou histórico, ou antes de escolher qualquer banco de dados.
---

# Modelagem de dados

Modele **conceito**, depois tabela. Quem começa pela tabela acaba com um domínio que é o reflexo
de uma decisão de armazenamento tomada cedo demais.

## Ordem de trabalho

```
1. Identificar entidades e o que as identifica
2. Escrever as invariantes  ← a etapa que quase todo mundo pula
3. Agrupar em agregados, definindo quem protege cada invariante
4. Definir relacionamentos e cardinalidade real
5. Decidir temporalidade: o que precisa de histórico
6. Tratar identidade externa e reconciliação
7. Só então: tabelas, chaves e índices
```

## 1. Entidade vs. valor

| | Entidade | Objeto de valor |
|---|---|---|
| Tem identidade própria | Sim | Não |
| Duas cópias iguais são a mesma coisa? | Não | Sim |
| Exemplo | Cliente, Pedido, Conversa | Endereço, Dinheiro, Faixa de RFV |

⚠️ **Transformar valor em entidade é o erro mais comum e mais caro.** "Endereço" com ID próprio
gera órfãos, duplicatas e uma tela de CRUD que ninguém pediu.

## 2. Invariantes — escreva-as antes de qualquer tabela

Invariante é a regra que **precisa ser verdadeira sempre**, não em algum momento. É o que dá
sentido ao agregado.

Formato:

```
INV-01  Um pedido não pode ser efetivado com total abaixo do mínimo do cliente
INV-02  Um contato com opt-out não recebe mensagem de campanha, por nenhum caminho
INV-03  Uma conversa fora da janela de 24h só aceita mensagem de template aprovado
INV-04  Toda consulta retorna apenas dados do tenant do usuário autenticado
```

**Para cada invariante, responda: quem a protege?** Se a resposta for "o front-end", está errado.
Se for "todo mundo lembra de checar", está errado. Invariante protegida por disciplina é
invariante violada.

INV-02 e INV-04 são exemplos de invariante que **precisa ser garantida pela camada**, não pelo
chamador — porque tem muitos chamadores e um esquecimento basta para causar dano real.

## 3. Agregado

Agregado é o conjunto de objetos que muda junto e é protegido junto. Regras:

- **Uma raiz.** Referências externas apontam só para a raiz
- **Transação = agregado.** Se uma operação precisa alterar dois agregados atomicamente, ou os
  limites estão errados, ou o caso pede consistência eventual explícita
- **Agregado pequeno.** Agregado grande vira gargalo de concorrência

Exemplo de decisão de limite:

```
Pedido (raiz)
  ├─ ItemDoPedido  ← dentro: o total e o mínimo dependem dos itens
  └─ referência a ClienteId  ← fora: cliente vive por conta própria
```

⚠️ **Não coloque tudo que "se relaciona" no mesmo agregado.** Relacionamento ≠ consistência
transacional.

## 4. Relacionamentos — modele a cardinalidade real

O mundo real é mais bagunçado que o diagrama inicial. Antes de fixar `1:N`, pergunte:

- Um cliente tem **um** telefone? (Não. Tem vários, e um é o principal.)
- Um cliente tem **um** CNPJ? (Não, se houver grupo econômico.)
- Um cliente tem **um** nome? (Não, se vier de várias fontes com grafias diferentes.)
- Um contato pertence a **um** vendedor? (Hoje sim; mas o histórico de quem foi dono importa.)

Cada "não" vira estrutura. Descobrir isso depois custa migração.

## 5. Temporalidade — o que precisa de histórico

Três padrões, escolha conscientemente:

| Padrão | Quando usar | Custo |
|---|---|---|
| **Estado atual** | O passado não tem valor de negócio | Baixo |
| **Histórico de mudanças** | "Quando mudou e quem mudou" é pergunta real | Médio |
| **Série temporal** | O valor está na **trajetória**, não no ponto | Alto |

Perguntas que revelam necessidade de histórico:
- *"Quem era o dono desse cliente em março?"* → histórico de atribuição
- *"Como esse cliente evoluiu de Campeão para Em Risco?"* → série temporal de segmento
- *"Qual era o preço quando o pedido foi feito?"* → **snapshot no pedido**, não referência ao preço atual

⚠️ **Preço, endereço e condição comercial dentro de um pedido são snapshot, não referência.**
Se o pedido aponta para o preço atual do produto, o histórico financeiro se corrompe no primeiro
reajuste.

## 6. Identidade externa e reconciliação

Quando o dado vem de fora (ERP, canal de mensagem, importação), você tem **duas identidades**:
a sua e a dele.

```
Cliente
  id            (nossa identidade, estável, interna)
  ids_externos  [ {sistema: "erp", id: "4471"}, {sistema: "whatsapp", id: "5581..."} ]
```

**Regras:**
- Nunca use o ID externo como chave primária. Ele muda, se repete entre sistemas e some quando
  a integração troca
- Guarde **todos** os IDs externos, não só o último
- Defina a **chave de reconciliação** explicitamente: por CNPJ? telefone normalizado? e-mail?
  E o que fazer quando duas chaves discordam
- Registre a **fonte de cada campo** quando várias fontes escrevem no mesmo lugar. Sem isso,
  ninguém sabe por que o nome mudou sozinho

⚠️ **Normalize telefone na escrita, não na leitura.** `+55 81 99861-7049`, `5581998617049` e
`81998617049` precisam colidir na mesma chave, senão a base duplica silenciosamente.

## 7. Multi-tenancy

Se a decisão é multi-tenant, ela é **transversal e não retroativa**:

- `tenant_id` em toda tabela de domínio, sem exceção
- Isolamento garantido pela **camada de acesso**, não por `WHERE` escrito à mão
- Chaves únicas são compostas com o tenant: `UNIQUE(tenant_id, cnpj)`, nunca `UNIQUE(cnpj)`
- Toda integração, token e credencial é por tenant

⚠️ **Retrofitar tenancy é reescrever todo o acesso a dados.** É a decisão mais barata de tomar
cedo e mais cara de adiar.

## 8. Só agora: tabelas

Com o modelo conceitual pronto, as decisões físicas ficam quase óbvias:

- Índice nasce de **consulta real da tela**, não de intuição
- Desnormalização é decisão consciente, com o motivo escrito
- Dado analítico pesado (agregações históricas, séries temporais) **não compete com o
  transacional** — separe leitura analítica de escrita operacional
- Migração: toda mudança precisa de caminho de ida e de volta

## Checklist antes de fechar

- □ Toda invariante está escrita e tem um dono
- □ Todo agregado cabe numa transação
- □ Nenhuma cardinalidade foi assumida sem ser questionada
- □ O que precisa de histórico está identificado, com o padrão escolhido
- □ Preço e condições em documentos são snapshot
- □ Chave de reconciliação de identidade externa está definida
- □ `tenant_id` está em tudo, se multi-tenant
- □ Nenhuma tabela existe "porque vai precisar depois"

## Próxima etapa

Modelo pronto → `arquitetura-limpa` (onde as regras moram) e `bdd` (as invariantes viram cenários).
