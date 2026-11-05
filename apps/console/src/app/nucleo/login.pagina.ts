import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { Router } from '@angular/router'
import { AuthServico } from './auth.servico.js'
import { MarcaComponente } from '../compartilhado/ui/marca.componente.js'
import { errosDaRedefinicao, errosDoEmail, type EtapaLogin } from './login.regras.js'

/**
 * Tela de login (produção). Usuário + senha via Cognito. Trata o primeiro
 * acesso (NEW_PASSWORD_REQUIRED) sem mandar ninguém para o painel da AWS.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MarcaComponente],
  template: `
    <main class="tela">
      <form class="cartao" (ngSubmit)="enviar()" autocomplete="off">
        <div class="cabeca">
          <app-marca class="logo" [rotulo]="true" />
          <p class="sub">Atendimento e recompra, num só lugar.</p>
        </div>

        @switch (etapa()) {
          @case ('esqueci_email') {
            <p class="aviso">Informe o e-mail do seu cadastro. Se ele existir, enviamos um código para redefinir a senha.</p>
            <label>E-mail
              <input name="usuario" type="email" [ngModel]="usuario()" (ngModelChange)="usuario.set($event)"
                     autocomplete="email" autocapitalize="off" spellcheck="false" [disabled]="ocupado()" />
            </label>
            @if (errosCampo()['usuario']) { <p class="erro">{{ errosCampo()['usuario'] }}</p> }
          }
          @case ('esqueci_codigo') {
            @if (aviso()) { <p class="aviso">{{ aviso() }}</p> }
            <label>Código recebido por e-mail
              <input name="codigo" inputmode="numeric" [ngModel]="codigo()" (ngModelChange)="codigo.set($event)"
                     autocomplete="one-time-code" [disabled]="ocupado()" />
            </label>
            @if (errosCampo()['codigo']) { <p class="erro">{{ errosCampo()['codigo'] }}</p> }
            <label>Nova senha
              <input name="novaSenha" type="password" [ngModel]="novaSenha()" (ngModelChange)="novaSenha.set($event)"
                     autocomplete="new-password" [disabled]="ocupado()" />
            </label>
            @if (errosCampo()['novaSenha']) { <p class="erro">{{ errosCampo()['novaSenha'] }}</p> }
            <label>Confirmar nova senha
              <input name="confirmacao" type="password" [ngModel]="confirmacao()" (ngModelChange)="confirmacao.set($event)"
                     autocomplete="new-password" [disabled]="ocupado()" />
            </label>
            @if (errosCampo()['confirmacao']) { <p class="erro">{{ errosCampo()['confirmacao'] }}</p> }
          }
          @default {
            <label>Usuário
              <input name="usuario" [ngModel]="usuario()" (ngModelChange)="usuario.set($event)"
                     autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
                     [disabled]="ocupado()" />
            </label>

            @if (!exigeNovaSenha()) {
              <label>Senha
                <input name="senha" type="password" [ngModel]="senha()" (ngModelChange)="senha.set($event)"
                       autocomplete="off" [disabled]="ocupado()" />
              </label>
              <div class="linha-opcoes">
                <label class="lembrar">
                  <input name="lembrar" type="checkbox" [ngModel]="lembrar()" (ngModelChange)="lembrar.set($event)" [disabled]="ocupado()" />
                  <span>Lembrar-me neste aparelho</span>
                </label>
                <button type="button" class="link" (click)="irParaEsqueci()" [disabled]="ocupado()">Esqueci a senha</button>
              </div>
            } @else {
              <p class="aviso">Primeiro acesso — defina uma nova senha.</p>
              <label>Nova senha
                <input name="novaSenha" type="password" [ngModel]="novaSenha()" (ngModelChange)="novaSenha.set($event)"
                       autocomplete="off" [disabled]="ocupado()" />
              </label>
            }
            @if (aviso()) { <p class="aviso sucesso">{{ aviso() }}</p> }
          }
        }

        @if (erro()) { <p class="erro" role="alert">{{ erro() }}</p> }

        <button type="submit" [disabled]="ocupado()">{{ rotuloBotao() }}</button>
        @if (etapa() !== 'entrar') {
          <button type="button" class="link voltar" (click)="voltarAoLogin()" [disabled]="ocupado()">Voltar ao login</button>
        }
      </form>
    </main>
  `,
  styles: [`
    /* Palco creme com um brilho laranja discreto no canto — o mesmo gesto do
       estudo de identidade, contido para não competir com o formulário. */
    .tela { min-height: 100dvh; display: grid; place-items: center; padding: var(--espacamento-6);
      background:
        radial-gradient(60% 55% at 82% 88%, color-mix(in srgb, var(--acao) 10%, transparent), transparent 70%),
        var(--fundo); }
    .cartao { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: var(--espacamento-3);
      background: var(--superficie-elevada); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); padding: var(--espacamento-8);
      box-shadow: 0 1px 2px rgb(0 0 0 / .05), 0 18px 48px rgb(0 0 0 / .10); }
    .cabeca { display: flex; flex-direction: column; gap: var(--espacamento-2); margin-bottom: var(--espacamento-2); }
    .logo { --marca-tam: 44px; --marca-fonte: 26px; }
    .sub { margin: 0; color: var(--texto-secundario); font-size: 14px; }
    label { display: flex; flex-direction: column; gap: var(--espacamento-2); font-size: 13px; color: var(--texto); }
    input { padding: var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie); color: var(--texto); font: inherit; font-size: 15px; }
    input:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; border-color: var(--acao); }
    button { margin-top: var(--espacamento-2); padding: var(--espacamento-3); border: 0; border-radius: var(--raio-controle); cursor: pointer;
      background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 15px; font-weight: 600; }
    button:hover:not(:disabled) { background: var(--acao-hover); }
    button:disabled { opacity: .6; cursor: default; }
    .erro { color: var(--erro); font-size: 13px; margin: 0; }
    .aviso { color: var(--texto-suave); font-size: 13px; margin: 0; }
    .aviso.sucesso { color: var(--sucesso); }
    .linha-opcoes { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); flex-wrap: wrap; }
    .lembrar { flex-direction: row; align-items: center; gap: var(--espacamento-2); }
    .lembrar input { padding: 0; width: 16px; height: 16px; accent-color: var(--acao); }
    .link { margin: 0; padding: 0; background: transparent; color: var(--acao); font-size: 13px; font-weight: 500; text-align: left; }
    .link:hover:not(:disabled) { background: transparent; text-decoration: underline; }
    .voltar { align-self: center; }
  `],
})
export class LoginPagina {
  private readonly auth = inject(AuthServico)
  private readonly router = inject(Router)

  readonly usuario = signal('')
  readonly senha = signal('')
  readonly novaSenha = signal('')
  readonly confirmacao = signal('')
  readonly codigo = signal('')
  /** "Lembrar-me": ligado por padrão (comportamento de sempre); desligado a sessão morre com a aba. */
  readonly lembrar = signal(true)
  readonly erro = signal<string | null>(null)
  readonly aviso = signal<string | null>(null)
  readonly errosCampo = signal<Readonly<Record<string, string>>>({})
  readonly ocupado = signal(false)
  readonly exigeNovaSenha = signal(false)
  readonly etapa = signal<EtapaLogin>('entrar')
  readonly rotuloBotao = computed(() => {
    if (this.etapa() === 'esqueci_email') return this.ocupado() ? 'Enviando…' : 'Enviar código'
    if (this.etapa() === 'esqueci_codigo') return this.ocupado() ? 'Salvando…' : 'Redefinir senha'
    return this.ocupado() ? 'Entrando…' : (this.exigeNovaSenha() ? 'Definir e entrar' : 'Entrar')
  })
  private session: string | null = null

  irParaEsqueci(): void {
    this.limparMensagens()
    this.etapa.set('esqueci_email')
  }

  voltarAoLogin(): void {
    this.limparMensagens()
    this.codigo.set(''); this.novaSenha.set(''); this.confirmacao.set('')
    this.etapa.set('entrar')
  }

  private limparMensagens(): void {
    this.erro.set(null); this.aviso.set(null); this.errosCampo.set({})
  }

  async enviar(): Promise<void> {
    if (this.ocupado()) return
    this.limparMensagens()
    if (this.etapa() === 'esqueci_email') return this.pedirCodigo()
    if (this.etapa() === 'esqueci_codigo') return this.redefinir()
    return this.entrar()
  }

  private async pedirCodigo(): Promise<void> {
    const locais = errosDoEmail(this.usuario())
    if (Object.keys(locais).length > 0) { this.errosCampo.set(locais); return }
    this.ocupado.set(true)
    try {
      const r = await this.auth.esqueciSenha(this.usuario().trim())
      if (r.tipo === 'ok') {
        // ⚠️ A mesma frase para e-mail cadastrado ou não: a tela não revela quem tem conta.
        this.aviso.set(r.mensagem)
        this.etapa.set('esqueci_codigo')
      } else {
        this.erro.set(r.mensagem)
      }
    } finally { this.ocupado.set(false) }
  }

  private async redefinir(): Promise<void> {
    const locais = errosDaRedefinicao(this.codigo(), this.novaSenha(), this.confirmacao())
    if (Object.keys(locais).length > 0) { this.errosCampo.set(locais); return }
    this.ocupado.set(true)
    try {
      const r = await this.auth.redefinirSenha(this.usuario().trim(), this.codigo().trim(), this.novaSenha())
      if (r.tipo === 'ok') {
        this.codigo.set(''); this.novaSenha.set(''); this.confirmacao.set(''); this.senha.set('')
        this.etapa.set('entrar')
        this.aviso.set('Senha redefinida. Entre com a nova senha.')
      } else {
        // Erro tipificado por campo quando há (política de senha); senão a mensagem geral.
        if (r.campos) this.errosCampo.set(r.campos)
        this.erro.set(r.mensagem)
      }
    } finally { this.ocupado.set(false) }
  }

  private async entrar(): Promise<void> {
    this.ocupado.set(true)
    try {
      const r = this.exigeNovaSenha() && this.session
        ? await this.auth.definirNovaSenha(this.usuario(), this.novaSenha(), this.session, this.lembrar())
        : await this.auth.entrar(this.usuario(), this.senha(), this.lembrar())

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
