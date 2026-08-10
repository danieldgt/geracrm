import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { Router } from '@angular/router'
import { AuthServico } from './auth.servico.js'

/**
 * Tela de login (produção). Usuário + senha via Cognito. Trata o primeiro
 * acesso (NEW_PASSWORD_REQUIRED) sem mandar ninguém para o painel da AWS.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <main class="tela">
      <form class="cartao" (ngSubmit)="enviar()">
        <h1>GeraCRM</h1>
        <p class="sub">Entre para acessar o atendimento.</p>

        <label>Usuário
          <input name="usuario" [ngModel]="usuario()" (ngModelChange)="usuario.set($event)"
                 autocomplete="username" [disabled]="ocupado()" />
        </label>

        @if (!exigeNovaSenha()) {
          <label>Senha
            <input name="senha" type="password" [ngModel]="senha()" (ngModelChange)="senha.set($event)"
                   autocomplete="current-password" [disabled]="ocupado()" />
          </label>
        } @else {
          <p class="aviso">Primeiro acesso — defina uma nova senha.</p>
          <label>Nova senha
            <input name="novaSenha" type="password" [ngModel]="novaSenha()" (ngModelChange)="novaSenha.set($event)"
                   autocomplete="new-password" [disabled]="ocupado()" />
          </label>
        }

        @if (erro()) { <p class="erro">{{ erro() }}</p> }

        <button type="submit" [disabled]="ocupado()">
          {{ ocupado() ? 'Entrando…' : (exigeNovaSenha() ? 'Definir e entrar' : 'Entrar') }}
        </button>
      </form>
    </main>
  `,
  styles: [`
    .tela { min-height: 100dvh; display: grid; place-items: center; background: var(--fundo); padding: var(--espacamento-6); }
    .cartao { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: var(--espacamento-3);
      background: var(--superficie-elevada); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); padding: var(--espacamento-8); box-shadow: var(--elevacao-modal); }
    h1 { margin: 0; font-size: var(--tipografia-escala-titulo-tamanho); font-weight: var(--tipografia-escala-titulo-peso);
      letter-spacing: var(--tipografia-escala-titulo-tracking); color: var(--marca); }
    .sub { margin: 0 0 var(--espacamento-1); color: var(--texto-secundario); font-size: 14px; }
    label { display: flex; flex-direction: column; gap: var(--espacamento-2); font-size: 13px; color: var(--texto); }
    input { padding: var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--fundo); color: var(--texto); font: inherit; font-size: 15px; }
    input:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    button { margin-top: var(--espacamento-2); padding: var(--espacamento-3); border: 0; border-radius: var(--raio-controle); cursor: pointer;
      background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 15px; font-weight: 600; }
    button:hover:not(:disabled) { background: var(--acao-hover); }
    button:disabled { opacity: .6; cursor: default; }
    .erro { color: var(--erro); font-size: 13px; margin: 0; }
    .aviso { color: var(--texto-suave); font-size: 13px; margin: 0; }
  `],
})
export class LoginPagina {
  private readonly auth = inject(AuthServico)
  private readonly router = inject(Router)

  readonly usuario = signal('')
  readonly senha = signal('')
  readonly novaSenha = signal('')
  readonly erro = signal<string | null>(null)
  readonly ocupado = signal(false)
  readonly exigeNovaSenha = signal(false)
  private session: string | null = null

  async enviar(): Promise<void> {
    if (this.ocupado()) return
    this.erro.set(null)
    this.ocupado.set(true)
    try {
      const r = this.exigeNovaSenha() && this.session
        ? await this.auth.definirNovaSenha(this.usuario(), this.novaSenha(), this.session)
        : await this.auth.entrar(this.usuario(), this.senha())

      if (r.tipo === 'ok') {
        await this.router.navigateByUrl('/')
      } else if (r.tipo === 'nova_senha') {
        this.session = r.session
        this.exigeNovaSenha.set(true)
      } else {
        this.erro.set(r.mensagem)
      }
    } catch {
      this.erro.set('Não foi possível falar com o servidor de login.')
    } finally {
      this.ocupado.set(false)
    }
  }
}
