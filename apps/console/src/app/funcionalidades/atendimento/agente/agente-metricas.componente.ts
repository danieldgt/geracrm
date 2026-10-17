import { Component, ChangeDetectionStrategy, input } from '@angular/core'
import { PainelComponente, EstadoComponente } from '../../../compartilhado/ui/index.js'

/**
 * MÉTRICAS E FASE — STUB da raia P19 (docs/plano-port-playbook-am.md).
 *
 * Já montado pela raia P0 na página do agente; a raia P19 preenche AQUI:
 * painel verde/vermelho por critério de fase (GET /v1/agente/go-live) e /v1/agente/metricas.
 *
 * ⚠️ Enquanto `ABA_METRICAS_PRONTA` for false, a página NÃO mostra este bloco — nada
 *    muda para quem usa o console. Ao preencher, a raia liga a constante neste
 *    mesmo arquivo (com os cinco estados de tela, skill geracrm-layout-ui).
 */
export const ABA_METRICAS_PRONTA: boolean = false

@Component({
  selector: 'app-agente-metricas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente],
  template: `
    <ui-painel><ui-estado titulo="Métricas e fase" icone="🛠️"
      descricao="Esta seção ainda está em preparação." /></ui-painel>
  `,
})
export class AgenteMetricasComponente {
  /** Número selecionado na página (as seções do tenant inteiro ignoram). */
  readonly canalId = input.required<string>()
}
