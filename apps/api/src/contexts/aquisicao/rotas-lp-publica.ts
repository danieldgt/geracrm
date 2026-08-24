import { randomBytes, randomUUID } from 'node:crypto'
import { codigoDeBytes, montarTextoWaMe } from '@geracrm/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql, comTenantServico } from '../../db/index.js'
import { renderizarLp, escaparHtml, type DadosLp } from './pagina-lp.js'
import { criarLimiteTaxa } from './limite-taxa.js'

/**
 * A SUPERFÍCIE PÚBLICA da landing page (AQ-44).
 *
 * ⚠️ **Estas duas rotas não têm autenticação, e é o ponto delas.** A LP roda no
 * navegador de um desconhecido que acabou de clicar num anúncio — não há token,
 * e não pode haver.
 *
 * ⚠️ **O tenant é RESOLVIDO, nunca recebido.** A chave da URL vai para
 * `lp_por_chave()` (SECURITY DEFINER, migration 0062) e de lá sai o `tenant_id`.
 * É exatamente o que o webhook da Meta faz com o `phone_number_id` (0057), e é o
 * que mantém o ADR-001 de pé numa rota sem sessão: `tenantId` no corpo da
 * requisição seria o mesmo que deixar o cliente escolher em qual empresa escrever.
 *
 * ⚠️ A partir da resolução, tudo passa por `comTenantServico` — a escrita
 * acontece sob a MESMA RLS do resto do sistema, com `SET LOCAL`.
 */

/** Sessões por (chave + IP) por minuto. Gente de verdade clica uma vez. */
const limitePorIp = criarLimiteTaxa({ teto: 20, janelaMs: 60_000 })
/**
 * ⚠️ E um teto por LP, independente de IP: o limite por IP se contorna trocando
 * de IP (ou forjando `x-forwarded-for`, que é cabeçalho de cliente). O teto por
 * chave é o que realmente limita quantas linhas entram no banco.
 */
const limitePorLp = criarLimiteTaxa({ teto: 600, janelaMs: 60_000 })

/**
 * IP de quem chamou, atrás do proxy do Railway.
 *
 * ⚠️ `x-forwarded-for` é escrito pelo cliente e só depois acrescentado pelo
 * proxy — dá para forjar. Serve para separar tráfego normal, não para barrar
 * quem está tentando: quem tenta esbarra no teto por LP.
 */
function ipDoCliente(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for']
  const bruto = Array.isArray(xff) ? xff[0] : xff
  return bruto?.split(',')[0]?.trim() || req.ip
}

interface LinhaLp {
  id: string; chave: string; titulo: string; subtitulo: string | null
  chamada_botao: string; aviso_consentimento: string | null
  telefone_destino: string; texto_base: string
}

/** Resolve a chave pública → tenant + conteúdo da página (este já sob RLS). */
async function acharLp(chave: string): Promise<{ tenantId: string; lp: LinhaLp } | null> {
  if (!/^[a-z0-9]{12,40}$/.test(chave)) return null
  const [rota] = await sql<{ tenant_id: string; lp_id: string; ativo: boolean }[]>`
    SELECT tenant_id, lp_id, ativo FROM lp_por_chave(${chave})`
  if (!rota || !rota.ativo) return null

  const [lp] = await comTenantServico(rota.tenant_id, (tx) => tx<LinhaLp[]>`
    SELECT id, chave, titulo, subtitulo, chamada_botao, aviso_consentimento,
           telefone_destino, texto_base
      FROM midia_lp WHERE tenant_id = tenant_atual() AND id = ${rota.lp_id}`)
  return lp ? { tenantId: rota.tenant_id, lp } : null
}

const dadosDaPagina = (lp: LinhaLp): DadosLp => ({
  chave: lp.chave,
  titulo: lp.titulo,
  subtitulo: lp.subtitulo,
  chamadaBotao: lp.chamada_botao,
  avisoConsentimento: lp.aviso_consentimento,
  telefoneDestino: lp.telefone_destino,
  textoBase: lp.texto_base,
})

const corta = (v: unknown, n = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null

/**
 * De qual plataforma veio o clique.
 *
 * ⚠️ Decidido AQUI, na borda, porque é o último ponto em que se sabe QUAL
 * parâmetro trouxe o clique — `gclid` e `fbclid` viram o mesmo `click_id` opaco
 * um passo adiante.
 *
 * ⚠️ E é uma lista fechada, nunca o texto do cliente: `plataforma` tem CHECK no
 * banco, e repassar `utm_source` cru faria o INSERT falhar por conta do lead ter
 * clicado num link com parâmetro esquisito.
 */
export function plataformaDoClique(tipo: unknown, utmSource: unknown): string | null {
  if (tipo === 'gclid' || tipo === 'wbraid' || tipo === 'gbraid') return 'google'
  if (tipo === 'fbclid') return 'meta'
  const s = typeof utmSource === 'string' ? utmSource.toLowerCase() : ''
  if (s.includes('google') || s.includes('adwords')) return 'google'
  if (s.includes('facebook') || s.includes('meta') || s.includes('instagram') || s === 'fb') return 'meta'
  if (s.includes('tiktok')) return 'tiktok'
  return null
}

export async function rotasLpPublica(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { chave: string } }>('/publico/lp/:chave', async (req, reply) => {
    const achado = await acharLp(req.params.chave)
    if (!achado) {
      // ⚠️ Página, não JSON: quem chega aqui é uma PESSOA que clicou num anúncio.
      //    E 404 de propósito — "esta LP não existe" e "esta LP está desligada"
      //    são a mesma coisa para quem está do lado de fora.
      return reply.code(404).type('text/html; charset=utf-8').send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
        + `<title>Página não encontrada</title>`
        + `<body style="font:16px system-ui;padding:40px;text-align:center">`
        + `<p>${escaparHtml('Esta página não está disponível.')}</p>`)
    }
    return reply
      .type('text/html; charset=utf-8')
      // Conteúdo muda pouco e o tráfego é de anúncio: cachear alivia a origem
      // sem atrapalhar nada — os parâmetros do clique são lidos no NAVEGADOR.
      .header('cache-control', 'public, max-age=300')
      .send(renderizarLp(dadosDaPagina(achado.lp)))
  })

  /**
   * Cria a sessão do clique e devolve o link do WhatsApp com o código.
   *
   * ⚠️ Chamada no CLIQUE, não no carregamento: sessão por visita contaria
   * crawler e preview de link, e cada uma delas afundaria a métrica de código
   * perdido (`consumida_em ÷ criadas`), que é justamente o termômetro da
   * atribuição.
   */
  app.post<{ Params: { chave: string }; Body: Record<string, unknown> }>(
    '/publico/lp/:chave/sessao', async (req, reply) => {
      const achado = await acharLp(req.params.chave)
      if (!achado) return reply.code(404).send({ erro: 'lp.nao_encontrada' })

      const agora = Date.now()
      const ip = ipDoCliente(req)
      if (!limitePorIp.permitir(`${req.params.chave}:${ip}`, agora)
        || !limitePorLp.permitir(req.params.chave, agora)) {
        // ⚠️ 429 com corpo tipificado — a página trata como falha e degrada para
        //    o wa.me sem código. O lead conversa; só a atribuição se perde.
        return reply.code(429).send({ erro: 'limite.excedido' })
      }

      const b = req.body ?? {}
      const { lp } = achado
      // 16 bytes para 6 caracteres: sobra de propósito. Colisão dentro do tenant
      // custaria uma atribuição errada, e o índice único recusaria a segunda.
      const codigo = codigoDeBytes(randomBytes(16))
      const texto = montarTextoWaMe(lp.texto_base, codigo)

      await comTenantServico(achado.tenantId, (tx) => tx`
        INSERT INTO midia_sessao_lp
          (tenant_id, id, lp_id, codigo, plataforma, click_id, utm_source, utm_medium,
           utm_campaign, utm_content, utm_term, campanha_externa_id, anuncio_externo_id,
           pagina, referrer, consentimento_texto)
        VALUES (tenant_atual(), ${randomUUID()}, ${lp.id}, ${codigo},
                ${plataformaDoClique(b['clickIdTipo'], b['utmSource'])},
                ${corta(b['clickId'], 300)}, ${corta(b['utmSource'])}, ${corta(b['utmMedium'])},
                ${corta(b['utmCampaign'])}, ${corta(b['utmContent'])}, ${corta(b['utmTerm'])},
                ${corta(b['campanhaExternaId'])}, ${corta(b['anuncioExternoId'])},
                ${corta(b['pagina'], 500)}, ${corta(b['referrer'], 500)},
                -- ⚠️ O aviso sai da LP, NÃO do corpo da requisição: o texto do
                --    consentimento tem de ser o que nós exibimos, não o que o
                --    cliente diz que leu.
                ${lp.aviso_consentimento})`)

      return reply.send({
        codigo,
        textoPronto: texto,
        // ⚠️ O lead escreve PRIMEIRO — é isso que mantém a operação inbound e
        //    autoriza o agente autônomo depois (AMK-014).
        link: `https://wa.me/${lp.telefone_destino}?text=${encodeURIComponent(texto)}`,
      })
    })
}
