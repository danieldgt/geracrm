# Infraestrutura — o que preciso de você para configurar

> Decisão N-5: você cria as contas, eu configuro. Esta é a lista exata.
> ⚠️ **Nenhuma migration roda antes disto.** É o que separa o código escrito do código executando.

---

## 1. Contas a criar

| # | Conta | Como | Plano |
|---|---|---|---|
| **C-1** | **AWS** | Conta da Gera3, com cartão corporativo | Cognito fica no free tier por MAU no início |
| **C-2** | **Railway** | Conta da Gera3, cartão corporativo | Uso medido |
| **C-3** | **Sentry** | Organização da Gera3 | Free serve para começar |
| **C-4** | **Domínio** | Registrar `[definir]` | ⚠️ Ver §4 — a escolha afeta a Meta |

Se a Gera3 já tem AWS, Railway ou Sentry do drezz, **reaproveitar a organização** e criar projeto
separado é melhor: menos faturas, menos gente para gerenciar acesso.

## 2. Acessos que preciso

| # | Onde | Nível | Para quê |
|---|---|---|---|
| **A-1** | AWS | IAM com permissão de Cognito, S3 e IAM limitada | Criar user pool, bucket e as políticas |
| **A-2** | Railway | Membro dos dois projetos | Criar serviços, banco, variáveis, domínios |
| **A-3** | Sentry | Admin do projeto | Configurar DSN, alertas e filtro de PII |
| **A-4** | DNS do domínio | Editar registros | ⚠️ Verificação de domínio da Meta (TXT) e domínios dos serviços |

⚠️ **Não me mande credencial por mensagem.** Use o cofre de segredos, ou crie o acesso e me avise —
eu configuro e você revoga depois se quiser.

## 3. O que eu provisiono depois

```
AWS
 └── Cognito user pool          custom:tenant_id · grupos de papel · MFA · sem Hosted UI
 └── S3                         bucket de mídia · URLs assinadas · ciclo de vida

Railway
 ├── projeto geracrm-hom        API · Postgres · réplica · variáveis
 └── projeto geracrm-prod       idem, credenciais distintas em tudo
       ⚠️ Dois PROJETOS, não dois environments — environment compartilha
          permissão, e um `railway link` errado aponta hom para o banco de prod

Sentry
 └── projeto por ambiente       ⚠️ com filtro de PII: conversa de cliente nunca vai para o Sentry

Local (eu configuro, roda na sua máquina)
 └── docker-compose.yml         Postgres + MinIO para desenvolvimento
```

## 4. ⚠️ A decisão do domínio afeta a Meta

O domínio não é só endereço — ele entra na **verificação de negócio da Meta** (M-02) e na
**política de privacidade** (App Review).

Três exigências que valem lembrar antes de registrar:

1. O site precisa ficar **no domínio verificado**, com nome legal e endereço visíveis
2. O e-mail de contato precisa ser **do mesmo domínio** — ⚠️ Gmail corporativo reprova
3. O nome legal enviado à Meta precisa ser **byte a byte o do cartão CNPJ**

⚠️ Errar aqui não é ajuste: é reprovação com recomeço do ciclo de verificação, que leva semanas.

## 5. Ordem

```
① C-4 domínio    →  destrava M-02 (verificação) e a URL da política
② C-1 AWS        →  Cognito e bucket
③ C-2 Railway    →  os dois projetos
④ C-3 Sentry     →  observabilidade
⑤ A-1…A-4        →  me dá acesso
⑥ eu configuro   →  1–2 dias
⑦ migration 0001 →  aí o schema existe
```

⚠️ **O domínio é o primeiro porque a Meta depende dele** — e o relógio da Meta é o único que não
paraleliza.

## 6. Custo aproximado no início

| Item | Ordem de grandeza |
|---|---|
| Cognito | ~zero (free tier por usuário ativo) |
| Railway (2 projetos, banco + réplica) | Dezenas de dólares/mês |
| S3 | Poucos dólares até a mídia acumular |
| Sentry | Zero no free |
| Domínio | Anual, baixo |

O que cresce com o uso é **banco** e **armazenamento de mídia** — nessa ordem. Está previsto na §11
de [`stack-arquitetura.md`](./stack-arquitetura.md), com as alavancas de redução.

---

## 7. Enquanto isso, o que não depende de nada

Docker Compose local com Postgres e MinIO destrava **as migrations e todo o desenvolvimento** —
sem AWS, sem Railway, sem cartão. Só o webhook público (E3-01) precisa de nuvem de verdade, e ele
vem depois.

Se você quiser, monto o Compose agora e começamos pelo schema.
