/**
 * A PÁGINA da landing page (AQ-44) — HTML montado no servidor, sem framework.
 *
 * ⚠️ Por que uma página mínima e não `apps/catalogo`: o que trava a campanha do
 * Google hoje é **não ter destino nenhum** (AMK-015). Uma LP com editor de
 * conteúdo é projeto; um destino que carrega rápido no 4G e leva ao WhatsApp com
 * a origem preservada é o que falta. Quando o catálogo SSR existir, esta página
 * vira uma rota lá dentro — o contrato (`/publico/lp/:chave`) não muda.
 *
 * ⚠️ **Dois modos, e eles não são o mesmo com pele diferente** (AMK-016):
 *
 * | Modo | Quem começa | Consequência |
 * |---|---|---|
 * | `inbound_wa` | o LEAD | janela de 24h nasce aberta; o agente pode atender |
 * | `outbound_formulario` | NÓS | precisa de template pago; quem fala é uma pessoa |
 *
 * ⚠️ **A sessão nasce no CLIQUE (ou no envio), não no carregamento.** Criar no
 * `load` contaria crawler, preview de link e curioso como intenção — e cada um
 * viraria uma sessão que nunca é consumida, afundando a métrica de "código
 * perdido" justamente quando ela precisa ser confiável.
 *
 * ⚠️ **E se a chamada falhar, o lead ainda fala com a loja.** No modo WhatsApp o
 * botão degrada para o `wa.me` sem código: perde-se a atribuição daquele lead,
 * não o lead. Trocar uma conversa por um dado é a inversão de valores que mata
 * produto de aquisição.
 */

export type ModoLp = 'inbound_wa' | 'outbound_formulario'

export interface DadosLp {
  readonly chave: string
  readonly modo: ModoLp
  readonly titulo: string
  readonly subtitulo: string | null
  readonly chamadaBotao: string
  readonly avisoConsentimento: string | null
  /** Obrigatório no modo WhatsApp; ausente no formulário (ninguém vai ao wa.me). */
  readonly telefoneDestino: string | null
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

/** O `wa.me` sem código — o caminho degradado, e o que sobra sem JavaScript. */
export function linkDireto(telefone: string, texto: string): string {
  return `https://wa.me/${telefone}?text=${encodeURIComponent(texto)}`
}

/** Nome do campo-armadilha. Bot preenche tudo; gente não vê. */
export const CAMPO_ARMADILHA = 'apelido'

const ESTILO = `
  :root { color-scheme: light dark;
    --fundo: #ffffff; --texto: #0f172a; --secundario: #475569; --borda: #e2e8f0;
    --acao: #16a34a; --acao-texto: #ffffff; --erro: #dc2626; --campo: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --fundo: #0f172a; --texto: #f1f5f9; --secundario: #94a3b8;
            --borda: #334155; --campo: #1e293b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 20px 40px; background: var(--fundo); color: var(--texto);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center; }
  main { width: 100%; max-width: 480px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; }
  p.sub { font-size: 17px; color: var(--secundario); margin: 0 0 28px; }
  a.botao, button.botao { display: block; width: 100%; padding: 18px 20px; border-radius: 12px;
    background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 18px; font-weight: 600;
    text-align: center; text-decoration: none; border: 0; cursor: pointer; }
  a.botao[aria-busy="true"], button.botao[aria-busy="true"] { opacity: .7; }
  a.botao:focus-visible, button.botao:focus-visible { outline: 3px solid var(--texto); outline-offset: 3px; }
  p.aviso { margin: 20px 0 0; font-size: 13px; color: var(--secundario); }
  /* ⚠️ Rótulo VISÍVEL, não placeholder: placeholder some quando a pessoa digita,
     e quem preenche formulário no celular precisa saber em qual campo está. */
  label { display: block; margin-bottom: 16px; font-size: 14px; color: var(--secundario); }
  input, textarea { display: block; width: 100%; margin-top: 6px; padding: 14px;
    font: inherit; color: var(--texto); background: var(--campo);
    border: 1px solid var(--borda); border-radius: 10px; }
  input:focus-visible, textarea:focus-visible { outline: 2px solid var(--acao); outline-offset: 1px; }
  textarea { min-height: 88px; resize: vertical; }
  /* O campo-armadilha sai da tela sem sair do DOM. */
  .armadilha { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
  p.erro { margin: 16px 0 0; color: var(--erro); font-size: 14px; }
  #obrigado h2 { font-size: 22px; margin: 0 0 8px; }
`

/** Cabeçalho comum: nada de fonte externa nem framework — 4G ruim é a regra. */
function cabecalho(titulo: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaparHtml(titulo)}</title>
<style>${ESTILO}</style>
</head>
<body>
<main>`
}

/** Leitura dos parâmetros do clique — igual nos dois modos. */
const LEITURA_DE_CLIQUE = `
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
  var origem = {
    clickId: clickId, clickIdTipo: tipo,
    utmSource: p.get('utm_source'), utmMedium: p.get('utm_medium'),
    utmCampaign: p.get('utm_campaign'), utmContent: p.get('utm_content'),
    utmTerm: p.get('utm_term'),
    campanhaExternaId: pega(['campaignid', 'campaign_id']),
    anuncioExternoId: pega(['creative', 'adid', 'ad_id']),
    pagina: location.href, referrer: document.referrer || null
  };`

function paginaWhatsApp(lp: DadosLp): string {
  const direto = linkDireto(lp.telefoneDestino ?? '', lp.textoBase)
  return `${cabecalho(lp.titulo)}
  <h1>${escaparHtml(lp.titulo)}</h1>
  ${lp.subtitulo ? `<p class="sub">${escaparHtml(lp.subtitulo)}</p>` : ''}
  <a class="botao" id="ir" href="${escaparHtml(direto)}" rel="nofollow noopener">${escaparHtml(lp.chamadaBotao)}</a>
  ${lp.avisoConsentimento ? `<p class="aviso">${escaparHtml(lp.avisoConsentimento)}</p>` : ''}
</main>
<script>
(function () {
  var CHAVE = ${paraScript(lp.chave)};
  var DIRETO = ${paraScript(direto)};
  var botao = document.getElementById('ir');
${LEITURA_DE_CLIQUE}
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
      body: JSON.stringify(origem)
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

function paginaFormulario(lp: DadosLp): string {
  return `${cabecalho(lp.titulo)}
  <div id="pedido">
    <h1>${escaparHtml(lp.titulo)}</h1>
    ${lp.subtitulo ? `<p class="sub">${escaparHtml(lp.subtitulo)}</p>` : ''}
    <form id="form" novalidate>
      <label>Seu nome
        <input name="nome" autocomplete="name" required maxlength="120">
      </label>
      <label>WhatsApp com DDD
        <input name="telefone" inputmode="tel" autocomplete="tel" required maxlength="20">
      </label>
      <label>E-mail (opcional)
        <input name="email" type="email" autocomplete="email" maxlength="180">
      </label>
      <label>O que você precisa? (opcional)
        <textarea name="mensagem" maxlength="1000"></textarea>
      </label>
      <!-- ⚠️ Campo-armadilha: some da tela, não do DOM. Bot preenche tudo. -->
      <div class="armadilha" aria-hidden="true">
        <label>Apelido<input name="${CAMPO_ARMADILHA}" tabindex="-1" autocomplete="off"></label>
      </div>
      <button class="botao" type="submit">${escaparHtml(lp.chamadaBotao)}</button>
      <p class="erro" id="erro" hidden></p>
    </form>
    ${lp.avisoConsentimento ? `<p class="aviso">${escaparHtml(lp.avisoConsentimento)}</p>` : ''}
  </div>
  <div id="obrigado" hidden>
    <h2>Recebemos o seu contato</h2>
    <p class="sub">Alguém da equipe vai falar com você em breve pelo WhatsApp.</p>
  </div>
</main>
<script>
(function () {
  var CHAVE = ${paraScript(lp.chave)};
  var form = document.getElementById('form');
  var erro = document.getElementById('erro');
  var botao = form.querySelector('button');
${LEITURA_DE_CLIQUE}
  var enviando = false;
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (enviando) return;
    var dados = new FormData(form);
    var corpo = {
      nome: (dados.get('nome') || '').trim(),
      telefone: (dados.get('telefone') || '').trim(),
      email: (dados.get('email') || '').trim() || null,
      mensagem: (dados.get('mensagem') || '').trim() || null,
      ${CAMPO_ARMADILHA}: dados.get('${CAMPO_ARMADILHA}') || null,
      origem: origem
    };
    if (!corpo.nome || !corpo.telefone) {
      erro.textContent = 'Preencha o nome e o WhatsApp.';
      erro.hidden = false;
      return;
    }
    enviando = true;
    erro.hidden = true;
    botao.setAttribute('aria-busy', 'true');
    fetch('/publico/lp/' + encodeURIComponent(CHAVE) + '/lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo)
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) {
        if (r.ok) {
          // ⚠️ Troca de tela, não caixa de aviso do navegador: o "obrigado"
          //    precisa sobreviver ao print que a pessoa manda para o vendedor.
          document.getElementById('pedido').hidden = true;
          document.getElementById('obrigado').hidden = false;
          return;
        }
        throw new Error((r.d && r.d.erro) || 'falhou');
      })
      .catch(function (e) {
        // ⚠️ O que a pessoa digitou FICA no formulário. Perder o texto por causa
        //    de uma falha de rede é a forma mais rápida de perder o lead.
        erro.textContent = String(e.message) === 'telefone.invalido'
          ? 'Confira o WhatsApp: precisa ter DDD.'
          : 'Não conseguimos enviar agora. Tente de novo em instantes.';
        erro.hidden = false;
      })
      .finally(function () {
        enviando = false;
        botao.removeAttribute('aria-busy');
      });
  });
})();
</script>
</body>
</html>`
}

export function renderizarLp(lp: DadosLp): string {
  return lp.modo === 'outbound_formulario' ? paginaFormulario(lp) : paginaWhatsApp(lp)
}
