import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core'
import { BadgeComponente, EstadoComponente } from '../../compartilhado/ui/index.js'
import { PAGINA_PANORAMA, cartoesVisiveis, type Agrupar, type CartaoPanorama } from './funil-filtros.regras.js'

/**
 * Panorama do funil (B1): um cartão por grupo (filial ou vendedor) com os selos e a contagem por etapa.
 * Apresentação pura: quem carrega é a página. Os cartões aparecem de 60 em 60 ("carregar mais") — a API
 * devolve até 200 grupos e a tela nunca despeja a lista inteira de uma vez.
 */
@Component({
  selector: 'app-funil-panorama',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponente, EstadoComponente],
  template: `
    <div class="barra">
      <div class="chips" role="group" aria-label="Agrupar panorama por">
        <button type="button" class="chip" [class.chip--ativo]="agrupar() === 'filial'" [attr.aria-pressed]="agrupar() === 'filial'"
                (click)="trocarAgrupar.emit('filial')">Filial</button>
        <button type="button" class="chip" [class.chip--ativo]="agrupar() === 'vendedor'" [attr.aria-pressed]="agrupar() === 'vendedor'"
                (click)="trocarAgrupar.emit('vendedor')">Vendedor</button>
      </div>
      @if (estado() === 'pronto' && truncado()) {
        <p class="aviso txt-denso" role="status">Mostrando os 200 maiores grupos. Use os filtros do board para chegar nos demais.</p>
      }
    </div>

    @switch (estado()) {
      @case ('carregando') {
        <div class="grade" aria-busy="true" aria-label="Carregando panorama">
          <div class="esqueleto"></div><div class="esqueleto"></div><div class="esqueleto"></div>
        </div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso ao panorama" descricao="Peça a um gestor para liberar o funil para o seu perfil." />
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível carregar o panorama" descricao="O funil segue disponível no board.">
          <button type="button" class="btn btn--secundario" (click)="tentarDeNovo.emit()">Tentar de novo</button>
        </ui-estado>
      }
      @case ('pronto') {
        @if (cartoes().length === 0) {
          <ui-estado tipo="vazio" titulo="Nenhuma oportunidade ativa por aqui"
                     descricao="Quando houver oportunidades abertas na sua carteira, os grupos aparecem neste painel." />
        } @else {
          <ul class="grade">
            @for (c of pagina().itens; track c.chave) {
              <li>
                <button type="button" class="cartao" [class.cartao--sem-dono]="c.semDono"
                        [attr.aria-label]="'Abrir o board de ' + c.rotulo" (click)="abrir.emit(c.chave)">
                  <span class="rotulo txt-secao">{{ c.rotulo }}</span>
                  <span class="selos">
                    @for (s of c.selos; track s.id) {
                      <ui-badge [tom]="s.tom"><b class="txt-dados">{{ s.valor }}</b> {{ s.rotulo }}</ui-badge>
                    }
                  </span>
                  <span class="etapas">
                    @for (e of c.etapas; track e.etapaId) {
                      <span class="etapa"><span class="etapa-n txt-dados">{{ e.total }}</span><span class="etapa-nome txt-denso">{{ e.nome }}</span></span>
                    }
                  </span>
                </button>
              </li>
            }
          </ul>
          @if (pagina().temMais) {
            <div class="mais">
              <button type="button" class="btn btn--secundario" (click)="visiveis.set(visiveis() + paginaTam)">
                Carregar mais ({{ pagina().restantes }})
              </button>
            </div>
          }
        }
      }
    }
  `,
  styles: `
    :host { display: block; flex: 1; min-height: 0; overflow-y: auto; padding-bottom: var(--folga-flutuante, 0px); }
    .barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-3); margin-bottom: var(--espacamento-4); }
    .chips { display: inline-flex; gap: var(--espacamento-2); }
    .chip { min-height: var(--densidade-alvo-clique-console); padding: var(--espacamento-1) var(--espacamento-4);
      border: 1px solid var(--borda); border-radius: var(--raio-completo); background: var(--superficie);
      color: var(--texto-secundario); font: inherit; cursor: pointer; }
    .chip:hover { color: var(--texto); background: var(--superficie-hover); }
    .chip--ativo { color: var(--acao); border-color: var(--acao); font-weight: 600; }
    .chip:focus-visible, .cartao:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .aviso { margin: 0; color: var(--texto-secundario); }
    .grade { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-3);
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
    .esqueleto { height: 140px; border-radius: var(--raio-painel); background: var(--superficie); border: 1px solid var(--borda); }
    .cartao { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: var(--espacamento-3);
      padding: var(--espacamento-4); text-align: left; font: inherit; color: var(--texto); cursor: pointer;
      background: var(--superficie-elevada); border: 1px solid var(--borda); border-radius: var(--raio-painel); }
    .cartao:hover { border-color: var(--borda-forte); background: var(--superficie-hover); }
    .cartao--sem-dono { border-style: dashed; }
    .rotulo { overflow-wrap: anywhere; }
    .selos { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .etapas { display: flex; flex-wrap: wrap; gap: var(--espacamento-2) var(--espacamento-4); }
    .etapa { display: inline-flex; align-items: baseline; gap: var(--espacamento-1); }
    .etapa-n { font-weight: 600; }
    .etapa-nome { color: var(--texto-secundario); }
    .mais { display: flex; justify-content: center; padding: var(--espacamento-4) 0; }
  `,
})
export class FunilPanoramaComponente {
  readonly agrupar = input<Agrupar>('filial')
  readonly estado = input<'carregando' | 'pronto' | 'sem_permissao' | 'erro'>('carregando')
  readonly cartoes = input<readonly CartaoPanorama[]>([])
  readonly truncado = input(false)

  readonly abrir = output<string>()
  readonly trocarAgrupar = output<Agrupar>()
  readonly tentarDeNovo = output<void>()

  protected readonly paginaTam = PAGINA_PANORAMA
  protected readonly visiveis = signal(PAGINA_PANORAMA)
  protected readonly pagina = computed(() => cartoesVisiveis(this.cartoes(), this.visiveis()))
}
