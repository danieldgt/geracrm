---
name: geracrm-formularios
description: >
  Formulários brasileiros e de cadastro no console GeraCRM: máscaras de CPF, CNPJ, telefone e CEP
  (grava só dígitos), dinheiro em centavos inteiros, consulta de CNPJ e CEP pela API (nunca pelo
  navegador), select estático × select paginado com opção injetada na edição, validação (cliente é
  conveniência, a API é a regra; erro 422 por campo vai para o campo), e listas no padrão L. Usar ao
  criar ou editar cadastro com documento, telefone, endereço ou valor (Contato, Produto, Campanha,
  Grupo), ao escolher um select, ou ao montar um formulário em apps/console. Complementa
  `geracrm-layout-ui` (padrões de tela e regras visuais) e `geracrm-console-angular` (signals, SSE).
---

# Formulários BR no console GeraCRM

Base: `compartilhado/ui/` (ver §5B de `docs/biblioteca-componentes.md`). Padrões de tela (F, M, A, C, L,
D) e a regra de rótulo visível estão em `geracrm-layout-ui`. Esta skill cobre o que acontece **dentro**
do formulário: o dado, a máscara, a validação e a lista de escolha.

## Blocos

| Preocupação | Use |
|---|---|
| CPF, CNPJ, CPF ou CNPJ, telefone, CEP | `ui-campo` com `mascara="cpf"` (ou `cnpj`, `cpfCnpj`, `telefone`, `cep`) |
| Campo cru de `<input>` sem `ui-campo` | diretiva `<input uiMascara="cpf" [formControl]="c">` |
| Dinheiro (BRL) | `ui-campo tipo="dinheiro"` — o valor do formulário é **centavos inteiros** |
| CNPJ e CEP com preenchimento automático | slot `[acao]` do `ui-campo` chamando a **API** (porta de consulta; ver abaixo) |
| UF e outras listas fixas e curtas | `ui-select` com `opcoes` |
| Vendedor, contato, produto, número, qualquer lista que cresce | `ui-select-paginado` com `carregar` |
| Validação do dado (CPF, CNPJ, telefone) | `validarCpf`, `validarCnpj`, `normalizarTelefone` de `@geracrm/shared` |

## Máscaras: exibem formatado, gravam só dígitos

- `mascara` (em `ui-campo`) e `uiMascara` (diretiva) formatam ao digitar. O **controle** recebe só dígitos:
  `"11144477735"`, não `"111.444.777-35"`.
- Os tipos são `cpf`, `cnpj`, `cpfCnpj` (escolhe CPF ou CNPJ pelo número de dígitos: até 11 vira CPF), `telefone` e `cep`.
- Funções puras em `mascaras.ts` (`formatarMascara`, `digitosDaMascara`); a diretiva e o `ui-campo` usam as mesmas.
- A máscara **não valida**. CPF de 11 dígitos com verificador errado passa pela tela. A regra é
  `validarCpf` / `validarCnpj` (`packages/shared`), e a API roda a mesma.
- Telefone: para validar e gravar, use `normalizarTelefone` (shared), que devolve o telefone normalizado ou
  `null`. Não grave o telefone formatado: o worker e a API comparam só dígitos.

> ⚠️ **Armadilha: telefone e documento formatados no payload.** `"(11) 98888-7777"` no corpo da requisição
> quebra a comparação com o WhatsApp e a busca por CPF. Quem envia é o `valor` do controle, que já vem em
> dígitos; não concatene nem reformate antes do `post`.

## Dinheiro em centavos inteiros

- `ui-campo tipo="dinheiro"` exibe `1.234,50` e entrega ao formulário `123450` (inteiro).
- Conversões em `console/compartilhado/ui/dinheiro.ts`: `reaisParaCentavos`, `centavosParaReais`, `formatarReais`.
  Para exibir um valor que já é centavos, use `formatarReais`; `centavosParaTexto` é o texto sem `R$`.
- Nunca `float` no payload (`45000.00`) nem texto (`"R$ 45.000,00"`). Dinheiro é inteiro em centavos
  de ponta a ponta (regra do `CLAUDE.md`; `geracrm-arquitetura`).

> ⚠️ **Armadilha: `tipo="dinheiro"` com valor que já vem em reais.** O CVA espera centavos. Se a tela carrega
> `45000` (reais) de uma API que devolve centavos, o campo mostra `450,00` sem erro. Confira a unidade do dado
> da API antes de ligar o campo.

## Consulta de CNPJ e CEP: pela API, nunca pelo navegador

- A consulta a serviço externo (BrasilAPI ou outro) **não** é feita pelo navegador. A tela chama uma rota
  da API, que é a porta de consulta do domínio, e a API chama o provedor. Motivos: CORS, cache, limite de
  uso e a regra de que o navegador não guarda chave nem depende de serviço de terceiro.
- A porta existe (`apps/api/src/contexts/crm/consulta-externa.ts`, rotas em `rotas-consultas.ts`):
  `GET /v1/consultas/cnpj/:cnpj` e `GET /v1/consultas/cep/:cep`. Fornecedor fora → 503
  `consulta.indisponivel`; não achou → 404 `consulta.nao_encontrado`; documento inválido → 422 por campo.
  Exemplo pronto: `funcionalidades/crm/contato-form.pagina.ts` (botão "Consultar" no `[acao]` do CNPJ e
  CEP consultado ao sair do campo). Mostre carregando, não encontrado e falha no próprio campo.

## Select: estático ou paginado

| Lista | Componente |
|---|---|
| Fixa, curta, não cresce (UF, status, perfil, forma de pagamento) | `ui-select` com `opcoes: { valor, rotulo }[]` |
| Vem do servidor ou pode crescer (vendedor, contato, produto, campanha) | `ui-select-paginado` com `carregar` |
| Depende de outro campo (vendedor da unidade) | dois campos; o segundo recarrega com o filtro do primeiro |

- `carregar(cursor, termo)` é por **cursor** (CLAUDE.md proíbe offset): `cursor` é `null` na primeira chamada e devolve `{ itens, proximoCursor }`; `proximoCursor: null` encerra.
- Filtre sempre por ativo nas listas operacionais; inativo só em telas de administração.
- Valor de `ui-select` vazio vira `null` no formulário: a obrigatoriedade é checada por `null`.

> ⚠️ **Armadilha: `opcaoInjetada` é obrigatória na edição.** O select só conhece o rótulo da página carregada.
> Sem a opção salva, a edição abre **vazia** (não mostra o id nem o placeholder) e o usuário acha que não
> salvou. Monte `opcaoInjetada` com o `valor` e o `rotulo` que a própria resposta do GET já traz (nome do
> vendedor, nome do produto), sem chamada extra. Não se aplica a filtro de listagem nem a formulário só de
> criação.

> ⚠️ **Armadilha: busca no cliente sobre lista paginada.** Se o select carregou 10 de 1.204 e filtra no
> cliente, responde "nada encontrado" para um registro que existe. Busca é sempre no servidor, com debounce.

## Validação

- **Cliente é conveniência; a API é a regra.** Validação de tela evita a ida ao servidor; quem decide é o
  schema de `packages/shared` (Zod), o mesmo que a API usa.
- **Erro aparece no blur e some na digitação.** Validar a cada tecla acusa o usuário antes de ele terminar.
  No submit, valide tudo, marque todos os campos como tocados e leve o foco ao primeiro com erro.
- **Não desabilite o botão primário por formulário inválido.** O usuário não sabe por que o botão está
  apagado. Deixe clicar, mostre o erro no campo e o foco no primeiro (diferente da regra do AM, que desabilita).
- **Erro 422 vai para o campo.** O corpo tipificado da API é `{ erro, mensagem?, campos? }` (`ErroApi` em
  `compartilhado/ui/erro-http.ts`). `campos` lista os nomes dos campos que falharam: aplique `mensagem` no
  `erro` de cada um. Use `corpoDoErro(e)` para ler o corpo e `mensagemDeErro(e, padrao)` para o texto.
  Erro sem campo certo: texto inline no corpo do formulário, com a ação corretiva.
- **Mensagem diz o que fazer.** "Informe um CPF válido com 11 dígitos", não "Campo inválido".
- **Toast só no sucesso.** O erro de salvamento fica no formulário; o toast de "Salvo" é o único toast.

> ⚠️ **Armadilha: 422 engolido por toast genérico.** Um `toast.error('Erro ao salvar')` esconde a mensagem
> que a API escreveu e deixa o campo errado parecer certo. Leia `campos` e aplique no campo.

## Listas (padrão L)

- Cabeçalho com a ação primária à direita; `ui-filtros` (busca com debounce de 300 ms e os controles
  projetados); `ui-tabela`; `ui-paginacao` ("Carregar mais", por cursor).
- **Filtro que muda zera o cursor.** Busca, aplicar e qualquer controle de filtro voltam ao início. O
  componente não sabe da lista; quem chama é que zera.
- `@for` sempre com `track` pela chave estável (`id`), nunca `$index` em linha de dado.
- Seleção: `selecionados` (Set de ids) e `ui-acoes-lote` com a quantidade. A seleção **não sobrevive** a
  mudança de filtro ou de página: zere ao trocar.
- Coluna de identificador ou valor (CPF, CNPJ, telefone, dinheiro, código): `mono: true` na coluna, para
  alinhar e não quebrar a linha.
- Exportar CSV (`ui-botao-csv`) exporta as linhas **carregadas**; diga isso no rótulo ou na dica.
- Listas nunca sem cursor. `OFFSET` profundo e lista ilimitada estão proibidos (ADR de paginação).

## Escrita e tokens

- Sem Tailwind e sem Font Awesome. Estilo com tokens (`var(--espacamento-*)`, `var(--acao)`, `var(--borda)`),
  tamanho com `.txt-*` e ícone com `ui-icone` (Lucide local, nome em kebab-case).
- Cor literal (`#hex`, `rgb()`) em componente quebra `cor-literal.spec.ts`.
- Voz ativa no botão: "Salvar contato", "Consultar CNPJ". O botão de salvar mantém o nome até o fim.

## Armadilhas

- **Crase em template.** `template:` e `styles:` são template literals. Uma crase dentro de comentário HTML
  ou CSS fecha o literal, e o erro (`NG1002`) não aponta a crase. Teste: `crase-em-template.spec.ts`.
- **`aria-label` em campo com rótulo visível.** Substitui o texto que a pessoa lê. Não ponha `aria-label` em
  `ui-campo` nem em `ui-select`: o `rotulo` já é o nome. Nem na busca de `ui-filtros`, que tem rótulo visível.
- **Atributo sem valor em input booleano.** `<ui-campo obrigatorio>` não liga; use `[obrigatorio]="true"`.
- **Máscara sem a diretiva ou o input.** `ui-campo` sem `mascara` digita sem formatar, sem erro visível.
- **Dinheiro como string ou float no payload.** Centavos inteiros.
- **Telefone ou CPF formatados no payload.** Dígitos.
- **Opção injetada esquecida na edição.** O campo abre vazio.
- **Consulta de CNPJ ou CEP direto no navegador.** Vai pela API.
- **Select estático para lista que cresce.** Use `ui-select-paginado`.

## Antes de dar por pronto

- [ ] Todo campo com rótulo visível; obrigatórios com `[obrigatorio]="true"`.
- [ ] Máscaras em CPF, CNPJ, telefone e CEP gravam só dígitos; dinheiro grava centavos.
- [ ] Select de lista que cresce é paginado; na edição, `opcaoInjetada` preenchida.
- [ ] Erro 422 aplicado no campo; toast só no sucesso.
- [ ] Lista com cursor, `track` por id, filtro zera o cursor, seleção zera ao filtrar.
- [ ] Testes de spec do formulário verdes (`pnpm --filter @geracrm/console test`) e `pnpm lint typecheck test` verde.
