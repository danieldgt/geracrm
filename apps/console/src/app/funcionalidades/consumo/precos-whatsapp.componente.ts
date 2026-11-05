import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { CampoComponente, GradeFormComponente, ModalComponente, ToastServico, focarPrimeiroInvalido } from '../../compartilhado/ui/index.js'
import { ConsumoServico } from './consumo.servico.js'
import { rotuloCategoria } from './consumo.regras.js'

const CATEGORIAS = ['marketing', 'utility', 'authentication', 'service'] as const

/**
 * Preços do WhatsApp (F2) — o preço por mensagem de cada categoria da Meta, em R$, e o câmbio US$→R$.
 * Vive na tela de Consumo porque é o que explica o número que ela mostra. Só administrador salva
 * (a API responde 403 e a tela diz isso). Dinheiro em centavos inteiros; o câmbio vai em milésimos.
 */
@Component({
  selector: 'app-precos-whatsapp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModalComponente, GradeFormComponente, CampoComponente],
  template: `
    <ui-modal [aberto]="aberto()" titulo="Preços do WhatsApp" largura="m" (fechar)="fechar.emit()">
      <form id="form-precos" (submit)="salvar($event)" novalidate>
        <p class="nota">
          Quanto a Meta cobra por mensagem em cada categoria. O Consumo multiplica as mensagens enviadas pelo número
          oficial por estes valores. Mensagem de atendimento dentro da janela de 24h costuma custar zero.
        </p>
        @if (carregando()) {
          <p class="nota" role="status">Carregando preços…</p>
        } @else {
          <ui-grade-form>
            @for (c of categorias; track c) {
              <ui-campo [rotulo]="rotulo(c)" tipo="dinheiro" [name]="'preco-' + c"
                [ngModel]="precos()[c]" (ngModelChange)="mudarPreco(c, $event)"
                [erro]="erros()['precos.' + c] ?? null" />
            }
            <ui-campo rotulo="Câmbio (R$ por US$ 1)" tipo="dinheiro" name="cambio"
              dica="Referência para converter a tabela em dólar da Meta."
              [ngModel]="cambio()" (ngModelChange)="cambio.set($event)"
              [erro]="erros()['cambioUsdBrlMilesimos'] ?? null" />
          </ui-grade-form>
        }
        @if (erroGeral()) { <p class="erro" role="alert">{{ erroGeral() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar.emit()">Cancelar</button>
        <button type="submit" form="form-precos" class="btn btn--primario" [disabled]="salvando() || carregando()">
          {{ salvando() ? 'Salvando…' : 'Salvar preços' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    .nota { margin: 0 0 var(--espacamento-4); color: var(--texto-secundario); }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); }
  `,
})
export class PrecosWhatsappComponente {
  private readonly servico = inject(ConsumoServico)
  private readonly toast = inject(ToastServico)

  readonly aberto = input(false)
  readonly fechar = output<void>()
  readonly salvo = output<void>()

  protected readonly categorias = CATEGORIAS
  protected readonly precos = signal<Record<string, number | null>>({})
  protected readonly cambio = signal<number | null>(null)
  protected readonly carregando = signal(false)
  protected readonly salvando = signal(false)
  protected readonly erros = signal<Record<string, string>>({})
  protected readonly erroGeral = signal<string | null>(null)

  constructor() {
    effect(() => {
      if (this.aberto()) untracked(() => void this.carregar())
    })
  }

  protected rotulo(c: string): string { return rotuloCategoria(c) }

  protected mudarPreco(c: string, v: number | null): void {
    this.precos.update((p) => ({ ...p, [c]: v }))
  }

  private async carregar(): Promise<void> {
    this.carregando.set(true); this.erros.set({}); this.erroGeral.set(null)
    try {
      const r = await this.servico.precos()
      const mapa: Record<string, number | null> = {}
      for (const i of r.itens) mapa[i.categoria] = i.centavosPorMensagem
      this.precos.set(mapa)
      // O câmbio trafega em milésimos; o campo de dinheiro trabalha em centavos (1 milésimo = 0,1 centavo).
      this.cambio.set(Math.round(r.cambioUsdBrlMilesimos / 10))
    } catch {
      this.erroGeral.set('Não foi possível carregar os preços.')
    } finally { this.carregando.set(false) }
  }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    const p = this.precos()
    const cambio = this.cambio()
    const faltando: Record<string, string> = {}
    for (const c of CATEGORIAS) if (p[c] === null || p[c] === undefined) faltando['precos.' + c] = 'Informe o preço (pode ser R$ 0,00).'
    if (cambio === null || cambio <= 0) faltando['cambioUsdBrlMilesimos'] = 'Informe o câmbio.'
    this.erros.set(faltando)
    if (Object.keys(faltando).length > 0) return
    this.salvando.set(true); this.erroGeral.set(null)
    const precos: Record<string, number> = {}
    for (const c of CATEGORIAS) precos[c] = p[c] as number
    const r = await this.servico.salvarPrecos(precos, (cambio as number) * 10)
    this.salvando.set(false)
    if (r) { this.erros.set(r.campos); this.erroGeral.set(r.geral); focarPrimeiroInvalido(); return }
    this.toast.sucesso('Preços atualizados')
    this.salvo.emit()
    this.fechar.emit()
  }
}
