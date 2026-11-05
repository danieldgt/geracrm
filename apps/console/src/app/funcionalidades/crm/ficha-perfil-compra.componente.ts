import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core'
import {
  BotaoComponente, EsqueletoComponente, EstadoComponente, ListaDefinicaoComponente, PainelComponente, mensagemDeErro,
} from '../../compartilhado/ui/index.js'
import { FichaBlocosServico } from './ficha-blocos.servico.js'
import { linhasPerfilDeCompra, type FatoMemoria } from './ficha.regras.js'

/**
 * Perfil de compra: o que o agente aprendeu do contato conversando (memória vigente). Só leitura —
 * memória nasce da conversa, nunca de formulário. Vazio explica isso em vez de parecer defeito.
 */
@Component({
  selector: 'app-ficha-perfil-compra',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BotaoComponente, EsqueletoComponente, EstadoComponente, ListaDefinicaoComponente, PainelComponente],
  template: `
    <ui-painel>
      <h2 class="txt-secao titulo">Perfil de compra</h2>
      @switch (estado()) {
        @case ('carregando') { <div aria-busy="true"><ui-esqueleto altura="48px" /></div> }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar o perfil de compra" [descricao]="erro()">
            <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
          </ui-estado>
        }
        @default {
          @if (linhas().length === 0) {
            <p class="txt-corpo vazio">O agente ainda não aprendeu nada deste contato. O perfil de compra é preenchido
              conforme ele conversa: preferências, objeções e restrições aparecem aqui.</p>
          } @else {
            <ui-lista-definicao [itens]="linhas()" [colunas]="1" />
          }
        }
      }
    </ui-painel>
  `,
  styles: `
    :host { display: block; }
    .titulo { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .vazio { margin: 0; color: var(--texto-secundario); }
  `,
})
export class FichaPerfilCompraComponente {
  private readonly blocos = inject(FichaBlocosServico)
  readonly contatoId = input.required<string>()
  readonly estado = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly erro = signal('')
  private readonly fatos = signal<readonly FatoMemoria[]>([])
  readonly linhas = computed(() => linhasPerfilDeCompra(this.fatos()))

  constructor() {
    effect(() => { this.contatoId(); untracked(() => { void this.carregar() }) })
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      this.fatos.set(await this.blocos.memoria(this.contatoId()))
      this.estado.set('pronto')
    } catch (e) {
      this.erro.set(mensagemDeErro(e, 'Tente de novo em instantes.'))
      this.estado.set('erro')
    }
  }
}
