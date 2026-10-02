import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import {
  BotaoComponente, CabecalhoTelaComponente, PainelComponente, EsqueletoComponente, EstadoComponente,
} from '../../../compartilhado/ui/index.js'
import { AgenteServico, ehSemPermissao, type CanalResumo } from './agente.servico.js'
import { AgenteConfigComponente } from './agente-config.componente.js'
import { AgentePlaygroundComponente } from './agente-playground.componente.js'
import { AgenteDecisoesComponente } from './agente-decisoes.componente.js'
import { AgenteSessoesComponente } from './agente-sessoes.componente.js'

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'
type Aba = 'configuracao' | 'playground' | 'decisoes' | 'sessoes'

const ABAS: readonly { readonly id: Aba; readonly rotulo: string }[] = [
  { id: 'configuracao', rotulo: 'Configuração' },
  { id: 'playground', rotulo: 'Playground' },
  { id: 'decisoes', rotulo: 'Decisões' },
  { id: 'sessoes', rotulo: 'Sessões' },
]

/**
 * O agente vendedor como PRODUTO: escolher o número, configurar, conversar com
 * ele antes de ligar, auditar cada decisão e ver as conversas conduzidas.
 *
 * A página só cuida do número selecionado e das abas; cada aba carrega o seu
 * dado e tem os seus cinco estados. Trocar de número recarrega as abas por
 * número (config, playground, decisões); sessões são do tenant inteiro.
 */
@Component({
  selector: 'app-agente',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pagina' },
  imports: [
    RouterLink, BotaoComponente, CabecalhoTelaComponente, PainelComponente, EsqueletoComponente, EstadoComponente,
    AgenteConfigComponente, AgentePlaygroundComponente, AgenteDecisoesComponente, AgenteSessoesComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Agente vendedor"
      subtitulo="Atende no WhatsApp com o catálogo e as políticas da loja — em sombra, assistido ou sozinho, por número." />

    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq-lista">
          <ui-esqueleto altura="40px" largura="50%" /><ui-esqueleto altura="36px" /><ui-esqueleto altura="160px" />
        </div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Você não tem acesso ao agente"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar os números"
          descricao="O servidor não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        @if (canais().length === 0) {
          <ui-painel><ui-estado titulo="Nenhum número conectado" icone="📱"
            descricao="O agente atende por número. Conecte um em Meus Números e volte aqui.">
            <a class="btn btn--primario" routerLink="/numeros">Ir para Meus Números</a>
          </ui-estado></ui-painel>
        } @else {
          <div class="topo">
            <label class="campo numero">
              <span>Número</span>
              <select [value]="canalId()" (change)="canalId.set($any($event.target).value)">
                @for (c of canais(); track c.id) { <option [value]="c.id">{{ c.nomeAmigavel }}</option> }
              </select>
            </label>

            <div class="abas" role="tablist" aria-label="Seções do agente" (keydown)="teclaAba($event)">
              @for (a of abas; track a.id) {
                <button type="button" role="tab" class="aba" [id]="'aba-' + a.id"
                        [attr.aria-selected]="aba() === a.id" [attr.aria-controls]="'painel-' + a.id"
                        [attr.tabindex]="aba() === a.id ? 0 : -1" (click)="aba.set(a.id)">{{ a.rotulo }}</button>
              }
            </div>
          </div>

          <div role="tabpanel" [id]="'painel-' + aba()" [attr.aria-labelledby]="'aba-' + aba()" class="painel-aba">
            @switch (aba()) {
              @case ('configuracao') { <app-agente-config [canalId]="canalId()" /> }
              @case ('playground') { <app-agente-playground [canalId]="canalId()" /> }
              @case ('decisoes') { <app-agente-decisoes [canalId]="canalId()" /> }
              @case ('sessoes') { <app-agente-sessoes /> }
            }
          </div>
        }
      }
    }
  `,
  styles: `
    :host { min-width: 0; }
    .esq-lista { display: grid; gap: var(--espacamento-3); }
    .topo { display: flex; align-items: end; justify-content: space-between; gap: var(--espacamento-4); flex-wrap: wrap;
      margin-bottom: var(--espacamento-4); }
    .numero { flex: 0 1 280px; min-width: 0; }
    .numero select { font: inherit; width: 100%; min-height: var(--densidade-alvo-clique-console); }
    .numero select:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .abas { display: flex; gap: var(--espacamento-1); border-bottom: 1px solid var(--borda); flex: 1 1 320px; min-width: 0;
      overflow-x: auto; }
    .aba { flex: none; padding: var(--espacamento-2) var(--espacamento-3); border: 0; border-bottom: 2px solid transparent;
      background: transparent; color: var(--texto-secundario); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer;
      margin-bottom: -1px; white-space: nowrap;
      transition: color var(--movimento-estado-duracao) var(--movimento-estado-curva); }
    .aba:hover { color: var(--texto); }
    .aba[aria-selected='true'] { color: var(--acao); border-bottom-color: var(--acao); }
    .aba:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: -2px; border-radius: var(--raio-controle); }
    .painel-aba { min-width: 0; }
    @media (max-width: 640px) { .topo { align-items: stretch; } .numero { flex-basis: 100%; } }
  `,
})
export class AgentePagina implements OnInit {
  private readonly api = inject(AgenteServico)

  readonly abas = ABAS
  readonly estado = signal<Estado>('carregando')
  readonly canais = signal<readonly CanalResumo[]>([])
  readonly canalId = signal('')
  readonly aba = signal<Aba>('configuracao')

  ngOnInit(): void { void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const canais = await this.api.listarCanais()
      this.canais.set(canais)
      // Mantém o número escolhido se ele ainda existe; senão, o primeiro.
      const atual = this.canalId()
      if (!canais.some((c) => c.id === atual)) this.canalId.set(canais[0]?.id ?? '')
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  /** Setas movem entre abas (padrão WAI-ARIA de tablist); Home/End vão às pontas. */
  teclaAba(ev: KeyboardEvent): void {
    const i = ABAS.findIndex((a) => a.id === this.aba())
    let alvo: number | null = null
    if (ev.key === 'ArrowRight') alvo = (i + 1) % ABAS.length
    else if (ev.key === 'ArrowLeft') alvo = (i - 1 + ABAS.length) % ABAS.length
    else if (ev.key === 'Home') alvo = 0
    else if (ev.key === 'End') alvo = ABAS.length - 1
    if (alvo === null) return
    ev.preventDefault()
    const id = ABAS[alvo]!.id
    this.aba.set(id)
    const el = (ev.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(`#aba-${id}`)
    el?.focus()
  }
}
