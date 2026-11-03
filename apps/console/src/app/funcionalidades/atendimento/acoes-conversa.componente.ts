import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, inject, input, signal, viewChild,
} from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { InboxServico } from '../../nucleo/inbox.servico.js'
import { PresencaServico } from '../../nucleo/presenca.servico.js'
import {
  MOTIVOS_DEVOLUCAO, TETO_TEXTO, corpoDevolucao, erroDevolucao, erroReatribuicao, podeDevolver, podeReatribuir,
  type MotivoDevolucao,
} from '../../nucleo/devolucao.regras.js'

interface Membro { readonly id: string; readonly nome: string }
type Aberto = 'nenhum' | 'devolver' | 'reatribuir'

/**
 * "Devolver ao agente" e "Reatribuir" no cabeçalho da conversa (G1).
 *
 * ⚠️ Devolver nem sempre entrega ao robô: se o agente do número não fala sozinho
 * (sombra/assistido/desligado), o servidor devolve a conversa à FILA e diz isso —
 * o aviso aparece aqui, não some em silêncio.
 *
 * // L1: trocar por ui-modal (modal simples local enquanto a biblioteca não o tem).
 */
@Component({
  selector: 'app-acoes-conversa',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mostrarDevolver()) {
      <button class="acao-btn" type="button" (click)="abrirDevolver()"
              title="Devolver a conversa ao agente">Devolver ao agente</button>
    }
    @if (mostrarReatribuir()) {
      <button class="acao-btn" type="button" (click)="abrirReatribuir()"
              title="Passar o atendimento para outra pessoa">Reatribuir</button>
    }
    @if (aviso(); as a) { <span class="aviso-ok" role="status">{{ a }}</span> }

    @if (aberto() !== 'nenhum') {
      <div class="overlay" (click)="fechar()">
        <div #caixa class="modal" role="dialog" aria-modal="true" tabindex="-1"
             aria-labelledby="acoes-conversa-titulo"
             (click)="$event.stopPropagation()" (keydown.escape)="fechar()">
          @if (aberto() === 'devolver') {
            <h2 id="acoes-conversa-titulo">Devolver ao agente</h2>
            <p class="ajuda">O agente volta a conduzir esta conversa e lê o motivo no próximo turno.</p>
            <fieldset>
              <legend class="so-leitor">Motivo</legend>
              @for (m of motivos; track m.id) {
                <label class="radio">
                  <input type="radio" name="motivo-devolucao" [value]="m.id"
                         [checked]="motivo() === m.id" (change)="motivo.set(m.id)" />
                  <span>{{ m.rotulo }}</span>
                </label>
              }
            </fieldset>
            @if (motivo() === 'outro') {
              <textarea rows="3" [attr.maxlength]="teto" placeholder="Descreva o motivo"
                        [ngModel]="texto()" (ngModelChange)="texto.set($event)"></textarea>
            }
          } @else {
            <h2 id="acoes-conversa-titulo">Reatribuir atendimento</h2>
            <label class="campo">
              <span>Para quem</span>
              <select [ngModel]="destino()" (ngModelChange)="destino.set($event)">
                <option [ngValue]="null">Escolha uma pessoa</option>
                @for (p of equipe(); track p.id) { <option [ngValue]="p.id">{{ p.nome }}</option> }
              </select>
            </label>
            <label class="campo">
              <span>Motivo</span>
              <textarea rows="3" [attr.maxlength]="teto" placeholder="Por que está passando adiante?"
                        [ngModel]="texto()" (ngModelChange)="texto.set($event)"></textarea>
            </label>
          }
          @if (erroServidor(); as e) { <p class="erro" role="alert">{{ e }}</p> }
          <div class="acoes">
            <button type="button" class="btn secundario" (click)="fechar()">Cancelar</button>
            <button type="button" class="btn primario" [disabled]="enviando() || !!erroDoFormulario()"
                    [title]="erroDoFormulario() ?? ''" (click)="confirmar()">
              {{ enviando() ? 'Enviando…' : (aberto() === 'devolver' ? 'Devolver' : 'Reatribuir') }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .acao-btn { font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; padding: 6px 12px; border-radius: 999px;
      border: 1px solid var(--borda-controle); background: var(--fundo); color: var(--texto); }
    .acao-btn:hover { background: var(--superficie-elevada); }
    .acao-btn:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .aviso-ok { font-size: 12px; color: var(--texto-secundario); max-width: 260px; }
    .overlay { position: fixed; inset: 0; z-index: 1100; display: grid; place-items: center;
      padding: var(--espacamento-4); background: var(--fundo-sobreposicao, rgb(0 0 0 / .4)); }
    .modal { width: 100%; max-width: 440px; padding: var(--espacamento-6); display: grid; gap: var(--espacamento-3);
      background: var(--superficie-elevada); color: var(--texto); border: 1px solid var(--borda);
      border-radius: var(--raio-painel); box-shadow: var(--elevacao-modal); outline: none; }
    h2 { margin: 0; font-size: 1.1rem; }
    .ajuda { margin: 0; color: var(--texto-secundario); }
    fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .radio { display: flex; gap: var(--espacamento-2); align-items: center; cursor: pointer; }
    .campo { display: grid; gap: var(--espacamento-1); }
    .campo span { color: var(--texto-secundario); font-size: 13px; }
    select, textarea { font: inherit; padding: var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); width: 100%; box-sizing: border-box; }
    textarea { resize: vertical; }
    select:focus-visible, textarea:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .erro { margin: 0; color: var(--erro); }
    .acoes { display: flex; justify-content: flex-end; gap: var(--espacamento-2); flex-wrap: wrap; }
    .btn { min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-2) var(--espacamento-4);
      border-radius: var(--raio-controle); border: 1px solid transparent; font: inherit; font-weight: 600; cursor: pointer; }
    .btn.secundario { background: var(--fundo); color: var(--texto); border-color: var(--borda-controle); }
    .btn.primario { background: var(--acao); color: var(--acao-texto); }
    .btn:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .so-leitor { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  `,
})
export class AcoesConversaComponente {
  private readonly servico = inject(InboxServico)
  private readonly presenca = inject(PresencaServico)
  private readonly http = inject(HttpClient)

  readonly conversaId = input.required<string>()
  readonly atendimento = input<{ readonly estado: string } | null>(null)

  readonly motivos = MOTIVOS_DEVOLUCAO
  readonly teto = TETO_TEXTO
  readonly mostrarDevolver = computed(() => podeDevolver(this.atendimento()))
  readonly mostrarReatribuir = computed(() => podeReatribuir(this.atendimento(), this.presenca.gestao()))

  readonly aberto = signal<Aberto>('nenhum')
  readonly motivo = signal<MotivoDevolucao | null>(null)
  readonly texto = signal('')
  readonly destino = signal<string | null>(null)
  readonly equipe = signal<readonly Membro[]>([])
  readonly enviando = signal(false)
  readonly erroServidor = signal<string | null>(null)
  readonly aviso = signal<string | null>(null)

  readonly erroDoFormulario = computed(() => this.aberto() === 'devolver'
    ? erroDevolucao({ motivo: this.motivo(), observacao: this.texto() })
    : erroReatribuicao({ usuarioId: this.destino(), motivo: this.texto() }))

  private readonly caixa = viewChild<ElementRef<HTMLElement>>('caixa')

  constructor() {
    // Foco entra no diálogo ao abrir (teclado não fica preso atrás).
    afterRenderEffect(() => {
      const el = this.caixa()?.nativeElement
      if (el && !el.contains(document.activeElement)) el.focus()
    })
  }

  private zerar(aberto: Aberto): void {
    this.motivo.set(null); this.texto.set(''); this.destino.set(null)
    this.erroServidor.set(null); this.aviso.set(null)
    this.aberto.set(aberto)
  }

  abrirDevolver(): void { this.zerar('devolver') }

  async abrirReatribuir(): Promise<void> {
    this.zerar('reatribuir')
    if (this.equipe().length > 0) return
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe'))
      this.equipe.set(r.itens)
    } catch { this.erroServidor.set('Não foi possível carregar a equipe.') }
  }

  fechar(): void { if (!this.enviando()) this.aberto.set('nenhum') }

  async confirmar(): Promise<void> {
    if (this.erroDoFormulario() || this.enviando()) return
    this.enviando.set(true)
    this.erroServidor.set(null)
    const id = this.conversaId()
    if (this.aberto() === 'devolver') {
      const r = await this.servico.devolverAoAgente(id, corpoDevolucao({ motivo: this.motivo()!, observacao: this.texto() }))
      this.enviando.set(false)
      if (!r.ok) { this.erroServidor.set(r.erro); return }
      this.aberto.set('nenhum')
      this.aviso.set(r.aviso)
    } else {
      const r = await this.servico.reatribuir(id, { usuarioId: this.destino()!, motivo: this.texto().trim() })
      this.enviando.set(false)
      if (!r.ok) { this.erroServidor.set(r.erro); return }
      this.aberto.set('nenhum')
    }
  }
}
