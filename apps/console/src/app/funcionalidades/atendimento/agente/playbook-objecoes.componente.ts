import { Component, ChangeDetectionStrategy, computed, input, output, signal } from '@angular/core'
import { LIMITES_PLAYBOOK, type ObjecaoPlaybook } from '@geracrm/shared'
import { BotaoComponente } from '../../../compartilhado/ui/index.js'
import { adicionarGatilho, contadorDaResposta, erroDoPrefixo, indicesDaBusca, moverItem, novaObjecao } from './playbook.regras.js'

/**
 * SEÇÃO OBJEÇÕES DO PLAYBOOK (raia G2) — o catálogo de objeções do negócio:
 * código (gerado, OBJ-NN), ativo, objeção, gatilhos (chips de texto livre) e a
 * resposta de referência (com contador). Busca, reordenar e remover.
 *
 * Sem estado de dados próprio: recebe a lista e emite a lista inteira a cada
 * mudança (o editor do playbook monta o conteúdo). O erro da publicação (422 por
 * campo, `objecoes[2].resposta`) aparece no item.
 *
 * ⚠️ A resposta de referência não aceita preço, percentual nem prazo literais —
 *    a API recusa e explica; a dica diz isso antes.
 */
@Component({
  selector: 'app-playbook-objecoes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BotaoComponente],
  template: `
    <section class="secao" id="pb-objecoes" aria-labelledby="pb-objecoes-titulo">
      <div class="topo">
        <h3 class="txt-secao" id="pb-objecoes-titulo">Objeções</h3>
        <span class="dica">{{ objecoes().length }}/{{ lim.objecoesMax }}</span>
      </div>
      <p class="dica">Quando o cliente disser um gatilho, o agente responde na linha da referência e registra a objeção.
        Na 3ª seguida sem reverter, uma pessoa assume (regra do sistema). Sem preço, percentual ou prazo na resposta: esses números vêm da ferramenta, no turno.</p>
      @if (!acaoLigada()) {
        <p class="aviso" role="note">A ação "Registrar objeções" está desligada: as objeções valem como referência, mas o agente não as registra nem conta as seguidas.</p>
      }

      @if (objecoes().length > 0) {
        <label class="campo busca">Buscar objeção
          <input type="search" [value]="busca()" (input)="busca.set($any($event.target).value)" placeholder="código, objeção, gatilho ou resposta" />
        </label>
      } @else {
        <p class="dica">Nenhuma objeção cadastrada.</p>
      }
      @if (objecoes().length > 0 && visiveis().length === 0) {
        <p class="dica" role="status">Nenhuma objeção encontrada para "{{ busca() }}".</p>
      }

      <ol class="lista">
        @for (i of visiveis(); track i) {
          @let o = objecoes()[i]!;
          <li class="item" [class.inativo]="!o.ativo" [attr.aria-label]="o.codigo">
            <div class="item-topo">
              <span class="txt-rotulo codigo txt-dados">{{ o.codigo }}</span>
              <span class="acoes-item">
                <label class="check"><input type="checkbox" [checked]="o.ativo" (change)="mudar(i, { ativo: $any($event.target).checked })" /> ativa</label>
                <button type="button" class="icone" [disabled]="i === 0" (click)="mover(i, -1)" [attr.aria-label]="'Subir ' + o.codigo">↑</button>
                <button type="button" class="icone" [disabled]="i === objecoes().length - 1" (click)="mover(i, 1)" [attr.aria-label]="'Descer ' + o.codigo">↓</button>
                <button type="button" class="icone" (click)="remover(i)" [attr.aria-label]="'Remover ' + o.codigo">✕</button>
              </span>
            </div>
            @if (erro('objecoes[' + i + '].codigo'); as e) { <p class="erro" role="alert">{{ e }}</p> }

            <label class="campo">Objeção
              <input type="text" [attr.maxlength]="lim.objecao" [value]="o.objecao" (input)="mudar(i, { objecao: $any($event.target).value })"
                     placeholder="Ex.: Achou caro" [attr.aria-invalid]="erro('objecoes[' + i + '].objecao') ? 'true' : null" />
            </label>
            @if (erro('objecoes[' + i + '].objecao'); as e) { <p class="erro" role="alert">{{ e }}</p> }

            <div class="campo">
              <span>Gatilhos (o que o cliente diz)</span>
              <div class="chips">
                @for (g of o.gatilhos; track g) {
                  <span class="chip">{{ g }}
                    @if (editavel()) { <button type="button" class="x" (click)="tirarGatilho(i, g)" [attr.aria-label]="'Remover gatilho ' + g">✕</button> }
                  </span>
                }
                @if (o.gatilhos.length === 0) { <span class="dica">nenhum gatilho</span> }
              </div>
              @if (editavel()) {
                <form class="adicionar" (submit)="$event.preventDefault(); botarGatilho(i, campoGatilho)">
                  <input #campoGatilho type="text" [attr.maxlength]="lim.gatilho" [attr.aria-label]="'Novo gatilho de ' + o.codigo" placeholder="Ex.: tá caro" />
                  <ui-botao tipo="submit" variante="secundario">Acrescentar</ui-botao>
                </form>
              }
              @if (erroGatilho()[o.codigo]; as e) { <p class="erro" role="alert">{{ e }}</p> }
              @if (erro('objecoes[' + i + '].gatilhos'); as e) { <p class="erro" role="alert">{{ e }}</p> }
            </div>

            <label class="campo">Resposta de referência
              <textarea rows="3" [attr.maxlength]="lim.respostaObjecao" [value]="o.resposta" (input)="mudar(i, { resposta: $any($event.target).value })"
                        placeholder="Como o agente deve conduzir. Sem preço, percentual ou prazo."
                        [attr.aria-invalid]="erro('objecoes[' + i + '].resposta') ? 'true' : null"></textarea>
              <span class="contador txt-dados" [class.excedeu]="contador(o.resposta).excedeu">{{ contador(o.resposta).texto }}</span>
            </label>
            @if (erro('objecoes[' + i + '].resposta'); as e) { <p class="erro" role="alert">{{ e }}</p> }
          </li>
        }
      </ol>
      @if (erro('objecoes'); as e) { <p class="erro" role="alert">{{ e }}</p> }

      @if (editavel()) {
        <div class="adicionar">
          <ui-botao variante="secundario" [desabilitado]="!podeAdicionar()" (click)="adicionar()">Adicionar objeção</ui-botao>
          @if (!podeAdicionar()) { <span class="dica">Limite de {{ lim.objecoesMax }} objeções.</span> }
        </div>
      }
    </section>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .secao { border: 1px solid var(--borda); border-radius: var(--raio-painel); padding: var(--espacamento-4); background: var(--superficie-elevada);
      display: flex; flex-direction: column; gap: var(--espacamento-2); min-width: 0; }
    h3 { margin: 0; }
    .topo { display: flex; justify-content: space-between; align-items: baseline; gap: var(--espacamento-2); }
    .dica { margin: 0; color: var(--texto-suave); font-size: 12px; overflow-wrap: anywhere; }
    .aviso { margin: 0; color: var(--atencao); font-size: 12px; overflow-wrap: anywhere; }
    .erro { margin: 0; color: var(--erro); font-size: 12px; overflow-wrap: anywhere; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 13px; color: var(--texto-secundario); min-width: 0; }
    .busca { max-width: 420px; }
    input[type=text], input[type=search], textarea { font: inherit; color: var(--texto); background: var(--superficie);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); padding: var(--espacamento-1) var(--espacamento-2);
      min-height: var(--densidade-alvo-clique-console); min-width: 0; width: 100%; }
    textarea { resize: vertical; }
    input:focus-visible, textarea:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .contador { align-self: flex-end; color: var(--texto-suave); font-size: 11px; }
    .contador.excedeu { color: var(--erro); }
    .check { display: inline-flex; gap: var(--espacamento-2); align-items: center; font-size: 13px; color: var(--texto); }
    .lista { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--espacamento-2); }
    .item { border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: var(--espacamento-2) var(--espacamento-3); background: var(--superficie);
      display: flex; flex-direction: column; gap: var(--espacamento-2); min-width: 0; }
    .item.inativo { opacity: 0.7; }
    .item-topo { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .codigo { color: var(--texto); }
    .acoes-item { display: inline-flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .icone { font: inherit; min-width: 32px; min-height: 32px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie-elevada); color: var(--texto); cursor: pointer; }
    .icone:disabled { opacity: 0.4; cursor: default; }
    .chips { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-1); padding: 2px var(--espacamento-2); border-radius: var(--raio-completo);
      background: var(--acao-suave); color: var(--texto); font-size: 13px; overflow-wrap: anywhere; }
    .x { border: 0; background: transparent; color: var(--texto-secundario); cursor: pointer; font: inherit; }
    .adicionar { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    .adicionar input { flex: 1; min-width: 160px; }
    @media (max-width: 640px) { .secao { padding: var(--espacamento-3); } }
  `,
})
export class PlaybookObjecoesComponente {
  readonly objecoes = input.required<readonly ObjecaoPlaybook[]>()
  readonly editavel = input(false)
  readonly erros = input<Readonly<Record<string, string>>>({})
  /** A ação "Registrar objeções" do playbook está ligada? */
  readonly acaoLigada = input(true)
  readonly mudou = output<ObjecaoPlaybook[]>()

  readonly lim = LIMITES_PLAYBOOK
  readonly busca = signal('')
  /** Erro do chip por código (o código não muda ao reordenar). */
  readonly erroGatilho = signal<Readonly<Record<string, string | undefined>>>({})
  readonly visiveis = computed(() => indicesDaBusca(this.objecoes(), this.busca()))
  readonly podeAdicionar = computed(() => novaObjecao(this.objecoes()) !== null)

  readonly contador = contadorDaResposta
  /** Erro do campo (ou dos filhos: `objecoes[2].gatilhos` cobre `objecoes[2].gatilhos[1]`); a raiz `objecoes` só exata. */
  erro(campo: string): string | null {
    const e = this.errosEfetivos()
    return campo === 'objecoes' ? e[campo] ?? null : erroDoPrefixo(e, campo)
  }

  /**
   * Os erros chegam indexados (`objecoes[2].resposta`); ao mover/remover, o índice
   * muda e o erro grudaria no item errado. Descarta os indexados do lote atual (a
   * próxima validação do pai traz outro objeto e reaparece com os índices certos).
   */
  private readonly lotePodado = signal<object | null>(null)
  private readonly errosEfetivos = computed(() => {
    const e = this.erros()
    if (e !== this.lotePodado()) return e
    return Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('objecoes[')))
  })

  private emitir(fn: (l: readonly ObjecaoPlaybook[]) => readonly ObjecaoPlaybook[]): void {
    if (!this.editavel()) return
    this.mudou.emit([...fn(this.objecoes())])
  }

  mudar(i: number, p: Partial<ObjecaoPlaybook>): void {
    this.emitir((l) => l.map((o, j) => (j === i ? { ...o, ...p } : o)))
  }
  mover(i: number, d: -1 | 1): void { this.lotePodado.set(this.erros()); this.erroGatilho.set({}); this.emitir((l) => moverItem(l, i, d)) }
  remover(i: number): void { this.lotePodado.set(this.erros()); this.erroGatilho.set({}); this.emitir((l) => l.filter((_o, j) => j !== i)) }
  adicionar(): void {
    const nova = novaObjecao(this.objecoes())
    if (!nova) return
    this.busca.set('')
    this.emitir((l) => [...l, nova])
  }
  /** Acrescenta o chip; limpa o campo só quando entrou. */
  botarGatilho(i: number, campo: HTMLInputElement): void {
    const o = this.objecoes()[i]
    if (!o) return
    const r = adicionarGatilho(o.gatilhos, campo.value)
    this.erroGatilho.update((e) => ({ ...e, [o.codigo]: r.erro ?? undefined }))
    if (r.erro) return
    this.mudar(i, { gatilhos: [...r.lista] })
    campo.value = ''
  }
  tirarGatilho(i: number, g: string): void {
    const o = this.objecoes()[i]
    if (o) this.mudar(i, { gatilhos: o.gatilhos.filter((x) => x !== g) })
  }
}
