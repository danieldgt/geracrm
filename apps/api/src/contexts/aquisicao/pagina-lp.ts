/**
 * A PÁGINA da landing page (AQ-44) — HTML montado no servidor, sem framework.
 *
 * ⚠️ Por que uma página mínima e não `apps/catalogo`: o que trava a campanha do
 * Google hoje é **não ter destino nenhum** (AMK-015). Uma LP com editor de
 * conteúdo é projeto; um destino que carrega rápido no 4G e leva ao WhatsApp com
 * a origem preservada é o que falta. Quando o catálogo SSR existir, esta página
 * vira uma rota lá dentro — o contrato (`/publico/lp/:chave`) não muda.
 *
 * ⚠️ **A sessão nasce no CLIQUE, não no carregamento.** Criar no `load` contaria
 * crawler, preview de link e curioso como intenção — e cada um deles viraria uma
 * sessão que nunca é consumida, afundando a métrica de "código perdido"
 * justamente quando ela precisa ser confiável.
 *
 * ⚠️ **E se a chamada falhar, o lead ainda fala com a loja.** O botão degrada
 * para o `wa.me` sem código: perde-se a atribuição daquele lead, não o lead.
 * Trocar uma conversa por um dado é a inversão de valores que mata produto de
 * aquisição.
 */

export interface DadosLp {
  readonly chave: string
  readonly titulo: string
  readonly subtitulo: string | null
  readonly chamadaBotao: string
  readonly avisoConsentimento: string | null
  readonly telefoneDestino: string
  readonly textoBase: string
}

/** Escapa para dentro de HTML. O conteúdo vem do banco, mas escapar é regra. */
export function escaparHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Escapa para dentro de `<script>`. ⚠️ `JSON.stringify` sozinho NÃO basta: a
 * sequência `</script>` dentro de uma string fecha a tag e o resto do JSON vira
 * markup. É o furo clássico de dado do banco injetado em script.
 */
export function paraScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c')
}

/** O `wa.me` sem código — o caminho degradado, e o que o `<noscript>` usa. */
export function linkDireto(telefone: string, texto: string): string {
  return `https://wa.me/${telefone}?text=${encodeURIComponent(texto)}`
}

export function renderizarLp(lp: DadosLp): string {
  const direto = linkDireto(lp.telefoneDestino, lp.textoBase)
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaparHtml(lp.titulo)}</title>
<!-- ⚠️ Tráfego de anúncio é majoritariamente móvel e frequentemente 4G ruim:
     nada de fonte externa, nada de framework, nada de requisição em cascata. -->
<style>
  :root { color-scheme: light dark;
    --fundo: #ffffff; --texto: #0f172a; --secundario: #475569; --borda: #e2e8f0;
    --acao: #16a34a; --acao-texto: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --fundo: #0f172a; --texto: #f1f5f9; --secundario: #94a3b8;
            --borda: #1e293b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 20px 40px; background: var(--fundo); color: var(--texto);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center; }
  main { width: 100%; max-width: 480px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; }
  p.sub { font-size: 17px; color: var(--secundario); margin: 0 0 28px; }
  a.botao { display: block; width: 100%; padding: 18px 20px; border-radius: 12px;
    background: var(--acao); color: var(--acao-texto); font-size: 18px; font-weight: 600;
    text-align: center; text-decoration: none; border: 0; cursor: pointer; }
  a.botao[aria-busy="true"] { opacity: .7; }
  a.botao:focus-visible { outline: 3px solid var(--texto); outline-offset: 3px; }
  p.aviso { margin: 20px 0 0; font-size: 13px; color: var(--secundario); }
</style>
</head>
<body>
<main>
  <h1>${escaparHtml(lp.titulo)}</h1>
  ${lp.subtitulo ? `<p class="sub">${escaparHtml(lp.subtitulo)}</p>` : ''}
  <a class="botao" id="ir" href="${escaparHtml(direto)}" rel="nofollow noopener">${escaparHtml(lp.chamadaBotao)}</a>
  ${lp.avisoConsentimento ? `<p class="aviso" id="aviso">${escaparHtml(lp.avisoConsentimento)}</p>` : ''}
</main>
<script>
(function () {
  var CHAVE = ${paraScript(lp.chave)};
  var DIRETO = ${paraScript(direto)};
  var botao = document.getElementById('ir');
  var p = new URLSearchParams(location.search);
  var pega = function (nomes) {
    for (var i = 0; i < nomes.length; i++) { var v = p.get(nomes[i]); if (v) return v; }
    return null;
  };
  // ⚠️ QUAL parâmetro trouxe o clique importa tanto quanto o valor: gclid é
  // Google, fbclid é Meta, e um passo adiante os dois viram o mesmo texto opaco.
  var TIPOS = ['gclid', 'wbraid', 'gbraid', 'fbclid'];
  var tipo = null, clickId = null;
  for (var i = 0; i < TIPOS.length && !clickId; i++) {
    var v = p.get(TIPOS[i]);
    if (v) { tipo = TIPOS[i]; clickId = v; }
  }
  // ValueTrack do Google e os equivalentes da Meta. ⚠️ Lidos da URL do ANÚNCIO:
  // é a única vez em que o clique se identifica.
  var corpo = {
    clickId: clickId, clickIdTipo: tipo,
    utmSource: p.get('utm_source'), utmMedium: p.get('utm_medium'),
    utmCampaign: p.get('utm_campaign'), utmContent: p.get('utm_content'),
    utmTerm: p.get('utm_term'),
    campanhaExternaId: pega(['campaignid', 'campaign_id']),
    anuncioExternoId: pega(['creative', 'adid', 'ad_id']),
    pagina: location.href, referrer: document.referrer || null
  };
  var indo = false;
  botao.addEventListener('click', function (ev) {
    if (indo) return;
    ev.preventDefault();
    indo = true;
    botao.setAttribute('aria-busy', 'true');
    // ⚠️ Rede pode demorar; o lead não pode ficar olhando um botão morto. Passou
    //    de 4s, vai pelo caminho direto — sem código, mas com a conversa.
    var caiuFora = setTimeout(function () { location.href = DIRETO; }, 4000);
    fetch('/publico/lp/' + encodeURIComponent(CHAVE) + '/sessao', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo)
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        clearTimeout(caiuFora);
        location.href = (d && d.link) ? d.link : DIRETO;
      })
      .catch(function () { clearTimeout(caiuFora); location.href = DIRETO; });
  });
})();
</script>
</body>
</html>`
}
