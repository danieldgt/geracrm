# apps/app — App do vendedor

**Expo / React Native** — Android e iOS. Recorte de campo, **não é o console espremido**.

> Status: **não implementado**. Aguardando Onda 2.

## Quem usa

A vendedora **fora da mesa**: no showroom, na feira, na rua, no pós-venda. Toda tela aqui precisa
justificar por que existe no bolso dela.

## Navegação

Tab bar de cinco: **Indicadores · Atendimento · Catálogo · CRM · Pagamentos**, com sub-abas
contextuais (`Tarefas | CRM | Metas`, `Visão geral | Equipe`).

## O que muda por ser campo

### Offline com fila de sincronização

```
SQLite local     catálogo, tabela de preço e carteira sincronizados
                 rascunhos de pedido
Fila             pedido montado offline aguarda conexão
Ao reconectar    revalida saldo e preço ANTES de efetivar
```

⚠️ **O conflito não é técnico, é comercial.** Se o saldo mudou entre montar e reconectar, o sistema
**não decide sozinho** — apresenta a divergência e a vendedora resolve. Sincronização automática
"resolveria" e criaria pedido errado.

Isso diverge do ADR-008 do drezz (online-only), de forma consciente: showroom sem sinal é caso de
uso real aqui.

### Push notification

Nova mensagem, tarefa vencendo, meta em risco. ⚠️ A notificação carrega **apenas o identificador**,
nunca o conteúdo — mesma regra do payload de evento, e evita expor conversa na tela de bloqueio.

### Rascunho multi-dispositivo

O rascunho de pedido é **estado do servidor**, não do aparelho. Começar no celular no showroom e
terminar no console precisa funcionar.

## Regras e skills

Regras gerais em [`geracrm-arquitetura`](../../.claude/skills/geracrm-arquitetura/SKILL.md).
Para Expo: [`expo-router`](../../.claude/skills/expo-router/SKILL.md),
[`expo-native-ui`](../../.claude/skills/expo-native-ui/SKILL.md),
[`expo-project-structure`](../../.claude/skills/expo-project-structure/SKILL.md),
[`expo-data-fetching`](../../.claude/skills/expo-data-fetching/SKILL.md),
[`expo-tailwind-setup`](../../.claude/skills/expo-tailwind-setup/SKILL.md),
[`eas-workflows`](../../.claude/skills/eas-workflows/SKILL.md),
[`eas-app-stores`](../../.claude/skills/eas-app-stores/SKILL.md).

## Design

Consome [`packages/design-tokens`](../../packages/design-tokens) via NativeWind. Componente é
duplicado entre console e app; **token, não**.
