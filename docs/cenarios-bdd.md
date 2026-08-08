# GeraCRM — Cenários BDD (Ondas 0 e 1)

> **O que este documento é:** os critérios de aceite executáveis das Ondas 0 e 1, escritos como
> cenários Gherkin em português. **O cenário BDD *é* o critério de aceite** — não existe um segundo
> documento de "critérios de aceite" a manter em paralelo.
>
> **Deriva de:** [`modelo-de-dados.md`](./modelo-de-dados.md) (invariantes INV-01…INV-60) ·
> [`escopo-funcional-geracrm.md`](./escopo-funcional-geracrm.md) (IDs) ·
> [`backlog-epicos-geracrm.md`](./backlog-epicos-geracrm.md) (épicos e ondas) ·
> [`especificacao-telas.md`](./especificacao-telas.md) · [`decisoes.md`](./decisoes.md) (ADRs).

---

## 0. Como ler

| Convenção | Significado |
|---|---|
| `Funcionalidade` | Uma capacidade de negócio. Traz épico (**EP-xx**), requisitos (**IDs**) e onda |
| `Regra` | Uma regra de negócio, com a invariante que ela protege (**INV-xx**) |
| `Cenário` | Um exemplo concreto. **Exatamente um `Quando`** |
| `Esquema do Cenário` | A mesma regra com vários dados — sempre incluindo a **fronteira** |
| ⚠️ | Armadilha real: o cenário existe porque alguém já errou aqui |

**Regras de escrita respeitadas em todo o documento** (skill `bdd`):

- Nenhum cenário menciona botão, endpoint, tabela, índice, HTTP ou nome de biblioteca. Se um cenário
  quebrar numa refatoração de interface, ele está errado.
- Um `Quando` por cenário. Se aparecerem dois, ou são dois cenários, ou o primeiro era contexto.
- Dados concretos: nomes, CNPJs, telefones, SKUs e valores reais de atacado de moda.
- **Toda invariante do modelo tem pelo menos um cenário que tenta violá-la e espera falha.**

### 0.1 Escopo de ondas

O corpo do documento é das **Ondas 0 e 1**. Três blocos de onda posterior entram mesmo assim, porque
a cobertura obrigatória os exige e porque **a invariante nasce na Onda 0**, no contrato do conector e
do gateway de envio — não na onda em que a tela aparece:

| Bloco | Onda da tela | Por que está aqui |
|---|---|---|
| §8 Pedido assistido | 2 | INT-01b/INT-01c são **Onda 0**; PED-08 decide se o módulo é usado ou abandonado |
| §4 Opt-out e bloqueio | 1 (toggles) / 3 (campanha) | O opt-out é gravado na Onda 1 e precisa ser respeitado por **todo** caminho de envio que existir depois |
| §7 Throttling e quota | 3 (campanha) | O gateway de envio é único desde a Onda 0; o 1-a-1 já passa por ele |

### 0.2 Glossário (linguagem ubíqua — os termos do cenário são os termos do código)

| Termo do negócio | Significado |
|---|---|
| **Empresa** | O cliente contratante — a fronteira de isolamento (`tenant`). Nunca "conta", nunca "organização" |
| **Filial** | Unidade da empresa. Números, usuários e contatos pertencem a filiais |
| **Contato** | O cliente da empresa (lojista). Tem N telefones, N documentos, N nomes |
| **Contato-lead** | Contato criado automaticamente quando um número desconhecido manda a primeira mensagem |
| **Conversa** | O fio permanente com um contato num canal |
| **Atendimento** | O episódio — abre quando alguém assume, fecha quando encerra. Tem protocolo |
| **Janela de atendimento** | As 24 h contadas da última mensagem **do cliente**. Fechada = só template |
| **Número** | Um WhatsApp da frota, de uma vendedora, numa filial |
| **Rascunho de pedido** | O pedido montado na conversa. É nosso |
| **Efetivação** | O ERP aceita o pedido e devolve número. É dele |
| **Versão de conteúdo** | Muda a cada alteração de item, quantidade ou condição do rascunho |
| **Cobertura de dados** | O intervalo de tempo que uma conexão de ERP realmente importou |
| **Lista de bloqueio** | Telefones da empresa que não recebem envio, mesmo sem contato cadastrado |

#### ⚠️ Termos de transição — as palavras que significavam duas coisas

Cada linha abaixo é uma palavra que, em documentos escritos na mesma semana, nomeava **dois eventos
diferentes**. É o defeito mais barato de corrigir hoje e o mais caro depois, porque ele entra no
código: um marco de banco chamado `virada_onda1` que significa três coisas produz três consultas
corretas e três respostas diferentes.

| Termo **correto** | Significa exatamente | ⚠️ Não confundir com |
|---|---|---|
| **Medição do antes** (ADR-017) | 2 semanas medindo **o sistema antigo**, à mão, **encerrando antes de a equipe saber da mudança** — âncora é o anúncio, não a sigla de cronograma. Produz LB-10, LB-11 e LB-12, que **não são reconstituíveis** | **Piloto paralelo** (M1.6 da Onda 1): 2 vendedoras **usando o GeraCRM** em paralelo por 1 semana. São operações **opostas** — medir o velho × usar o novo |
| **`ENS-1` / `ENS-2`** | Os dois **ensaios de carga**: ENS-1 em T-4 (homologação, mede duração e acha DIV), ENS-2 em T-1 (produção, carga completa) | **`E1-xx` / `E2-xx`**: prefixo de **tarefa por épico** no `plano-onda-0.md` (`E1-01` = EP-01, `E2-16` = EP-02). ⚠️ *"E2 depende de E2-07"* tinha duas leituras corretas |
| **`primeiro_corte`** | O **primeiro** número do cliente apontando para o GeraCRM (`T` / `D-0`). É o instante em que a janela de sombra fecha para sempre | **`ultimo_corte`** (frota inteira conectada) e **`abandono_sistema_antigo`** (contrato antigo encerrado — ⚠️ nunca antes de D+30 do último lote). Os três eram "a virada" |
| **`linha_base_congelada`** | O marco de congelar a régua. ⚠️ **Sempre antes de `primeiro_corte`** — uma régua congelada depois do evento que ela mede não é régua | — |
| **Conciliação** | Comparar o CRM **contra o ERP** (RC-01…RC-10, códigos DIV). Prova o que **faltou** trazer | **Reconciliação** (INV-57): contadores **internos** batendo entre si. ⚠️ Fecha perfeitamente numa carga que trouxe 60% das vendas. As duas palavras andam **sempre juntas** no critério de saída da Onda 0 |

### 0.3 Personagens e dados fixos

```
EMPRESAS (tenants)
  Malharia Aurora        — filiais: Matriz (Recife), Showroom (Caruaru)
  Confecção Boa Vista    — a outra empresa; nunca deve enxergar nada da Aurora

USUÁRIOS (Malharia Aurora)
  Rafael    gestor       escopo empresa
  Sônia     supervisora  filial Matriz
  Eduarda   vendedora    número +55 81 99100-0001 · carteira com Vest Fácil
  Karine    vendedora    número +55 81 99100-0002 · carteira com Loja da Ju
  Ale       atendente    sem carteira, atende pela fila

CONTATOS (Malharia Aurora)
  Vest Fácil Modas LTDA   CNPJ 12.345.678/0001-90 · +55 81 99861-7049 (principal)
  Loja da Ju              CNPJ 98.765.432/0001-10 · +55 11 95654-3016 (principal)
  Saturno Modas           CNPJ 55.444.333/0001-22 · +55 81 99777-1234 (principal)

PRODUTOS
  22625 CONJUNTO LAILA   grade P38·M40·G42 × cores ROSA·VERDE   R$ 146,00
  08825 CONJUNTO KARINE  grade M40                              R$ 115,00
```

---

## 1. Isolamento por empresa e autorização

**Épico:** EP-01 · **Requisitos:** PLT-02, PLT-03 · **Onda:** 0
**Invariantes:** INV-01, INV-02, INV-03, INV-04, INV-34, INV-59

```gherkin
Funcionalidade: Isolamento por empresa e autorização

  Contexto:
    Dado que existem as empresas "Malharia Aurora" e "Confecção Boa Vista"
    E "Malharia Aurora" tem o contato "Vest Fácil Modas LTDA"
    E "Confecção Boa Vista" tem o contato "Ateliê Pituba"

  @INV-01
  Regra: nenhuma leitura nem escrita alcança dado de outra empresa (INV-01)

    Cenário: usuário de outra empresa não alcança um contato existente nem sabendo o identificador
      Dado que Bruna está autenticada em "Confecção Boa Vista"
      E ela recebeu de um colega o identificador do contato "Vest Fácil Modas LTDA"
      Quando ela abre a ficha por esse identificador
      Então a ficha não é encontrada
      E a resposta é a mesma que ela receberia para um identificador inexistente

    Cenário: busca por CNPJ só devolve o que é da própria empresa
      Dado que Bruna está autenticada em "Confecção Boa Vista"
      E o CNPJ "12.345.678/0001-90" existe apenas em "Malharia Aurora"
      Quando ela busca por "12.345.678/0001-90"
      Então nenhum resultado é apresentado

    Cenário: alteração dirigida a contato de outra empresa não acontece
      Dado que Bruna está autenticada em "Confecção Boa Vista"
      Quando ela tenta desativar o recebimento de campanhas do contato "Vest Fácil Modas LTDA"
      Então a alteração é recusada
      E "Vest Fácil Modas LTDA" continua recebendo campanhas em "Malharia Aurora"

  ⚠️ A terceira é a que importa: leitura bloqueada e escrita liberada é o furo clássico de quem
  protege isolamento na tela em vez de na camada de dados.

  @INV-02
  Regra: a empresa vem sempre da sessão autenticada, nunca de campo informado (INV-02)

    Cenário: carga de clientes que declara outra empresa como destino é recusada
      Dado que a integração de "Malharia Aurora" está autenticada com o token dela
      E o arquivo de carga declara "Confecção Boa Vista" como empresa de destino
      Quando a carga é submetida
      Então a carga é recusada como inválida
      E nenhum cliente é criado em nenhuma das duas empresas

  @INV-03
  Regra: unicidade é sempre dentro da empresa, nunca global (INV-03)

    Cenário: duas empresas cadastram o mesmo CNPJ e ambas conseguem
      Dado que "Malharia Aurora" já tem o contato com CNPJ "12.345.678/0001-90"
      Quando "Confecção Boa Vista" cadastra um contato com o CNPJ "12.345.678/0001-90"
      Então o cadastro é aceito
      E cada empresa enxerga apenas o seu contato

    Cenário: a mesma empresa não cadastra o mesmo CNPJ duas vezes
      Dado que "Malharia Aurora" já tem o contato "Vest Fácil Modas LTDA" com CNPJ "12.345.678/0001-90"
      Quando Rafael cadastra outro contato com o CNPJ "12.345.678/0001-90"
      Então o cadastro é recusado por duplicidade
      E a ficha existente é oferecida para edição

  ⚠️ Unicidade global de CNPJ impede o segundo cliente do produto de cadastrar um lojista que o
  primeiro já atende — e no atacado de polo os dois atendem os mesmos lojistas.

  @INV-04
  Regra: nada se vincula a algo de outra empresa (INV-04)

    Cenário: vincular pedido de uma empresa a contato de outra falha
      Dado que existe um rascunho de pedido em "Malharia Aurora"
      Quando a integração tenta vincular esse rascunho ao contato "Ateliê Pituba", de "Confecção Boa Vista"
      Então a operação falha
      E o rascunho permanece vinculado ao contato original

  @INV-34 @INV-59
  Regra: quem vê o quê é decidido por papel na filial, em um lugar só (INV-34, INV-59)

    Esquema do Cenário: visibilidade de conversa por papel
      Dado que a conversa com "Vest Fácil Modas LTDA" chegou no número de Eduarda, da filial Matriz
      E "Vest Fácil Modas LTDA" está na carteira de Eduarda
      Quando <quem> abre a caixa de entrada
      Então a conversa <aparece ou não>

      Exemplos:
        | quem                                      | aparece ou não |
        | Rafael, gestor da empresa                 | aparece        |
        | Sônia, supervisora da filial Matriz       | aparece        |
        | Sônia, supervisora apenas do Showroom     | não aparece    |
        | Eduarda, dona do número e da carteira     | aparece        |
        | Karine, vendedora de outro número         | não aparece    |
        | Ale, atendente sem carteira e sem número  | não aparece    |

    Cenário: mensagem que chega no meu número, de cliente da carteira da colega, tem dono
      Dado que "Loja da Ju" está na carteira de Karine
      Quando "Loja da Ju" manda mensagem para o número de Eduarda
      Então a conversa aparece para Eduarda
      E continua aparecendo para Karine
      Mas o dono de carteira de "Loja da Ju" continua sendo apenas Karine

    Cenário: o mesmo usuário tem papéis diferentes em filiais diferentes
      Dado que Sônia é gestora na Matriz e vendedora no Showroom
      Quando ela abre a lista de contatos do Showroom
      Então ela vê apenas os contatos da carteira dela no Showroom
      Mas na Matriz ela continua vendo todos os contatos da filial

  ⚠️ É **disjunção** no nível do vendedor, e isso é decisão: sem ela, a mensagem que chega no meu
  número sobre cliente da colega fica invisível para todo mundo. A exclusividade da carteira é mantida
  por INV-32 (um dono), não por invisibilidade.
```

---

## 2. Notificação em tempo real

**Épico:** EP-05, EP-07 · **Requisitos:** INB-01, PLT-07 · **Onda:** 1 · **ADR-007**
**Invariantes:** INV-05, INV-40

```gherkin
Funcionalidade: Notificação em tempo real de conversa

  Contexto:
    Dado que Eduarda está com a caixa de entrada aberta em "Malharia Aurora"
    E Bruna está com a caixa de entrada aberta em "Confecção Boa Vista"

  @INV-05
  Regra: notificação de uma empresa nunca chega a usuário de outra (INV-05)

    Cenário: mensagem nova de uma empresa não notifica ninguém da outra
      Dado que "Vest Fácil Modas LTDA" tem conversa em "Malharia Aurora"
      Quando "Vest Fácil Modas LTDA" manda "chegou a coleção nova?"
      Então Eduarda recebe a notificação da conversa
      E Bruna não recebe notificação alguma

    Cenário: assinar a conversa de outra empresa não entrega nada
      Dado que Bruna descobriu o identificador da conversa de "Vest Fácil Modas LTDA"
      Quando ela pede para acompanhar essa conversa em tempo real
      Então a assinatura é recusada
      E nenhuma notificação daquela conversa chega até ela

  @INV-05
  Regra: a notificação nunca carrega conteúdo (INV-05)

    Cenário: a notificação anuncia a mudança, não a mensagem
      Dado que "Vest Fácil Modas LTDA" mandou "vou fechar 6 peças do 22625"
      Quando a notificação chega ao navegador de Eduarda
      Então ela informa apenas qual conversa mudou e em que versão
      E o texto "vou fechar 6 peças do 22625" não está na notificação
      E o conteúdo só aparece depois de ser buscado com a sessão autenticada de Eduarda

  ⚠️ É esta regra que transforma um erro de roteamento em não-evento: mesmo que a notificação erre o
  alvo, o intruso recebe um identificador que a consulta dele não resolve.

  @INV-05 @INV-34
  Regra: a permissão é revalidada a cada assinatura, não só no login (INV-05, INV-34)

    Cenário: permissão revogada durante a sessão interrompe a entrega
      Dado que Ale está acompanhando em tempo real a conversa com "Saturno Modas"
      E Rafael remove o acesso de Ale à filial Matriz
      Quando chega uma mensagem nova de "Saturno Modas"
      Então Ale deixa de receber notificações dessa conversa
      E a conversa sai da tela dela sem que ela precise recarregar
      E ela não precisa fazer login de novo para o restante do trabalho dela continuar

    Cenário: contato transferido de carteira para de notificar o dono antigo
      Dado que "Loja da Ju" estava na carteira de Karine e foi transferido para Eduarda
      E Karine continua com a sessão aberta
      Quando "Loja da Ju" manda mensagem para um número que não é o de Karine
      Então Eduarda recebe a notificação
      E Karine não recebe

  @INV-40
  Regra: a notificação só sai depois que o dado está gravado (INV-40)

    Cenário: falha ao gravar a mensagem não emite notificação
      Dado que uma mensagem de "Vest Fácil Modas LTDA" está sendo processada
      Quando a gravação falha antes de concluir
      Então nenhuma notificação de conversa é emitida
      E a conversa de Eduarda não é marcada como tendo mensagem nova

    Cenário: reconexão não perde nem repete evento
      Dado que Eduarda ficou 40 segundos sem conexão
      E nesse intervalo chegaram 3 mensagens em 2 conversas dela
      Quando a conexão dela é restabelecida informando a última versão que ela tinha
      Então as 2 conversas aparecem atualizadas
      E nenhuma conversa é contada duas vezes como não lida
```

---

## 3. Cadastro unificado de contato

**Épico:** EP-04 · **Requisitos:** CTT-01…CTT-04, CTT-10 · **Onda:** 0
**Invariantes:** INV-06, INV-07, INV-08, INV-09, INV-10, INV-11, INV-12, INV-49

```gherkin
Funcionalidade: Cadastro unificado de contato

  @INV-06
  Regra: telefone é sempre guardado na forma canônica da casa (INV-06)

    Esquema do Cenário: formatos diferentes viram o mesmo telefone
      Dado que "Malharia Aurora" tem país padrão Brasil
      Quando o telefone é cadastrado como "<digitado>"
      Então ele é guardado como "+5581998617049"
      E a forma original "<digitado>" fica preservada para auditoria

      Exemplos:
        | digitado          |
        | +55 81 99861-7049 |
        | 5581998617049     |
        | 81998617049       |
        | (81) 9861-7049    |
        | 81 9861 7049      |

    Cenário: telefone impossível não entra
      Quando a carga do ERP traz o telefone "81 3"
      Então o telefone não é gravado
      E o contato é criado sem telefone, com pendência de qualidade cadastral registrada

    Cenário: a forma que a Meta devolve não vira a forma canônica
      Dado que "Vest Fácil Modas LTDA" tem o telefone canônico "+5581998617049"
      Quando chega uma mensagem cujo identificador de remetente é "+558198617049"
      Então a mensagem é ligada a "Vest Fácil Modas LTDA"
      E o telefone canônico do contato continua "+5581998617049"
      E a forma de envio "+558198617049" é registrada como a forma usada pelo canal

  ⚠️ No Brasil o identificador que a Meta devolve costuma vir **sem o nono dígito**. Deixar essa
  forma virar a canônica foi a origem do bug de opt-out da §4 — não a solução dele.

  @INV-07 @INV-49
  Regra: um telefone principal pertence a no máximo um contato (INV-07, INV-49)

    Cenário: cadastrar o mesmo telefone como principal em dois contatos falha
      Dado que "+5581998617049" é o telefone principal de "Vest Fácil Modas LTDA"
      Quando Rafael cadastra "+5581998617049" como principal de "Vest Fácil Filial Norte"
      Então o cadastro é recusado
      E a tela informa que o telefone já é principal de "Vest Fácil Modas LTDA"

    Cenário: o mesmo telefone pode ser secundário em vários contatos
      Dado que "+5581998617049" é principal de "Vest Fácil Modas LTDA"
      Quando Rafael acrescenta "+5581998617049" como telefone secundário de "Vest Fácil Filial Norte"
      Então o cadastro é aceito
      E "Vest Fácil Filial Norte" passa a ter esse telefone marcado como secundário

    Cenário: colisão de telefone principal na carga do ERP não derruba o lote nem funde clientes
      Dado que "+5581998617049" é principal de "Vest Fácil Modas LTDA"
      E a carga do ERP traz "Vest Fácil Filial Norte" com o mesmo telefone
      Quando a carga é processada
      Então "Vest Fácil Filial Norte" é criado com o telefone como secundário
      E um conflito de identidade é aberto para conferência humana
      E o restante do lote é processado normalmente
      E os históricos de compra dos dois contatos permanecem separados

  ⚠️ Fundir dois clientes por telefone é irreversível na prática: mistura histórico de compra e
  corrompe o RFV dos dois. Criar duplicado é reversível. A assimetria é deliberada.

  @INV-49
  Regra: a conversa entrante tem dono determinístico (INV-49)

    Cenário: mensagem de telefone que é secundário em outro contato vai para o dono do principal
      Dado que "+5581998617049" é principal de "Vest Fácil Modas LTDA" e secundário de "Vest Fácil Filial Norte"
      Quando chega uma mensagem de "+5581998617049"
      Então a conversa é ligada a "Vest Fácil Modas LTDA"
      E nenhuma conversa é criada para "Vest Fácil Filial Norte"

  @INV-08
  Regra: um padrão de cada tipo por contato — mas vários valores (INV-08)

    Cenário: marcar um segundo endereço de entrega como padrão desmarca o anterior
      Dado que "Vest Fácil Modas LTDA" tem os endereços "Rua do Sol, 120" (padrão) e "Av. Recife, 900"
      Quando Rafael marca "Av. Recife, 900" como endereço de entrega padrão
      Então "Av. Recife, 900" passa a ser o padrão
      E "Rua do Sol, 120" continua cadastrado, sem ser padrão

    Cenário: dois documentos fiscais padrão ao mesmo tempo é recusado
      Dado que "Vest Fácil Modas LTDA" tem o CNPJ "12.345.678/0001-90" como documento fiscal padrão
      Quando a carga do ERP tenta marcar o CNPJ "12.345.678/0002-71" também como padrão, sem desmarcar o primeiro
      Então a operação é recusada
      E o documento fiscal padrão continua sendo "12.345.678/0001-90"

  @INV-09
  Regra: um cliente do ERP corresponde a no máximo um contato (INV-09)

    Cenário: dois contatos apontando para o mesmo cliente do ERP é recusado
      Dado que o cliente "4471" do GeraCloud corresponde a "Vest Fácil Modas LTDA"
      Quando Rafael tenta apontar o contato "Loja da Ju" para o mesmo cliente "4471" do GeraCloud
      Então a operação é recusada
      E "Vest Fácil Modas LTDA" continua sendo o contato do cliente "4471"

  @INV-10
  Regra: fonte de menor precedência acrescenta, nunca sobrescreve (INV-10)

    Cenário: o nome que vem do WhatsApp não apaga o nome do ERP fiscal
      Dado que "Vest Fácil Modas LTDA" tem razão social vinda do ERP fiscal
      E o perfil do WhatsApp desse contato se chama "Vest Fácil 💛"
      Quando a primeira mensagem dele é recebida
      Então a razão social continua "Vest Fácil Modas LTDA"
      E "Vest Fácil 💛" passa a existir como nome alternativo do contato

    Cenário: ERP secundário não sobrescreve cidade escrita à mão
      Dado que Rafael corrigiu a cidade de "Loja da Ju" para "São Paulo" manualmente
      Quando a carga do ERP secundário traz a cidade "Guarulhos" para esse contato
      Então a cidade continua "São Paulo"
      E fica registrado que a carga tentou alterar, com o valor recusado e a origem

  ⚠️ Este par de cenários responde à pergunta que sempre aparece no segundo mês de integração:
  *"por que o nome do cliente mudou sozinho?"*.

  @INV-11
  Regra: contato mesclado nunca é apagado (INV-11)

    Cenário: link antigo para o contato perdedor continua funcionando
      Dado que "Vest Fácil Filial Norte" foi mesclado em "Vest Fácil Modas LTDA" por Rafael
      Quando Karine abre um link antigo que aponta para "Vest Fácil Filial Norte"
      Então a ficha de "Vest Fácil Modas LTDA" é apresentada
      E é informado que o contato foi mesclado, por quem e quando

    Cenário: apagar contato mesclado é recusado
      Dado que "Vest Fácil Filial Norte" foi mesclado em "Vest Fácil Modas LTDA"
      Quando Rafael tenta excluir "Vest Fácil Filial Norte"
      Então a exclusão é recusada
      E é oferecida a opção de desfazer a mesclagem

    Cenário: opt-out do perdedor prevalece na mesclagem
      Dado que "Vest Fácil Filial Norte" tinha o recebimento de campanhas desativado
      E "Vest Fácil Modas LTDA" tinha o recebimento de campanhas ativado
      Quando Rafael mescla "Vest Fácil Filial Norte" em "Vest Fácil Modas LTDA"
      Então "Vest Fácil Modas LTDA" fica com o recebimento de campanhas desativado

  @INV-12
  Regra: toda conversa tem contato (INV-12)

    Cenário: número desconhecido vira contato-lead na primeira mensagem
      Dado que "+5581988887777" não existe em "Malharia Aurora"
      Quando chega uma mensagem desse número no número de Eduarda
      Então um contato-lead é criado com esse telefone como principal
      E a conversa já nasce ligada a esse contato
      E o contato-lead aparece imediatamente na base para funil, tarefa e campanha

    Cenário: falha ao criar o contato não deixa mensagem órfã
      Dado que "+5581988887777" não existe em "Malharia Aurora"
      E a criação do contato-lead falhará
      Quando chega uma mensagem desse número
      Então nenhuma mensagem é gravada sem contato
      E o recebimento é reprocessado depois
```

---

## 4. Opt-out, lista de bloqueio e consentimento

**Épico:** EP-04, EP-17 · **Requisitos:** CTT-08, CTT-15, CMP-10, CMP-14 · **Onda:** 1 (preferências) / 3 (campanha)
**Invariantes:** INV-13, INV-14, INV-15, INV-16, INV-50

```gherkin
Funcionalidade: Opt-out, lista de bloqueio e consentimento

  Contexto:
    Dado que o contato "Saturno Modas" desativou o recebimento de campanhas em 12/03/2026
    E "Saturno Modas" continua com o recebimento de automações ativado

  @INV-13
  Regra: contato em opt-out não recebe campanha por caminho nenhum (INV-13)

    Esquema do Cenário: nenhum caminho de disparo entrega a quem pediu para sair
      Dado que "Saturno Modas" está no público bruto do disparo
      Quando o disparo acontece por "<caminho>"
      Então "Saturno Modas" não recebe a mensagem
      E ele é registrado como "bloqueado por opt-out" no relatório

      Exemplos:
        | caminho                                         |
        | campanha por segmento RFV                       |
        | campanha por lista importada de planilha        |
        | disparo manual em lote com a base inteira selecionada |
        | reenvio das falhas de uma campanha anterior     |
        | cadência automática de recompra                 |
        | automação disparada por mudança de etapa do funil |
        | envio pela integração pública da empresa        |

    Cenário: disparo manual em lote seleciona todos e mesmo assim não entrega
      Dado que Rafael selecionou os 4.312 contatos da base para um disparo manual
      E 87 deles desativaram o recebimento de campanhas
      Quando ele confirma o disparo
      Então 4.225 mensagens são enfileiradas
      E os 87 aparecem no relatório como "bloqueado por opt-out"
      E nenhuma mensagem sai para eles nem depois, em retentativa

    Cenário: opt-out registrado durante o disparo interrompe o envio pendente
      Dado que uma campanha com 900 destinatários está em andamento
      E "Saturno Modas" ainda não recebeu a mensagem dessa campanha
      Quando ele responde "PARAR" em outra conversa e o opt-out é registrado
      Então a mensagem pendente dele não é enviada
      E ele passa a constar como "bloqueado por opt-out" no relatório da campanha

  ⚠️ Há muitos caminhos até um envio e **um esquecimento basta** para o cliente receber mensagem
  depois de pedir para sair. Por isso a regra vale na camada de saída, não em cada chamador.

  @INV-14
  Regra: campanha e automação são preferências independentes (INV-14)

    Esquema do Cenário: as duas preferências não se contaminam
      Dado que "Saturno Modas" tem campanhas "<campanhas>" e automações "<automacoes>"
      Quando o sistema tenta enviar uma mensagem de "<tipo>"
      Então o envio "<resultado>"

      Exemplos:
        | campanhas | automacoes | tipo      | resultado   |
        | ativado   | ativado    | campanha  | acontece    |
        | ativado   | ativado    | automação | acontece    |
        | desativado| ativado    | campanha  | é bloqueado |
        | desativado| ativado    | automação | acontece    |
        | ativado   | desativado | campanha  | acontece    |
        | ativado   | desativado | automação | é bloqueado |

    Cenário: desativar campanhas não desativa automações
      Dado que "Loja da Ju" tem as duas preferências ativadas
      Quando Karine desativa o recebimento de campanhas de "Loja da Ju"
      Então o recebimento de automações continua ativado

  @INV-15 @INV-50
  Regra: telefone na lista de bloqueio não recebe envio, mesmo sem cadastro (INV-15)

    Cenário: telefone bloqueado sem contato cadastrado não recebe
      Dado que "+5581999998888" está na lista de bloqueio de "Malharia Aurora"
      E esse telefone não tem contato cadastrado
      Quando uma campanha por lista importada inclui esse telefone
      Então nenhuma mensagem sai para ele
      E ele aparece no relatório como "bloqueado"

    Cenário: bloqueio pedido pelo WhatsApp alcança o cadastro com nono dígito
      Dado que "Saturno Modas" pediu para sair respondendo pelo WhatsApp
      E o pedido chegou com o telefone "+558199771234", sem o nono dígito
      E o cadastro de "Saturno Modas" tem o telefone "+5581997771234", com o nono dígito
      Quando uma campanha materializada a partir do cadastro tenta enviar para ele
      Então o envio é bloqueado
      E o motivo registrado é "telefone na lista de bloqueio"

  ⚠️ Este é o cenário jurídico mais caro do produto, e o furo era invisível: a lista recebia 12
  dígitos, a campanha disparava com 13, a revalidação não encontrava e **enviava**.

  @INV-50
  Regra: a chave reduzida bloqueia, mas nunca funde cadastro (INV-50)

    Cenário: dois telefones com os mesmos 8 dígitos finais não viram o mesmo contato
      Dado que "Vest Fácil Modas LTDA" tem o telefone "+558133617049"
      E "Loja da Ju" tem o telefone "+5581998617049"
      Quando a carga do ERP é processada
      Então os dois contatos permanecem separados
      E nenhuma mesclagem automática acontece
      Mas uma sugestão de conferência é registrada

  @INV-16
  Regra: toda mudança de preferência deixa registro com autor, origem e horário (INV-16)

    Cenário: opt-out vindo de resposta a campanha registra a campanha que o provocou
      Dado que "Saturno Modas" recebeu a campanha "Coleção Inverno 26"
      Quando ele responde "não quero mais receber" e o opt-out é registrado
      Então fica registrado o horário, a origem "resposta do cliente", a campanha "Coleção Inverno 26"
      E a mensagem exata que provocou a mudança

    Cenário: mudança de preferência sem autor identificável é recusada
      Dado que uma rotina interna tenta desativar campanhas de "Loja da Ju"
      E a rotina não informa origem nem autor
      Quando a alteração é submetida
      Então a alteração é recusada
      E a preferência de "Loja da Ju" permanece inalterada
```

---

## 5. Janela de atendimento, template e envio

**Épico:** EP-05, EP-03 · **Requisitos:** INB-04, INB-05, CAN-01…CAN-04 · **Onda:** 1
**Invariantes:** INV-17, INV-18, INV-19, INV-20, INV-21

```gherkin
Funcionalidade: Janela de atendimento e regras de envio

  Contexto:
    Dado que o número "+55 81 99100-0001" de Eduarda está conectado
    E o método de pagamento da empresa está em ordem na Meta
    E a conversa com "Vest Fácil Modas LTDA" existe nesse número

  @INV-18
  Regra: o estado da janela é derivado da última mensagem do cliente (INV-18)

    Esquema do Cenário: fronteira das 24 horas
      Dado que a última mensagem de "Vest Fácil Modas LTDA" foi há <horas>
      Quando Eduarda abre a conversa
      Então a janela está "<estado>"
      E o envio de texto livre "<envio>"

      Exemplos:
        | horas   | estado  | envio          |
        | 0h00    | aberta  | é permitido    |
        | 12h00   | aberta  | é permitido    |
        | 23h00   | aberta  | é permitido    |
        | 23h59   | aberta  | é permitido    |
        | 24h00   | fechada | é bloqueado    |
        | 24h01   | fechada | é bloqueado    |
        | 72h00   | fechada | é bloqueado    |

    Cenário: mensagem enviada pela vendedora não reabre a janela
      Dado que a última mensagem de "Vest Fácil Modas LTDA" foi há 23 horas
      E Eduarda respondeu há 10 minutos
      Quando passam mais 1 hora
      Então a janela está fechada

    Cenário: mensagem do cliente reabre a janela em tempo real, sem recarregar
      Dado que a janela com "Vest Fácil Modas LTDA" está fechada há 3 dias
      E Eduarda está com essa conversa aberta na tela
      Quando "Vest Fácil Modas LTDA" manda "oi, tem o 22625 no verde?"
      Então a janela passa a "aberta · faltam 24h"
      E o envio de texto livre passa a ser permitido sem que Eduarda recarregue a tela

    Cenário: a duração vem do canal, não de constante do produto
      Dado que o canal de Instagram de "Malharia Aurora" declara janela de 24 horas
      E o canal de WhatsApp declara janela de 24 horas
      Quando a duração declarada pelo WhatsApp muda para 48 horas
      Então a contagem regressiva na tela e o bloqueio de envio passam a usar 48 horas
      E nenhuma alteração no Instagram acontece

  ⚠️ A contagem regressiva da tela e o bloqueio do servidor **precisam vir da mesma regra**. Duas
  implementações produzem o caso em que a tela deixa digitar e o envio falha depois.

  @INV-17
  Regra: fora da janela, só template aprovado sai (INV-17)

    Cenário: texto livre fora da janela é bloqueado antes de tentar enviar
      Dado que a janela com "Vest Fácil Modas LTDA" está fechada
      Quando Eduarda tenta enviar "chegou a grade nova, quer ver?"
      Então o envio é bloqueado
      E é explicado que a janela está fechada
      E a escolha de template é oferecida
      E o texto que ela digitou é preservado para ser aproveitado no template

    Cenário: template aprovado sai com a janela fechada
      Dado que a janela com "Vest Fácil Modas LTDA" está fechada
      E o template "reengajamento_colecao" está aprovado e vigente
      Quando Eduarda envia esse template
      Então a mensagem é enviada
      E a janela permanece fechada até que o cliente responda

  @INV-20
  Regra: só versão aprovada e vigente é enviável, e a mensagem guarda o texto lido (INV-20)

    Cenário: template em análise não é enviável
      Dado que o template "promo_junho" foi submetido e está em análise na Meta
      Quando Eduarda tenta enviá-lo para "Vest Fácil Modas LTDA"
      Então o envio é bloqueado
      E é informado que o template ainda não foi aprovado

    Cenário: template rejeitado depois do envio não altera o que o cliente leu
      Dado que Eduarda enviou "reengajamento_colecao" para "Vest Fácil Modas LTDA" em 02/04/2026
      E o texto enviado foi "Oi Vest Fácil, chegou a coleção de inverno."
      Quando a Meta rejeita uma nova versão desse template em 05/04/2026
      Então a mensagem de 02/04/2026 continua exibindo exatamente o texto enviado
      E nenhuma mensagem já enviada é alterada

  @INV-19
  Regra: Instagram não reabre janela por template e não é público de campanha (INV-19)

    Cenário: escolher Instagram como canal de campanha é recusado com explicação
      Dado que "Malharia Aurora" tem o Instagram Direct conectado
      Quando Rafael tenta criar uma campanha com o Instagram como canal de envio
      Então a criação é recusada
      E é explicado que o Instagram não permite disparo em massa nem template para reabrir conversa

    Cenário: janela fechada no Instagram sugere migração de canal
      Dado que a conversa de Instagram com "@lojadaju" está com a janela fechada
      Quando Karine abre essa conversa
      Então nenhum template é oferecido
      E é sugerido continuar o atendimento pelo WhatsApp

  @INV-21
  Regra: nenhum envio sai por canal não conectado ou sem pagamento em ordem (INV-21)

    Esquema do Cenário: o envio falha dizendo exatamente a causa
      Dado que o número de Eduarda está "<estado do número>"
      E o método de pagamento na Meta está "<pagamento>"
      Quando ela tenta enviar uma mensagem para "Vest Fácil Modas LTDA"
      Então o envio é bloqueado
      E o motivo apresentado é "<motivo>"

      Exemplos:
        | estado do número | pagamento     | motivo                                          |
        | desconectado     | em ordem      | número desconectado — refazer a conexão         |
        | conectado        | ausente       | método de pagamento não cadastrado na Meta      |
        | conectado        | recusado      | pagamento recusado pela Meta                    |
        | bloqueado        | em ordem      | número bloqueado pela Meta                      |

  ⚠️ Somos Tech Provider: **o cliente paga a Meta direto** (ADR-002). Falha de pagamento chegando como
  erro genérico produz chamado de suporte que ninguém resolve.
```

---

## 6. Fila de atendimento e assunção

**Épico:** EP-06 · **Requisitos:** INB-09, INB-10, INB-11 · **Onda:** 1
**Invariantes:** INV-51

```gherkin
Funcionalidade: Fila em modo pull e assunção de atendimento

  Contexto:
    Dado que a conversa com "Saturno Modas" está na fila, sem atendimento aberto
    E Ale e Karine estão as duas com a fila aberta na tela

  @INV-51
  Regra: uma conversa tem no máximo um atendimento aberto (INV-51)

    Cenário: dois atendentes assumem ao mesmo tempo e só um leva
      Dado que Ale e Karine visualizam a conversa com "Saturno Modas" em modo leitura
      Quando as duas assumem o atendimento no mesmo instante
      Então apenas uma delas fica com o atendimento
      E a outra recebe "este atendimento já foi assumido por" com o nome de quem levou
      E existe um único protocolo para esse atendimento
      E a conversa some da fila para as duas em tempo real

    Cenário: mensagem nova chegando durante a assunção não abre um segundo atendimento
      Dado que Ale está assumindo o atendimento de "Saturno Modas"
      Quando chega uma mensagem nova de "Saturno Modas" no mesmo instante
      Então continua existindo um único atendimento aberto
      E a mensagem entra nesse atendimento

    Cenário: reabrir conversa com atendimento aberto é recusado
      Dado que Ale tem o atendimento de "Saturno Modas" aberto
      Quando Karine tenta abrir um novo atendimento para a mesma conversa
      Então a operação é recusada
      E é informado que Ale está atendendo

    Cenário: conversa encerrada pode ser assumida de novo, com protocolo novo
      Dado que Ale encerrou o atendimento de "Saturno Modas" com o protocolo "#000318"
      Quando Karine assume um novo atendimento dessa conversa
      Então um novo atendimento é aberto com protocolo "000319"
      E o histórico da conversa permanece contínuo

  ⚠️ Só esconder o botão de quem chegou depois **não é dono de invariante — é esperança com CSS**.
  Dois episódios abertos produzem dois protocolos, SLA e CSAT em dobro, e transferência sem saber qual
  linha fechar.

  Regra: quem está só olhando não responde

    Cenário: atendente sem assumir não consegue enviar
      Dado que Ale está visualizando a conversa de "Saturno Modas" em modo leitura
      Quando ela tenta enviar uma mensagem
      Então o envio é bloqueado
      E é oferecida a assunção do atendimento
```

---

## 7. Frota de números, throttling e quota

**Épico:** EP-03, EP-17 · **Requisitos:** CAN-04, CAN-05, CAN-06, CMP-09 · **Onda:** 0 (gateway) / 3 (campanha)
**Invariantes:** INV-22, INV-23, INV-24

```gherkin
Funcionalidade: Limite de envio e proteção do número

  Contexto:
    Dado que o número "+55 81 99100-0001" está no tier de 1.000 conversas iniciadas por 24 horas
    E o número "+55 81 99100-0002" está no tier de 250

  @INV-22
  Regra: o limite conta conversas iniciadas com contatos distintos, em 24 horas móveis (INV-22)

    Esquema do Cenário: fronteira do limite do tier
      Dado que o número "+55 81 99100-0001" já iniciou conversa com <iniciadas> contatos distintos nas últimas 24 horas
      Quando o disparo tenta iniciar conversa com mais um contato
      Então o envio "<resultado>"

      Exemplos:
        | iniciadas | resultado                                     |
        | 998       | acontece                                      |
        | 999       | acontece                                      |
        | 1000      | é bloqueado por limite do número atingido     |
        | 1001      | é bloqueado por limite do número atingido     |

    Cenário: três mensagens para o mesmo contato consomem um único lugar
      Dado que o número "+55 81 99100-0001" ainda não iniciou nenhuma conversa hoje
      Quando ele envia 3 templates para "Vest Fácil Modas LTDA" na mesma janela
      Então o consumo do limite do número é de 1 conversa iniciada

    Esquema do Cenário: a janela é móvel, não é o dia do calendário
      Dado que o número atingiu o limite do tier com o último envio feito às 23h50 de 12/04/2026
      Quando um novo disparo é tentado em "<momento>"
      Então o envio "<resultado>"

      Exemplos:
        | momento                | resultado   |
        | 00h05 de 13/04/2026    | é bloqueado |
        | 23h45 de 13/04/2026    | é bloqueado |
        | 23h55 de 13/04/2026    | acontece    |

    Cenário: dois disparos concorrentes não ultrapassam o limite
      Dado que restam exatamente 1 lugar no limite de 24 horas do número "+55 81 99100-0002"
      E duas campanhas estão disparando por esse número ao mesmo tempo
      Quando as duas tentam iniciar conversa com contatos distintos no mesmo instante
      Então apenas uma mensagem é enviada
      E a outra fica pendente para a próxima janela
      E o limite do número não é ultrapassado em nenhum momento

    Cenário: o lugar é reservado antes de chamar a Meta
      Dado que restam 3 lugares no limite do número "+55 81 99100-0001"
      Quando o envio é iniciado e a Meta demora 40 segundos para responder
      Então nenhum outro disparo consegue usar aquele lugar durante a espera

  ⚠️ Contar **mensagens** em vez de conversas iniciadas travava disparos perfeitamente legais; contar
  por **dia do calendário** deixava enviar o limite inteiro às 23h e de novo às 00h05 — que é
  exatamente o que derruba a qualidade do número.

  @INV-23
  Regra: dois envios do mesmo número respeitam intervalo mínimo (INV-23)

    Cenário: disparo em rajada é espaçado automaticamente
      Dado que 50 mensagens estão na fila do número "+55 81 99100-0001"
      Quando o disparo começa
      Então entre dois envios consecutivos desse número há sempre um intervalo de ao menos 8 segundos
      E o intervalo varia entre um envio e outro

    Cenário: dois processos disparando pelo mesmo número não colapsam o intervalo
      Dado que duas campanhas usam o número "+55 81 99100-0001"
      Quando as duas tentam enviar no mesmo instante
      Então um envio acontece e o outro espera o intervalo mínimo
      E os dois envios nunca saem no mesmo segundo

    Cenário: números diferentes não competem entre si
      Dado que "+55 81 99100-0001" acabou de enviar
      Quando "+55 81 99100-0002" tenta enviar no mesmo instante
      Então o envio acontece imediatamente

  @INV-24
  Regra: número com qualidade baixa não dispara campanha (INV-24)

    Cenário: campanha não usa número com qualidade abaixo do limiar
      Dado que o número "+55 81 99100-0002" está com qualidade "baixa"
      Quando uma campanha distribuída pela frota começa a disparar
      Então nenhuma mensagem de campanha sai por "+55 81 99100-0002"
      E o painel de saúde da frota apresenta o motivo da exclusão

    Cenário: atendimento 1-a-1 continua permitido no número com qualidade baixa
      Dado que o número "+55 81 99100-0002" está com qualidade "baixa"
      Quando Karine responde uma conversa dentro da janela por esse número
      Então a mensagem é enviada normalmente
```

---

## 8. Pedido assistido — rascunho e efetivação

**Épico:** EP-27 · **Requisitos:** PED-05…PED-09, INT-01b, INT-01c · **Onda:** 2 (contrato do conector: **0**)
**Invariantes:** INV-25, INV-26, INV-27, INV-28, INV-29, INV-30, INV-31, INV-52, INV-53

```gherkin
Funcionalidade: Montagem e efetivação de pedido na conversa

  Contexto:
    Dado que Eduarda atende "Vest Fácil Modas LTDA"
    E o cliente está na tabela de preço "ATACADO", prazo 30 dias
    E o pedido mínimo da empresa é de 10 peças
    E "22625 CONJUNTO LAILA" custa R$ 146,00 e vende em grade fechada P38+M40+G42
    E "08825 CONJUNTO KARINE" custa R$ 115,00

  @INV-52
  Regra: uma conversa tem no máximo um rascunho de pedido (INV-52)

    Cenário: iniciar um segundo rascunho na mesma conversa retoma o existente
      Dado que existe um rascunho com 7 peças na conversa com "Vest Fácil Modas LTDA"
      Quando Eduarda inicia um pedido nessa conversa pelo celular
      Então o rascunho existente é apresentado com as 7 peças
      E nenhum segundo rascunho é criado

    Cenário: dois dispositivos iniciando rascunho no mesmo instante produzem um só
      Dado que Eduarda está com a conversa aberta no desktop e no celular
      Quando ela inicia um pedido nos dois ao mesmo tempo
      Então existe um único rascunho na conversa
      E os dois dispositivos passam a mostrar o mesmo rascunho

  @INV-25 @INV-26
  Regra: preço e condição do pedido são retrato do momento da inclusão (INV-25, INV-26)

    Cenário: mudança de tabela de preço não altera rascunho já montado
      Dado que Eduarda incluiu 6 unidades de "22625 CONJUNTO LAILA" a R$ 146,00 em 10/04/2026
      Quando o preço de "22625" sobe para R$ 159,00 no ERP em 11/04/2026
      Então o rascunho continua com R$ 146,00 por unidade
      E o total do rascunho continua sendo a soma dos valores registrados nele

    Cenário: total do pedido não é recalculado a partir do catálogo
      Dado que o rascunho tem 6 unidades a R$ 146,00 e 1 unidade a R$ 115,00
      Quando Eduarda abre o rascunho no dia seguinte
      Então o total apresentado é R$ 991,00

  @INV-46
  Regra: dinheiro não perde nem ganha centavo (INV-46)

    Cenário: preço com fração de centavo é recusado na importação
      Quando o ERP envia o preço "146,005" para "22625 CONJUNTO LAILA"
      Então o preço não é importado
      E o produto fica marcado com pendência de dado inválido

    Esquema do Cenário: soma de itens fecha exatamente
      Dado que o rascunho tem <qtd> unidades a <preco>
      Quando Eduarda confere o total
      Então o total é exatamente <total>

      Exemplos:
        | qtd | preco      | total        |
        | 3   | R$ 0,07    | R$ 0,21      |
        | 7   | R$ 146,00  | R$ 1.022,00  |
        | 999 | R$ 33,33   | R$ 33.296,67 |

  @INV-27
  Regra: pedido com validação pendente não é efetivado (INV-27)

    Esquema do Cenário: cada regra violada diz o que falta
      Dado que o rascunho está com "<situação>"
      Quando Eduarda tenta efetivar o pedido
      Então a efetivação é bloqueada
      E a mensagem apresentada é "<mensagem>"
      E o rascunho é preservado

      Exemplos:
        | situação                                        | mensagem                                                        |
        | 7 peças, mínimo 10                              | Mínimo 10 peças — faltam 3                                      |
        | grade incompleta de "22625" (falta 1 P38)       | CONJUNTO LAILA vende em grade fechada (P38+M40+G42) — falta 1 P38 |
        | só a categoria CONJUNTO, mix mínimo de 2        | Mix mínimo: 2 categorias — só CONJUNTO selecionado              |

    Cenário: pedido no limite exato do mínimo é efetivado
      Dado que o rascunho tem exatamente 10 peças e a grade completa
      Quando Eduarda efetiva o pedido
      Então o pedido é enviado ao ERP
      E o número do pedido devolvido pelo ERP é apresentado

  @INV-28
  Regra: a regra comercial é congelada no rascunho e revalidada na efetivação (INV-28)

    Cenário: mudança de regra não invalida rascunho antigo em silêncio
      Dado que o rascunho de 3 dias atrás foi montado com pedido mínimo de 10 peças
      E o gestor mudou o mínimo para 15 peças ontem
      Quando Eduarda efetiva o rascunho de 12 peças
      Então a divergência entre a regra congelada e a regra atual é apresentada antes de enviar
      E Eduarda decide se segue com a regra antiga ou ajusta o pedido
      E em nenhuma hipótese a divergência é aplicada sem ela ver

  @INV-30 @PED-08
  Regra: falha na efetivação nunca altera nem apaga o rascunho (INV-30)

    Esquema do Cenário: os cinco erros de efetivação, cada um com a ação corretiva
      Dado que o rascunho de "Vest Fácil Modas LTDA" está válido e pronto para envio
      Quando a efetivação falha com "<erro do ERP>"
      Então o rascunho permanece intacto e editável
      E a mensagem apresentada é "<mensagem>"
      E a ação oferecida é "<ação>"

      Exemplos:
        | erro do ERP                | mensagem                                                | ação                              |
        | estoque esgotado           | VERDE G42 não tem mais saldo (0 disponível)             | ajustar quantidade · remover item |
        | crédito bloqueado          | Crédito insuficiente: pedido R$ 991, disponível R$ 400  | solicitar liberação · reduzir pedido |
        | item inativado             | 08825 foi inativado no ERP                              | remover item · buscar substituto  |
        | cliente sem cadastro fiscal| Cliente sem CNPJ cadastrado no ERP                      | abrir ficha para completar        |
        | erro de comunicação        | GeraCloud não respondeu                                 | tentar novamente                  |

    Cenário: três falhas seguidas não corroem o rascunho
      Dado que a efetivação já falhou duas vezes por erro de comunicação
      Quando Eduarda tenta efetivar de novo e falha outra vez
      Então o rascunho continua com os mesmos 12 itens, quantidades e preços
      E o histórico das três tentativas fica disponível para conferência

  ⚠️ **É aqui que produtos desse tipo morrem.** Se a vendedora perde o pedido montado numa falha do
  ERP, ela volta a lançar no ERP e a ferramenta é abandonada.

  @INV-29
  Regra: uma versão de conteúdo produz no máximo um pedido no ERP (INV-29)

    Cenário: reenviar depois de erro de comunicação não duplica o pedido
      Dado que Eduarda efetivou o rascunho e a comunicação falhou sem resposta
      E nada foi alterado no rascunho
      Quando ela tenta efetivar de novo
      Então o ERP reconhece que é o mesmo pedido
      E um único pedido existe no ERP
      E o número devolvido é o mesmo da primeira tentativa

    Cenário: ajustar o pedido depois da falha produz um pedido diferente
      Dado que a efetivação falhou porque "VERDE G42" não tinha saldo
      Quando Eduarda remove "VERDE G42" e efetiva de novo
      Então o ERP trata como um pedido novo
      E o pedido efetivado é o ajustado, sem "VERDE G42"

    Cenário: duas efetivações disparadas no mesmo instante não geram dois pedidos
      Dado que o rascunho está válido
      Quando Eduarda dispara a efetivação duas vezes no mesmo instante
      Então um único pedido é criado no ERP

  ⚠️ O par acima é o coração da idempotência: **mesma versão → mesma chave** (reenviar não duplica);
  **conteúdo ajustado → chave nova** (senão um ERP corretamente idempotente devolveria o primeiro
  pedido, errado, como sucesso).

  @INV-53
  Regra: depois de resposta perdida, só se retenta após conferir com o ERP (INV-53)

    Cenário: timeout com conexão que sabe consultar pedido é reconciliado sozinho
      Dado que a efetivação atingiu o tempo limite sem resposta
      E a conexão com o ERP sabe consultar pedido pela chave da efetivação
      Quando a reconciliação consulta o ERP
      E o ERP responde que o pedido "PV-88213" foi criado
      Então o pedido é marcado como efetivado com o número "PV-88213"
      E nenhuma nova tentativa de envio acontece

    Cenário: timeout com conexão que não sabe consultar pedido pede conferência humana
      Dado que a efetivação atingiu o tempo limite sem resposta
      E a conexão com o ERP não sabe consultar pedido
      Quando a reconciliação é tentada
      Então o pedido fica em "aguardando conferência"
      E é pedido a Eduarda que confirme no ERP se o pedido entrou
      E nenhuma retentativa automática acontece

  ⚠️ Degradação anunciada, nunca garantia fingida: sem a capacidade de consulta, retentar às cegas
  duplica o pedido do cliente.

  @INV-31
  Regra: pedido efetivado é imutável (INV-31)

    Cenário: alterar item de pedido efetivado é recusado
      Dado que o pedido "PV-88213" foi efetivado com 12 peças
      Quando Eduarda tenta remover um item desse pedido
      Então a alteração é recusada
      E é oferecida a criação de um novo pedido a partir dele
```

---

## 9. Carteira, funil e histórico de propriedade

**Épico:** EP-08 · **Requisitos:** CRM-01…CRM-09 · **Onda:** 2 (a invariante nasce com a carteira, na Onda 1)
**Invariantes:** INV-32, INV-33, INV-35, INV-36, INV-58

```gherkin
Funcionalidade: Carteira e funil

  @INV-32 @INV-33
  Regra: um contato tem no máximo um dono vigente, sem sobreposição (INV-32, INV-33)

    Cenário: atribuir segundo dono sem encerrar o primeiro é recusado
      Dado que "Vest Fácil Modas LTDA" está na carteira de Eduarda desde 01/02/2026
      Quando Rafael tenta atribuir o mesmo contato a Karine sem encerrar a atribuição de Eduarda
      Então a operação é recusada
      E Eduarda continua sendo a dona

    Cenário: transferência fecha uma atribuição e abre outra no mesmo instante
      Dado que "Vest Fácil Modas LTDA" está na carteira de Eduarda desde 01/02/2026
      Quando Rafael transfere o contato para Karine em 15/04/2026
      Então a atribuição de Eduarda é encerrada em 15/04/2026
      E a de Karine começa no mesmo instante
      E fica registrado quem transferiu e quando

    Cenário: registrar atribuição retroativa que se sobrepõe é recusado
      Dado que Karine é dona de "Vest Fácil Modas LTDA" desde 15/04/2026
      Quando Rafael tenta registrar que Eduarda foi dona de 10/04/2026 a 20/04/2026
      Então o registro é recusado por sobreposição de período

  @INV-58
  Regra: o histórico de carteira não tem lacuna (INV-58)

    Cenário: desligar a vendedora deixa o contato explicitamente sem dono
      Dado que Eduarda é dona de 40 contatos
      Quando Rafael desativa o usuário de Eduarda
      Então os 40 contatos passam a constar como "sem dono" a partir daquele instante
      E não existe nenhum intervalo de tempo sem registro de propriedade

    Cenário: relatório de propriedade em qualquer data devolve resposta
      Dado que "Vest Fácil Modas LTDA" teve donos desde 01/02/2026
      Quando Rafael pergunta quem era o dono em 03/03/2026
      Então uma resposta é apresentada, ainda que seja "sem dono"

  @INV-35
  Regra: um contato ocupa uma etapa por funil, com registro de toda mudança (INV-35)

    Cenário: colocar o mesmo contato em duas etapas do mesmo funil é recusado
      Dado que "Loja da Ju" está na etapa "Negociação" do funil de Leads
      Quando Karine tenta colocá-la também em "Proposta enviada" no mesmo funil
      Então a operação é recusada
      E "Loja da Ju" permanece em uma única etapa

    Cenário: mudança de etapa registra autor, origem e horário
      Dado que "Loja da Ju" está em "Negociação"
      Quando Karine move o contato para "Proposta enviada"
      Então fica registrado que Karine moveu, a partir da conversa, com data e hora

  @INV-36
  Regra: descartar exige motivo do catálogo (INV-36)

    Cenário: descarte sem motivo é recusado
      Dado que "Loja da Ju" está em "Negociação"
      Quando Karine tenta movê-la para "Perdido" sem informar motivo
      Então a operação é recusada
      E a lista de motivos de perda é apresentada

    Cenário: motivo fora do catálogo é recusado
      Quando Karine tenta descartar "Loja da Ju" com o motivo digitado "sei lá"
      Então a operação é recusada
      E apenas motivos do catálogo da empresa são aceitos
```

---

## 10. Ingestão, webhook e idempotência

**Épico:** EP-02, EP-03 · **Requisitos:** INT-01, INT-02, INT-04, INT-05, INT-08, CAN-01 · **Onda:** 0
**Invariantes:** INV-37, INV-38, INV-39, INV-41, INV-55

```gherkin
Funcionalidade: Recebimento de eventos do canal e ingestão do ERP

  @INV-37
  Regra: um evento do canal é aplicado uma única vez (INV-37)

    Cenário: reentrega do mesmo evento não duplica a mensagem
      Dado que a mensagem "olá, tem o 22625?" de "Vest Fácil Modas LTDA" já foi recebida
      Quando a Meta reentrega exatamente o mesmo evento 4 minutos depois
      Então a conversa continua com uma única mensagem
      E nenhuma notificação de mensagem nova é emitida de novo

    Cenário: evento que não pode ser processado nunca confirma o recebimento como sucesso silencioso
      Dado que chega um evento do canal com estrutura que não reconhecemos
      Quando o evento é processado
      Então o recebimento é confirmado ao canal, para que ele não reentregue indefinidamente
      E o evento é registrado como falha permanente no painel de sincronização
      E fica disponível para reprocessamento manual

  ⚠️ Falha permanente respondida com erro faz a Meta reentregar em laço e degrada o webhook inteiro;
  falha permanente confirmada **sem registro** some com o dado. Confirma-se o recebimento **e**
  registra-se a falha — as duas coisas. *(Nota de implementação, fora do cenário: a confirmação é
  HTTP 200.)*

  @INV-38 @INV-60
  Regra: uma mensagem do canal tem uma única linha, mesmo meses depois (INV-38, INV-60)

    Cenário: reentrega tardia de mensagem antiga não cria uma segunda mensagem
      Dado que a mensagem de "Vest Fácil Modas LTDA" foi recebida em 05/01/2026
      Quando a Meta reentrega o mesmo identificador de mensagem em 20/04/2026
      Então nenhuma mensagem nova é criada
      E nenhuma segunda cobrança é registrada para aquela mensagem

  @INV-39
  Regra: o status de entrega só avança (INV-39)

    Esquema do Cenário: reentrega fora de ordem não regride o status
      Dado que a mensagem está com status "<atual>"
      Quando chega o evento de status "<recebido>"
      Então o status da mensagem fica "<final>"

      Exemplos:
        | atual    | recebido | final    |
        | enviado  | entregue | entregue |
        | entregue | lido     | lido     |
        | lido     | entregue | lido     |
        | lido     | enviado  | lido     |
        | entregue | enviado  | entregue |

    Cenário: falha de entrega é apresentada com motivo e não some
      Dado que a mensagem para "Saturno Modas" falhou por número inexistente
      Quando Eduarda abre a conversa
      Então a mensagem aparece marcada como falha
      E o motivo "número inexistente" está disponível

  @INV-55
  Regra: uma venda física entra uma única vez (INV-55)

    Cenário: a mesma venda vinda de duas conexões não é contada duas vezes
      Dado que "Malharia Aurora" tem as conexões "GeraCloud Produção" (fonte de venda) e "drezz Loja 2"
      E a venda "PV-88213" de "Vest Fácil Modas LTDA", de 12/04/2026, R$ 991,00, já entrou pela conexão fonte
      Quando a mesma venda chega pela conexão "drezz Loja 2"
      Então nenhuma segunda venda é criada
      E um conflito de identidade é registrado para conferência
      E a frequência de compra de "Vest Fácil Modas LTDA" continua contando uma venda

    Cenário: declarar duas conexões como fonte de venda é recusado
      Dado que "GeraCloud Produção" é a fonte de venda de "Malharia Aurora"
      Quando Rafael tenta marcar "drezz Loja 2" também como fonte de venda
      Então a operação é recusada
      E é explicado que apenas uma conexão pode ser a fonte de venda da empresa

  ⚠️ Sem esta regra, frequência e valor do RFV dobram, o ciclo de vida reclassifica, a Fila do Dia
  prioriza errado — **e nada denuncia**.

  @INT-04
  Regra: reenvio de carga com a mesma chave de operação não duplica (INT-04)

    Cenário: reenviar o mesmo lote de clientes não cria duplicados
      Dado que o lote "carga-2026-04-12-001" com 1.200 clientes já foi processado
      Quando o mesmo lote é enviado de novo com a mesma chave de operação
      Então nenhum cliente é criado
      E o resultado devolvido é o mesmo do primeiro processamento

    Cenário: lote interrompido no meio é retomado sem duplicar o que já entrou
      Dado que o lote "carga-2026-04-12-002" falhou após processar 700 dos 1.200 clientes
      Quando o lote é reenviado com a mesma chave de operação
      Então os 500 restantes são processados
      E os 700 já existentes não são duplicados

  @INV-41
  Regra: credencial de terceiro nunca aparece nem alcança outra empresa (INV-41)

    Cenário: credencial salva não é devolvida por inteiro
      Dado que Rafael salvou a credencial da conexão "GeraCloud Produção"
      Quando ele abre a configuração dessa conexão depois
      Então a credencial aparece mascarada
      E o valor completo não é apresentado em nenhuma tela nem em nenhum registro de diagnóstico

    Cenário: conexão de uma empresa não é alcançada por outra
      Dado que "Confecção Boa Vista" conhece o identificador da conexão de "Malharia Aurora"
      Quando ela tenta usar essa conexão
      Então a operação falha como conexão não encontrada
```

---

## 11. Conector de ERP e negociação de capacidade

**Épico:** EP-02 · **Requisitos:** INT-01, INT-01b, INT-01c · **Onda:** 0 · **ADR-008**
**Invariantes:** INV-56 (cobertura), INV-53 (reconciliação)

```gherkin
Funcionalidade: Degradação por capacidade ausente do ERP

  ⚠️ O produto **degrada em vez de quebrar**, e a degradação é **visível**: usuário de ERP limitado
  precisa saber por que o saldo tem hora.

  Regra: sem saldo em tempo real, o saldo é apresentado com a hora da última sincronização

    Cenário: conexão sem consulta de saldo ao vivo mostra saldo datado
      Dado que a conexão "Bling da Aurora" não sabe consultar saldo em tempo real
      E a última sincronização de estoque foi às 06h00 de 12/04/2026
      Quando Eduarda busca "22625 CONJUNTO LAILA" para montar o pedido
      Então o saldo é apresentado com o aviso "saldo de 12/04/2026 06h00"
      E a montagem do pedido é permitida
      E é informado que a disponibilidade será conferida na efetivação

    Cenário: a validação de saldo migra para a efetivação
      Dado que a conexão "Bling da Aurora" não sabe consultar saldo em tempo real
      E o rascunho tem 3 unidades de "VERDE G42", com saldo datado de 5 unidades
      Quando Eduarda efetiva o pedido e o ERP responde que só há 1 disponível
      Então a efetivação falha com "VERDE G42: pedido 3, disponível 1"
      E o rascunho é preservado com a ação de ajustar a quantidade

    Cenário: conexão com saldo ao vivo não apresenta hora de apuração
      Dado que a conexão "GeraCloud Produção" sabe consultar saldo em tempo real
      Quando Eduarda busca "22625 CONJUNTO LAILA"
      Então o saldo é apresentado sem aviso de defasagem

  Regra: sem escrita de pedido, o tira-pedidos vira rascunho exportável

    Cenário: ERP que não recebe pedido não oferece efetivação
      Dado que a conexão "Tiny da Aurora" não sabe receber pedido
      Quando Eduarda termina de montar um rascunho válido de 12 peças
      Então nenhuma efetivação é oferecida
      E é oferecido exportar o pedido e enviar o resumo formatado ao cliente
      E é informado que este ERP não recebe pedido pelo GeraCRM

    Cenário: a limitação é anunciada antes de montar, não depois
      Dado que a conexão "Tiny da Aurora" não sabe receber pedido
      Quando Eduarda inicia um pedido na conversa
      Então a limitação já é informada no início da montagem

  @INV-56
  Regra: nada é classificado fora da cobertura de dados da conexão (INV-56)

    Cenário: contato sem venda importada não é chamado de "perdido"
      Dado que a conexão "GeraCloud Produção" só importou vendas a partir de 01/03/2026
      E "Vest Fácil Modas LTDA" não tem nenhuma venda importada
      Quando a ficha dele é aberta
      Então não é apresentado "Dias sem vendas: 267"
      E é apresentado "sem dados de venda anteriores a 01/03/2026"
      E ele não é classificado como "Perdido"

    Cenário: a matriz RFV se recusa a classificar quem está fora da cobertura
      Dado que a janela de análise de recência é de 12 meses
      E a cobertura de vendas da conexão começa há 45 dias
      Quando a matriz RFV é calculada
      Então nenhum contato é classificado
      E é informado que a carga histórica ainda não cobre a janela necessária

    Cenário: carga histórica concluída libera a classificação
      Dado que a carga histórica de 24 meses foi concluída
      Quando a matriz RFV é calculada
      Então os contatos passam a ser classificados
      E as métricas deixam de ser marcadas como não confiáveis

  ⚠️ **"Nunca comprou" e "não sabemos" são coisas diferentes.** Sem esta regra, a base inteira nasce
  como "Perdido" no dia 1 e o cliente perde a confiança no produto na primeira reunião.
```

---

## 12. Custo, atribuição de receita e contadores

**Épico:** EP-14, EP-17 · **Requisitos:** CMP-10…CMP-12, BI-02 · **Onda:** 3 (contrato desde a Onda 0)
**Invariantes:** INV-42, INV-43, INV-44, INV-45, INV-54, INV-57

```gherkin
Funcionalidade: Custo por mensagem e atribuição de receita

  @INV-54
  Regra: uma mensagem gera no máximo uma cobrança por categoria (INV-54)

    Cenário: reentrega do evento de status não cobra duas vezes
      Dado que a mensagem de campanha para "Loja da Ju" já registrou custo de R$ 0,32 na categoria "Marketing"
      Quando o mesmo evento de status é reentregue
      Então o custo registrado continua sendo R$ 0,32
      E o custo total da campanha não muda

    Cenário: a mesma mensagem em duas categorias cobráveis registra duas linhas
      Dado que a mensagem gerou cobrança de "Marketing" e de "Utility"
      Quando o custo da campanha é apurado
      Então as duas cobranças são somadas uma única vez cada

  ⚠️ O custo é o número mais comercial do produto. Inflado por reentrega de webhook, **sem nada que
  denuncie**, ele destrói o argumento de ROI.

  @INV-42 @INV-43
  Regra: receita exata e receita estimada nunca são somadas (INV-42, INV-43)

    Cenário: o relatório da campanha apresenta os dois números separados
      Dado que a campanha "Coleção Inverno 26" tem R$ 12.400,00 de receita exata e R$ 31.800,00 de estimada
      Quando Rafael abre o relatório da campanha
      Então os dois valores aparecem separados, cada um com o método
      E nenhum valor total combinando os dois é apresentado

    Cenário: segunda atribuição exata para a mesma venda é recusada
      Dado que a venda "PV-88213" já está atribuída de forma exata ao pedido montado na conversa
      Quando a apuração tenta atribuir a mesma venda de forma exata a outra campanha
      Então a segunda atribuição é recusada
      E um conflito é registrado para conferência

  @INV-44
  Regra: a janela de atribuição estimada é declarada e fica gravada (INV-44)

    Cenário: atribuição sem janela declarada não é registrada
      Dado que a empresa não definiu a janela padrão de atribuição estimada
      Quando a apuração de receita estimada é executada
      Então nenhuma atribuição estimada é registrada
      E é informado que a regra de atribuição não está declarada

    Cenário: mudar a janela não reescreve o que já foi apurado
      Dado que as atribuições de março foram apuradas com janela de 7 dias
      Quando Rafael muda a janela padrão para 14 dias em abril
      Então as atribuições de março continuam exibindo "janela de 7 dias"
      E as de abril passam a exibir "janela de 14 dias"

  @INV-45
  Regra: a linha do tempo de segmento RFV é encadeada e sem empate (INV-45)

    Cenário: duas transições no mesmo instante são recusadas
      Dado que "Vest Fácil Modas LTDA" teve uma transição de segmento registrada em 12/04/2026 03h00
      Quando outra transição do mesmo contato é registrada no mesmo instante
      Então o segundo registro é recusado

    Cenário: transição cuja origem não é o segmento anterior é recusada
      Dado que a última transição de "Vest Fácil Modas LTDA" terminou no segmento "Leal"
      Quando é registrada uma transição partindo de "Campeão" para "Em risco"
      Então o registro é recusado
      E a linha do tempo continua encadeada

  @INV-57
  Regra: contador denormalizado é cache, nunca fonte de verdade (INV-57)

    Cenário: reconciliação ao fim da carga corrige o contador da ficha
      Dado que a ficha de "Vest Fácil Modas LTDA" mostra 12 vendas
      E a carga de ontem trouxe mais 2 vendas dele
      Quando a reconciliação ao fim da carga é executada
      Então a ficha passa a mostrar 14 vendas

    Cenário: editar o contador à mão é recusado
      Quando Rafael tenta alterar diretamente a quantidade de vendas de "Vest Fácil Modas LTDA"
      Então a alteração é recusada
      E é informado que esse número vem da apuração de vendas

    Cenário: o segmento RFV não é calculado a partir do contador exibido
      Dado que o contador exibido está desatualizado em 2 vendas
      Quando a matriz RFV é calculada
      Então a classificação usa as vendas apuradas, não o contador exibido
```

---

## 13. Regras transversais de apresentação e dado

**Épico:** transversal · **Requisitos:** ADR-011 · **Onda:** 0
**Invariantes:** INV-46, INV-47, INV-48

```gherkin
Funcionalidade: Regras transversais

  @INV-47
  Regra: nenhuma lista é carregada inteira (INV-47)

    Cenário: coluna de kanban com onze mil cards abre por partes
      Dado que a coluna "Sem pedidos" do funil de relacionamento tem 11.427 contatos
      Quando Rafael abre o kanban
      Então os primeiros 50 contatos da coluna são apresentados
      E há a opção de carregar mais
      E em nenhum momento os 11.427 são carregados de uma vez

    Cenário: pedido de página gigante pela integração é limitado
      Dado que a integração de "Malharia Aurora" solicita 5.000 contatos numa única página
      Quando a solicitação é processada
      Então é devolvida a página no tamanho máximo permitido
      E é devolvido o ponto de continuação para a próxima página

    Cenário: continuar a lista não repete nem pula item quando chega dado novo
      Dado que Rafael carregou as 3 primeiras páginas da lista de conversas
      E chegaram 4 conversas novas nesse intervalo
      Quando ele carrega a página seguinte
      Então nenhum item já apresentado aparece de novo
      E nenhum item é pulado

  @INV-48
  Regra: estado é sempre um valor com nome, nunca um código numérico (INV-48)

    Cenário: estado desconhecido vindo do ERP é recusado com nome
      Quando o ERP envia o estado do pedido como "3"
      Então a importação recusa o valor
      E o erro registrado é "estado de pedido desconhecido: 3"
      E o pedido mantém o estado anterior
```

---

## 14. Mapa de cobertura — invariante → onde está o cenário

| INV | Onde | INV | Onde | INV | Onde |
|---|---|---|---|---|---|
| INV-01 | §1 | INV-21 | §5 | INV-41 | §10 |
| INV-02 | §1 | INV-22 | §7 | INV-42 | §12 |
| INV-03 | §1 | INV-23 | §7 | INV-43 | §12 |
| INV-04 | §1 | INV-24 | §7 | INV-44 | §12 |
| INV-05 | §2 | INV-25 | §8 | INV-45 | §12 |
| INV-06 | §3 | INV-26 | §8 | INV-46 | §8 |
| INV-07 | §3 | INV-27 | §8 | INV-47 | §13 |
| INV-08 | §3 | INV-28 | §8 | INV-48 | §13 |
| INV-09 | §3 | INV-29 | §8 | INV-49 | §3 |
| INV-10 | §3 | INV-30 | §8 | INV-50 | §4 |
| INV-11 | §3 | INV-31 | §8 | INV-51 | §6 |
| INV-12 | §3 | INV-32 | §9 | INV-52 | §8 |
| INV-13 | §4 | INV-33 | §9 | INV-53 | §8 |
| INV-14 | §4 | INV-34 | §1, §2 | INV-54 | §12 |
| INV-15 | §4 | INV-35 | §9 | INV-55 | §10 |
| INV-16 | §4 | INV-36 | §9 | INV-56 | §11 |
| INV-17 | §5 | INV-37 | §10 | INV-57 | §12 |
| INV-18 | §5 | INV-38 | §10 | INV-58 | §9 |
| INV-19 | §5 | INV-39 | §10 | INV-59 | §1 |
| INV-20 | §5 | INV-40 | §2 | INV-60 | §10 |

**Cobertura das exigências transversais:**

| Exigência | Cenários |
|---|---|
| Isolamento de banco e de canal em tempo real | §1 (3 cenários de leitura, busca e escrita) · §2 (assinatura recusada) |
| Permissão revogada durante a sessão | §2 — "permissão revogada durante a sessão interrompe a entrega" |
| Notificação sem conteúdo | §2 — "a notificação anuncia a mudança, não a mensagem" |
| Fronteira da janela de 24 h | §5 — Esquema com 23h00, 23h59, **24h00**, 24h01 |
| Os 5 erros de PED-08 com ação corretiva | §8 — Esquema "os cinco erros de efetivação" |
| Idempotência do reenvio de pedido | §8 — mesma versão reenvia · conteúdo ajustado gera pedido novo |
| Opt-out por todo caminho, inclusive lote manual | §4 — Esquema com 7 caminhos + cenário do lote de 4.312 |
| Webhook: idempotência e falha permanente confirmada | §10 — reentrega · falha permanente registrada |
| Throttling por número: limite e concorrência | §7 — fronteira 999/1000 · janela móvel · dois disparos concorrentes |
| Degradação do conector por capacidade ausente | §11 — saldo datado · sem escrita de pedido |
| Fila pull com dois atendentes simultâneos | §6 — "dois atendentes assumem ao mesmo tempo" |

---

## 15. Dúvidas levantadas na escrita — precisam de resposta antes da implementação

> ⚠️ A skill `bdd` é explícita: *sessão que termina sem nenhuma dúvida levantada foi superficial*.
> Estas oito não são detalhes — cada uma muda o comportamento de pelo menos um cenário acima.

| # | Dúvida | Impacto no cenário | Quem responde |
|---|---|---|---|
| 1 | O **intervalo mínimo entre envios** do mesmo número (usei 8 s) é qual, e ele varia por tier? | §7 — o número no Esquema | Operação / observação da Meta |
| 2 | Qual o **limiar de qualidade** que barra campanha (baixa? média?) e ele é configurável por empresa? | §7 — "qualidade abaixo do limiar" | Dono do negócio |
| 3 | **Mix mínimo por categoria** é regra da empresa, do cliente ou da tabela de preço? | §8 — Esquema de validações | Dono do negócio |
| 4 | Quando a **regra comercial congelada diverge da atual**, quem decide: a vendedora ou o gestor com alçada? | §8 — cenário de INV-28 | Dono do negócio |
| 5 | **Janela padrão de atribuição estimada** (3/7/14 d) e o desempate quando o cliente recebeu duas campanhas | §12 — INV-44 | Decisão comercial (decisão aberta nº 4 do modelo) |
| 6 | Carteira é **exclusiva** ou existe "dono + apoio"? | §9 — INV-32 | Dono do negócio (decisão aberta nº 7) |
| 7 | **Janela máxima de reentrega de webhook** da Meta — define até quando o cenário de reentrega tardia (§10) precisa valer | §10 — reentrega de 20/04 sobre mensagem de 05/01 | Documentação da Meta (decisão aberta nº 15) |
| 8 | O contato-lead criado por mensagem entrante (§3, INV-12) entra em **qual etapa** do funil de leads, e ele já conta como público de campanha? | §3 e §4 | Dono do negócio |

---

## 16. O que deliberadamente **não** virou cenário

| Item | Por quê |
|---|---|
| Formato de resposta, códigos de erro, nomes de campo | Detalhe de implementação — vira teste de unidade e contrato, não BDD |
| Normalização de telefone caso a caso (regra do nono dígito por faixa de DDD) | Tabela de dados; vira teste de unidade parametrizado da função pura |
| Cálculo interno da faixa RFV | TDD do job; o BDD cobre só a **recusa de classificar fora da cobertura** (§11) |
| Layout, cores, anel de janela, comportamento de scroll | `especificacao-telas.md` e `identidade-visual.md` |
| Desempenho e latência | Requisito não-funcional com número, medido fora da suíte BDD |

⚠️ **Suíte BDD gigante fica lenta e ninguém roda.** O que está aqui é comportamento de negócio; o
resto é TDD, que é mais rápido e mais barato.
