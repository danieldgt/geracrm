# R10 — Plataforma para vender o CRM a outros clientes (próxima rodada)

> Raia aberta pelo `plano-mestre-vendedor-autonomo.md` §4. Este documento é o briefing para a
> rodada seguinte, no formato das raias (arquivos, contrato, pronto), para rodar por
> `rodada-raias` (`.claude/workflows`).

## Por que agora

O agente vendedor, o catálogo manual e o playground tornam o produto vendável a uma loja
**sem ERP**. O que falta é o que o Taylor (ata de 27/07) chamou de "implantação eficiente":
entrar, configurar e começar a vender em uma hora, com a marca do cliente — e com a Gera3
podendo operar vários clientes sem tocar em banco.

## R10a — Onboarding guiado
```
ARQUIVOS   apps/console/src/app/funcionalidades/onboarding/**, apps/api/src/contexts/plataforma/onboarding/**
           (tabela onboarding_passo já existe: 0003b)
CONTRATO   GET/PUT /v1/onboarding (passos: numero_conectado, catalogo_pronto, politicas_escritas,
           persona_definida, agente_em_sombra, primeira_venda) — cada passo com "como fazer" e link
PRONTO     cliente novo vê um checklist na Início até concluir; cada passo marca sozinho quando a
           condição vale (ex.: produto_indice > 0); nenhum passo exige a Gera3
```

## R10b — White-label por tenant
```
ARQUIVOS   infra/migrations/0093_tenant_marca.sql (tenant_marca: nome_exibicao, logo_chave, cores jsonb
           {acao, acaoHover}, dominio), apps/api/src/contexts/plataforma/rotas-marca.ts,
           apps/console/src/app/nucleo/tema.servico.ts (aplica tokens do tenant em runtime),
           apps/console/src/app/compartilhado/ui/marca.componente.ts
CONTRATO   GET /v1/marca (público por host) → {nome, logoUrl, cores}; PUT /v1/plataforma/clientes/:id/marca (staff)
PRONTO     dois tenants abrem o mesmo console com logo/cor próprios; login mostra a marca pelo host;
           tokens continuam a única fonte (cor do tenant vira --acao em runtime, nunca #hex no componente)
```

## R10c — Módulos por plano
```
ARQUIVOS   plano.modulos (já existe) → apps/console/src/app/nucleo/menu.ts (cadeado por módulo),
           apps/api/src/plugins/modulo.ts (preHandler exigirModulo('agente'|'campanhas'|'catalogo'))
PRONTO     item fora do plano aparece com cadeado e texto de upsell (regra da skill: sem permissão não
           aparece; sem contrato aparece com cadeado); API recusa 402 modulo.nao_contratado
```

## R10d — LGPD do agente
```
ARQUIVOS   apps/api/src/contexts/plataforma/lgpd/** (exclusão do titular alcança agente_decisao,
           cliente_memoria, conhecimento com dado pessoal, mensagens), job de retenção por tenant
           (agente_decisao.retencao_dias), export do titular
PRONTO     DELETE /v1/contatos/:id/titular apaga/anonimiza em todas as tabelas (teste lista cada uma);
           retenção roda à noite e registra em auditoria
```

## R10e — Canal não-oficial pronto para autônomo
```
ARQUIVOS   INV-23 (numero_throttle) ligado no gateway e no despachante; caminho_preferido por tenant
           (estudo Baileys §12.3); aviso visível de queda para o outro caminho
PRONTO     dois envios do mesmo número respeitam intervalo randômico mínimo; campanha pede "quantos cabem";
           tela de Números mostra o caminho padrão
```

## Ordem sugerida
R10a → R10c → R10b → R10e → R10d (a LGPD entra antes do primeiro cliente externo com agente autônomo).
