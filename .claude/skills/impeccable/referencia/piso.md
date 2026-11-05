# Piso de acabamento: leia antes de editar UI

Adaptado de `craft-floor.md` e `operate.md`, do Impeccable (Apache-2.0; ver `../NOTICE.md`). O piso cuida da
mecânica e nunca escolhe a direção. A direção é de `geracrm-layout-ui`.

## Conferir no resultado renderizado

- **Contraste.** Texto do corpo e placeholder ≥ 4,5:1; texto grande ≥ 3:1; ícone, borda de controle
  (`--borda-controle`) e anel de foco (`--borda-foco`) ≥ 3:1. **Nos dois temas** (`data-tema="claro"`/`"escuro"` e
  sem atributo, seguindo o SO).
- **Profundidade.** Borda antes de sombra. Sombra só no que flutua (`--elevacao-dropdown`, `--elevacao-modal`). No
  escuro, a profundidade vem do degrau `--fundo` → `--superficie` → `--superficie-elevada`, não de brilho.
- **Espaço.** Só `--espacamento-*`. Mais espaço acima de um título que abaixo. Proximidade antes de caixa.
- **Tipo.** Só `.txt-*`. Dado numérico ou identificador em `.txt-dados` (Geist Mono, `tabular-nums`). `text-wrap:
  balance` em título. Medida de leitura até `--largura-leitura` (640 px).
- **Movimento.** Só `--movimento-*`, só para estado. O anel da janela de 24h é a única coisa que anima sozinha.
- **Estados.** Os cinco de `geracrm-layout-ui` (carregando com esqueleto, vazio, erro, sem permissão, parcial) como
  ramos `@switch`, mais hover, foco do teclado, ativo e desabilitado que diz por quê.
- **Superfícies do navegador.** Anel de foco, barra de rolagem, seleção, `text-underline-offset`, algarismos
  tabulares.
- **Texto.** O controle diz a ação ("Bloquear", "Importar", "Adicionar e conversar"); o erro diz o problema e a saída.
- **Sem quebra.** `min-width: 0` (`.encolhe`) em filho de flex/grid com texto; conteúdo largo rola dentro da caixa
  (`.rolagem-x`); a página nunca rola na horizontal; nada sobrepõe nada de 320 px ao largo.

## Formulários: o padrão do GeraCRM (decisão do dono, 2026-11-05)

- **Criar e editar abre `ui-modal`** a partir do botão primário do cabeçalho (padrão M), com `ui-grade-form` de 2
  colunas, rótulo acima, rodapé `Cancelar` + um primário à direita. Abaixo de 720 px o modal vira tela cheia.
- **Formulário-página (F)** só quando o cadastro é longo e tem seções (contato completo, campanha em passos), com
  `ui-breadcrumb` e o mesmo rodapé.
- **Ação sobre um registro** (perder, transferir, agendar, bloquear) é modal de ação (A), nomeando o registro.
- **Achados (P1/P2):** formulário inline ou expansível no meio da lista; painel que empurra a lista para baixo;
  "cartão de criar" fixo acima da tabela; duas telas do mesmo tipo com jeitos diferentes de criar; modal sem
  `Cancelar`; modal com dados digitados que fecha sem perguntar; salvar automático numa tela e botão Salvar na vizinha.

## Recuse por padrão

- **Grade de cartões iguais** com ícone, título e texto. **Cartão dentro de cartão é sempre erro.**
- O molde "número-herói" e quatro KPI em cartão com ícone tingido. KPI é `ui-stat-card` num contêiner dividido.
- **Selo ou rótulo miúdo acima do título.** O título é substantivo ("Contatos", "Funil").
- Numeração de seção 01/02/03.
- Texto em degradê; vidro e desfoque decorativos.
- Borda lateral colorida maior que 1 px em cartão, item de lista ou aviso, **exceto** o acento do card do kanban
  (`--densidade-acento-lateral-card`).
- Sparkline, anel ou retângulo arredondado no lugar de conteúdo (o anel de 24h é dado, não enfeite).
- **Emoji ou caractere unicode como ícone.** Ícones Lucide por `ui-icone`, uma família.
- Cor literal (`#hex`, `rgb()`) em componente: o `cor-literal.spec.ts` quebra o build.
- Cor RFV sem rótulo ao lado.
- Azul pintando fundo, painel, item de menu ou ícone de enfeite.

## Proibido no modo Operar

- Movimento decorativo e coreografia de entrada.
- Componente inconsistente: "se o botão de salvar é diferente em dois lugares, um está errado" (do original).
- Duas telas para o mesmo trabalho, ou o mesmo dado com dois nomes no menu.
- Affordance reinventada: link que parece botão, botão que parece texto.
- Saturação forte em estado inativo; acento no cromo.

## Exceções do GeraCRM (decididas, não reabra no refino)

- Geist Mono em dado (SKU, telefone, CNPJ, protocolo, dinheiro).
- Turquesa no anel da janela de 24h e no "ao vivo"; o anel anima (24 h por volta, nunca pisca).
- O canal não-oficial do WhatsApp mostra o risco de banimento de forma visível (ADR-021); o aviso não é ruído.
- Degradação de ERP visível na interface (ADR-008): aviso de capacidade ausente fica.
- Alvo de clique do console: `--densidade-alvo-clique-console` (28 px), piso WCAG de 24 px; no toque, 44 px.
