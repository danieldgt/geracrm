import { inject } from '@angular/core'
import { Router, type CanActivateFn } from '@angular/router'
import { AuthServico, ehProducao } from './auth.servico.js'

/**
 * Barra a casca quando não há sessão — só em PRODUÇÃO.
 *
 * ⚠️ Em desenvolvimento (localhost) não exige login: a API aceita `x-tenant-id`
 * de dogfooding. Em produção, sem ID token do Cognito, manda para `/login`.
 */
export const guardaAuth: CanActivateFn = () => {
  if (!ehProducao()) return true
  const auth = inject(AuthServico)
  if (auth.autenticado()) return true
  return inject(Router).parseUrl('/login')
}
