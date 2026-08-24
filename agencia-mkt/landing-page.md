# A landing page do anúncio — como usar (AQ-44/45)

> O destino que faltava. Sem uma URL, não existe campanha no Google (AMK-015) — e sem
> o código de origem viajando até a conversa, existe campanha mas não existe atribuição.

## O caminho inteiro, em cinco passos

```
1. Anúncio no Google        →  https://crm.drezz.com.br/publico/lp/<chave>?gclid={gclid}&…
2. A página                 →  título, subtítulo e UM botão
3. O clique no botão        →  POST /publico/lp/<chave>/sessao  (grava gclid/UTM, devolve o código)
4. O WhatsApp abre          →  "Olá! Vi o anúncio [ref: A7K2Q9]"
5. A mensagem chega         →  o código vira `midia_lead_origem` no mesmo commit da mensagem
```

Do passo 5 em diante o que já existia assume: a resolução tardia liga a origem ao anúncio
quando a estrutura sincroniza, e a venda no ERP vira conversão devolvida à plataforma.

## Criar uma LP

Console → **Mídia paga** → *Landing pages do anúncio*. Pede três coisas: nome interno,
título da página e o WhatsApp de destino. O link aparece na lista com um botão de copiar.

⚠️ **A chave da URL é pública e resolve o tenant.** É o mesmo mecanismo do webhook da Meta
(`phone_number_id` → canal → tenant, migration `0057`): a rota não recebe `tenantId`, ela
**resolve** (`lp_por_chave`, migration `0062`). O que a chave autoriza é deliberadamente
mínimo — gravar uma visita anônima. Ela não lê contato, não lê métrica, não escreve em mais nada.

## O que colar no Google Ads

URL final:

```
https://crm.drezz.com.br/publico/lp/<chave>
```

Sufixo de URL final (ValueTrack — é isto que carrega o clique):

```
gclid={gclid}&campaignid={campaignid}&creative={creative}&utm_source=google&utm_medium=cpc&utm_campaign={campaignname}
```

A página lê esses parâmetros **no navegador** e os manda no clique. Na Meta, os equivalentes
são `fbclid`, `campaign_id` e `ad_id` — a página aceita os dois conjuntos.

⚠️ **Qual parâmetro veio importa tanto quanto o valor.** `gclid` é Google, `fbclid` é Meta;
um passo adiante os dois viram o mesmo texto opaco. A plataforma é decidida na borda e
gravada na sessão.

## As decisões que não são óbvias

**A sessão nasce no CLIQUE, não no carregamento.** Criar no `load` contaria crawler, preview
de link do WhatsApp e curioso como intenção — e cada um viraria uma sessão que nunca é
consumida, afundando justamente a métrica que mede a saúde da atribuição.

**Se a chamada falhar, o lead ainda fala com a loja.** O `href` do botão já é o `wa.me`
direto, sem código; o JavaScript só o substitui quando consegue. Rede ruim, JS bloqueado ou
API fora: perde-se a atribuição daquele lead, não o lead. ⚠️ Trocar uma conversa por um dado
é a inversão que mata produto de aquisição.

**O código é editável pelo lead.** Ele pode apagar o texto pronto antes de enviar — o desenho
inteiro (`0059`) assume a perda. Por isso a **taxa de código perdido** aparece por LP na tela:
é ela que diz se o ROAS está furando em silêncio.

⚠️ **"Ninguém clicou ainda" não é 0% de perda.** Sem sessão nenhuma a taxa é `—`, não zero.

**O consentimento é congelado no clique.** `midia_sessao_lp.consentimento_texto` guarda o
texto **exibido naquele momento**, e ele sai da LP, nunca do corpo da requisição. Ler o aviso
da LP na hora de consumir devolveria a redação atual — e o registro passaria a afirmar que a
pessoa consentiu com um texto que ela nunca viu.

## Limites

- **Rate limit**: 20 sessões por minuto por (LP + IP) e 600 por minuto por LP. ⚠️ É proteção
  contra abuso trivial e contra o bot que descobre a URL — não contra ataque distribuído, que
  se resolve na borda. E é **por instância**: duas instâncias somam o dobro do teto.
- **A página é mínima de propósito** — sem CMS, sem imagem, sem formulário. LP com editor é
  projeto; o que trava a campanha hoje é não ter destino. Quando `apps/catalogo` existir, esta
  página vira uma rota lá dentro e o contrato `/publico/lp/:chave` não muda.
- **Ingestão de formulário (AQ-12)** continua em aberto: aqui só existe o caminho `wa.me`,
  que é o caminho inbound (AMK-014).

## Onde está o código

| Peça | Arquivo |
|---|---|
| Schema da LP + resolvedor por chave | `infra/migrations/0062_midia_lp.sql` |
| Página (HTML puro, testável) | `apps/api/src/contexts/aquisicao/pagina-lp.ts` |
| Rotas públicas (sem token) | `apps/api/src/contexts/aquisicao/rotas-lp-publica.ts` |
| Limite de taxa | `apps/api/src/contexts/aquisicao/limite-taxa.ts` |
| Consumo do código na mensagem | `apps/api/src/contexts/aquisicao/consumo-codigo.ts` |
| Gancho na ingestão (savepoint) | `apps/api/src/contexts/atendimento/ingestao-mensagem.ts` |
| Painel no console | `apps/console/src/app/funcionalidades/aquisicao/midia.pagina.ts` |
| Proxy da rota pública | `apps/console/nginx.conf` |
