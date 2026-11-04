import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { comTenantServico, sql } from '../../db/index.js'
import { exigirTenant } from '../../plugins/tenant.js'
import { auditar } from '../plataforma/auditoria.js'
import { atorDaRequisicao } from '../atendimento/rotas-fila.js'
import { criarLimiteTaxa } from '../aquisicao/limite-taxa.js'
import { chamarCognito, secretHash, type RespostaCognito } from './cognito-publico.js'
import { provedorSenhaCognito } from './provedor-senha-cognito.js'
import type { ProvedorSenha } from './provedor-senha.js'
import type { ProvedorIdentidade } from './provedor-identidade.js'
import { ipDoCliente } from '../../plugins/ip-cliente.js'

/**
 * Login server-side — porque o app client do Cognito é CONFIDENCIAL (tem secret).
 *
 * ⚠️ Um SPA no browser não pode logar direto num client com secret: o
 * `SECRET_HASH` exigiria o secret no navegador. Então o secret vive AQUI, no
 * servidor, e o browser só troca usuário/senha por um ID token. O ID token
 * (que carrega `custom:tenant_id`) é o que a API já valida no resto das rotas.
 *
 * ⚠️ Rotas PÚBLICAS (sem exigirTenant): login não tem tenant ainda — é o login
 * que o revela.
 */

/**
 * Monta a resposta de sucesso com o token e QUANDO ele expira (epoch ms), para o
 * cliente agendar a renovação ANTES de morrer. `refreshToken` só vem no login (o
 * fluxo de refresh não emite outro). ⚠️ ExpiresIn é do IdToken (~1h).
 */
function respostaOk(r: RespostaCognito['AuthenticationResult'], agora: number): { tipo: 'ok'; idToken: string; expiraEm: number; refreshToken?: string } {
  const expiraEm = agora + (r?.ExpiresIn ?? 3600) * 1000
  return r?.RefreshToken
    ? { tipo: 'ok', idToken: r.IdToken!, expiraEm, refreshToken: r.RefreshToken }
    : { tipo: 'ok', idToken: r!.IdToken!, expiraEm }
}

/** Erro cru do Cognito → mensagem que a tela pode mostrar. */
function traduzErro(r: RespostaCognito): string {
  const tipo = (r.__type ?? '').split('#').pop() ?? ''
  if (/NotAuthorized/i.test(tipo)) return 'Usuário ou senha incorretos.'
  // ⚠️ Mesma frase de NotAuthorized: "não encontrado" separado seria oráculo de existência de conta.
  if (/UserNotFound/i.test(tipo)) return 'Usuário ou senha incorretos.'
  if (/PasswordResetRequired/i.test(tipo)) return 'É preciso redefinir a senha no painel.'
  if (/InvalidParameter|InvalidPassword/i.test(tipo)) return r.message ?? 'Parâmetro inválido.'
  if (/Too?ManyRequests|LimitExceeded/i.test(tipo)) return 'Muitas tentativas — aguarde um instante.'
  return r.message ?? tipo ?? 'Falha ao entrar.'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Carimba `usuario.ultimo_login_em` (0111) — a coluna "último acesso" da lista
 * de usuários.
 *
 * ⚠️ O ID token acabou de chegar DO Cognito, nesta chamada, por TLS: não veio do
 *    cliente. Por isso o `sub` e o `custom:tenant_id` dele são lidos sem
 *    revalidar a assinatura — o tenant continua vindo de um token (ADR-001).
 * ⚠️ Melhor esforço: falhar aqui NUNCA derruba o login (é carimbo de exibição).
 *    Usuário que ainda não tem linha (antes do 1º batimento) não é criado aqui.
 */
async function registrarLogin(
  idToken: string, log: FastifyInstance['log'], ip: string, origem: 'senha' | 'nova_senha',
): Promise<void> {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    const sub = payload['sub']
    const tenantId = payload['custom:tenant_id']
    if (typeof sub !== 'string' || typeof tenantId !== 'string' || !UUID.test(tenantId)) return
    await comTenantServico(tenantId, async (tx) => {
      const [u] = await tx<{ id: string }[]>`
        UPDATE usuario SET ultimo_login_em = now()
         WHERE tenant_id = tenant_atual() AND cognito_sub = ${sub} RETURNING id`
      // D6/D4: o login entra na trilha no mesmo formato da auditoria v2 (ator, ação, entidade, dados).
      if (u) {
        await auditar(tx, { atorId: u.id, acao: 'usuario.login', entidade: 'usuario', entidadeId: u.id, dados: { ip, origem } })
      }
    })
  } catch (erro) {
    log.debug({ erro: erro instanceof Error ? erro.message : String(erro) }, 'ultimo_login_em nao gravado')
  }
}

// D4: limites por IP (`ipDoCliente`, que respeita `trustProxy` e o segredo do nginx) — em memória, por instância: freio contra
// abuso trivial; ataque distribuído é da borda. O pedido de código é mais restrito que a confirmação.
const limiteEsqueci = criarLimiteTaxa({ teto: 5, janelaMs: 15 * 60_000 })
const limiteRedefinir = criarLimiteTaxa({ teto: 10, janelaMs: 15 * 60_000 })

// Limites do login (B4): por IP (folgado — escritório inteiro sai por um IP) e por usuário (apertado).
const limiteLoginIp = criarLimiteTaxa({ teto: 60, janelaMs: 15 * 60_000 })
const limiteLoginUsuario = criarLimiteTaxa({ teto: 10, janelaMs: 15 * 60_000 })
const limiteLogout = criarLimiteTaxa({ teto: 30, janelaMs: 60_000 })
// ⚠️ Por E-MAIL (hash na chave — o e-mail não fica em memória nem em log): o NOSSO 429 tem de vir antes do
//    `LimitExceeded` do Cognito, que só aparece para quem existe e viraria oráculo. Igual para qualquer e-mail.
const limiteEsqueciEmail = criarLimiteTaxa({ teto: 3, janelaMs: 15 * 60_000 })
const limiteRedefinirEmail = criarLimiteTaxa({ teto: 3, janelaMs: 15 * 60_000 })
const chaveDoEmail = (email: string): string => createHash('sha256').update(email.trim().toLowerCase()).digest('hex')

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const MAX_SENHA = 256

export interface OpcoesRotasAuth {
  readonly provedorSenha?: ProvedorSenha
  /** Para encerrar as sessões depois da redefinição por código. Sem ele, só a senha muda. */
  readonly provedorIdentidade?: ProvedorIdentidade
}

export async function rotasAuth(app: FastifyInstance, opcoes: OpcoesRotasAuth = {}): Promise<void> {
  const provedorSenha = opcoes.provedorSenha ?? provedorSenhaCognito(app.log)
  const provedorIdentidade = opcoes.provedorIdentidade
  const clientId = process.env.COGNITO_CLIENT_ID
  const secret = process.env.COGNITO_CLIENT_SECRET
  const configurado = Boolean(clientId && secret)

  /**
   * Depois de redefinir por código: encerra as sessões antigas e deixa o rastro (`usuario.senha_redefinida`,
   * com IP). O usuário é achado por `lower(email)` pela função de serviço (a rota não tem tenant). Só age
   * quando há EXATAMENTE um — e nunca falha a redefinição, que já aconteceu.
   */
  const aposRedefinicao = async (email: string, ip: string): Promise<void> => {
    try {
      const achados = await sql<{ tenant_id: string; usuario_id: string; cognito_sub: string }[]>`
        SELECT tenant_id, usuario_id, cognito_sub FROM usuario_por_email(${email})`
      if (achados.length !== 1) return
      const u = achados[0]!
      if (provedorIdentidade) {
        const r = await provedorIdentidade.encerrarSessoes({ sub: u.cognito_sub, tenantId: u.tenant_id })
        if (r.tipo !== 'ok') app.log.warn({ resultado: r.tipo, contexto: 'identidade.senha' }, 'sessões não encerradas após redefinição')
      }
      await comTenantServico(u.tenant_id, (tx) => auditar(tx, {
        atorId: u.usuario_id, acao: 'usuario.senha_redefinida', entidade: 'usuario', entidadeId: u.usuario_id,
        dados: { ip, origem: 'esqueci_senha' },
      }))
    } catch (erro) {
      app.log.warn({ erro: erro instanceof Error ? erro.message : String(erro), contexto: 'identidade.senha' }, 'pós-redefinição falhou')
    }
  }

  app.post<{ Body: { usuario?: string; senha?: string } }>('/v1/auth/login', async (req, reply) => {
    if (!configurado) return reply.code(503).send({ tipo: 'erro', mensagem: 'Login indisponível: Cognito não configurado no servidor.' })
    const usuario = req.body?.usuario?.trim()
    const senha = req.body?.senha
    if (!usuario || !senha) return reply.code(400).send({ tipo: 'erro', mensagem: 'Usuário e senha são obrigatórios.' })
    if (!limiteLoginIp.permitir(ipDoCliente(req), Date.now()) || !limiteLoginUsuario.permitir(chaveDoEmail(usuario), Date.now())) {
      return reply.code(429).send({ tipo: 'erro', mensagem: 'Muitas tentativas. Aguarde alguns minutos.' })
    }

    const { status, corpo } = await chamarCognito('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: usuario, PASSWORD: senha, SECRET_HASH: secretHash(usuario, clientId!, secret!) },
    })

    const idToken = corpo.AuthenticationResult?.IdToken
    if (idToken) {
      await registrarLogin(idToken, req.log, ipDoCliente(req), 'senha')
      return reply.send(respostaOk(corpo.AuthenticationResult, Date.now()))
    }
    // Usuário criado pelo admin no primeiro acesso.
    if (corpo.ChallengeName === 'NEW_PASSWORD_REQUIRED' && corpo.Session) {
      return reply.send({ tipo: 'nova_senha', session: corpo.Session })
    }
    // Credencial errada é 401; config/flow é o status do Cognito.
    return reply.code(status === 200 ? 401 : status).send({ tipo: 'erro', mensagem: traduzErro(corpo) })
  })

  app.post<{ Body: { usuario?: string; novaSenha?: string; session?: string } }>('/v1/auth/nova-senha', async (req, reply) => {
    if (!configurado) return reply.code(503).send({ tipo: 'erro', mensagem: 'Login indisponível: Cognito não configurado no servidor.' })
    const usuario = req.body?.usuario?.trim()
    const novaSenha = req.body?.novaSenha
    const session = req.body?.session
    if (!usuario || !novaSenha || !session) return reply.code(400).send({ tipo: 'erro', mensagem: 'Dados incompletos para definir a nova senha.' })

    const { status, corpo } = await chamarCognito('RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ClientId: clientId,
      Session: session,
      ChallengeResponses: { USERNAME: usuario, NEW_PASSWORD: novaSenha, SECRET_HASH: secretHash(usuario, clientId!, secret!) },
    })

    const idToken = corpo.AuthenticationResult?.IdToken
    if (idToken) {
      await registrarLogin(idToken, req.log, ipDoCliente(req), 'nova_senha')
      return reply.send(respostaOk(corpo.AuthenticationResult, Date.now()))
    }
    return reply.code(status === 200 ? 400 : status).send({ tipo: 'erro', mensagem: traduzErro(corpo) })
  })

  /**
   * Renova o ID token ANTES de expirar, com o refresh token do Cognito — a sessão
   * não morre mais em ~1h (o cliente agenda a chamada). ⚠️ O SECRET_HASH do
   * REFRESH_TOKEN_AUTH é calculado com o USUÁRIO do login; por isso ele volta aqui.
   * O fluxo de refresh NÃO emite outro refresh token (mantém o mesmo, até ~30 dias).
   */
  app.post<{ Body: { refreshToken?: string; usuario?: string } }>('/v1/auth/refresh', async (req, reply) => {
    if (!configurado) return reply.code(503).send({ tipo: 'erro', mensagem: 'Login indisponível: Cognito não configurado no servidor.' })
    const refreshToken = req.body?.refreshToken
    const usuario = req.body?.usuario?.trim()
    if (!refreshToken || !usuario) return reply.code(400).send({ tipo: 'erro', mensagem: 'Refresh token e usuário são obrigatórios.' })

    const { status, corpo } = await chamarCognito('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken, SECRET_HASH: secretHash(usuario, clientId!, secret!) },
    })

    if (corpo.AuthenticationResult?.IdToken) return reply.send(respostaOk(corpo.AuthenticationResult, Date.now()))
    // Refresh token expirado/revogado → 401: o cliente cai para o login.
    return reply.code(status === 200 ? 401 : status).send({ tipo: 'erro', mensagem: traduzErro(corpo) })
  })
  /**
   * "Esqueci a senha" — pede o código por e-mail. ⚠️ A resposta é IGUAL para e-mail cadastrado e não
   * cadastrado (200 com a mesma frase): a tela não serve de oráculo de existência. Limite por IP.
   */
  app.post<{ Body: { usuario?: string } }>('/v1/auth/esqueci-senha', async (req, reply) => {
    if (!limiteEsqueci.permitir(ipDoCliente(req), Date.now())) {
      return reply.code(429).send({ erro: 'limite.excedido', mensagem: 'Muitas tentativas. Aguarde alguns minutos.' })
    }
    const email = req.body?.usuario?.trim().toLowerCase()
    if (!email || !EMAIL.test(email) || email.length > 254) {
      return reply.code(422).send({ erro: 'auth.email_invalido', mensagem: 'Informe um e-mail válido.' })
    }
    if (!limiteEsqueciEmail.permitir(chaveDoEmail(email), Date.now())) {
      return reply.code(429).send({ erro: 'limite.excedido', mensagem: 'Muitas tentativas. Aguarde alguns minutos.' })
    }
    const r = await provedorSenha.esqueciSenha(email)
    if (r.tipo === 'indisponivel') {
      return reply.code(503).send({ erro: 'auth.indisponivel', mensagem: 'Recuperação de senha indisponível no momento.' })
    }
    return reply.send({ tipo: 'ok', mensagem: 'Se o e-mail estiver cadastrado, enviamos um código para ele.' })
  })

  /** Confirma o código e define a nova senha. Código errado e e-mail sem pedido são a MESMA resposta. */
  app.post<{ Body: { usuario?: string; codigo?: string; novaSenha?: string } }>('/v1/auth/redefinir-senha', async (req, reply) => {
    if (!limiteRedefinir.permitir(ipDoCliente(req), Date.now())) {
      return reply.code(429).send({ erro: 'limite.excedido', mensagem: 'Muitas tentativas. Aguarde alguns minutos.' })
    }
    const email = req.body?.usuario?.trim().toLowerCase()
    const codigo = req.body?.codigo?.trim()
    const novaSenha = req.body?.novaSenha
    if (!email || !EMAIL.test(email) || !codigo || !/^\d{4,10}$/.test(codigo) || !novaSenha || novaSenha.length > MAX_SENHA) {
      return reply.code(422).send({ erro: 'auth.dados_invalidos', mensagem: 'Informe o e-mail, o código recebido e a nova senha.' })
    }
    if (!limiteRedefinirEmail.permitir(chaveDoEmail(email), Date.now())) {
      return reply.code(429).send({ erro: 'limite.excedido', mensagem: 'Muitas tentativas. Aguarde alguns minutos.' })
    }
    const r = await provedorSenha.confirmarEsqueciSenha(email, codigo, novaSenha)
    switch (r.tipo) {
      case 'ok':
        await aposRedefinicao(email, ipDoCliente(req))
        return reply.send({ tipo: 'ok' })
      case 'limite': // o limite do provedor é a MESMA resposta do código inválido
      case 'codigo_invalido': return reply.code(422).send({ erro: 'auth.codigo_invalido', mensagem: 'Código inválido. Confira o e-mail ou peça outro.' })
      case 'codigo_expirado': return reply.code(422).send({ erro: 'auth.codigo_expirado', mensagem: 'O código expirou. Peça outro.' })
      case 'senha_invalida': return reply.code(422).send({ erro: 'auth.senha_invalida', mensagem: r.mensagem, campos: { novaSenha: r.mensagem } })
      case 'indisponivel': return reply.code(503).send({ erro: 'auth.indisponivel', mensagem: 'Recuperação de senha indisponível no momento.' })
    }
  })

  /**
   * Saída registrada na trilha (D6/D4). O logout é do CLIENTE (descartar o token); isto só deixa o rastro.
   * Autenticada: o ator vem do token. Melhor esforço do lado do console — a saída local nunca espera.
   */
  app.post<{ Body: { refreshToken?: string } | undefined }>('/v1/auth/logout', { preHandler: exigirTenant }, async (req, reply) => {
    if (!limiteLogout.permitir(ipDoCliente(req), Date.now())) {
      return reply.code(429).send({ erro: 'limite.excedido', mensagem: 'Muitas tentativas. Aguarde um instante.' })
    }
    // Logout de verdade: revoga o refresh token no provedor (melhor esforço, fora de transação).
    const refresh = req.body?.refreshToken
    if (typeof refresh === 'string' && refresh.length > 0 && refresh.length < 4096) await provedorSenha.revogarSessao(refresh)
    await req.comTenant(async (tx) => {
      const atorId = await atorDaRequisicao(tx, req)
      await auditar(tx, {
        atorId, atorStaff: req.atorStaff ?? false,
        acao: 'usuario.logout', entidade: 'usuario', entidadeId: atorId, dados: { ip: ipDoCliente(req) },
      })
    })
    return reply.code(204).send()
  })
}
