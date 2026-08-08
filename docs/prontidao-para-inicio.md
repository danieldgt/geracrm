# Próximos passos e o que falta

> Estado em 08/08/2026, depois da revisão final. Este documento é reescrito a cada mudança de
> estado — se a data acima não for de hoje, desconfie dele.

---

## 1. Onde estamos

**O planejamento acabou.** Ondas 0 e 1 detalhadas, 2–4 em nível macro, 16 ADRs, modelo com 70
entidades e 60 invariantes, contrato de API, telas, cenários BDD, identidade visual e 35 skills.

**O código começou.** `packages/shared` com as duas primeiras regras de domínio (janela de 24h e
normalização de telefone), 14 testes verdes.

⚠️ **Não há sistema para acessar.** Sem servidor, banco, API ou tela. A Onda 0 não tem tela por
desenho — ela entrega dado entrando e canal em pé. O console chega na Onda 1.

---

## 2. 🔴 O que trava, hoje

### 2.1 Depende só de nós — e nada disso é código

| # | O que | Por que trava | Esforço |
|---|---|---|---|
| **N-1** | **Data da medição do antes**, e comunicá-la ao cliente | ⚠️ **O único dado irrecuperável do projeto.** Dois planos nossos discordam em 14 semanas: `plano-onda-0` §5.5 diz ≈T-22, `plano-onda-1` e `entrada` §7 dizem T-8. Uma leitura mede 5 meses antes do corte (sazonalidade contamina); a outra mede depois de a equipe já saber (comportamento muda) | Decisão |
| **N-2** | **PoC da PK composta `(tenant_id, id)`** + ADR-016 | Bloqueia a migration `0001` e tudo depois. ⚠️ Revisar isso depois da `0012` é reescrita de schema | 1–2 dias |
| **N-3** | Corrigir os **4 resíduos do ADR-015** | O critério de saída nº 5 da Onda 0 hoje **não fecha**: exige LB-07, que é foto do dia do primeiro corte (Onda 1) sobre job de RFV (Onda 2). Mais o `T+1` que ainda diz "fecha o critério nº 2 da Onda 0" e a onda divergente de RFV-08 e PLT-11 | Horas |
| **N-4** | **Política de privacidade e termos** | ⚠️ **Está no caminho crítico externo e ninguém tinha notado:** o App Review da Meta (M-07) exige a URL pública. Sem isso, M-07 não é submetido | Jurídico |
| **N-5** | Provisionar infra — Cognito, 2 projetos Railway, Postgres + réplica, bucket, Sentry, cofre de segredos, domínios | Bloqueia a `0001` e o webhook público | 1–2 dias |

### 2.2 Depende de terceiro — todos parados desde o início

| # | O que | Dono | Espera | Bloqueia |
|---|---|---|---|---|
| **T-1** 🔴 | **M-01…M-04** — Business Manager, verificação de domínio, app, Business Verification | Meta | dias a semanas | M-05 → M-07 → o corte do cliente |
| **T-2** 🔴 | **M-13 — os números do cliente já estão em API oficial?** | Cliente | até 3 semanas | ⚠️ Se estiverem, o onboarding é **portabilidade entre WABAs**, não conexão — e depende do concorrente que está perdendo o cliente. **Sem plano B**: número novo perde o reconhecimento da base |
| **T-3** 🔴 | **M-09/M-10** — documentação da API do GeraCloud e credenciais de homologação isoladas | Time do ERP | dias | **EP-02 inteiro** — o coração da Onda 0 |
| **T-4** | **M-11/M-12** — cópia da base real e volume (contatos, anos, mensagens/dia, nº de números) | Cliente | dias | Dimensionamento e o risco nº 1 (40% da base sem documento) |
| **T-5** | **Opt-out histórico e faturas do BSP atual** | Cliente | — | ⚠️ **Somem no cancelamento do contrato antigo.** Depois não existem em lugar nenhum |

---

## 3. Ordem recomendada

```
HOJE — quatro coisas, em paralelo, nenhuma é código
  ① T-1  iniciar o registro na Meta ............... semanas de espera, parado há dias
  ② T-3  pedir doc e credenciais do GeraCloud ..... bloqueia EP-02 inteiro
  ③ T-2  perguntar ao cliente sobre os números .... define entrada vs. portabilidade
  ④ N-1  decidir a data da medição do antes ....... irrecuperável

ESTA SEMANA
  ⑤ N-2  PoC da PK composta + ADR-016 ............. destrava a migration 0001
  ⑥ N-5  provisionar infra
  ⑦ N-3  corrigir os 4 resíduos do ADR-015
  ⑧ N-4  encomendar política e termos ............. está no caminho crítico da Meta

DEPOIS — aí sim, código de produção
  ⑨ migrations 0001…0010
  ⑩ R-01  API Fastify + Zod + plugin de tenant
  ⑪ EP-02 conector GeraCloud + carga histórica
```

⚠️ **Os quatro de hoje não dependem de nenhuma linha de código, e três deles dependem de pessoas
fora do time.** Cada dia parado ali é um dia somado ao fim do projeto, não ao começo.

---

## 4. O que dá para fazer sem esperar ninguém

Se a ideia é ver algo de pé enquanto os terceiros respondem:

| Opção | O que entrega | Depende de |
|---|---|---|
| **Docker Compose + API com health check** | Primeira coisa que abre no navegador; esqueleto para tudo depois | Nada |
| Mais regras de domínio em `shared` | RFV, pedido mínimo, chave de reconciliação — puras, testáveis, sem banco | Nada |
| Biblioteca de componentes (bloco 1) | Botão, campo, badge, tabela sobre os tokens | Nada |
| Migrations `0001`…`0010` | O schema de pé | **N-2** (PoC da PK) |

---

## 5. O padrão que a revisão final expôs

Os quatro 🔴 de consistência têm **uma causa só**: o ADR-015 moveu o marco do corte da Onda 0 para
a Onda 1, e os documentos que apontavam para esse marco não foram reancorados.

⚠️ **A lição é sobre datas relativas.** "T-8" e "antes da S0" pareciam âncoras estáveis e não eram —
`T` mudou de onda e as duas passaram a significar coisas diferentes. Onde a data importa de verdade
(a medição do antes, que é irrecuperável), a âncora precisa ser **um fato, não uma sigla**: *duas
semanas antes de a equipe do cliente saber que a migração vai acontecer*.

---

## 6. Pendências que não bloqueiam nada agora

11 médias e 6 baixas da revisão de consistência · o nono varredor (numeração de migration) · 3
cenários BDD de comportamentos novos · 4 furos de token · 4 códigos de erro do catálogo ·
`prontidao` a reescrever a cada mudança de estado (é este documento) · precificação · cláusula de
desistência no meio do corte · retenção pós-saída com jurídico.
