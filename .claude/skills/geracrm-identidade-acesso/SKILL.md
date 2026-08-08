---
name: geracrm-identidade-acesso
description: >
  Autenticação e autorização no GeraCRM: Cognito headless, claim de tenant, papéis e permissões,
  autorização em caso de uso, permissão por número e por carteira, token de push, revogação durante
  a sessão, e o caminho para white-label multi-tenant. Usar ao mexer em login, sessão, permissão,
  papel, convite de usuário, ou ao decidir onde uma checagem de acesso deve morar.
---

# Identidade e acesso

**Cognito headless** (ADR-006, herdado do ADR-005 do drezz): Cognito é o provedor, mas **toda a UI
é nossa** — login, cadastro, recuperação de senha e gestão de usuários são telas próprias.
⚠️ A Hosted UI do Cognito nunca é exibida.

## Modelagem

- Um user pool; **`custom:tenant_id`** como atributo do usuário.
- Papéis por **groups** do Cognito. Grupo de staff da Gera3 com acesso cross-tenant **auditado**.
- A API valida o JWT **localmente via JWKS** — stateless, sem chamada ao Cognito por request.
- MFA, verificação de e-mail e reset delegados ao Cognito.
- Gestão de usuários sempre pela aplicação (painel próprio). ⚠️ Nunca pelo console AWS — o que se
  faz por lá não passa por auditoria nem por regra de negócio.

**Lock-in mitigado por desenho:** a fronteira é um plugin Fastify + telas próprias. Trocar o IdP
não toca o produto.

## A regra fundamental

⚠️ **`tenant_id` vem do token, nunca de parâmetro.**

Qualquer rota que aceite `tenantId` no corpo, na query ou no path está errada — mesmo que valide
depois. O parâmetro não deveria existir.

## Onde a autorização mora

| Camada | Responsabilidade |
|---|---|
| **Caso de uso** | ✅ A decisão de acesso. Vale para toda porta de entrada — HTTP, worker, importação |
| Camada de acesso a dados | ✅ Isolamento de tenant (RLS), garantido, não opcional |
| Controller | ❌ Só extrai o contexto autenticado e repassa |
| Console / app | ❌ Esconde o que não pode ser usado — **nunca é a garantia** |

⚠️ **Autorização em controller vaza.** A mesma regra precisa valer quando a ação vier de um job, de
um webhook ou da API pública. Se estiver no controller, cada nova porta de entrada esquece dela.

## Níveis de permissão do produto

Além do papel, o GeraCRM tem três recortes que a maioria dos CRMs não tem:

| Recorte | Significa |
|---|---|
| **Por filial** | Usuário vê apenas as unidades a que pertence |
| **Por número** | Vendedora vê o inbox do próprio número; supervisor vê a frota |
| **Por carteira** | Vendedor vê os clientes que são dele (CRM-06) |

⚠️ Esses três se combinam. A pergunta "este usuário pode ver esta conversa?" passa por tenant →
filial → número → carteira. **Centralize essa decisão em um lugar só** — replicá-la em cada tela
garante divergência.

## Token de push

O canal SSE tem token próprio, curto (5–15 min), com `{ tenantId, userId }`.

⚠️ **O token não carrega a lista de canais permitidos.** A autorização é revalidada **a cada
subscrição** — permissão muda durante a sessão. Detalhes em `geracrm-tempo-real`.

## Revogação durante a sessão

| Evento | Efeito |
|---|---|
| Usuário removido de um número | Publica `permissao.alterada` no canal dele; assinaturas do número são encerradas **no servidor** |
| Carteira transferida | O cliente sai da visão do vendedor anterior na próxima consulta |
| Usuário desativado | Sessão invalidada; assinaturas encerradas |
| Papel alterado | Cliente re-autoriza; a UI recalcula o que mostra |

⚠️ **Encerrar só no cliente não é revogação.** A decisão é do servidor.

## Credenciais de terceiros

Token da Meta, credencial de ERP, chave de IA: **por tenant, cifrados em repouso**.

⚠️ Nunca em texto plano em tabela nem em log. ⚠️ Credencial de um cliente jamais alcança outro —
é o mesmo risco do canal sem tenant, com consequência pior.

## Auditoria

Registrar: envio de mensagem · exclusão · transferência de atendimento · mudança de carteira ·
alteração de permissão · acesso cross-tenant do staff · efetivação de pedido.

⚠️ **Acesso de staff a dado de cliente é sempre auditado**, sem exceção — é o que separa suporte
de invasão de privacidade.

## Caminho para white-label (Onda 4)

A tenancy desde a modelagem (ADR-001) já destrava PLT-09/10. O que falta é superfície:

- Domínio próprio por tenant → o pool precisa aceitar múltiplos domínios de callback
- Painel de revenda com subcontas → hierarquia de tenant (revenda → clientes)
- ⚠️ Staff da revenda tem acesso cross-tenant **dentro da própria revenda**, nunca fora

## Testes

```
□ rota que aceita tenantId por parâmetro → não deve existir
□ usuário do tenant A não lê dado do tenant B (todo repositório)
□ usuário sem permissão no número não vê a conversa
□ vendedor não vê cliente de outra carteira
□ permissão revogada durante a sessão deixa de valer imediatamente
□ acesso de staff gera registro de auditoria
```
