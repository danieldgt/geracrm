import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'

interface Conta {
  readonly id: string
  readonly plataforma: string
  readonly idExterno: string
  readonly nome: string
  readonly moeda: string
  readonly ativo: boolean
}
interface Anuncio {
  readonly id: string
  readonly nome: string
  readonly estado: string
  readonly campanha: string
  readonly custoCentavos: string
  readonly cliques: number
  readonly impressoes: number
  readonly leads: number
}
interface Lp {
  readonly id: string
  readonly nome: string
  readonly url: string
  readonly ativo: boolean
  readonly sessoes: number
  readonly consumidas: number
  /** ⚠️ `null` = ninguém clicou ainda. Diferente de 0% (todo clique preservou o código). */
  readonly taxaPerdida: number | null
}
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * Mídia paga (AQ-06) — custo e leads por anúncio.
 *
 * ⚠️ **Custo por lead é o número que a tela existe para mostrar**, e não CPL da
 * plataforma: é o nosso custo dividido pelos leads que ENTRARAM no CRM. A
 * diferença entre os dois é justamente o que a operação enxerga e o painel do
 * Google não.
 *
 * ⚠️ ROAS **não aparece aqui de propósito.** Ele exige declarar o modelo de
 * atribuição e a janela (AMK-009), e um número desses solto numa lista viraria
 * promessa que o produto não sustenta. Vive na tela do anúncio, com o rótulo ao
 * lado.
 */
@Component({
  selector: 'app-midia',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="cabecalho">
      <h1>Mídia paga</h1>
      <p class="sub">O que cada anúncio custou e quantos leads trouxe, no período.</p>
    </header>

    <form class="filtros" (submit)="$event.preventDefault(); carregar()">
      <label>De <input type="date" [value]="de()" (change)="de.set($any($event.target).value)" /></label>
      <label>Até <input type="date" [value]="ate()" (change)="ate.set($any($event.target).value)" /></label>
      <button class="btn btn--secundario" type="submit">Aplicar</button>
    </form>

    <details class="conectar" [open]="contas().length === 0">
      <summary>Conectar conta de anúncio</summary>
      <form class="nova" (submit)="conectar($event)">
        <label>Plataforma
          <select [value]="novaPlataforma()" (change)="novaPlataforma.set($any($event.target).value)">
            <option value="google">Google Ads</option>
            <option value="meta">Meta</option>
            <option value="tiktok">TikTok</option>
          </select>
        </label>
        <label>ID da conta
          <input [value]="novoIdExterno()" (input)="novoIdExterno.set($any($event.target).value)"
                 placeholder="997-075-4431" aria-label="ID da conta na plataforma" />
        </label>
        <label>Nome
          <input [value]="novoNome()" (input)="novoNome.set($any($event.target).value)"
                 placeholder="Drezz — aquisição" aria-label="Nome da conta" />
        </label>
        <label>Moeda
          <input [value]="novaMoeda()" (input)="novaMoeda.set($any($event.target).value.toUpperCase())"
                 maxlength="3" size="4" aria-label="Moeda" />
        </label>
        <button class="btn btn--primario" type="submit"
                [disabled]="conectando() || !novoIdExterno().trim() || !novoNome().trim()">
          {{ conectando() ? 'Conectando…' : 'Conectar' }}
        </button>
      </form>
      <!-- ⚠️ A moeda não muda depois: some do formulário e vira propriedade da
           conta. Errar aqui contamina todo o custo — e a correção é recriar. -->
      <p class="dica">A moeda <strong>não pode ser alterada</strong> depois. Ela precisa bater com a
        configurada na plataforma — somar custo entre moedas dá número sem significado.</p>
      @if (erroConectar(); as e) { <p class="erro" role="alert">{{ e }}</p> }
    </details>

    @if (contas().length > 0) {
      <ul class="contas">
        @for (c of contas(); track c.id) {
          <li class="conta">
            <span class="nome">{{ c.nome }}</span>
            <span class="dado">{{ c.plataforma }} · {{ c.idExterno }} · {{ c.moeda }}</span>
            @if (!c.ativo) { <span class="badge">inativa</span> }
          </li>
        }
      </ul>
    }

    <!-- ⚠️ Landing pages (AQ-44). Sem destino não há campanha no Google: o
         anúncio precisa de uma URL, e é ela que carrega o clique até a conversa. -->
    <details class="conectar" [open]="lps().length === 0">
      <summary>Landing pages do anúncio</summary>
      <form class="nova" (submit)="criarLp($event)">
        <label>Nome interno
          <input [value]="lpNome()" (input)="lpNome.set($any($event.target).value)"
                 placeholder="Uniformes — PE" aria-label="Nome interno da landing page" />
        </label>
        <label>Título da página
          <input [value]="lpTitulo()" (input)="lpTitulo.set($any($event.target).value)"
                 placeholder="Uniformes para a sua equipe" aria-label="Título da página" />
        </label>
        <label>WhatsApp de destino
          <input [value]="lpTelefone()" (input)="lpTelefone.set($any($event.target).value)"
                 placeholder="55 81 99999-8888" aria-label="WhatsApp de destino" />
        </label>
        <button class="btn btn--primario" type="submit"
                [disabled]="criandoLp() || !lpNome().trim() || !lpTitulo().trim()">
          {{ criandoLp() ? 'Criando…' : 'Criar landing page' }}
        </button>
      </form>
      <p class="dica">O link abaixo é o que vai no anúncio. Ele guarda o clique (gclid/UTM) e
        abre o WhatsApp com um código — é esse código que liga a venda ao anúncio que a pagou.</p>
      @if (erroLp(); as e) { <p class="erro" role="alert">{{ e }}</p> }
    </details>

    @if (lps().length > 0) {
      <ul class="contas">
        @for (l of lps(); track l.id) {
          <li class="conta lp">
            <span class="nome">{{ l.nome }}</span>
            <span class="dado url">{{ urlCompleta(l.url) }}</span>
            <button class="btn btn--secundario btn--pequeno" (click)="copiar(l.url)">
              {{ copiado() === l.url ? 'Copiado' : 'Copiar link' }}
            </button>
            <!-- ⚠️ "—" quando ninguém clicou: 0% de código perdido sem sessão
                 nenhuma seria uma saúde que ninguém observou. -->
            <span class="dado">
              {{ l.sessoes }} cliques ·
              @if (l.taxaPerdida === null) { código perdido: — }
              @else { <span [class.ruim]="l.taxaPerdida > 0.5">código perdido: {{ pct(l.taxaPerdida) }}</span> }
            </span>
            @if (!l.ativo) { <span class="badge">desligada</span> }
          </li>
        }
      </ul>
    }

    @switch (estado()) {
      @case ('carregando') { <div class="bloco"><div class="esqueleto"></div></div> }
      @case ('sem_permissao') { <div class="bloco aviso"><h2>Sem acesso</h2>
        <p>Sua conta não tem permissão para ver a mídia.</p></div> }
      @case ('erro') { <div class="bloco aviso"><h2>Não foi possível carregar</h2>
        <button class="btn btn--secundario" (click)="carregar()">Tentar de novo</button></div> }
      @case ('pronto') {
        @if (itens().length === 0) {
          <div class="bloco vazio">
            <h2>Nenhum anúncio no período</h2>
            <!-- ⚠️ Vazio aqui quase nunca é "não há dado": é conta não conectada
                 ou sincronização que ainda não rodou. Dizer isso evita a leitura
                 errada de que a campanha não gastou nada. -->
            <p>Se a conta acabou de ser conectada, a primeira sincronização pode levar algumas horas.</p>
          </div>
        } @else {
          <table class="tabela">
            <thead>
              <tr>
                <th>Anúncio</th><th>Campanha</th>
                <th class="num">Impressões</th><th class="num">Cliques</th>
                <th class="num">Custo</th><th class="num">Leads</th>
                <th class="num">Custo/lead</th>
              </tr>
            </thead>
            <tbody>
              @for (a of itens(); track a.id) {
                <tr>
                  <!-- ⚠️ O nome vira link para o ROI (AQ-16): é onde o "gastei X"
                       da lista encontra o "faturei Y". -->
                  <td><a class="link-anuncio" [routerLink]="['/midia/anuncio', a.id]">{{ a.nome }}</a>
                    @if (a.estado !== 'ativa') { <span class="badge">{{ a.estado }}</span> }</td>
                  <td class="suave">{{ a.campanha }}</td>
                  <td class="num">{{ a.impressoes }}</td>
                  <td class="num">{{ a.cliques }}</td>
                  <td class="num">{{ dinheiro(a.custoCentavos) }}</td>
                  <td class="num">{{ a.leads }}</td>
                  <!-- ⚠️ Traço, não "R$ 0,00", quando não há lead: zero lead com
                       custo não é custo-por-lead zero — é indefinido. -->
                  <td class="num forte">{{ custoPorLead(a) }}</td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4">Total</td>
                <td class="num">{{ dinheiro(totalCusto()) }}</td>
                <td class="num">{{ totalLeads() }}</td>
                <td class="num forte">{{ custoPorLeadTotal() }}</td>
              </tr>
            </tfoot>
          </table>
          @if (temMais()) { <button class="btn btn--secundario mais" (click)="carregarMais()">Carregar mais</button> }
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .cabecalho { margin-bottom: var(--espacamento-5); }
    h1 { margin: 0; font-size: 20px; color: var(--texto); }
    .sub { margin: var(--espacamento-1) 0 0; color: var(--texto-secundario); font-size: 14px; }
    .filtros { display: flex; gap: var(--espacamento-3); align-items: end; margin-bottom: var(--espacamento-4); flex-wrap: wrap; }
    .filtros label { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 12px; color: var(--texto-secundario); }
    .filtros input { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .conectar { margin-bottom: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); padding: var(--espacamento-3) var(--espacamento-4); }
    .conectar summary { cursor: pointer; font-size: 13px; color: var(--texto); }
    .nova { display: flex; gap: var(--espacamento-3); align-items: end; flex-wrap: wrap; margin-top: var(--espacamento-3); }
    .nova label { display: flex; flex-direction: column; gap: var(--espacamento-1); font-size: 12px; color: var(--texto-secundario); }
    .nova input, .nova select { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .dica { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); }
    .erro { color: var(--erro); font-size: 13px; margin: var(--espacamento-2) 0 0; }
    .contas { list-style: none; display: flex; gap: var(--espacamento-3); flex-wrap: wrap; margin: 0 0 var(--espacamento-4); padding: 0; }
    .conta { display: flex; flex-direction: column; gap: 2px; padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .conta .nome { font-size: 13px; color: var(--texto); }
    .conta .dado { font-size: 11px; color: var(--texto-suave); font-family: var(--tipografia-familia-dados, monospace); }
    .badge { font-size: 11px; color: var(--texto-suave); border: 1px solid var(--borda); border-radius: var(--raio-controle); padding: 0 var(--espacamento-1); margin-left: var(--espacamento-1); }
    .bloco { padding: var(--espacamento-8); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .bloco h2 { margin: 0 0 var(--espacamento-2); font-size: 16px; color: var(--texto); }
    .bloco p { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .esqueleto { height: 44px; border-radius: var(--raio-controle); background: var(--superficie); }
    .tabela { width: 100%; border-collapse: collapse; border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); overflow: hidden; }
    th, td { padding: var(--espacamento-2) var(--espacamento-3); text-align: left; font-size: 13px; border-bottom: 1px solid var(--borda); }
    th { color: var(--texto-secundario); font-weight: 500; font-size: 12px; }
    td { color: var(--texto); }
    td.suave { color: var(--texto-suave); }
    /* ⚠️ tabular-nums: sem isso, coluna de dinheiro não alinha e o olho não compara. */
    .num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--tipografia-familia-dados, monospace); }
    .forte { color: var(--texto); font-weight: 600; }
    tfoot td { border-bottom: none; border-top: 1px solid var(--borda-forte); color: var(--texto-secundario); }
    .mais { margin-top: var(--espacamento-3); }
    .link-anuncio { color: var(--acao); text-decoration: none; }
    .link-anuncio:hover { text-decoration: underline; }
    .conta.lp { flex-wrap: wrap; }
    /* ⚠️ min-width:0 + quebra: URL é uma palavra só e estoura a linha inteira,
       empurrando o botão de copiar para fora da caixa. */
    .conta.lp .url { min-width: 0; word-break: break-all; font-family: var(--tipografia-familia-dados, monospace); }
    .conta.lp .ruim { color: var(--erro); }
  `,
})
export class MidiaPagina implements OnInit {
  readonly #http = inject(HttpClient)

  readonly estado = signal<Estado>('carregando')
  readonly contas = signal<readonly Conta[]>([])
  readonly itens = signal<readonly Anuncio[]>([])
  readonly temMais = signal(false)
  readonly #cursor = signal<string | null>(null)

  readonly novaPlataforma = signal('google')
  readonly novoIdExterno = signal('')
  readonly novoNome = signal('')
  readonly novaMoeda = signal('BRL')
  readonly conectando = signal(false)
  readonly erroConectar = signal<string | null>(null)

  readonly de = signal(this.#diasAtras(30))
  readonly ate = signal(this.#diasAtras(0))

  readonly lps = signal<readonly Lp[]>([])
  readonly lpNome = signal('')
  readonly lpTitulo = signal('')
  readonly lpTelefone = signal('')
  readonly criandoLp = signal(false)
  readonly erroLp = signal<string | null>(null)
  readonly copiado = signal<string | null>(null)

  readonly totalCusto = computed(() =>
    // ⚠️ String → Number aqui, e não somando strings: `custoCentavos` vem como
    //    texto porque é bigint no banco (INV-46). "2" + "3" seria "23".
    String(this.itens().reduce((s, a) => s + Number(a.custoCentavos), 0)))
  readonly totalLeads = computed(() => this.itens().reduce((s, a) => s + a.leads, 0))

  ngOnInit(): void { void this.carregar() }

  #diasAtras(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  }

  dinheiro(centavos: string | number): string {
    return (Number(centavos) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  /** ⚠️ Traço quando não há lead: zero lead não é custo-por-lead zero, é indefinido. */
  custoPorLead(a: Anuncio): string {
    return a.leads > 0 ? this.dinheiro(Number(a.custoCentavos) / a.leads) : '—'
  }
  custoPorLeadTotal(): string {
    const l = this.totalLeads()
    return l > 0 ? this.dinheiro(Number(this.totalCusto()) / l) : '—'
  }

  async conectar(ev: Event): Promise<void> {
    ev.preventDefault()
    this.conectando.set(true)
    this.erroConectar.set(null)
    try {
      await firstValueFrom(this.#http.post('/v1/aquisicao/contas', {
        plataforma: this.novaPlataforma(),
        idExterno: this.novoIdExterno().trim(),
        nome: this.novoNome().trim(),
        moeda: this.novaMoeda().trim() || 'BRL',
      }))
      this.novoIdExterno.set(''); this.novoNome.set('')
      await this.carregar()
    } catch (e) {
      // ⚠️ Conflito é resultado ESPERADO, com mensagem própria — a API devolve
      //    409 nomeado, e repetir "erro ao salvar" desperdiçaria a informação.
      const st = e instanceof HttpErrorResponse ? e.status : 0
      this.erroConectar.set(
        st === 409 ? 'Esta conta já está conectada.'
        : st === 422 ? 'Confira a plataforma e o ID da conta.'
        : 'Não foi possível conectar. Tente de novo.')
    } finally {
      this.conectando.set(false)
    }
  }

  /**
   * ⚠️ A URL que vai no anúncio é ABSOLUTA e sai da origem atual: a API devolve o
   * caminho, e o link é servido na mesma origem do console (proxy do nginx). Um
   * caminho relativo colado no Google Ads não é um destino.
   */
  urlCompleta(caminho: string): string {
    return `${location.origin}${caminho}`
  }

  pct(taxa: number): string { return `${Math.round(taxa * 100)}%` }

  async copiar(caminho: string): Promise<void> {
    const url = this.urlCompleta(caminho)
    try {
      await navigator.clipboard.writeText(url)
      this.copiado.set(caminho)
      setTimeout(() => this.copiado.set(null), 2000)
    } catch {
      // Clipboard bloqueado (http, permissão): a URL está na tela e dá para
      // selecionar à mão — não vale travar a tela por causa disso.
      this.erroLp.set('Não consegui copiar. Selecione o link na tela.')
    }
  }

  async criarLp(ev: Event): Promise<void> {
    ev.preventDefault()
    this.criandoLp.set(true)
    this.erroLp.set(null)
    try {
      await firstValueFrom(this.#http.post('/v1/aquisicao/lps', {
        nome: this.lpNome().trim(),
        titulo: this.lpTitulo().trim(),
        telefone: this.lpTelefone().trim(),
      }))
      this.lpNome.set(''); this.lpTitulo.set(''); this.lpTelefone.set('')
      await this.#carregarLps()
    } catch (e) {
      const st = e instanceof HttpErrorResponse ? e.status : 0
      const campo = e instanceof HttpErrorResponse ? String(e.error?.campo ?? '') : ''
      this.erroLp.set(
        st === 422 && campo === 'telefone' ? 'Informe o WhatsApp com DDD e DDI (ex.: 55 81 99999-8888).'
        : st === 422 ? 'Confira o nome e o título da página.'
        : 'Não foi possível criar a landing page. Tente de novo.')
    } finally {
      this.criandoLp.set(false)
    }
  }

  /** ⚠️ PARCIAL: se as LPs falharem, a tela de mídia continua de pé. */
  async #carregarLps(): Promise<void> {
    try {
      const r = await firstValueFrom(this.#http.get<{ itens: Lp[] }>('/v1/aquisicao/lps'))
      this.lps.set(r.itens)
    } catch { this.lps.set([]) }
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.#cursor.set(null)
    try {
      const c = await firstValueFrom(
        this.#http.get<{ contas: Conta[] }>('/v1/aquisicao/contas'))
      this.contas.set(c.contas)
      await this.#carregarLps()
      const r = await this.#buscarPagina(null)
      this.itens.set(r.itens)
      this.temMais.set(r.temMais)
      this.#cursor.set(r.cursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMais(): Promise<void> {
    try {
      const r = await this.#buscarPagina(this.#cursor())
      this.itens.update((atual) => [...atual, ...r.itens])
      this.temMais.set(r.temMais)
      this.#cursor.set(r.cursor)
    } catch { this.estado.set('erro') }
  }

  #buscarPagina(cursor: string | null): Promise<{ itens: Anuncio[]; temMais: boolean; cursor: string | null }> {
    const q = new URLSearchParams({ de: this.de(), ate: this.ate() })
    if (cursor) q.set('cursor', cursor)
    return firstValueFrom(
      this.#http.get<{ itens: Anuncio[]; temMais: boolean; cursor: string | null }>(
        `/v1/aquisicao/anuncios?${q.toString()}`))
  }
}
