import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core'
import { Router } from '@angular/router'
import { AuthServico } from './auth.servico.js'

/**
 * Menu do usuário no canto superior direito (avatar → perfil / sair). Padrão
 * tradicional de app. O dropdown abre para a ESQUERDA/baixo, com espaço — nunca
 * cortado por container estreito (foi o bug do sino na lateral).
 */
@Component({
  selector: 'app-menu-usuario',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <button class="avatar" (click)="aberto.set(!aberto())" [attr.aria-label]="'Menu de ' + nome()"
              [title]="nome()">{{ iniciais() }}</button>
      @if (aberto()) {
        <div class="fora" (click)="aberto.set(false)"></div>
        <div class="menu" role="menu">
          <div class="quem">
            <span class="avatar grande">{{ iniciais() }}</span>
            <span class="quem-txt encolhe">
              <strong class="nome">{{ nome() }}</strong>
              @if (email()) { <span class="email">{{ email() }}</span> }
            </span>
          </div>
          <button class="item" role="menuitem" (click)="irPerfil()">Meu perfil</button>
          <button class="item sair" role="menuitem" (click)="sair()">Sair do sistema</button>
        </div>
      }
    </div>
  `,
  styles: `
    .wrap { position: relative; }
    .avatar { width: 30px; height: 30px; border-radius: var(--raio-completo); border: 1px solid var(--borda);
      background: var(--acao); color: var(--acao-texto); font-size: 12px; font-weight: 600; cursor: pointer;
      display: grid; place-items: center; padding: 0; }
    .avatar:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .avatar.grande { width: 36px; height: 36px; font-size: 14px; flex: none; }
    .fora { position: fixed; inset: 0; z-index: 40; }
    .menu { position: absolute; top: 38px; right: 0; z-index: 41; width: 240px;
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      box-shadow: var(--elevacao-dropdown); overflow: hidden; padding: var(--espacamento-1); }
    .quem { display: flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-3);
      border-bottom: 1px solid var(--borda); margin-bottom: var(--espacamento-1); }
    .quem-txt { display: flex; flex-direction: column; gap: 1px; }
    .nome { font-size: 13px; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .email { font-size: 12px; color: var(--texto-suave); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item { display: block; width: 100%; text-align: left; padding: var(--espacamento-2) var(--espacamento-3);
      border: 0; background: transparent; color: var(--texto); font: inherit; font-size: 13px; cursor: pointer;
      border-radius: var(--raio-controle); }
    .item:hover { background: var(--superficie-hover); }
    .item:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; }
    .item.sair { color: var(--erro); }
  `,
})
export class MenuUsuarioComponente {
  private readonly auth = inject(AuthServico)
  private readonly router = inject(Router)
  readonly aberto = signal(false)

  readonly nome = computed(() => this.auth.usuario()?.nome ?? 'Dogfooding')
  readonly email = computed(() => this.auth.usuario()?.email ?? null)
  readonly iniciais = computed(() => {
    const n = this.nome().trim()
    const partes = n.split(/\s+/)
    return ((partes[0]?.[0] ?? '') + (partes.length > 1 ? partes[partes.length - 1]![0] : '')).toUpperCase() || 'U'
  })

  irPerfil(): void { this.aberto.set(false); void this.router.navigate(['/config']) }
  sair(): void { this.aberto.set(false); this.auth.sair(); void this.router.navigate(['/login']) }
}
