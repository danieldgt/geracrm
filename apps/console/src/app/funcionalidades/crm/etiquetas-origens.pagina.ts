import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core'
import {
  AbasComponente, BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico,
  EstadoComponente, GradeFormComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ToastServico, mensagemDeErro, mesclarPagina, ehStatus, type Aba, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'
import { EtiquetasServico, type Etiqueta, type Origem } from './etiquetas.servico.js'
import { CORES_ETIQUETA, ROTULO_COR, erroDoNome, lerOrdem, tokenDaCor } from './etiquetas.regras.js'

type Aba_ = 'etiquetas' | 'origens'
type EstadoLista = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
interface EdicaoAberta { readonly aba: Aba_; readonly id: string | null }

const OPCOES_COR: OpcaoSelect[] = CORES_ETIQUETA.map((c) => ({ valor: c, rotulo: ROTULO_COR[c] }))

/**
 * Etiquetas e origens (A4) — padrão Lista + CRUD em modal. Leitura para todos; quem não pode
 * escrever recebe 403 da API e a mensagem aparece no modal. Desativar não apaga: o contato
 * que já usa a etiqueta/origem a mantém.
 */
@Component({
  selector: 'app-etiquetas-origens',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AbasComponente, BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente,
    GradeFormComponente, ModalComponente, PaginacaoComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Etiquetas e origens"
      subtitulo="Classifique os contatos: etiquetas coloridas e a origem de cada cadastro.">
      <button type="button" class="btn btn--primario" (click)="novo()">
        {{ aba() === 'etiquetas' ? '+ Nova etiqueta' : '+ Nova origem' }}
      </button>
    </ui-cabecalho-tela>

    <ui-abas [abas]="abas()" [(ativa)]="aba" />

    <div class="corpo">
      @if (aba() === 'etiquetas') {
        @if (estadoEtiquetas() === 'erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as etiquetas" [descricao]="erroEtiquetas()">
            <button type="button" class="btn btn--secundario" (click)="carregarEtiquetas()">Tentar de novo</button>
          </ui-estado>
        } @else if (estadoEtiquetas() === 'sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso às etiquetas" descricao="Peça acesso a um administrador." />
        } @else {
          <ui-tabela [colunas]="colunasEtiqueta" [linhas]="linhasEtiqueta()" [carregando]="estadoEtiquetas() === 'carregando'">
            <ng-template uiCelula="nome" let-l>
              <span class="chip"><span class="ponto" aria-hidden="true" [style.background]="token(l.cor)"></span>{{ l.nome }}</span>
            </ng-template>
            <ng-template uiCelula="cor" let-l>{{ rotuloCor(l.cor) }}</ng-template>
            <ng-template uiCelula="ativa" let-l>
              <ui-badge [tom]="l.ativa ? 'sucesso' : 'neutro'">{{ l.ativa ? 'Ativa' : 'Inativa' }}</ui-badge>
            </ng-template>
            <ng-template uiCelula="acoes" let-l>
              <span class="acoes">
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="editar('etiquetas', l.id)">Editar</button>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="alternarAtiva('etiquetas', l.id)">
                  {{ l.ativa ? 'Desativar' : 'Reativar' }}
                </button>
              </span>
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Nenhuma etiqueta ainda"
                descricao="Crie etiquetas como VIP ou Quente para filtrar e marcar seus contatos.">
                <button type="button" class="btn btn--primario" (click)="novo()">+ Nova etiqueta</button>
              </ui-estado>
            </div>
          </ui-tabela>
          @if (estadoEtiquetas() === 'pronto') {
            <ui-paginacao [mostrados]="etiquetas().length" [temMais]="cursorEtiquetas() !== null"
              [carregando]="carregandoMais()" (mais)="carregarEtiquetas(true)" />
          }
        }
      } @else {
        @if (estadoOrigens() === 'erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as origens" [descricao]="erroOrigens()">
            <button type="button" class="btn btn--secundario" (click)="carregarOrigens()">Tentar de novo</button>
          </ui-estado>
        } @else if (estadoOrigens() === 'sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso às origens" descricao="Peça acesso a um administrador." />
        } @else {
          <ui-tabela [colunas]="colunasOrigem" [linhas]="linhasOrigem()" [carregando]="estadoOrigens() === 'carregando'">
            <ng-template uiCelula="ativa" let-l>
              <ui-badge [tom]="l.ativa ? 'sucesso' : 'neutro'">{{ l.ativa ? 'Ativa' : 'Inativa' }}</ui-badge>
            </ng-template>
            <ng-template uiCelula="acoes" let-l>
              <span class="acoes">
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="editar('origens', l.id)">Editar</button>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="alternarAtiva('origens', l.id)">
                  {{ l.ativa ? 'Desativar' : 'Reativar' }}
                </button>
              </span>
            </ng-template>
            <div uiVazio>
              <ui-estado titulo="Nenhuma origem ainda"
                descricao="Cadastre de onde seus contatos vêm: Site, Indicação, Feira, Instagram...">
                <button type="button" class="btn btn--primario" (click)="novo()">+ Nova origem</button>
              </ui-estado>
            </div>
          </ui-tabela>
          @if (estadoOrigens() === 'pronto') {
            <ui-paginacao [mostrados]="origens().length" [temMais]="cursorOrigens() !== null"
              [carregando]="carregandoMais()" (mais)="carregarOrigens(true)" />
          }
        }
      }
    </div>

    <ui-modal [aberto]="edicao() !== null" [titulo]="tituloModal()" largura="p" (fechar)="fechar()">
      <form id="form-catalogo" (submit)="salvar($event)">
        <ui-grade-form [colunas]="2">
          <ui-campo class="largo" rotulo="Nome" [obrigatorio]="true" [(valor)]="nome" [erro]="erroNome()" />
          @if (edicao()?.aba === 'etiquetas') {
            <ui-select class="largo" rotulo="Cor" [opcoes]="opcoesCor" [(valor)]="cor" />
          } @else {
            <ui-campo class="largo" rotulo="Ordem" dica="Menor aparece primeiro (0 a 9999)." [(valor)]="ordem" [erro]="erroOrdem()" />
          }
        </ui-grade-form>
        @if (erroEnvio(); as e) { <p class="erro-envio" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar()">Cancelar</button>
        <button type="submit" form="form-catalogo" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Salvar' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .chip { display: inline-flex; align-items: center; gap: var(--espacamento-2); }
    .ponto { width: 10px; height: 10px; border-radius: var(--raio-completo); flex: none; }
    .acoes { display: inline-flex; gap: var(--espacamento-2); }
    .erro-envio { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class EtiquetasOrigensPagina implements OnInit {
  private readonly api = inject(EtiquetasServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly colunasEtiqueta: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Etiqueta' },
    { chave: 'cor', rotulo: 'Cor', largura: '140px' },
    { chave: 'ativa', rotulo: 'Situação', largura: '120px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '220px' },
  ]
  protected readonly colunasOrigem: ColunaTabela[] = [
    { chave: 'nome', rotulo: 'Origem' },
    { chave: 'ordem', rotulo: 'Ordem', mono: true, largura: '100px' },
    { chave: 'ativa', rotulo: 'Situação', largura: '120px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '220px' },
  ]
  protected readonly opcoesCor = OPCOES_COR

  protected readonly aba = signal<Aba_>('etiquetas')
  protected readonly etiquetas = signal<readonly Etiqueta[]>([])
  protected readonly origens = signal<readonly Origem[]>([])
  protected readonly estadoEtiquetas = signal<EstadoLista>('carregando')
  protected readonly estadoOrigens = signal<EstadoLista>('carregando')
  protected readonly erroEtiquetas = signal('')
  protected readonly erroOrigens = signal('')
  protected readonly cursorEtiquetas = signal<string | null>(null)
  protected readonly cursorOrigens = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)

  protected readonly abas = computed<Aba[]>(() => [
    { id: 'etiquetas', rotulo: 'Etiquetas' },
    { id: 'origens', rotulo: 'Origens' },
  ])
  protected readonly linhasEtiqueta = computed(() => this.etiquetas() as unknown as readonly LinhaTabela[])
  protected readonly linhasOrigem = computed(() => this.origens() as unknown as readonly LinhaTabela[])

  // Modal de criar/editar
  protected readonly edicao = signal<EdicaoAberta | null>(null)
  protected readonly nome = signal('')
  protected readonly cor = signal('neutro')
  protected readonly ordem = signal('0')
  protected readonly erroNome = signal<string | null>(null)
  protected readonly erroOrdem = signal<string | null>(null)
  protected readonly erroEnvio = signal<string | null>(null)
  protected readonly salvando = signal(false)
  protected readonly tituloModal = computed(() => {
    const e = this.edicao()
    if (!e) return ''
    const o = e.aba === 'etiquetas' ? 'etiqueta' : 'origem'
    return e.id ? `Editar ${o}` : `Nova ${o}`
  })

  ngOnInit(): void {
    void this.carregarEtiquetas()
    void this.carregarOrigens()
  }

  protected token(cor: string): string { return tokenDaCor(cor) }
  protected rotuloCor(cor: string): string { return ROTULO_COR[cor as keyof typeof ROTULO_COR] ?? cor }

  async carregarEtiquetas(mais = false): Promise<void> {
    if (mais) this.carregandoMais.set(true); else this.estadoEtiquetas.set('carregando')
    try {
      const p = await this.api.etiquetas(mais ? this.cursorEtiquetas() : null)
      this.etiquetas.set(mais ? mesclarPagina(this.etiquetas(), p.itens, (i) => i.id) : [...p.itens])
      this.cursorEtiquetas.set(p.proximoCursor)
      this.estadoEtiquetas.set('pronto')
    } catch (e) {
      this.erroEtiquetas.set(mensagemDeErro(e, 'Erro ao carregar as etiquetas.'))
      this.estadoEtiquetas.set(ehStatus(e, 403) ? 'sem_permissao' : 'erro')
    } finally { this.carregandoMais.set(false) }
  }

  async carregarOrigens(mais = false): Promise<void> {
    if (mais) this.carregandoMais.set(true); else this.estadoOrigens.set('carregando')
    try {
      const p = await this.api.origens(mais ? this.cursorOrigens() : null)
      this.origens.set(mais ? mesclarPagina(this.origens(), p.itens, (i) => i.id) : [...p.itens])
      this.cursorOrigens.set(p.proximoCursor)
      this.estadoOrigens.set('pronto')
    } catch (e) {
      this.erroOrigens.set(mensagemDeErro(e, 'Erro ao carregar as origens.'))
      this.estadoOrigens.set(ehStatus(e, 403) ? 'sem_permissao' : 'erro')
    } finally { this.carregandoMais.set(false) }
  }

  protected novo(): void { this.abrir(this.aba(), null) }
  protected editar(aba: Aba_, id: string): void { this.abrir(aba, id) }

  private abrir(aba: Aba_, id: string | null): void {
    this.erroNome.set(null); this.erroOrdem.set(null); this.erroEnvio.set(null)
    if (id && aba === 'etiquetas') {
      const e = this.etiquetas().find((x) => x.id === id)
      this.nome.set(e?.nome ?? ''); this.cor.set(e?.cor ?? 'neutro')
    } else if (id) {
      const o = this.origens().find((x) => x.id === id)
      this.nome.set(o?.nome ?? ''); this.ordem.set(String(o?.ordem ?? 0))
    } else {
      this.nome.set(''); this.cor.set('neutro'); this.ordem.set('0')
    }
    this.edicao.set({ aba, id })
  }

  protected fechar(): void { if (!this.salvando()) this.edicao.set(null) }

  protected async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const e = this.edicao()
    if (!e || this.salvando()) return
    const ehEtiqueta = e.aba === 'etiquetas'
    const erroN = erroDoNome(this.nome(), ehEtiqueta ? 40 : 60)
    const ordem = ehEtiqueta ? 0 : lerOrdem(this.ordem())
    this.erroNome.set(erroN)
    this.erroOrdem.set(ordem === null ? 'Use um número inteiro de 0 a 9999.' : null)
    if (erroN || ordem === null) return
    this.salvando.set(true); this.erroEnvio.set(null)
    try {
      const nome = this.nome().trim()
      if (ehEtiqueta) {
        if (e.id) await this.api.editarEtiqueta(e.id, { nome, cor: this.cor() })
        else await this.api.criarEtiqueta({ nome, cor: this.cor() })
      } else if (e.id) await this.api.editarOrigem(e.id, { nome, ordem })
      else await this.api.criarOrigem({ nome, ordem })
      this.edicao.set(null)
      this.toast.sucesso(e.id ? 'Alterações salvas.' : 'Cadastro criado.')
      await (ehEtiqueta ? this.carregarEtiquetas() : this.carregarOrigens())
    } catch (err) {
      this.erroEnvio.set(mensagemDeErro(err, 'Não foi possível salvar.'))
    } finally { this.salvando.set(false) }
  }

  protected async alternarAtiva(aba: Aba_, id: string): Promise<void> {
    const item = aba === 'etiquetas' ? this.etiquetas().find((x) => x.id === id) : this.origens().find((x) => x.id === id)
    if (!item) return
    const desativar = item.ativa
    if (desativar) {
      const ok = await this.confirmacao.confirmar({
        titulo: `Desativar "${item.nome}"?`,
        mensagem: 'Deixa de aparecer para novas escolhas. Quem já usa continua com ela.',
        acao: 'Desativar', perigo: true,
      })
      if (!ok) return
    }
    try {
      if (aba === 'etiquetas') await this.api.editarEtiqueta(id, { ativa: !desativar })
      else await this.api.editarOrigem(id, { ativa: !desativar })
      await (aba === 'etiquetas' ? this.carregarEtiquetas() : this.carregarOrigens())
    } catch (err) {
      this.toast.erro(mensagemDeErro(err, 'Não foi possível alterar.'))
    }
  }
}
