import { chamarCognito, secretHash, tipoDoErro, type RespostaCognito } from './cognito-publico.js'
import type {
  ProvedorSenha, ResultadoEsqueciSenha, ResultadoRedefinicao, ResultadoTrocaSenha,
} from './provedor-senha.js'

/**
 * Adaptador Cognito da porta `ProvedorSenha`, pela API pública do app client confidencial
 * (`SECRET_HASH`) — mesma configuração do login, sem credencial IAM.
 *
 * ⚠️ `ChangePassword` exige o ACCESS token da pessoa, que o login do console não guarda. Em vez de
 *    carregar um segundo token no navegador, o adaptador confirma a senha atual com um
 *    `InitiateAuth` (USER_PASSWORD_AUTH) e usa o access token dessa chamada na hora — e só nela.
 * ⚠️ `ForgotPassword` engole TODO erro do provedor (usuário inexistente, e-mail não verificado, limite):
 *    a resposta é a mesma para quem existe e para quem não existe.
 */

const configurado = () => Boolean(process.env.COGNITO_CLIENT_ID && process.env.COGNITO_CLIENT_SECRET)

const credenciais = (email: string) => {
  const clientId = process.env.COGNITO_CLIENT_ID!
  return { clientId, hash: secretHash(email, clientId, process.env.COGNITO_CLIENT_SECRET!) }
}

const mensagemPolitica = (r: RespostaCognito): string =>
  r.message ?? 'A nova senha não atende à política de senhas.'

const ehLimite = (t: string): boolean => /Too?ManyRequests|LimitExceeded|TooManyFailedAttempts/i.test(t)

type Log = { warn: (o: object, msg: string) => void }

/** Avisa que o provedor respondeu algo que não esperávamos — só o TIPO do erro, nunca e-mail nem senha. */
const avisar = (log: Log | undefined, operacao: string, tipo: string): void =>
  log?.warn({ operacao, tipoErro: tipo || 'desconhecido', contexto: 'identidade.senha' }, 'provedor de senha respondeu erro inesperado')

export function provedorSenhaCognito(log?: Log): ProvedorSenha {
  return {
    async trocarSenha(emailBruto, senhaAtual, novaSenha): Promise<ResultadoTrocaSenha> {
      if (!configurado()) return { tipo: 'indisponivel' }
      const email = emailBruto.trim().toLowerCase()
      const { clientId, hash } = credenciais(email)
      const auth = await chamarCognito('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: senhaAtual, SECRET_HASH: hash },
      })
      const acesso = auth.corpo.AuthenticationResult?.AccessToken
      if (!acesso) {
        const t = tipoDoErro(auth.corpo)
        if (ehLimite(t)) return { tipo: 'limite' }
        // ⚠️ Desafio (senha temporária, MFA) NÃO é "senha atual incorreta": a senha pode estar certa.
        if (auth.corpo.ChallengeName || /PasswordResetRequired/i.test(t)) return { tipo: 'desafio' }
        if (/NotAuthorized|UserNotFound/i.test(t)) return { tipo: 'senha_atual_errada' }
        avisar(log, 'trocar_senha.autenticar', t)
        return { tipo: 'indisponivel' }
      }
      const r = await chamarCognito('ChangePassword', {
        AccessToken: acesso, PreviousPassword: senhaAtual, ProposedPassword: novaSenha,
      })
      if (r.status === 200 && !r.corpo.__type) {
        // ⚠️ Trocar a senha NÃO derrubava as outras sessões: quem tinha a senha antiga (ou um token
        //    roubado) seguia dentro. GlobalSignOut com o access token em mãos revoga todos os refresh
        //    tokens da pessoa — inclusive o desta sessão (o console manda entrar de novo).
        const saiu = await chamarCognito('GlobalSignOut', { AccessToken: acesso })
        if (saiu.status !== 200) avisar(log, 'trocar_senha.global_sign_out', tipoDoErro(saiu.corpo))
        return { tipo: 'ok' }
      }
      const t = tipoDoErro(r.corpo)
      if (/InvalidPassword|InvalidParameter/i.test(t)) return { tipo: 'senha_invalida', mensagem: mensagemPolitica(r.corpo) }
      if (/NotAuthorized/i.test(t)) return { tipo: 'senha_atual_errada' }
      if (ehLimite(t)) return { tipo: 'limite' }
      avisar(log, 'trocar_senha.change_password', t)
      return { tipo: 'indisponivel' }
    },

    async esqueciSenha(emailBruto): Promise<ResultadoEsqueciSenha> {
      if (!configurado()) return { tipo: 'indisponivel' }
      const email = emailBruto.trim().toLowerCase()
      const { clientId, hash } = credenciais(email)
      try {
        const r = await chamarCognito('ForgotPassword', { ClientId: clientId, Username: email, SecretHash: hash })
        const t = tipoDoErro(r.corpo)
        // UserNotFound e limite são o dia a dia (e não podem aparecer diferente): só o resto vira aviso.
        if (t && !/UserNotFound|Too?ManyRequests|LimitExceeded/i.test(t)) avisar(log, 'esqueci_senha', t)
      } catch {
        // rede: mesma resposta — não dá para distinguir de "usuário inexistente" sem vazar.
      }
      return { tipo: 'ok' }
    },

    async confirmarEsqueciSenha(emailBruto, codigo, novaSenha): Promise<ResultadoRedefinicao> {
      if (!configurado()) return { tipo: 'indisponivel' }
      const email = emailBruto.trim().toLowerCase()
      const { clientId, hash } = credenciais(email)
      const r = await chamarCognito('ConfirmForgotPassword', {
        ClientId: clientId, Username: email, ConfirmationCode: codigo, Password: novaSenha, SecretHash: hash,
      })
      if (r.status === 200 && !r.corpo.__type) return { tipo: 'ok' }
      const t = tipoDoErro(r.corpo)
      if (/CodeMismatch|UserNotFound|NotAuthorized/i.test(t)) return { tipo: 'codigo_invalido' }
      if (/ExpiredCode/i.test(t)) return { tipo: 'codigo_expirado' }
      if (/InvalidPassword/i.test(t)) return { tipo: 'senha_invalida', mensagem: mensagemPolitica(r.corpo) }
      // ⚠️ Limite do provedor e erro desconhecido caem na MESMA resposta do código inválido: um 429/5xx só
      //    para quem existe seria oráculo. O tipo vai para o log (sem e-mail).
      if (!ehLimite(t)) avisar(log, 'redefinir_senha', t)
      return { tipo: 'codigo_invalido' }
    },

    async revogarSessao(refreshToken): Promise<void> {
      if (!configurado()) return
      try {
        await chamarCognito('RevokeToken', {
          Token: refreshToken, ClientId: process.env.COGNITO_CLIENT_ID!, ClientSecret: process.env.COGNITO_CLIENT_SECRET!,
        })
      } catch { /* melhor esforço: o token expira sozinho */ }
    },
  }
}
