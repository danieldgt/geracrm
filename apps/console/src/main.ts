import { bootstrapApplication } from '@angular/platform-browser'
import { provideZonelessChangeDetection, Component, ChangeDetectionStrategy, inject } from '@angular/core'
import {
  provideHttpClient, withFetch, withInterceptors, type HttpInterceptorFn, HttpErrorResponse,
} from '@angular/common/http'
import { tap } from 'rxjs'
import { provideRouter, withComponentInputBinding, RouterOutlet, Router } from '@angular/router'
import { ROTAS } from './app/rotas.js'
import { AuthServico, ehProducao } from './app/nucleo/auth.servico.js'

/**
 * Raiz MÍNIMA — só o ponto de entrada do roteador.
 *
 * ⚠️ A casca (menu + conteúdo) NÃO é a raiz: ela é o layout da rota `''` em
 * rotas.ts. Se a raiz fosse o próprio Shell E o Shell também fosse a rota `''`,
 * o router-outlet da casca renderizaria OUTRA casca — dois menus na tela. A
 * raiz é só `<router-outlet>`; o Shell aparece uma vez, dentro dele.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class Raiz {}

/**
 * Identidade em toda chamada à API. Dois mundos (ADR-001):
 *  - PRODUÇÃO: `Authorization: Bearer <ID token do Cognito>` — o tenant vem do
 *    `custom:tenant_id` do token, validado na API. Sem token, 401 → login.
 *  - DEV (localhost): `x-tenant-id` de dogfooding, que a API só aceita fora de
 *    produção. Sem login, para não atrapalhar o desenvolvimento.
 */
const TENANT_DOGFOODING = '6e7a0d00-0000-4000-8000-000000000001'
const injetarIdentidade: HttpInterceptorFn = (req, next) => {
  // Só anexa nas chamadas à nossa API; requests ao IDP do Cognito passam limpas.
  if (!req.url.startsWith('/v1')) return next(req)

  if (!ehProducao()) {
    return next(req.clone({ setHeaders: { 'x-tenant-id': TENANT_DOGFOODING } }))
  }

  // inject() só vale no contexto síncrono do interceptor — captura aqui, usa no callback.
  const auth = inject(AuthServico)
  const router = inject(Router)
  const token = auth.idToken()
  const autenticada = token
    ? req.clone({ setHeaders: { authorization: `Bearer ${token}` } })
    : req

  return next(autenticada).pipe(
    tap({
      error: (e: unknown) => {
        // Token expirado/rejeitado: encerra a sessão e volta ao login.
        if (e instanceof HttpErrorResponse && e.status === 401) {
          auth.sair()
          void router.navigateByUrl('/login')
        }
      },
    }),
  )
}

void bootstrapApplication(Raiz, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(ROTAS, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([injetarIdentidade])),
  ],
})
