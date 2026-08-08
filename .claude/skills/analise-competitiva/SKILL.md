---
name: analise-competitiva
description: >
  Mapear concorrentes de um produto de software por anéis de proximidade, extrair funcionalidades
  e modelo de negócio de cada um, montar matriz comparativa honesta e identificar lacunas
  exploráveis. Use quando for preciso "analisar os concorrentes", "ver o que o mercado faz",
  "comparar com X", posicionar um produto, decidir se vale entrar num mercado, ou justificar
  quais funcionalidades são obrigatórias por serem tabela de entrada.
---

# Análise competitiva

O objetivo não é listar concorrentes. É responder três perguntas: **o que é tabela de entrada,
o que é diferencial e onde há campo vazio.**

## Anéis de proximidade

Concorrente não é só quem faz a mesma coisa. Organize em anéis — do centro para fora:

| Anel | Quem é | O que extrair |
|---|---|---|
| **1. Direto** | Mesma vertical, mesma promessa, mesmo cliente | Paridade obrigatória; onde eles são fracos |
| **2. Adjacente funcional** | Resolve a mesma dor por outro caminho | Conceitos maduros para absorver |
| **3. Adjacente de orçamento** | Disputa o mesmo dinheiro do cliente | Por que o cliente escolheria eles |
| **4. Canal** | Não é software, mas reduz a necessidade do seu produto | Ameaça invisível |
| **5. Plataforma de base** | Sistema que o cliente já tem e pode expandir | Hoje parceiro, amanhã substituto |
| **6. Genérico** | Ferramenta horizontal que "dá para usar" | Só como referência de UX |

⚠️ **O anel 4 é o mais esquecido e o mais perigoso.** Se um marketplace resolve a aquisição do
cliente, ele precisa menos do seu CRM de prospecção — e você nunca aparece na comparação de
software.

⚠️ **O anel 5 é ambíguo por natureza.** Quem fornece seus dados hoje pode lançar o seu módulo
amanhã. Vale mapear o que eles já estão construindo.

## Fontes, em ordem de valor

| Fonte | Vale | Cuidado |
|---|---|---|
| **Capturas de tela do produto** | Muito | A verdade do que existe |
| **Documentação de API pública** | Muito | Revela o modelo de dados e a maturidade |
| **Página de preços** | Alto | Revela o modelo de negócio e o cliente-alvo |
| **Landing de comparação ("X vs Y")** | Alto | Eles dizem quem consideram concorrente e onde se acham fortes |
| **Changelog / novidades** | Alto | Mostra a direção, não só o estado |
| **Cases e depoimentos** | Médio | Revela o perfil de cliente real |
| **Landing de marketing** | Baixo | Mostra o que vende, não o que faz |

⚠️ **Analisar concorrente só pelo site é o erro clássico.** O marketing promete IA, omni-canal e
automação total. As capturas mostram três telas e um relatório.

## O que extrair de cada concorrente

```
Posicionamento   uma frase, com as palavras deles
Público          porte, segmento, faixa de faturamento declarada
Funcionalidades  por módulo, com o que é forte e o que é raso
Modelo de preço  quanto, cobrado por quê (usuário? volume? canal?)
Integrações      com quantos e quais sistemas
Escala           clientes, volume, tempo de mercado
Lacunas          o que claramente não fazem
```

**O modelo de cobrança é o dado mais subestimado.** Se todo o nicho cobra por canal e você cobra
por usuário, o cliente não consegue comparar — e "não consegue comparar" costuma virar "não compra".

## Matriz comparativa honesta

Use uma escala que distinga profundidade, não só presença:

```
✅✅✅  referência do mercado nisso
✅✅    forte
✅      tem
⚠️      raso ou parcial
❌      não tem
```

⚠️ **Matriz que dá ✅ para tudo do seu produto e ❌ para tudo dos outros não convence ninguém e
mente para você mesmo.** A matriz serve para decidir, não para vender. Se todos os concorrentes
têm algo que você não tem, isso é tabela de entrada — coloque no backlog.

## Ler as lacunas

Depois da matriz, três perguntas:

1. **O que todos têm?** → tabela de entrada. Não é diferencial, é requisito de existência
2. **O que ninguém tem?** → candidato a diferencial. **Mas verifique por quê:** pode ser porque
   não é possível, não é rentável, ou o mercado não quer
3. **O que exige juntar duas ferramentas hoje?** → a lacuna mais valiosa. O cliente já paga
   duas assinaturas e já sente a dor

⚠️ **"Ninguém faz" nem sempre é oportunidade.** Às vezes é cemitério. Antes de apostar, procure
quem tentou e saiu.

## Do mapa à decisão

A análise termina em **caminhos com trade-off explícito**, não em um relatório:

```
A. Concorrente direto      clonar com execução melhor
   risco: mercado disputado, incumbentes com base instalada

B. Mesma tecnologia, outro nicho
   risco: cada nicho tem integrações próprias; escopo multiplica

C. Camada abaixo (plataforma/white-label)
   risco: ciclo de venda mais longo; exige multi-tenancy desde o início
```

⚠️ **Entrar de frente contra dois incumbentes com o mesmo discurso é a pior opção**, salvo se
você tem uma vantagem estrutural — base de clientes, dado exclusivo, canal de distribuição.

## Checklist

- □ Os seis anéis foram percorridos, inclusive canal e plataforma de base
- □ Cada concorrente tem evidência citável, não impressão
- □ O modelo de cobrança de cada um está registrado
- □ A matriz distingue profundidade, não só presença
- □ A tabela de entrada está separada do diferencial
- □ Cada "ninguém faz" foi investigado antes de virar aposta
- □ A conclusão são caminhos com risco, não um vencedor único

## Relacionado

`levantar-requisitos` — capturas de concorrente se analisam com o mesmo método.
`especificar-requisitos` — tabela de entrada vira requisito obrigatório.
