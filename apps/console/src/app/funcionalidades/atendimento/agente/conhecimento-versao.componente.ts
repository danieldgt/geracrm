import { Component, ChangeDetectionStrategy, effect, inject, input, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import { BadgeComponente, BotaoComponente, EsqueletoComponente } from '../../../compartilhado/ui/index.js'
import { ConhecimentoServico, type VersaoCompleta } from './conhecimento.servico.js'
import { badgeOrigem, mensagemFalhaVersao, rotuloAutor } from './conhecimento.regras.js'

type Estado =
  | { readonly tipo: 'carregando' }
  | { readonly tipo: 'pronto'; readonly versao: VersaoCompleta }
  | { readonly tipo: 'sem_permissao' }
  | { readonly tipo: 'falha'; readonly mensagem: string; readonly tentarDeNovo: boolean }

/**
 * O TEXTO EXATO de "Título vN" — o que o agente leu quando citou o documento
 * numa decisão (raia P9). Lê do histórico imutável, nunca do documento atual:
 * se a versão é anterior ao histórico, diz isso em vez de mostrar outro texto.
 */
@Component({
  selector: 'app-conhecimento-versao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BadgeComponente, BotaoComponente, EsqueletoComponente],
  template: `
    @switch (estado().tipo) {
      @case ('carregando') { <ui-esqueleto altura="64px" /> }
      @case ('sem_permissao') { <p class="dica">Sem acesso à base de conhecimento.</p> }
      @case ('falha') {
        <p class="aviso" role="status">{{ falha() }}
          @if (podeTentar()) { <ui-botao variante="fantasma" (click)="carregar()">Tentar de novo</ui-botao> }</p>
      }
      @case ('pronto') {
        @if (pronta(); as v) {
          <div class="cab">
            <span class="titulo encolhe">{{ v.titulo }}</span>
            <span class="txt-dados meta">v{{ v.versao }}</span>
            <ui-badge [tom]="origem(v).tom">{{ origem(v).rotulo }}</ui-badge>
            @if (v.atual) { <ui-badge tom="sucesso">atual</ui-badge> } @else { <ui-badge tom="atencao">hoje na v{{ v.versaoAtual }}</ui-badge> }
            <span class="meta">{{ autor(v) }} · <span class="txt-dados">{{ v.criadoEm | date: 'dd/MM/yy HH:mm' }}</span></span>
          </div>
          <pre class="texto">{{ v.conteudo }}</pre>
        }
      }
    }
  `,
  styles: `
    :host { display: block; min-width: 0; margin-top: var(--espacamento-1); }
    .cab { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .titulo { font-weight: 600; color: var(--texto); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta, .dica { color: var(--texto-suave); font-size: 12px; }
    .dica { margin: 0; }
    .texto { margin: var(--espacamento-1) 0 0; padding: var(--espacamento-2); background: var(--fundo); border-radius: var(--raio-controle);
      font-family: inherit; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; }
    .aviso { margin: 0; padding: var(--espacamento-2); border-radius: var(--raio-controle); background: var(--atencao-suave);
      color: var(--texto); font-size: 13px; display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
  `,
})
export class ConhecimentoVersaoComponente {
  readonly documentoId = input.required<string>()
  readonly versao = input.required<number>()

  private readonly api = inject(ConhecimentoServico)
  readonly estado = signal<Estado>({ tipo: 'carregando' })
  private pedido = 0

  constructor() {
    effect(() => { this.documentoId(); this.versao(); untracked(() => void this.carregar()) })
  }

  pronta(): VersaoCompleta | null { const e = this.estado(); return e.tipo === 'pronto' ? e.versao : null }
  falha(): string { const e = this.estado(); return e.tipo === 'falha' ? e.mensagem : '' }
  podeTentar(): boolean { const e = this.estado(); return e.tipo === 'falha' && e.tentarDeNovo }
  origem(v: VersaoCompleta) { return badgeOrigem(v.origem, v.restauradaDe) }
  autor(v: VersaoCompleta): string { return rotuloAutor(v) }

  async carregar(): Promise<void> {
    const n = ++this.pedido
    this.estado.set({ tipo: 'carregando' })
    const r = await this.api.lerVersao(this.documentoId(), this.versao())
    if (n !== this.pedido) return
    if (r.ok) { this.estado.set({ tipo: 'pronto', versao: r.versao }); return }
    if (r.status === 403) { this.estado.set({ tipo: 'sem_permissao' }); return }
    // 404 é resposta definitiva (não existe / anterior ao histórico); o resto pode ser rede.
    this.estado.set({ tipo: 'falha', mensagem: mensagemFalhaVersao(r.erro.erro, r.erro.primeiraRegistrada), tentarDeNovo: r.status !== 404 })
  }
}
