import { Component, ChangeDetectionStrategy, effect, inject, input, output, signal, untracked } from '@angular/core'
import type { DiffSecaoPlaybook, VersaoPlaybook } from '@geracrm/shared'
import { BadgeComponente, BotaoComponente, EsqueletoComponente, ToastServico } from '../../../compartilhado/ui/index.js'
import { PlaybookServico, type ResumoVersao } from './playbook.servico.js'
import { PlaybookDiffComponente } from './playbook-diff.componente.js'
import { dataCurta, erroDaObservacao, textoDeFalha } from './playbook.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro'

const ROTULO_ORIGEM: Readonly<Record<string, string>> = {
  importada: 'importada da configuração', manual: 'editada na tela', documento: 'sugerida de documento', restaurada: 'restaurada',
}

/**
 * HISTÓRICO DO PLAYBOOK (P17): versões publicadas e arquivadas do escopo, por
 * cursor ("Carregar mais"). Ver uma versão mostra o diff contra a publicada;
 * Restaurar pede observação e publica a cópia como versão NOVA.
 */
@Component({
  selector: 'app-playbook-historico',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponente, BotaoComponente, EsqueletoComponente, PlaybookDiffComponente],
  template: `
    @switch (estado()) {
      @case ('carregando') {
        <div class="lista"><ui-esqueleto altura="40px" /><ui-esqueleto altura="40px" /><ui-esqueleto altura="40px" /></div>
      }
      @case ('erro') {
        <p class="erro" role="alert">Não foi possível carregar o histórico. <ui-botao variante="secundario" (click)="recarregar()">Tentar de novo</ui-botao></p>
      }
      @case ('pronto') {
        @if (itens().length === 0) {
          <p class="dica">Nenhuma versão publicada ainda. A primeira aparece aqui quando você publicar (ou importar).</p>
        }
        <ul class="lista">
          @for (v of itens(); track v.id) {
            <li class="linha">
              <div class="resumo">
                <span class="txt-dados">v{{ v.numero }}</span>
                <ui-badge [tom]="v.estado === 'publicada' ? 'sucesso' : 'neutro'">{{ v.estado }}</ui-badge>
                <span class="meta encolhe">{{ data(v.publicadaEm) }}@if (v.publicadaPor) { · {{ v.publicadaPor }}} · {{ origem(v.origem) }}</span>
                <ui-botao variante="fantasma" (click)="abrir(v)">{{ aberta()?.versao?.id === v.id ? 'Fechar' : 'Ver' }}</ui-botao>
              </div>
              @if (v.observacao) { <p class="obs">“{{ v.observacao }}”</p> }
              @if (aberta(); as a) {
                @if (a.versao.id === v.id) {
                  <div class="detalhe">
                    @if (a.diff) {
                      <p class="txt-rotulo">O que mudaria em relação à publicada</p>
                      <app-playbook-diff [diff]="a.diff" vazio="Igual à publicada." />
                    } @else { <p class="dica">Esta é a versão publicada.</p> }
                    @if (podeEditar() && v.estado === 'arquivada') {
                      <form class="restaurar" (submit)="$event.preventDefault(); restaurar(v)">
                        <label class="campo">Por que restaurar? (obrigatório, ao menos 10 caracteres)
                          <input type="text" maxlength="500" [value]="observacao()" (input)="observacao.set($any($event.target).value)" />
                        </label>
                        <ui-botao tipo="submit" [carregando]="restaurando()" [desabilitado]="!!erroObs()">Restaurar como versão nova</ui-botao>
                      </form>
                      @if (observacao() && erroObs(); as e) { <p class="dica">{{ e }}</p> }
                    }
                    @if (erroRestaurar(); as e) { <p class="erro" role="alert">{{ e }}</p> }
                  </div>
                }
              }
            </li>
          }
        </ul>
        @if (cursor()) { <ui-botao variante="secundario" [carregando]="maisCarregando()" (click)="carregarMais()">Carregar mais</ui-botao> }
      }
    }
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .linha { border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: var(--espacamento-2) var(--espacamento-3); min-width: 0; }
    .resumo { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .meta { color: var(--texto-suave); font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .obs { margin: var(--espacamento-1) 0 0; font-size: 13px; color: var(--texto-secundario); overflow-wrap: anywhere; }
    .detalhe { margin-top: var(--espacamento-2); padding-top: var(--espacamento-2); border-top: 1px solid var(--borda); display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .restaurar { display: flex; gap: var(--espacamento-2); align-items: end; flex-wrap: wrap; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 13px; color: var(--texto-secundario); flex: 1; min-width: 200px; }
    input { font: inherit; color: var(--texto); background: var(--superficie); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      padding: var(--espacamento-1) var(--espacamento-2); min-height: var(--densidade-alvo-clique-console); }
    .dica { margin: 0; color: var(--texto-suave); font-size: 13px; }
    .erro { margin: 0; color: var(--erro); font-size: 13px; display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
  `,
})
export class PlaybookHistoricoComponente {
  readonly canalId = input<string | null>(null)
  readonly podeEditar = input(false)
  /** Mudou a cada publicação do pai: recarrega. */
  readonly versaoDoPai = input(0)
  readonly restaurado = output<VersaoPlaybook>()

  private readonly api = inject(PlaybookServico)
  private readonly toast = inject(ToastServico)
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly ResumoVersao[]>([])
  readonly cursor = signal<string | null>(null)
  readonly maisCarregando = signal(false)
  readonly aberta = signal<{ versao: VersaoPlaybook; diff: readonly DiffSecaoPlaybook[] | null } | null>(null)
  readonly observacao = signal('')
  readonly restaurando = signal(false)
  readonly erroRestaurar = signal<string | null>(null)

  constructor() {
    effect(() => { this.canalId(); this.versaoDoPai(); untracked(() => void this.recarregar()) })
  }

  data(iso: string | null): string { return dataCurta(iso) }
  origem(o: string): string { return ROTULO_ORIGEM[o] ?? o }
  erroObs(): string | null { return erroDaObservacao(this.observacao()) }

  async recarregar(): Promise<void> {
    this.estado.set('carregando'); this.aberta.set(null)
    try {
      const p = await this.api.listarVersoes(this.canalId(), null)
      this.itens.set(p.itens); this.cursor.set(p.proximoCursor); this.estado.set('pronto')
    } catch { this.estado.set('erro') }
  }

  async carregarMais(): Promise<void> {
    const c = this.cursor()
    if (!c) return
    this.maisCarregando.set(true)
    try {
      const p = await this.api.listarVersoes(this.canalId(), c)
      this.itens.update((xs) => [...xs, ...p.itens.filter((n) => !xs.some((x) => x.id === n.id))])
      this.cursor.set(p.proximoCursor)
    } catch { this.toast.erro('Não foi possível carregar mais versões.') } finally { this.maisCarregando.set(false) }
  }

  async abrir(v: ResumoVersao): Promise<void> {
    if (this.aberta()?.versao.id === v.id) { this.aberta.set(null); return }
    this.erroRestaurar.set(null); this.observacao.set('')
    try {
      const r = await this.api.lerVersao(v.id)
      this.aberta.set({ versao: r.versao, diff: r.diffContraPublicada })
    } catch { this.toast.erro('Não foi possível abrir a versão.') }
  }

  async restaurar(v: ResumoVersao): Promise<void> {
    if (this.erroObs() || this.restaurando()) return
    this.restaurando.set(true); this.erroRestaurar.set(null)
    try {
      const r = await this.api.restaurar(v.id, this.observacao().trim())
      if (!r.ok) {
        this.erroRestaurar.set(r.erro.erro === 'playbook.rascunho_existente'
          ? 'Há um rascunho em andamento. Publique ou descarte o rascunho antes de restaurar.'
          : textoDeFalha(r.status, r.erro.mensagem, 'restaurar'))
        return
      }
      this.toast.sucesso(`Restaurada como v${r.versao.numero}.`)
      this.restaurado.emit(r.versao)
    } finally { this.restaurando.set(false) }
  }
}
