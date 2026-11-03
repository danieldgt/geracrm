import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import {
  CabecalhoTelaComponente, CampoComponente, EstadoComponente, GradeFormComponente, ModalComponente,
} from '../../compartilhado/ui/index.js'

interface Bucket { readonly estado: string; readonly contatos: number; readonly receitaCentavos: number }
interface Retencao { readonly config: { diasAtivo: number; diasInativo: number }; readonly buckets: Bucket[]; readonly totalContatos: number }
type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

const ROTULOS: Record<string, { nome: string; acao: string; token: string }> = {
  ativo:      { nome: 'Ativos',    acao: 'Comprando no ritmo — mantenha o relacionamento.', token: 'var(--rfv-campeao)' },
  inativo:    { nome: 'Inativos',  acao: 'Passaram do ritmo — hora de reativar antes de perder.', token: 'var(--rfv-em-risco)' },
  perdido:    { nome: 'Perdidos',  acao: 'Sumidos há tempo — campanha de resgate ou aceitar a perda.', token: 'var(--rfv-perdido)' },
  sem_compra: { nome: 'Sem compra', acao: 'Cadastrados que nunca compraram — primeira venda.', token: 'var(--texto-suave)' },
}
const ORDEM = ['ativo', 'inativo', 'perdido', 'sem_compra']

/**
 * Retenção — o funil de recompra (ciclo de vida). A base distribuída em
 * Ativo/Inativo/Perdido/Sem compra, com a fronteira em dias CONFIGURÁVEL pelo
 * dono do negócio. Segue geracrm-layout-ui (5 estados, tokens, responsivo).
 */
@Component({
  selector: 'app-retencao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CabecalhoTelaComponente, CampoComponente, EstadoComponente, GradeFormComponente, ModalComponente, RouterLink],
  template: `
    <ui-cabecalho-tela titulo="Retenção"
      subtitulo="Onde sua base está no ciclo de recompra — e quem está indo embora.">
      @if (d()) {
        <button type="button" class="btn btn--secundario" (click)="abrirConfig()">Ajustar fronteiras</button>
      }
    </ui-cabecalho-tela>

    <div class="corpo">
      @switch (estado()) {
        @case ('carregando') {
          <div class="funil">
            <div class="esq"></div><div class="esq"></div><div class="esq"></div>
          </div>
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Sem acesso à retenção" descricao="Peça acesso a um administrador." />
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar a retenção" descricao="Verifique a conexão e tente de novo.">
            <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          @if (d(); as r) {
            <p class="fronteiras txt-denso">
              Ativo até {{ r.config.diasAtivo }} dias · Inativo até {{ r.config.diasInativo }} dias · acima disso = Perdido
            </p>

            @if (r.totalContatos === 0) {
              <ui-estado titulo="Sem base ainda" descricao="O funil aparece quando houver contatos." />
            } @else {
              <div class="funil">
                @for (b of ordenados(); track b.estado) {
                  <section class="etapa" [style.--c]="rotulo(b.estado).token">
                    <div class="etapa-topo">
                      <span class="ponto"></span>
                      <strong class="etapa-nome">{{ rotulo(b.estado).nome }}</strong>
                    </div>
                    <span class="etapa-qtd txt-kpi">{{ b.contatos }}</span>
                    <span class="etapa-pct txt-dados">{{ pct(b.contatos, r.totalContatos) }}% · {{ reais(b.receitaCentavos) }}</span>
                    <div class="barra"><span class="fill" [style.width.%]="pct(b.contatos, maxBucket())"></span></div>
                    <p class="etapa-acao">{{ rotulo(b.estado).acao }}</p>
                  </section>
                }
              </div>
              <p class="dica">Quer agir sobre um grupo? Veja os <a routerLink="/segmentos">segmentos RFV</a> ou monte uma <a routerLink="/campanhas">campanha</a>.</p>
            }
          }
        }
      }
    </div>

    <ui-modal [aberto]="configAberta()" titulo="Ajustar fronteiras" largura="p" (fechar)="fecharConfig()">
      <form id="form-retencao" (submit)="salvar($event)">
        <ui-grade-form>
          <ui-campo rotulo="Ativo até (dias)" tipo="number" dica="Compra dentro deste prazo: ativo." [obrigatorio]="true"
            [valor]="ativo().toString()" (valorChange)="ativo.set(+$event)" [erro]="erroAtivo()" />
          <ui-campo rotulo="Inativo até (dias)" tipo="number" dica="Acima disso e até o limite: inativo; depois, perdido."
            [obrigatorio]="true" [valor]="inativo().toString()" (valorChange)="inativo.set(+$event)" [erro]="erroInativo()" />
        </ui-grade-form>
        @if (erroCfg(); as e) { <p class="erro" role="alert">{{ e }}</p> }
      </form>
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharConfig()">Cancelar</button>
        <button type="submit" form="form-retencao" class="btn btn--primario" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : 'Aplicar' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-2); min-width: 0; }
    .fronteiras { margin: 0 0 var(--espacamento-2); color: var(--texto-secundario); }
    .funil { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--espacamento-3); }
    .esq { height: 160px; border-radius: var(--raio-painel); background: var(--superficie); }
    .etapa { display: flex; flex-direction: column; gap: var(--espacamento-1); padding: var(--espacamento-4); border: 1px solid var(--borda); border-top: 3px solid var(--c); border-radius: var(--raio-painel); background: var(--superficie-elevada); }
    .etapa-topo { display: flex; align-items: center; gap: var(--espacamento-2); }
    .ponto { width: 8px; height: 8px; border-radius: var(--raio-completo); background: var(--c); flex: none; }
    .etapa-nome { color: var(--texto); font-size: 14px; }
    .etapa-qtd { color: var(--texto); }
    .etapa-pct { color: var(--texto-suave); font-size: 12px; }
    .barra { height: 5px; border-radius: var(--raio-completo); background: var(--superficie); overflow: hidden; margin: var(--espacamento-1) 0; }
    .fill { display: block; height: 100%; background: var(--c); }
    .etapa-acao { margin: var(--espacamento-1) 0 0; font-size: 12px; color: var(--texto-secundario); line-height: 1.4; }
    .dica { margin-top: var(--espacamento-4); font-size: 13px; color: var(--texto-suave); }
    .dica a { color: var(--acao); }
    .erro { margin: var(--espacamento-3) 0 0; color: var(--erro); font-size: 13px; }
  `,
})
export class RetencaoPagina implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly d = signal<Retencao | null>(null)
  readonly ativo = signal(30); readonly inativo = signal(90)
  readonly configAberta = signal(false)
  readonly salvando = signal(false); readonly erroCfg = signal<string | null>(null)
  readonly erroAtivo = signal<string | null>(null); readonly erroInativo = signal<string | null>(null)

  readonly ordenados = computed(() => {
    const b = this.d()?.buckets ?? []
    return [...b].sort((x, y) => ORDEM.indexOf(x.estado) - ORDEM.indexOf(y.estado))
  })

  ngOnInit(): void { void this.carregar() }
  rotulo(estado: string) { return ROTULOS[estado] ?? { nome: estado, acao: '', token: 'var(--texto-suave)' } }
  reais(c: number): string { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  pct(n: number, total: number): number { return total > 0 ? Math.round((n / total) * 100) : 0 }
  maxBucket(): number { return Math.max(1, ...(this.d()?.buckets.map((b) => b.contatos) ?? [])) }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const r = await firstValueFrom(this.http.get<Retencao>('/v1/retencao'))
      this.d.set(r)
      this.ativo.set(r.config.diasAtivo); this.inativo.set(r.config.diasInativo)
      this.estado.set('pronto')
    } catch (e) { this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro') }
  }

  abrirConfig(): void {
    this.erroCfg.set(null); this.erroAtivo.set(null); this.erroInativo.set(null)
    this.configAberta.set(true)
  }

  fecharConfig(): void { if (!this.salvando()) this.configAberta.set(false) }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    this.erroAtivo.set(null); this.erroInativo.set(null); this.erroCfg.set(null)
    if (this.ativo() < 1) { this.erroAtivo.set('Use pelo menos 1 dia.'); return }
    if (this.inativo() <= this.ativo()) { this.erroInativo.set('Inativo tem de ser maior que Ativo.'); return }
    this.salvando.set(true)
    try {
      await firstValueFrom(this.http.put('/v1/retencao/config', { diasAtivo: this.ativo(), diasInativo: this.inativo() }))
      this.configAberta.set(false)
      await this.carregar()
    } catch { this.erroCfg.set('Não foi possível salvar.') } finally { this.salvando.set(false) }
  }
}
