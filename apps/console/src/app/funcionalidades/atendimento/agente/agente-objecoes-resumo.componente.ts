import { Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { JANELA_RESUMO_OBJECOES_PADRAO, type ResumoObjecoesDto } from '@geracrm/shared'
import {
  BotaoComponente, EsqueletoComponente, EstadoComponente, PainelComponente, TabelaComponente, type ColunaTabela,
} from '../../../compartilhado/ui/index.js'
import { ehSemPermissao } from './agente.servico.js'
import { MetricasServico } from './metricas.servico.js'
import { linhasDoResumoObjecoes } from './playbook.regras.js'

type Estado = 'carregando' | 'pronto' | 'sem_permissao' | 'erro'

/**
 * RELATÓRIO MÍNIMO DE OBJEÇÕES (raia G2) — na aba Métricas do agente: por código,
 * a objeção, quantas vezes o agente a registrou e quanto dela foi revertida, nos
 * últimos 30 dias do número (`GET /v1/agente/objecoes/resumo`).
 *
 * Cinco estados: carregando (esqueleto), erro (tentar de novo), sem permissão,
 * vazio (nenhuma objeção registrada na janela) e pronto. Agregado limitado por
 * construção (≤ 99 códigos): não é lista paginada.
 */
@Component({
  selector: 'app-agente-objecoes-resumo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente, EsqueletoComponente, BotaoComponente, TabelaComponente],
  template: `
    <ui-painel>
      <h3 class="titulo">Objeções <span class="escopo">· últimos {{ dias }} dias · este número</span></h3>
      <p class="dica">O que o agente registrou com "Registrar objeções" (playbook). Revertida = o cliente aceitou o argumento e seguiu.</p>
      @switch (estado()) {
        @case ('carregando') {
          <div class="esq" aria-busy="true" aria-label="Carregando as objeções"><ui-esqueleto altura="40px" /><ui-esqueleto altura="40px" /></div>
        }
        @case ('sem_permissao') {
          <p class="parcial" role="status">Você não tem acesso ao relatório de objeções.</p>
        }
        @case ('erro') {
          <div class="parcial" role="status">
            <span>O relatório de objeções não carregou agora.</span>
            <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
          </div>
        }
        @case ('pronto') {
          <ui-tabela [colunas]="colunas" [linhas]="linhas()">
            <div uiVazio>
              <ui-estado titulo="Nenhuma objeção registrada" icone="📊"
                [descricao]="'Nos últimos ' + dias + ' dias o agente não registrou objeções neste número. Cadastre as objeções no playbook e deixe a ação ligada.'" />
            </div>
          </ui-tabela>
        }
      }
    </ui-painel>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .titulo { margin: 0; font-size: 15px; font-weight: 600; color: var(--texto); }
    .escopo { color: var(--texto-suave); font-weight: 400; }
    .dica { margin: var(--espacamento-1) 0 var(--espacamento-3); color: var(--texto-suave); font-size: 13px; overflow-wrap: anywhere; }
    .esq { display: grid; gap: var(--espacamento-2); }
    .parcial { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; margin: 0; font-size: 13px; color: var(--atencao); }
  `,
})
export class AgenteObjecoesResumoComponente {
  readonly canalId = input.required<string>()
  readonly #api = inject(MetricasServico)

  readonly dias = JANELA_RESUMO_OBJECOES_PADRAO
  readonly colunas: readonly ColunaTabela[] = [
    { chave: 'codigo', rotulo: 'Código', mono: true, largura: '96px' },
    { chave: 'objecao', rotulo: 'Objeção' },
    { chave: 'vezes', rotulo: 'Vezes', alinhamento: 'dir', mono: true, largura: '96px' },
    { chave: 'revertida', rotulo: '% revertida', alinhamento: 'dir', mono: true, largura: '120px' },
  ]
  readonly estado = signal<Estado>('carregando')
  readonly resumo = signal<ResumoObjecoesDto | null>(null)
  readonly linhas = computed(() => linhasDoResumoObjecoes(this.resumo()?.itens ?? []))

  constructor() {
    effect(() => {
      this.canalId()
      untracked(() => { void this.carregar() })
    })
  }

  async carregar(): Promise<void> {
    const canal = this.canalId()
    this.estado.set('carregando')
    try {
      const r = await this.#api.objecoes(canal, this.dias)
      if (canal !== this.canalId()) return // resposta de um número que já saiu da tela
      this.resumo.set(r)
      this.estado.set('pronto')
    } catch (e) {
      if (canal !== this.canalId()) return
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }
}
