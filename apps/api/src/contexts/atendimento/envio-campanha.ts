import { randomUUID } from 'node:crypto'
import { normalizarTelefone, variaveisDoCorpo, type CampoMapeamento } from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../db/index.js'
import { decifrar } from '../integracao/cofre.js'
import { criarCanal } from './canais/fabrica.js'
import { avaliarEnvio, enviarPeloGateway, type ContextoEnvio } from './canais/gateway.js'
import type { ClasseFalha } from './envio-conversa.js'

/**
 * ENVIO DE CAMPANHA V2 (F1) — template aprovado (oficial) ou texto livre (não oficial)
 * para UM contato, pelo GATEWAY ÚNICO.
 *
 * ⚠️ Irmão de `enviarTextoParaContato` (legado) e de `enviarTemplateNaConversa`, com
 *    três diferenças que são a razão de existir:
 *    1. Template com VÁRIAS variáveis, preenchidas pelo mapeamento `{{n}} -> campo` da F2.
 *       Variável sem valor é recusa NOSSA (`variavel_sem_valor`): mandar "Olá, !" é pior
 *       que não mandar.
 *    2. A decisão do gateway é avaliada ANTES de gravar qualquer coisa: opt-out, pausa e
 *       canal fora não criam conversa nem mensagem fantasma na thread do contato.
 *       O gateway reavalia de novo no despacho (a porta continua única).
 *    3. A mensagem nasce com `campanha_id` e `template_id` — é o que o Consumo (F2) usa
 *       para o custo por campanha e por categoria.
 * ⚠️ O opt-out vale para QUALQUER telefone do contato e para `recebe_campanhas = false`,
 *    não só o principal: quem pediu para parar pediu para a pessoa.
 */

export interface TemplateCampanha {
  readonly id: string
  readonly nome: string
  readonly idioma: string
  readonly categoria: string
  readonly versao: number
  /** Corpo (body) da versão APROVADA. */
  readonly corpo: string
  readonly variaveis: readonly number[]
  readonly mapeamento: Readonly<Record<string, string>>
}

export type ResultadoTemplateCampanha =
  | { estado: 'ok'; template: TemplateCampanha }
  | { estado: 'nao_encontrado' }
  | { estado: 'categoria_invalida'; categoria: string }
  | { estado: 'nao_aprovado' }
  | { estado: 'sem_mapeamento'; faltando: readonly number[] }
  | { estado: 'cabecalho_com_variavel' }

/**
 * O template serve para campanha? MARKETING, com versão APROVADA, sem variável no
 * cabeçalho (o adaptador só preenche o corpo) e com TODAS as variáveis do corpo mapeadas.
 * Sob tenant (RLS).
 */
export async function carregarTemplateCampanha(tx: Sql, templateId: string): Promise<ResultadoTemplateCampanha> {
  const [t] = await tx<{
    id: string; nome: string; idioma: string; categoria: string; mapeamento: Record<string, string> | null
    versao: number | null; corpo: { header?: { texto?: string }; body?: { texto?: string } } | null
  }[]>`
    SELECT t.id, t.nome, t.idioma, t.categoria, t.mapeamento_variaveis AS mapeamento, tv.versao, tv.corpo
      FROM template t
      LEFT JOIN template_versao tv ON tv.tenant_id = t.tenant_id AND tv.template_id = t.id AND tv.status_meta = 'APPROVED'
     WHERE t.tenant_id = tenant_atual() AND t.id = ${templateId}`
  if (!t) return { estado: 'nao_encontrado' }
  if (t.categoria !== 'MARKETING') return { estado: 'categoria_invalida', categoria: t.categoria }
  if (t.versao === null || !t.corpo) return { estado: 'nao_aprovado' }
  if (variaveisDoCorpo(t.corpo.header?.texto ?? '').length > 0) return { estado: 'cabecalho_com_variavel' }
  const corpo = t.corpo.body?.texto ?? ''
  const variaveis = variaveisDoCorpo(corpo)
  const mapeamento = t.mapeamento ?? {}
  const faltando = variaveis.filter((n) => !mapeamento[String(n)])
  if (faltando.length > 0) return { estado: 'sem_mapeamento', faltando }
  return {
    estado: 'ok',
    template: { id: t.id, nome: t.nome, idioma: t.idioma, categoria: t.categoria, versao: t.versao, corpo, variaveis, mapeamento },
  }
}

/** Os valores que um contato dá aos campos do mapeamento. `null` = sem valor. */
interface ValoresContato {
  readonly nome: string | null
  readonly nome_fantasia: string | null
  readonly razao_social: string | null
  readonly email: string | null
  readonly vendedor: string | null
  readonly empresa: string | null
}

const limpo = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null)

/**
 * Valor de um campo, com o recuo que não muda o sentido: nome fantasia ↔ razão social
 * ↔ nome; vendedor sem carteira → nome da empresa. E-mail não tem recuo: não existe
 * "outro e-mail" honesto.
 */
export function valorDoCampo(campo: CampoMapeamento | string, v: ValoresContato): string | null {
  switch (campo) {
    case 'contato.nome': return limpo(v.nome)
    case 'contato.nome_fantasia': return limpo(v.nome_fantasia) ?? limpo(v.razao_social) ?? limpo(v.nome)
    case 'contato.razao_social': return limpo(v.razao_social) ?? limpo(v.nome_fantasia) ?? limpo(v.nome)
    case 'contato.email': return limpo(v.email)
    case 'vendedor.nome': return limpo(v.vendedor) ?? limpo(v.empresa)
    case 'empresa.nome': return limpo(v.empresa)
    default: return null
  }
}

/** Variáveis na ordem `{{1}}, {{2}}…` e o corpo renderizado, ou a primeira sem valor. */
export function preencherTemplate(
  tpl: TemplateCampanha, valores: ValoresContato,
): { ok: true; variaveis: string[]; renderizado: string } | { ok: false; variavel: number } {
  const porNumero = new Map<number, string>()
  for (const n of tpl.variaveis) {
    const valor = valorDoCampo(tpl.mapeamento[String(n)] ?? '', valores)
    if (valor === null) return { ok: false, variavel: n }
    porNumero.set(n, valor)
  }
  const renderizado = tpl.corpo.replace(/\{\{\s*(\d{1,2})\s*\}\}/g, (todo, n: string) => porNumero.get(Number(n)) ?? todo)
  return { ok: true, variaveis: tpl.variaveis.map((n) => porNumero.get(n)!), renderizado }
}

async function valoresDoContato(tx: Sql, contatoId: string): Promise<ValoresContato | null> {
  const [v] = await tx<ValoresContato[]>`
    SELECT c.nome, c.nome_fantasia, c.razao_social, c.email,
           (SELECT u.nome FROM carteira_atribuicao ca
              JOIN usuario u ON u.tenant_id = ca.tenant_id AND u.id = ca.usuario_id
             WHERE ca.tenant_id = c.tenant_id AND ca.contato_id = c.id AND ca.ate IS NULL
             ORDER BY ca.de DESC LIMIT 1) AS vendedor,
           (SELECT t.nome FROM tenant t WHERE t.id = c.tenant_id) AS empresa
      FROM contato c WHERE c.tenant_id = tenant_atual() AND c.id = ${contatoId}`
  return v ?? null
}

interface CanalDoEnvio {
  provedor: string | null; cred: Uint8Array | null; tipo: string; estado: string; arquivado: boolean; disparoPausado: boolean
}

async function lerCanal(tx: Sql, canalId: string): Promise<CanalDoEnvio | null> {
  const [c] = await tx<CanalDoEnvio[]>`
    SELECT cc.provedor, cc.credenciais_cifradas AS cred, cc.tipo, cc.estado,
           (cc.arquivado_em IS NOT NULL) AS arquivado, coalesce(cfg.disparo_pausado, false) AS "disparoPausado"
      FROM canal_conectado cc
      LEFT JOIN canal_configuracao cfg ON cfg.tenant_id = cc.tenant_id AND cfg.canal_id = cc.id
     WHERE cc.tenant_id = tenant_atual() AND cc.id = ${canalId}`
  return c ?? null
}

function contextoDoGateway(canal: CanalDoEnvio, bloqueado: boolean, ehTemplate: boolean, ultimaEntranteEm: Date | null): ContextoEnvio {
  return {
    tipoCanal: canal.tipo, estadoCanal: canal.estado, provedor: canal.provedor, canalArquivado: canal.arquivado,
    temCredencial: !!canal.cred, destinoBloqueado: bloqueado, ehTemplate, ultimaEntranteEm,
    // ⚠️ Campanha é o caso de livro da pausa de disparo: tráfego em massa iniciado por nós.
    ehDisparo: true, disparoPausado: canal.disparoPausado,
  }
}

export interface PedidoEnvioCampanha {
  readonly campanhaId: string
  readonly canalId: string
  readonly contatoId: string
  /** Template (oficial). Exclusivo com `texto`. */
  readonly templateId: string | null
  /** Texto livre (não oficial). */
  readonly texto: string | null
}

export type ResultadoEnvioCampanha =
  | { ok: true; conversaId: string; mensagemId: string; idExterno: string }
  | { ok: false; classe: ClasseFalha; motivo: string; conversaId?: string; mensagemId?: string }

export interface DepsEnvioCampanha {
  readonly criar?: typeof criarCanal | undefined
}

/**
 * Envia a campanha a UM contato. Roda como serviço (`comTenantServico`): o tenant
 * vem do despachante, nunca de parâmetro de cliente.
 */
export async function enviarCampanhaParaContato(
  tenantId: string, p: PedidoEnvioCampanha, agora: Date, deps: DepsEnvioCampanha = {},
): Promise<ResultadoEnvioCampanha> {
  type Preparo = {
    canal: CanalDoEnvio; destino: string; conversaId: string; mensagemId: string
    ctx: ContextoEnvio; template: { nome: string; idioma: string; variaveis: string[] } | null
  }
  type Falha = { ok: false; classe: ClasseFalha; motivo: string }

  const preparo = await comTenantServico(tenantId, async (tx): Promise<Preparo | Falha> => {
    const canal = await lerCanal(tx, p.canalId)
    if (!canal) return { ok: false, classe: 'alvo', motivo: 'canal_nao_encontrado' }
    const [alvo] = await tx<{ destino: string | null; bloqueado: boolean; conversaId: string | null; ultimaEntranteEm: Date | null }[]>`
      SELECT (SELECT ct.e164 FROM contato_telefone ct
               WHERE ct.tenant_id = c.tenant_id AND ct.contato_id = c.id AND ct.principal
                 AND ct.whatsapp IS DISTINCT FROM false) AS destino,
             (NOT c.recebe_campanhas OR NOT c.ativo OR EXISTS (
                SELECT 1 FROM contato_telefone ot
                  JOIN lista_bloqueio lb ON lb.tenant_id = ot.tenant_id AND lb.chave_bloqueio = ot.chave_bloqueio
                 WHERE ot.tenant_id = c.tenant_id AND ot.contato_id = c.id)) AS bloqueado,
             cv.id AS "conversaId", cv.ultima_entrante_em AS "ultimaEntranteEm"
        FROM contato c
        LEFT JOIN conversa cv ON cv.tenant_id = c.tenant_id AND cv.canal_id = ${p.canalId} AND cv.contato_id = c.id
       WHERE c.tenant_id = tenant_atual() AND c.id = ${p.contatoId}`
    if (!alvo) return { ok: false, classe: 'alvo', motivo: 'contato_nao_encontrado' }
    if (!alvo.destino) return { ok: false, classe: 'alvo', motivo: 'sem_telefone' }

    let template: Preparo['template'] = null
    let texto = p.texto ?? ''
    if (p.templateId) {
      const r = await carregarTemplateCampanha(tx, p.templateId)
      // ⚠️ Template pausado/desativado pela Meta entre o iniciar e o envio: recusa NOSSA,
      //    nunca uma chamada que a Meta recusaria (e cobraria a reputação do número).
      if (r.estado !== 'ok') return { ok: false, classe: 'recusa', motivo: 'template_indisponivel' }
      const valores = await valoresDoContato(tx, p.contatoId)
      const preenchido = valores ? preencherTemplate(r.template, valores) : { ok: false as const, variavel: 0 }
      if (!preenchido.ok) return { ok: false, classe: 'recusa', motivo: 'variavel_sem_valor' }
      template = { nome: r.template.nome, idioma: r.template.idioma, variaveis: preenchido.variaveis }
      texto = preenchido.renderizado
    }

    const ctx = contextoDoGateway(canal, alvo.bloqueado, template !== null, alvo.ultimaEntranteEm)
    const decisao = avaliarEnvio(ctx, agora)
    if (!decisao.libera) return { ok: false, classe: 'recusa', motivo: decisao.motivo }

    let conversaId = alvo.conversaId
    if (!conversaId) {
      conversaId = randomUUID()
      await tx`
        INSERT INTO conversa (tenant_id, id, canal_id, contato_id, ultima_mensagem_em, ultima_direcao, versao)
        VALUES (tenant_atual(), ${conversaId}, ${p.canalId}, ${p.contatoId}, now(), 'saliente', 1)`
    }
    const mensagemId = randomUUID()
    await tx`
      INSERT INTO mensagem (tenant_id, id, conversa_id, direcao, tipo, conteudo, status, status_ordem, campanha_id, template_id)
      VALUES (tenant_atual(), ${mensagemId}, ${conversaId}, 'saliente', 'texto',
              ${JSON.stringify({
                texto,
                campanha: { id: p.campanhaId },
                ...(template && p.templateId ? { template: { id: p.templateId, nome: template.nome, idioma: template.idioma } } : {}),
              })}::text::jsonb,
              'pendente', 0, ${p.campanhaId}, ${p.templateId})`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET ultima_mensagem_em = now(), ultima_direcao = 'saliente', versao = versao + 1
       WHERE tenant_id = tenant_atual() AND id = ${conversaId} RETURNING versao`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.enviada', 'conversa', ${conversaId},
              ${JSON.stringify({ conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
    return { canal, destino: alvo.destino, conversaId, mensagemId, ctx, template }
  })
  if ('ok' in preparo) return preparo

  const r = await enviarPeloGateway(preparo.ctx, agora, async () => {
    const canal = (deps.criar ?? criarCanal)(preparo.canal.provedor!, decifrar(Buffer.from(preparo.canal.cred!)))
    if (preparo.template) {
      if (!canal.enviarTemplate) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'canal não envia template' }
      return canal.enviarTemplate(preparo.destino, preparo.template)
    }
    // ⚠️ Sem cabeçalho de atendente: a campanha é da empresa.
    return canal.enviarTexto(preparo.destino, p.texto ?? '')
  })

  await comTenantServico(tenantId, async (tx) => {
    await tx`UPDATE mensagem SET status = ${r.ok ? 'enviada' : 'falhou'}, status_ordem = 1,
                    id_externo = ${r.ok ? r.idExterno : null}
              WHERE tenant_id = tenant_atual() AND id = ${preparo.mensagemId}`
    const [conv] = await tx<{ versao: string }[]>`
      UPDATE conversa SET versao = versao + 1 WHERE tenant_id = tenant_atual() AND id = ${preparo.conversaId} RETURNING versao`
    await tx`
      INSERT INTO outbox (tenant_id, tipo, agregado, agregado_id, payload)
      VALUES (tenant_atual(), 'mensagem.status', 'conversa', ${preparo.conversaId},
              ${JSON.stringify({ conversaId: preparo.conversaId, versao: Number(conv?.versao ?? 0) })}::text::jsonb)`
  })

  return r.ok
    ? { ok: true, conversaId: preparo.conversaId, mensagemId: preparo.mensagemId, idExterno: r.idExterno }
    : { ok: false, classe: r.classe, motivo: r.motivo, conversaId: preparo.conversaId, mensagemId: preparo.mensagemId }
}

// ─────────────────────────────────────────────────────────────────────────────
// Envio de TESTE (até 5 números, fora do lote)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResultadoTeste {
  readonly telefone: string
  readonly ok: boolean
  /** Recusa ou falha: `bloqueado` (opt-out), `telefone_invalido`, motivo do gateway/provedor. */
  readonly motivo?: string
}

/**
 * Envia o conteúdo da campanha a números de TESTE. Sem destinatário de campanha, sem
 * conversa e sem mensagem gravada: é conferência de quem monta, não alcance — e não
 * conta no lote nem no relatório. ⚠️ O opt-out vale do mesmo jeito: número na lista de
 * bloqueio não recebe nem teste. Variáveis: do contato dono do número, se houver; senão
 * o nome da empresa e "Cliente" (nunca `{{1}}` cru).
 */
export async function enviarTesteCampanha(
  tenantId: string,
  p: { canalId: string; templateId: string | null; texto: string | null; telefones: readonly string[] },
  agora: Date,
  deps: DepsEnvioCampanha = {},
): Promise<ResultadoTeste[]> {
  const resultados: ResultadoTeste[] = []
  for (const bruto of p.telefones) {
    const tel = normalizarTelefone(bruto)
    if (!tel) { resultados.push({ telefone: bruto, ok: false, motivo: 'telefone_invalido' }); continue }

    const preparo = await comTenantServico(tenantId, async (tx) => {
      const canal = await lerCanal(tx, p.canalId)
      if (!canal) return { erro: 'canal_nao_encontrado' as const }
      const [b] = await tx<{ bloqueado: boolean; contatoId: string | null }[]>`
        SELECT EXISTS (SELECT 1 FROM lista_bloqueio WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio}) AS bloqueado,
               (SELECT contato_id FROM contato_telefone WHERE tenant_id = tenant_atual() AND chave_bloqueio = ${tel.chaveBloqueio}
                 ORDER BY principal DESC LIMIT 1) AS "contatoId"`
      let template: { nome: string; idioma: string; variaveis: string[] } | null = null
      if (p.templateId) {
        const r = await carregarTemplateCampanha(tx, p.templateId)
        if (r.estado !== 'ok') return { erro: 'template_indisponivel' as const }
        const doContato = b?.contatoId ? await valoresDoContato(tx, b.contatoId) : null
        const [emp] = await tx<{ nome: string | null }[]>`SELECT nome FROM tenant WHERE id = tenant_atual()`
        const valores: ValoresContato = doContato ?? {
          nome: 'Cliente', nome_fantasia: null, razao_social: null, email: null, vendedor: null, empresa: emp?.nome ?? null,
        }
        const preenchido = preencherTemplate(r.template, valores)
        if (!preenchido.ok) return { erro: 'variavel_sem_valor' as const }
        template = { nome: r.template.nome, idioma: r.template.idioma, variaveis: preenchido.variaveis }
      }
      return { canal, bloqueado: b?.bloqueado ?? false, template }
    })
    if ('erro' in preparo) { resultados.push({ telefone: tel.e164, ok: false, motivo: preparo.erro }); continue }

    const ctx = contextoDoGateway(preparo.canal, preparo.bloqueado, preparo.template !== null, null)
    const r = await enviarPeloGateway(ctx, agora, async () => {
      const canal = (deps.criar ?? criarCanal)(preparo.canal.provedor!, decifrar(Buffer.from(preparo.canal.cred!)))
      if (preparo.template) {
        if (!canal.enviarTemplate) return { ok: false, motivo: 'resposta_inesperada', detalhe: 'canal não envia template' }
        return canal.enviarTemplate(tel.e164, preparo.template)
      }
      return canal.enviarTexto(tel.e164, p.texto ?? '')
    })
    resultados.push(r.ok ? { telefone: tel.e164, ok: true } : { telefone: tel.e164, ok: false, motivo: r.motivo })
  }
  return resultados
}
