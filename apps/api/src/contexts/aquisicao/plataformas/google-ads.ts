import { microsParaCentavos } from '@geracrm/shared'
import type {
  CapacidadesPlataforma, ConversaoParaEnvio, EstruturaVeiculacao, MetricaDiaExterna,
  MotivoFalhaPlataforma, NoVeiculacao, PeriodoConsulta, PortaPlataformaMidia, ResultadoPlataforma,
} from './porta.js'

/**
 * Adaptador do Google Ads atrás da PortaPlataformaMidia (AQ-04).
 *
 * ⚠️ O Google é sempre mockado em teste (`buscar` injetável) — mesmo padrão do
 * `CanalMetaOficial`. Falha vira retorno TIPIFICADO, nunca exceção.
 *
 * ⚠️ **A VERSÃO DA API É CONFIGURÁVEL, e isso não é preferência.** O Google passou
 * a lançar **mensalmente** em 2026, cada versão vive ~1 ano, e na desativação
 * **todas as requisições passam a falhar** — não degradam, falham. A v21 morreu em
 * 05/08/2026. Uma versão fixa no código é um apagão com data marcada; por isso ela
 * sai de `GOOGLE_ADS_API_VERSION` e o default é revisado a cada migração.
 * (O adaptador da Meta pode fixar `v21.0` porque lá a régua é outra.)
 */

/** ⚠️ Revisar a cada migração — ver `docs`/sunset-dates. Atual em ago/2026: v25. */
const VERSAO_PADRAO = 'v25'
const BASE = 'https://googleads.googleapis.com'

export interface CredencialGoogleAds {
  readonly developerToken: string
  /** A MCC, **só dígitos** (sem hífen). Ex.: `1232760756`. */
  readonly loginCustomerId: string
  /**
   * ⚠️ Função, não string. Access token dura ~1h e o adaptador vive num worker de
   * dias — guardar o valor faria a primeira hora funcionar e a segunda falhar com
   * `401`, que pareceria credencial errada. O `ProvedorTokenGoogle` renova.
   */
  readonly obterAccessToken: () => Promise<ResultadoPlataforma<string>>
}

/**
 * ⚠️ Capacidades HONESTAS: só declara `true` o que este adaptador REALMENTE faz.
 * Prometer capacidade que não existe faz o produto falhar em vez de degradar —
 * e o despachante de conversões confia nisto para **descartar** com motivo
 * nomeado em vez de tentar oito vezes contra o vazio.
 */
export const CAPACIDADES_GOOGLE_ADS: CapacidadesPlataforma = {
  leituraEstrutura: true,
  leituraMetrica: true,
  // ⚠️ Customer Match tem requisitos de elegibilidade da conta (AMK-015) e ainda
  //    não foi implementado. Não prometer o que é a promessa mais forte da oferta.
  publicoPersonalizado: false,
  // ⚠️ Offline Conversion Import: próxima etapa. Enquanto false, o despachante
  //    descarta com `plataforma_sem_capacidade` — visível, não silencioso.
  conversaoOffline: false,
  // Click-to-WhatsApp é formato Meta. É a razão da LP com wa.me existir (AMK-012).
  cliqueParaConversa: false,
  escritaEstado: false,
  escritaOrcamento: false,
}

interface LinhaBusca {
  campaign?: { id?: string; name?: string; status?: string }
  adGroup?: { id?: string; name?: string; status?: string; campaign?: string }
  adGroupAd?: { ad?: { id?: string; name?: string }; status?: string; adGroup?: string }
  metrics?: { impressions?: string; clicks?: string; costMicros?: string; conversions?: number }
  segments?: { date?: string }
}

/** Estados do Google → o nosso vocabulário. O que não reconhecemos vira rascunho. */
function traduzirEstado(status: string | undefined): NoVeiculacao['estado'] {
  switch (status) {
    case 'ENABLED': return 'ativa'
    case 'PAUSED': return 'pausada'
    case 'REMOVED': return 'removida'
    default: return 'rascunho'
  }
}

/**
 * Extrai a CAUSA de dentro do erro do Google.
 *
 * ⚠️ O Google embrulha o motivo real em `error.details[].errors[].errorCode.*`, e
 * a mensagem de topo é sempre a mesma frase genérica. Sem desembrulhar, três
 * credenciais diferentes (developer token, cliente OAuth, refresh token) produzem
 * o mesmo `credencial_invalida` — e quem está configurando não sabe qual trocar.
 *
 * Descoberto na primeira chamada real: a resposta dizia "Request is missing
 * required authentication credential", e a causa — `DEVELOPER_TOKEN_INVALID` —
 * estava enterrada, fora do corte de 500 caracteres.
 */
export function extrairCausa(corpo: unknown): string | null {
  const raiz = (corpo as { error?: { message?: string; details?: unknown[] } })?.error
  if (!raiz) return null

  const detalhes = Array.isArray(raiz.details) ? raiz.details : []
  for (const d of detalhes) {
    const erros = (d as { errors?: { errorCode?: Record<string, string>; message?: string }[] })?.errors
    for (const e of erros ?? []) {
      const codigo = Object.values(e.errorCode ?? {})[0]
      if (codigo) {
        const dica = DICA[codigo]
        return dica ? `${codigo} — ${dica}` : `${codigo}${e.message ? `: ${e.message}` : ''}`
      }
    }
  }
  return raiz.message ?? null
}

/** O que fazer, para os códigos que aparecem enquanto se configura. */
const DICA: Record<string, string> = {
  DEVELOPER_TOKEN_INVALID:
    'o developer token não vale. Pegue o atual em ads.google.com/aw/apicenter e atualize '
    + 'GOOGLE_ADS_DEVELOPER_TOKEN. ⚠️ Se você o redefiniu, o valor antigo morreu na hora.',
  DEVELOPER_TOKEN_NOT_APPROVED:
    'o token existe mas não alcança esta conta — é o nível de acesso, não a credencial. '
    + 'Solicite o Basic (passo ④ do onboarding).',
  DEVELOPER_TOKEN_PROHIBITED:
    'este developer token está proibido de usar a API. Fale com o suporte do Google Ads.',
  CUSTOMER_NOT_ENABLED:
    'a conta de anúncio existe mas não foi habilitada — falta concluir o cadastro (forma de pagamento).',
  NOT_ADS_USER: 'a conta autenticada não tem acesso a esta conta de anúncio.',
  USER_PERMISSION_DENIED:
    'autenticou, mas sem permissão nesta conta. Confira o vínculo com a MCC e o login-customer-id.',
  CUSTOMER_NOT_FOUND: 'o customerId não existe ou não está vinculado à MCC informada.',
}

/** `customers/123/adGroups/456` → `456`. */
const idDoRecurso = (recurso: string | undefined): string | null =>
  recurso ? (recurso.split('/').pop() ?? null) : null

export class PlataformaGoogleAds implements PortaPlataformaMidia {
  readonly plataforma = 'google' as const
  readonly capacidades = CAPACIDADES_GOOGLE_ADS

  readonly #cred: CredencialGoogleAds
  readonly #buscar: typeof fetch
  readonly #versao: string
  readonly #timeout: number

  constructor(
    cred: CredencialGoogleAds,
    opcoes: { buscar?: typeof fetch; versao?: string; timeoutMs?: number } = {},
  ) {
    this.#cred = cred
    this.#buscar = opcoes.buscar ?? fetch
    this.#versao = opcoes.versao ?? process.env.GOOGLE_ADS_API_VERSION ?? VERSAO_PADRAO
    this.#timeout = opcoes.timeoutMs ?? 30_000
  }

  /**
   * Uma consulta GAQL, seguindo a paginação até o fim.
   *
   * ⚠️ **Ignorar o `nextPageToken` é o erro silencioso desta API**: a resposta vem
   * `200 OK` com metade dos dados, o custo do relatório aparece MENOR, e ninguém
   * desconfia porque o número melhorou. Por isso a paginação é do adaptador, e não
   * opção de quem chama.
   */
  async #consultar(contaExternaId: string, gaql: string): Promise<ResultadoPlataforma<LinhaBusca[]>> {
    const conta = contaExternaId.replace(/\D/g, '')
    if (!conta) return { ok: false, motivo: 'sem_permissao', detalhe: 'conta externa vazia' }

    const url = `${BASE}/${this.#versao}/customers/${conta}/googleAds:search`
    const linhas: LinhaBusca[] = []
    let pageToken: string | undefined

    // Teto de páginas: defesa contra laço infinito se a API devolver o mesmo token.
    for (let pagina = 0; pagina < 200; pagina++) {
      // ⚠️ Renovado a cada página: uma sincronização longa pode atravessar a
      //    expiração do token, e o provedor devolve o mesmo valor do cache
      //    enquanto ele serve — o custo é uma comparação de relógio.
      const acesso = await this.#cred.obterAccessToken()
      if (!acesso.ok) return acesso

      const sinal = AbortSignal.timeout(this.#timeout)
      let resposta: Response
      try {
        resposta = await this.#buscar(url, {
          method: 'POST',
          signal: sinal,
          headers: {
            authorization: `Bearer ${acesso.dados}`,
            'developer-token': this.#cred.developerToken,
            // ⚠️ Sem `login-customer-id`, o Google recusa acesso a conta de
            //    cliente vinculada: ele diz por QUAL gerenciador estamos entrando.
            'login-customer-id': this.#cred.loginCustomerId.replace(/\D/g, ''),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query: gaql, ...(pageToken ? { pageToken } : {}) }),
        })
      } catch (e) {
        // Timeout e queda de rede são "espere e tente de novo", não erro nosso.
        return { ok: false, motivo: 'indisponivel', detalhe: String(e) }
      }

      const corpo = (await resposta.json().catch(() => null)) as
        { results?: LinhaBusca[]; nextPageToken?: string; error?: unknown } | null

      if (!resposta.ok) return { ok: false, ...this.#traduzirErro(resposta.status, corpo) }

      linhas.push(...(corpo?.results ?? []))
      if (!corpo?.nextPageToken) return { ok: true, dados: linhas }
      pageToken = corpo.nextPageToken
    }
    return { ok: false, motivo: 'resposta_inesperada', detalhe: 'paginação não terminou em 200 páginas' }
  }

  /**
   * HTTP + corpo do Google → motivo tipificado.
   *
   * ⚠️ A distinção que mais importa é `limite_de_taxa`: o despachante NÃO consome
   * tentativa nele, então classificá-lo errado mandaria conversões válidas para o
   * dead-letter.
   */
  #traduzirErro(status: number, corpo: unknown): { motivo: MotivoFalhaPlataforma; detalhe?: string } {
    const texto = JSON.stringify(corpo ?? {})
    const detalhe = extrairCausa(corpo) ?? texto.slice(0, 500)

    if (status === 401) return { motivo: 'credencial_invalida', detalhe }
    if (status === 429 || /RESOURCE_EXHAUSTED|QUOTA_ERROR|RateExceeded/i.test(texto)) {
      return { motivo: 'limite_de_taxa', detalhe }
    }
    if (status === 403) {
      // 403 é ambíguo no Google: pode ser cota OU falta de permissão.
      return /QUOTA|RESOURCE_EXHAUSTED/i.test(texto)
        ? { motivo: 'limite_de_taxa', detalhe }
        : { motivo: 'sem_permissao', detalhe }
    }
    if (/CUSTOMER_NOT_ENABLED|ACCOUNT_SUSPENDED|CUSTOMER_NOT_FOUND|NOT_ADS_USER/i.test(texto)) {
      return { motivo: 'conta_indisponivel', detalhe }
    }
    if (status >= 500) return { motivo: 'indisponivel', detalhe }
    if (/DEVELOPER_TOKEN|OAUTH|AUTHENTICATION/i.test(texto)) {
      return { motivo: 'credencial_invalida', detalhe }
    }
    return { motivo: 'resposta_inesperada', detalhe }
  }

  async testarConexao(): Promise<ResultadoPlataforma<{ nomeConta: string; moeda: string }>> {
    const r = await this.#consultar(this.#cred.loginCustomerId,
      'SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1')
    if (!r.ok) return r
    const c = (r.dados[0] as { customer?: { descriptiveName?: string; currencyCode?: string } } | undefined)?.customer
    return { ok: true, dados: { nomeConta: c?.descriptiveName ?? '', moeda: c?.currencyCode ?? 'BRL' } }
  }

  async lerEstrutura(contaExternaId: string): Promise<ResultadoPlataforma<EstruturaVeiculacao>> {
    // ⚠️ `status != 'REMOVED'` NÃO entra: anúncio removido continua tendo custo
    //    histórico, e escondê-lo faria o total do período não fechar.
    const campanhas = await this.#consultar(contaExternaId,
      'SELECT campaign.id, campaign.name, campaign.status FROM campaign')
    if (!campanhas.ok) return campanhas

    const grupos = await this.#consultar(contaExternaId,
      'SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.campaign FROM ad_group')
    if (!grupos.ok) return grupos

    const anuncios = await this.#consultar(contaExternaId,
      'SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad_group FROM ad_group_ad')
    if (!anuncios.ok) return anuncios

    return {
      ok: true,
      dados: {
        campanhas: campanhas.dados.map((l) => ({
          idExterno: l.campaign?.id ?? '',
          nome: l.campaign?.name ?? '',
          estado: traduzirEstado(l.campaign?.status),
          paiExternoId: null,
        })).filter((n) => n.idExterno !== ''),
        conjuntos: grupos.dados.map((l) => ({
          idExterno: l.adGroup?.id ?? '',
          nome: l.adGroup?.name ?? '',
          estado: traduzirEstado(l.adGroup?.status),
          paiExternoId: idDoRecurso(l.adGroup?.campaign),
        })).filter((n) => n.idExterno !== ''),
        anuncios: anuncios.dados.map((l) => ({
          idExterno: l.adGroupAd?.ad?.id ?? '',
          // Anúncio no Google costuma vir sem nome — cai no id, que é o que a
          // tela consegue mostrar sem mentir.
          nome: l.adGroupAd?.ad?.name ?? `Anúncio ${l.adGroupAd?.ad?.id ?? ''}`,
          estado: traduzirEstado(l.adGroupAd?.status),
          paiExternoId: idDoRecurso(l.adGroupAd?.adGroup),
        })).filter((n) => n.idExterno !== ''),
      },
    }
  }

  async lerMetricas(
    contaExternaId: string, periodo: PeriodoConsulta,
  ): Promise<ResultadoPlataforma<readonly MetricaDiaExterna[]>> {
    // ⚠️ `segments.date` é o que dá o GRÃO diário. Sem ele o Google devolve o
    //    período agregado numa linha só — e a tabela `midia_metrica_dia`, que é
    //    por dia, receberia um total carimbado num dia qualquer.
    const gaql = `
      SELECT ad_group_ad.ad.id, segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM ad_group_ad
       WHERE segments.date BETWEEN '${periodo.de}' AND '${periodo.ate}'`

    const r = await this.#consultar(contaExternaId, gaql)
    if (!r.ok) return r

    return {
      ok: true,
      dados: r.dados
        .filter((l) => l.adGroupAd?.ad?.id && l.segments?.date)
        .map((l) => ({
          anuncioExternoId: l.adGroupAd!.ad!.id!,
          dia: l.segments!.date!,
          // ⚠️ Contadores vêm como STRING no JSON do Google (são int64).
          impressoes: Number(l.metrics?.impressions ?? 0),
          cliques: Number(l.metrics?.clicks ?? 0),
          // ⚠️ A conversão de micros acontece AQUI, na borda. Micros não
          //    atravessam a porta (regra do porta.ts).
          custoCentavos: microsParaCentavos(Number(l.metrics?.costMicros ?? 0)),
          conversoesPlataforma: Math.round(l.metrics?.conversions ?? 0),
        })),
    }
  }

  async enviarConversao(
    _contaExternaId: string, _conversao: ConversaoParaEnvio,
  ): Promise<ResultadoPlataforma<{ idExterno: string | null }>> {
    // ⚠️ Coerente com `capacidades.conversaoOffline === false`: o despachante nem
    //    chega aqui — ele descarta antes, com motivo nomeado. Este retorno existe
    //    para que a incoerência, se alguém mexer na capacidade sem implementar,
    //    apareça como motivo tipificado em vez de `undefined` viajando.
    return {
      ok: false,
      motivo: 'resposta_inesperada',
      detalhe: 'Offline Conversion Import ainda não implementado no adaptador Google',
    }
  }
}
