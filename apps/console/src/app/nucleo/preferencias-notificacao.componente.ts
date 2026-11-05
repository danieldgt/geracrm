import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { ROTULO_CANAL_NOTIFICACAO, type CanalNotificacao } from '@geracrm/shared'
import { EsqueletoComponente, EstadoComponente, ToastServico, mensagemDeErro } from '../compartilhado/ui/index.js'
import { alterarCanal, preferenciasAlteradas, type PreferenciaTipo } from './notificacoes.regras.js'

/**
 * Preferências de aviso: a matriz tipo × canal (no sistema, push, e-mail) do usuário do token (D4).
 * ⚠️ Só vai para a API o que mudou. Sem linha gravada vale o padrão do servidor — a tela mostra o que o
 * servidor já resolveu. E-mail só aparece onde o tipo tem e-mail; nos demais a célula diz "—".
 */
@Component({
  selector: 'app-preferencias-notificacao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EsqueletoComponente, EstadoComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') {
        <div class="esqueletos" aria-busy="true"><ui-esqueleto altura="20px" /><ui-esqueleto altura="20px" /><ui-esqueleto altura="20px" /></div>
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar as preferências" [descricao]="erro() ?? ''">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        <div class="rolagem-x">
          <table class="matriz">
            <caption class="sr-only">Por onde você quer receber cada tipo de aviso</caption>
            <thead>
              <tr>
                <th scope="col" class="txt-rotulo">Aviso</th>
                @for (c of canais; track c.canal) { <th scope="col" class="txt-rotulo centro">{{ c.rotulo }}</th> }
              </tr>
            </thead>
            <tbody>
              @for (t of tipos(); track t.tipo) {
                <tr>
                  <th scope="row" class="txt-corpo">{{ t.rotulo }}</th>
                  @for (c of canais; track c.canal) {
                    <td class="centro">
                      @if (c.canal === 'email' && !t.emailDisponivel) {
                        <span class="nada" aria-label="Sem e-mail para este aviso">—</span>
                      } @else {
                        <input type="checkbox" [checked]="t.canais[c.canal]"
                               [attr.aria-label]="t.rotulo + ': ' + c.rotulo"
                               (change)="alternar(t.tipo, c.canal, $any($event.target).checked)" />
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="acoes">
          <button type="button" class="btn btn--primario" [disabled]="!mudou() || salvando()" (click)="salvar()">
            {{ salvando() ? 'Salvando…' : 'Salvar preferências' }}
          </button>
        </div>
      }
    }
  `,
  styles: `
    :host { display: block; }
    .esqueletos { display: grid; gap: var(--espacamento-3); }
    .matriz { width: 100%; border-collapse: collapse; }
    .matriz th, .matriz td { padding: var(--espacamento-2) var(--espacamento-3); border-bottom: 1px solid var(--borda); text-align: left; font-weight: 400; }
    .matriz thead th { font-weight: 600; white-space: nowrap; }
    .matriz .centro { text-align: center; }
    .matriz input { width: 18px; height: 18px; accent-color: var(--acao); cursor: pointer; }
    .nada { color: var(--texto-suave); }
    .acoes { display: flex; justify-content: flex-end; margin-top: var(--espacamento-4); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `,
})
export class PreferenciasNotificacaoComponente implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastServico)

  protected readonly canais: readonly { canal: CanalNotificacao; rotulo: string }[] = [
    { canal: 'app', rotulo: ROTULO_CANAL_NOTIFICACAO.app },
    { canal: 'push', rotulo: ROTULO_CANAL_NOTIFICACAO.push },
    { canal: 'email', rotulo: ROTULO_CANAL_NOTIFICACAO.email },
  ]
  protected readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  protected readonly erro = signal<string | null>(null)
  protected readonly tipos = signal<readonly PreferenciaTipo[]>([])
  protected readonly salvando = signal(false)
  private original = signal<readonly PreferenciaTipo[]>([])
  protected readonly mudou = computed(() => preferenciasAlteradas(this.original(), this.tipos()).length > 0)

  ngOnInit(): void { void this.carregar() }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ tipos: PreferenciaTipo[] }>('/v1/notificacoes/preferencias'))
      this.original.set(r.tipos)
      this.tipos.set(r.tipos)
      this.estado.set('pronto')
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Não foi possível carregar as preferências. Tente de novo.'))
      this.estado.set('erro')
    }
  }

  protected alternar(tipo: string, canal: CanalNotificacao, ligado: boolean): void {
    this.tipos.update((ts) => alterarCanal(ts, tipo, canal, ligado))
  }

  protected async salvar(): Promise<void> {
    const itens = preferenciasAlteradas(this.original(), this.tipos())
    if (itens.length === 0 || this.salvando()) return
    this.salvando.set(true)
    try {
      await firstValueFrom(this.http.put('/v1/notificacoes/preferencias', { itens }))
      this.original.set(this.tipos())
      this.toast.sucesso('Preferências de aviso salvas.')
    } catch (e) {
      // Preserva o que foi marcado; a pessoa tenta de novo.
      this.toast.erro(mensagemDeErro(e, 'Não foi possível salvar as preferências. Tente de novo.'))
    } finally { this.salvando.set(false) }
  }
}
