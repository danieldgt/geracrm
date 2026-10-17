import { Component, ChangeDetectionStrategy, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import {
  BadgeComponente, BotaoComponente, ConfirmacaoServico, EsqueletoComponente, EstadoComponente, PainelComponente, ToastServico,
  mesclarPagina,
} from '../../../compartilhado/ui/index.js'
import { ehSemPermissao } from './agente.servico.js'
import { ConhecimentoServico, type Documento, type VersaoCompleta, type VersaoItem } from './conhecimento.servico.js'
import {
  OBSERVACAO_MAX, badgeOrigem, compactarDiff, diffLinhas, formatarInteiro, mensagemFalhaVersao, resumoDiff, rotuloAutor,
  validarObservacao, type BlocoDiff,
} from './conhecimento.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
type Vista = 'texto' | 'atual' | 'anterior'
/** A versão aberta e a anterior a ela carregam à parte da lista: falha aqui é parcial, a lista fica. */
type Carga<T> = { readonly estado: 'carregando' } | { readonly estado: 'pronto'; readonly valor: T } | { readonly estado: 'erro'; readonly mensagem: string }

/**
 * HISTÓRICO de um documento da base (raia P9): todas as versões, imutáveis,
 * com quem fez e por quê; o texto exato de cada uma; a diferença para a atual
 * ou para a anterior; e RESTAURAR — que cria uma versão nova com o texto
 * escolhido, nunca reescreve o passado.
 */
@Component({
  selector: 'app-conhecimento-historico',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, PainelComponente],
  template: `
    <ui-painel>
      <div class="cab">
        <h2 class="txt-secao secao encolhe">Histórico — {{ documento().titulo }}</h2>
        <span class="txt-dados meta">atual: v{{ documento().versao }}</span>
        <ui-botao variante="fantasma" (click)="fechar.emit()">Fechar</ui-botao>
      </div>
      <p class="dica">Cada versão fica guardada como foi escrita. É o texto que o agente leu quando citou "{{ documento().titulo }} vN". Restaurar cria uma versão nova.</p>

      @switch (estado()) {
        @case ('carregando') {
          <div class="esq"><ui-esqueleto altura="40px" /><ui-esqueleto altura="40px" /><ui-esqueleto altura="40px" /></div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso ao histórico" descricao="Peça a um administrador para liberar." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o histórico" descricao="O servidor não respondeu. Dá para tentar de novo.">
            <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
          </ui-estado>
        }
        @case ('pronto') {
          @if (itens().length === 0) {
            <ui-estado titulo="Nenhuma versão registrada" icone="🕘"
              descricao="Este documento ainda não tem versões no histórico. A próxima edição registra a primeira." />
          } @else {
            <ul class="lista">
              @for (v of itens(); track v.versao) {
                <li class="item" [class.selecionado]="selecionada() === v.versao">
                  <!-- Ordem fixa: versão, origem, atual, autor, data, tamanho. -->
                  <div class="linha">
                    <span class="txt-dados num">v{{ v.versao }}</span>
                    <ui-badge [tom]="origem(v).tom">{{ origem(v).rotulo }}</ui-badge>
                    @if (v.atual) { <ui-badge tom="sucesso">atual</ui-badge> }
                    <span class="autor encolhe">{{ autor(v) }}</span>
                    <span class="txt-dados meta">{{ v.criadoEm | date: 'dd/MM/yy HH:mm' }}</span>
                    <span class="txt-dados meta">{{ caracteres(v.caracteres) }} car.</span>
                    <ui-botao variante="fantasma" (click)="abrir(v)">{{ selecionada() === v.versao ? 'Aberta' : 'Ver' }}</ui-botao>
                  </div>
                  @if (v.observacao) { <p class="obs">{{ v.observacao }}</p> }
                  @if (v.titulo !== documento().titulo) { <p class="dica">título nesta versão: {{ v.titulo }}</p> }
                </li>
              }
            </ul>
            @if (erroMais(); as e) { <p class="erro-txt" role="alert">{{ e }}</p> }
            @if (proximoCursor()) {
              <div class="mais"><ui-botao variante="secundario" (click)="carregarMais()" [carregando]="carregandoMais()">
                {{ carregandoMais() ? 'Carregando…' : 'Carregar versões mais antigas' }}</ui-botao></div>
            }
          }

          <!-- A versão aberta: texto, diferença e restaurar. -->
          @if (selecionada() !== null) {
            <section class="aberta" aria-live="polite">
              @switch (versao().estado) {
                @case ('carregando') { <ui-esqueleto altura="120px" /> }
                @case ('erro') {
                  <p class="aviso aviso--erro" role="alert">{{ erroVersao() }}</p>
                }
                @case ('pronto') {
                  @if (versaoPronta(); as v) {
                    <div class="vistas" role="radiogroup" aria-label="O que mostrar">
                      <label class="radio"><input type="radio" name="vista" [checked]="vista() === 'texto'" (change)="mudarVista('texto')" /> Texto da v{{ v.versao }}</label>
                      @if (!v.atual) {
                        <label class="radio"><input type="radio" name="vista" [checked]="vista() === 'atual'" (change)="mudarVista('atual')" /> Diferença para a atual (v{{ documento().versao }})</label>
                      }
                      @if (v.versao > 1) {
                        <label class="radio"><input type="radio" name="vista" [checked]="vista() === 'anterior'" (change)="mudarVista('anterior')" /> O que mudou na v{{ v.versao }}</label>
                      }
                    </div>

                    @if (vista() === 'texto') {
                      <pre class="texto rolagem-x">{{ v.conteudo }}</pre>
                    } @else {
                      @switch (estadoDiff()) {
                        @case ('carregando') { <ui-esqueleto altura="80px" /> }
                        @case ('erro') { <p class="aviso" role="status">{{ erroAnterior() }}</p> }
                        @case ('pronto') {
                          <p class="dica">{{ legendaDiff() }} · <span class="txt-dados">{{ resumo() }}</span></p>
                          @if (aproximado()) { <p class="dica">Diferença muito grande: mostrada em blocos inteiros.</p> }
                          <div class="diff rolagem-x" role="table" aria-label="Diferença linha a linha">
                            @for (b of blocos(); track $index) {
                              @if (b.tipo === 'omitidas') {
                                <div class="d-omit" role="row"><span role="cell">… {{ b.quantidade }} {{ b.quantidade === 1 ? 'linha igual' : 'linhas iguais' }}</span></div>
                              } @else {
                                <div class="d-linha" role="row" [class.d-add]="b.tipo === 'adicionada'" [class.d-rem]="b.tipo === 'removida'">
                                  <span class="d-sinal" role="cell" [attr.aria-label]="rotuloSinal(b)">{{ sinal(b) }}</span>
                                  <span class="d-texto" role="cell">{{ b.texto || ' ' }}</span>
                                </div>
                              }
                            }
                          </div>
                        }
                      }
                    }

                    @if (!v.atual) {
                      <form class="restaurar" (submit)="restaurar($event, v)" novalidate>
                        <label class="campo">
                          <span>Nota da restauração (opcional)</span>
                          <input type="text" [value]="observacao()" (input)="observacao.set($any($event.target).value)"
                                 [attr.maxlength]="observacaoMax" [attr.aria-invalid]="erroObservacao() ? 'true' : null"
                                 placeholder="Ex.: voltou a regra de frete anterior" />
                          @if (erroObservacao(); as e) { <span class="msg-erro">{{ e }}</span> }
                        </label>
                        <ui-botao tipo="submit" variante="secundario" [carregando]="restaurando()" [desabilitado]="erroObservacao() !== null">
                          {{ restaurando() ? 'Restaurando…' : 'Restaurar como v' + (documento().versao + 1) }}</ui-botao>
                      </form>
                    }
                  }
                }
              }
            </section>
          }
        }
      }
    </ui-painel>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .cab { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .secao { margin: 0; color: var(--texto); flex: 1 1 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta, .dica { color: var(--texto-suave); }
    .dica { margin: var(--espacamento-1) 0 0; font-size: 12px; }
    .esq { display: grid; gap: var(--espacamento-2); margin-top: var(--espacamento-3); }
    .lista { list-style: none; margin: var(--espacamento-3) 0 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-controle);
      max-height: 320px; overflow-y: auto; }
    .item { padding: var(--espacamento-2) var(--espacamento-3); border-bottom: 1px solid var(--borda); display: grid; gap: 2px; min-width: 0; }
    .item:last-child { border-bottom: none; }
    .item.selecionado { background: var(--superficie-selecionada); }
    .linha { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .num { color: var(--texto); font-weight: 600; }
    .autor { color: var(--texto-secundario); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 100px; }
    .obs { margin: 0; color: var(--texto-secundario); font-size: 13px; overflow-wrap: anywhere; }
    .mais { margin-top: var(--espacamento-2); }
    .erro-txt, .msg-erro { color: var(--erro); font-size: 12px; margin: var(--espacamento-2) 0 0; }
    .aberta { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .vistas { display: flex; gap: var(--espacamento-4); flex-wrap: wrap; }
    .radio { display: flex; align-items: center; gap: var(--espacamento-2); font-size: 13px; color: var(--texto); cursor: pointer; }
    .texto { margin: 0; padding: var(--espacamento-3); background: var(--fundo); border: 1px solid var(--borda); border-radius: var(--raio-controle);
      font-family: inherit; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow-y: auto; }
    .diff { border: 1px solid var(--borda); border-radius: var(--raio-controle); max-height: 360px; overflow: auto;
      font-family: var(--tipografia-familia-dados); font-size: 12px; background: var(--fundo); }
    .d-linha { display: flex; gap: var(--espacamento-2); padding: 1px var(--espacamento-2); min-width: 0; }
    .d-add { background: var(--sucesso-suave); }
    .d-rem { background: var(--erro-suave); }
    .d-sinal { flex: none; width: 1ch; color: var(--texto-suave); }
    .d-texto { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; color: var(--texto); }
    .d-omit { padding: 2px var(--espacamento-2); color: var(--texto-suave); background: var(--superficie); font-style: italic; }
    .aviso { margin: 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .aviso--erro { background: var(--erro-suave); }
    .restaurar { display: flex; align-items: end; gap: var(--espacamento-2); flex-wrap: wrap; margin-top: var(--espacamento-2); }
    .restaurar .campo { flex: 1 1 260px; min-width: 0; display: grid; gap: 2px; font-size: 12px; color: var(--texto-secundario); }
    .restaurar input { font: inherit; width: 100%; min-height: var(--densidade-alvo-clique-console); }
    .restaurar input:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
  `,
})
export class ConhecimentoHistoricoComponente {
  readonly documento = input.required<Documento>()
  readonly fechar = output<void>()
  /** O documento depois de restaurado — a lista da aba troca a linha. */
  readonly restaurado = output<Documento>()

  private readonly api = inject(ConhecimentoServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)
  readonly observacaoMax = OBSERVACAO_MAX

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly VersaoItem[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  readonly erroMais = signal<string | null>(null)

  readonly selecionada = signal<number | null>(null)
  readonly versao = signal<Carga<VersaoCompleta>>({ estado: 'carregando' })
  readonly anterior = signal<Carga<VersaoCompleta> | null>(null)
  readonly vista = signal<Vista>('texto')
  readonly observacao = signal('')
  readonly restaurando = signal(false)
  /** Descarta resposta de versão que chegou depois de outra ter sido aberta. */
  private pedido = 0
  private ultimaCarga = ''

  readonly versaoPronta = computed(() => { const c = this.versao(); return c.estado === 'pronto' ? c.valor : null })
  readonly erroVersao = computed(() => { const c = this.versao(); return c.estado === 'erro' ? c.mensagem : '' })
  readonly erroAnterior = computed(() => { const c = this.anterior(); return c?.estado === 'erro' ? c.mensagem : '' })
  readonly erroObservacao = computed(() => validarObservacao(this.observacao()))

  /** Os dois textos comparados: [antigo, novo]. `null` enquanto o lado de lá não chegou. */
  private readonly pares = computed<readonly [string, string] | null>(() => {
    const v = this.versaoPronta()
    if (!v) return null
    if (this.vista() === 'atual') return [v.conteudo, this.documento().conteudo]
    if (this.vista() === 'anterior') { const a = this.anterior(); return a?.estado === 'pronto' ? [a.valor.conteudo, v.conteudo] : null }
    return null
  })
  readonly estadoDiff = computed<'carregando' | 'erro' | 'pronto'>(() => {
    if (this.vista() === 'anterior') { const a = this.anterior(); if (!a || a.estado === 'carregando') return 'carregando'; if (a.estado === 'erro') return 'erro' }
    return this.pares() ? 'pronto' : 'carregando'
  })
  private readonly diff = computed(() => { const p = this.pares(); return p ? diffLinhas(p[0], p[1]) : null })
  readonly blocos = computed<readonly BlocoDiff[]>(() => { const d = this.diff(); return d ? compactarDiff(d.linhas) : [] })
  readonly resumo = computed(() => { const d = this.diff(); return d ? resumoDiff(d) : '' })
  readonly aproximado = computed(() => this.diff()?.aproximado ?? false)
  readonly legendaDiff = computed(() => {
    const v = this.versaoPronta()
    if (!v) return ''
    return this.vista() === 'atual'
      ? `− o que está na v${v.versao} · + o que está na atual (v${this.documento().versao}) — restaurar troca o + pelo −`
      : `− v${v.versao - 1} · + v${v.versao}`
  })

  constructor() {
    // Trocar de documento recomeça o histórico.
    // Depende do id E da versão: restaurar (ou editar) troca o documento e a lista ganha a versão nova.
    effect(() => {
      const chave = `${this.documento().id}:${this.documento().versao}`
      untracked(() => { if (chave !== this.ultimaCarga) { this.ultimaCarga = chave; void this.carregar() } })
    })
  }

  origem(v: VersaoItem) { return badgeOrigem(v.origem, v.restauradaDe) }
  autor(v: VersaoItem): string { return rotuloAutor(v) }
  caracteres(n: number): string { return formatarInteiro(n) }
  sinal(b: BlocoDiff): string { return b.tipo === 'adicionada' ? '+' : b.tipo === 'removida' ? '−' : ' ' }
  rotuloSinal(b: BlocoDiff): string { return b.tipo === 'adicionada' ? 'adicionada' : b.tipo === 'removida' ? 'removida' : 'igual' }

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.erroMais.set(null)
    this.selecionada.set(null); this.anterior.set(null); this.observacao.set('')
    try {
      const p = await this.api.listarVersoes(this.documento().id, null)
      this.itens.set(p.itens)
      this.proximoCursor.set(p.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true); this.erroMais.set(null)
    try {
      const p = await this.api.listarVersoes(this.documento().id, cursor)
      this.itens.update((a) => mesclarPagina(a, p.itens, (v) => v.versao))
      this.proximoCursor.set(p.proximoCursor)
    } catch {
      this.erroMais.set('Não foi possível carregar versões mais antigas. Tente de novo.')
    } finally { this.carregandoMais.set(false) }
  }

  async abrir(v: VersaoItem): Promise<void> {
    const n = ++this.pedido
    this.selecionada.set(v.versao)
    this.versao.set({ estado: 'carregando' }); this.anterior.set(null); this.observacao.set('')
    this.vista.set(v.atual ? 'texto' : 'atual')
    const r = await this.api.lerVersao(this.documento().id, v.versao)
    if (n !== this.pedido) return
    this.versao.set(r.ok ? { estado: 'pronto', valor: r.versao } : { estado: 'erro', mensagem: mensagemFalhaVersao(r.erro.erro, r.erro.primeiraRegistrada) })
  }

  mudarVista(vista: Vista): void {
    this.vista.set(vista)
    if (vista === 'anterior' && this.anterior() === null) void this.carregarAnterior()
  }

  private async carregarAnterior(): Promise<void> {
    const v = this.versaoPronta()
    if (!v || v.versao <= 1) return
    const n = this.pedido
    this.anterior.set({ estado: 'carregando' })
    const r = await this.api.lerVersao(this.documento().id, v.versao - 1)
    if (n !== this.pedido) return
    this.anterior.set(r.ok ? { estado: 'pronto', valor: r.versao } : { estado: 'erro', mensagem: mensagemFalhaVersao(r.erro.erro, r.erro.primeiraRegistrada) })
  }

  async restaurar(ev: Event, v: VersaoCompleta): Promise<void> {
    ev.preventDefault()
    if (this.restaurando() || this.erroObservacao()) return
    const nova = this.documento().versao + 1
    const ok = await this.confirmacao.confirmar({
      titulo: `Restaurar a v${v.versao}?`,
      mensagem: `O texto da v${v.versao} vira a v${nova} e o agente passa a usá-lo na próxima resposta. Nenhuma versão é apagada.`,
      acao: 'Restaurar',
    })
    if (!ok) return
    this.restaurando.set(true)
    try {
      const r = await this.api.restaurar(this.documento().id, v.versao, this.observacao().trim())
      if (r.ok) {
        this.toast.sucesso(`v${v.versao} restaurada — agora na v${r.documento.versao}.`)
        this.restaurado.emit(r.documento)
        return
      }
      if (r.status === 403) { this.estado.set('sem_permissao'); return }
      this.toast.erro(r.erro.mensagem ?? mensagemFalhaVersao(r.erro.erro))
    } finally { this.restaurando.set(false) }
  }
}
