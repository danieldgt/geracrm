import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { SlicePipe } from '@angular/common'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, PaginacaoComponente, TabelaComponente,
  ToastServico, mensagemDeErro, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'

interface Vendedor { readonly usuarioId: string; readonly usuario: string; readonly clientes: number }
interface Membro { readonly id: string; readonly nome: string }
interface ContatoCarteira { readonly id: string; readonly nome: string; readonly qtdVendas: number; readonly ultimaVendaEm: string | null }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
// Alvo aberto no painel da direita: um vendedor específico, os órfãos, ou nada.
type Alvo = { tipo: 'vendedor'; id: string; nome: string } | { tipo: 'orfaos' } | null

/**
 * Vendedores e Carteiras — quem é o dono de cada cliente, com transferência
 * atômica (a API fecha o período e abre o novo na mesma transação) e órfãos
 * visíveis. ⚠️ Órfão não some: aparece como uma "carteira" própria a distribuir.
 * Padrão Lista em duas colunas: carteiras à esquerda, clientes em tabela à
 * direita, com paginação por cursor.
 */
@Component({
  selector: 'app-carteiras',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CabecalhoTelaComponente, CelulaDiretiva, EstadoComponente, PaginacaoComponente, RouterLink, SlicePipe, TabelaComponente],
  template: `
    <ui-cabecalho-tela titulo="Vendedores e Carteiras"
      subtitulo="Quem é o dono de cada cliente. Toda transferência fica no histórico." />

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <div class="grade" aria-busy="true">
            <div class="col">
              <div class="esq"></div>
              <div class="esq"></div>
            </div>
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso às carteiras" descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as carteiras" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <div class="grade">
            <!-- Coluna 1: as carteiras (vendedores + órfãos) -->
            <section class="col" aria-label="Carteiras">
              <ul class="lista">
                @if (orfaos() > 0) {
                  <li class="cart" [class.on]="ehAlvo('orfaos')" (click)="abrirOrfaos()">
                    <span class="ava orfao" aria-hidden="true">?</span>
                    <span class="cart-nome encolhe">Sem dono</span>
                    <span class="cart-qtd txt-dados alerta">{{ orfaos() }}</span>
                  </li>
                }
                @for (v of vendedores(); track v.usuarioId) {
                  <li class="cart" [class.on]="ehAlvo('vendedor', v.usuarioId)" (click)="abrirVendedor(v)">
                    <span class="ava" aria-hidden="true">{{ inicial(v.usuario) }}</span>
                    <span class="cart-nome encolhe">{{ v.usuario }}</span>
                    <span class="cart-qtd txt-dados">{{ v.clientes }}</span>
                  </li>
                }
                @if (vendedores().length === 0 && orfaos() === 0) {
                  <li class="vazio">Nenhuma carteira atribuída ainda.</li>
                }
              </ul>
            </section>

            <!-- Coluna 2: clientes da carteira selecionada -->
            <section class="col detalhe">
              @if (alvo() === null) {
                <ui-estado titulo="Escolha uma carteira" descricao="Selecione um vendedor à esquerda para ver e transferir seus clientes." />
              } @else {
                <div class="det-topo">
                  <h2 class="txt-secao encolhe">{{ tituloAlvo() }}</h2>
                  <span class="det-qtd txt-dados">{{ contatos().length }}{{ temMais() ? '+' : '' }}</span>
                </div>
                @if (contatos().length === 0 && !erroContatos() && !carregandoContatos()) {
                  <ui-estado titulo="Sem clientes nesta carteira" descricao="Quando um cliente entrar aqui, ele aparece nesta lista." />
                } @else {
                  <ui-tabela [colunas]="colunas" [linhas]="linhas()" [chaveLinha]="chaveContato" [carregando]="carregandoContatos()">
                    <ng-template uiCelula="cliente" let-c>
                      <span class="cli">
                        <a class="cli-nome" [routerLink]="['/contato', c.id]">{{ c.nome }}</a>
                      </span>
                    </ng-template>
                    <ng-template uiCelula="ultimaVenda" let-c>{{ c.ultimaVendaEm ? (c.ultimaVendaEm | slice: 0:10) : '—' }}</ng-template>
                    <ng-template uiCelula="acoes" let-c>
                      <span class="acoes">
                        <select class="sel" [disabled]="movendo() === c.id" aria-label="Transferir {{ c.nome }} para outro vendedor"
                          (change)="transferir(c.id, $any($event.target).value); $any($event.target).value=''">
                          <option value="">Transferir…</option>
                          @for (m of equipe(); track m.id) {
                            @if (!ehDonoAtual(m.id)) { <option [value]="m.id">→ {{ m.nome }}</option> }
                          }
                        </select>
                        @if (alvo()?.tipo === 'vendedor') {
                          <button type="button" class="btn btn--perigo btn--pequeno" [disabled]="movendo() === c.id"
                            (click)="soltar(c.id)" [attr.aria-label]="'Deixar ' + c.nome + ' sem dono'">Soltar</button>
                        }
                      </span>
                    </ng-template>
                  </ui-tabela>
                  <div class="rodape">
                    <ui-paginacao [mostrados]="contatos().length" [temMais]="temMais()" (mais)="carregarContatos(true)" />
                  </div>
                }
                @if (erroContatos(); as e) {
                  <p class="erro" role="alert">{{ e }} <button type="button" class="btn btn--secundario btn--pequeno" (click)="carregarContatos()">Tentar de novo</button></p>
                }
              }
            </section>
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); min-width: 0; }
    .grade { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: var(--espacamento-4); align-items: start; }
    @media (max-width: 720px) { .grade { grid-template-columns: 1fr; } }
    .col { min-width: 0; }
    .esq { height: 52px; border-radius: var(--raio-controle); background: var(--superficie); margin-bottom: var(--espacamento-2); }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; background: var(--superficie-elevada); }
    .cart { display: flex; align-items: center; gap: var(--espacamento-3); padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); cursor: pointer; }
    .cart:last-child { border-bottom: none; }
    .cart:hover { background: var(--superficie); }
    .cart.on { background: var(--acao-suave); box-shadow: inset 3px 0 0 var(--acao); }
    .ava { width: 28px; height: 28px; border-radius: var(--raio-completo); background: var(--acao-suave); color: var(--acao); font-size: 12px; font-weight: 600; display: grid; place-items: center; flex: none; }
    .ava.orfao { background: var(--atencao-suave); color: var(--atencao); }
    .cart-nome { flex: 1; color: var(--texto); font-size: 14px; }
    .cart-qtd { color: var(--texto-secundario); font-weight: 600; }
    .cart-qtd.alerta { color: var(--atencao); }
    .vazio { padding: var(--espacamento-6); text-align: center; color: var(--texto-suave); font-size: 13px; }
    .det-topo { display: flex; align-items: baseline; justify-content: space-between; gap: var(--espacamento-3); margin-bottom: var(--espacamento-3); }
    .det-topo h2 { margin: 0; }
    .det-qtd { color: var(--texto-suave); }
    .cli { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .cli-nome { color: var(--acao); text-decoration: none; font-size: 14px; }
    .cli-nome:hover { text-decoration: underline; }
    .cli-nome:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: 2px; }
    .acoes { display: inline-flex; align-items: center; justify-content: flex-end; gap: var(--espacamento-2); flex-wrap: wrap; }
    .sel { padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; font-size: 12px; }
    .rodape { margin-top: var(--espacamento-2); }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; }
    button:disabled, select:disabled { opacity: .6; cursor: default; }
  `,
})
export class CarteirasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly vendedores = signal<readonly Vendedor[]>([])
  readonly orfaos = signal(0)
  readonly equipe = signal<readonly Membro[]>([])
  readonly alvo = signal<Alvo>(null)
  readonly contatos = signal<readonly ContatoCarteira[]>([])
  readonly linhas = computed(() => this.contatos() as unknown as LinhaTabela[])
  readonly temMais = signal(false)
  readonly movendo = signal<string | null>(null)
  readonly erroContatos = signal<string | null>(null)
  readonly carregandoContatos = signal(false)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)
  private cursor: string | null = null

  protected readonly colunas: readonly ColunaTabela[] = [
    { chave: 'cliente', rotulo: 'Cliente' },
    { chave: 'qtdVendas', rotulo: 'Compras', alinhamento: 'dir', mono: true, largura: '90px' },
    { chave: 'ultimaVenda', rotulo: 'Última venda', mono: true, largura: '120px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '300px' },
  ]
  protected readonly chaveContato = (l: LinhaTabela): string => String(l['id'])

  readonly tituloAlvo = computed(() => {
    const a = this.alvo()
    return a === null ? '' : a.tipo === 'orfaos' ? 'Clientes sem dono' : `Carteira de ${a.nome}`
  })

  ngOnInit(): void { void this.carregar() }
  inicial(nome: string): string { return (nome.trim()[0] ?? '?').toUpperCase() }
  ehAlvo(tipo: 'vendedor' | 'orfaos', id?: string): boolean {
    const a = this.alvo()
    return a?.tipo === tipo && (tipo === 'orfaos' || a.tipo === 'vendedor' && a.id === id)
  }
  ehDonoAtual(usuarioId: string): boolean {
    const a = this.alvo()
    return a?.tipo === 'vendedor' && a.id === usuarioId
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [resumo, equipe] = await Promise.all([
        firstValueFrom(this.http.get<{ itens: Vendedor[]; orfaos: number }>('/v1/carteiras')),
        firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe')),
      ])
      this.vendedores.set(resumo.itens)
      this.orfaos.set(resumo.orfaos)
      this.equipe.set(equipe.itens)
      this.estado.set('pronto')
      // Reabrir o alvo atual, se ainda existir; senão limpar o painel.
      const a = this.alvo()
      if (a?.tipo === 'vendedor' && !resumo.itens.some((v) => v.usuarioId === a.id)) this.alvo.set(null)
      else if (a?.tipo === 'orfaos' && resumo.orfaos === 0) this.alvo.set(null)
      else if (a !== null) await this.carregarContatos()
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  abrirVendedor(v: Vendedor): void { this.alvo.set({ tipo: 'vendedor', id: v.usuarioId, nome: v.usuario }); void this.carregarContatos() }
  abrirOrfaos(): void { this.alvo.set({ tipo: 'orfaos' }); void this.carregarContatos() }

  async carregarContatos(anexar = false): Promise<void> {
    const a = this.alvo()
    if (a === null) return
    if (!anexar) { this.cursor = null; this.contatos.set([]) }
    const base = a.tipo === 'orfaos' ? 'orfaos=1' : `usuarioId=${a.id}`
    const url = `/v1/carteiras/contatos?${base}${this.cursor ? `&cursor=${encodeURIComponent(this.cursor)}` : ''}`
    this.erroContatos.set(null)
    this.carregandoContatos.set(true)
    try {
      const r = await firstValueFrom(this.http.get<{ itens: ContatoCarteira[]; proximoCursor: string | null }>(url))
      this.contatos.set(anexar ? [...this.contatos(), ...r.itens] : r.itens)
      this.cursor = r.proximoCursor
      this.temMais.set(r.proximoCursor !== null)
    } catch (e) {
      // Parcial: as carteiras continuam; só os clientes do alvo não vieram.
      this.erroContatos.set(mensagemDeErro(e, 'Não foi possível carregar os clientes desta carteira.'))
    } finally {
      this.carregandoContatos.set(false)
    }
  }

  async transferir(contatoId: string, usuarioId: string): Promise<void> {
    if (!usuarioId || this.movendo()) return
    const destino = this.equipe().find((m) => m.id === usuarioId)?.nome ?? 'o vendedor'
    this.movendo.set(contatoId)
    try {
      await firstValueFrom(this.http.post(`/v1/contatos/${contatoId}/carteira`, { usuarioId }))
      this.toast.sucesso(`Cliente transferido para ${destino}`)
      await this.carregar()
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível transferir o cliente.'))
      await this.carregar() // reflete o estado real
    }
    finally { this.movendo.set(null) }
  }

  async soltar(contatoId: string): Promise<void> {
    if (this.movendo()) return
    const c = this.contatos().find((x) => x.id === contatoId)
    const ok = await this.confirmacao.confirmar({
      titulo: 'Deixar cliente sem dono?',
      mensagem: `${c?.nome ?? 'O cliente'} sai desta carteira e vai para os órfãos até alguém assumir. A transferência fica no histórico.`,
      acao: 'Soltar',
    })
    if (!ok) return
    this.movendo.set(contatoId)
    try {
      await firstValueFrom(this.http.delete(`/v1/contatos/${contatoId}/carteira`))
      this.toast.sucesso('Cliente solto da carteira')
      await this.carregar()
    } catch (e) {
      this.toast.erro(mensagemDeErro(e, 'Não foi possível soltar o cliente.'))
      await this.carregar()
    }
    finally { this.movendo.set(null) }
  }
}
