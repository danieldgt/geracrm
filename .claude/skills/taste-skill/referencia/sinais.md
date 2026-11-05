# Sinais de tela gerada por IA, e o que vale no GeraCRM

Registro adaptado de `references/tells.md` e da seção 14 de `references/app-screens.md` da taste-skill (MIT; ver
`../SKILL.md`). Cada sinal vem com o que entra no lugar e o veredito para este repositório. Tirar o sinal e não pôr
nada no lugar também falha ("estética da evitação"): o espaço que sobra é do dado real.

## Telas do console

| Sinal | O que entra no lugar | No GeraCRM |
|---|---|---|
| Barra lateral tingida, com pílula azul e barra à esquerda no item atual | fundo neutro e um degrau `--superficie-selecionada` | vale |
| "Bem-vindo de volta, Daniel 👋" | título-substantivo em `.txt-titulo` | vale |
| Quatro cartões de KPI com ícone em círculo tingido | `ui-stat-card` em contêiner dividido | vale |
| Pílula verde "+12,5 %" em todo KPI | variação em palavras, com a janela; cinza no zero | vale |
| Sparkline em todo KPI | a tendência no gráfico, ou em lugar nenhum | vale |
| KPI de 48 px em negrito na cor da marca | `.txt-kpi` (32 px) na cor do texto | vale |
| Gráfico de área em degradê, curva suavizada | linha reta de 2 px | vale |
| Paleta arco-íris, um matiz por barra | um matiz por gráfico; RFV com `--rfv-*` e rótulo | vale |
| Cartão com borda de 1 px **e** sombra grande | borda ou degrau de tom; `--raio-painel` | vale |
| Tabela zebrada com selo, avatar e "⋯" em toda linha | réguas, um selo, uma ação | vale |
| Selo saturado com texto branco | `-suave` com texto do mesmo matiz | vale |
| Azul em todo botão, aba e link | azul na ação primária, no foco e na seleção | vale (ADR-012) |
| Exportar, Compartilhar e seletor de data em volta do título | ação só quando existe (`ui-botao-csv` em lista) | vale |
| Pessoa e empresa de mentira, total redondo | dado do tenant, no tamanho real | vale |
| Grade de 4 colunas fixa com célula órfã | colunas pelo número de itens | vale |
| Neon no escuro, borda que brilha | slate profundo (`neutro.900`), degrau de luminosidade | vale |
| Ícone colorido por categoria numa lista | uma família cinza; cor no estado | vale |
| Ilustração e "Nenhum dado ainda" num gráfico vazio | a linha do zero e uma frase com a próxima ação | vale |
| **Uma tela por recurso do backend no menu** ("Mensagens Enviadas", "Config. do Canal", "CRM Avançado") | uma tela por trabalho de quem usa; o resto vira aba, filtro ou visão | vale: é o sinal mais forte de produto montado por gerador |
| **Cada tela com um jeito de criar** (inline aqui, painel ali, página acolá) | `ui-modal` em todas (padrão M), página só para cadastro longo | vale (decisão do dono, 2026-11-05) |
| Descrição técnica no subtítulo ("RFV-10", "ADR-020", "MC-05", "O2") | o trabalho em palavras de quem usa | vale: código de requisito não é texto de interface |
| Mono em tudo como "cara técnica" | Geist Mono só em dado (SKU, telefone, CNPJ, dinheiro) | vale |

## Texto

Palavras que denunciam texto genérico: "desbloqueie", "sem atrito", "eleve", "potencialize", "robusto", "o futuro
do…", "não é só X, é Y". Botão "Saiba mais", "Comece agora", "Clique aqui". Travessão como cacoete. No GeraCRM, frase
curta, voz ativa, o botão diz o que faz, erro com saída, e nunca prova inventada.
