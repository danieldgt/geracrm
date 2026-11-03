import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core'
import { HttpErrorResponse } from '@angular/common/http'
import { reaisParaCentavos } from '../../compartilhado/ui/index.js'
import { TemaServico } from '../../nucleo/tema.servico.js'
import { FormularioRenderComponente } from './formulario-render.componente.js'
import { estiloDoBotao, prepararEnvio, type FormularioDefinicao } from './formulario.regras.js'
import { FormulariosServico } from './formularios.servico.js'

type Estado = 'carregando' | 'indisponivel' | 'erro_carga' | 'pronto' | 'enviando' | 'sucesso'

/**
 * Página PÚBLICA do formulário (`/f/:chave`) — FORA da casca, sem login e sem carregar o shell.
 *
 * ⚠️ Quem chega aqui é uma pessoa de fora, em geral no celular: leve, tema CLARO sempre (a preferência
 * de tema do console não vale para ela), sem cor literal. A API é a regra: o 422 volta por campo e é
 * pintado no campo certo. Honeypot invisível (`apelido`); consentimento LGPD com o texto do tenant.
 */
@Component({
  selector: 'app-formulario-publico',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormularioRenderComponente],
  template: `
    <main class="palco" [class.embutido]="embutido()">
      <section class="cartao" aria-live="polite">
        @switch (estado()) {
          @case ('carregando') {
            <div class="esqueleto" aria-busy="true" aria-label="Carregando formulário">
              <span class="barra larga"></span><span class="barra"></span><span class="barra"></span><span class="barra"></span>
            </div>
          }
          @case ('indisponivel') {
            <div class="mensagem">
              <h1>Formulário indisponível</h1>
              <p>Este formulário não existe ou não está recebendo respostas agora.</p>
            </div>
          }
          @case ('erro_carga') {
            <div class="mensagem">
              <h1>Não foi possível abrir o formulário</h1>
              <p>Verifique a conexão e tente de novo.</p>
              <button type="button" class="botao" (click)="carregar()">Tentar de novo</button>
            </div>
          }
          @case ('sucesso') {
            <div class="mensagem sucesso" role="status">
              <h1>Tudo certo!</h1>
              <p>{{ mensagemSucesso() }}</p>
            </div>
          }
          @default {
            @if (definicao(); as d) {
              <form (submit)="enviar($event)" novalidate>
                <header class="cab">
                  <h1>{{ d.titulo }}</h1>
                  @if (d.descricao) { <p class="desc">{{ d.descricao }}</p> }
                </header>

                <app-formulario-render [campos]="d.campos" [(valores)]="valores" [(arquivos)]="arquivos"
                  [erros]="erros()" [desabilitado]="estado() === 'enviando'" />

                <!-- Honeypot: invisível para gente, irresistível para robô. Preenchido = descartado em silêncio. -->
                <div class="armadilha" aria-hidden="true">
                  <label>Não preencha este campo
                    <input type="text" [name]="d.armadilha" tabindex="-1" autocomplete="off"
                      [value]="apelido()" (input)="apelido.set($any($event.target).value)" />
                  </label>
                </div>

                <div class="lgpd">
                  <label class="aceite">
                    <input type="checkbox" [checked]="aceitou()" [disabled]="estado() === 'enviando'"
                      (change)="aceitou.set($any($event.target).checked)" />
                    <span>{{ d.textoConsentimento }}</span>
                  </label>
                  @if (erros()['consentimento']) { <p class="erro" role="alert">{{ erros()['consentimento'] }}</p> }
                </div>

                @if (erroEnvio(); as e) { <p class="erro caixa" role="alert">{{ e }}</p> }

                <button type="submit" class="botao" [disabled]="estado() === 'enviando'"
                  [style.background]="botao().fundo" [style.color]="botao().texto">
                  {{ estado() === 'enviando' ? 'Enviando…' : (erroEnvio() ? 'Tentar de novo' : d.textoBotao) }}
                </button>
              </form>
            }
          }
        }
      </section>
    </main>
  `,
  styles: `
    :host { display: block; background: var(--fundo); color: var(--texto); }
    .palco { min-height: 100dvh; display: flex; justify-content: center; align-items: flex-start;
      padding: var(--espacamento-8) var(--espacamento-4); box-sizing: border-box; }
    .palco.embutido { padding: var(--espacamento-3); }
    .cartao { width: 100%; max-width: 640px; min-width: 0; background: var(--superficie-elevada);
      border: 1px solid var(--borda); border-radius: var(--raio-painel); padding: var(--espacamento-6); box-sizing: border-box; }
    .embutido .cartao { border: 0; background: transparent; padding: var(--espacamento-2); }
    @media (max-width: 480px) { .cartao { padding: var(--espacamento-4); } .palco { padding: var(--espacamento-4) var(--espacamento-3); } }
    form { display: flex; flex-direction: column; gap: var(--espacamento-5); }
    .cab h1, .mensagem h1 { margin: 0; font-size: 22px; line-height: 1.25; color: var(--texto); }
    .desc { margin: var(--espacamento-2) 0 0; color: var(--texto-secundario); font-size: 14px; white-space: pre-line; }
    .armadilha { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }
    .lgpd { display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .aceite { display: flex; gap: var(--espacamento-3); align-items: flex-start; font-size: 13px; color: var(--texto-secundario); cursor: pointer; }
    .aceite input { margin-top: 2px; width: 16px; height: 16px; flex: none; accent-color: var(--acao); }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .erro.caixa { padding: var(--espacamento-3); border-radius: var(--raio-controle); background: var(--erro-suave); }
    .botao { padding: var(--espacamento-3) var(--espacamento-5); border: 0; border-radius: var(--raio-controle); cursor: pointer;
      background: var(--acao); color: var(--acao-texto); font: inherit; font-size: 15px; font-weight: 600; align-self: stretch; }
    .botao:disabled { opacity: .6; cursor: default; }
    .botao:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .mensagem { text-align: center; padding: var(--espacamento-6) var(--espacamento-2); display: flex; flex-direction: column; gap: var(--espacamento-3); align-items: center; }
    .mensagem p { margin: 0; color: var(--texto-secundario); }
    .mensagem.sucesso h1 { color: var(--sucesso); }
    .esqueleto { display: flex; flex-direction: column; gap: var(--espacamento-4); }
    .barra { display: block; height: 40px; border-radius: var(--raio-controle); background: var(--superficie); }
    .barra.larga { height: 28px; width: 60%; }
  `,
})
export class FormularioPublicoPagina implements OnInit {
  /** Ligado à rota `f/:chave` e ao `?embed=1` (withComponentInputBinding). */
  readonly chave = input.required<string>()
  readonly embed = input<string | undefined>(undefined)

  private readonly api = inject(FormulariosServico)
  private readonly tema = inject(TemaServico)

  protected readonly estado = signal<Estado>('carregando')
  protected readonly definicao = signal<FormularioDefinicao | null>(null)
  protected readonly valores = signal<Record<string, unknown>>({})
  protected readonly arquivos = signal<ReadonlyMap<string, File>>(new Map())
  protected readonly erros = signal<Record<string, string>>({})
  protected readonly erroEnvio = signal<string | null>(null)
  protected readonly aceitou = signal(false)
  protected readonly apelido = signal('')
  protected readonly mensagemSucesso = signal('')
  protected readonly embutido = computed(() => this.embed() === '1')
  protected readonly botao = computed(() => estiloDoBotao(this.definicao()?.cor ?? 'acao'))

  constructor() {
    // ⚠️ Tema CLARO sempre, sem gravar a escolha: a pessoa de fora não tem a preferência do console.
    document.documentElement.setAttribute('data-tema', 'claro')
    inject(DestroyRef).onDestroy(() => this.tema.aplicar())
  }

  ngOnInit(): void { void this.carregar() }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      this.definicao.set(await this.api.definicaoPublica(this.chave()))
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 404 ? 'indisponivel' : 'erro_carga')
    }
  }

  protected async enviar(ev: Event): Promise<void> {
    ev.preventDefault()
    const d = this.definicao()
    if (!d || this.estado() === 'enviando') return
    this.erroEnvio.set(null)

    const pronto = prepararEnvio(d.campos, this.valores(), this.arquivos(), this.aceitou(), reaisParaCentavos)
    if (!pronto.ok) { this.erros.set(pronto.erros); return }
    this.erros.set({})

    this.estado.set('enviando')
    try {
      const r = await this.api.enviarPublico(this.chave(), {
        respostas: pronto.respostas, consentimento: true, [d.armadilha]: this.apelido(),
      }, pronto.anexos)
      this.mensagemSucesso.set(r.mensagem)
      this.estado.set('sucesso')
    } catch (e) {
      this.estado.set('pronto')
      if (e instanceof HttpErrorResponse) {
        const corpo = e.error as { campos?: Record<string, string>; mensagem?: string } | null
        if (e.status === 422 && corpo?.campos) { this.erros.set(corpo.campos); return }
        if (e.status === 404) { this.estado.set('indisponivel'); return }
        if (e.status === 429) { this.erroEnvio.set('Muitos envios seguidos. Aguarde um instante e tente de novo.'); return }
        if (corpo?.mensagem) { this.erroEnvio.set(corpo.mensagem); return }
      }
      this.erroEnvio.set('Não foi possível enviar agora. Seus dados continuam aqui — tente de novo.')
    }
  }
}
