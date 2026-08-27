import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit, OnDestroy } from '@angular/core'
import { Router } from '@angular/router'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
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
          <!-- ⚠️ ESTOU AUSENTE. Enquanto ligado, esta pessoa não conta como
               disponível — e se ninguém do número estiver disponível, o agente
               assume as conversas. É por isso que o texto diz o que ACONTECE,
               não só o estado: quem marca precisa saber o efeito. -->
          <button class="item ausencia" role="menuitem" (click)="alternarAusencia()"
                  [disabled]="mexendo()">
            <span class="ponto" [class.on]="ausente()"></span>
            <span class="encolhe">
              {{ ausente() ? 'Estou ausente' : 'Estou disponível' }}
              <small>{{ ausente() ? 'o agente pode assumir suas conversas' : 'você recebe e atende normalmente' }}</small>
            </span>
          </button>
          <div class="risco"></div>
          <button class="item" role="menuitem" (click)="irPerfil()">Meu perfil</button>
          <button class="item sair" role="menuitem" (click)="sair()">Sair do sistema</button>
        </div>
      }
    </div>
  `,
  styles: `
    .wrap { position: relative; }
    .ausencia { display: flex; align-items: flex-start; gap: var(--espacamento-2); text-align: left; }
    .ausencia small { display: block; color: var(--texto-suave); font-size: 11px; margin-top: 1px; }
    .encolhe { min-width: 0; }
    /* Verde = disponível, âmbar = ausente. Cor com RÓTULO ao lado, nunca sozinha. */
    .ponto { width: 8px; height: 8px; border-radius: var(--raio-completo);
      background: var(--sucesso); flex: none; margin-top: 5px; }
    .ponto.on { background: var(--atencao); }
    .risco { height: 1px; background: var(--borda); margin: var(--espacamento-1) 0; }
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
export class MenuUsuarioComponente implements OnInit, OnDestroy {
  private readonly auth = inject(AuthServico)
  private readonly router = inject(Router)
  readonly aberto = signal(false)

  readonly nome = computed(() => this.auth.usuario()?.nome ?? 'Dogfooding')
  private readonly http = inject(HttpClient)
  readonly ausente = signal(false)
  readonly mexendo = signal(false)
  #batimento: ReturnType<typeof setInterval> | null = null

  /**
   * ⚠️ O BATIMENTO. Fechar o navegador não avisa ninguém, então a AUSÊNCIA de
   * sinal é o sinal: sem isto o produto acharia que há gente na mesa a noite
   * inteira e o agente nunca assumiria. 2 min contra uma janela de 5 no
   * servidor — folga para uma reconexão sem derrubar a presença.
   */
  ngOnInit(): void {
    void this.bater()
    this.#batimento = setInterval(() => void this.bater(), 120_000)
    void this.carregarAusencia()
  }

  ngOnDestroy(): void {
    if (this.#batimento) { clearInterval(this.#batimento); this.#batimento = null }
  }

  private async bater(): Promise<void> {
    // ⚠️ Silencioso: falhar o batimento não pode virar erro na tela de quem só
    //    está trabalhando. Na pior hipótese a presença expira e o agente cobre.
    try { await firstValueFrom(this.http.post('/v1/config/presenca', {})) } catch { /* ignora */ }
  }

  private async carregarAusencia(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ itens: { email: string | null; ausente: boolean }[] }>('/v1/config/equipe'))
      // ⚠️ Casa por e-mail: o usuário do lado do cliente não carrega o id do
      //    banco. O servidor decide por `cognito_sub` na hora de gravar — aqui é
      //    só para o botão nascer com o estado certo.
      const meuEmail = this.auth.usuario()?.email
      const meu = meuEmail ? r.itens.find((u) => u.email === meuEmail) : undefined
      if (meu) this.ausente.set(meu.ausente)
    } catch { /* sem equipe: fica no padrão disponível */ }
  }

  async alternarAusencia(): Promise<void> {
    if (this.mexendo()) return
    this.mexendo.set(true)
    const novo = !this.ausente()
    try {
      await firstValueFrom(this.http.patch('/v1/config/ausencia', { ausente: novo }))
      this.ausente.set(novo)
    } catch { /* mantém o estado anterior: a tela não mente sobre o servidor */ }
    finally { this.mexendo.set(false) }
  }
  readonly email = computed(() => this.auth.usuario()?.email ?? null)
  readonly iniciais = computed(() => {
    const n = this.nome().trim()
    const partes = n.split(/\s+/)
    return ((partes[0]?.[0] ?? '') + (partes.length > 1 ? partes[partes.length - 1]![0] : '')).toUpperCase() || 'U'
  })

  irPerfil(): void { this.aberto.set(false); void this.router.navigate(['/config']) }
  sair(): void { this.aberto.set(false); this.auth.sair(); void this.router.navigate(['/login']) }
}
