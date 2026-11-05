# Aviso de origem e de mudanças

Esta skill é uma **adaptação** de **Impeccable**, de Paul Bakaus:

- Repositório: https://github.com/pbakaus/impeccable. Site: https://impeccable.style/
- Versão lida: commit `9fadc41729c38fd47d7ae622b501558653f9d2e9`, de 2026-11-02 (skill 4.8.x)
- Licença: Apache License 2.0. O texto integral está em `LICENSE`, nesta pasta.
- Copyright 2025 Paul Bakaus

O Impeccable avisa no `NOTICE.md` dele que as referências de iOS e Android (`skill/reference/ios.md` e
`android.md`) foram destiladas de `platform-design-skills`, de ehmo (https://github.com/ehmo/platform-design-skills,
licença MIT). Daquele material esta adaptação usa só regras de plataforma de domínio público: 44 pt no iOS, 48 dp no
Android, área segura, voltar do sistema e Reduzir movimento.

## O que mudou em relação ao original (Apache-2.0, seção 4b)

Em 2026-11-03, para o projeto Velivo (código `velvet`):

- Texto reescrito em português (pt-BR) e resumido. Não há cópia literal de arquivo inteiro. Algumas regras
  curtas foram traduzidas quase ao pé da letra; nesses pontos o texto diz "do original".
- **Fica de fora tudo o que executa ou fala com a rede**: o lançador `scripts/impeccable`, o binário que ele
  baixa, a telemetria (`impeccable.style/api/roll` e `/api/chosen`), a checagem de versão, o `npx impeccable`, os
  hooks (`SessionStart`, `PostToolUse`, `Stop`), o modo *live*, o `generate-image` (que chama a OpenAI), o
  `serve-question`, o `concept-seed`, os agentes empacotados e o frontmatter `allowed-tools`. Esta pasta não tem
  `scripts/`, hooks nem código.
- `PRODUCT.md` e `DESIGN.md` foram trocados pelas fontes que o repositório já tem: `CLAUDE.md`, `apps/web/CLAUDE.md`,
  `apps/mobile/CLAUDE.md`, `docs/modelo-de-produto.md`, `apps/web/src/styles.css`, `apps/mobile/src/theme.ts` e
  `docs/layout/`.
- O detector determinístico ("Assessment B") foi trocado pela medição da skill `taste-skill` deste repositório
  (`../taste-skill/referencia/medir.md`) e pelos testes que o projeto já roda: axe, contraste e orçamento de bundle.
- Os exemplos genéricos viraram telas, tokens e componentes da Velivo. Também entraram regras de precedência com
  `velvet-front`, `uplift-de-front` e `taste-skill`.

## Port para o GeraCRM (2026-11-05)

Esta pasta veio da adaptação Velivo descrita acima (repositório `Velvet`, `.claude/skills/impeccable`) e foi
reescrita para o console do GeraCRM. Continua sem script, binário, hook, telemetria ou chamada de rede.

- Superfícies, tokens e telas da Velivo trocados pelos do GeraCRM: `apps/console` (Angular 21), `apps/app`
  (Expo), `apps/catalogo` (SSR); tokens de `packages/design-tokens` (`--acao`, `--superficie*`, `--texto*`,
  `--borda*`, `--espacamento-*`, `--raio-*`, `--elevacao-*`) e as classes `.txt-*`.
- Tipografia Geist + Geist Mono no lugar de Manrope + Fraunces; a mono é permitida em dado (SKU, telefone,
  CNPJ, dinheiro). Acento azul só em ação, foco, seleção e link; turquesa é a assinatura (anel de 24h).
- Modos refeitos para o produto: Operar, Conversar, Ler e Preencher.
- **Decisão do dono (2026-11-05):** criar e editar usam modal (`ui-modal`, padrão M) por padrão. O veto
  "modal por reflexo" do original foi invertido: no GeraCRM o achado é o formulário inline no meio da lista.
- Precedência: `geracrm-layout-ui`, `geracrm-formularios`, `CLAUDE.md` e as ADRs vencem esta skill.
- Provas trocadas por `pnpm lint typecheck test`, `cor-literal.spec.ts` e `crase-em-template.spec.ts`.
