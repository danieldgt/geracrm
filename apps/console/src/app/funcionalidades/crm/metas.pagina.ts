import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente,
  GradeFormComponente, IconeComponente, ModalComponente, SelectComponente, TabelaComponente, ToastServico, mensagemDeErro,
  reaisParaCentavos, type ColunaTabela, type LinhaTabela, type OpcaoSelect,
} from '../../compartilhado/ui/index.js'

interface Meta {
  readonly id: string
  readonly usuarioId: string | null
  readonly usuario: string
  readonly tipo: string
  readonly alvo: number
  readonly realizado: number
  readonly realizadoDisponivel: boolean
  readonly pct: number
}
interface Membro { readonly id: string; readonly nome: string }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

/**
 * Metas de venda — alvo mensal (equipe e por vendedor) com o realizado derivado
 * das vendas do período. A equipe aparece no topo; abaixo, uma barra por vendedor.
 * Segue geracrm-layout-ui (5 estados, tokens, responsivo, sem cor literal).
 */
@Component({
  selector: 'app-metas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, GradeFormComponente,
    IconeComponente, ModalComponente, SelectComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Metas" subtitulo="Alvo do mês contra o que já foi vendido.">
      <div class="periodo">
        <button type="button" class="nav" (click)="mudarMes(-1)" aria-label="Mês anterior">‹</button>
        <span class="mes txt-dados">{{ rotuloMes() }}</span>
        <button type="button" class="nav" (click)="mudarMes(1)" aria-label="Próximo mês">›</button>
      </div>
      <button type="button" class="btn btn--primario" (click)="novaAberta.set(true)">
        <ui-icone nome="plus" />Nova meta
      </button>
    </ui-cabecalho-tela>

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso às metas" descricao="Peça acesso a um administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar as metas" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (itens().length === 0) {
            <ui-estado titulo="Sem metas neste mês" descricao="Defina uma meta — da equipe ou de um vendedor.">
              <button type="button" class="btn btn--primario" (click)="novaAberta.set(true)">Nova meta</button>
            </ui-estado>
          } @else {
            <ui-tabela [colunas]="colunas" [linhas]="linhas()">
              <ng-template uiCelula="usuario" let-m>
                <span class="nome">{{ m.usuario }}</span>
                @if (m.usuarioId === null) { <ui-badge tom="info">Equipe</ui-badge> }
              </ng-template>
              <ng-template uiCelula="progresso" let-m>
                <div class="progresso">
                  @if (m.realizadoDisponivel) {
                    <span class="pct txt-dados" [class.bateu]="m.pct >= 100">{{ m.pct }}%</span>
                  } @else {
                    <span class="pct-indisp">sem cálculo</span>
                  }
                  <span class="barra" aria-hidden="true">
                    <span class="preenche" [class.bateu]="m.pct >= 100" [style.width.%]="min(m.pct, 100)"></span>
                  </span>
                </div>
              </ng-template>
              <ng-template uiCelula="acoes" let-m>
                <button type="button" class="btn btn--secundario btn--pequeno" (click)="excluir(m.id)">Remover</button>
              </ng-template>
            </ui-tabela>
          }
        }
      }
    </div>

    <ui-modal [aberto]="novaAberta()" titulo="Nova meta" largura="p" (fechar)="fecharNova()">
      <form id="form-meta" (submit)="salvar($event)">
        <ui-grade-form>
          <ui-select class="largo" rotulo="De quem é a meta" placeholder="Equipe (todos)" [opcoes]="opcoesEquipe()"
            [dica]="erroEquipe() ?? 'Sem escolha, a meta é da equipe.'" [(valor)]="alvoUsuario" />
          <ui-campo class="largo" rotulo="Alvo do mês (R$)" tipo="dinheiro" placeholder="0,00" [obrigatorio]="true"
            dica="Valor em reais. Precisa ser maior que zero." [(valor)]="valor" [erro]="erroValor()" />
        </ui-grade-form>
        @if (erroForm()) { <p class="erro" role="alert">{{ erroForm() }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharNova()">Cancelar</button>
        <button type="submit" form="form-meta" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Definir meta' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .periodo { display: flex; align-items: center; gap: var(--espacamento-2); }
    .nav { width: 32px; height: 32px; border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--superficie-elevada); color: var(--texto); font-size: 18px; cursor: pointer; }
    .mes { min-width: 92px; text-align: center; color: var(--texto); }
    .nome { color: var(--texto); margin-right: var(--espacamento-2); }
    .progresso { display: flex; align-items: center; gap: var(--espacamento-2); min-width: 140px; }
    .pct { color: var(--texto-secundario); font-weight: 600; min-width: 44px; text-align: right; }
    .pct.bateu { color: var(--sucesso); }
    .pct-indisp { font-size: 12px; color: var(--texto-suave); }
    .barra { display: block; flex: 1; height: 8px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; }
    .preenche { display: block; height: 100%; background: var(--acao); }
    .preenche.bateu { background: var(--sucesso); }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class MetasPagina implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly confirmacao = inject(ConfirmacaoServico)
  private readonly toast = inject(ToastServico)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'usuario', rotulo: 'Responsável' },
    { chave: 'realizado', rotulo: 'Realizado', alinhamento: 'dir', mono: true, largura: '130px' },
    { chave: 'alvo', rotulo: 'Alvo', alinhamento: 'dir', mono: true, largura: '130px' },
    { chave: 'progresso', rotulo: 'Progresso', largura: '220px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '120px' },
  ]

  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Meta[]>([])
  protected readonly linhas = computed(() => this.itens() as unknown as readonly LinhaTabela[])
  readonly equipe = signal<readonly Membro[]>([])
  protected readonly opcoesEquipe = computed<OpcaoSelect[]>(() => this.equipe().map((m) => ({ valor: m.id, rotulo: m.nome })))
  readonly erroEquipe = signal<string | null>(null)
  private readonly hoje = new Date()
  readonly ano = signal(this.hoje.getUTCFullYear())
  readonly mes = signal(this.hoje.getUTCMonth() + 1)
  readonly alvoUsuario = signal(''); readonly valor = signal('')
  readonly salvando = signal(false); readonly erroForm = signal<string | null>(null)
  readonly erroValor = signal<string | null>(null)
  readonly novaAberta = signal(false)

  readonly rotuloMes = computed(() => `${MESES[this.mes() - 1]} ${this.ano()}`)
  readonly valorNumerico = computed(() => this.parseReais(this.valor()))

  ngOnInit(): void { void this.carregar(); void this.carregarEquipe() }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  min(a: number, b: number): number { return Math.min(a, b) }

  // R$ digitado → centavos (regra compartilhada em compartilhado/ui/dinheiro.ts). null se inválido/zero.
  private parseReais(v: string): number | null {
    const c = reaisParaCentavos(v)
    return c !== null && c > 0 ? c : null
  }

  mudarMes(delta: number): void {
    let m = this.mes() + delta, a = this.ano()
    if (m < 1) { m = 12; a-- } else if (m > 12) { m = 1; a++ }
    this.mes.set(m); this.ano.set(a)
    void this.carregar()
  }

  async carregarEquipe(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Membro[] }>('/v1/equipe'))
      this.equipe.set(r.itens)
      this.erroEquipe.set(null)
    } catch (e) {
      // Parcial: dá para definir a meta da equipe; a lista de vendedores não veio.
      this.erroEquipe.set(mensagemDeErro(e, 'A lista de vendedores não carregou — só a meta da equipe está disponível.'))
    }
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<{ itens: Meta[] }>(`/v1/metas?ano=${this.ano()}&mes=${this.mes()}`))
      this.itens.set(r.itens)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  fecharNova(): void { if (!this.salvando()) this.novaAberta.set(false) }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    const alvo = this.valorNumerico()
    if (alvo === null) { this.erroValor.set('Informe um valor maior que zero.'); return }
    this.erroValor.set(null)
    this.salvando.set(true); this.erroForm.set(null)
    try {
      await firstValueFrom(this.http.post('/v1/metas', {
        usuarioId: this.alvoUsuario() || null, ano: this.ano(), mes: this.mes(), alvoCentavos: alvo,
      }))
      this.valor.set('')
      this.novaAberta.set(false)
      this.toast.sucesso('Meta definida')
      await this.carregar()
    } catch (e) { this.erroForm.set(mensagemDeErro(e, 'Não foi possível salvar a meta.')) }
    finally { this.salvando.set(false) }
  }

  async excluir(id: string): Promise<void> {
    const m = this.itens().find((x) => x.id === id)
    const ok = await this.confirmacao.confirmar({
      titulo: 'Remover meta?',
      mensagem: `A meta de ${m?.usuario ?? 'este alvo'} em ${this.rotuloMes()} (${this.reais(m?.alvo ?? 0)}) some. O realizado continua nas vendas.`,
      acao: 'Remover',
    })
    if (!ok) return
    try {
      await firstValueFrom(this.http.delete(`/v1/metas/${id}`))
      this.toast.sucesso('Meta removida')
      await this.carregar()
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível remover a meta.')) }
  }
}
